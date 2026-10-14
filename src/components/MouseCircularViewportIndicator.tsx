import React, { useEffect, useRef } from 'react';

/**
 * Mouse Circular Viewport Visual Indicator (蓝色圆形视口):
 * Renders a clean 60fps blue circle overlay centered on the mouse cursor.
 * Diameter is equal to screen height (window.innerHeight).
 * Direct DOM transform manipulation avoids React state re-render overhead.
 */
export const MouseCircularViewportIndicator: React.FC = React.memo(function MouseCircularViewportIndicator() {
  const circleRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let rafId: number | null = null;

    const updateCircle = (e: PointerEvent | MouseEvent) => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (!circleRef.current) return;

        const diameter = window.innerHeight;
        const radius = diameter / 2;
        const x = e.clientX - radius;
        const y = e.clientY - radius;

        circleRef.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        circleRef.current.style.width = `${diameter}px`;
        circleRef.current.style.height = `${diameter}px`;
      });
    };

    window.addEventListener('pointermove', updateCircle, { passive: true, capture: true });
    window.addEventListener('resize', () => {
      if ((window as any).__lastMousePos) {
        updateCircle((window as any).__lastMousePos);
      }
    });

    return () => {
      window.removeEventListener('pointermove', updateCircle, true);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  const initialDiameter = typeof window !== 'undefined' ? window.innerHeight : 800;
  const initialRadius = initialDiameter / 2;
  const initialPos = typeof window !== 'undefined' && (window as any).__lastMousePos
    ? { x: (window as any).__lastMousePos.x - initialRadius, y: (window as any).__lastMousePos.y - initialRadius }
    : { x: (typeof window !== 'undefined' ? window.innerWidth / 2 : 500) - initialRadius, y: (typeof window !== 'undefined' ? window.innerHeight / 2 : 400) - initialRadius };

  return (
    <div
      ref={circleRef}
      className="fixed top-0 left-0 pointer-events-none rounded-full border-2 border-blue-500/60 shadow-[0_0_20px_rgba(59,130,246,0.25)] z-[99] transition-opacity duration-300"
      style={{
        width: `${initialDiameter}px`,
        height: `${initialDiameter}px`,
        transform: `translate3d(${initialPos.x}px, ${initialPos.y}px, 0)`,
      }}
    />
  );
});
