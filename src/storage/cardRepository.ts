import type { CardData } from "../components/GenerationCard";
import { createWorkspaceTransaction, readValue, transactionDone } from "./database";
import { enqueueStorageWrite, waitForStorageWrite } from "./status";

type Snapshot = { id: string; cardKeys: string[]; assetIds: string[]; savedAt: number };
type Manifest = { current: Snapshot; backup?: Snapshot };
const assetIds = new WeakMap<Blob, Map<string, string>>();
const lastCommitted = new WeakMap<CardData[], { project: string; revision: string }>();
const revisions = new Map<string, string>();
const failedSaves = new Map<string, CardData[]>();
const listeners = new Set<(status: CardSaveStatus) => void>();
export type CardSaveStatus = { projectId?: string; state: "saved" | "error"; count: number; at: number; error?: string };
export const projectKey = (id?: string) => id ? `cards_${id}` : "cards";
export function subscribeCardSaves(fn: (status: CardSaveStatus) => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
function report(status: CardSaveStatus) { listeners.forEach(fn => { try { fn(status); } catch (error) { console.error(error); } }); }

function sanitizeBlob(blob: unknown): Blob | null {
  if (!(blob instanceof Blob)) return null;
  try {
    return blob.slice(0, blob.size, blob.type);
  } catch {
    return blob;
  }
}

function encode(value: any, project: string, blobs: Map<string, Blob>, ancestors = new Set<object>()): any {
  if (value instanceof Blob) {
    const safeBlob = sanitizeBlob(value) || value;
    let ids = assetIds.get(value);
    if (!ids) { ids = new Map(); assetIds.set(value, ids); }
    let id = ids.get(project);
    if (!id) { id = `${project}:${crypto.randomUUID()}`; ids.set(project, id); }
    if (safeBlob !== value) {
      let safeIds = assetIds.get(safeBlob);
      if (!safeIds) { safeIds = new Map(); assetIds.set(safeBlob, safeIds); }
      safeIds.set(project, id);
    }
    blobs.set(id, safeBlob);
    return { __mira_asset__: id };
  }
  if (value === null || value === undefined || typeof value !== "object") {
    if (typeof value === "function" || typeof value === "symbol") return null;
    return value;
  }
  if (ancestors.has(value)) return null;
  ancestors.add(value);
  const result = Array.isArray(value) ? value.map(item => encode(item, project, blobs, ancestors))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item, project, blobs, ancestors)]));
  ancestors.delete(value);
  return result;
}

function decode(value: any, blobs: Map<string, Blob>, project: string): any {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (typeof value.__mira_asset__ === "string" && Object.keys(value).length === 1) {
    const id = value.__mira_asset__;
    const blob = blobs.get(id);
    if (!(blob instanceof Blob)) {
      // Graceful fallback: Never crash card or project load if a binary asset is missing or detached
      return undefined;
    }
    let ids = assetIds.get(blob);
    if (!ids) { ids = new Map(); assetIds.set(blob, ids); }
    ids.set(project, id);
    return blob;
  }
  return Array.isArray(value) ? value.map(item => decode(item, blobs, project))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item, blobs, project)]));
}

function prepare(cards: CardData[], project: string) {
  const blobs = new Map<string, Blob>();
  const ids = new Set<string>();
  const id = crypto.randomUUID();
  const records = cards.map((card, idx) => {
    let effectiveCard = card;
    if (!effectiveCard.id || ids.has(effectiveCard.id)) {
      effectiveCard = {
        ...effectiveCard,
        id: `card_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 7)}`
      };
    }
    ids.add(effectiveCard.id);
    
    // Normalize card media references: salvage available blobs and sanitize detached blob URLs
    if (!(effectiveCard.fileData instanceof Blob) && (effectiveCard.originalFileData instanceof Blob || effectiveCard.trueOriginalFileData instanceof Blob)) {
      effectiveCard = {
        ...effectiveCard,
        fileData: effectiveCard.originalFileData || effectiveCard.trueOriginalFileData
      };
    }
    // If imageUrl is a blob: URL but no binary blob exists, do not abort project save
    if (effectiveCard.imageUrl?.startsWith("blob:") && !(effectiveCard.fileData instanceof Blob)) {
      effectiveCard = {
        ...effectiveCard,
        imageUrl: null
      };
    }

    return { key: JSON.stringify([project, id, effectiveCard.id]), value: encode(effectiveCard, project, blobs) };
  });
  return { records, blobs, snapshot: { id, cardKeys: records.map(item => item.key), assetIds: [...blobs.keys()], savedAt: Date.now() } satisfies Snapshot };
}

