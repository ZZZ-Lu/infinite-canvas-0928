import type { AgentRuntimeTrace } from './agent/debugTrace';
import type { CardData } from './components/GenerationCard';
import { capture, mergeChanges } from './utils/storageMerge';

const DB_NAME = 'InfiniteCanvasDB';
const STORE_NAME = 'workspace';
const baselines = new Map<string, CardData[]>();
const queues = new Map<string, Promise<unknown>>();
const failed = new Map<string, () => Promise<unknown>>();
const listeners = new Set<(event: CardSaveStatus) => void>();
let pending = 0;
export type CardSaveStatus = { projectId?: string; state: 'saved' | 'error'; count: number; cards?: CardData[]; error?: string };
export function subscribeCardSaves(fn: (event: CardSaveStatus) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
function report(event: CardSaveStatus) { listeners.forEach(fn => { try { fn(event); } catch (error) { console.error(error); } }); }
export const hasPendingStorage = () => pending > 0 || failed.size > 0;
const keyFor = (id?: string) => id ? `cards_${id}` : 'cards';

// Open the existing version; never downgrade, delete, or upgrade an unfamiliar DB.
function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB not supported')); return; }
    const request = indexedDB.open(DB_NAME);
    let blocked = false;
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error('数据库被其他页面占用，请保留当前编辑后关闭旧页面再重试。')); };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      if (!db.objectStoreNames.contains(STORE_NAME)) { db.close(); reject(new Error('数据库格式不兼容，已停止操作并保留所有原数据。')); return; }
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}
function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    let cause: DOMException | null = null;
    tx.oncomplete = () => resolve();
    tx.onerror = event => { cause = (event.target as IDBRequest)?.error || tx.error; };
    tx.onabort = () => reject(cause || tx.error || new Error('数据库事务已中止，数据未保存。'));
  });
}
async function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore, tx: IDBTransaction) => () => T): Promise<T> {
  const db = await openDB();
  try {
    const tx = db.transaction(STORE_NAME, mode), done = completed(tx);
    let result: () => T;
    try { result = action(tx.objectStore(STORE_NAME), tx); }
    catch (error) { tx.abort(); await done.catch(() => {}); throw error; }
    await done;
    return result();
  } finally { db.close(); }
}
function enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
  pending++;
  const task = (queues.get(key) || Promise.resolve()).catch(() => {}).then(operation);
  queues.set(key, task);
  task.then(() => { if (queues.get(key) === task) { queues.delete(key); failed.delete(key); } pending--; }, () => {
    if (queues.get(key) === task) { queues.delete(key); failed.set(key, operation); } pending--;
  });
  return task;
}
export async function retryFailedCardSaves() { await Promise.all([...failed].map(([key, operation]) => enqueue(key, operation))); }
function validate(cards: CardData[]) {
  const ids = new Set<string>();
  for (const card of cards) {
    if (!card.id || ids.has(card.id)) throw new Error('卡片 ID 缺失或重复，已停止保存。');
    ids.add(card.id);
    if (card.imageUrl?.startsWith('blob:') && !(card.fileData instanceof Blob)) throw new Error('本地图片尚无可持久化的文件，已停止保存并保留原数据。');
  }
}
export function saveCards(cards: CardData[], projectId?: string): Promise<void> {
  const key = keyFor(projectId);
  let snapshot: CardData[];
  try { snapshot = capture(cards); validate(snapshot); }
  catch (error) { report({ projectId, state: 'error', count: cards.length, error: String(error) }); return enqueue(key, async () => { throw error; }); }
  let base: CardData[] | undefined;
  let started = false;
  return enqueue(key, async () => {
    try {
      // A retry must merge against the same local baseline as its first attempt.
      if (!started) { base = baselines.get(key); started = true; }
      let writeError: unknown;
      await transaction('readwrite', (store, tx) => {
        const prior = store.get(key), info = store.get(key + '_save_info');
        info.onsuccess = () => { try {
          if (info.result?.deleted) throw new Error('项目已在其他页面删除，已停止旧页面覆盖。');
          if (prior.result !== undefined && !Array.isArray(prior.result)) throw new Error('项目数据格式异常，已停止覆盖。');
          if (prior.result === undefined && (base || info.result)) throw new Error('原有项目数据缺失，已停止覆盖。');
          if (prior.result !== undefined && !base) throw new Error('项目尚未读取，请先重新读取后保存，避免覆盖其他页面数据。');
          const merged = mergeChanges(base || [], snapshot, prior.result || []);
          validate(merged);
          if (prior.result?.length) store.put(prior.result, key + '_backup');
          store.put(merged, key);
          store.put({ revision: crypto.randomUUID(), savedAt: Date.now(), count: merged.length, deleted: false }, key + '_save_info');
        } catch (error) { writeError = error; tx.abort(); } };
        return () => undefined;
      }).catch(error => { throw writeError || error; });
      baselines.set(key, snapshot);
      report({ projectId, state: 'saved', count: snapshot.length, cards });
    } catch (error) {
      report({ projectId, state: 'error', count: snapshot.length, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });
}
export async function loadCards(projectId?: string): Promise<CardData[] | null> {
  const key = keyFor(projectId);
  await queues.get(key)?.catch(() => {});
  const value = await transaction('readonly', store => {
    const request = store.get(key), info = store.get(key + '_save_info');
    return () => {
      if (info.result?.deleted) throw new Error('项目已删除，原数据保留在备份中。');
      if (request.result === undefined && info.result) throw new Error('项目记录缺失，已停止加载和自动覆盖。');
      return request.result;
    };
  });
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw new Error('项目数据格式异常，已停止加载。');
  validate(value);
  baselines.set(key, capture(value));
  return value;
}
export async function loadCardBackup(projectId?: string): Promise<CardData[] | null> {
  return transaction('readonly', store => { const r = store.get(keyFor(projectId) + '_backup'); return () => r.result ?? null; });
}
export function restoreCardBackup(projectId?: string): Promise<void> {
  const key = keyFor(projectId);
  return enqueue(key, async () => {
    let restored: CardData[] = [], problem: unknown;
    await transaction('readwrite', (store, tx) => {
      const backup = store.get(key + '_backup');
      backup.onsuccess = () => { try {
        if (!Array.isArray(backup.result)) throw new Error('没有可恢复的备份，原数据未修改。');
        validate(backup.result); restored = backup.result;
        store.put(restored, key);
        store.put({ revision: crypto.randomUUID(), savedAt: Date.now(), count: restored.length, deleted: false }, key + '_save_info');
      } catch (error) { problem = error; tx.abort(); } };
      return () => undefined;
    }).catch(error => { throw problem || error; });
    baselines.set(key, capture(restored));
    report({ projectId, state: 'saved', count: restored.length, cards: restored });
  });
}
export function deleteCardsForProject(projectId: string): Promise<void> {
  const key = keyFor(projectId);
  return enqueue(key, async () => {
    await transaction('readwrite', store => {
      const request = store.get(key);
      request.onsuccess = () => {
        if (request.result?.length) store.put(request.result, key + '_backup');
        store.delete(key);
        store.put({ deleted: true, savedAt: Date.now() }, key + '_save_info');
      };
      return () => undefined;
    });
    baselines.delete(key);
  });
}
export async function requestPersistence(): Promise<boolean> {
  try { return !!(navigator.storage?.persist && (await navigator.storage.persisted() || await navigator.storage.persist())); }
  catch { return false; }
}
export function saveAgentTraces(traces: AgentRuntimeTrace[]): Promise<void> {
  const snapshot = capture(traces.slice(-50));
  return enqueue('agent_traces', () => transaction('readwrite', store => { store.put(snapshot, 'agent_traces'); return () => undefined; }));
}
export function loadAgentTraces(): Promise<AgentRuntimeTrace[] | null> {
  return transaction('readonly', store => { const r = store.get('agent_traces'); return () => r.result ?? null; });
}
