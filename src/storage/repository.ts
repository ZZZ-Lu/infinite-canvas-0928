import type { CardData } from '../components/GenerationCard';
import { CardCodec, type EncodedCard, type Resource } from './codec';

export type Transport = (method: string, ...args: any[]) => Promise<any>;
const yieldTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));
type Waiter = { resolve: () => void; reject: (error: unknown) => void };
type Session = {
  revision: number; deleted: boolean; signatures: Map<string, string>;
  refs: Map<string, CardData>; order: string[];
  pending?: { cards: CardData[]; waiters: Waiter[] };
  running?: Promise<void>; failed?: boolean; needsSync?: boolean;
};

export class CardRepository {
  private codec = new CardCodec();
  private sessions = new Map<string, Session>();
  private loading = new Map<string, Promise<CardData[] | null>>();
  onCommit?: (project: string) => void;
  constructor(private rpc: Transport) {}
  hasPending() { return [...this.sessions.values()].some(s => s.pending || s.running || s.failed); }
  load(project: string): Promise<CardData[] | null> {
    const existing = this.loading.get(project);
    if (existing) return existing;
    const promise = this.read(project).finally(() => this.loading.delete(project));
    this.loading.set(project, promise);
    return promise;
  }
  private async read(project: string): Promise<CardData[] | null> {
    const session = this.sessions.get(project);
    if (session?.running) await session.running;
    if (session?.failed) throw new Error('当前项目有未保存更改，请先重试保存');
    const stored = await this.rpc('load', project);
    const cards: CardData[] = [];
    const signatures = new Map<string, string>();
    if (stored) {
      const ids = [...new Set<string>(stored.cards.flatMap((c: EncodedCard) => c.resources))];
      // Do not send the entire project's media in one worker message.
      for (let i = 0; i < ids.length; i += 8) {
        const resources: Resource[] = await this.rpc('getAssets', ids.slice(i, i + 8));
        this.codec.accept(resources);
        await yieldTask();
      }
      for (let i = 0; i < stored.cards.length; i++) {
        const card = stored.cards[i] as EncodedCard;
        cards.push(this.codec.decode(card.data));
        signatures.set(card.id, JSON.stringify(card.data));
        if (i % 16 === 15) await yieldTask();
      }
    }
    this.sessions.set(project, {
      revision: stored?.head.revision || 0, deleted: !!stored?.head.deleted,
      signatures, refs: new Map(cards.map(c => [c.id, c])), order: cards.map(c => c.id),
    });
    return stored ? cards : null;
  }
  async save(cards: CardData[], project: string): Promise<void> {
    // Capture ownership and the array before yielding; UI uses immutable card updates.
    const snapshot = cards.slice();
    const ids = new Set<string>();
    for (const card of snapshot) {
      if (!card?.id || ids.has(card.id)) throw new Error('卡片 ID 缺失或重复，未保存');
      ids.add(card.id);
    }
    if (!this.sessions.has(project)) await this.load(project);
    const session = this.sessions.get(project)!;
    if (session.deleted) throw new Error('项目已删除，未写入旧页面数据');
    return new Promise<void>((resolve, reject) => {
      const waiters = [...(session.pending?.waiters || []), { resolve, reject }];
      session.pending = { cards: snapshot, waiters };
      this.kick(project, session);
    });
  }
  private kick(project: string, session: Session) {
    if (session.running) return;
    session.running = this.drain(project, session).finally(() => {
      session.running = undefined;
      // A caller can enqueue between its promise resolving and this finally.
      if (session.pending) this.kick(project, session);
    });
  }
  private async drain(project: string, session: Session) {
    while (session.pending) {
      const job = session.pending;
      session.pending = undefined;
      try {
        const changes: EncodedCard[] = [];
        const signatures = new Map<string, string>();
        const nextRefs = new Map<string, CardData>();
        let sliceStart = performance.now();
        for (const card of job.cards) {
          nextRefs.set(card.id, card);
          if (session.refs.get(card.id) === card) {
            signatures.set(card.id, session.signatures.get(card.id)!);
          } else {
            const encoded = await this.codec.card(card);
            const signature = JSON.stringify(encoded.data);
            signatures.set(card.id, signature);
            if (signature !== session.signatures.get(card.id)) changes.push({ ...encoded, base: session.signatures.has(card.id) ? JSON.parse(session.signatures.get(card.id)!) : null });
          }
          if (performance.now() - sliceStart > 3) { await yieldTask(); sliceStart = performance.now(); }
        }
        const removed = session.order.filter(id => !nextRefs.has(id));
        const order = job.cards.map(c => c.id);
        const orderChanged = order.length !== session.order.length || order.some((id, i) => id !== session.order[i]);
        // Upload new media once, in bounded messages, before referencing it.
        const resources = this.codec.pending(changes.flatMap(c => c.resources));
        for (let i = 0; i < resources.length; i += 4) {
          const batch = resources.slice(i, i + 4);
          await this.rpc('assets', batch);
          this.codec.accept(batch);
          await yieldTask();
        }
        if (changes.length || removed.length || orderChanged || session.revision === 0) {
          let head;
          if (changes.length > 16) {
            const token = crypto.randomUUID();
            try {
              // Keep large imports/pastes out of one main-thread structured clone.
              let batch: EncodedCard[] = [], bytes = 0;
              for (const change of changes) {
                const size = (signatures.get(change.id)?.length || 0) * 2;
                if (batch.length && (batch.length >= 16 || bytes + size > 128 * 1024)) {
                  await this.rpc('stage', token, batch);
                  await yieldTask();
                  batch = []; bytes = 0;
                }
                batch.push(change); bytes += size;
              }
              if (batch.length) await this.rpc('stage', token, batch);
              head = await this.rpc('commitStaged', project, session.revision, token, removed, order, session.order);
            } catch (error) {
              await this.rpc('discard', token).catch(() => {});
              throw error;
            }
          } else {
            head = await this.rpc('commit', project, session.revision, changes, removed, order, session.order);
          }
          session.needsSync ||= head.revision !== session.revision + 1;
          session.revision = head.revision;
          this.onCommit?.(project);
        }
        session.signatures = signatures;
        session.refs = nextRefs;
        session.order = order;
        session.failed = false;
        job.waiters.forEach(w => w.resolve());
      } catch (error) {
        session.failed = true;
        job.waiters.forEach(w => w.reject(error));
        // Keep the baseline unchanged. The UI retains current data; retries diff against it.
      }
    }
  }
  async synchronize(project: string, snapshot: CardData[], stillCurrent: () => boolean): Promise<CardData[] | null> {
    // Flush this page's edits first. Never replace an editing page with a stale read.
    await this.save(snapshot, project);
    const session = this.sessions.get(project)!;
    if (session.running) await session.running;
    if (!stillCurrent() || session.pending || session.failed) return null;
    const revision = session.revision;
    const head = await this.rpc('getHead', project);
    if (head && !head.deleted && head.revision === revision && !session.needsSync) return stillCurrent() ? snapshot : null;
    const stored = await this.rpc('load', project);
    if (!stored || stored.head.deleted) throw new Error('项目已删除，请切换项目');
    const signatures = new Map<string, string>();
    const changed: EncodedCard[] = [];
    for (const record of stored.cards as EncodedCard[]) {
      const signature = JSON.stringify(record.data);
      signatures.set(record.id, signature);
      if (signature !== session.signatures.get(record.id)) changed.push(record);
    }
    const ids = [...new Set(changed.flatMap(record => record.resources))];
    for (let i = 0; i < ids.length; i += 8) {
      this.codec.accept(await this.rpc('getAssets', ids.slice(i, i + 8)));
      await yieldTask();
    }
    const cards: CardData[] = [];
    for (let i = 0; i < stored.cards.length; i++) {
      const record = stored.cards[i];
      cards.push(signatures.get(record.id) === session.signatures.get(record.id)
        ? session.refs.get(record.id)! : this.codec.decode(record.data));
      if (i % 16 === 15) await yieldTask();
    }
    if (!stillCurrent() || session.running || session.pending || session.revision !== revision || session.failed) return null;
    session.needsSync = false;
    session.revision = stored.head.revision;
    session.signatures = signatures;
    session.refs = new Map(cards.map(card => [card.id, card]));
    session.order = cards.map(card => card.id);
    return cards;
  }
  async remove(project: string) {
    if (!this.sessions.has(project)) await this.load(project);
    const session = this.sessions.get(project)!;
    if (session.running) await session.running;
    const head = await this.rpc('remove', project, session.revision);
    session.deleted = true;
    session.revision = head.revision;
    session.failed = false;
  }
  async restore(project: string) {
    if (!this.sessions.has(project)) await this.load(project);
    const session = this.sessions.get(project)!;
    if (session.running) await session.running;
    if (session.failed || session.pending) throw new Error('仍有未保存更改，不能覆盖恢复');
    await this.rpc('restore', project, session.revision);
    return this.load(project);
  }
}
