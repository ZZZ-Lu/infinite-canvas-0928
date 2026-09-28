import React, { useEffect, useLayoutEffect, useRef } from 'react';
import {
  getOrLoadCanvasImage,
  calculateObjectCover,
} from '../utils/imageTextureCache';
import { getOrLoadThumbImage } from '../utils/thumbnail';

export interface CardImageCanvasProps {
  cardId?: string;
  thumbnailUrl?: string | null;
  imageUrl?: string | null;
  originalImageUrl?: string | null;
  showOriginal?: boolean;
  width: number;
  height: number;
  dpr?: number;
  state?: string;
  isZooming?: boolean;
  className?: string;
}

/**
 * High-performance Canvas renderer for Card Images across all three LOD tiers:
 * - Micro: Ultra-fast 64px thumbnail loaded instantly as baseline placeholder
 * - Full: Standard high-definition preview image with smooth asynchronous loading
 * - Original: Ultra-high-resolution original image activated on deep zoom
 * 
 * Complies with AGENTS.md Architecture Constraints:
 * - Data-DOM Decoupling: Zero DOM <img> tags created. Pure hardware-accelerated Canvas.
 * - Intent-Driven Lazy Restoration: Instant degradation to Full/Micro upon motion.
 */
export const CardImageCanvas: React.FC<CardImageCanvasProps> = React.memo(function CardImageCanvas({
  cardId,
  thumbnailUrl,
  imageUrl,
  originalImageUrl,
  showOriginal = false,
  width,
  height,
  dpr = 1,
  state,
  isZooming = false,
  className = '',
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafIdRef = useRef<number | null>(null);

  // Cross-fade animation progress states
  const fullAlphaRef = useRef<number>(1);
  const originalAlphaRef = useRef<number>(0);
  const fadeStartTimeRef = useRef<number | null>(null);
  const isFadingOriginalRef = useRef<boolean>(false);

  // Keep latest props in refs to avoid re-binding callbacks
  const propsRef = useRef({
    cardId,
    thumbnailUrl,
    imageUrl,
    originalImageUrl,
    showOriginal,
    width,
    height,
    dpr,
    state,
    isZooming,
  });
  propsRef.current = {
    cardId,
    thumbnailUrl,
    imageUrl,
    originalImageUrl,
    showOriginal,
    width,
    height,
    dpr,
    state,
    isZooming,
  };

  const scheduleDraw = () => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      draw();
    });
  };

  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const {
      cardId,
      thumbnailUrl,
      imageUrl,
      originalImageUrl,
      showOriginal,
      width: w,
      height: h,
      dpr: currentDpr,
      state: cardState,
      isZooming: zooming,
    } = propsRef.current;

    if (w <= 0 || h <= 0) return;

    // Determine target canvas pixel resolution
    const isGestureActive = typeof window !== 'undefined' && (
      Boolean((window as any).isDraggingCard) || 
      Boolean((window as any).isDraggingCanvas) ||
      Boolean((window as any).isZoomingCanvas) ||
      document.getElementById('canvas-workspace')?.getAttribute('data-gesture') === 'true' ||
      document.getElementById('canvas-workspace')?.getAttribute('data-zooming') === 'true' ||
      document.getElementById('canvas-workspace')?.getAttribute('data-panning') === 'true'
    );
    const effectiveShowOriginal = showOriginal && !isGestureActive;

    const actualDpr = effectiveShowOriginal
      ? Math.min(Math.max(window.devicePixelRatio || 1, currentDpr), 8.0)
      : (window.devicePixelRatio || 1);

    const targetPxW = Math.round(w * actualDpr);
    const targetPxH = Math.round(h * actualDpr);

    if (canvas.width !== targetPxW || canvas.height !== targetPxH) {
      canvas.width = targetPxW;
      canvas.height = targetPxH;
    }

    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Coordinate space normalization (from physical pixels to CSS pixels)
    ctx.scale(actualDpr, actualDpr);

    // Plan A: Image fills full canvas bounds. Corner clipping is seamlessly handled by parent container's overflow-hidden squircle to ensure 100% precision fit.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 1. Check loaded states for Micro, Full, and Original
    const microImg = thumbnailUrl
      ? getOrLoadThumbImage(thumbnailUrl, scheduleDraw)
      : null;

    const fullImg = imageUrl
      ? getOrLoadCanvasImage(imageUrl, scheduleDraw, 'full')
      : null;

    const origImg = (effectiveShowOriginal && originalImageUrl)
      ? getOrLoadCanvasImage(originalImageUrl, scheduleDraw, 'original')
      : null;

    const isGenerating = cardState === 'generating';

    // Helper to draw an image with object-cover calculation
    const drawCover = (img: HTMLImageElement, alpha: number = 1) => {
      if (!img || !img.complete || img.naturalWidth === 0) return;
      const { sx, sy, sw, sh } = calculateObjectCover(
        img.naturalWidth,
        img.naturalHeight,
        w,
        h
      );
      ctx.globalAlpha = alpha;
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
    };

    // 2. Base Tier: Render Micro / Thumbnail
    if (microImg && microImg.complete && microImg.naturalWidth > 0) {
      drawCover(microImg, 1);
    }

    // 3. Middle Tier: Render Full standard preview
    if (fullImg && fullImg.complete && fullImg.naturalWidth > 0) {
      if (isGenerating && !imageUrl) {
        // Generating placeholder filter
        ctx.filter = 'blur(12px) brightness(0.95)';
        drawCover(fullImg, 1);
        ctx.filter = 'none';
      } else {
        drawCover(fullImg, 1);
      }
    }

    // 4. Top Tier: Render Original High-Res (Intent-Driven Lazy Restoration)
    if (effectiveShowOriginal && origImg && origImg.complete && origImg.naturalWidth > 0) {
      if (zooming) {
        // During active zoom/pan, instantly draw full opacity with 0ms transition
        drawCover(origImg, 1);
      } else {
        // Smooth cross-fade into high-resolution original
        const now = performance.now();
        if (!isFadingOriginalRef.current) {
          isFadingOriginalRef.current = true;
          fadeStartTimeRef.current = now;
        }

        const elapsed = now - (fadeStartTimeRef.current || now);
        const fadeDuration = 150; // 150ms smooth transition matching original spec
        const progress = Math.min(1, elapsed / fadeDuration);

        drawCover(origImg, progress);

        if (progress < 1) {
          // Continue animation until fully opaque
          scheduleDraw();
        }
      }
    } else {
      // Reset original fade state when not showing original
      isFadingOriginalRef.current = false;
      fadeStartTimeRef.current = null;
    }

    // 5. Track first paint completeness for Zero-Flicker Handoff
    const hasMedia = Boolean(thumbnailUrl || imageUrl || originalImageUrl);
    let isPainted = false;

    if (!hasMedia) {
      isPainted = true;
    } else {
      const microImgComplete = microImg && microImg.complete && microImg.naturalWidth > 0;
      const fullImgComplete = fullImg && fullImg.complete && fullImg.naturalWidth > 0;
      const origImgComplete = effectiveShowOriginal && origImg && origImg.complete && origImg.naturalWidth > 0;
      
      if (microImgComplete || fullImgComplete || origImgComplete) {
        isPainted = true;
      }
    }

    if (isPainted && cardId && typeof window !== 'undefined') {
      if (!(window as any).__paintedCardIds) {
        (window as any).__paintedCardIds = new Set<string>();
      }
      if (!(window as any).__paintedCardIds.has(cardId)) {
        (window as any).__paintedCardIds.add(cardId);
        window.dispatchEvent(new CustomEvent('card-painted', { detail: { cardId } }));
      }
    }

    ctx.restore();
  };

  // Trigger draw synchronously on mount and prop updates to eliminate the 1-frame asynchronous lag!
  useLayoutEffect(() => {
    // Cancel any pending RAF since we are drawing synchronously now
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    draw();
  }, [
    cardId,
    thumbnailUrl,
    imageUrl,
    originalImageUrl,
    showOriginal,
    width,
    height,
    dpr,
    state,
    isZooming,
  ]);

  // Clean up painted registration on unmount
  useEffect(() => {
    return () => {
      if (cardId && typeof window !== 'undefined') {
        if ((window as any).__paintedCardIds) {
          (window as any).__paintedCardIds.delete(cardId);
          window.dispatchEvent(new CustomEvent('card-painted', { detail: { cardId } }));
        }
      }
    };
  }, [cardId]);

  // Listen for idle canvas styles restoration
  useEffect(() => {
    const handleStylesRestored = () => {
      scheduleDraw();
    };
    window.addEventListener('canvas-styles-restored', handleStylesRestored);
    return () => {
      window.removeEventListener('canvas-styles-restored', handleStylesRestored);
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className={`absolute inset-0 w-full h-full pointer-events-none ${className}`}
      style={{
        width: `${width}px`,
        height: `${height}px`,
      }}
    />
  );
});
