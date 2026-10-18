export const DATABASE_NAME = 'InfiniteCanvasDB';
export const DATABASE_VERSION = 2;
export const STORES = ['workspace', 'settings', 'projects', 'manifests', 'card_records', 'assets', 'drafts', 'mcp_keys', 'traces', 'meta'] as const;
let connection: Promise<IDBDatabase> | undefined;
let activeDatabase: IDBDatabase | undefined;
function invalidateConnection(db: IDBDatabase) {
  if (activeDatabase === db) { activeDatabase = undefined; connection = undefined; }
  try { db.close(); } catch {}
}

export function openWorkspaceDatabase(): Promise<IDBDatabase> {
  if (!connection) {
    connection = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      let blocked = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        for (const name of STORES) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
        }
      };
      request.onblocked = () => { blocked = true; reject(new Error('数据库升级被旧页面占用，请关闭其他旧版画布页面后重试。')); };
      request.onerror = () => reject(request.error || new Error('无法打开项目数据库'));
      request.onsuccess = () => {
        const db = request.result;
        if (blocked) { db.close(); return; }
        activeDatabase = db;
        db.onversionchange = () => invalidateConnection(db);
        db.onclose = () => invalidateConnection(db);
        resolve(db);
      };
    }).catch(error => { connection = undefined; throw error; });
  }
  return connection;
}

// Retry only creation of a transaction: no write requests have been issued yet.
export async function createWorkspaceTransaction(stores: string | string[], mode: IDBTransactionMode = 'readonly'): Promise<IDBTransaction> {
  for (let attempt = 0; ; attempt++) {
    const db = await openWorkspaceDatabase();
    try { return db.transaction(stores, mode); }
    catch (error) {
      if ((error as DOMException)?.name !== 'InvalidStateError') throw error;
      invalidateConnection(db);
      if (attempt >= 1) throw error;
    }
  }
}

export function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
  });
}

// Install completion handlers before issuing requests. Never await network/CPU work in a transaction.
export function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    let cause: DOMException | null = null;
    tx.oncomplete = () => resolve();
    tx.onerror = event => { cause = (event.target as IDBRequest)?.error || tx.error; };
    tx.onabort = () => {
      const error = cause || tx.error || new Error('IndexedDB 事务已中止');
      // Only tear down the active connection if the database is actually closing/closed,
      // avoiding cascading failures across other concurrent stores (settings/projects/drafts).
      if (/closing|closed/i.test(error.message)) invalidateConnection(tx.db);
      reject(error);
    };
  });
}

export async function readValue<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const tx = await createWorkspaceTransaction(store, 'readonly');
  const done = transactionDone(tx);
  const request = tx.objectStore(store).get(key);
  await done;
  return request.result;
}

export async function readEntries<T>(store: string): Promise<Array<[IDBValidKey, T]>> {
  const tx = await createWorkspaceTransaction(store, 'readonly');
  const done = transactionDone(tx);
  const values = tx.objectStore(store).getAll();
  const keys = tx.objectStore(store).getAllKeys();
  await done;
  return keys.result.map((key, i) => [key, values.result[i]]);
}
