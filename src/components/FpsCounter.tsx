import React, { useEffect, useRef } from 'react';

interface FpsCounterProps {
  hasActiveTask?: boolean;
}

/**
 * High-performance, zero-overhead real-time FPS Counter.
 * Updates DOM directly to avoid any React re-render or layout thrashing.
 */
export const FpsCounter: React.FC<FpsCounterProps> = ({ hasActiveTask = false }) => {
  const frameCountRef = useRef(0);
  const lastTimeRef = useRef(performance.now());
  const rafIdRef = useRef<number | null>(null);
  const dotRef = useRef<HTMLSpanElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    let active = true;

    const tick = () => {
      if (!active) return;
      frameCountRef.current++;
      
      const now = performance.now();
      const elapsed = now - lastTimeRef.current;
      
      if (elapsed >= 500) { // Recalculate every 500ms for readable visual stability
        const calculatedFps = Math.round((frameCountRef.current * 1000) / elapsed);
        frameCountRef.current = 0;
        lastTimeRef.current = now;

        if (textRef.current) {
          textRef.current.textContent = String(calculatedFps);
        }
        if (dotRef.current) {
          const colorClass = calculatedFps >= 58 ? 'bg-emerald-500 animate-pulse' :
            calculatedFps >= 45 ? 'bg-teal-500' :
            calculatedFps >= 30 ? 'bg-amber-500' :
            'bg-red-500';
          dotRef.current.className = `w-1.5 h-1.5 rounded-full ${colorClass}`;
        }
      }
      
      rafIdRef.current = requestAnimationFrame(tick);
    };

    rafIdRef.current = requestAnimationFrame(tick);

    return () => {
      active = false;
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  return (
    <div 
      id="fps-counter"
      onPointerDown={e => e.stopPropagation()}
      className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-1.5 px-3 h-[36px] bg-gray-100/90 dark:bg-neutral-800/90 backdrop-blur-md border border-gray-200/80 dark:border-[#404040]/80 shadow-md rounded-2xl corner-squircle text-[11px] font-bold font-mono select-none"
    >
      <span ref={dotRef} className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
      <span className="text-gray-400 dark:text-neutral-500">FPS:</span>
      <span ref={textRef} className="text-gray-700 dark:text-neutral-200">60</span>
    </div>
  );
};
