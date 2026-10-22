import type { AgentRuntimeTrace } from "./agent/debugTrace";
import { CardData } from "./components/GenerationCard";
import { cardRepository } from './storage/client';

const DB_NAME = "InfiniteCanvasDB";
const STORE_NAME = "workspace";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      return reject(new Error("IndexedDB is not supported"));
    }

    const tryOpen = (version?: number) => {
      const request = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);

      request.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        if (db.objectStoreNames.contains(STORE_NAME)) {
          resolve(db);
        } else {
          const nextVer = (db.version || 1) + 1;
          db.close();
          tryOpen(nextVer);
        }
      };

      request.onerror = () => {
        const err = request.error;
        reject(err);
      };
    };

    tryOpen();
  });
}

export async function requestPersistence(): Promise<boolean> {
  try {
    if (navigator.storage && navigator.storage.persist) {
      let isPersisted = await navigator.storage.persisted();
      if (!isPersisted) {
        isPersisted = await navigator.storage.persist();
      }
      console.log(`Storage persistence status: ${isPersisted ? "Persisted" : "Not Persisted"}`);
      return isPersisted;
    }
  } catch (error) {
    console.error("Failed to request persistence:", error);
  }
  return false;
}

export async function saveCards(cards: CardData[], projectId?: string): Promise<void> {
  await cardRepository.save(cards, projectId ? `cards_${projectId}` : 'cards');
}

export async function loadCards(projectId?: string): Promise<CardData[] | null> {
  return cardRepository.load(projectId ? `cards_${projectId}` : 'cards');
}

export async function deleteCardsForProject(projectId: string): Promise<void> {
  await cardRepository.remove(`cards_${projectId}`);
}

export function hasPendingCardSaves() { return cardRepository.hasPending(); }
export function restorePreviousCardSave(projectId: string) {
  return cardRepository.restore(`cards_${projectId}`);
}

export async function saveAgentTraces(traces: AgentRuntimeTrace[]): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(traces.slice(-50), "agent_traces");
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onabort = () => { db.close(); reject(tx.error || request.error); };
  });
}

export async function loadAgentTraces(): Promise<AgentRuntimeTrace[] | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get("agent_traces");
        
    request.onsuccess = () => { db.close(); resolve(request.result || null); };
    request.onerror = () => { db.close(); reject(request.error); };
  });
}


const cardSyncListeners = new Set<(projectId: string) => void>();
const cardSyncChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('infinite-canvas-card-commits') : null;
const notifyCardSync = (key: string) => {
  if (typeof key !== 'string' || !key.startsWith('cards_')) return;
  cardSyncListeners.forEach(listener => listener(key.slice(6)));
};
cardRepository.onCommit = key => { cardSyncChannel?.postMessage(key); notifyCardSync(key); };
if (cardSyncChannel) cardSyncChannel.onmessage = event => notifyCardSync(event.data);
export function subscribeCardSync(listener: (projectId: string) => void) {
  cardSyncListeners.add(listener);
  return () => { cardSyncListeners.delete(listener); };
}
export function synchronizeCards(projectId: string, snapshot: CardData[], stillCurrent: () => boolean) {
  return cardRepository.synchronize(`cards_${projectId}`, snapshot, stillCurrent);
}