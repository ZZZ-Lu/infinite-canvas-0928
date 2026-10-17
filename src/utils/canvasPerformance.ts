import { createRecoveryPacer } from './canvasRecoveryPolicy';

// Shared idle interval for gesture effects and high-resolution image restoration.
export const CANVAS_IDLE_MS = 300;

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
  const moving = ['data-gesture', 'data-panning', 'data-zooming'].some(
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
    if (++framesSinceJob > pacer.idleFrames) {
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
