/**
 * Surface bitmap cache for prompt rendering.
 * Caches offscreen rendered canvas surfaces by key to avoid re-drawing complex text on every frame.
 */

export const readyPromptPanels = new Set<string>();

const surfaceCache = new Map<string, HTMLCanvasElement>();
const MAX_CACHE_SIZE = 120;

export function getSurfaceBitmap(key: string): HTMLCanvasElement | null {
  const cached = surfaceCache.get(key);
  if (!cached) return null;
  surfaceCache.delete(key);
  surfaceCache.set(key, cached);
  return cached;
}

export function cacheSurfaceBitmap(key: string, sourceCanvas: HTMLCanvasElement): void {
  if (!sourceCanvas.width || !sourceCanvas.height) return;
  try {
    const clone = document.createElement('canvas');
    clone.width = sourceCanvas.width;
    clone.height = sourceCanvas.height;
    const ctx = clone.getContext('2d');
    if (ctx) {
      ctx.drawImage(sourceCanvas, 0, 0);
      surfaceCache.set(key, clone);
      if (surfaceCache.size > MAX_CACHE_SIZE) {
        const oldestKey = surfaceCache.keys().next().value;
        if (oldestKey) surfaceCache.delete(oldestKey);
      }
    }
  } catch (e) {
    console.warn('[promptSurfaceCache] Error caching surface bitmap:', e);
  }
}

export function clearSurfaceCache(): void {
  surfaceCache.clear();
}
