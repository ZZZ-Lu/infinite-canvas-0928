import React, { useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import { AlertCircle } from 'lucide-react';
import { useVideoPlayer } from '../../hooks/useVideoPlayer';
import { VideoControlOverlay } from './VideoControlOverlay';

interface VideoCardPlayerProps {
  cardId: string;
  src: string;
  thumbnailUrl?: string;
  localThumbnailUrl?: string;
  isHovered: boolean;
  width: number;
  height: number;
  dpr?: number;
  onTimeUpdate?: (time: number) => void;
  onThumbnailCaptured?: (thumb: string) => void;
  onRefreshVideoUrl?: (force?: boolean) => void;
}

export const generateThumbnailFromVideo = (video: HTMLVideoElement): string | undefined => {
  try {
    if (!video.videoWidth || !video.videoHeight) return undefined;
    const canvas = document.createElement('canvas');
    const width = 256;
    const aspect = video.videoHeight / video.videoWidth;
    if (!aspect || !isFinite(aspect)) return undefined;
    canvas.width = width;
    canvas.height = width * aspect;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.6);
    }
  } catch (e) {
    // Ignore Cross-Origin canvas taint
  }
  return undefined;
};

export const VideoCardPlayer: React.FC<VideoCardPlayerProps> = ({
  cardId,
  src,
  thumbnailUrl,
  localThumbnailUrl,
  isHovered,
  width,
  height,
  dpr = 1,
  onTimeUpdate,
  onThumbnailCaptured,
  onRefreshVideoUrl
}) => {
  const [videoHasError, setVideoHasError] = useState(false);
  const [videoLoadError, setVideoLoadError] = useState('');

  const {
    videoRef,
    isPlaying,
    duration,
    setDuration,
    progress,
    setProgress,
    effectiveSrc,
    togglePlay,
    saveProgress,
    getSavedTime
  } = useVideoPlayer({
    cardId,
    rawSrc: src,
    onTimeUpdate
  });

  const savedTime = getSavedTime();
  const shouldMountVideo = (isHovered || isPlaying) || (!thumbnailUrl && !localThumbnailUrl);

  const handleSeek = useCallback((targetTime: number) => {
    if (videoRef.current) {
      videoRef.current.currentTime = targetTime;
      saveProgress(targetTime);
      if (duration > 0) {
        setProgress((targetTime / duration) * 100);
      }
    }
  }, [duration, saveProgress, setProgress]);

  const captureThumbnailIfMissing = useCallback((video: HTMLVideoElement) => {
    if (!thumbnailUrl && !localThumbnailUrl) {
      const thumb = generateThumbnailFromVideo(video);
      if (thumb) {
        onThumbnailCaptured?.(thumb);
      }
    }
  }, [thumbnailUrl, localThumbnailUrl, onThumbnailCaptured]);

  const displayThumb = thumbnailUrl || localThumbnailUrl;

  return (
    <div
      className="absolute inset-0 overflow-hidden squircle pointer-events-auto"
      style={{
        width: width * dpr,
        height: height * dpr,
        transform: dpr > 1 ? `scale(${1 / dpr})` : undefined,
        transformOrigin: 'top left',
        backgroundImage: displayThumb ? `url(${displayThumb})` : undefined,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      }}
    >
      <div className="absolute inset-0 w-full h-full overflow-hidden squircle group/video pointer-events-auto">
        {shouldMountVideo && effectiveSrc && effectiveSrc.trim() !== '' && !videoHasError && (
          <motion.video
            ref={videoRef}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            {...({ referrerPolicy: 'no-referrer' } as any)}
            src={effectiveSrc}
            loop
            playsInline
            muted={!isPlaying}
            preload="auto"
            autoPlay={isPlaying}
            className="absolute inset-0 w-full h-full object-cover pointer-events-none transition-opacity duration-500 group-data-[zooming=true]/canvas:!transition-none group-data-[zooming=true]/canvas:!duration-0 group-data-[zooming=true]/canvas:will-change-transform"
            onLoadedData={(e) => {
              const video = e.currentTarget;
              if (video.duration) setDuration(video.duration);
              captureThumbnailIfMissing(video);
            }}
            onLoadedMetadata={(e) => {
              const video = e.currentTarget;
              if (video.duration) setDuration(video.duration);
              captureThumbnailIfMissing(video);
            }}
            onTimeUpdate={(e) => {
              const video = e.currentTarget;
              const time = video.currentTime;
              saveProgress(time);
              if (video.duration) {
                setDuration(video.duration);
                setProgress((time / video.duration) * 100);
              }
            }}
            onPause={(e) => {
              saveProgress(e.currentTarget.currentTime);
            }}
            onSeeked={(e) => {
              if (e.currentTarget.paused) {
                saveProgress(e.currentTarget.currentTime);
              }
            }}
            onError={() => {
              setVideoHasError(true);
              setVideoLoadError('视频流读取失败');
              onRefreshVideoUrl?.(true);
            }}
          />
        )}

        {/* Video Load Error Overlay */}
        {videoHasError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 p-4 text-center select-none pointer-events-auto z-[20]">
            <AlertCircle className="w-8 h-8 text-amber-500 mb-2 animate-bounce" />
            <span className="text-white text-xs font-semibold mb-1">视频加载异常</span>
            {videoLoadError && (
              <p className="text-white/70 text-[10px] mb-2 max-w-[200px] break-words line-clamp-2" role="alert">
                {videoLoadError}
              </p>
            )}
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setVideoHasError(false);
                setVideoLoadError('');
                onRefreshVideoUrl?.(true);
                togglePlay(true);
              }}
              className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-[10px] font-bold shadow-md transition-colors active:scale-95 cursor-pointer"
            >
              重新获取视频地址
            </button>
          </div>
        )}

        {/* Video Controls Overlay */}
        {!videoHasError && (
          <VideoControlOverlay
            isPlaying={isPlaying}
            isHovered={isHovered}
            progress={progress}
            duration={duration}
            savedTime={savedTime}
            width={width}
            height={height}
            onTogglePlay={togglePlay}
            onSeek={handleSeek}
          />
        )}
      </div>
    </div>
  );
};
