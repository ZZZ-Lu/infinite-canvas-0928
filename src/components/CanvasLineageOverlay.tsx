import React, { useState, useEffect, useMemo } from 'react';
import { MotionValue } from 'motion/react';
import { CardData, getCardSize } from './GenerationCard';

export interface CanvasLineageOverlayProps {
  cards: CardData[];
  selectedCardIds: string[];
  scale?: MotionValue<number>;
}

interface LineageConnection {
  id: string;
  source: CardData;
  target: CardData;
}

/**
 * Calculates the exact intersection point where the ray from (cx, cy)
 * towards (targetX, targetY) exits the rectangular boundary.
 */
function getRectBorderIntersection(
  rectX: number,
  rectY: number,
  width: number,
  height: number,
  targetX: number,
  targetY: number
): { x: number; y: number } {
  const cx = rectX + width / 2;
  const cy = rectY + height / 2;
  const dx = targetX - cx;
  const dy = targetY - cy;

  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
    return { x: cx, y: cy };
  }

  const hw = width / 2;
  const hh = height / 2;

  const sx = Math.abs(dx) > 0.001 ? hw / Math.abs(dx) : Infinity;
  const sy = Math.abs(dy) > 0.001 ? hh / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);

  return {
    x: cx + dx * s,
    y: cy + dy * s,
  };
}

