import { createWorkspaceTransaction, openWorkspaceDatabase, readEntries, transactionDone } from '../storage/database';
import { enqueueStorageWrite } from '../storage/status';
export const initDb = openWorkspaceDatabase;
export async function getDrafts(): Promise<Record<string, string>> {
  return Object.fromEntries(await readEntries<string>('drafts'));
}
export function saveDraft(targetId: string, text: string): Promise<void> {
  return enqueueStorageWrite(`draft:${targetId}`, async () => {
    const tx = await createWorkspaceTransaction('drafts', 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore('drafts').put(text, targetId);
    await done;
  });
}
export function deleteDraft(targetId: string): Promise<void> {
  return enqueueStorageWrite(`draft:${targetId}`, async () => {
    const tx = await createWorkspaceTransaction('drafts', 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore('drafts').delete(targetId);
    await done;
  });
}
