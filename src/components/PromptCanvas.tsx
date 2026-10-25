import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MotionValue } from 'motion/react';
import { CANVAS_IDLE_MS, scheduleCanvasSurface } from '../utils/canvasPerformance';

import { layoutPromptText } from '../utils/promptTextLayout';
import { cacheSurfaceBitmap, getSurfaceBitmap, publishCardSurface } from '../utils/promptSurfaceCache';

const PLACEHOLDER = '输入文字指令，例如：清冷克制的女主，穿白衬衫...';

/** A persistent text surface. Its bitmap is independent of camera motion. */
export const PromptCanvas = React.memo(function PromptCanvas({
  text, height, mentionNames, scale, editing, scrollTop, onEdit, disabled, targetId, renderKey, onReady, cardId, surfaceRevision, suspended = false,
}: {
  text: string;
  height: number;
  mentionNames: string[];
  scale: MotionValue<number>;
  editing: boolean;
  scrollTop: number;
  onEdit: (cursor: number) => void;
  disabled: boolean;
  targetId: string;
  renderKey?: string;
  onReady?: (key: string) => void;
  cardId?: string;
  surfaceRevision?: string;
  suspended?: boolean;
}) {
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const linesRef = useRef<{ text: string; start: number }[]>([]);
  const layoutRef = useRef<{ key: string; value: ReturnType<typeof layoutPromptText> } | null>(null);
  const visibleScrollRef = useRef(0);
  const [width, setWidth] = useState(446);
  const [resolution, setResolution] = useState(() => Math.min(3, Math.max(1, scale.get()) * (window.devicePixelRatio || 1)));
  const [themeEpoch, setThemeEpoch] = useState(0);
  const mentionKey = JSON.stringify([...new Set(mentionNames.filter(Boolean))].sort((a, b) => b.length - a.length));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(entries => {
      const nextWidth = entries[0]?.contentRect.width;
      if (nextWidth) setWidth(nextWidth);
    });
    observer.observe(canvas);
    const themeObserver = new MutationObserver(() => setThemeEpoch(n => n + 1));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => { observer.disconnect(); themeObserver.disconnect(); };
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let active = true;
    const update = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setResolution(Math.min(3, Math.max(1, scale.get()) * (window.devicePixelRatio || 1))), CANVAS_IDLE_MS);
    };
    const unsubscribe = scale.on('change', update);
    document.fonts.ready.then(() => { if (active) setThemeEpoch(n => n + 1); });
    return () => { active = false; clearTimeout(timer); unsubscribe(); };
  }, [scale]);

  useLayoutEffect(() => {
    if (suspended) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d', { alpha: true, desynchronized: true, willReadFrequently: false });
    if (!canvas || !ctx) return;
    return scheduleCanvasSurface(() => {
    canvas.width = Math.ceil(width * resolution);
    canvas.height = Math.ceil(height * resolution);
    ctx.scale(canvas.width / width, canvas.height / height);
    const style = getComputedStyle(canvas);
    ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    ctx.textBaseline = 'alphabetic';
    const dark = document.documentElement.classList.contains('dark');
    const content = text || PLACEHOLDER;
    const names: string[] = JSON.parse(mentionKey);
    const ranges: { start: number; end: number }[] = [];
    if (text && names.length) {
      const pattern = new RegExp(`@(?:${names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
      for (const match of text.matchAll(pattern)) ranges.push({ start: match.index!, end: match.index! + match[0].length });
    }
    const layoutKey = JSON.stringify([content, width, style.fontFamily, style.fontWeight, style.fontSize, style.letterSpacing, mentionKey]);
    if (layoutRef.current?.key !== layoutKey) {
      layoutRef.current = { key: layoutKey, value: layoutPromptText(content, width, style, names) };
    }
    const { lines, baseline } = layoutRef.current.value;
    linesRef.current = lines;
    const visibleScroll = Math.max(0, Math.min(scrollTop, lines.length * 22 - height));
    visibleScrollRef.current = visibleScroll;
    const bitmapKey = JSON.stringify(['text', layoutKey, width, height, canvas.width, canvas.height, mentionKey, visibleScroll, style.color, dark]);
    const bitmap = getSurfaceBitmap(bitmapKey);
    if (bitmap) {
      ctx.drawImage(bitmap, 0, 0, width, height);
      publishCardSurface(cardId, 'text', surfaceRevision, bitmapKey);
      readyRef.current?.(renderKey || '');
      return;
    }
    lines.forEach((row, rowIndex) => {
      const y = rowIndex * 22 - visibleScroll;
      if (y + 22 <= 0 || y >= height) return;
      const rowEnd = row.start + row.text.length;
      const cuts = new Set([row.start, rowEnd]);
      for (const range of ranges) {
        if (range.end > row.start && range.start < rowEnd) {
          cuts.add(Math.max(row.start, range.start));
          cuts.add(Math.min(rowEnd, range.end));
        }
      }
      const points = [...cuts].sort((a, b) => a - b);
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1];
        const highlighted = ranges.some(range => a >= range.start && a < range.end);
        const x = ctx.measureText(row.text.slice(0, a - row.start)).width;
        const segment = row.text.slice(a - row.start, b - row.start);
        if (highlighted) {
          ctx.fillStyle = dark ? 'rgba(96,165,250,.20)' : 'rgba(59,130,246,.15)';
          ctx.beginPath();
          ctx.roundRect(x, y + 1, ctx.measureText(segment).width, 20, 2);
          ctx.fill();
        }
        ctx.fillStyle = !text ? (dark ? '#737373' : '#9ca3af') : highlighted ? (dark ? '#60a5fa' : '#2563eb') : style.color;
        ctx.fillText(segment, x, y + baseline);
      }
    });
    cacheSurfaceBitmap(bitmapKey, canvas);
    publishCardSurface(cardId, 'text', surfaceRevision, bitmapKey);
    readyRef.current?.(renderKey || '');
    }, { priority: 'prompt', label: `prompt-text:${targetId}` });
  }, [text, height, width, resolution, mentionKey, scrollTop, themeEpoch, renderKey, cardId, surfaceRevision, suspended]);

  return <canvas ref={canvasRef}
    data-agent-target={editing ? undefined : targetId}
    role="button" tabIndex={editing || disabled ? -1 : 0} aria-disabled={disabled}
    aria-label={text ? `编辑提示词：${text}` : PLACEHOLDER}
    className={`prompt-canvas absolute inset-0 w-full text-gray-800 dark:text-neutral-100 text-[14px] leading-[22px] font-medium ${editing ? 'invisible' : 'cursor-text'}`}
    style={{ height, fontFamily: 'inherit' }}
    onPointerDown={event => { if (event.button === 0) event.stopPropagation(); }}
    onClick={event => {
      if (disabled) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const row = linesRef.current[Math.floor(((event.clientY - rect.top) * height / rect.height + visibleScrollRef.current) / 22)];
      const ctx = event.currentTarget.getContext('2d');
      if (!text || !row || !ctx) { onEdit(text.length); return; }
      const x = (event.clientX - rect.left) * width / rect.width;
      let cursor = 0;
      for (const char of row.text) {
        const next = cursor + char.length;
        if ((ctx.measureText(row.text.slice(0, cursor)).width + ctx.measureText(row.text.slice(0, next)).width) / 2 > x) break;
        cursor = next;
      }
      onEdit(row.start + cursor);
    }}
    onKeyDown={event => { if (!disabled && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); event.stopPropagation(); onEdit(text.length); } }}
    />;
});
