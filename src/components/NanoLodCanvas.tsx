import React, { useEffect, useRef } from 'react';
import { readyPromptPanels } from '../utils/promptSurfaceCache';
import { MotionValue } from 'motion/react';
import { CardData, getCardSize } from './GenerationCard';
import {
  getOrLoadThumbImage,
  getOrCreateMediaThumbnail,
  thumbCache,
} from '../utils/thumbnail';
import { calculateObjectCover, fullImageCache, getOrLoadCanvasImage } from '../utils/imageTextureCache';
import { getCardVisualBounds, getNanoLodThreshold, getLodTierByScale, type LodTier } from '../utils/viewportCulling';
import { getBottomPanelHeight, getPromptAreaHeight, calculatePromptLines } from '../utils/cardLayout';
import { buildCardQuadTree, QuadTree, BoundingBox } from '../utils/quadTree';

export interface NanoLodCanvasProps {
  cards: CardData[];
  selectedCardIds: string[];
  renderedCardIds?: Set<string>;
  agentTargetCardId?: string | null;
  agentTargetCardIds?: string[] | Set<string>;
  agentReferenceCardIds?: string[];
  agentFocusMap?: Record<string, { role: string; sourceTool: string }>;
  pickerSession?: {
    targetCardId: string;
    selectedReferences?: Array<{
      url: string;
      name?: string;
      fileData?: Blob;
      sourceCardId?: string;
    }>;
    selectedCardIds?: string[];
  } | null;
  scale: MotionValue<number>;
  tx: MotionValue<number>;
  ty: MotionValue<number>;
  isDarkMode: boolean;
  isOverviewMode?: boolean;
  dotModeThreshold?: number;
  isActive: boolean;
  onReady?: () => void;
  onThumbnailGenerated?: (id: string, thumbnailUrl: string) => void;
}

export const DEFAULT_OVERVIEW_DOT_THRESHOLD = 0;

interface BakedSnapshot {
  canvas: HTMLCanvasElement;
  bounds: { minX: number; minY: number; width: number; height: number };
  dark: boolean;
  cardsCount: number;
  selectedKey: string;
}

