import { NANO_LOD_THRESHOLD } from './cardLodAppearance';
export type LodFrame = { scale: number; tx: number; ty: number };

// A queued callback from a previous camera/LOD cannot retire the current DOM.
export function canRetireDomForNano(frame: LodFrame, camera: LodFrame) {
  return frame.scale < NANO_LOD_THRESHOLD && camera.scale < NANO_LOD_THRESHOLD &&
    frame.scale === camera.scale && frame.tx === camera.tx && frame.ty === camera.ty;
}

export interface LodHandoffState {
  cardId: string;
  underlayUrl: string;
  targetUrl: string;
  startTime: number;
  durationMs: number;
  isReady: boolean;
}

const activeHandoffs = new Map<string, LodHandoffState>();

export function startLodHandoff(cardId: string, underlayUrl: string, targetUrl: string, durationMs: number = 150): LodHandoffState {
  const state: LodHandoffState = {
    cardId,
    underlayUrl,
    targetUrl,
    startTime: performance.now(),
    durationMs,
    isReady: false,
  };
  activeHandoffs.set(cardId, state);
  return state;
}

export function markLodHandoffReady(cardId: string) {
  const existing = activeHandoffs.get(cardId);
  if (existing) {
    existing.isReady = true;
  }
}

export function getLodHandoffState(cardId: string): LodHandoffState | undefined {
  return activeHandoffs.get(cardId);
}

export function completeLodHandoff(cardId: string) {
  activeHandoffs.delete(cardId);
}
