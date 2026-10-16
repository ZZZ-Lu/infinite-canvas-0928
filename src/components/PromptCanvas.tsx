import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MotionValue } from 'motion/react';
import { CANVAS_IDLE_MS } from '../utils/canvasPerformance';

const PLACEHOLDER = '输入文字指令，例如：清冷克制的女主，穿白衬衫...';

/** A persistent text surface. Its bitmap is independent of camera motion. */
export const PromptCanvas = React.memo(function PromptCanvas({
  text, height, mentionNames, scale, editing, scrollTop, onEdit, disabled, targetId,
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
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const linesRef = useRef<{ text: string; start: number }[]>([]);
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
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    canvas.width = Math.ceil(width * resolution);
    canvas.height = Math.ceil(height * resolution);
    ctx.scale(resolution, resolution);
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
    const lines: { text: string; start: number }[] = [];
    let line = '';
    let start = 0;
    let index = 0;
    for (const char of content) {
      if (char === '\n') {
        lines.push({ text: line, start });
        line = '';
        start = index + 1;
      } else {
        if (line && ctx.measureText(line + char).width > width) {
          lines.push({ text: line, start });
          start = index;
          line = '';
        }
        line += char;
      }
      index += char.length;
    }
    lines.push({ text: line, start });
    linesRef.current = lines;
    const visibleScroll = Math.max(0, Math.min(scrollTop, lines.length * 22 - height));
    visibleScrollRef.current = visibleScroll;
    const metrics = ctx.measureText('Hg');
    const ascent = metrics.fontBoundingBoxAscent ?? metrics.actualBoundingBoxAscent;
    const descent = metrics.fontBoundingBoxDescent ?? metrics.actualBoundingBoxDescent;
    const baseline = (22 - ascent - descent) / 2 + ascent;
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
          ctx.fillRect(x, y + 1, ctx.measureText(segment).width, 20);
        }
        ctx.fillStyle = !text ? (dark ? '#737373' : '#9ca3af') : highlighted ? (dark ? '#60a5fa' : '#2563eb') : style.color;
        ctx.fillText(segment, x, y + baseline);
      }
    });
  }, [text, height, width, resolution, mentionKey, scrollTop, themeEpoch]);

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
