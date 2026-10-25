import { AspectRatio, CARD_DIMENSIONS, getCardSize } from '../components/GenerationCard';
import { getBottomPanelHeight } from './cardLayout';
import { NANO_LOD_THRESHOLD, NANO_LOD_ENTER_HIGH_THRESHOLD, NANO_LOD_EXIT_HIGH_THRESHOLD } from './cardLodAppearance';

export interface CardBounds {
  id: string;
  x: number;
  y: number;
  ratio: AspectRatio;
  customWidth?: number;
  customHeight?: number;
  prompt?: string;
  referenceImages?: any[];
  referenceImageUrl?: string | null;
  fileName?: string;
  isAsset?: boolean;
}

export interface CanvasViewport {
  viewportWidth: number;
  viewportHeight: number;
  scale: number;
  tx: number;
  ty: number;
}

/**
 * Calculates visual dimensions of a card in canvas world coordinates.
 * Includes the image area, gap, and dynamic bottom prompt/action panel height for generation cards.
 */
export function getCardDimensions(card: CardBounds): { width: number; height: number } {
  const dim = getCardSize(card);
  const isGenerationCard = !card.fileName && !card.isAsset;
  const visualWidth = isGenerationCard ? Math.max(dim.width, 480) : dim.width;
  if (!isGenerationCard) {
    return { width: visualWidth, height: dim.height };
  }
  const panelHeight = getBottomPanelHeight(card.prompt, card.referenceImages?.length || (card.referenceImageUrl ? 1 : 0));
  const visualHeight = dim.height + 12 + panelHeight;
  return { width: visualWidth, height: visualHeight };
}

export function getCardWorldBounds(card: CardBounds) {
  const image = getCardSize(card);
  const visual = getCardDimensions(card);
  const left = card.x + Math.min(0, (image.width - visual.width) / 2);
  return { minX: left, minY: card.y, maxX: left + visual.width, maxY: card.y + visual.height };
}

/**
 * Determines whether a card's axis-aligned bounding box intersects with
 * a rectangle defined by the viewport plus a pre-load buffer.
 *
 * This function performs pure mathematical AABB vs AABB collision detection
 * in screen space, completely decoupled from DOM or rendering layers.
 */
export function isCardIntersectingRectangle(
  card: CardBounds,
  viewport: CanvasViewport
): boolean {
  const { viewportWidth, viewportHeight, scale, tx, ty } = viewport;
  if (viewportWidth <= 0 || viewportHeight <= 0 || scale <= 0) return true;

  // Card dimensions in canvas coordinates
  const bounds = getCardWorldBounds(card);

  // Card AABB in screen coordinates
  const cardLeft = bounds.minX * scale + tx;
  const cardTop = bounds.minY * scale + ty;
  const cardRight = bounds.maxX * scale + tx;
  const cardBottom = bounds.maxY * scale + ty;

  // Add a scale-adaptive buffer zone outside screen edges for smooth pre-loading
  const buffer = Math.max(40, Math.min(150, Math.round(150 * Math.sqrt(scale))));
  
  // Explicit user preference: Expand top safety buffer zone specifically for top-edge culling
  const topBuffer = buffer + 350;

  return (
    cardLeft <= viewportWidth + buffer &&
    cardRight >= -buffer &&
    cardTop <= viewportHeight + buffer &&
    cardBottom >= -topBuffer
  );
}

/**
 * Shared Nano/Micro-LOD Scale Threshold: 0.40 (40%)
 * Scale < 0.40 renders via NanoLodCanvas (2D Canvas mode with color blocks).
 * Scale >= 0.40 renders via DOM cards mode (interactive prompt component).
 */
export { NANO_LOD_ENTER_HIGH_THRESHOLD, NANO_LOD_EXIT_HIGH_THRESHOLD };

export function getNanoLodThreshold(): number {
  return NANO_LOD_THRESHOLD;
}

/**
 * Dual-threshold hysteresis state resolver to prevent rapid mount/unmount flickering
 * near the scale 0.40 boundary during continuous zoom gestures.
 */
