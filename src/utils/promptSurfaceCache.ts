// Bounded render-only bitmap cache. Never included in project state or files.
const BITMAP_BUDGET = 32 * 1024 * 1024;
const bitmaps = new Map<string, HTMLCanvasElement>();
let bitmapBytes = 0;
export const readyPromptPanels = new Set<string>();

type SurfaceCard = { prompt?: string; ratio?: string; res?: string; mcpModel?: string; mcpParameters?: unknown; state?: string; referenceImages?: { url: string; thumbnailUrl?: string; name?: string }[]; referenceImageUrl?: string | null; referenceImageName?: string };
const revisions = new WeakMap<SurfaceCard, { dark: boolean; key: string }>();
const aliases = new Map<string, { revision: string; bitmapKey: string }>();
export function getCardSurfaceRevision(card: SurfaceCard, dark: boolean) {
  const cached = revisions.get(card);
  if (cached?.dark === dark) return cached.key;
  const key = JSON.stringify([dark, card.prompt || '', card.ratio, card.res, card.mcpModel, card.mcpParameters, card.state,
    card.referenceImages?.map(ref => [ref.url, ref.thumbnailUrl, ref.name]), card.referenceImageUrl, card.referenceImageName]);
  revisions.set(card, { dark, key });
  return key;
}
// Aliases point at existing bounded surfaces; they never retain another bitmap copy.
export function publishCardSurface(id: string | undefined, part: 'text' | 'panel', revision: string | undefined, bitmapKey: string) {
  if (!id || !revision || !bitmaps.has(bitmapKey)) return;
  const key = `${id}:${part}`;
  const old = aliases.get(key);
  if (old?.revision === revision && old.bitmapKey === bitmapKey) return;
  aliases.delete(key);
  aliases.set(key, { revision, bitmapKey });
  if (aliases.size > 256) aliases.delete(aliases.keys().next().value!);
  window.dispatchEvent(new Event('card-surface-ready'));
}
export function getCardSurface(id: string, part: 'text' | 'panel', revision: string) {
  const alias = aliases.get(`${id}:${part}`);
  if (!alias || alias.revision !== revision) return;
  const bitmap = getSurfaceBitmap(alias.bitmapKey);
  if (!bitmap) aliases.delete(`${id}:${part}`);
  return bitmap;
}

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
