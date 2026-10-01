import React from 'react';
import { Play, Pause } from 'lucide-react';

interface VideoControlOverlayProps {
  isPlaying: boolean;
  isHovered: boolean;
  progress: number;
  duration: number;
  savedTime: number;
  width: number;
  height: number;
  onTogglePlay: (targetState?: boolean) => void;
  onSeek: (targetTime: number) => void;
}

export const VideoControlOverlay: React.FC<VideoControlOverlayProps> = ({
  isPlaying,
  isHovered,
  progress,
  duration,
  savedTime,
  width,
  height,
  onTogglePlay,
  onSeek,
}) => {
  const formatTime = (seconds: number) => {
    if (isNaN(seconds) || seconds < 0) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  const narrowerSide = Math.min(width, height);
  const playButtonDiameter = narrowerSide / 2;
  const playButtonIconSize = playButtonDiameter * 0.76;

  const showControlBar = (isHovered || isPlaying) || savedTime > 0;

  return (
    <>
      {/* Center Play/Pause Button Overlay */}
      {!isPlaying ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/25 hover:bg-black/35 transition-colors pointer-events-none">
          <div
            className="rounded-full bg-white/40 dark:bg-black/50 border border-white/30 dark:border-white/10 shadow-xl flex items-center justify-center transform hover:scale-105 transition-transform cursor-pointer pointer-events-auto group-data-[scale-micro=true]/canvas:!scale-100"
            style={{
              width: playButtonDiameter,
              height: playButtonDiameter,
            }}
            onPointerDown={(e) => {
              if (e.button === 0) e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePlay(true);
            }}
          >
            <Play className="text-white/85" style={{ width: playButtonIconSize, height: playButtonIconSize }} />
          </div>
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div
            className="rounded-full bg-white/40 dark:bg-black/50 border border-white/30 dark:border-white/10 shadow-xl flex items-center justify-center transform hover:scale-105 transition-transform duration-200 opacity-0 hover:opacity-100 cursor-pointer pointer-events-auto"
            style={{
              width: playButtonDiameter,
              height: playButtonDiameter,
            }}
            onPointerDown={(e) => {
              if (e.button === 0) e.stopPropagation();
            }}
            onClick={(e) => {
              e.stopPropagation();
              onTogglePlay(false);
            }}
          >
            <Pause className="text-white/85" style={{ width: playButtonIconSize, height: playButtonIconSize }} />
          </div>
        </div>
      )}

      {/* Progress Bar Controller Overlay */}
      {showControlBar && (
        <div
          className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-4 pt-12 flex flex-col gap-2 transition-opacity duration-200 opacity-0 group-hover/video:opacity-100 group-data-[scale-micro=true]/canvas:hidden"
          onPointerDown={(e) => {
            if (e.button === 0) e.stopPropagation();
          }}
        >
          <div className="flex items-center gap-3">
            {/* Miniature Play/Pause Button */}
            <button
              type="button"
              className="text-white hover:text-blue-400 transition-colors cursor-pointer focus:outline-none flex-shrink-0"
              onClick={(e) => {
                e.stopPropagation();
                onTogglePlay();
              }}
            >
              {isPlaying ? (
                <Pause className="w-4.5 h-4.5 text-white" />
              ) : (
                <Play className="w-4.5 h-4.5 text-white" />
              )}
            </button>

            {/* Range Slider */}
            <input
              type="range"
              min="0"
              max="100"
              step="0.1"
              value={progress > 0 ? progress : (duration > 0 && savedTime > 0 ? (savedTime / duration) * 100 : 0)}
              onChange={(e) => {
                const pct = parseFloat(e.target.value);
                if (duration > 0) {
                  const targetTime = (pct / 100) * duration;
                  onSeek(targetTime);
                }
              }}
              className="w-full h-1 bg-transparent rounded-lg appearance-none cursor-pointer accent-blue-500 focus:outline-none [&::-webkit-slider-runnable-track]:bg-white/20 [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-lg [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-500 hover:[&::-webkit-slider-thumb]:scale-125 [&::-webkit-slider-thumb]:-translate-y-[4px]"
            />

            {/* Time Stamps */}
            <span className="text-[10px] font-mono text-white/90 select-none flex-shrink-0">
              {formatTime(duration > 0 && progress > 0 ? (progress / 100) * duration : savedTime)} / {formatTime(duration)}
            </span>
          </div>
        </div>
      )}
    </>
  );
};
