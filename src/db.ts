import type { AgentRuntimeTrace } from "./agent/debugTrace";
import { CardData } from "./components/GenerationCard";

const DB_NAME = "InfiniteCanvasDB";
const STORE_NAME = "workspace";
const DB_VERSION = 20;

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
        if (err && (err.name === "VersionError" || err.message?.includes("version"))) {
          console.warn("Version error opening " + DB_NAME + ", recreating database...");
          const delReq = indexedDB.deleteDatabase(DB_NAME);
          delReq.onsuccess = () => tryOpen(DB_VERSION);
          delReq.onerror = () => reject(err);
        } else {
          reject(err);
        }
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
  const db = await openDB();
  const key = projectId ? `cards_${projectId}` : "cards";
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(cards, key);
        
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function loadCards(projectId?: string): Promise<CardData[] | null> {
  const db = await openDB();
  const key = projectId ? `cards_${projectId}` : "cards";
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(key);
        
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteCardsForProject(projectId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(`cards_${projectId}`);
        
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function saveAgentTraces(traces: AgentRuntimeTrace[]): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(traces.slice(-50), "agent_traces");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function loadAgentTraces(): Promise<AgentRuntimeTrace[] | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get("agent_traces");
        
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}