export function isNanoLodScale(scale: number, currentIsNano: boolean): boolean {
  if (currentIsNano) {
    return scale < NANO_LOD_ENTER_HIGH_THRESHOLD;
  } else {
    return scale < NANO_LOD_EXIT_HIGH_THRESHOLD;
  }
}

export const CARD_DENSITY_HIGH_THRESHOLD = 15; // Kept for backwards compatibility
export const HIGH_RENDER_WEIGHT_THRESHOLD = 12; // Weight threshold where DOM cards start impacting reflow
export const FRAME_BUDGET_MS = 3.5; // Strict JS budget per frame (3.5ms) ensuring React layout and paint have >13ms to guarantee 60 FPS

/**
 * Calculates a rendering complexity weight for a card.
 * Cards with prompt panels, textareas, and reference images have significantly higher DOM weight
 * and layout reflow costs during pan/zoom gestures than simple image asset cards.
 */
export function calculateCardRenderWeight(card: CardBounds): number {
  const isGenerationCard = !card.fileName && !card.isAsset;
  if (!isGenerationCard) {
    return 1; // Plain image or video card: lightweight DOM
  }
  let weight = 2; // Base generation card
  if (card.prompt || (card.referenceImages && card.referenceImages.length > 0)) {
    weight += 3; // Generation card with active prompt/action panel
  }
  if (card.referenceImages && card.referenceImages.length > 0) {
    weight += card.referenceImages.length; // Extra DOM nodes per reference image chip
  }
  return weight;
}

/**
 * Calculates total render weight for a set of visible cards.
 */
export function calculateTotalRenderWeight(cards: CardBounds[]): number {
  let total = 0;
  for (let i = 0; i < cards.length; i++) {
    total += calculateCardRenderWeight(cards[i]);
  }
  return total;
}

/**
 * Calculates per-frame mounting quota based on scale, gesture state, and live frame duration.
 * - Active Gesture: STRICT ZERO-MOUNT (returns 0). Guarantees 60 FPS gesture smoothness during active drag/zoom.
 * - Gesture Settled & Idle: Mounts in frame-budgeted batches (4-6 cards per frame, or 2 under heavy frame duration)
 *   so cards settle in minimal React render cycles rather than dragging across dozens of single-card frames.
 */
export function getLodMountQuota(
  scale: number, 
  isGestureActive: boolean = false, 
  frameIndex: number = 0,
  cardCountOrWeight: number = 0,
  lastFrameDuration: number = 0
): number {
  if (scale < getNanoLodThreshold()) return 0;
  if (isGestureActive) return 0; // Strictly zero DOM mounting during gesture!
  if (lastFrameDuration > 20.0) return 2;
  return 6;
}

export const UNMOUNT_TARGET_DURATION_MS = 200; // Target duration (200ms) to complete progressive DOM card unmounting during High -> Low LOD switch

/**
 * Calculates per-frame unmounting quota based on time budget and remaining culled cards.
 * High -> Low LOD transitions happen very quickly during large-scale zoom-out,
 * so unmounting is time-budgeted to complete smoothly within targetDurationMs (default 200ms).
 *
 * @param remainingCulledCount Total number of culled cards still awaiting DOM removal
 * @param elapsedMs Elapsed time in milliseconds since this unmount session began
 * @param targetDurationMs Target completion duration in milliseconds
 * @returns Number of cards to unmount in the current frame
 */
export function getLodUnmountQuota(
  remainingCulledCount: number,
  elapsedMs: number,
  targetDurationMs: number = UNMOUNT_TARGET_DURATION_MS
): number {
  if (remainingCulledCount <= 0) return 0;
  if (elapsedMs >= targetDurationMs) return remainingCulledCount;

  const remainingTime = Math.max(16.6, targetDurationMs - elapsedMs);
  const remainingFrames = Math.max(1, Math.ceil(remainingTime / 16.6));
  return Math.max(1, Math.ceil(remainingCulledCount / remainingFrames));
}



