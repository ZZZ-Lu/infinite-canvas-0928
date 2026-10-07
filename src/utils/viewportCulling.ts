import { AspectRatio, CARD_DIMENSIONS, getCardSize } from '../components/GenerationCard';

export interface CardBounds {
  id: string;
  x: number;
  y: number;
  ratio: AspectRatio;
  customWidth?: number;
  customHeight?: number;
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
 * Includes the image area, gap, and bottom prompt/action panel.
 */
export function getCardDimensions(card: CardBounds): { width: number; height: number } {
  const dim = getCardSize(card);
  const visualWidth = Math.max(dim.width, 480);
  const visualHeight = dim.height + 220; // 12px gap + ~200px bottom panel
  return { width: visualWidth, height: visualHeight };
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
  const { width: cardWidth, height: cardHeight } = getCardDimensions(card);

  // Card AABB in screen coordinates
  const cardLeft = card.x * scale + tx;
  const cardTop = card.y * scale + ty;
  const cardRight = cardLeft + cardWidth * scale;
  const cardBottom = cardTop + cardHeight * scale;

  // Add a scale-adaptive buffer zone outside screen edges for smooth pre-loading
  // At smaller scales (e.g., 0.40), reduces buffer to prevent mounting dozens of offscreen DOM nodes
  const buffer = Math.max(40, Math.min(150, Math.round(150 * Math.sqrt(scale))));

  return (
    cardLeft <= viewportWidth + buffer &&
    cardRight >= -buffer &&
    cardTop <= viewportHeight + buffer &&
    cardBottom >= -buffer
  );
}

/**
 * Nano-LOD Scale Threshold: 0.40 (40%)
 * Scale < 0.40 renders via NanoLodCanvas (2D Canvas mode with color blocks).
 * Scale >= 0.40 renders via DOM cards mode (interactive prompt component).
 */
export function getNanoLodThreshold(): number {
  return 0.40;
}

/**
 * Dynamic LOD-Adaptive Mounting Quotas (Strictly Frame-Based, Ultra-Light Budget)
 * 
 * Returns the maximum number of DOM cards allowed to mount into the DOM for the given frame.
 * Prioritizes 60fps zooming and panning fluid motion by strictly budgeting DOM node mounting workload.
 * 
 * - Nano-LOD (scale < threshold): Quota is 0 (pure 2D Canvas rendering, 0 DOM cards).
 * - While actively zooming or dragging (gesture active): 1 card every 4 frames (0.25 card / frame).
 * - Micro-LOD (threshold <= scale < 1.00): 1 card every 2 frames (0.5 card / frame).
 * - Standard-LOD (1.00 <= scale < 2.00): 1 card every 2 frames (0.5 card / frame).
 * - Macro-LOD (scale >= 2.00): 1 card every 4 frames (0.25 card / frame).
 */
export function getLodMountQuota(scale: number, isGestureActive: boolean = false, frameIndex: number = 0): number {
  if (scale < getNanoLodThreshold()) return 0;
  if (isGestureActive) {
    return frameIndex % 4 === 0 ? 1 : 0;
  }
  if (scale < 1.00) return frameIndex % 2 === 0 ? 1 : 0;
  if (scale < 2.00) return frameIndex % 2 === 0 ? 1 : 0;
  return frameIndex % 4 === 0 ? 1 : 0;
}
