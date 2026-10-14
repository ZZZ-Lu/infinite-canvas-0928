import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MotionValue } from 'motion/react';
import { getOrLoadThumbImage } from '../utils/thumbnail';
import { CANVAS_IDLE_MS } from '../utils/canvasPerformance';

export interface PanelControl {
  key: string;
  label: string;
  targetId: string;
  onClick: () => void;
}

/** Cached panel decoration plus semantic hit targets; menus remain native overlays. */
export const PromptPanelCanvas = React.memo(function PromptPanelCanvas({
  height, references, controls, scale, generating, canGenerate, onGenerate,
  onReference, onMention, onRemove, onAdd, cardId, children,
}: {
  height: number;
  references: { url: string; thumbnailUrl?: string; name?: string }[];
  controls: PanelControl[];
  scale: MotionValue<number>;
  generating: boolean;
  canGenerate: boolean;
  onGenerate: () => void;
  onReference: (index: number) => void;
  onMention: (index: number) => void;
  onRemove: (index: number) => void;
  onAdd: () => void;
  cardId: string;
  children: React.ReactNode;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [epoch, setEpoch] = useState(0);
  const [hoveredReference, setHoveredReference] = useState<number | null>(null);
  const [dpr, setDpr] = useState(() => Math.min(3, Math.max(1, scale.get()) * (window.devicePixelRatio || 1)));
  const referenceKey = JSON.stringify(references.map(r => [r.thumbnailUrl || r.url, r.name]));
  const controlKey = JSON.stringify(controls.map(c => [c.key, c.label]));
  const naturalWidths = controls.map(c => c.key === 'mention' ? 56 : c.key === 'model' ? 140 : Math.max(48, Math.min(85, c.label.length * 8 + 28)));
  const available = 394 - Math.max(0, controls.length - 1) * 12;
  const ratio = Math.min(1, available / naturalWidths.reduce((a, b) => a + b, 0));
  let controlX = 17;
  const controlBounds = controls.map((control, index) => {
    const width = naturalWidths[index] * ratio;
    const bound = { ...control, x: controlX, width };
    controlX += width + 12;
    return bound;
  });
  const footerY = height - 49;

  useEffect(() => {
    const observer = new MutationObserver(() => setEpoch(n => n + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    let timer: ReturnType<typeof setTimeout>;
    const unsubscribe = scale.on('change', () => {
      clearTimeout(timer);
      timer = setTimeout(() => setDpr(Math.min(3, Math.max(1, scale.get()) * (window.devicePixelRatio || 1))), CANVAS_IDLE_MS);
    });
    return () => { observer.disconnect(); unsubscribe(); clearTimeout(timer); };
  }, [scale]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let frame: number | null = null;
    let active = true;
    const redraw = () => {
      if (!active || frame !== null) return;
      frame = requestAnimationFrame(() => { frame = null; draw(); });
    };
    const draw = () => {
      canvas.width = Math.ceil(478 * dpr);
      canvas.height = Math.ceil((height - 2) * dpr);
      ctx.scale(dpr, dpr);
      const dark = document.documentElement.classList.contains('dark');
      const muted = dark ? '#a3a3a3' : '#6b7280';
      const border = dark ? '#404040' : '#e5e7eb';
      const fontFamily = getComputedStyle(canvas).fontFamily;
      ctx.fillStyle = dark ? '#262626' : '#f3f4f6';
      ctx.beginPath(); ctx.roundRect(0, 0, 478, height - 2, 19); ctx.fill();
      ctx.font = `500 6.5px ${fontFamily}`;
      const ellipsis = (text: string, width: number) => {
        if (ctx.measureText(text).width <= width) return text;
        let result = text;
        while (result && ctx.measureText(result + '…').width > width) result = result.slice(0, -1);
        return result + '…';
      };
      references.forEach((reference, index) => {
        const x = 16 + index % 8 * 56, y = 16 + Math.floor(index / 8) * 56;
        ctx.fillStyle = dark ? '#292929' : '#f9fafb';
        ctx.strokeStyle = border;
        ctx.beginPath(); ctx.roundRect(x, y, 48, 48, 7); ctx.fill(); ctx.stroke();
        const image = getOrLoadThumbImage(reference.thumbnailUrl || reference.url, redraw);
        if (image?.complete && image.naturalWidth) {
          ctx.save(); ctx.beginPath(); ctx.roundRect(x + 1, y + 1, 46, 46, 6); ctx.clip();
          const fit = Math.min(46 / image.naturalWidth, 46 / image.naturalHeight);
          const w = image.naturalWidth * fit, h = image.naturalHeight * fit;
          ctx.drawImage(image, x + 1 + (46 - w) / 2, y + 1 + (46 - h) / 2, w, h);
          ctx.restore();
        }
        ctx.fillStyle = '#3b82f6'; ctx.font = `700 6.5px ${fontFamily}`;
        ctx.fillText(ellipsis(`@${reference.name || `图 ${index + 1}`}`, 44), x + 2, y + 9);
        if (hoveredReference === index) {
          ctx.fillStyle = dark ? '#171717' : '#ffffff';
          ctx.beginPath(); ctx.arc(x + 43, y + 43, 7, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = muted; ctx.font = `500 13px ${fontFamily}`; ctx.fillText('×', x + 39, y + 47);
        }
      });
      const addX = 16 + references.length % 8 * 56;
      const addY = 16 + Math.floor(references.length / 8) * 56;
      ctx.strokeStyle = dark ? '#404040' : '#d1d5db'; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.roundRect(addX, addY, 48, 48, 7); ctx.stroke(); ctx.setLineDash([]);
      ctx.strokeStyle = muted; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(addX + 19, addY + 24); ctx.lineTo(addX + 29, addY + 24);
      ctx.moveTo(addX + 24, addY + 19); ctx.lineTo(addX + 24, addY + 29); ctx.stroke();
      ctx.strokeStyle = dark ? '#404040' : '#f3f4f6'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(16, footerY - 9); ctx.lineTo(462, footerY - 9); ctx.stroke();
      controlBounds.forEach(control => {
        const x = control.x - 1;
        if (control.key === 'mention') {
          ctx.fillStyle = dark ? '#172554' : '#eff6ff';
          ctx.beginPath(); ctx.roundRect(x, footerY + 4, control.width, 24, 5); ctx.fill();
        }
        ctx.fillStyle = control.key === 'mention' ? (dark ? '#60a5fa' : '#2563eb') : muted;
        ctx.font = `600 12px ${fontFamily}`;
        const icon = control.key === 'mention' ? '@' : control.key === 'model' ? '✧' : control.key === 'ratio' ? '▢' : control.key === 'res' ? '▱' : '◇';
        ctx.fillText(icon, x + 3, footerY + 20);
        ctx.fillText(ellipsis(control.label, Math.max(1, control.width - 26)), x + 20, footerY + 20);
        if (control.key !== 'mention') {
          ctx.strokeStyle = muted; ctx.beginPath();
          ctx.moveTo(x + control.width - 8, footerY + 14); ctx.lineTo(x + control.width - 5, footerY + 17); ctx.lineTo(x + control.width - 2, footerY + 14); ctx.stroke();
        }
      });
      ctx.globalAlpha = canGenerate && !generating ? 1 : .5;
      ctx.fillStyle = dark ? '#f5f5f5' : '#111827';
      ctx.beginPath(); ctx.arc(446, footerY + 16, 16, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = dark ? '#171717' : '#fff'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(446, footerY + 21); ctx.lineTo(446, footerY + 10);
      ctx.moveTo(441, footerY + 15); ctx.lineTo(446, footerY + 10); ctx.lineTo(451, footerY + 15); ctx.stroke();
      ctx.globalAlpha = 1;
    };
    draw();
    return () => { active = false; if (frame !== null) cancelAnimationFrame(frame); };
  }, [height, referenceKey, controlKey, dpr, epoch, hoveredReference, generating, canGenerate]);

  const buttonStyle = (x: number, y: number, width: number, h: number): React.CSSProperties => ({ position: 'absolute', left: x, top: y, width, height: h, background: 'transparent', border: 0, padding: 0 });
  return <div className="absolute inset-0" style={{ fontFamily: 'inherit' }}>
    <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 w-full h-full pointer-events-none" />
    {references.map((reference, index) => {
      const x = 17 + index % 8 * 56, y = 17 + Math.floor(index / 8) * 56;
      return <div key={`${index}:${reference.url}`} onMouseEnter={() => setHoveredReference(index)} onMouseLeave={() => setHoveredReference(null)} onFocus={() => setHoveredReference(index)}>
        <button type="button" aria-label={`查看参考图：${reference.name || index + 1}`} title={reference.name}
          style={buttonStyle(x, y + 12, 48, 36)} onClick={() => onReference(index)} />
        <button type="button" aria-label={`@${reference.name || `图 ${index + 1}`}`} title="点击在提示词中引用"
          style={buttonStyle(x, y, 48, 12)} onClick={() => onMention(index)} />
        <button type="button" aria-label={`移除参考图：${reference.name || index + 1}`} title="移除参考图"
          style={{ ...buttonStyle(x + 36, y + 36, 14, 14), visibility: hoveredReference === index ? 'visible' : 'hidden' }} onClick={() => onRemove(index)} />
      </div>;
    })}
    <button type="button" aria-label="添加参考图" title="添加参考图" data-agent-target={`ref-btn-${cardId}`}
      style={buttonStyle(17 + references.length % 8 * 56, 17 + Math.floor(references.length / 8) * 56, 48, 48)} onClick={onAdd} />
    {children}
    {controlBounds.map(control => <button key={control.key} type="button" aria-label={control.key === 'mention' ? '@ 引用' : control.label}
      title={control.label} data-agent-target={control.targetId} style={buttonStyle(control.x, footerY, control.width, 32)} onClick={control.onClick} />)}
    <button type="button" aria-label="生成" title="生成" data-agent-target={`generate-btn-${cardId}`} disabled={!canGenerate || generating}
      style={buttonStyle(431, footerY, 32, 32)} onClick={onGenerate} />
  </div>;
});
