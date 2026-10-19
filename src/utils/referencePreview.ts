import { generateImageThumbnail } from './thumbnail';
import { fullImageCache } from './imageTextureCache';

export const STANDARD_PREVIEW_EDGE = 1200;
type Reference = { url: string; sourceCardId?: string; thumbnailUrl?: string };
type SourceCard = { id: string; imageUrl?: string | null; originalImageUrl?: string | null; trueOriginalImageUrl?: string | null; isVideo?: boolean; thumbnailUrl?: string };
const previews = new Map<string, Promise<string>>();

export function resolveReferencePreviewSource(reference: Reference, cards: SourceCard[]) {
  const source = (reference.sourceCardId && cards.find(card => card.id === reference.sourceCardId)) ||
    cards.find(card => [card.imageUrl, card.originalImageUrl, card.trueOriginalImageUrl].includes(reference.url));
  return (source?.isVideo ? source.thumbnailUrl : source?.imageUrl) || reference.url;
}

// Renderer-only cache. AI references continue to use their unmodified original data.
export function getStandardReferencePreview(source: string): Promise<string> {
  const loaded = fullImageCache.get(source);
  if (loaded?.complete && loaded.naturalWidth > 0 && Math.max(loaded.naturalWidth, loaded.naturalHeight) <= STANDARD_PREVIEW_EDGE) {
    return Promise.resolve(source);
  }
  const cached = previews.get(source);
  if (cached) { previews.delete(source); previews.set(source, cached); return cached; }
  const pending = generateImageThumbnail(source, STANDARD_PREVIEW_EDGE).catch(error => {
    if (previews.get(source) === pending) previews.delete(source);
    throw error;
  });
  previews.set(source, pending);
  if (previews.size > 16) previews.delete(previews.keys().next().value!);
  return pending;
}
