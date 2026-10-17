import type { AgentRuntimeTrace } from './agent/debugTrace';
import { CardData } from './components/GenerationCard';

const DB_NAME = 'InfiniteCanvasDB';
const STORE_NAME = 'workspace';
const DB_VERSION = 1;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    
    request.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
  });
}

export async function requestPersistence(): Promise<boolean> {
  try {
    if (navigator.storage && navigator.storage.persist) {
      let isPersisted = await navigator.storage.persisted();
      if (!isPersisted) {
        isPersisted = await navigator.storage.persist();
      }
      console.log(`Storage persistence status: ${isPersisted ? 'Persisted' : 'Not Persisted'}`);
      return isPersisted;
    }
  } catch (error) {
    console.error('Failed to request persistence:', error);
  }
  return false;
}

export type CardSaveStatus = { projectId?: string; state: 'saved' | 'error'; count: number; at: number; error?: string };
const saveListeners = new Set<(status: CardSaveStatus) => void>();
const saveQueues = new Map<string, Promise<void>>();
const savedSnapshots = new WeakMap<CardData[], { key: string; version: number }>();
const savedVersions = new Map<string, number>();
function isCurrentSnapshot(cards: CardData[], key: string) {
  const saved = savedSnapshots.get(cards);
  return saved?.key === key && saved.version === savedVersions.get(key);
}
export function subscribeCardSaves(listener: (status: CardSaveStatus) => void) {
  saveListeners.add(listener);
  return () => { saveListeners.delete(listener); };
}

export function saveCards(cards: CardData[], projectId?: string): Promise<void> {
  const key = projectId ? `cards_${projectId}` : 'cards';
  if (isCurrentSnapshot(cards, key) && !saveQueues.has(key)) return Promise.resolve();
  const snapshot = cards.slice();
  const task = (saveQueues.get(key) || Promise.resolve()).catch(() => {}).then(async () => {
    if (isCurrentSnapshot(cards, key)) return;
    try {
      const db = await openDB();
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error || new Error('Card save aborted'));
          tx.onerror = () => reject(tx.error || new Error('Card save failed'));
          const store = tx.objectStore(STORE_NAME);
          const old = store.get(key);
          old.onsuccess = () => {
            try {
              // Atomic backup and replacement; preserve the last nonempty snapshot.
              if (Array.isArray(old.result) && old.result.length > 0) store.put(old.result, `${key}_backup`);
              store.put(snapshot, key);
              store.put({ savedAt: Date.now(), count: snapshot.length }, `${key}_save_info`);
            } catch (error) { tx.abort(); reject(error); }
          };
        });
      } finally { db.close(); }
      const version = (savedVersions.get(key) || 0) + 1;
      savedVersions.set(key, version);
      savedSnapshots.set(cards, { key, version });
      saveListeners.forEach(fn => fn({ projectId, state: 'saved', count: snapshot.length, at: Date.now() }));
    } catch (error) {
      saveListeners.forEach(fn => fn({ projectId, state: 'error', count: snapshot.length, at: Date.now(), error: error instanceof Error ? error.message : String(error) }));
      throw error;
    }
  });
  saveQueues.set(key, task);
  const cleanup = () => { if (saveQueues.get(key) === task) saveQueues.delete(key); };
  task.then(cleanup, cleanup);
  return task;
}

export async function loadCards(projectId?: string): Promise<CardData[] | null> {
  const key = projectId ? `cards_${projectId}` : 'cards';
  await saveQueues.get(key)?.catch(() => {});
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
    
    tx.oncomplete = () => { db.close(); resolve(request.result ?? null); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Card load aborted')); };
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteCardsForProject(projectId: string): Promise<void> {
  await saveQueues.get(`cards_${projectId}`)?.catch(() => {});
  savedVersions.set(`cards_${projectId}`, (savedVersions.get(`cards_${projectId}`) || 0) + 1);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(`cards_${projectId}`);
    store.delete(`cards_${projectId}_backup`);
    store.delete(`cards_${projectId}_save_info`);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error('Project deletion aborted')); };
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveAgentTraces(traces: AgentRuntimeTrace[]): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    // Keep max 50 traces to avoid taking up too much space
    const request = store.put(traces.slice(-50), 'agent_traces');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function loadAgentTraces(): Promise<AgentRuntimeTrace[] | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get('agent_traces');
    
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}
