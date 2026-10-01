/**
 * Thumbnail utility module for ultra-low resolution Nano-LOD rendering.
 * Strictly adheres to Data-DOM Decoupling: contains zero React state or DOM dependencies,
 * fully portable to PixiJS / WebGL / Canvas / Worker environments.
 */

export const MAX_THUMBNAIL_EDGE = 480;

// In-memory string cache for thumbnail Data URLs (media/card id -> DataURL)
export const thumbCache = new Map<string, string>();

// In-memory HTMLImageElement cache for instantaneous Canvas 2D ctx.drawImage
export const thumbImageCache = new Map<string, HTMLImageElement>();

// Set of card IDs currently pending thumbnail generation to prevent duplicate concurrent work
const pendingThumbnailIds = new Set<string>();

/**
 * Multi-step progressive downscaling to prevent aliasing, blurriness, and moire
 * when downsampling large 2K/4K media down to thumbnail dimensions.
 */
function drawImageHighQuality(
  ctx: CanvasRenderingContext2D,
  source: HTMLImageElement | HTMLVideoElement,
  targetW: number,
  targetH: number
) {
  const curW = source instanceof HTMLVideoElement ? (source.videoWidth || targetW) : (source.naturalWidth || targetW);
  const curH = source instanceof HTMLVideoElement ? (source.videoHeight || targetH) : (source.naturalHeight || targetH);

  // If within 2x of target, draw directly with high quality smoothing
  if (curW <= targetW * 2 && curH <= targetH * 2) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, targetW, targetH);
    return;
  }

  // Progressive half-step downsampling for extreme downscales to preserve sharp details
  let curCanvas = document.createElement('canvas');
  curCanvas.width = curW;
  curCanvas.height = curH;
  const curCtx = curCanvas.getContext('2d');
  if (!curCtx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, targetW, targetH);
    return;
  }
  curCtx.imageSmoothingEnabled = true;
  curCtx.imageSmoothingQuality = 'high';
  curCtx.drawImage(source, 0, 0);

  let stepW = curW;
  let stepH = curH;
  while (stepW > targetW * 2 || stepH > targetH * 2) {
    const nextW = Math.max(targetW, Math.floor(stepW / 2));
    const nextH = Math.max(targetH, Math.floor(stepH / 2));
    const nextCanvas = document.createElement('canvas');
    nextCanvas.width = nextW;
    nextCanvas.height = nextH;
    const nextCtx = nextCanvas.getContext('2d');
    if (!nextCtx) break;
    nextCtx.imageSmoothingEnabled = true;
    nextCtx.imageSmoothingQuality = 'high';
    nextCtx.drawImage(curCanvas, 0, 0, nextW, nextH);

    curCanvas = nextCanvas;
    stepW = nextW;
    stepH = nextH;
  }

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(curCanvas, 0, 0, targetW, targetH);
}

/**
 * Calculate proportional thumbnail dimensions preserving aspect ratio without distortion.
 * Longest edge is strictly capped at maxEdge (default: 480px).
 */
export function getThumbnailDimensions(
  origW: number,
  origH: number,
  maxEdge: number = MAX_THUMBNAIL_EDGE
): { width: number; height: number } {
  if (origW <= 0 || origH <= 0) {
    return { width: maxEdge, height: maxEdge };
  }
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

/**
 * Generate a crisp, high-definition thumbnail preserving fine lines and faces.
 */
export async function generateImageThumbnail(
  imageSource: string | Blob,
  maxEdge: number = MAX_THUMBNAIL_EDGE,
  quality: number = 0.90
): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    let tempUrl: string | null = null;

    if (imageSource instanceof Blob) {
      tempUrl = URL.createObjectURL(imageSource);
      img.src = tempUrl;
    } else if (typeof imageSource === 'string' && imageSource.trim()) {
      // Allow cross-origin images to be drawn to canvas without tainting
      if (!imageSource.startsWith('data:') && !imageSource.startsWith('blob:')) {
        img.crossOrigin = 'anonymous';
      }
      img.src = imageSource;
    } else {
      resolve('');
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timeoutId);
      img.onload = null;
      img.onerror = null;
      if (tempUrl) {
        URL.revokeObjectURL(tempUrl);
      }
    };

    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('Image thumbnail generation timed out'));
    }, 5000);

    img.onload = () => {
      try {
        const origW = img.naturalWidth || maxEdge;
        const origH = img.naturalHeight || maxEdge;
        const { width: tw, height: th } = getThumbnailDimensions(origW, origH, maxEdge);

        const canvas = document.createElement('canvas');
        canvas.width = tw;
        canvas.height = th;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          cleanup();
          return reject(new Error('2D context unavailable'));
        }

        drawImageHighQuality(ctx, img, tw, th);
        let dataUrl = '';
        try {
          dataUrl = canvas.toDataURL('image/webp', quality);
          if (!dataUrl.startsWith('data:image/webp')) {
            dataUrl = canvas.toDataURL('image/jpeg', quality);
          }
        } catch {
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        cleanup();
        resolve(dataUrl);
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    img.onerror = (e) => {
      cleanup();
      reject(new Error('Image load failed for thumbnail generation'));
    };
  });
}

