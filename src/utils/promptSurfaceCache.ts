// Bounded render-only bitmap cache. Never included in project state or files.
const BITMAP_BUDGET = 32 * 1024 * 1024;
const bitmaps = new Map<string, HTMLCanvasElement>();
let bitmapBytes = 0;
export const readyPromptPanels = new Set<string>();

export function getSurfaceBitmap(key: string) {
  const bitmap = bitmaps.get(key);
  if (bitmap) { bitmaps.delete(key); bitmaps.set(key, bitmap); }
  return bitmap;
}
export function cacheSurfaceBitmap(key: string, source: HTMLCanvasElement) {
  const bytes = source.width * source.height * 4;
  if (bytes > BITMAP_BUDGET || key.length > 500000 || bitmaps.has(key)) return;
  while ((bitmapBytes + bytes > BITMAP_BUDGET || bitmaps.size >= 64) && bitmaps.size) {
    const [oldKey, old] = bitmaps.entries().next().value!;
    bitmaps.delete(oldKey); bitmapBytes -= old.width * old.height * 4;
    old.width = old.height = 0;
  }
  const copy = document.createElement('canvas');
  copy.width = source.width; copy.height = source.height;
  const ctx = copy.getContext('2d');
  if (!ctx) return;
  ctx.drawImage(source, 0, 0);
  bitmaps.set(key, copy); bitmapBytes += bytes;
}
