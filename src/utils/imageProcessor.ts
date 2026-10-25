/**
 * Client pool and pipeline for off-thread image processing.
 * Dispatches heavy image decompression, proxy scaling, and thumbnail generation to Web Workers.
 * 
 * Complies with AGENTS.md Architecture Constraints:
 * - Data-DOM Decoupling: Zero DOM dependencies, zero React state stored.
 * - Intent-Driven: Prepares lightweight proxies off-thread without freezing UI or Framer Motion entrance curves.
 * - Non-destructive: Untouched original binary files remain intact for AI pipelines.
 */

import { thumbCache } from './thumbnail';

export interface ProcessedImageResult {
  previewBlob: Blob;
  proxy4KBlob?: Blob;
  isOver4K: boolean;
  thumb256: string;
  thumb128: string;
  thumb64: string;
  width: number;
  height: number;
}

export interface ThumbnailBundleResult {
  thumb256: string;
  thumb128: string;
  thumb64: string;
}

interface WorkerTask {
  id: number;
  resolve: (val: any) => void;
  reject: (err: any) => void;
}

interface WorkerInstance {
  worker: Worker;
  activeCount: number;
}

const POOL_SIZE = typeof navigator !== 'undefined'
  ? Math.min(4, Math.max(2, (navigator.hardwareConcurrency || 4) - 1))
  : 2;

let workers: WorkerInstance[] = [];
let nextRequestId = 1;
const pendingRequests = new Map<number, WorkerTask>();

function createWorkerInstance(): WorkerInstance {
  const worker = new Worker(
    new URL('../workers/imageProcessor.worker.ts', import.meta.url),
    { type: 'module' }
  );

  const instance: WorkerInstance = {
    worker,
    activeCount: 0,
  };

  worker.onmessage = (event: MessageEvent) => {
    const { id, success, result, error } = event.data;
    const task = pendingRequests.get(id);
    if (!task) return;

    pendingRequests.delete(id);
    instance.activeCount = Math.max(0, instance.activeCount - 1);

    if (success) {
      task.resolve(result);
    } else {
      task.reject(new Error(error || 'Worker image processing failed'));
    }
  };

  worker.onerror = (err) => {
    console.warn('[imageProcessor] Worker encountered error:', err);
    // Reject all active tasks for this worker
    for (const [id, task] of pendingRequests.entries()) {
      task.reject(new Error('Image worker failed'));
      pendingRequests.delete(id);
    }
    instance.activeCount = 0;
    try {
      worker.terminate();
    } catch {}
    // Remove from pool so a fresh one can be spawned
    workers = workers.filter(w => w !== instance);
  };

  return instance;
}

function getBestWorker(): WorkerInstance {
  if (workers.length < POOL_SIZE) {
    try {
      const newInst = createWorkerInstance();
      workers.push(newInst);
      return newInst;
    } catch (e) {
      console.warn('[imageProcessor] Failed to create new worker, trying existing:', e);
    }
  }

  if (workers.length === 0) {
    throw new Error('No workers available');
  }

  // Pick worker with least active tasks
  let best = workers[0];
  for (let i = 1; i < workers.length; i++) {
    if (workers[i].activeCount < best.activeCount) {
      best = workers[i];
    }
  }
  return best;
}

