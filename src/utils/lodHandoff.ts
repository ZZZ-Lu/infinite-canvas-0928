/**
 * LOD Handoff Utility
 * Coordinates smooth transition between DOM interactive cards and Nano LOD canvas rendering.
 */

export interface LodFrame {
  key: string;
  timestamp: number;
  width: number;
  height: number;
  scale?: number;
  tx?: number;
  ty?: number;
  cardIds?: string[];
  [key: string]: any;
}

export function canRetireDomForNano(
  frame: LodFrame,
  transform: { scale: number; tx: number; ty: number }
): boolean {
  if (!frame) return false;
  if (typeof frame.scale === 'number') {
    const scaleDiff = Math.abs(frame.scale - transform.scale);
    if (scaleDiff > 0.15) return false;
  }
  return true;
}