/**
 * Generate a crisp first-frame thumbnail from a video source using a temporary offscreen element.
 * Completely unloads the video element afterwards to avoid hardware decoder allocation limits.
 */
export async function generateVideoThumbnail(
  videoSource: string | Blob,
  maxEdge: number = MAX_THUMBNAIL_EDGE,
  quality: number = 0.90
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!videoSource) {
      resolve('');
      return;
    }
    if (typeof videoSource === 'string' && videoSource.trim() === '') {
      resolve('');
      return;
    }

    // Check memory cache first
    if (typeof videoSource === 'string') {
      const cached = thumbCache.get(videoSource);
      if (cached) {
        resolve(cached);
        return;
      }
    }

    const video = document.createElement('video');
    video.style.position = 'fixed';
    video.style.top = '-9999px';
    video.style.left = '-9999px';
    video.style.width = '1px';
    video.style.height = '1px';
    video.style.opacity = '0';
    video.style.pointerEvents = 'none';
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    (video as any).referrerPolicy = 'no-referrer';

    let tempUrl: string | null = null;
    let isAttached = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    let hasCaptured = false;
    let seekAttempts = 0;

    const cleanup = () => {
      clearTimeout(timeoutId);
      video.onloadedmetadata = null;
      video.onloadeddata = null;
      video.oncanplay = null;
      video.onseeked = null;
      video.ontimeupdate = null;
      video.onerror = null;
      try {
        video.pause();
      } catch {}
      video.src = '';
      if (isAttached && video.parentNode) {
        video.parentNode.removeChild(video);
      }
      if (tempUrl) {
        URL.revokeObjectURL(tempUrl);
      }
    };

    const capture = () => {
      if (hasCaptured) return;
      if (!video.videoWidth || !video.videoHeight) return;

      try {
        const origW = video.videoWidth || 640;
        const origH = video.videoHeight || 360;
        const { width: tw, height: th } = getThumbnailDimensions(origW, origH, maxEdge);

        const canvas = document.createElement('canvas');
        canvas.width = tw;
        canvas.height = th;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          cleanup();
          return reject(new Error('2D context unavailable'));
        }

        drawImageHighQuality(ctx, video, tw, th);

        // Black frame detection: check if the frame is completely black (e.g. video starting with black fade)
        try {
          const sampleW = Math.min(tw, 20);
          const sampleH = Math.min(th, 20);
          const sampleData = ctx.getImageData(
            Math.floor((tw - sampleW) / 2),
            Math.floor((th - sampleH) / 2),
            sampleW,
            sampleH
          ).data;
          let isAllBlack = true;
          for (let i = 0; i < sampleData.length; i += 4) {
            if (sampleData[i] > 18 || sampleData[i + 1] > 18 || sampleData[i + 2] > 18) {
              isAllBlack = false;
              break;
            }
          }
          // If the sampled center is completely black and the video has enough duration, try seeking to 0.25s
          if (isAllBlack && seekAttempts < 2 && video.duration && video.duration > 0.3) {
            seekAttempts++;
            video.currentTime = 0.25;
            return;
          }
        } catch {
          // If getImageData has cross-origin or security restriction, continue with toDataURL
        }

        hasCaptured = true;
        let dataUrl = '';
        try {
          dataUrl = canvas.toDataURL('image/webp', quality);
          if (!dataUrl.startsWith('data:image/webp')) {
            dataUrl = canvas.toDataURL('image/jpeg', quality);
          }
        } catch {
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        cleanup();
        if (typeof videoSource === 'string' && dataUrl) {
          thumbCache.set(videoSource, dataUrl);
        }
        resolve(dataUrl);
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    timeoutId = setTimeout(() => {
      if (!hasCaptured && video.videoWidth && video.videoHeight) {
        hasCaptured = true;
        try {
          const { width: tw, height: th } = getThumbnailDimensions(video.videoWidth, video.videoHeight, maxEdge);
          const canvas = document.createElement('canvas');
          canvas.width = tw;
          canvas.height = th;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            drawImageHighQuality(ctx, video, tw, th);
            const dataUrl = canvas.toDataURL('image/jpeg', quality);
            cleanup();
            if (typeof videoSource === 'string' && dataUrl) {
              thumbCache.set(videoSource, dataUrl);
            }
            resolve(dataUrl);
            return;
          }
        } catch {}
      }
      cleanup();
      reject(new Error('Video thumbnail capture timed out'));
    }, 8000);

    const triggerSeek = () => {
      if (hasCaptured) return;
      if (video.currentTime < 0.04) {
        try {
          video.currentTime = 0.08;
        } catch {}
      }
    };

    video.onloadedmetadata = triggerSeek;
    video.onloadeddata = triggerSeek;
    video.oncanplay = triggerSeek;
    video.onseeked = capture;
    video.ontimeupdate = () => {
      if (video.currentTime >= 0.05) {
        capture();
      }
    };

    video.onerror = () => {
      if (video.crossOrigin === 'anonymous' && typeof videoSource === 'string') {
        video.removeAttribute('crossOrigin');
        video.src = videoSource;
        video.load();
        return;
      }
      cleanup();
      reject(new Error('Video load failed for thumbnail capture'));
    };

    if (videoSource instanceof Blob) {
      tempUrl = URL.createObjectURL(videoSource);
      video.src = tempUrl;
    } else if (typeof videoSource === 'string' && videoSource.trim()) {
      let resolvedSrc = videoSource;
      if (/^https?:\/\//i.test(videoSource) && !videoSource.startsWith(window.location.origin)) {
        resolvedSrc = `/api/mcp/workrally/proxy-media?url=${encodeURIComponent(videoSource)}`;
      }
      if (!resolvedSrc.startsWith('data:') && !resolvedSrc.startsWith('blob:')) {
        video.crossOrigin = 'anonymous';
      }
      video.src = resolvedSrc;
    } else {
      resolve('');
      return;
    }

    if (typeof document !== 'undefined' && document.body) {
      document.body.appendChild(video);
      isAttached = true;
    }

    video.load();

    const playPromise = video.play();
    if (playPromise !== undefined) {
      playPromise.catch(() => {});
    }
  });
}

