import { createWorkspaceTransaction, openWorkspaceDatabase, readValue, transactionDone } from './database';
import { hydrateAppStorage, writeSettingBatch } from './appStorage';
import { requestPersistentStorage } from './status';

async function readLegacyDatabase(name: string, store: string): Promise<Array<[IDBValidKey, unknown]>> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    let absent = false;
    request.onupgradeneeded = () => { absent = true; request.transaction!.abort(); };
    request.onerror = () => absent ? resolve([]) : reject(request.error);
    request.onblocked = () => reject(new Error('旧版数据库被占用，迁移已停止'));
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(store)) { db.close(); resolve([]); return; }
      const tx = db.transaction(store, 'readonly');
      const values = tx.objectStore(store).getAll();
      const keys = tx.objectStore(store).getAllKeys();
      transactionDone(tx).then(() => { db.close(); resolve(keys.result.map((key, i) => [key, values.result[i]])); }, error => { db.close(); reject(error); });
    };
  });
}

export async function initializeStorage() {
  const db = await openWorkspaceDatabase();
  if (!await readValue('meta', 'local-storage-migrated-v1')) {
    const entries: Array<[string, string]> = [];
    // Legacy storage is read only once; retained as a rollback source, never used at runtime.
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      const value = localStorage.getItem(key);
      if (value !== null) entries.push([key, value]);
    }
    await writeSettingBatch(entries, 'local-storage-migrated-v1');
  }
  if (!await readValue('meta', 'auxiliary-databases-migrated-v1')) {
    const [drafts, keys] = await Promise.all([readLegacyDatabase('MiraDraftsDb', 'drafts'), readLegacyDatabase('mira_mcp_config_db', 'mcp_keys')]);
    const tx = await createWorkspaceTransaction(['drafts', 'mcp_keys', 'meta'], 'readwrite');
    const done = transactionDone(tx);
    const migrated = tx.objectStore('meta').get('auxiliary-databases-migrated-v1');
    migrated.onsuccess = () => {
      if (migrated.result) return;
      for (const [id, value] of drafts) tx.objectStore('drafts').put(value, id);
      for (const [id, value] of keys) tx.objectStore('mcp_keys').put(value, id);
      tx.objectStore('meta').put({ completedAt: Date.now() }, 'auxiliary-databases-migrated-v1');
    };
    await done;
  }
  await hydrateAppStorage();
  // A denied persistence request must not be represented as a successful grant.
  await requestPersistentStorage();
}
