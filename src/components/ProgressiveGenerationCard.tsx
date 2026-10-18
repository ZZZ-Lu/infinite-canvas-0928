import React, { useCallback, useSyncExternalStore } from 'react';
import { GenerationCard } from './GenerationCard';

// Renderer-local admission state, separate from serializable card/project data.
export function createCardMountStore() {
  const ids = new Set<string>();
  const listeners = new Map<string, Set<() => void>>();
  return {
    ids,
    subscribe(id: string, listener: () => void) {
      let subscribers = listeners.get(id);
      if (!subscribers) { subscribers = new Set(); listeners.set(id, subscribers); }
      subscribers.add(listener);
      return () => { subscribers!.delete(listener); if (!subscribers!.size) listeners.delete(id); };
    },
    replace(next: Set<string>) {
      if (next === ids) return;
      const changed = new Set<string>();
      for (const id of ids) if (!next.has(id)) changed.add(id);
      for (const id of next) if (!ids.has(id)) changed.add(id);
      ids.clear(); for (const id of next) ids.add(id);
      for (const id of changed) listeners.get(id)?.forEach(listener => listener());
    },
  };
}
export const ProgressiveGenerationCard = React.memo(function ProgressiveGenerationCard({ mountStore, isHighLodTarget, ...props }:
  React.ComponentProps<typeof GenerationCard> & {
    mountStore: ReturnType<typeof createCardMountStore>;
    isHighLodTarget?: boolean;
  }) {
  const id = props.data.id;
  const isTarget = Boolean(isHighLodTarget);
  const subscribe = useCallback((listener: () => void) => mountStore.subscribe(id, listener), [id, mountStore]);
  const snapshot = useCallback(() => Boolean(isTarget || mountStore.ids.has(id)), [id, isTarget, mountStore]);
  const mounted = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (mounted || isTarget) ? <GenerationCard isHighLodTarget={isTarget} {...props} /> : null;
});