// Map from URL -> Set of callbacks to trigger when loaded
const pendingThumbCallbacks = new Map<string, Set<() => void>>();

/**
 * Retrieve or load an HTMLImageElement for synchronous Canvas 2D ctx.drawImage.
 * Triggers onLoaded callback when texture is ready for drawing.
 */
export function getOrLoadThumbImage(
  url: string,
  onLoaded?: () => void
): HTMLImageElement | null {
  if (!url) return null;
  const existing = thumbImageCache.get(url);
  if (existing) {
    if (existing.complete && existing.naturalWidth > 0) {
      return existing;
    }
    if (onLoaded) {
      if (!pendingThumbCallbacks.has(url)) {
        pendingThumbCallbacks.set(url, new Set());
      }
      pendingThumbCallbacks.get(url)!.add(onLoaded);
    }
    return null;
  }

  const img = new Image();
  img.referrerPolicy = 'no-referrer';
  if (onLoaded) {
    if (!pendingThumbCallbacks.has(url)) {
      pendingThumbCallbacks.set(url, new Set());
    }
    pendingThumbCallbacks.get(url)!.add(onLoaded);
  }

  img.onload = () => {
    const callbacks = pendingThumbCallbacks.get(url);
    if (callbacks) {
      callbacks.forEach(cb => {
        try {
          cb();
        } catch (err) {
          console.error('[thumbnail] Thumb callback execution error:', err);
        }
      });
      pendingThumbCallbacks.delete(url);
    }
  };
  img.onerror = () => {
    pendingThumbCallbacks.delete(url);
  };
  img.src = url;
  thumbImageCache.set(url, img);
  return null;
}

/**
 * Universal media thumbnail getter/creator.
 * Checks memory cache -> existing thumbnailUrl -> generates from media source -> caches result.
 */
export async function getOrCreateMediaThumbnail(
  media: {
    id: string;
    imageUrl?: string | null;
    fileData?: Blob;
    originalFileData?: Blob;
    trueOriginalFileData?: Blob;
    originalImageUrl?: string | null;
    trueOriginalImageUrl?: string | null;
    isVideo?: boolean;
    thumbnailUrl?: string;
  },
  maxEdge: number = MAX_THUMBNAIL_EDGE
): Promise<string | null> {
  // 1. If already has thumbnailUrl, warm up memory cache
  if (media.thumbnailUrl) {
    thumbCache.set(media.id, media.thumbnailUrl);
    if (media.imageUrl) thumbCache.set(media.imageUrl, media.thumbnailUrl);
    return media.thumbnailUrl;
  }

  // 2. Check memory cache by id or imageUrl
  if (thumbCache.has(media.id)) {
    return thumbCache.get(media.id)!;
  }
  if (media.imageUrl && thumbCache.has(media.imageUrl)) {
    return thumbCache.get(media.imageUrl)!;
  }

  // 3. Check if already pending to avoid redundant work
  if (pendingThumbnailIds.has(media.id)) {
    return null;
  }

  // 4. Source resolution
  const source = media.fileData || media.originalFileData || media.trueOriginalFileData || media.imageUrl || media.originalImageUrl || media.trueOriginalImageUrl;
  if (!source) return null;

  pendingThumbnailIds.add(media.id);
  try {
    let dataUrl: string;
    if (media.isVideo) {
      dataUrl = await generateVideoThumbnail(source, maxEdge);
    } else {
      dataUrl = await generateImageThumbnail(source, maxEdge);
    }

    thumbCache.set(media.id, dataUrl);
    if (media.imageUrl) thumbCache.set(media.imageUrl, dataUrl);
    return dataUrl;
  } catch (err) {
    console.warn(`[thumbnail] Could not generate thumbnail for card ${media.id}:`, err);
    return null;
  } finally {
    pendingThumbnailIds.delete(media.id);
  }
}
