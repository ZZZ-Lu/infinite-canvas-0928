import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { videoRegistry } from '../services/videoRegistry';

interface UseVideoPlayerOptions {
  cardId: string;
  rawSrc: string | null;
  initialTime?: number;
  onTimeUpdate?: (time: number) => void;
}

export function useVideoPlayer({ cardId, rawSrc, initialTime = 0, onTimeUpdate }: UseVideoPlayerOptions) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [progress, setProgress] = useState(0);
  const lastSavedTimeRef = useRef<number>(0);

  // Retrieve stored playback progress from localStorage or card props
  const getSavedTime = useCallback((): number => {
    if (typeof window === 'undefined') return initialTime || 0;
    try {
      const local = localStorage.getItem(`mira_vid_pos_${cardId}`);
      if (local !== null) {
        const val = parseFloat(local);
        if (!isNaN(val) && val > 0) return val;
      }
    } catch {}
    return initialTime || 0;
  }, [cardId, initialTime]);

  // Construct W3C Media Fragment URL (#t=12.50) so browser decodes at exact target frame natively
  const effectiveSrc = useMemo(() => {
    if (!rawSrc) return '';
    const pos = getSavedTime();
    if (pos > 0.1 && !rawSrc.includes('#t=')) {
      return `${rawSrc}#t=${pos.toFixed(2)}`;
    }
    return rawSrc;
  }, [rawSrc, getSavedTime]);

  // Save progress safely with 0s uninitialized state overwrite protection
  const saveProgress = useCallback((currentTime: number) => {
    const prevPos = getSavedTime();
    // CRITICAL: Protect existing valid progress from being wiped out by uninitialized 0s mount events
    if (currentTime <= 0.1 && prevPos > 0.5) {
      return;
    }
    if (currentTime > 0.1) {
      try {
        localStorage.setItem(`mira_vid_pos_${cardId}`, currentTime.toFixed(2));
      } catch {}
      if (Math.abs(currentTime - lastSavedTimeRef.current) >= 1.0) {
        lastSavedTimeRef.current = currentTime;
        onTimeUpdate?.(currentTime);
      }
    }
  }, [cardId, getSavedTime, onTimeUpdate]);

  // Direct user-gesture triggered play/pause
  const togglePlay = useCallback((targetState?: boolean) => {
    const nextState = targetState ?? !isPlaying;
    setIsPlaying(nextState);

    const video = videoRef.current;
    if (!video) return;

    if (nextState) {
      video.muted = false;
      const playPromise = video.play();
      if (playPromise !== undefined) {
        playPromise.catch((err: any) => {
          if (err?.name === 'NotAllowedError') {
            video.muted = true;
            video.play().catch(() => {});
          }
        });
      }
    } else {
      video.pause();
    }
  }, [isPlaying]);

  // Register video element with videoRegistry
  useEffect(() => {
    const video = videoRef.current;
    if (video) {
      videoRegistry.register(cardId, video);
    }
    return () => {
      videoRegistry.unregister(cardId);
    };
  }, [cardId, videoRef.current]);

  return {
    videoRef,
    isPlaying,
    setIsPlaying,
    duration,
    setDuration,
    progress,
    setProgress,
    effectiveSrc,
    togglePlay,
    saveProgress,
    getSavedTime
  };
}
