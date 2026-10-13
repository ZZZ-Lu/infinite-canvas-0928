/**
 * Pure In-Memory Bounding Box Image Cropper
 * 
 * Strict compliance with Data-DOM Decoupling:
 * - Operates directly on Blob / File / dataURL / HTMLImageElement in memory
 * - Uses OffscreenCanvas where available, falling back to lightweight detached Canvas
 * - Zero DOM attachment, zero style computation, zero reflow/repaint
 */

export interface BoundingBox2D {
  // [ymin, xmin, ymax, xmax] in 0~100 normalized coordinate system (or 0~1000 integer system)
  box: [number, number, number, number];
}

/**
 * Extracts a normalized crop from an image source in pure memory.
 * Returns a high-fidelity dataUrl (image/jpeg) suitable for sending to vision models.
 */
export async function cropBoundingBoxFromImage(
  imageSource: string | Blob | File | HTMLImageElement,
  box: [number, number, number, number],
  options: {
    paddingPercent?: number; // e.g. 0.05 for 5% padding around the box
    maxOutputDimension?: number; // cap output dimension (e.g. 640px) for speed & bandwidth
    quality?: number; // JPEG quality (default 0.9)
  } = {}
): Promise<{ dataUrl: string; width: number; height: number } | null> {
  const { paddingPercent = 0.04, maxOutputDimension = 640, quality = 0.9 } = options;

  let img: HTMLImageElement;
  let objectUrlToRevoke: string | null = null;

  try {
    if (imageSource instanceof HTMLImageElement) {
      if (!imageSource.complete || imageSource.naturalWidth === 0) {
        await new Promise((resolve, reject) => {
          imageSource.onload = () => resolve(true);
          imageSource.onerror = reject;
        });
      }
      img = imageSource;
    } else {
      img = new Image();
      img.crossOrigin = 'anonymous';
      img.referrerPolicy = 'no-referrer';

      const loadPromise = new Promise((resolve, reject) => {
        img.onload = () => resolve(true);
        img.onerror = (e) => reject(new Error('Failed to load image for cropping: ' + String(e)));
      });

      if (typeof imageSource === 'string') {
        img.src = imageSource;
      } else if (imageSource instanceof Blob) {
        objectUrlToRevoke = URL.createObjectURL(imageSource);
        img.src = objectUrlToRevoke;
      } else {
        return null;
      }

      await loadPromise;
    }

    const nw = img.naturalWidth || img.width || 1;
    const nh = img.naturalHeight || img.height || 1;

    // Normalize coordinates to 0.0 ~ 1.0 range
    const [b0, b1, b2, b3] = box.map(v => typeof v === 'number' ? v : parseFloat(v) || 0);
    const maxVal = Math.max(b0, b1, b2, b3);
    const scale = maxVal > 100 ? 1000 : (maxVal > 1.0 ? 100 : 1.0);

    const rawYmin = Math.min(b0, b2) / scale;
    const rawYmax = Math.max(b0, b2) / scale;
    const rawXmin = Math.min(b1, b3) / scale;
    const rawXmax = Math.max(b1, b3) / scale;

    const padY = (rawYmax - rawYmin) * paddingPercent;
    const padX = (rawXmax - rawXmin) * paddingPercent;

    const normYmin = Math.max(0, rawYmin - padY);
    const normYmax = Math.min(1.0, rawYmax + padY);
    const normXmin = Math.max(0, rawXmin - padX);
    const normXmax = Math.min(1.0, rawXmax + padX);

    const sx = Math.round(normXmin * nw);
    const sy = Math.round(normYmin * nh);
    const sw = Math.max(2, Math.round((normXmax - normXmin) * nw));
    const sh = Math.max(2, Math.round((normYmax - normYmin) * nh));

    // Downscale target if larger than maxOutputDimension
    let targetW = sw;
    let targetH = sh;
    if (Math.max(targetW, targetH) > maxOutputDimension) {
      if (targetW >= targetH) {
        targetH = Math.round((targetH / targetW) * maxOutputDimension);
        targetW = maxOutputDimension;
      } else {
        targetW = Math.round((targetW / targetH) * maxOutputDimension);
        targetH = maxOutputDimension;
      }
    }
    targetW = Math.max(2, targetW);
    targetH = Math.max(2, targetH);

    let dataUrl = '';

    if (typeof OffscreenCanvas !== 'undefined') {
      const offscreen = new OffscreenCanvas(targetW, targetH);
      const ctx = offscreen.getContext('2d');
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetW, targetH);
      const blob = await offscreen.convertToBlob({ type: 'image/jpeg', quality });
      dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      });
    } else {
      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, targetW, targetH);
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    }

    return { dataUrl, width: targetW, height: targetH };
  } catch (err) {
    console.warn('[ImageCropper] Error cropping bounding box:', err);
    return null;
  } finally {
    if (objectUrlToRevoke) {
      try {
        URL.revokeObjectURL(objectUrlToRevoke);
      } catch {}
    }
  }
}
