import type { CardData } from '../components/GenerationCard';
import { createWorkspaceTransaction, readValue, transactionDone } from './database';
import { enqueueStorageWrite, waitForStorageWrite } from './status';

type Snapshot = { id: string; cardKeys: string[]; assetIds: string[]; savedAt: number };
type Manifest = { current: Snapshot; backup?: Snapshot };
const assetIds = new WeakMap<Blob, Map<string, string>>();
const lastCommitted = new WeakMap<CardData[], { project: string; revision: string }>();
const revisions = new Map<string, string>();
const failedSaves = new Map<string, CardData[]>();
const listeners = new Set<(status: CardSaveStatus) => void>();
export type CardSaveStatus = { projectId?: string; state: 'saved' | 'error'; count: number; at: number; error?: string };
export const projectKey = (id?: string) => id ? `cards_${id}` : 'cards';
export function subscribeCardSaves(fn: (status: CardSaveStatus) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
function report(status: CardSaveStatus) { listeners.forEach(fn => { try { fn(status); } catch (error) { console.error(error); } }); }

function encode(value: any, project: string, blobs: Map<string, Blob>, ancestors = new Set<object>()): any {
  if (value instanceof Blob) {
    let ids = assetIds.get(value);
    if (!ids) { ids = new Map(); assetIds.set(value, ids); }
    let id = ids.get(project);
    if (!id) { id = `${project}:${crypto.randomUUID()}`; ids.set(project, id); }
    blobs.set(id, value);
    return { __mira_asset__: id };
  }
  if (value === null || value === undefined || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') throw new Error('卡片包含不可保存的数据');
    return value;
  }
  if (ancestors.has(value)) throw new Error('卡片存在循环引用，已停止保存');
  ancestors.add(value);
  const result = Array.isArray(value) ? value.map(item => encode(item, project, blobs, ancestors))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item, project, blobs, ancestors)]));
  ancestors.delete(value);
  return result;
}
function decode(value: any, blobs: Map<string, Blob>, project: string): any {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (typeof value.__mira_asset__ === 'string' && Object.keys(value).length === 1) {
    const id = value.__mira_asset__;
    const blob = blobs.get(id);
    if (!(blob instanceof Blob)) throw new Error('图片二进制记录缺失，已停止加载与自动覆盖');
    let ids = assetIds.get(blob);
    if (!ids) { ids = new Map(); assetIds.set(blob, ids); }
    ids.set(project, id);
    return blob;
  }
  return Array.isArray(value) ? value.map(item => decode(item, blobs, project))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item, blobs, project)]));
}
function prepare(cards: CardData[], project: string) {
  const blobs = new Map<string, Blob>();
  const ids = new Set<string>();
  const id = crypto.randomUUID();
  const records = cards.map(card => {
    if (!card.id || ids.has(card.id)) throw new Error('卡片 ID 缺失或重复，已停止保存');
    ids.add(card.id);
    if (card.imageUrl?.startsWith('blob:') && !(card.fileData instanceof Blob)) throw new Error('本地图片尚无二进制数据，已保留上次保存');
    return { key: JSON.stringify([project, id, card.id]), value: encode(card, project, blobs) };
  });
  return { records, blobs, snapshot: { id, cardKeys: records.map(item => item.key), assetIds: [...blobs.keys()], savedAt: Date.now() } satisfies Snapshot };
}

