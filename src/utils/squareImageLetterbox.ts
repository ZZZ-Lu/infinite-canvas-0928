/**
 * Square Letterbox & Vertical Slicing Utilities
 * 
 * Provides:
 * 1. Letterbox transformation for 1:1 square image grounding
 * 2. Multi-slice generation for tall vertical body portraits
 * 3. Coordinate unpadding back to original image space
 */

export interface LetterboxPadInfo {
  originalWidth: number;
  originalHeight: number;
  squareSize: number;
  padLeft: number;
  padTop: number;
  renderWidth: number;
  renderHeight: number;
  scale: number;
  isPadded: boolean;
}

export type SquarePadInfo = LetterboxPadInfo;

export interface VerticalSlice {
  sliceIndex: number;
  label: string;
  yStartPercent: number;
  heightPercent: number;
  dataUrl: string;
}

function loadImage(source: string | HTMLImageElement | Blob | File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') {
      return reject(new Error('Image is not supported in non-browser environment'));
    }

    if (source instanceof HTMLImageElement) {
      if (source.complete && source.naturalWidth > 0) {
        return resolve(source);
      }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(new Error('Failed to load image element: ' + String(e)));
      img.src = source.src;
      return;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error('Failed to load image: ' + String(e)));

    if (typeof source === 'string') {
      img.src = source;
    } else if (source instanceof Blob) {
      img.src = URL.createObjectURL(source);
    } else {
      reject(new Error('Unsupported image source type'));
    }
  });
}

/**
 * Creates a 1:1 square canvas containing the letterboxed image centered with black padding.
 * Returns the dataUrl and the padding geometry metadata for coordinate transformation.
 */
export async function createSquareLetterboxImage(
  imageSource: string | HTMLImageElement | Blob | File,
  targetSquareSize: number = 1024
): Promise<{
  dataUrl: string;
  padInfo: LetterboxPadInfo;
}> {
  const img = await loadImage(imageSource);
  const origW = img.naturalWidth || img.width || 1;
  const origH = img.naturalHeight || img.height || 1;

  const canvas = document.createElement('canvas');
  canvas.width = targetSquareSize;
  canvas.height = targetSquareSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context not available');
  }

  // Black letterbox background
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, targetSquareSize, targetSquareSize);

  const scale = Math.min(targetSquareSize / origW, targetSquareSize / origH);
  const renderWidth = Math.round(origW * scale);
  const renderHeight = Math.round(origH * scale);
  const padLeft = Math.round((targetSquareSize - renderWidth) / 2);
  const padTop = Math.round((targetSquareSize - renderHeight) / 2);

  ctx.drawImage(img, padLeft, padTop, renderWidth, renderHeight);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  const padInfo: LetterboxPadInfo = {
    originalWidth: origW,
    originalHeight: origH,
    squareSize: targetSquareSize,
    padLeft,
    padTop,
    renderWidth,
    renderHeight,
    scale,
    isPadded: padLeft > 0 || padTop > 0,
  };

  return { dataUrl, padInfo };
}

/**
 * Creates vertical widescreen slice crops with overlap for long vertical portraits.
 */
export async function createVerticalWidescreenSlices(
  imageSource: string | HTMLImageElement | Blob | File,
  numSlices: number = 3
): Promise<VerticalSlice[]> {
  const img = await loadImage(imageSource);
  const origW = img.naturalWidth || img.width || 1;
  const origH = img.naturalHeight || img.height || 1;

  const defaultLabels = [
    '头部五官与面容特写',
    '上身胸腹与手部姿态',
    '下身腿部与足部曲线',
    '全身环境与边缘细节'
  ];

  const slices: VerticalSlice[] = [];
  const count = Math.max(1, Math.min(5, numSlices));

  const step = 100 / count;
  const overlap = count > 1 ? step * 0.35 : 0;

  for (let i = 0; i < count; i++) {
    const yStartPercent = Math.max(0, i * step - (i > 0 ? overlap : 0));
    const yEndPercent = Math.min(100, (i + 1) * step + (i < count - 1 ? overlap : 0));
    const heightPercent = yEndPercent - yStartPercent;

    const sy = Math.round((yStartPercent / 100) * origH);
    const sh = Math.max(1, Math.round((heightPercent / 100) * origH));
    const sx = 0;
    const sw = origW;

    const sliceCanvas = document.createElement('canvas');
    const targetW = Math.min(origW, 1024);
    const targetH = Math.round((sh / sw) * targetW);
    sliceCanvas.width = targetW;
    sliceCanvas.height = targetH;

    const ctx = sliceCanvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetW, targetH);
      const dataUrl = sliceCanvas.toDataURL('image/jpeg', 0.9);
      slices.push({
        sliceIndex: i,
        label: defaultLabels[i] || `切片 ${i + 1}`,
        yStartPercent: Math.round(yStartPercent * 10) / 10,
        heightPercent: Math.round(heightPercent * 10) / 10,
        dataUrl,
      });
    }
  }

  return slices;
}

