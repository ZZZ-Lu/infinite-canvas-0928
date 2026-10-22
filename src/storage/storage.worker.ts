import { StorageBackend } from './backend';
const backend = new StorageBackend();
// Requests may overlap across projects; IndexedDB transactions protect revisions.
self.onmessage = async (event: MessageEvent) => {
  const { id, method, args } = event.data;
  try {
    if (!['getHead', 'load', 'assets', 'getAssets', 'commit', 'remove', 'restore', 'stage', 'discard', 'commitStaged'].includes(method)) throw new Error('Invalid storage operation');
    const value = await (backend[method as keyof StorageBackend] as Function).apply(backend, args);
    self.postMessage({ id, value });
  } catch (error) {
    self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
