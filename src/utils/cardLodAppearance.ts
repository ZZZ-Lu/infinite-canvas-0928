/**
 * Utility functions for drawing card outlines, borders, and icons on Canvas for Nano/Micro LOD rendering.
 */

export function isStandardCardLod(scale: number): boolean {
  return scale >= 0.22;
}

export function cardOutline(
  width: number,
  height: number,
  rounded = true,
  _squircleSupported = false
): Path2D {
  const path = new Path2D();
  if (!rounded) {
    path.rect(0, 0, width, height);
    return path;
  }
  const radius = Math.min(16, width / 2, height / 2);
  path.moveTo(radius, 0);
  path.lineTo(width - radius, 0);
  path.arcTo(width, 0, width, radius, radius);
  path.lineTo(width, height - radius);
  path.arcTo(width, height, width - radius, height, radius);
  path.lineTo(radius, height);
  path.arcTo(0, height, 0, height - radius, radius);
  path.lineTo(0, radius);
  path.arcTo(0, 0, radius, 0, radius);
  path.closePath();
  return path;
}

export function strokeCardOutline(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  standard = true,
  _squircleSupported = false
): void {
  ctx.save();
  const radius = standard ? Math.min(16, width / 2, height / 2) : 4;
  ctx.beginPath();
  if (ctx.roundRect) {
    ctx.roundRect(x, y, width, height, radius);
  } else {
    ctx.rect(x, y, width, height);
  }
  ctx.stroke();
  ctx.restore();
}

export function drawEmptyCardIcon(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  dark = false
): void {
  ctx.save();
  ctx.fillStyle = dark ? 'rgba(255, 255, 255, 0.25)' : 'rgba(0, 0, 0, 0.2)';
  ctx.beginPath();
  ctx.arc(cx, cy, 12, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
