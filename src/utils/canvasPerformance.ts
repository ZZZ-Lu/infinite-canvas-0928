import { createRecoveryPacer } from './canvasRecoveryPolicy';

// Shared idle interval for gesture effects and high-resolution image restoration.
export const CANVAS_IDLE_MS = 300;

export type CanvasLoadingMode = 'immediate' | 'lazy';
const loadingModeKey = 'canvas_loading_mode';
export const CANVAS_LOADING_MODE_EVENT = 'canvas-loading-mode-change';
let loadingMode: CanvasLoadingMode = 'immediate';
try {
  if (localStorage.getItem(loadingModeKey) === 'lazy') loadingMode = 'lazy';
} catch { /* A disabled preference store must not prevent rendering. */ }
export function getCanvasLoadingMode() { return loadingMode; }
export function setCanvasLoadingMode(mode: CanvasLoadingMode) {
  loadingMode = mode;
  try { localStorage.setItem(loadingModeKey, mode); } catch { /* Session preference still applies. */ }
  window.dispatchEvent(new Event(CANVAS_LOADING_MODE_EVENT));
}
export function subscribeCanvasLoadingMode(listener: () => void) {
  window.addEventListener(CANVAS_LOADING_MODE_EVENT, listener);
  return () => window.removeEventListener(CANVAS_LOADING_MODE_EVENT, listener);
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key !== loadingModeKey && event.key !== null) return;
    loadingMode = event.newValue === 'lazy' ? 'lazy' : 'immediate';
    window.dispatchEvent(new Event(CANVAS_LOADING_MODE_EVENT));
  });
}

// Rendering policy only: camera pan and zoom may load proxies progressively.
export function canLoadDuringCameraGesture() {
  if (loadingMode === 'lazy' || typeof document === 'undefined') return false;
  const workspace = document.getElementById('canvas-workspace');
  return (workspace?.getAttribute('data-panning') === 'true' ||
    workspace?.getAttribute('data-zooming') === 'true') &&
    !(window as any).isDraggingCard && !(window as any).__nanoDragging;
}

// Mounting and drawing share this adaptive, render-only queue.
type SurfaceOptions = { priority?: 'prompt'; label?: string };
const surfaceJobs = new Map<symbol, { run: () => void; options: SurfaceOptions; queuedAt: number }>();
const surfaceTimings: { label: string; waitMs: number; runMs: number }[] = [];
// Bounded diagnostics, kept out of serializable project state.
export function getCanvasSurfaceTimings() { return surfaceTimings.map(timing => ({ ...timing })); }
const pacer = createRecoveryPacer();
let surfaceFrame: number | null = null;
let previousFrame: number | null = null;
let framesSinceJob = 0;
let wasMoving = false;
// A gesture can start while the queue is empty (no rAF pump to observe it).
if (typeof window !== 'undefined') {
  window.addEventListener('canvas-gesture-start', () => { wasMoving = true; });
}

function scheduleSurfaceFrame() {
  if (surfaceFrame === null && (surfaceJobs.size || previousFrame !== null)) surfaceFrame = requestAnimationFrame(pumpSurfaces);
}

