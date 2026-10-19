const DB_NAME = "MiraDraftsDb";
const STORE_NAME = "drafts";
const DB_VERSION = 20;

export function initDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not supported in this environment"));
      return;
    }

    const tryOpen = (version?: number) => {
      const request = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME);

      request.onupgradeneeded = () => {
        const db = request.result;
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

export async function getDrafts(): Promise<Record<string, string>> {
  try {
    const db = await initDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.openCursor();
      const result: Record<string, string> = {};

      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          result[cursor.key as string] = cursor.value as string;
          cursor.continue();
        } else {
          resolve(result);
        }
      };

      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error("Failed to get drafts from IndexedDB:", err);
    return {};
  }
}

export async function saveDraft(targetId: string, text: string): Promise<void> {
  try {
    const db = await initDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(text, targetId);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error(`Failed to save draft for ${targetId} to IndexedDB:`, err);
  }
}

export async function deleteDraft(targetId: string): Promise<void> {
  try {
    const db = await initDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(targetId);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error(`Failed to delete draft for ${targetId} from IndexedDB:`, err);
  }
}
