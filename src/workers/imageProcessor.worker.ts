/**
 * Web Worker for off-thread image decoding, resizing, and multi-tier LOD thumbnail generation.
 * 
 * Complies with AGENTS.md Architecture Constraints:
 * - Data-DOM Decoupling: Zero DOM dependencies, zero React state, pure OffscreenCanvas.
 * - Hardware Accelerated: Uses native createImageBitmap and OffscreenCanvas in dedicated threads.
 * - Memory Protection: Directly converts downscaled frames to Blobs/DataURLs without Base64 memory bloating.
 */

function getTargetDimensions(origW: number, origH: number, maxEdge: number) {
  if (origW <= 0 || origH <= 0) return { width: maxEdge, height: maxEdge };
  if (origW <= maxEdge && origH <= maxEdge) return { width: origW, height: origH };
  if (origW >= origH) {
    return {
      width: maxEdge,
      height: Math.max(1, Math.round(maxEdge * (origH / origW))),
    };
  } else {
    return {
      width: Math.max(1, Math.round(maxEdge * (origW / origH))),
      height: maxEdge,
    };
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  const SyncReaderClass = (self as any).FileReaderSync;
  if (typeof SyncReaderClass !== 'undefined') {
    try {
      const reader = new SyncReaderClass();
      return Promise.resolve(reader.readAsDataURL(blob));
    } catch {
      // Fall through to async FileReader
    }
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error || new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}

async function canvasToBlob(canvas: OffscreenCanvas, type: string, quality: number): Promise<Blob> {
  if (typeof canvas.convertToBlob === 'function') {
    return await canvas.convertToBlob({ type, quality });
  }
  // Fallback if convertToBlob is not available
  // @ts-ignore
  if (typeof canvas.toBlob === 'function') {
    return new Promise((resolve, reject) => {
      // @ts-ignore
      canvas.toBlob((blob: Blob | null) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas toBlob failed'));
      }, type, quality);
    });
  }
  throw new Error('OffscreenCanvas convertToBlob not supported in this environment');
}

async function processImage(file: Blob, maxPreviewDim = 1200, maxTextureDim = 4096) {
  const bitmap = await createImageBitmap(file);
  const origW = bitmap.width;
  const origH = bitmap.height;

  // 1. Preview proxy (max 1200px)
  const previewDim = getTargetDimensions(origW, origH, maxPreviewDim);
  const previewCanvas = new OffscreenCanvas(previewDim.width, previewDim.height);
  const previewCtx = previewCanvas.getContext('2d', { alpha: true, desynchronized: true, willReadFrequently: false });
  if (!previewCtx) throw new Error('2D context unavailable on OffscreenCanvas');
  previewCtx.imageSmoothingEnabled = true;
  previewCtx.imageSmoothingQuality = 'high';
  previewCtx.drawImage(bitmap, 0, 0, previewDim.width, previewDim.height);

  const previewMime = (file.type === 'image/png' || file.type === 'image/webp') ? 'image/jpeg' : 'image/jpeg';
  const previewBlob = await canvasToBlob(previewCanvas, previewMime, 0.85);

  // 2. 4K Proxy (only if original > maxTextureDim)
  const isOver4K = origW > maxTextureDim || origH > maxTextureDim;
  let proxy4KBlob: Blob | undefined;
  if (isOver4K) {
    const proxyDim = getTargetDimensions(origW, origH, maxTextureDim);
    const proxyCanvas = new OffscreenCanvas(proxyDim.width, proxyDim.height);
    const proxyCtx = proxyCanvas.getContext('2d', { alpha: true, desynchronized: true, willReadFrequently: false });
    if (proxyCtx) {
      proxyCtx.imageSmoothingEnabled = true;
      proxyCtx.imageSmoothingQuality = 'high';
      proxyCtx.drawImage(bitmap, 0, 0, proxyDim.width, proxyDim.height);
      proxy4KBlob = await canvasToBlob(proxyCanvas, 'image/jpeg', 0.90);
    }
  }

  // 3. Progressive multi-tier thumbnails downscaled directly from previewCanvas
  // 256px (Closeup)
  const dim256 = getTargetDimensions(origW, origH, 256);
  const canvas256 = new OffscreenCanvas(dim256.width, dim256.height);
  const ctx256 = canvas256.getContext('2d', { alpha: true, desynchronized: true, willReadFrequently: false });
  if (!ctx256) throw new Error('2D context failed for thumb 256');
  ctx256.imageSmoothingEnabled = true;
  ctx256.imageSmoothingQuality = 'high';
  ctx256.drawImage(previewCanvas, 0, 0, dim256.width, dim256.height);
  const blob256 = await canvasToBlob(canvas256, 'image/webp', 0.88);
  const thumb256 = await blobToDataUrl(blob256);

  // 128px (Full detail)
  const dim128 = getTargetDimensions(origW, origH, 128);
  const canvas128 = new OffscreenCanvas(dim128.width, dim128.height);
  const ctx128 = canvas128.getContext('2d', { alpha: true, desynchronized: true, willReadFrequently: false });
  if (!ctx128) throw new Error('2D context failed for thumb 128');
  ctx128.imageSmoothingEnabled = true;
  ctx128.imageSmoothingQuality = 'high';
  ctx128.drawImage(canvas256, 0, 0, dim128.width, dim128.height);
  const blob128 = await canvasToBlob(canvas128, 'image/webp', 0.85);
  const thumb128 = await blobToDataUrl(blob128);

  // 64px (Micro LOD)
  const dim64 = getTargetDimensions(origW, origH, 64);
  const canvas64 = new OffscreenCanvas(dim64.width, dim64.height);
  const ctx64 = canvas64.getContext('2d', { alpha: true, desynchronized: true, willReadFrequently: false });
  if (!ctx64) throw new Error('2D context failed for thumb 64');
  ctx64.imageSmoothingEnabled = true;
  ctx64.imageSmoothingQuality = 'high';
  ctx64.drawImage(canvas128, 0, 0, dim64.width, dim64.height);
  const blob64 = await canvasToBlob(canvas64, 'image/webp', 0.80);
  const thumb64 = await blobToDataUrl(blob64);

  // Release decoded bitmap resource
  bitmap.close();

  return {
    previewBlob,
    proxy4KBlob,
    isOver4K,
    thumb256,
    thumb128,
    thumb64,
    width: origW,
    height: origH,
  };
}

async function processThumbnails(source: Blob) {
  const bitmap = await createImageBitmap(source);
  const origW = bitmap.width;
  const origH = bitmap.height;

  // 256px
  const dim256 = getTargetDimensions(origW, origH, 256);
  const canvas256 = new OffscreenCanvas(dim256.width, dim256.height);
  const ctx256 = canvas256.getContext('2d', { alpha: true, desynchronized: true, willReadFrequently: false });
  if (!ctx256) throw new Error('2D context failed');
  ctx256.imageSmoothingEnabled = true;
  ctx256.imageSmoothingQuality = 'high';
  ctx256.drawImage(bitmap, 0, 0, dim256.width, dim256.height);
  const blob256 = await canvasToBlob(canvas256, 'image/webp', 0.88);
  const thumb256 = await blobToDataUrl(blob256);

  // 128px
  const dim128 = getTargetDimensions(origW, origH, 128);
  const canvas128 = new OffscreenCanvas(dim128.width, dim128.height);
  const ctx128 = canvas128.getContext('2d', { alpha: true, desynchronized: true, willReadFrequently: false });
  if (!ctx128) throw new Error('2D context failed');
  ctx128.imageSmoothingEnabled = true;
  ctx128.imageSmoothingQuality = 'high';
  ctx128.drawImage(canvas256, 0, 0, dim128.width, dim128.height);
  const blob128 = await canvasToBlob(canvas128, 'image/webp', 0.85);
  const thumb128 = await blobToDataUrl(blob128);

  // 64px
  const dim64 = getTargetDimensions(origW, origH, 64);
  const canvas64 = new OffscreenCanvas(dim64.width, dim64.height);
  const ctx64 = canvas64.getContext('2d', { alpha: true, desynchronized: true, willReadFrequently: false });
  if (!ctx64) throw new Error('2D context failed');
  ctx64.imageSmoothingEnabled = true;
  ctx64.imageSmoothingQuality = 'high';
  ctx64.drawImage(canvas128, 0, 0, dim64.width, dim64.height);
  const blob64 = await canvasToBlob(canvas64, 'image/webp', 0.80);
  const thumb64 = await blobToDataUrl(blob64);

  bitmap.close();

  return {
    thumb256,
    thumb128,
    thumb64,
  };
}

self.onmessage = async (event: MessageEvent) => {
  const { id, type, payload } = event.data;
  try {
    if (type === 'PROCESS_IMAGE') {
      const { file, maxPreviewDim, maxTextureDim } = payload;
      const result = await processImage(file, maxPreviewDim, maxTextureDim);
      self.postMessage({ id, success: true, result });
    } else if (type === 'PROCESS_THUMBNAILS') {
      const { source } = payload;
      const result = await processThumbnails(source);
      self.postMessage({ id, success: true, result });
    } else {
      throw new Error(`Unknown worker operation: ${type}`);
    }
  } catch (error) {
    self.postMessage({
      id,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
