import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MotionValue } from 'motion/react';
import { ArrowUp, Box, ChevronDown, Layers, Plus, Sparkles } from 'lucide-react';
import { getOrLoadThumbImage } from '../utils/thumbnail';
import { CANVAS_IDLE_MS, scheduleCanvasSurface } from '../utils/canvasPerformance';
import { cacheSurfaceBitmap, getSurfaceBitmap, publishCardSurface } from '../utils/promptSurfaceCache';
import { referenceDisplayName } from '../utils/referenceName';

export interface PanelControl { key: string; label: string; targetId: string; onClick: () => void; }

// Use the same CSS and Lucide geometry as the interactive panel. The transparent
// semantic controls provide layout/hit testing; only their cached bitmap is visible.
export const PromptPanelCanvas = React.memo(function PromptPanelCanvas({
  height, references, controls, scale, generating, canGenerate, onGenerate,
  onReference, onMention, onRemove, onAdd, cardId, children, renderKey, onReady, surfaceRevision, suspended = false,
}: {
  height: number;
  references: { url: string; thumbnailUrl?: string; name?: string }[];
  controls: PanelControl[]; scale: MotionValue<number>; generating: boolean; canGenerate: boolean;
  onGenerate: () => void; onReference: (index: number) => void;
  onMention: (index: number) => void; onRemove: (index: number) => void;
  onAdd: () => void; cardId: string; children: React.ReactNode;
  renderKey?: string; onReady?: (key: string) => void;
  surfaceRevision?: string;
  suspended?: boolean;
}) {
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [epoch, setEpoch] = useState(0);
  const [hoveredReference, setHoveredReference] = useState<number | null>(null);
  const [dpr, setDpr] = useState(() => Math.min(3, Math.max(1, scale.get()) * (window.devicePixelRatio || 1)));
  const referenceKey = JSON.stringify(references.map(r => [r.thumbnailUrl || r.url, r.name]));
  const controlKey = JSON.stringify(controls.map(c => [c.key, c.label]));

  useEffect(() => {
    if (suspended) return;
    const observer = new MutationObserver(() => setEpoch(n => n + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    const sizeObserver = new ResizeObserver(() => setEpoch(n => n + 1));
    if (rootRef.current) sizeObserver.observe(rootRef.current);
    let active = true;
    document.fonts.ready.then(() => { if (active) setEpoch(n => n + 1); });
    let timer: ReturnType<typeof setTimeout>;
    const unsubscribe = scale.on('change', () => {
      clearTimeout(timer);
      timer = setTimeout(() => setDpr(Math.min(3, Math.max(1, scale.get()) * (window.devicePixelRatio || 1))), CANVAS_IDLE_MS);
    });
    return () => { active = false; observer.disconnect(); sizeObserver.disconnect(); unsubscribe(); clearTimeout(timer); };
  }, [scale, suspended]);

  useLayoutEffect(() => {
    if (suspended) return;
    const canvas = canvasRef.current, root = rootRef.current;
    const ctx = canvas?.getContext('2d', { alpha: true, desynchronized: true, willReadFrequently: false });
    if (!canvas || !ctx || !root) return;
    let cancelDraw: (() => void) | null = null;
    let active = true;
    const redraw = () => {
      if (!active || cancelDraw) return;
      cancelDraw = scheduleCanvasSurface(() => { cancelDraw = null; draw(); }, { priority: 'prompt', label: `prompt-panel:${cardId}` });
    };
    const draw = () => {
      const origin = root.getBoundingClientRect();
      const width = parseFloat(getComputedStyle(root).width);
      const localHeight = parseFloat(getComputedStyle(root).height);
      const zoom = origin.width / width;
      if (!zoom || !width || !localHeight) return;
      canvas.width = Math.ceil(width * dpr); canvas.height = Math.ceil(localHeight * dpr);
      ctx.scale(canvas.width / width, canvas.height / localHeight);
      const dark = document.documentElement.classList.contains('dark');
      const bitmapKey = JSON.stringify(['panel', width, localHeight, canvas.width, canvas.height, referenceKey, controlKey, dark, generating, canGenerate]);
      const bitmap = hoveredReference === null && getSurfaceBitmap(bitmapKey);
      if (bitmap) {
        ctx.drawImage(bitmap, 0, 0, width, localHeight);
        publishCardSurface(cardId, 'panel', surfaceRevision, bitmapKey);
        readyRef.current?.(renderKey || '');
        return;
      }
      let imagesComplete = true;
      const bounds = (e: Element) => {
        const r = e.getBoundingClientRect();
        return { x: (r.x - origin.x) / zoom, y: (r.y - origin.y) / zoom, w: r.width / zoom, h: r.height / zoom };
      };
      const text = (e: Element) => {
        const s = getComputedStyle(e), r = bounds(e);
        ctx.save(); ctx.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
        ctx.letterSpacing = s.letterSpacing === 'normal' ? '0px' : s.letterSpacing;
        ctx.fillStyle = s.color;
        let label = e.textContent || '';
        if (ctx.measureText(label).width > r.w + .5) {
          while (label && ctx.measureText(label + '…').width > r.w + .5) label = label.slice(0, -1);
          label += '…';
        }
        const m = ctx.measureText('Hg');
        const ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent;
        const descent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent;
        ctx.fillText(label, r.x, r.y + (r.h - ascent - descent) / 2 + ascent);
        ctx.restore();
      };
      const icon = (svg: SVGSVGElement) => {
        const r = bounds(svg), s = getComputedStyle(svg);
        ctx.save(); ctx.translate(r.x, r.y); ctx.scale(r.w / 24, r.h / 24);
        ctx.strokeStyle = s.color; ctx.lineWidth = parseFloat(s.strokeWidth) || 2;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.globalAlpha = parseFloat(s.opacity);
        for (const node of svg.children) {
          const a = (name: string) => Number(node.getAttribute(name));
          ctx.beginPath();
          if (node.tagName === 'path') { ctx.stroke(new Path2D(node.getAttribute('d') || '')); continue; }
          if (node.tagName === 'circle') ctx.arc(a('cx'), a('cy'), a('r'), 0, Math.PI * 2);
          if (node.tagName === 'line') { ctx.moveTo(a('x1'), a('y1')); ctx.lineTo(a('x2'), a('y2')); }
          if (node.tagName === 'polyline') {
            const points = (node.getAttribute('points') || '').trim().split(/[ ,]+/).map(Number);
            for (let i = 0; i < points.length; i += 2) i ? ctx.lineTo(points[i], points[i + 1]) : ctx.moveTo(points[i], points[i + 1]);
          }
          if (node.tagName === 'rect') ctx.roundRect(a('x'), a('y'), a('width'), a('height'), a('rx'));
          ctx.stroke();
        }
        ctx.restore();
      };
      // The outer panel already paints the background and its squircle border.
      references.forEach((reference, index) => {
        const x = 16 + index % 8 * 56, y = 16 + Math.floor(index / 8) * 56;
        ctx.fillStyle = dark ? 'rgba(38,38,38,.6)' : '#f9fafb';
        ctx.strokeStyle = dark ? 'rgba(64,64,64,.6)' : '#e5e7eb';
        ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(x + .5, y + .5, 47, 47, 8); ctx.fill(); ctx.stroke();
        const image = getOrLoadThumbImage(reference.thumbnailUrl || reference.url, redraw);
        if (!image) imagesComplete = false;
        if (image?.complete && image.naturalWidth) {
          ctx.save(); ctx.beginPath(); ctx.roundRect(x + 1, y + 1, 46, 46, 7); ctx.clip();
          const fit = Math.min(46 / image.naturalWidth, 46 / image.naturalHeight);
          const w = image.naturalWidth * fit, h = image.naturalHeight * fit;
          ctx.drawImage(image, x + 1 + (46 - w) / 2, y + 1 + (46 - h) / 2, w, h); ctx.restore();
        }
        const label = root.querySelector(`[data-ref-label="${index}"]`); if (label) text(label);
        if (hoveredReference === index) {
          ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(x + 45, y + 3, 7, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + 43, y + 3); ctx.lineTo(x + 47, y + 3); ctx.stroke();
        }
      });
      const addX = 16 + references.length % 8 * 56, addY = 16 + Math.floor(references.length / 8) * 56;
      ctx.strokeStyle = dark ? '#404040' : '#d1d5db'; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.roundRect(addX + 1, addY + 1, 46, 46, 8); ctx.stroke(); ctx.setLineDash([]);
      const footer = root.querySelector('[data-panel-footer]')!;
      const f = bounds(footer);
      ctx.strokeStyle = dark ? '#404040' : '#f3f4f6'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(f.x, f.y + .5); ctx.lineTo(f.x + f.w, f.y + .5); ctx.stroke();
      for (const el of root.querySelectorAll('[data-paint-bg]')) {
        const r = bounds(el), s = getComputedStyle(el);
        ctx.fillStyle = s.backgroundColor; ctx.beginPath(); ctx.roundRect(r.x, r.y, r.w, r.h, parseFloat(s.borderRadius) || 0); ctx.fill();
      }
      for (const el of root.querySelectorAll('[data-paint-ratio]')) {
        const r = bounds(el), s = getComputedStyle(el);
        ctx.save(); ctx.globalAlpha = .7; ctx.strokeStyle = s.color; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.roundRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2, 3); ctx.stroke(); ctx.restore();
      }
      root.querySelectorAll('[data-paint-text]').forEach(text);
      root.querySelectorAll<SVGSVGElement>('svg').forEach(icon);
      if (hoveredReference === null && imagesComplete) cacheSurfaceBitmap(bitmapKey, canvas);
      if (hoveredReference === null) publishCardSurface(cardId, 'panel', surfaceRevision, bitmapKey);
      readyRef.current?.(renderKey || '');
    };
    redraw();
    return () => { active = false; cancelDraw?.(); };
  }, [height, referenceKey, controlKey, dpr, epoch, hoveredReference, generating, canGenerate, renderKey, cardId, surfaceRevision, suspended]);

  return <div ref={rootRef} className="absolute inset-0" style={{ fontFamily: 'inherit' }}>
    <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 w-full h-full pointer-events-none" />
    {references.map((reference, index) => {
      const x = 16 + index % 8 * 56, y = 16 + Math.floor(index / 8) * 56;
      return <div key={`${index}:${reference.url}`} className="absolute w-12 h-12" style={{ left: x, top: y }} onMouseEnter={() => setHoveredReference(index)} onMouseLeave={() => setHoveredReference(null)} onFocus={() => setHoveredReference(index)}>
        <button type="button" aria-label={`查看参考图：${reference.name || index + 1}`} title={reference.name}
          className="absolute inset-0 opacity-0" onClick={() => onReference(index)} />
        <button type="button" aria-label={`@${reference.name || `图 ${index + 1}`}`} title="点击在提示词中引用"
          className="absolute top-[3px] left-[3px] right-[3px] px-0.5 text-left opacity-0" onClick={() => onMention(index)}>
          <span data-ref-label={index} className="text-[6.5px] font-bold text-[#3b82f6] dark:text-blue-400 block truncate leading-normal tracking-tight">@{referenceDisplayName(reference.name || `图 ${index + 1}`)}</span>
        </button>
        <button type="button" aria-label={`移除参考图：${reference.name || index + 1}`} title="移除参考图"
          className="absolute -top-1 -right-1 w-3.5 h-3.5 opacity-0" style={{ visibility: hoveredReference === index ? 'visible' : 'hidden' }} onClick={() => onRemove(index)} />
      </div>;
    })}
    <button type="button" aria-label="添加参考图" title="添加参考图" data-agent-target={`ref-btn-${cardId}`}
      className="absolute w-12 h-12 flex items-center justify-center text-gray-500 opacity-0"
      style={{ left: 16 + references.length % 8 * 56, top: 16 + Math.floor(references.length / 8) * 56 }} onClick={onAdd}><Plus className="w-4 h-4" /></button>
    {children}
    <div data-panel-footer style={{ top: height - 59 }} className="absolute left-4 right-4 flex items-center justify-between pt-2 border-t border-gray-100 dark:border-[#404040] opacity-0">
      <div className="flex items-center gap-3 text-gray-500 dark:text-neutral-400 text-[13px]">
        {controls.map(control => <React.Fragment key={control.key}>
          {control.key === 'res' && <div data-paint-bg className="w-[1px] h-3.5 bg-gray-300 dark:bg-neutral-700" />}
          <button type="button" data-paint-bg={control.key === 'mention' ? '' : undefined} aria-label={control.key === 'mention' ? '@ 引用' : control.label}
            title={control.label} data-agent-target={control.targetId} onClick={control.onClick}
            className={control.key === 'mention' ? 'flex items-center gap-1 text-[12px] font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/40 px-2 py-0.5 rounded-md' : `flex items-center gap-1.5 ${control.key === 'model' ? 'max-w-[150px]' : control.key === 'ratio' || control.key === 'res' ? '' : 'max-w-[120px]'}`}>
            {control.key === 'mention' ? <span data-paint-text className="font-bold text-[13px]">@</span> : control.key === 'model' ? <Sparkles className="w-3.5 h-3.5 opacity-70 shrink-0" /> : control.key === 'res' ? <Layers className="w-3.5 h-3.5 opacity-70" /> : control.key === 'ratio' ? <div data-paint-ratio className="w-3.5 h-3 border-2 border-current rounded-[3px] opacity-70" /> : <Box className="w-3.5 h-3.5 opacity-70 shrink-0" />}
            <span data-paint-text className={control.key === 'mention' ? 'text-[12px]' : 'font-semibold truncate'}>{control.label}</span>
            {control.key !== 'mention' && <ChevronDown className="w-3 h-3 opacity-50 shrink-0" />}
          </button>
        </React.Fragment>)}
      </div>
      <button type="button" data-paint-bg aria-label="生成" title="生成" data-agent-target={`generate-btn-${cardId}`} disabled={!canGenerate || generating}
        className="w-8 h-8 rounded-full bg-gray-900 dark:bg-neutral-100 text-white dark:text-neutral-900 flex items-center justify-center shrink-0" onClick={onGenerate}><ArrowUp className="w-4 h-4 stroke-[3]" /></button>
    </div>
  </div>;
});