function drawCardBottomPanel(
  ctx: CanvasRenderingContext2D,
  card: CardData,
  cardX: number,
  cardY: number,
  cardW: number,
  cardH: number,
  dark: boolean,
  isSelected: boolean,
  borderSelected: string,
  borderNormal: string,
  selectedLineWidth: number,
  normalLineWidth: number,
  alpha: number = 1.0,
  lodTier: LodTier = 'nano',
  onScheduleDraw?: () => void
) {
  if (alpha <= 0.001) return;
  const panelW = 480;

  const refCount = card.referenceImages?.length || 0;
  const refRows = Math.ceil((refCount + 1) / 8);
  const refSectionHeight = refRows * 56;

  const promptAreaHeight = getPromptAreaHeight(card.prompt);
  const displayLineCount = Math.max(1, Math.min(13, Math.round(promptAreaHeight / 22)));

  // Get unified panel height matching Full Detail & MicroLOD exactly
  const panelH = getBottomPanelHeight(card.prompt, card.referenceImages?.length);
  const panelX = cardX + (cardW - panelW) / 2;
  const panelY = cardY + cardH + 12; // 12px gap matching flex flex-col gap-3 in DOM

  ctx.save();
  if (alpha < 1.0) {
    ctx.globalAlpha = (ctx.globalAlpha || 1.0) * alpha;
  }

  // Background fill: 0px for Nano, 12px for Micro & Standard (never 20px)
  const panelRadius = lodTier === 'nano' ? 0 : 12;
  ctx.fillStyle = dark ? '#262626' : '#f3f4f6';
  ctx.beginPath();
  if (panelRadius > 0) {
    ctx.roundRect(panelX, panelY, panelW, panelH, panelRadius);
  } else {
    ctx.rect(panelX, panelY, panelW, panelH);
  }
  ctx.fill();

  // Border (matching card and panel perimeter bounds)
  ctx.strokeStyle = isSelected ? borderSelected : borderNormal;
  const currentLw = isSelected ? selectedLineWidth : normalLineWidth;
  ctx.lineWidth = currentLw;
  ctx.stroke();

  let curY = panelY + 17; // 1px border + 16px padding

  if (lodTier === 'nano') {
    // === NANO LOD MODE (Fast blocky rectangles for < 40% zoom) ===
    ctx.fillStyle = dark ? '#383838' : '#e2e8f0';

    // 1) Reference images skeleton (sharp right-angle blocks)
    for (let r = 0; r < refRows; r++) {
      const itemsInRow = Math.min(refCount + 1 - r * 8, 8);
      for (let i = 0; i < itemsInRow; i++) {
        const rx = panelX + 17 + i * 56;
        const ry = curY + r * 56;
        ctx.beginPath();
        ctx.rect(rx, ry, 48, 48);
        ctx.fill();
      }
    }
    curY += (refRows * 56 - 8) + 16;

    // 2) Prompt text skeleton lines (sharp right-angle lines)
    const textTopOffset = curY + (promptAreaHeight - displayLineCount * 18) / 2;
    for (let i = 0; i < displayLineCount; i++) {
      const lw = (i === displayLineCount - 1 && displayLineCount > 1) ? (panelW - 34) * 0.58 : (panelW - 34) * 0.88;
      ctx.beginPath();
      ctx.rect(panelX + 17, textTopOffset + i * 22, lw, 14);
      ctx.fill();
    }

    // 3) Controls bottom bar & generate button (sharp right-angle)
    const actionBarY = panelY + panelH - 17 - 32;
    ctx.beginPath();
    ctx.rect(panelX + 17, actionBarY + 2, 140, 28);
    ctx.fill();

    ctx.beginPath();
    ctx.rect(panelX + panelW - 49, actionBarY, 32, 32);
    ctx.fill();
  } else {
    // === MICRO LOD MODE (Rich rounded squircle UI with thumbnails & text for >= 40% zoom) ===
    // 1) Reference images & add button
    for (let r = 0; r < refRows; r++) {
      const totalInRow = Math.min(refCount + 1 - r * 8, 8);
      for (let i = 0; i < totalInRow; i++) {
        const globalIdx = r * 8 + i;
        const rx = panelX + 17 + i * 56;
        const ry = curY + r * 56;

        if (globalIdx < refCount) {
          // Reference image slot
          ctx.fillStyle = dark ? 'rgba(38,38,38,0.6)' : '#f9fafb';
          ctx.strokeStyle = dark ? 'rgba(64,64,64,0.6)' : '#e5e7eb';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(rx + 0.5, ry + 0.5, 47, 47, 8);
          ctx.fill();
          ctx.stroke();

          const refItem = card.referenceImages?.[globalIdx];
          if (refItem && onScheduleDraw) {
            const thumbUrl = refItem.thumbnailUrl || refItem.microLodThumbnailUrl || refItem.url;
            const refImg = getOrLoadThumbImage(thumbUrl, onScheduleDraw);
            if (refImg && refImg.complete && refImg.naturalWidth > 0) {
              ctx.save();
              ctx.beginPath();
              ctx.roundRect(rx + 1, ry + 1, 46, 46, 7);
              ctx.clip();
              const fit = Math.min(46 / refImg.naturalWidth, 46 / refImg.naturalHeight);
              const rw = refImg.naturalWidth * fit;
              const rh = refImg.naturalHeight * fit;
              ctx.drawImage(refImg, rx + 1 + (46 - rw) / 2, ry + 1 + (46 - rh) / 2, rw, rh);
              ctx.restore();
            }
          }
        } else {
          // Plus button (Add reference)
          ctx.save();
          ctx.strokeStyle = dark ? '#404040' : '#d1d5db';
          ctx.lineWidth = 1.5;
          ctx.setLineDash([4, 3]);
          ctx.beginPath();
          ctx.roundRect(rx + 1, ry + 1, 46, 46, 8);
          ctx.stroke();
          ctx.setLineDash([]);

          // Draw small plus icon in center
          ctx.strokeStyle = dark ? '#666666' : '#9ca3af';
          ctx.lineWidth = 2;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(rx + 24, ry + 17);
          ctx.lineTo(rx + 24, ry + 31);
          ctx.moveTo(rx + 17, ry + 24);
          ctx.lineTo(rx + 31, ry + 24);
          ctx.stroke();
          ctx.restore();
        }
      }
    }
    curY += (refRows * 56 - 8) + 16;

    // 2) Prompt text rendering with typography
    const trimmedPrompt = (card.prompt || '').trim();
    ctx.save();
    ctx.font = '13px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    if (trimmedPrompt) {
      ctx.fillStyle = dark ? '#e5e5e5' : '#1f2937';
      const maxW = panelW - 34;
      const paragraphs = trimmedPrompt.split('\n');
      let lineY = curY + 16;
      let lineCount = 0;
      for (const p of paragraphs) {
        if (lineCount >= displayLineCount) break;
        let line = '';
        for (let c = 0; c < p.length; c++) {
          const test = line + p[c];
          if (ctx.measureText(test).width > maxW && line !== '') {
            ctx.fillText(line, panelX + 17, lineY);
            line = p[c];
            lineY += 20;
            lineCount++;
            if (lineCount >= displayLineCount) break;
          } else {
            line = test;
          }
        }
        if (line && lineCount < displayLineCount) {
          ctx.fillText(line, panelX + 17, lineY);
          lineY += 20;
          lineCount++;
        }
      }
    } else {
      ctx.fillStyle = dark ? '#737373' : '#9ca3af';
      ctx.fillText('描述你想要生成的画面...', panelX + 17, curY + 16);
    }
    ctx.restore();

    // 3) Controls bottom bar & generate button
    const actionBarY = panelY + panelH - 17 - 32;

    // Footer divider line
    ctx.strokeStyle = dark ? '#333333' : '#e5e7eb';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(panelX + 17, actionBarY - 8);
    ctx.lineTo(panelX + panelW - 17, actionBarY - 8);
    ctx.stroke();

    // Control pills
    ctx.save();
    ctx.font = '11px system-ui, -apple-system, sans-serif';
    const ratioStr = card.ratio || '16:9';
    const resStr = card.res || (card.isVideo ? '720p' : '2K');

    // Ratio pill
    const ratioW = ctx.measureText(ratioStr).width + 16;
    ctx.beginPath();
    ctx.roundRect(panelX + 17, actionBarY + 2, ratioW, 26, 6);
    ctx.fillStyle = dark ? '#333333' : '#e5e7eb';
    ctx.fill();
    ctx.fillStyle = dark ? '#d4d4d4' : '#4b5563';
    ctx.fillText(ratioStr, panelX + 25, actionBarY + 18);

    // Res pill
    const resW = ctx.measureText(resStr).width + 16;
    ctx.beginPath();
    ctx.roundRect(panelX + 22 + ratioW, actionBarY + 2, resW, 26, 6);
    ctx.fillStyle = dark ? '#333333' : '#e5e7eb';
    ctx.fill();
    ctx.fillStyle = dark ? '#d4d4d4' : '#4b5563';
    ctx.fillText(resStr, panelX + 30 + ratioW, actionBarY + 18);
    ctx.restore();

    // Generate Button
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(panelX + panelW - 49, actionBarY, 32, 32, 8);
    ctx.fillStyle = dark ? '#3b82f6' : '#2563eb';
    ctx.fill();
    // Up arrow icon
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const gx = panelX + panelW - 33;
    const gy = actionBarY + 16;
    ctx.beginPath();
    ctx.moveTo(gx, gy + 5);
    ctx.lineTo(gx, gy - 5);
    ctx.moveTo(gx - 4, gy - 1);
    ctx.lineTo(gx, gy - 5);
    ctx.lineTo(gx + 4, gy - 1);
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}