export function saveCards(cards: CardData[], projectId?: string): Promise<void> {
  const key = projectKey(projectId);
  // Snapshot metadata before any await; File/Blob is immutable and stored separately.
  let prepared: ReturnType<typeof prepare>;
  try { prepared = prepare(cards, key); } catch (error) {
    failedSaves.set(key, cards);
    return enqueueStorageWrite(key, async () => { throw error; });
  }
  failedSaves.set(key, cards);
  return enqueueStorageWrite(key, async () => {
    try {
      const known = lastCommitted.get(cards);
      if (known?.project === key && revisions.get(key) === known.revision) {
        if (failedSaves.get(key) === cards) failedSaves.delete(key);
        return;
      }
      const tx = await createWorkspaceTransaction(['manifests', 'card_records', 'assets'], 'readwrite');
      const done = transactionDone(tx);
      const manifests = tx.objectStore('manifests');
      const priorRequest = manifests.get(key);
      let writeError: unknown;
      priorRequest.onsuccess = () => {
        try {
          const prior = priorRequest.result as Manifest | undefined;
          if (prior && revisions.get(key) !== prior.current.id) {
            throw new Error('另一个页面已更新此项目，已阻止覆盖。请先保留当前编辑并重新读取。');
          }
          const backup = prior?.current.cardKeys.length ? prior.current : prior?.backup;
          const keepAssets = new Set([...(prior?.current.assetIds || []), ...(prior?.backup?.assetIds || [])]);
          for (const [id, blob] of prepared.blobs) if (!keepAssets.has(id)) tx.objectStore('assets').put(blob, id);
          for (const record of prepared.records) tx.objectStore('card_records').put(record.value, record.key);
          manifests.put({ current: prepared.snapshot, backup }, key);
          // Reclaim only versions that are no longer current or recoverable.
          const keepKeys = new Set([...prepared.snapshot.cardKeys, ...(backup?.cardKeys || [])]);
          const keepBlobIds = new Set([...prepared.snapshot.assetIds, ...(backup?.assetIds || [])]);
          for (const old of [prior?.current, prior?.backup]) {
            for (const cardKey of old?.cardKeys || []) if (!keepKeys.has(cardKey)) tx.objectStore('card_records').delete(cardKey);
            for (const blobId of old?.assetIds || []) if (!keepBlobIds.has(blobId)) tx.objectStore('assets').delete(blobId);
          }
        } catch (error) { writeError = error; tx.abort(); }
      };
      await done.catch(error => { throw writeError || error; });
      revisions.set(key, prepared.snapshot.id);
      lastCommitted.set(cards, { project: key, revision: prepared.snapshot.id });
      if (failedSaves.get(key) === cards) failedSaves.delete(key);
      report({ projectId, state: 'saved', count: cards.length, at: Date.now() });
    } catch (error) {
      report({ projectId, state: 'error', count: cards.length, at: Date.now(), error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });
}

async function readSnapshot(project: string, backup: boolean): Promise<CardData[] | null> {
  const tx = await createWorkspaceTransaction(['manifests', 'card_records', 'assets'], 'readonly');
  const done = transactionDone(tx);
  const manifestRequest = tx.objectStore('manifests').get(project);
  const records: IDBRequest[] = [];
  const blobs = new Map<string, IDBRequest>();
  let selected: Snapshot | undefined;
  manifestRequest.onsuccess = () => {
    const manifest = manifestRequest.result as Manifest | undefined;
    selected = backup ? manifest?.backup : manifest?.current;
    if (selected) {
      for (const key of selected.cardKeys) records.push(tx.objectStore('card_records').get(key));
      for (const id of selected.assetIds) blobs.set(id, tx.objectStore('assets').get(id));
    }
  };
  await done;
  if (!selected) return null;
  const assets = new Map([...blobs].map(([id, request]) => [id, request.result]));
  const restored = records.map(request => {
    if (!request.result) throw new Error('卡片记录缺失，已停止加载与自动覆盖');
    return decode(request.result, assets, project);
  });
  if (!backup) revisions.set(project, selected.id);
  return restored;
}
export async function loadCards(projectId?: string): Promise<CardData[] | null> {
  const key = projectKey(projectId);
  await waitForStorageWrite(key);
  const current = await readSnapshot(key, false);
  if (current !== null) return current;
  const legacy = await readValue<CardData[]>('workspace', key);
  if (legacy === undefined) return null;
  if (!Array.isArray(legacy)) throw new Error('旧版卡片数据格式无效，已停止迁移');
  // Legacy record remains intact; commit new representation before reporting success.
  await saveCards(legacy, projectId);
  return legacy;
}
export async function loadCardBackup(projectId?: string) {
  const key = projectKey(projectId);
  await waitForStorageWrite(key);
  return await readSnapshot(key, true) ?? await readValue<CardData[]>('workspace', `${key}_backup`) ?? null;
}
export async function retryCardSaves() {
  await Promise.all([...failedSaves].map(([key, cards]) => saveCards(cards, key === 'cards' ? undefined : key.slice(6))));
}
export function deleteCardsForProject(projectId: string): Promise<void> {
  const key = projectKey(projectId);
  return enqueueStorageWrite(key, async () => {
    const tx = await createWorkspaceTransaction(['manifests', 'card_records', 'assets', 'workspace'], 'readwrite');
    const done = transactionDone(tx);
    const request = tx.objectStore('manifests').get(key);
    request.onsuccess = () => {
      const manifest = request.result as Manifest | undefined;
      for (const version of [manifest?.current, manifest?.backup]) {
        for (const cardKey of version?.cardKeys || []) tx.objectStore('card_records').delete(cardKey);
        for (const id of version?.assetIds || []) tx.objectStore('assets').delete(id);
      }
      tx.objectStore('manifests').delete(key);
      for (const suffix of ['', '_backup', '_save_info']) tx.objectStore('workspace').delete(key + suffix);
    };
    await done;
    revisions.delete(key); failedSaves.delete(key);
  });
}
