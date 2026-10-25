let worker: Worker | null = null;
let requestId = 0;
const pending = new Map<number, { resolve: (blob: Blob) => void; reject: (error: Error) => void }>();

function getWorker(): Worker {
  if (typeof Worker === 'undefined') throw new Error('Web Workers are unavailable');
  if (worker) return worker;

  const instance = new Worker(new URL('./imageResize.worker.ts', import.meta.url), { type: 'module' });
  instance.onmessage = ({ data }: MessageEvent<{ id: number; blob?: Blob; error?: string }>) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error || !data.blob) request.reject(new Error(data.error || 'Image resize returned no data'));
    else request.resolve(data.blob);
  };
  const failWorker = () => {
    const error = new Error('Background image processing failed');
    pending.forEach(request => request.reject(error));
    pending.clear();
    instance.terminate();
    if (worker === instance) worker = null;
  };
  instance.onerror = failWorker;
  instance.onmessageerror = failWorker;
  worker = instance;
  return instance;
}

/** Resize an image away from the UI thread when browser worker APIs are available. */
export function resizeImageOffThread(file: Blob, maxDim: number, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    try {
      pending.set(id, { resolve, reject });
      getWorker().postMessage({ id, file, maxDim, quality });
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