export const CanvasLineageOverlay: React.FC<CanvasLineageOverlayProps> = React.memo(function CanvasLineageOverlay({
  cards,
  selectedCardIds,
  scale,
}) {
  // Real-time drag synchronization (0-latency tracking)
  const [, setDragEpoch] = useState(0);

  useEffect(() => {
    let rafId: number | null = null;
    const triggerUpdate = () => {
      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          setDragEpoch(n => (n + 1) % 1000000);
        });
      }
    };

    window.addEventListener('card-drag-move', triggerUpdate);
    window.addEventListener('nano-dragging', triggerUpdate);

    return () => {
      window.removeEventListener('card-drag-move', triggerUpdate);
      window.removeEventListener('nano-dragging', triggerUpdate);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  // Scale tracking for scale-invariant visual stroke width and dot size
  const [currentScale, setCurrentScale] = useState(() => scale ? scale.get() : 1);

  useEffect(() => {
    if (!scale) return;
    let rafId: number | null = null;
    const unsub = scale.on('change', (s) => {
      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          setCurrentScale(s);
        });
      }
    });
    return () => {
      unsub();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [scale]);

  // ONLY render when cards are actively selected
  const activeSelectedSet = useMemo(() => new Set(selectedCardIds), [selectedCardIds]);

  // Compute upstream connections for selected cards
  const connections = useMemo(() => {
    if (activeSelectedSet.size === 0 || cards.length === 0) return [];

    const cardMap = new Map<string, CardData>();
    cards.forEach(c => cardMap.set(c.id, c));

    const connMap = new Map<string, LineageConnection>();
    const visited = new Set<string>();

    const traceUpstream = (currCard: CardData) => {
      if (visited.has(currCard.id)) return;
      visited.add(currCard.id);

      // Case 1: The card is forked from a parent card -> connect to parent
      if (currCard.derivedFromId) {
        const parent = cardMap.get(currCard.derivedFromId);
        if (parent) {
          const key = `${parent.id}->${currCard.id}`;
          if (!connMap.has(key)) {
            connMap.set(key, { id: key, source: parent, target: currCard });
          }
          // Recursively trace upstream predecessors
          traceUpstream(parent);
        }
      }

      // Case 2: Reference images
      // If reference images are inherited from the parent card, do not display their lines.
      // If they are newly attached/connected afterwards, display their lines.
      const parentRefIds = new Set<string>();
      if (currCard.derivedFromId) {
        const parent = cardMap.get(currCard.derivedFromId);
        if (parent) {
          if (parent.referenceSourceIds) {
            parent.referenceSourceIds.forEach(id => parentRefIds.add(id));
          }
          if (parent.referenceImages) {
            parent.referenceImages.forEach(r => {
              if (r.sourceCardId) parentRefIds.add(r.sourceCardId);
              if (r.url) {
                cards.forEach(c => {
                  if (c.id !== parent.id && (c.imageUrl === r.url || c.originalImageUrl === r.url || c.thumbnailUrl === r.url)) {
                    parentRefIds.add(c.id);
                  }
                });
              }
            });
          }
        }
      }

      const refIds = new Set<string>();
      if (currCard.referenceSourceIds) {
        currCard.referenceSourceIds.forEach(id => refIds.add(id));
      }
      if (currCard.referenceImages) {
        currCard.referenceImages.forEach(r => {
          if (r.sourceCardId) {
            refIds.add(r.sourceCardId);
          } else if (r.url) {
            const matched = cards.find(c => c.id !== currCard.id && (c.imageUrl === r.url || c.originalImageUrl === r.url || c.thumbnailUrl === r.url));
            if (matched) {
              refIds.add(matched.id);
            }
          }
        });
      }

      if (refIds.size > 0) {
        refIds.forEach(srcId => {
          // If inherited from parent, skip connecting line
          if (parentRefIds.has(srcId)) return;
          // If this source card is the parent itself, the parent->currCard line is already added
          if (currCard.derivedFromId && srcId === currCard.derivedFromId) return;

          const srcCard = cardMap.get(srcId);
          if (srcCard) {
            const key = `${srcCard.id}->${currCard.id}`;
            if (!connMap.has(key)) {
              connMap.set(key, { id: key, source: srcCard, target: currCard });
            }
            // Recursively trace upstream predecessors of the newly referenced card
            traceUpstream(srcCard);
          }
        });
      }
    };

    // Trace upstream lineage for every selected card
    selectedCardIds.forEach(id => {
      const card = cardMap.get(id);
      if (card) {
        traceUpstream(card);
      }
    });

    return Array.from(connMap.values());
  }, [cards, activeSelectedSet, selectedCardIds]);

  if (connections.length === 0) return null;

  // Real-time coordinate resolver considering active drag deltas
  const getLiveCardPos = (c: CardData) => {
    // 1. DOM Card Drag Delta
    const domDelta = (window as any).__dragDelta;
    if (domDelta) {
      if (domDelta.draggingCardId === c.id || (activeSelectedSet.has(c.id) && activeSelectedSet.has(domDelta.draggingCardId))) {
        return { x: c.x + domDelta.dx, y: c.y + domDelta.dy };
      }
    }

    // 2. Nano-Canvas Drag Delta
    const nanoDelta = (window as any).__nanoDragging;
    if (nanoDelta) {
      if (nanoDelta.cardId === c.id || (activeSelectedSet.has(c.id) && activeSelectedSet.has(nanoDelta.cardId))) {
        return { x: c.x + nanoDelta.dx, y: c.y + nanoDelta.dy };
      }
    }

    return { x: c.x, y: c.y };
  };

  const BLUE_COLOR = '#3b82f6';
  const safeScale = Math.max(currentScale || 1, 0.001);
  const strokeWidth = 1.5 / safeScale;
  const dotRadius = 3.5 / safeScale;

  return (
    <svg
      className="absolute inset-0 pointer-events-none overflow-visible z-[6]"
      style={{ width: 1, height: 1 }}
    >
      {connections.map(conn => {
        const { source, target } = conn;
        const srcDim = getCardSize(source);
        const tgtDim = getCardSize(target);

        const srcPos = getLiveCardPos(source);
        const tgtPos = getLiveCardPos(target);

        const srcCenter = {
          x: srcPos.x + srcDim.width / 2,
          y: srcPos.y + srcDim.height / 2,
        };
        const tgtCenter = {
          x: tgtPos.x + tgtDim.width / 2,
          y: tgtPos.y + tgtDim.height / 2,
        };

        // Exact boundary entry and exit points on the card boxes
        const startPoint = getRectBorderIntersection(
          srcPos.x,
          srcPos.y,
          srcDim.width,
          srcDim.height,
          tgtCenter.x,
          tgtCenter.y
        );

        const endPoint = getRectBorderIntersection(
          tgtPos.x,
          tgtPos.y,
          tgtDim.width,
          tgtDim.height,
          srcCenter.x,
          srcCenter.y
        );

        return (
          <g key={conn.id}>
            {/* Pure Clean Blue Straight Line (Scale Invariant) */}
            <line
              x1={startPoint.x}
              y1={startPoint.y}
              x2={endPoint.x}
              y2={endPoint.y}
              stroke={BLUE_COLOR}
              strokeWidth={strokeWidth}
            />

            {/* Start Circular Dot (Scale Invariant) */}
            <circle
              cx={startPoint.x}
              cy={startPoint.y}
              r={dotRadius}
              fill={BLUE_COLOR}
            />

            {/* End Circular Dot (Scale Invariant) */}
            <circle
              cx={endPoint.x}
              cy={endPoint.y}
              r={dotRadius}
              fill={BLUE_COLOR}
            />
          </g>
        );
      })}
    </svg>
  );
});
