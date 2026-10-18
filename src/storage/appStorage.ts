import { createWorkspaceTransaction, transactionDone } from './database';
import { clearStorageDirty, enqueueStorageWrite, markStorageDirty, reportStorageError } from './status';
const cache = new Map<string, string>();
const dirty = new Map<string, string | null>();
let ready = false;
let scheduled = false;
let flushing: Promise<void> | undefined;
let settingsRevision: string | undefined;
function assertReady() { if (!ready) throw new Error('项目存储尚未初始化'); }

export async function writeSettingBatch(entries: Array<[string, string | null]>, marker?: string): Promise<void> {
  // Validate and prepare project records before opening the transaction.
  const projectEntry = entries.find(([key]) => key === 'script_projects');
  let projects: any[] | undefined;
  if (projectEntry?.[1] != null) {
    projects = JSON.parse(projectEntry[1]);
    if (!Array.isArray(projects) || projects.some(p => !p || typeof p.id !== 'string')) throw new Error('项目目录格式无效，已停止写入');
  }
  const tx = await createWorkspaceTransaction(['settings', 'projects', 'meta'], 'readwrite');
  const done = transactionDone(tx);
  let writeError: unknown;
  const nextRevision = crypto.randomUUID();
  const migration = marker ? tx.objectStore('meta').get(marker) : undefined;
  const version = tx.objectStore('meta').get('settings-revision');
  version.onsuccess = () => { try {
    if (migration?.result) return;
    if (ready && version.result !== settingsRevision) throw new Error('另一个页面已更新项目或设置，已阻止旧页面覆盖。请保留当前编辑后重新读取。');
    const store = tx.objectStore('settings');
    for (const [key, value] of entries) {
      if (key === 'script_projects') {
        if (value === null) { store.delete(key); continue; }
        for (const project of projects!) tx.objectStore('projects').put(project, project.id);
        store.put({ kind: 'project-index', ids: projects!.map(p => p.id) }, key);
      } else if (value === null) store.delete(key);
      else store.put(value, key);
    }
    if (marker) tx.objectStore('meta').put({ completedAt: Date.now() }, marker);
    tx.objectStore('meta').put(nextRevision, 'settings-revision');
  } catch (error) { writeError = error; tx.abort(); } };
  await done.catch(error => { throw writeError || error; });
  settingsRevision = migration?.result ? version.result : nextRevision;
}

export async function hydrateAppStorage() {
  const tx = await createWorkspaceTransaction(['settings', 'projects', 'meta'], 'readonly');
  const done = transactionDone(tx);
  const settingKeys = tx.objectStore('settings').getAllKeys();
  const settingValues = tx.objectStore('settings').getAll();
  const projectKeys = tx.objectStore('projects').getAllKeys();
  const projectValues = tx.objectStore('projects').getAll();
  const version = tx.objectStore('meta').get('settings-revision');
  await done;
  const settings = settingKeys.result.map((key, index) => [key, settingValues.result[index]] as const);
  const byId = new Map(projectKeys.result.map((key, i) => [String(key), projectValues.result[i]]));
  cache.clear();
  for (const [key, value] of settings) {
    if (key === 'script_projects' && value?.kind === 'project-index') {
      const items = value.ids.map((id: string) => {
        if (!byId.has(id)) throw new Error('项目目录引用的记录缺失，已停止加载，避免覆盖数据');
        return byId.get(id);
      });
      cache.set(String(key), JSON.stringify(items));
    } else if (typeof value === 'string') {
      if (key === 'script_projects') {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed) || parsed.some(p => !p || typeof p.id !== 'string')) throw new Error('项目目录格式无效，已停止启动');
      }
      cache.set(String(key), value);
    }
  }
  settingsRevision = version.result;
  ready = true;
}

export function flushAppStorage(): Promise<void> {
  if (flushing) return flushing;
  if (!dirty.size) return Promise.resolve();
  flushing = enqueueStorageWrite('settings', async () => {
    while (dirty.size) {
      const batch = [...dirty];
      await writeSettingBatch(batch);
      for (const [key, value] of batch) if (dirty.get(key) === value) dirty.delete(key);
    }
    clearStorageDirty('settings');
  }).finally(() => { flushing = undefined; });
  return flushing;
}
function schedule() {
  markStorageDirty('settings');
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => { scheduled = false; void flushAppStorage().catch(error => reportStorageError('settings', error)); });
}
// Synchronous reads are a hydrated memory view. IndexedDB is the only write destination.
export const appStorage = {
  getItem(key: string): string | null { assertReady(); return cache.get(key) ?? null; },
  setItem(key: string, value: string) {
    assertReady(); const next = String(value);
    if (cache.get(key) === next) return;
    cache.set(key, next); dirty.set(key, next); schedule();
  },
  removeItem(key: string) { assertReady(); if (!cache.has(key)) return; cache.delete(key); dirty.set(key, null); schedule(); },
};