/**
 * Restores landmark coordinates from letterboxed canvas space back to the original image coordinates.
 * If padInfo is null or undefined, preserves landmarks and ensures coordinates are valid.
 */
export function unpadLandmarks(landmarks: any, padInfo?: LetterboxPadInfo | null): any {
  if (!landmarks || typeof landmarks !== 'object') {
    return landmarks;
  }

  // If no pad info is provided, pass through safely
  if (!padInfo || padInfo.renderWidth <= 0 || padInfo.renderHeight <= 0) {
    return landmarks;
  }

  function unpadCoords(x: number, y: number): { x: number; y: number } {
    if (typeof x !== 'number' || typeof y !== 'number') return { x, y };
    const pixelX = (x / 100) * padInfo!.squareSize;
    const pixelY = (y / 100) * padInfo!.squareSize;
    const origX = Math.max(0, Math.min(100, ((pixelX - padInfo!.padLeft) / padInfo!.renderWidth) * 100));
    const origY = Math.max(0, Math.min(100, ((pixelY - padInfo!.padTop) / padInfo!.renderHeight) * 100));
    return {
      x: Math.round(origX * 10) / 10,
      y: Math.round(origY * 10) / 10,
    };
  }

  function unpadBox(box: any): any {
    if (!Array.isArray(box) || box.length !== 4) return box;
    const [b0, b1, b2, b3] = box.map((v: any) => (typeof v === 'number' ? v : parseFloat(v) || 0));
    const isThousandScale = Math.max(b0, b1, b2, b3) > 100;
    const scale = isThousandScale ? 10 : 1;
    const ymin = Math.min(b0, b2) / scale;
    const ymax = Math.max(b0, b2) / scale;
    const xmin = Math.min(b1, b3) / scale;
    const xmax = Math.max(b1, b3) / scale;

    const pMin = unpadCoords(xmin, ymin);
    const pMax = unpadCoords(xmax, ymax);
    return [pMin.y, pMin.x, pMax.y, pMax.x];
  }

  const result = { ...landmarks };

  if (Array.isArray(result.interestPoints)) {
    result.interestPoints = result.interestPoints.map((pt: any) => {
      if (!pt || typeof pt !== 'object') return pt;
      const { x, y } = unpadCoords(pt.x, pt.y);
      return {
        ...pt,
        x,
        y,
        ...(pt.box ? { box: unpadBox(pt.box) } : {}),
      };
    });
  }

  if (result.regions && typeof result.regions === 'object') {
    const updatedRegions: Record<string, any> = {};
    for (const [key, val] of Object.entries(result.regions)) {
      if (!val) continue;
      if (Array.isArray(val)) {
        updatedRegions[key] = val.map((item: any) => {
          if (!item || typeof item !== 'object') return item;
          const { x, y } = unpadCoords(item.x, item.y);
          return {
            ...item,
            x,
            y,
            ...(item.box ? { box: unpadBox(item.box) } : {}),
          };
        });
      } else if (typeof val === 'object') {
        const item = val as any;
        const { x, y } = unpadCoords(item.x, item.y);
        updatedRegions[key] = {
          ...item,
          x,
          y,
          ...(item.box ? { box: unpadBox(item.box) } : {}),
        };
      } else {
        updatedRegions[key] = val;
      }
    }
    result.regions = updatedRegions;
  }

  return result;
}
