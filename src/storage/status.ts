/**
 * Storage queue and status tracking for sequential background writes.
 * Ensures storage tasks per project key are serialized to prevent race conditions.
 */

const pendingWrites = new Map<string, Promise<void>>();
const dirtyKeys = new Set<string>();

export function markStorageDirty(key: string): void {
  dirtyKeys.add(key);
}

export function isStorageDirty(key: string): boolean {
  return dirtyKeys.has(key);
}

export function clearStorageDirty(key: string): void {
  dirtyKeys.delete(key);
}

export function enqueueStorageWrite<T>(key: string, fn: () => Promise<T>): Promise<T> {
  markStorageDirty(key);
  const previous = pendingWrites.get(key) || Promise.resolve();

  const next = previous
    .catch(() => {})
    .then(async () => {
      try {
        return await fn();
      } finally {
        if (pendingWrites.get(key) === next) {
          pendingWrites.delete(key);
          clearStorageDirty(key);
        }
      }
    });

  pendingWrites.set(key, next.then(() => {}));
  return next;
}

export async function waitForStorageWrite(key: string): Promise<void> {
  const pending = pendingWrites.get(key);
  if (pending) {
    await pending.catch(() => {});
  }
}
