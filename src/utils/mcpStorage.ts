/**
 * IndexedDB storage utility for WorkRally MCP (Model Context Protocol) tokens & configuration.
 * Adheres to Data-DOM Decoupling and provides reliable persistent client-side key storage.
 */

export interface McpKeyItem {
  id: string;
  name: string;
  token: string;
  serverUrl: string;
  createdAt: number;
  lastUsedAt?: number;
  lastTestedAt?: number;
  lastTestStatus?: 'success' | 'failed';
  lastTestMessage?: string;
  discoveredTools?: string[];
  isActive: boolean;
}

const DB_NAME = 'mira_mcp_config_db';
const DB_VERSION = 1;
const STORE_NAME = 'mcp_keys';
const DEFAULT_SERVER_URL = 'https://workrally.qq.com/zenstudio/api/mcp';

let dbInstance: IDBDatabase | null = null;
const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach(cb => {
    try {
      cb();
    } catch (e) {
      console.error('Error in MCP key listener', e);
    }
  });
}

export function subscribeMcpKeyChanges(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) {
    return Promise.resolve(dbInstance);
  }

  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      return reject(new Error('IndexedDB not supported in current environment'));
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('isActive', 'isActive', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    request.onsuccess = (event) => {
      dbInstance = (event.target as IDBOpenDBRequest).result;
      dbInstance.onversionchange = () => {
        dbInstance?.close();
        dbInstance = null;
      };
      resolve(dbInstance);
    };

    request.onerror = () => {
      reject(request.error || new Error('Failed to open MCP IndexedDB'));
    };
  });
}

/**
 * Get all saved MCP Keys from IndexedDB
 */
export async function getMcpKeys(): Promise<McpKeyItem[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        const items = (request.result || []) as McpKeyItem[];
        // Sort by active first, then created desc
        items.sort((a, b) => {
          if (a.isActive && !b.isActive) return -1;
          if (!a.isActive && b.isActive) return 1;
          return (b.createdAt || 0) - (a.createdAt || 0);
        });
        resolve(items);
      };

      request.onerror = () => {
        reject(request.error || new Error('Failed to read MCP keys'));
      };
    });
  } catch (e) {
    console.warn('Fallback: reading MCP keys failed', e);
    return [];
  }
}

const CACHE_KEY = 'mira_cached_active_mcp';
const TOKEN_KEY = 'mira_active_mcp_token';
let activeMcpKeyCache: McpKeyItem | null = null;

if (typeof window !== 'undefined') {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) activeMcpKeyCache = JSON.parse(raw);
  } catch {}
}

export function getActiveMcpKeySync(): McpKeyItem | null {
  return activeMcpKeyCache;
}

export function getActiveMcpTokenSync(): string {
  if (activeMcpKeyCache?.token) return activeMcpKeyCache.token;
  if (typeof window !== 'undefined') {
    try {
      const direct = localStorage.getItem(TOKEN_KEY);
      if (direct) return direct;
      const raw = localStorage.getItem(CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.token) return parsed.token;
      }
    } catch {}
  }
  return '';
}

function updateActiveCache(item: McpKeyItem | null) {
  activeMcpKeyCache = item;
  if (typeof window !== 'undefined') {
    try {
      if (item) {
        localStorage.setItem(CACHE_KEY, JSON.stringify(item));
        if (item.token) {
          localStorage.setItem(TOKEN_KEY, item.token);
        }
      } else {
        localStorage.removeItem(CACHE_KEY);
        localStorage.removeItem(TOKEN_KEY);
      }
    } catch {}
  }
}

// Prime cache on module load
if (typeof window !== 'undefined') {
  setTimeout(() => {
    getActiveMcpKey().catch(() => {});
  }, 0);
}

/**
 * Get currently active MCP Key from IndexedDB
 */
export async function getActiveMcpKey(): Promise<McpKeyItem | null> {
  const keys = await getMcpKeys();
  const active = keys.find(k => k.isActive) || (keys.length > 0 ? keys[0] : null);
  updateActiveCache(active);
  return active;
}

/**
 * Save or update an MCP Key item in IndexedDB
 */
export async function saveMcpKey(
  item: Omit<McpKeyItem, 'id' | 'createdAt'> & { id?: string }
): Promise<McpKeyItem> {
  const db = await openDB();
  const allKeys = await getMcpKeys();

  const id = item.id || `mcp_key_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const now = Date.now();

  const isFirstKey = allKeys.length === 0;
  const shouldBeActive = item.isActive ?? isFirstKey;

  const newItem: McpKeyItem = {
    id,
    name: item.name.trim() || 'WorkRally 密钥',
    token: item.token.trim(),
    serverUrl: item.serverUrl?.trim() || DEFAULT_SERVER_URL,
    createdAt: (item as any).createdAt || now,
    lastUsedAt: item.lastUsedAt,
    lastTestedAt: item.lastTestedAt,
    lastTestStatus: item.lastTestStatus,
    lastTestMessage: item.lastTestMessage,
    discoveredTools: item.discoveredTools,
    isActive: shouldBeActive,
  };

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    // If this item is set to active, deactivate all other keys in transaction
    if (newItem.isActive) {
      allKeys.forEach(k => {
        if (k.id !== newItem.id && k.isActive) {
          store.put({ ...k, isActive: false });
        }
      });
    }

    const request = store.put(newItem);

    request.onsuccess = () => {
      if (newItem.isActive) {
        updateActiveCache(newItem);
      }
      notifyListeners();
      resolve(newItem);
    };

    request.onerror = () => {
      reject(request.error || new Error('Failed to save MCP key'));
    };
  });
}

/**
 * Set an MCP Key as the active key
 */
export async function setActiveMcpKey(id: string): Promise<void> {
  const db = await openDB();
  const allKeys = await getMcpKeys();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    allKeys.forEach(k => {
      store.put({
        ...k,
        isActive: k.id === id,
      });
    });

    transaction.oncomplete = () => {
      const active = allKeys.find(k => k.id === id) || null;
      if (active) updateActiveCache({ ...active, isActive: true });
      notifyListeners();
      resolve();
    };

    transaction.onerror = () => {
      reject(transaction.error || new Error('Failed to activate MCP key'));
    };
  });
}

/**
 * Delete an MCP Key by ID
 */
export async function deleteMcpKey(id: string): Promise<void> {
  const db = await openDB();
  const allKeys = await getMcpKeys();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    store.delete(id);

    // If deleted key was active, make the first remaining key active
    const deletedWasActive = allKeys.find(k => k.id === id)?.isActive;
    const remaining = allKeys.filter(k => k.id !== id);

    if (deletedWasActive && remaining.length > 0) {
      store.put({ ...remaining[0], isActive: true });
    }

    transaction.oncomplete = () => {
      getActiveMcpKey().catch(() => {});
      notifyListeners();
      resolve();
    };

    transaction.onerror = () => {
      reject(transaction.error || new Error('Failed to delete MCP key'));
    };
  });
}

export function getMcpConfig(): { token: string; serverUrl: string } {
  const activeKey = getActiveMcpKeySync();
  return {
    token: activeKey?.token || getActiveMcpTokenSync(),
    serverUrl: activeKey?.serverUrl || DEFAULT_SERVER_URL,
  };
}

export { DEFAULT_SERVER_URL };
