export interface RecoveryPacer {
  idleFrames: number;
  observeFrame(ms: number): void;
  resumeAfterGesture(): void;
  observeJob(durationMs: number): void;
}

export function createRecoveryPacer(): RecoveryPacer {
  let adaptiveIdleFrames = 2;
  let recentFrameTime = 16.6;

  return {
    get idleFrames() {
      return adaptiveIdleFrames;
    },
    observeFrame(frameMs: number) {
      if (frameMs > 0 && frameMs < 500) {
        recentFrameTime = recentFrameTime * 0.8 + frameMs * 0.2;
        if (recentFrameTime > 32) {
          adaptiveIdleFrames = 4;
        } else if (recentFrameTime < 20) {
          adaptiveIdleFrames = 2;
        }
      }
    },
    resumeAfterGesture() {
      adaptiveIdleFrames = 2;
    },
    observeJob(durationMs: number) {
      if (durationMs > 12) {
        adaptiveIdleFrames = Math.min(8, adaptiveIdleFrames + 1);
      }
    }
  };
}
