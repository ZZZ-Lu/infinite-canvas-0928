import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";

export interface ToastNotice {
  id: string;
  text: string;
  dotColor?: string;
  progress?: number;
}

export function showToastNotice(
  text: string,
  options?: { id?: string; dotColor?: string; duration?: number; progress?: number }
) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("mira-toast", {
        detail: { text, ...options },
      })
    );
  }
}

interface FpsCounterProps {
  hasActiveTask?: boolean;
  notices?: ToastNotice[];
}

/**
 * Ultra-smooth Dynamic Island HUD Capsule:
 * - Uses Quintic ease-out ([0.16, 1, 0.3, 1]) for instantaneous, butter-smooth physical width expansion.
 * - Persistent primary capsule container that morphs width/height in-place without layout pop glitches.
 * - Secondary capsules are stacked vertically ONLY when multiple notices exist simultaneously.
 */
export const FpsCounter: React.FC<FpsCounterProps> = ({ hasActiveTask = false, notices = [] }) => {
  const frameCountRef = useRef(0);
  const lastTimeRef = useRef(performance.now());
  const rafIdRef = useRef<number | null>(null);
  const dotRef = useRef<HTMLSpanElement | null>(null);
  const primaryContentRef = useRef<HTMLDivElement | null>(null);
  const [fps, setFps] = useState(60);
  const [primaryWidth, setPrimaryWidth] = useState<number | null>(null);

  const [eventToasts, setEventToasts] = useState<ToastNotice[]>([]);

  // Listen for global toast events
  useEffect(() => {
    const handleToastEvent = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail && detail.text) {
        const id = detail.id || `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const newNotice: ToastNotice = {
          id,
          text: detail.text,
          dotColor: detail.dotColor || "bg-blue-500",
          progress: detail.progress,
        };
        setEventToasts((prev) => [...prev.filter((t) => t.id !== id), newNotice]);

        if (detail.duration !== 0) {
          setTimeout(() => {
            setEventToasts((prev) => prev.filter((t) => t.id !== id));
          }, detail.duration || 3000);
        }
      }
    };

    window.addEventListener("mira-toast", handleToastEvent);
    return () => {
      window.removeEventListener("mira-toast", handleToastEvent);
    };
  }, []);

  // Continuous background FPS calculation
  useEffect(() => {
    let active = true;
    const tick = () => {
      if (!active) return;
      frameCountRef.current++;

      const now = performance.now();
      const elapsed = now - lastTimeRef.current;

      if (elapsed >= 500) {
        const calculatedFps = Math.round((frameCountRef.current * 1000) / elapsed);
        frameCountRef.current = 0;
        lastTimeRef.current = now;
        setFps(calculatedFps);
        if (dotRef.current) {
          const colorClass =
            calculatedFps >= 58
              ? "bg-emerald-500 animate-pulse"
              : calculatedFps >= 45
              ? "bg-teal-500"
              : calculatedFps >= 30
              ? "bg-amber-500"
              : "bg-red-500";
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

  // Combine prop notices and event toasts (deduplicated by ID)
  const activeNotices = [...notices];
  eventToasts.forEach((et) => {
    if (!activeNotices.some((n) => n.id === et.id)) {
      activeNotices.push(et);
    }
  });

  const primaryNotice = activeNotices.length > 0 ? activeNotices[0] : null;
  const secondaryNotices = activeNotices.length > 1 ? activeNotices.slice(1) : [];
  // Measure the newly rendered content before paint, then animate a numeric
  // width instead of letting simultaneous entering/exiting content affect layout.
  useLayoutEffect(() => {
    const content = primaryContentRef.current;
    if (!content) return;
    const contentWidth = content.getBoundingClientRect().width;
    if (contentWidth > 0) setPrimaryWidth(Math.ceil(contentWidth + 30));
  }, [primaryNotice?.id, primaryNotice?.text, fps]);

  return (
    <div
      id="fps-counter-wrapper"
      onPointerDown={(e) => e.stopPropagation()}
      className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col items-center gap-1.5 select-none pointer-events-none"
    >
      {/* PERSISTENT MORPHING PRIMARY CAPSULE SHELL */}
      <motion.div
        style={{ width: primaryWidth ?? undefined }}
        className="relative overflow-hidden flex items-center justify-center px-3.5 h-[36px] bg-gray-100/90 dark:bg-neutral-800/90 backdrop-blur-md border border-gray-200/80 dark:border-[#404040]/80 shadow-md rounded-2xl corner-squircle text-[11px] font-bold select-none pointer-events-auto transition-[width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] will-change-[width] whitespace-nowrap"
      >
        {primaryNotice ? (
            <motion.div
              key={`notice-${primaryNotice.id}`}
              ref={primaryContentRef}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="flex items-center gap-2"
            >
              {/* Optional Progress Background Bar */}
              {typeof primaryNotice.progress === "number" && primaryNotice.progress > 0 && (
                <div
                  className="absolute inset-y-0 left-0 bg-blue-500/20 dark:bg-blue-400/25 border-r border-blue-500/50 dark:border-blue-400/50 transition-[width] duration-150 ease-out pointer-events-none"
                  style={{ width: `${Math.min(100, Math.max(0, primaryNotice.progress * 100))}%` }}
                />
              )}

              {/* Notice Indicator Dot */}
              <span
                className={`w-1.5 h-1.5 rounded-full shrink-0 relative z-10 ${
                  primaryNotice.dotColor || "bg-blue-500 animate-pulse"
                }`}
              />

              {/* Notice Text */}
              <span className="relative z-10 tracking-wide font-medium font-sans text-gray-800 dark:text-neutral-100">
                {primaryNotice.text}
              </span>
            </motion.div>
          ) : (
            <motion.div
              key="fps-content"
              ref={primaryContentRef}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
              className="flex items-center gap-1.5 font-mono"
            >
              <span ref={dotRef} className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
              <span className="text-gray-400 dark:text-neutral-500">FPS:</span>
              <span className="text-gray-700 dark:text-neutral-200 tabular-nums">
                {fps}
              </span>
            </motion.div>
          )}
      </motion.div>

      {/* Secondary notifications stack below primary capsule ONLY if multiple exist simultaneously */}
      <AnimatePresence>
        {secondaryNotices.map((notice) => (
          <motion.div
            key={notice.id}
            layout
            initial={{ opacity: 0, y: -8, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.95 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="relative overflow-hidden flex items-center justify-center gap-2 px-3.5 h-[36px] bg-gray-100/90 dark:bg-neutral-800/90 backdrop-blur-md border border-gray-200/80 dark:border-[#404040]/80 shadow-md rounded-2xl corner-squircle text-[11px] font-bold font-sans text-gray-800 dark:text-neutral-100 whitespace-nowrap pointer-events-auto"
          >
            {typeof notice.progress === "number" && notice.progress > 0 && (
              <div
                className="absolute inset-y-0 left-0 bg-blue-500/20 dark:bg-blue-400/25 border-r border-blue-500/50 dark:border-blue-400/50 transition-[width] duration-150 ease-out pointer-events-none"
                style={{ width: `${Math.min(100, Math.max(0, notice.progress * 100))}%` }}
              />
            )}
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 relative z-10 ${
                notice.dotColor || "bg-blue-500 animate-pulse"
              }`}
            />
            <span className="relative z-10 tracking-wide font-medium">{notice.text}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
};