export const NanoLodCanvas: React.FC<NanoLodCanvasProps> = React.memo(function NanoLodCanvas({
  cards,
  selectedCardIds,
  renderedCardIds,
  agentTargetCardId,
  agentTargetCardIds,
  agentReferenceCardIds,
  agentFocusMap,
  pickerSession,
  scale,
  tx,
  ty,
  isDarkMode,
  isOverviewMode = false,
  dotModeThreshold = DEFAULT_OVERVIEW_DOT_THRESHOLD,
  isActive,
  onReady,
  onThumbnailGenerated,
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const cardPanelFadeMapRef = useRef<Map<string, number>>(new Map());
  const pendingThumbGenRef = useRef<Set<string>>(new Set());
  const bakedSnapshotRef = useRef<BakedSnapshot | null>(null);
  const quadTreeRef = useRef<QuadTree<CardData> | null>(null);

  // Synchronize QuadTree spatial index on cards change
  useEffect(() => {
    quadTreeRef.current = buildCardQuadTree(cards);
  }, [cards]);

  // Store latest props in refs to avoid re-binding change listeners on every render
  const cardsRef = useRef(cards);
  cardsRef.current = cards;

  const selectedIdsRef = useRef(selectedCardIds);
  selectedIdsRef.current = selectedCardIds;

  const renderedIdsRef = useRef(renderedCardIds);
  renderedIdsRef.current = renderedCardIds;

  const agentTargetCardIdRef = useRef(agentTargetCardId);
  agentTargetCardIdRef.current = agentTargetCardId;

  const agentTargetCardIdsRef = useRef(agentTargetCardIds);
  agentTargetCardIdsRef.current = agentTargetCardIds;

  const agentReferenceCardIdsRef = useRef(agentReferenceCardIds);
  agentReferenceCardIdsRef.current = agentReferenceCardIds;

  const agentFocusMapRef = useRef(agentFocusMap);
  agentFocusMapRef.current = agentFocusMap;

  const pickerSessionRef = useRef(pickerSession);
  pickerSessionRef.current = pickerSession;

  const isDarkRef = useRef(isDarkMode);
  isDarkRef.current = isDarkMode;

  const isOverviewModeRef = useRef(isOverviewMode);
  isOverviewModeRef.current = isOverviewMode;

  const dotThresholdRef = useRef(dotModeThreshold);
  dotThresholdRef.current = dotModeThreshold;

  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;

  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  const onThumbGenRef = useRef(onThumbnailGenerated);
  onThumbGenRef.current = onThumbnailGenerated;

  // Builds or retrieves cached static snapshot texture for Overview Mode
  const getOrBuildOverviewSnapshot = (
    currentCards: CardData[],
    dark: boolean,
    selectedSet: Set<string>,
    pickerSession: NanoLodCanvasProps['pickerSession']
  ): BakedSnapshot | null => {
    if (currentCards.length === 0) return null;

    const selectedKey = Array.from(selectedSet).sort().join(',') + (pickerSession ? `_picker_${pickerSession.targetCardId}` : '');
    const cached = bakedSnapshotRef.current;
    if (
      cached &&
      cached.dark === dark &&
      cached.cardsCount === currentCards.length &&
      cached.selectedKey === selectedKey
    ) {
      return cached;
    }

    // 1. Calculate overall world bounding box including bottom panels
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < currentCards.length; i++) {
      const card = currentCards[i];
      const dim = getCardSize(card);
      const isGenerationCard = !card.fileName && !card.isAsset;
      const panelH = isGenerationCard ? getBottomPanelHeight(card.prompt, card.referenceImages?.length) + 12 : 0;
      const panelW = 480;
      const effectiveLeft = Math.min(card.x, isGenerationCard ? card.x + (dim.width - panelW) / 2 : card.x);
      const effectiveRight = Math.max(card.x + dim.width, isGenerationCard ? card.x + (dim.width + panelW) / 2 : card.x + dim.width);

      if (effectiveLeft < minX) minX = effectiveLeft;
      if (card.y < minY) minY = card.y;
      if (effectiveRight > maxX) maxX = effectiveRight;
      if (card.y + dim.height + panelH > maxY) maxY = card.y + dim.height + panelH;
    }
    if (minX === Infinity) return null;

    const padding = 100;
    minX -= padding;
    minY -= padding;
    maxX += padding;
    maxY += padding;
    const worldW = maxX - minX;
    const worldH = maxY - minY;

    // 2. Determine texture size (bounded to max 2560px)
    const maxTextureEdge = 2560;
    const scaleRatio = Math.min(1.0, maxTextureEdge / Math.max(worldW, worldH));
    const textureW = Math.max(128, Math.min(maxTextureEdge, Math.round(worldW * scaleRatio)));
    const textureH = Math.max(128, Math.min(maxTextureEdge, Math.round(worldH * scaleRatio)));

    let offscreen: HTMLCanvasElement;
    if (cached && cached.canvas) {
      offscreen = cached.canvas;
      if (offscreen.width !== textureW || offscreen.height !== textureH) {
        offscreen.width = textureW;
        offscreen.height = textureH;
      }
    } else {
      offscreen = document.createElement('canvas');
      offscreen.width = textureW;
      offscreen.height = textureH;
    }

    const offCtx = offscreen.getContext('2d');
    if (!offCtx) return null;

    offCtx.clearRect(0, 0, textureW, textureH);
    offCtx.save();
    offCtx.scale(scaleRatio, scaleRatio);
    offCtx.translate(-minX, -minY);

    // Sharp rectangle rendering strictly adhering to card ratio and dimensions
    const colorGenerating = dark ? '#262626' : '#f3f4f6';
    const colorMedia = dark ? '#262626' : '#f3f4f6';
    const colorDraft = dark ? '#262626' : '#f3f4f6';
    const borderNormal = dark ? 'rgba(64, 64, 64, 0.85)' : 'rgba(212, 212, 216, 0.85)';
    const borderSelected = '#3b82f6';
    const borderAgentTarget = '#9333ea';
    const normalLineWidth = 1.5 / scaleRatio;
    const selectedLineWidth = 3.5 / scaleRatio;

    for (let i = 0; i < currentCards.length; i++) {
      const card = currentCards[i];
      const dim = getCardSize(card);
      const isSelected = selectedSet.has(card.id);
      const targetIds = agentTargetCardIdsRef.current;
      const isAgentTargetInSet = Boolean(
        targetIds && (targetIds instanceof Set ? targetIds.has(card.id) : targetIds.includes(card.id))
      );
      const isAgentFocused = Boolean(
        (agentTargetCardIdRef.current && agentTargetCardIdRef.current === card.id) ||
        isAgentTargetInSet ||
        agentFocusMapRef.current?.[card.id]
      );
      const hasMedia = Boolean(
        card.thumbnailUrl || card.imageUrl || card.originalImageUrl || card.trueOriginalImageUrl || card.fileData || card.originalFileData || card.trueOriginalFileData
      );

      // Fill proportional rectangle
      offCtx.fillStyle = card.state === 'generating' ? colorGenerating : hasMedia ? colorMedia : colorDraft;
      offCtx.fillRect(card.x, card.y, dim.width, dim.height);

      // Thumbnail cover if available in cache
      const thumbUrl =
        card.closeupThumbnailUrl ||
        card.thumbnailUrl ||
        thumbCache.get(card.id) ||
        (card.imageUrl ? thumbCache.get(card.imageUrl) : undefined) ||
        card.imageUrl ||
        card.originalImageUrl;

      let drawSourceImg: HTMLImageElement | null = null;
      if (thumbUrl) {
        drawSourceImg = getOrLoadThumbImage(thumbUrl, scheduleDraw);
      } else if (card.imageUrl && fullImageCache.has(card.imageUrl)) {
        const cachedImg = fullImageCache.get(card.imageUrl);
        if (cachedImg && cachedImg.complete && cachedImg.naturalWidth > 0) {
          drawSourceImg = cachedImg;
        }
      }

      if (drawSourceImg && drawSourceImg.complete && drawSourceImg.naturalWidth > 0) {
        const { sx, sy, sw, sh } = calculateObjectCover(
          drawSourceImg.naturalWidth,
          drawSourceImg.naturalHeight,
          dim.width,
          dim.height
        );
        offCtx.drawImage(drawSourceImg, sx, sy, sw, sh, card.x, card.y, dim.width, dim.height);
      }

      // Proportional rectangle stroke border
      if (isAgentFocused) {
        offCtx.strokeStyle = borderAgentTarget;
        offCtx.lineWidth = selectedLineWidth * 1.25;
        offCtx.strokeRect(card.x, card.y, dim.width, dim.height);
      } else {
        offCtx.strokeStyle = isSelected ? borderSelected : borderNormal;
        const currentLw = isSelected ? selectedLineWidth : normalLineWidth;
        offCtx.lineWidth = currentLw;
        offCtx.strokeRect(card.x, card.y, dim.width, dim.height);
      }

      // 4. Bottom Panel Skeleton Color Block for Generation Cards in Overview Mode
      const isGenerationCard = !card.fileName && !card.isAsset;
      if (isGenerationCard) {
        drawCardBottomPanel(
          offCtx,
          card,
          card.x,
          card.y,
          dim.width,
          dim.height,
          dark,
          isSelected,
          borderSelected,
          borderNormal,
          selectedLineWidth,
          normalLineWidth
        );
      }
    }

    offCtx.restore();

    const result: BakedSnapshot = {
      canvas: offscreen,
      bounds: { minX, minY, width: worldW, height: worldH },
      dark,
      cardsCount: currentCards.length,
      selectedKey,
    };
    bakedSnapshotRef.current = result;
    return result;
  };

  // Single-frame draw call
  const draw = () => {
    const canvas = canvasRef.current;
    if (!canvas || !isActiveRef.current) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const currentScale = scale.get();
    const currentTx = tx.get();
    const currentTy = ty.get();
    const dpr = window.devicePixelRatio || 1;

    const width = window.innerWidth;
    const height = window.innerHeight;

    // Adjust canvas resolution if viewport size changed
    const targetW = Math.round(width * dpr);
    const targetH = Math.round(height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const dark = isDarkRef.current;
    const currentCards = cardsRef.current;
    const selectedIds = selectedIdsRef.current || [];
    const pickerSession = pickerSessionRef.current;

    // Check if dragging locally in Nano LOD
    const dragging = (window as any).__nanoDragging;

    ctx.save();
    // Normalize to CSS pixel coordinates
    ctx.scale(dpr, dpr);
    // Apply camera world transform
    ctx.translate(currentTx, currentTy);
    ctx.scale(currentScale, currentScale);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // PERFORMANCE HIGHWAY: In Overview Mode, draw the single baked snapshot texture in O(1) time
    if (isOverviewModeRef.current && !dragging) {
      const selectedSet = new Set<string>(selectedIds);
      const snapshot = getOrBuildOverviewSnapshot(currentCards, dark, selectedSet, pickerSession);
      if (snapshot) {
        ctx.drawImage(
          snapshot.canvas,
          0,
          0,
          snapshot.canvas.width,
          snapshot.canvas.height,
          snapshot.bounds.minX,
          snapshot.bounds.minY,
          snapshot.bounds.width,
          snapshot.bounds.height
        );
      }
      ctx.restore();
      if (onReadyRef.current) {
        onReadyRef.current();
      }
      return;
    }

    // Reset baked snapshot when leaving overview mode to free memory
    if (bakedSnapshotRef.current) {
      bakedSnapshotRef.current = null;
    }

    // Compute visible viewport bounds in world coordinates for instant AABB culling
    const vpLeft = -currentTx / currentScale;
    const vpTop = -currentTy / currentScale;
    const vpRight = (width - currentTx) / currentScale;
    const vpBottom = (height - currentTy) / currentScale;

    // Color constants matching Nano-LOD design (sharp straight edges / no border radius)
    // Matches DOM bg-gray-100 (#f3f4f6) and dark:bg-neutral-800 (#262626)
    const colorGenerating = dark ? '#262626' : '#f3f4f6';
    const colorMedia = dark ? '#262626' : '#f3f4f6';
    const colorDraft = dark ? '#262626' : '#f3f4f6';

    const borderNormal = dark ? 'rgba(64, 64, 64, 0.85)' : 'rgba(212, 212, 216, 0.85)';
    const borderSelected = '#3b82f6';
    const borderAgentTarget = '#9333ea';
    const borderPickerTarget = '#3b82f6';
    const borderPickerSelected = '#2563eb';

    const iconDraftColor = dark ? 'rgba(64, 64, 64, 0.85)' : 'rgba(212, 212, 216, 0.85)';
    const iconMediaColor = dark ? 'rgba(115, 115, 115, 0.85)' : 'rgba(163, 163, 163, 0.85)';

    // Constant screen-pixel line widths regardless of world scale
    const normalLineWidth = 1 / currentScale;
    const selectedLineWidth = 2 / currentScale;
    const pickerSelectedLineWidth = 4 / currentScale;

    const threshold = getNanoLodThreshold();
    const currentLodTier: LodTier = isOverviewModeRef.current ? 'nano' : getLodTierByScale(currentScale);
    const currentCardRadius = currentLodTier === 'nano' ? 0 : 12;

    // First pass: Draw unselected cards
    // Second pass: Draw selected cards on top to avoid border occlusion
    const unselectedCards: CardData[] = [];
    const selectedCards: CardData[] = [];

    // Rapid QuadTree spatial query in O(log N + K) time
    const queryMargin = 100 / currentScale;
    const vpBounds: BoundingBox = {
      minX: vpLeft - queryMargin,
      minY: vpTop - queryMargin,
      maxX: vpRight + queryMargin,
      maxY: vpBottom + queryMargin,
    };
    const candidateCards = quadTreeRef.current ? quadTreeRef.current.query(vpBounds) : currentCards;

    for (let i = 0; i < candidateCards.length; i++) {
      const card = candidateCards[i];

      // Determine real-time dragging position for visibility test
      let cx = card.x;
      let cy = card.y;
      if (dragging) {
        const isThisDragging = dragging.isDraggingSelected 
          ? dragging.selectedCardIds.includes(card.id) 
          : card.id === dragging.cardId;
        if (isThisDragging) {
          cx += dragging.dx;
          cy += dragging.dy;
        }
      }

      // Include the visible prompt panel even when its image is above the viewport.
      const bounds = getCardVisualBounds(card);
      const offsetX = cx - card.x;
      const offsetY = cy - card.y;
      if (
        bounds.maxX + offsetX < vpLeft ||
        bounds.minX + offsetX > vpRight ||
        bounds.maxY + offsetY < vpTop ||
        bounds.minY + offsetY > vpBottom
      ) {
        continue;
      }
      const isSelected = selectedIds.includes(card.id);
      const isPickerTarget = pickerSession?.targetCardId === card.id;
      let isPickerSelected = false;
      if (pickerSession) {
        if (pickerSession.selectedReferences) {
          isPickerSelected = pickerSession.selectedReferences.some(ref => 
            ref.sourceCardId === card.id || 
            (ref.url && (ref.url === card.imageUrl || ref.url === card.originalImageUrl || ref.url === card.thumbnailUrl))
          );
        } else if (pickerSession.selectedCardIds) {
          isPickerSelected = pickerSession.selectedCardIds.includes(card.id);
        }
      }
      
      if (isSelected || isPickerTarget || isPickerSelected) {
        selectedCards.push(card);
      } else {
        unselectedCards.push(card);
      }
    }

    const renderCard = (card: CardData) => {
      const dim = getCardSize(card);

      // --- CALCULATE REALTIME NANO DRAGGING OFFSET ---
      let cardX = card.x;
      let cardY = card.y;
      if (dragging) {
        const isThisDragging = dragging.isDraggingSelected 
          ? dragging.selectedCardIds.includes(card.id) 
          : card.id === dragging.cardId;
        if (isThisDragging) {
          cardX += dragging.dx;
          cardY += dragging.dy;
        }
      }

      const highLodFocusCardId = pickerSession?.targetCardId || (selectedIds.length === 1 ? selectedIds[0] : null);
      const isSelected = selectedIds.includes(card.id);
      const isHighLodTarget = card.id === highLodFocusCardId;
      // In scale >= threshold or for the high-LOD target card, check if Standard/Native LOD is already mounted and painted in DOM underneath
      const renderedSet = renderedIdsRef.current;
      const paintedSet = typeof window !== 'undefined' ? (window as any).__paintedCardIds : null;
      const isPainted = Boolean(paintedSet?.has(card.id));
      const panelReady = Boolean(card.fileName || card.isAsset) || readyPromptPanels.has(card.id);
      const isCardReadyInDom = (currentScale >= threshold || isHighLodTarget) && Boolean(renderedSet && (renderedSet.has(card.id) || isHighLodTarget) && isPainted && panelReady);

      // Instant seamless handoff: if card is rendered and painted in DOM, DOM handles rendering directly!
      if (isCardReadyInDom) {
        return;
      }

      // If we are in High LOD (scale >= threshold), and the card is currently being dragged in DOM,
      // skip rendering it on the canvas completely so that we don't leave any "ghost" behind.
      if (currentScale >= getNanoLodThreshold()) {
        const isDragging = (window as any).isDraggingCard;
        const draggingCardId = (window as any).draggingCardId;
        if (isDragging && draggingCardId) {
          const isThisDragging = (card.id === draggingCardId) || 
            (selectedIds.includes(draggingCardId) && selectedIds.includes(card.id));
          if (isThisDragging) {
            return;
          }
        }
      }

      const isPickerTarget = pickerSession?.targetCardId === card.id;
      
      let pickerSelectionIndex = 0;
      if (pickerSession) {
        if (pickerSession.selectedReferences) {
          const idx = pickerSession.selectedReferences.findIndex(ref => 
            ref.sourceCardId === card.id || 
            (ref.url && (ref.url === card.imageUrl || ref.url === card.originalImageUrl || ref.url === card.thumbnailUrl))
          );
          if (idx !== -1) {
            pickerSelectionIndex = idx + 1;
          }
        } else if (pickerSession.selectedCardIds) {
          const idx = pickerSession.selectedCardIds.indexOf(card.id);
          if (idx !== -1) {
            pickerSelectionIndex = idx + 1;
          }
        }
      }
      const isPickerSelected = pickerSelectionIndex > 0;

      const screenW = dim.width * currentScale;

      const hasMedia = Boolean(
        card.thumbnailUrl ||
        card.imageUrl ||
        card.originalImageUrl ||
        card.trueOriginalImageUrl ||
        card.fileData ||
        card.originalFileData ||
        card.trueOriginalFileData
      );
      const isGenerating = card.state === 'generating';

      // 1. Base Fill (sharp rect in Nano LOD, 12px rounded in Micro & Standard LOD)
      if (isGenerating) {
        ctx.fillStyle = colorGenerating;
      } else if (hasMedia) {
        ctx.fillStyle = colorMedia;
      } else {
        ctx.fillStyle = colorDraft;
      }
      ctx.beginPath();
      if (currentCardRadius > 0) {
        ctx.roundRect(cardX, cardY, dim.width, dim.height, currentCardRadius);
      } else {
        ctx.rect(cardX, cardY, dim.width, dim.height);
      }
      ctx.fill();

      // Placeholder media uses one lower card LOD; geometry keeps the current LOD.
      // Micro placeholders use Nano's 256px image; Standard and close-up
      // placeholders use the 1200px proxy, never the original texture tier.
      // The 64px/128px reference variants are not card LOD image tiers.
      let hasDrawnThumbnail = false;
      let drawSourceImg: HTMLImageElement | null = null;
      const fullProxyUrl = card.imageUrl;
      const cachedThumbnail = thumbCache.get(card.id) || (fullProxyUrl ? thumbCache.get(fullProxyUrl) : undefined);
      if (currentLodTier === 'standard' && fullProxyUrl) {
        drawSourceImg = getOrLoadCanvasImage(fullProxyUrl, scheduleDraw, 'full');
      }
      const nanoThumbnailUrl = card.closeupThumbnailUrl || card.thumbnailUrl || cachedThumbnail;
      if (!drawSourceImg && nanoThumbnailUrl) {
        drawSourceImg = getOrLoadThumbImage(nanoThumbnailUrl, scheduleDraw);
      } else if (!drawSourceImg && fullProxyUrl) {
        // Legacy cards without thumbnails may reuse a loaded proxy, never fetch it
        // merely to supply a Micro/Nano placeholder.
        drawSourceImg = fullImageCache.get(fullProxyUrl) || null;
      }
      if (drawSourceImg && drawSourceImg.complete && drawSourceImg.naturalWidth > 0) {
        const { sx, sy, sw, sh } = calculateObjectCover(
          drawSourceImg.naturalWidth,
          drawSourceImg.naturalHeight,
          dim.width,
          dim.height
        );
        if (currentCardRadius > 0) {
          ctx.save();
          ctx.beginPath();
          ctx.roundRect(cardX, cardY, dim.width, dim.height, currentCardRadius);
          ctx.clip();
          ctx.drawImage(drawSourceImg, sx, sy, sw, sh, cardX, cardY, dim.width, dim.height);
          // Add dark filter for videos in Micro/Standard LOD matching DOM's bg-black/25
          if (card.isVideo) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
            ctx.fillRect(cardX, cardY, dim.width, dim.height);
          }
          ctx.restore();
        } else {
          ctx.drawImage(drawSourceImg, sx, sy, sw, sh, cardX, cardY, dim.width, dim.height);
          // Add dark filter for videos in Nano LOD to match Micro LOD's bg-black/25
          if (card.isVideo) {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
            ctx.fillRect(cardX, cardY, dim.width, dim.height);
          }
        }
        hasDrawnThumbnail = true;
      } else if (hasMedia && !isGenerating) {
        // Trigger background thumbnail generation ONLY when idle (never during active drag, pan, or zoom gesture)
        const isWorkspaceGesturing = typeof document !== 'undefined' && Boolean(
          document.getElementById('canvas-workspace')?.getAttribute('data-gesture') === 'true' ||
          document.getElementById('canvas-workspace')?.getAttribute('data-zooming') === 'true' ||
          document.getElementById('canvas-workspace')?.getAttribute('data-panning') === 'true' ||
          (window as any).isDraggingCard ||
          (window as any).__nanoDragging
        );

        if (!isWorkspaceGesturing && !pendingThumbGenRef.current.has(card.id)) {
          pendingThumbGenRef.current.add(card.id);
          getOrCreateMediaThumbnail(card).then((generatedUrl) => {
            pendingThumbGenRef.current.delete(card.id);
            if (generatedUrl) {
              onThumbGenRef.current?.(card.id, generatedUrl);
              scheduleDraw();
            }
          });
        }
      }

      const focusItem = agentFocusMapRef.current?.[card.id];
      const targetIds = agentTargetCardIdsRef.current;
      const isAgentTargetInSet = Boolean(
        targetIds && (targetIds instanceof Set ? targetIds.has(card.id) : targetIds.includes(card.id))
      );
      const isAgentPrimary = Boolean(
        (agentTargetCardIdRef.current && agentTargetCardIdRef.current === card.id) ||
        isAgentTargetInSet ||
        focusItem
      );
      const isAgentRef = Boolean(
        agentReferenceCardIdsRef.current && agentReferenceCardIdsRef.current.includes(card.id)
      );

      // Helper to stroke card bounds (sharp rect in Nano LOD, 12px rounded in Micro & Standard LOD)
      const strokeCardBounds = (strokeStyle: string | CanvasGradient, lineWidth: number, dashed = false) => {
        ctx.save();
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = lineWidth;
        if (dashed) ctx.setLineDash([4, 4]);
        ctx.beginPath();
        if (currentCardRadius > 0) {
          ctx.roundRect(cardX, cardY, dim.width, dim.height, currentCardRadius);
        } else {
          ctx.rect(cardX, cardY, dim.width, dim.height);
        }
        ctx.stroke();
        ctx.restore();
      };

      // 3. Border
      if (isPickerSelected) {
        strokeCardBounds(borderPickerSelected, pickerSelectedLineWidth);
      } else if (isAgentPrimary) {
        if (isSelected) {
          // Dual co-presence: half user blue (#3b82f6) + half agent purple (#a45cf8) diagonal gradient stroke
          const grad = ctx.createLinearGradient(cardX, cardY, cardX + dim.width, cardY + dim.height);
          grad.addColorStop(0, '#3b82f6');
          grad.addColorStop(0.44, '#3b82f6');
          grad.addColorStop(0.56, '#a45cf8');
          grad.addColorStop(1, '#a45cf8');
          strokeCardBounds(grad, selectedLineWidth);
        } else {
          strokeCardBounds(borderAgentTarget, selectedLineWidth * 1.25);
        }
      } else if (isAgentRef) {
        strokeCardBounds(borderAgentTarget, normalLineWidth * 1.5, true);
      } else if (isPickerTarget) {
        strokeCardBounds(borderPickerTarget, selectedLineWidth);
      } else if (isSelected) {
        strokeCardBounds(borderSelected, selectedLineWidth);
      } else {
        strokeCardBounds(borderNormal, normalLineWidth);
      }

      // 3b. Bottom Panel Skeleton Color Block for Generation Cards in 2D Canvas Mode
      const isGenerationCard = !card.fileName && !card.isAsset;
      if (isGenerationCard) {
        // Only skip canvas skeleton bottom panel for the exclusive high-LOD target (whose native panel is rendered in DOM)
        if (!isHighLodTarget) {
          drawCardBottomPanel(
            ctx,
            card,
            cardX,
            cardY,
            dim.width,
            dim.height,
            dark,
            isSelected,
            borderSelected,
            borderNormal,
            selectedLineWidth,
            normalLineWidth,
            1.0,
            currentLodTier,
            scheduleDraw
          );
        }
      }

      // 4. Center indicator / video play badge
      if (card.isVideo && screenW >= 12) {
        // Video Thumbnail Overlay: semi-transparent circular badge with play triangle
        const cx = cardX + dim.width / 2;
        const cy = cardY + dim.height / 2;
        const badgeRadius = Math.min(dim.width, dim.height) * 0.25;

        // Semi-transparent circular backdrop matching DOM's bg-white/20 dark:bg-black/30
        ctx.fillStyle = dark ? 'rgba(0, 0, 0, 0.3)' : 'rgba(255, 255, 255, 0.2)';
        ctx.beginPath();
        ctx.arc(cx, cy, badgeRadius, 0, Math.PI * 2);
        ctx.fill();

        // Border matching DOM's border-white/30 dark:border-white/10
        ctx.lineWidth = 1;
        ctx.strokeStyle = dark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(255, 255, 255, 0.3)';
        ctx.stroke();

        // White play triangle (matches DOM text-white/85)
        const triSize = badgeRadius * 0.8;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.beginPath();
        ctx.moveTo(cx - triSize * 0.35, cy - triSize * 0.5);
        ctx.lineTo(cx + triSize * 0.55, cy);
        ctx.lineTo(cx - triSize * 0.35, cy + triSize * 0.5);
        ctx.closePath();
        ctx.fill();
      } else if (!hasDrawnThumbnail && screenW >= 12) {
        // Fallback indicator when thumbnail is still generating/loading
        const cx = cardX + dim.width / 2;
        const cy = cardY + dim.height / 2;
        if (hasMedia) {
          const r = Math.max(2.5 / currentScale, 2);
          ctx.fillStyle = iconMediaColor;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();
        } else {
          const r = Math.max(1.5 / currentScale, 1.5);
          ctx.fillStyle = iconDraftColor;
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 5. Picker Session Badges
      if (isPickerSelected && screenW >= 24) {
        // Draw picker index badge on top left
        const badgeSize = Math.max(16 / currentScale, 12);
        const padding = Math.max(4 / currentScale, 2);
        const fontSize = Math.max(10 / currentScale, 8);
        
        ctx.fillStyle = borderPickerSelected;
        ctx.beginPath();
        // A simple square or slightly rounded rect for canvas mode
        ctx.rect(cardX + padding, cardY + padding, badgeSize, badgeSize);
        ctx.fill();
        
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${fontSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(pickerSelectionIndex.toString(), cardX + padding + badgeSize / 2, cardY + padding + badgeSize / 2 + (1/currentScale));
      } else if (isPickerTarget && screenW >= 40) {
        // Draw "当前目标" badge
        const fontSize = Math.max(10 / currentScale, 8);
        const paddingX = Math.max(8 / currentScale, 4);
        const paddingY = Math.max(4 / currentScale, 2);
        
        ctx.font = `bold ${fontSize}px sans-serif`;
        const metrics = ctx.measureText("当前目标");
        const w = metrics.width + paddingX * 2;
        const h = fontSize + paddingY * 2;
        
        const badgeX = cardX - paddingX;
        const badgeY = cardY - h;
        
        ctx.fillStyle = '#3b82f6';
        ctx.beginPath();
        ctx.rect(badgeX, badgeY, w, h);
        ctx.fill();
        
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText("当前目标", badgeX + w/2, badgeY + h/2 + (1/currentScale));
      }
    };

    // Render unselected first, then selected on top
    for (let i = 0; i < unselectedCards.length; i++) {
      renderCard(unselectedCards[i]);
    }
    for (let i = 0; i < selectedCards.length; i++) {
      renderCard(selectedCards[i]);
    }

    ctx.restore();
    
    if (onReadyRef.current) {
      onReadyRef.current();
    }
  };

  const scheduleDraw = () => {
    if (rafIdRef.current !== null) return;
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      draw();
    });
  };

  // Re-draw when active state changes
  useEffect(() => {
    if (isActive) {
      scheduleDraw();
    } else {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
  }, [isActive]);

  // Re-draw when data changes (renderedCardIds excluded to prevent canvas redraw thrashing on DOM card mount)
  useEffect(() => {
    if (isActive) {
      scheduleDraw();
    }
  }, [cards, selectedCardIds, agentTargetCardId, agentTargetCardIds, agentReferenceCardIds, agentFocusMap, pickerSession, isDarkMode, isOverviewMode, dotModeThreshold, isActive]);

  // Listen to custom nano dragging events for local, non-react repaint
  useEffect(() => {
    if (!isActive) return;
    window.addEventListener('card-painted', scheduleDraw);
    return () => window.removeEventListener('card-painted', scheduleDraw);
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return;
    const handleRepaint = () => {
      scheduleDraw();
    };
    window.addEventListener('nano-dragging', handleRepaint);
    return () => {
      window.removeEventListener('nano-dragging', handleRepaint);
    };
  }, [isActive]);

  // Listen to MotionValue camera transforms (pan & zoom)
  useEffect(() => {
    if (!isActive) return;

    const unsubScale = scale.on('change', scheduleDraw);
    const unsubTx = tx.on('change', scheduleDraw);
    const unsubTy = ty.on('change', scheduleDraw);

    const handleResize = () => scheduleDraw();
    window.addEventListener('resize', handleResize);

    return () => {
      unsubScale();
      unsubTx();
      unsubTy();
      window.removeEventListener('resize', handleResize);
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [scale, tx, ty, isActive]);

  if (!isActive) return null;

  return (
    <canvas
      ref={canvasRef}
      id="nano-lod-canvas"
      className={`fixed inset-0 pointer-events-none ${isOverviewMode ? 'z-0' : 'z-[15]'}`}
      style={{
        width: '100vw',
        height: '100vh',
      }}
    />
  );
});
