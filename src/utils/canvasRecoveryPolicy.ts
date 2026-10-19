/** Render pacing only; durations are milliseconds, independent of project data. */
export function createRecoveryPacer() {
  const intervals: number[] = [];
  let budget = 1000 / 120;
  let idleFrames = 1;
  let stableFrames = 0;
  const slowDown = (steps: number) => {
    idleFrames = Math.min(12, idleFrames + steps);
    stableFrames = 0;
  };
  return {
    get idleFrames() { return idleFrames; },
    get frameBudget() { return budget; },
    resumeAfterGesture() {
      // Recheck current load rather than carrying a long cooldown into each gesture.
      idleFrames = Math.min(idleFrames, 2);
      stableFrames = 0;
    },
    observeFrame(ms: number) {
      if (!Number.isFinite(ms) || ms <= 0) return;
      intervals.push(ms);
      if (intervals.length > 60) intervals.shift();
      // Learn the fastest observed cadence, not the average inflated by dropped frames.
      if (intervals.length >= 12) budget = Math.max(1000 / 240, Math.min(1000 / 60, Math.min(...intervals)));
      if (ms > Math.max(budget * 1.5, budget + 2) && (intervals.length >= 12 || ms > 20)) {
        slowDown(ms > budget * 3 ? 2 : 1);
      } else if (ms <= budget * 1.2 + .5) {
        // Recover gradually: brief fast bursts must not immediately undo throttling.
        if (++stableFrames >= 18) { idleFrames = Math.max(0, idleFrames - 1); stableFrames = 0; }
      } else {
        stableFrames = 0;
      }
    },
    observeJob(ms: number) {
      if (ms > budget * .5) slowDown(ms > budget ? 2 : 1);
    },
  };
}
