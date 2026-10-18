import { appStorage, flushAppStorage } from '../storage/appStorage';
import { createWorkspaceTransaction, readEntries, transactionDone } from '../storage/database';
import { enqueueStorageWrite } from '../storage/status';
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


export const DEFAULT_SERVER_URL = 'https://workrally.qq.com/zenstudio/api/mcp';
const CACHE_KEY = 'mira_cached_active_mcp';
const TOKEN_KEY = 'mira_active_mcp_token';
const listeners = new Set<() => void>();
let activeMcpKeyCache: McpKeyItem | null = null;
try { const raw = appStorage.getItem(CACHE_KEY); if (raw) activeMcpKeyCache = JSON.parse(raw); } catch {}
export function subscribeMcpKeyChanges(callback: () => void) { listeners.add(callback); return () => { listeners.delete(callback); }; }
function updateActiveCache(item: McpKeyItem | null) {
  activeMcpKeyCache = item;
  if (item) {
    appStorage.setItem(CACHE_KEY, JSON.stringify(item));
    appStorage.setItem(TOKEN_KEY, item.token);
  } else {
    appStorage.removeItem(CACHE_KEY); appStorage.removeItem(TOKEN_KEY);
  }
}
function notify() { listeners.forEach(fn => { try { fn(); } catch (error) { console.error(error); } }); }
export function getActiveMcpKeySync() { return activeMcpKeyCache; }
export function getActiveMcpTokenSync(): string { return activeMcpKeyCache?.token || appStorage.getItem(TOKEN_KEY) || ''; }
export async function getMcpKeys(): Promise<McpKeyItem[]> {
  const items = (await readEntries<McpKeyItem>('mcp_keys')).map(([, item]) => item);
  return items.sort((a,b) => Number(b.isActive)-Number(a.isActive) || (b.createdAt||0)-(a.createdAt||0));
}
export async function getActiveMcpKey(): Promise<McpKeyItem | null> {
  const keys = await getMcpKeys();
  const active = keys.find(item => item.isActive) || keys[0] || null;
  updateActiveCache(active); return active;
}
async function commitKeys(items: McpKeyItem[], removed?: string) {
  const tx = await createWorkspaceTransaction('mcp_keys', 'readwrite');
  const done = transactionDone(tx);
  for (const item of items) tx.objectStore('mcp_keys').put(item, item.id);
  if (removed) tx.objectStore('mcp_keys').delete(removed);
  await done;
  updateActiveCache(items.find(item => item.isActive) || items[0] || null);
  await flushAppStorage();
  notify();
}
export function saveMcpKey(item: Omit<McpKeyItem, 'id' | 'createdAt'> & { id?: string }): Promise<McpKeyItem> {
  return enqueueStorageWrite('mcp_keys', async () => {
    const keys = await getMcpKeys();
    const id = item.id || crypto.randomUUID();
    const previous = keys.find(key => key.id === id);
    const saved: McpKeyItem = { ...item, id, createdAt: previous?.createdAt || Date.now(), name: item.name.trim() || 'WorkRally 密钥', token: item.token.trim(), serverUrl: item.serverUrl?.trim() || DEFAULT_SERVER_URL, isActive: item.isActive ?? keys.length === 0 };
    const others = keys.filter(key => key.id !== id).map(key => saved.isActive ? { ...key, isActive: false } : key);
    await commitKeys([...others, saved]); return saved;
  });
}
export function setActiveMcpKey(id: string): Promise<void> {
  return enqueueStorageWrite('mcp_keys', async () => {
    const keys = await getMcpKeys();
    if (!keys.some(key => key.id === id)) throw new Error('密钥不存在');
    await commitKeys(keys.map(key => ({ ...key, isActive: key.id === id })));
  });
}
export function deleteMcpKey(id: string): Promise<void> {
  return enqueueStorageWrite('mcp_keys', async () => {
    const keys = (await getMcpKeys()).filter(key => key.id !== id);
    if (!keys.some(key => key.isActive) && keys[0]) keys[0] = { ...keys[0], isActive: true };
    await commitKeys(keys, id);
  });
}
export function getMcpConfig() { return { token: getActiveMcpTokenSync(), serverUrl: activeMcpKeyCache?.serverUrl || DEFAULT_SERVER_URL }; }
