type VideoState = {
  cardId: string;
  element: HTMLVideoElement;
  wasPlayingBeforeGesture: boolean;
};

class VideoRegistryService {
  private activeVideos = new Map<string, VideoState>();

  register(cardId: string, element: HTMLVideoElement) {
    this.activeVideos.set(cardId, {
      cardId,
      element,
      wasPlayingBeforeGesture: false
    });
  }

  unregister(cardId: string) {
    this.activeVideos.delete(cardId);
  }

  /**
   * Pause all active playing videos during canvas dragging/zooming/panning to release GPU compositor layers
   */
  pauseAllForGesture() {
    this.activeVideos.forEach((state) => {
      if (state.element && !state.element.paused) {
        state.wasPlayingBeforeGesture = true;
        try {
          state.element.pause();
        } catch {}
      }
    });
  }

  /**
   * Resume videos that were playing before canvas gesture started
   */
  resumeAllAfterGesture() {
    this.activeVideos.forEach((state) => {
      if (state.wasPlayingBeforeGesture && state.element) {
        state.wasPlayingBeforeGesture = false;
        try {
          state.element.play().catch(() => {});
        } catch {}
      }
    });
  }
}

export const videoRegistry = new VideoRegistryService();
