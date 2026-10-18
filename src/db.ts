import type { AgentRuntimeTrace } from './agent/debugTrace';
import { createWorkspaceTransaction, readValue, transactionDone } from './storage/database';
import { enqueueStorageWrite } from './storage/status';
export { saveCards, loadCards, deleteCardsForProject, loadCardBackup, retryCardSaves, subscribeCardSaves } from './storage/cardRepository';
export type { CardSaveStatus } from './storage/cardRepository';
export { requestPersistentStorage as requestPersistence } from './storage/status';

export function saveAgentTraces(traces: AgentRuntimeTrace[]): Promise<void> {
  return enqueueStorageWrite('traces', async () => {
    const tx = await createWorkspaceTransaction('traces', 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore('traces').put(traces.slice(-50), 'agent_traces');
    await done;
  });
}
export async function loadAgentTraces(): Promise<AgentRuntimeTrace[] | null> {
  return await readValue<AgentRuntimeTrace[]>('traces', 'agent_traces')
    ?? await readValue<AgentRuntimeTrace[]>('workspace', 'agent_traces') ?? null;
}