export function saveCards(cards: CardData[], projectId?: string): Promise<void> {
  const key = projectKey(projectId);
  // Snapshot metadata before any await; File/Blob is immutable and stored separately.
  let prepared: ReturnType<typeof prepare>;
  try { prepared = prepare(cards, key); } catch (error) {
    failedSaves.set(key, cards);
    return enqueueStorageWrite(key, async () => { throw error; });
  }
  failedSaves.set(key, cards);
  return enqueueStorageWrite(key, async () => {
    try {
      const known = lastCommitted.get(cards);
      if (known?.project === key && revisions.get(key) === known.revision) {
        if (failedSaves.get(key) === cards) failedSaves.delete(key);
        return;
      }
      const tx = await createWorkspaceTransaction(["manifests", "card_records", "assets"], "readwrite");
      const done = transactionDone(tx);
      const manifests = tx.objectStore("manifests");
      const priorRequest = manifests.get(key);
      let writeError: unknown;
      priorRequest.onsuccess = () => {
        try {
          const prior = priorRequest.result as Manifest | undefined;
          if (prior && revisions.get(key) !== prior.current.id) {
            throw new Error("另一个页面已更新此项目，已阻止覆盖。请先保留当前编辑并重新读取。");
          }
          const backup = prior?.current.cardKeys.length ? prior.current : prior?.backup;
          const keepAssets = new Set([...(prior?.current.assetIds || []), ...(prior?.backup?.assetIds || [])]);
          
          // Write binary assets with isolation: prevent single corrupted/detached blob error from aborting the whole transaction
          const assetStore = tx.objectStore("assets");
          for (const [id, blob] of prepared.blobs) {
            if (!keepAssets.has(id)) {
              try {
                const req = assetStore.put(blob, id);
                req.onerror = (e) => {
                  console.warn(`[storage] Could not write binary asset ${id} to disk cache:`, req.error);
                  e.preventDefault();
                  e.stopPropagation();
                };
              } catch (assetErr) {
                console.warn(`[storage] Error dispatching asset ${id}:`, assetErr);
              }
            }
          }

          for (const record of prepared.records) tx.objectStore("card_records").put(record.value, record.key);
          manifests.put({ current: prepared.snapshot, backup }, key);
          
          // Reclaim only versions that are no longer current or recoverable.
          const keepKeys = new Set([...prepared.snapshot.cardKeys, ...(backup?.cardKeys || [])]);
          const keepBlobIds = new Set([...prepared.snapshot.assetIds, ...(backup?.assetIds || [])]);
          for (const old of [prior?.current, prior?.backup]) {
            for (const cardKey of old?.cardKeys || []) if (!keepKeys.has(cardKey)) tx.objectStore("card_records").delete(cardKey);
            for (const blobId of old?.assetIds || []) if (!keepBlobIds.has(blobId)) tx.objectStore("assets").delete(blobId);
          }
        } catch (error) { writeError = error; tx.abort(); }
      };
      await done.catch(error => { throw writeError || error; });
      revisions.set(key, prepared.snapshot.id);
      lastCommitted.set(cards, { project: key, revision: prepared.snapshot.id });
      if (failedSaves.get(key) === cards) failedSaves.delete(key);
      report({ projectId, state: "saved", count: cards.length, at: Date.now() });
    } catch (error) {
      report({ projectId, state: "error", count: cards.length, at: Date.now(), error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  });
}

async function readSnapshot(project: string, backup: boolean): Promise<CardData[] | null> {
  const manifestTx = await createWorkspaceTransaction(["manifests"], "readonly");
  const manifestDone = transactionDone(manifestTx);
  const manifestRequest = manifestTx.objectStore("manifests").get(project);
  await manifestDone;

  const manifest = manifestRequest.result as Manifest | undefined;
  const selected = backup ? manifest?.backup : manifest?.current;
  if (!selected) return null;
  if (selected.cardKeys.length === 0) return [];

  const readTx = await createWorkspaceTransaction(["card_records", "assets"], "readonly");
  const readDone = transactionDone(readTx);
  const cardStore = readTx.objectStore("card_records");
  const assetStore = readTx.objectStore("assets");

  const recordRequests = selected.cardKeys.map(k => ({ key: k, req: cardStore.get(k) }));
  const assetRequests = selected.assetIds.map(id => ({ id, req: assetStore.get(id) }));
  await readDone;

  const assets = new Map(assetRequests.map(({ id, req }) => [id, req.result]));
  const restored = recordRequests
    .map(({ req }) => req.result ? decode(req.result, assets, project) : null)
    .filter((c): c is CardData => Boolean(c && typeof c === "object" && c.id));

  if (!backup) revisions.set(project, selected.id);
  return restored;
}

export async function loadCards(projectId?: string): Promise<CardData[] | null> {
  const key = projectKey(projectId);
  await waitForStorageWrite(key);
  const current = await readSnapshot(key, false);
  if (current !== null && current.length > 0) return current;

  // Disaster recovery: If current snapshot is empty or lost, check if backup snapshot exists
  const backup = await readSnapshot(key, true);
  if (backup !== null && backup.length > 0) {
    console.warn(`[storage] Restored project ${key} from backup snapshot (${backup.length} cards)`);
    await saveCards(backup, projectId).catch(console.error);
    return backup;
  }

  if (current !== null) return current;

  const legacy = await readValue<CardData[]>("workspace", key);
  if (legacy === undefined) return null;
  if (!Array.isArray(legacy)) throw new Error("旧版卡片数据格式无效，已停止迁移");
  // Legacy record remains intact; commit new representation before reporting success.
  await saveCards(legacy, projectId);
  return legacy;
}

export async function loadCardBackup(projectId?: string) {
  const key = projectKey(projectId);
  await waitForStorageWrite(key);
  return await readSnapshot(key, true) ?? await readValue<CardData[]>("workspace", `${key}_backup`) ?? null;
}

export async function retryCardSaves() {
  await Promise.all([...failedSaves].map(([key, cards]) => saveCards(cards, key === "cards" ? undefined : key.slice(6))));
}

export function deleteCardsForProject(projectId: string): Promise<void> {
  const key = projectKey(projectId);
  return enqueueStorageWrite(key, async () => {
    const tx = await createWorkspaceTransaction(["manifests", "card_records", "assets", "workspace"], "readwrite");
    const done = transactionDone(tx);
    const request = tx.objectStore("manifests").get(key);
    request.onsuccess = () => {
      const manifest = request.result as Manifest | undefined;
      for (const version of [manifest?.current, manifest?.backup]) {
        for (const cardKey of version?.cardKeys || []) tx.objectStore("card_records").delete(cardKey);
        for (const id of version?.assetIds || []) tx.objectStore("assets").delete(id);
      }
      tx.objectStore("manifests").delete(key);
      for (const suffix of ["", "_backup", "_save_info"]) tx.objectStore("workspace").delete(key + suffix);
    };
    await done;
    revisions.delete(key); failedSaves.delete(key);
  });
}
