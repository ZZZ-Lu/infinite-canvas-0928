import { mergeFields, resourceIds } from './merge';
import { CardCodec, type EncodedCard, type Resource } from './codec';

const NAME = 'InfiniteCanvasIncrementalDB';
type Head = { generation: string; revision: number; order: string[]; deleted?: boolean };
const request = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const completed = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onabort = () => reject(tx.error || new Error('保存事务已取消'));
  tx.onerror = () => {}; // onabort is the final failure boundary.
});
function validate(cards: any[]) {
  const ids = new Set<string>();
  for (const card of cards) {
    if (!card || typeof card.id !== 'string' || !card.id || ids.has(card.id)) throw new Error('卡片 ID 缺失或重复');
    ids.add(card.id);
  }
}
export class StorageBackend {
  constructor(private databaseName = NAME) {}
  private staged = new Map<string, EncodedCard[]>();
  async stage(token: string, cards: EncodedCard[]) {
    this.staged.set(token, [...(this.staged.get(token) || []), ...cards]);
  }
  async discard(token: string) { this.staged.delete(token); }
  async commitStaged(project: string, revision: number, token: string, removed: string[], order: string[], baselineOrder?: string[]) {
    const changes = this.staged.get(token);
    if (!changes) throw new Error('后台待保存批次丢失，请重试');
    try { return await this.commit(project, revision, changes, removed, order, baselineOrder); }
    finally { this.staged.delete(token); }
  }
  private connection?: Promise<IDBDatabase>;
  private open() {
    return this.connection ||= new Promise((resolve, reject) => {
      const req = indexedDB.open(this.databaseName, 1);
      req.onupgradeneeded = () => {
        for (const store of ['projects', 'cards', 'assets', 'history']) req.result.createObjectStore(store);
      };
      req.onerror = () => { this.connection = undefined; reject(req.error); };
      req.onblocked = () => { /* Existing connections close on versionchange. Never delete the database. */ };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => { db.close(); this.connection = undefined; };
        db.onclose = () => { this.connection = undefined; };
        resolve(db);
      };
    });
  }
  private async head(project: string): Promise<Head | undefined> {
    const db = await this.open();
    return request(db.transaction('projects').objectStore('projects').get(project));
  }
  async assets(resources: Resource[]) {
    if (!resources.length) return;
    const db = await this.open();
    const tx = db.transaction('assets', 'readwrite');
    const done = completed(tx);
    try { for (const asset of resources) tx.objectStore('assets').put(asset.value, asset.id); }
    catch (error) { tx.abort(); await done.catch(() => {}); throw error; }
    await done;
  }
  async getAssets(ids: string[]): Promise<Resource[]> {
    const db = await this.open();
    const store = db.transaction('assets').objectStore('assets');
    return Promise.all(ids.map(async id => {
      const value = await request(store.get(id));
      return { id, value: value ?? null };
    }));
  }
  private async legacy(project: string): Promise<any[] | null> {
    // Read the old database inside the worker, including its large structured clone.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('InfiniteCanvasDB');
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
    try {
      if (!db.objectStoreNames.contains('workspace')) return null;
      const value = await request(db.transaction('workspace').objectStore('workspace').get(project));
      if (value == null) return null;
      if (!Array.isArray(value)) throw new Error('旧项目格式异常，停止迁移');
      return value;
    } finally { db.close(); }
  }
  private async migrate(project: string) {
    const old = await this.legacy(project);
    if (old === null) return;
    validate(old);
    const codec = new CardCodec();
    const generation = crypto.randomUUID();
    const db = await this.open();
    // Staging generations are invisible until their project head commits.
    for (let i = 0; i < old.length; i += 16) {
      const batch = [];
      for (const card of old.slice(i, i + 16)) batch.push(await codec.card(card));
      const resources = codec.pending(batch.flatMap(c => c.resources));
      await this.assets(resources);
      codec.accept(resources);
      const tx = db.transaction('cards', 'readwrite');
      const done = completed(tx);
      try {
        for (const card of batch) tx.objectStore('cards').put(card, [project, generation, card.id]);
        await done;
      } catch (error) {
        try { tx.abort(); } catch {}
        await done.catch(() => {});
        throw error;
      }
    }
    const tx = db.transaction('projects', 'readwrite');
    const done = completed(tx);
    const store = tx.objectStore('projects');
    const existing = await request(store.get(project));
    if (!existing) store.put({ generation, revision: 1, order: old.map(c => c.id) }, project);
    await done;
  }
  async getHead(project: string) { return this.head(project); }
  async load(project: string): Promise<{ head: Head; cards: EncodedCard[] } | null> {
    let head = await this.head(project);
    if (!head) { await this.migrate(project); head = await this.head(project); }
    if (!head) return null;
    if (head.deleted) return { head, cards: [] };
    const db = await this.open();
    // Head and cards must come from one consistent transaction.
    const tx = db.transaction(['projects', 'cards']);
    head = await request(tx.objectStore('projects').get(project));
    if (!head) throw new Error('项目状态丢失');
    const cards = await Promise.all(head.order.map(id =>
      request<EncodedCard>(tx.objectStore('cards').get([project, head!.generation, id]))));
    if (cards.some(c => !c)) throw new Error('卡片记录不完整，停止加载');
    return { head, cards };
  }
  async commit(project: string, revision: number, changes: EncodedCard[], removed: string[], order: string[], baselineOrder?: string[]) {
    validate(changes);
    if (new Set(order).size !== order.length) throw new Error('卡片顺序重复');
    const db = await this.open();
    const tx = db.transaction(['projects', 'cards', 'assets', 'history'], 'readwrite');
    const done = completed(tx);
    try {
      const heads = tx.objectStore('projects');
      const old: Head | undefined = await request(heads.get(project));
      if (old?.deleted) throw new Error('项目已删除，不能写入旧页面数据');
      if (!baselineOrder && (old?.revision || 0) !== revision) throw new Error('项目已在其他页面修改');
      const generation = old?.generation || crypto.randomUUID();
      const cards = tx.objectStore('cards');
      if (baselineOrder) {
        const latest = await Promise.all(changes.map(c => request<EncodedCard | undefined>(cards.get([project, generation, c.id]))));
        changes = changes.flatMap((change, i) => {
          const remote = latest[i];
          // Deletion wins over an edit from a page that still held the deleted card.
          if (change.base != null && !remote) return [];
          const data = remote && change.base != null ? mergeFields(change.base, change.data, remote.data) : change.data;
          return [{ id: change.id, data, resources: resourceIds(data) }];
        });
        const ids = new Set(old?.order || []);
        removed.forEach(id => ids.delete(id));
        changes.forEach(card => ids.add(card.id));
        const orderIds = new Set(order), baselineIds = new Set(baselineOrder);
        const reordered = baselineOrder.filter(id => orderIds.has(id));
        const localExisting = order.filter(id => baselineIds.has(id));
        const localReordered = reordered.some((id, i) => id !== localExisting[i]);
        const preferred = localReordered ? order : (old?.order || []);
        const preferredIds = new Set(preferred);
        order = [...preferred.filter(id => ids.has(id)), ...[...ids].filter(id => !preferredIds.has(id))];
      }
      const before: EncodedCard[] = [];
      const touched = [...new Set([...changes.map(c => c.id), ...removed])];
      const previous = await Promise.all(touched.map(id => request<EncodedCard | undefined>(cards.get([project, generation, id]))));
      previous.forEach(c => { if (c) before.push(c); });
      const assetIds = [...new Set(changes.flatMap(c => c.resources))];
      const assets = tx.objectStore('assets');
      const present = await Promise.all(assetIds.map(id => request(assets.count(id))));
      if (present.some(count => !count)) throw new Error('媒体尚未保存，取消卡片提交');
      const nextIds = new Set(old?.order || []);
      removed.forEach(id => nextIds.delete(id));
      changes.forEach(c => nextIds.add(c.id));
      if (nextIds.size !== order.length || order.some(id => !nextIds.has(id))) throw new Error('卡片清单不一致');
      for (const card of changes) cards.put(card, [project, generation, card.id]);
      for (const id of removed) cards.delete([project, generation, id]);
      const next: Head = { generation, revision: (old?.revision || 0) + 1, order };
      tx.objectStore('history').put({ previousHead: old || null, before, added: changes.filter(c => !previous[touched.indexOf(c.id)]).map(c => c.id), at: Date.now() }, [project, next.revision]);
      if (next.revision > 50) tx.objectStore('history').delete([project, next.revision - 50]);
      heads.put(next, project);
      await done;
      return next;
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw error;
    }
  }
  async remove(project: string, revision: number) {
    const db = await this.open();
    const tx = db.transaction(['projects', 'history'], 'readwrite');
    const done = completed(tx);
    try {
      const store = tx.objectStore('projects');
      const old: Head | undefined = await request(store.get(project));
      if ((old?.revision || 0) !== revision) throw new Error('项目已在其他页面修改，未删除');
      const next = { generation: old?.generation || crypto.randomUUID(), revision: (old?.revision || 0) + 1, order: [], deleted: true };
      tx.objectStore('history').put({ previousHead: old || null, at: Date.now(), deleted: true }, [project, next.revision]);
      if (next.revision > 50) tx.objectStore('history').delete([project, next.revision - 50]);
      store.put(next, project);
      await done;
      return next;
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw error;
    }
  }
  async restore(project: string, revision: number) {
    const db = await this.open();
    const tx = db.transaction(['projects', 'cards', 'history'], 'readwrite');
    const done = completed(tx);
    try {
      const heads = tx.objectStore('projects'), cards = tx.objectStore('cards'), history = tx.objectStore('history');
      const current: Head | undefined = await request(heads.get(project));
      if (!current || current.revision !== revision) throw new Error('恢复版本已变化');
      const log = await request(history.get([project, revision]));
      if (!log) throw new Error('没有可恢复的提交记录');
      const previous: Head | null = log.previousHead;
      const writes: EncodedCard[] = log.before || [];
      const removed: string[] = log.added || [];
      const touched = [...new Set([...writes.map(c => c.id), ...removed])];
      const oldRecords = await Promise.all(touched.map(id => request<EncodedCard | undefined>(cards.get([project, current.generation, id]))));
      for (const record of writes) cards.put(record, [project, current.generation, record.id]);
      for (const id of removed) cards.delete([project, current.generation, id]);
      const next: Head = { ...(previous || { generation: current.generation, order: [], deleted: true }), revision: revision + 1 };
      history.put({
        previousHead: current, before: oldRecords.filter(Boolean),
        added: writes.filter(c => !oldRecords[touched.indexOf(c.id)]).map(c => c.id),
        at: Date.now(), restoredFrom: revision,
      }, [project, next.revision]);
      if (next.revision > 50) history.delete([project, next.revision - 50]);
      heads.put(next, project);
      await done;
      return next;
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {});
      throw error;
    }
  }
}
