export interface StorageState {
  pending: number;
  dirty: number;
  errors: Record<string, string>;
  lastSavedAt: number | null;
  persistence: 'checking' | 'granted' | 'denied' | 'unsupported';
}
let state: StorageState = { pending: 0, dirty: 0, errors: {}, lastSavedAt: null, persistence: 'checking' };
const listeners = new Set<() => void>();
const dirtyKeys = new Set<string>();
const queues = new Map<string, Promise<unknown>>();
const failedOperations = new Map<string, () => Promise<unknown>>();
function update(patch: Partial<StorageState>) {
  state = { ...state, ...patch };
  listeners.forEach(fn => { try { fn(); } catch (error) { console.error(error); } });
}
export const getStorageState = () => state;
export function subscribeStorageState(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function markStorageDirty(key: string) { dirtyKeys.add(key); update({ dirty: dirtyKeys.size }); }
export function clearStorageDirty(key: string) { dirtyKeys.delete(key); update({ dirty: dirtyKeys.size }); }
export function describeStorageError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Failed to write blobs|IOError/i.test(message)) return `图片或视频写入磁盘失败，请检查磁盘剩余空间和源文件。${message}`;
  if ((error as DOMException)?.name === 'QuotaExceededError') return `浏览器存储空间不足。${message}`;
  return message;
}
export function reportStorageError(key: string, error: unknown) {
  const previous = state.errors[key];
  // Preserve the initiating IO error instead of replacing it with cascading close errors.
  const message = previous && /IOError|Failed to write blobs/i.test(previous) && /closing|closed/i.test(describeStorageError(error))
    ? previous : describeStorageError(error);
  update({ errors: { ...state.errors, [key]: message } });
}
export function clearStorageError(key: string) {
  const errors = { ...state.errors }; delete errors[key]; update({ errors });
}
export function enqueueStorageWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
  markStorageDirty(key);
  update({ pending: state.pending + 1 });
  const task = (queues.get(key) || Promise.resolve()).catch(() => {}).then(operation);
  queues.set(key, task);
  task.then(() => {
    if (queues.get(key) === task) { queues.delete(key); failedOperations.delete(key); clearStorageDirty(key); clearStorageError(key); }
    update({ pending: state.pending - 1, lastSavedAt: Date.now() });
  }, error => {
    if (queues.get(key) === task) { queues.delete(key); failedOperations.set(key, operation); }
    update({ pending: state.pending - 1 });
    reportStorageError(key, error);
  });
  return task;
}
export async function retryFailedStorageWrites() {
  await Promise.all([...failedOperations].map(([key, operation]) => enqueueStorageWrite(key, operation)));
}
export async function waitForStorageWrite(key: string) { await queues.get(key)?.catch(() => {}); }
export function hasUnsavedData() { return state.pending > 0 || state.dirty > 0 || Object.keys(state.errors).length > 0; }
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.persist) {
      update({ persistence: 'unsupported' }); return false;
    }
    const granted = await navigator.storage.persisted() || await navigator.storage.persist();
    update({ persistence: granted ? 'granted' : 'denied' });
    return granted;
  } catch (error) {
    update({ persistence: 'denied' });
    return false;
  }
}