function pumpSurfaces(frameTime: number) {
  surfaceFrame = null;
  if (!surfaceJobs.size) {
    // Observe one trailing frame, even if React has not enqueued its surfaces yet.
    if (previousFrame !== null) pacer.observeFrame(frameTime - previousFrame);
    previousFrame = null;
    framesSinceJob = 0;
    return;
  }
  const workspace = document.getElementById('canvas-workspace');
  const cameraMoving = canLoadDuringCameraGesture();
  const moving = !cameraMoving && ['data-gesture', 'data-panning', 'data-zooming'].some(
    name => workspace?.getAttribute(name) === 'true',
  );
  if (moving) {
    wasMoving = true;
    previousFrame = null;
    framesSinceJob = 0;
  } else {
    if (wasMoving) { pacer.resumeAfterGesture(); wasMoving = false; }
    // The next rAF interval includes deferred React commit/layout work, not just
    // the synchronous time spent admitting a card to the mount store.
    if (previousFrame !== null) pacer.observeFrame(frameTime - previousFrame);
    previousFrame = frameTime;
    if (++framesSinceJob > Math.max(cameraMoving ? 1 : 0, pacer.idleFrames)) {
      framesSinceJob = 0;
      // Finish already-mounted prompt surfaces before admitting another card.
      // Still execute just one job at the existing adaptive frame cadence.
      let next = surfaceJobs.entries().next().value!;
      for (const entry of surfaceJobs) {
        if (entry[1].options.priority === 'prompt') { next = entry; break; }
      }
      const [key, job] = next;
      surfaceJobs.delete(key);
      const start = performance.now();
      try { job.run(); } finally {
        const runMs = performance.now() - start;
        surfaceTimings.push({ label: job.options.label || 'surface', waitMs: start - job.queuedAt, runMs });
        if (surfaceTimings.length > 100) surfaceTimings.shift();
        pacer.observeJob(runMs);
        scheduleSurfaceFrame();
      }
      return;
    }
  }
  scheduleSurfaceFrame();
}

export function scheduleCanvasSurface(job: () => void, options: SurfaceOptions = {}): () => void {
  const key = Symbol();
  surfaceJobs.set(key, { run: job, options, queuedAt: performance.now() });
  scheduleSurfaceFrame();
  return () => {
    surfaceJobs.delete(key);
    if (!surfaceJobs.size) {
      if (surfaceFrame !== null) cancelAnimationFrame(surfaceFrame);
      surfaceFrame = null;
      previousFrame = null;
      framesSinceJob = 0;
    }
  };
}

// Original texture decoding is asynchronous. Keep it serial as well: pacing
// only the call that starts each request would still allow every visible card
// to decode and resize its canvas at the same time after a zoom gesture.
type OriginalRestoreJob = {
  id: string;
  priority: number;
  cancelled: boolean;
  cancelStart?: () => void;
  run: (isCancelled: () => boolean) => Promise<void>;
};
const originalRestoreJobs = new Map<string, OriginalRestoreJob>();
let activeOriginalRestore: OriginalRestoreJob | null = null;

function pumpOriginalRestores() {
  if (activeOriginalRestore || originalRestoreJobs.size === 0) return;
  const job = [...originalRestoreJobs.values()].sort((a, b) => a.priority - b.priority)[0];
  originalRestoreJobs.delete(job.id);
  activeOriginalRestore = job;
  job.cancelStart = scheduleCanvasSurface(() => {
    job.cancelStart = undefined;
    void (async () => {
      try {
        if (!job.cancelled) await job.run(() => job.cancelled);
      } catch (error) {
        console.warn('[canvas] Original image restore failed:', error);
      } finally {
        // Give the committed card a paint opportunity before starting the next.
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        if (activeOriginalRestore === job) activeOriginalRestore = null;
        pumpOriginalRestores();
      }
    })();
  }, { label: `original:${job.id}` });
}

export function scheduleOriginalImageRestore(
  id: string,
  priority: number,
  run: (isCancelled: () => boolean) => Promise<void>,
): () => void {
  originalRestoreJobs.get(id)?.cancelStart?.();
  const previous = originalRestoreJobs.get(id);
  if (previous) previous.cancelled = true;
  const job: OriginalRestoreJob = { id, priority, run, cancelled: false };
  originalRestoreJobs.set(id, job);
  pumpOriginalRestores();
  return () => {
    job.cancelled = true;
    if (originalRestoreJobs.get(id) === job) originalRestoreJobs.delete(id);
    if (job.cancelStart) {
      job.cancelStart();
      job.cancelStart = undefined;
      if (activeOriginalRestore === job) activeOriginalRestore = null;
      pumpOriginalRestores();
    }
  };
}