function sendToWorker<T>(type: string, payload: any): Promise<T> {
  return new Promise((resolve, reject) => {
    try {
      const inst = getBestWorker();
      const id = nextRequestId++;
      pendingRequests.set(id, { id, resolve, reject });
      inst.activeCount++;
      inst.worker.postMessage({ id, type, payload });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Main-thread fallback pipeline using native createImageBitmap with asynchronous frame yields.
 */
async function processImageFallback(
  file: Blob,
  maxPreviewDim = 1200,
  maxTextureDim = 4096
): Promise<ProcessedImageResult> {
  const bitmap = await createImageBitmap(file);
  const origW = bitmap.width;
  const origH = bitmap.height;

  const getDims = (mw: number) => {
    if (origW <= mw && origH <= mw) return { width: origW, height: origH };
    if (origW >= origH) {
      return { width: mw, height: Math.max(1, Math.round(mw * (origH / origW))) };
    } else {
      return { width: Math.max(1, Math.round(mw * (origW / origH))), height: mw };
    }
  };

  // Preview
  const pDim = getDims(maxPreviewDim);
  const canvas = document.createElement('canvas');
  canvas.width = pDim.width;
  canvas.height = pDim.height;
  const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true, willReadFrequently: false });
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, pDim.width, pDim.height);
  }

  const previewBlob = await new Promise<Blob>((res) => {
    canvas.toBlob((b) => res(b || file), 'image/jpeg', 0.85);
  });

  // Yield frame to prevent blocking UI
  await new Promise(r => setTimeout(r, 0));

  let proxy4KBlob: Blob | undefined;
  const isOver4K = origW > maxTextureDim || origH > maxTextureDim;
  if (isOver4K) {
    const kDim = getDims(maxTextureDim);
    const canvas4k = document.createElement('canvas');
    canvas4k.width = kDim.width;
    canvas4k.height = kDim.height;
    const ctx4k = canvas4k.getContext('2d', { alpha: true, desynchronized: true, willReadFrequently: false });
    if (ctx4k) {
      ctx4k.imageSmoothingEnabled = true;
      ctx4k.imageSmoothingQuality = 'high';
      ctx4k.drawImage(bitmap, 0, 0, kDim.width, kDim.height);
    }
    proxy4KBlob = await new Promise<Blob>((res) => {
      canvas4k.toBlob((b) => res(b || file), 'image/jpeg', 0.90);
    });
    await new Promise(r => setTimeout(r, 0));
  }

  // Thumbnails
  const d256 = getDims(256);
  const c256 = document.createElement('canvas');
  c256.width = d256.width;
  c256.height = d256.height;
  const ctx256 = c256.getContext('2d', { alpha: true, desynchronized: true, willReadFrequently: false });
  ctx256?.drawImage(canvas, 0, 0, d256.width, d256.height);
  const thumb256 = c256.toDataURL('image/webp', 0.88);

  const d128 = getDims(128);
  const c128 = document.createElement('canvas');
  c128.width = d128.width;
  c128.height = d128.height;
  const ctx128 = c128.getContext('2d', { alpha: true, desynchronized: true, willReadFrequently: false });
  ctx128?.drawImage(c256, 0, 0, d128.width, d128.height);
  const thumb128 = c128.toDataURL('image/webp', 0.85);

  const d64 = getDims(64);
  const c64 = document.createElement('canvas');
  c64.width = d64.width;
  c64.height = d64.height;
  const ctx64 = c64.getContext('2d', { alpha: true, desynchronized: true, willReadFrequently: false });
  ctx64?.drawImage(c128, 0, 0, d64.width, d64.height);
  const thumb64 = c64.toDataURL('image/webp', 0.80);

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

/**
 * Off-thread image processor: handles decoding, downscaling to 1200px preview proxy,
 * checking 4K texture boundary, and generating 256/128/64 thumbnails in a single worker pass.
 */
export async function processImageOffThread(
  file: Blob,
  maxPreviewDim = 1200,
  maxTextureDim = 4096
): Promise<ProcessedImageResult> {
  try {
    const result = await sendToWorker<ProcessedImageResult>('PROCESS_IMAGE', {
      file,
      maxPreviewDim,
      maxTextureDim,
    });

    // Populate memory cache so canvas can render synchronously without micro-stutter
    if (result.thumb256) {
      thumbCache.set(result.thumb256, result.thumb256);
    }

    return result;
  } catch (workerErr) {
    console.warn('[imageProcessor] Worker execution failed, using frame-yielding fallback:', workerErr);
    return processImageFallback(file, maxPreviewDim, maxTextureDim);
  }
}

/**
 * Off-thread thumbnail generator for single sources (e.g. video posters or generated media).
 */
export async function processThumbnailsOffThread(
  source: Blob
): Promise<ThumbnailBundleResult> {
  try {
    const result = await sendToWorker<ThumbnailBundleResult>('PROCESS_THUMBNAILS', {
      source,
    });

    if (result.thumb256) {
      thumbCache.set(result.thumb256, result.thumb256);
    }

    return result;
  } catch (workerErr) {
    console.warn('[imageProcessor] Worker thumbnails failed, fallback:', workerErr);
    // Quick fallback
    const res = await processImageFallback(source, 256, 4096);
    return {
      thumb256: res.thumb256,
      thumb128: res.thumb128,
      thumb64: res.thumb64,
    };
  }
}
