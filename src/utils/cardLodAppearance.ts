// Shared by native card CSS and the loading canvas. Values are world pixels.
export const NANO_LOD_THRESHOLD = 0.40;
export const NANO_LOD_ENTER_HIGH_THRESHOLD = 0.40;
export const NANO_LOD_EXIT_HIGH_THRESHOLD = 0.34;
export const CARD_CORNER_RADIUS = 20;
export const CARD_PANEL_WIDTH = 480;
export const cardCornerStyle = { '--card-corner-radius': `${CARD_CORNER_RADIUS}px` };
export const isStandardCardLod = (scale: number) => scale >= NANO_LOD_EXIT_HIGH_THRESHOLD;
export const EMPTY_CARD_PATHS = [
  'M8.5 2C8.8 4.5 10.5 6.2 13 6.5C10.5 6.8 8.8 8.5 8.5 11C8.2 8.5 6.5 6.8 4 6.5C6.5 6.2 8.2 4.5 8.5 2Z',
  'M15.5 10L22 20H9L15.5 10Z',
  'M8.5 13L13 20H4L8.5 13Z',
];
let emptyPaths: Path2D[] | undefined;
export function drawEmptyCardIcon(ctx: CanvasRenderingContext2D, x: number, y: number, dark: boolean) {
  emptyPaths ||= EMPTY_CARD_PATHS.map(path => new Path2D(path));
  ctx.save(); ctx.translate(x - 24, y - 24); ctx.scale(2, 2);
  ctx.fillStyle = dark ? '#525252' : '#d1d5db';
  emptyPaths.forEach(path => ctx.fill(path));
  ctx.restore();
}

// CSS corner-shape:squircle is superellipse(2), i.e. exponent 4.
// Cache normalized paths: camera transforms never rebuild geometry.
const paths = new Map<string, Path2D>();
export function cardOutline(width: number, height: number, standard: boolean, squircle = true): Path2D {
  const key = `${width}:${height}:${standard}:${squircle}`;
  const cached = paths.get(key);
  if (cached) return cached;
  const path = new Path2D();
  const r = Math.min(CARD_CORNER_RADIUS, width / 2, height / 2);
  if (!standard) path.rect(0, 0, width, height);
  else if (!squircle) path.roundRect(0, 0, width, height, r);
  else {
    path.moveTo(r, 0);
    for (let corner = 0; corner < 4; corner++) {
      const cx = corner === 0 || corner === 1 ? width - r : r;
      const cy = corner === 0 || corner === 3 ? r : height - r;
      for (let step = 0; step <= 16; step++) {
        const angle = -Math.PI / 2 + corner * Math.PI / 2 + step * Math.PI / 32;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        path.lineTo(cx + r * Math.sign(cos) * Math.sqrt(Math.abs(cos)), cy + r * Math.sign(sin) * Math.sqrt(Math.abs(sin)));
      }
    }
    path.closePath();
  }
  if (paths.size >= 128) paths.delete(paths.keys().next().value!);
  paths.set(key, path);
  return path;
}

export function strokeCardOutline(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, standard: boolean, squircle: boolean) {
  if (!standard) { ctx.strokeRect(x, y, width, height); return; }
  ctx.save(); ctx.translate(x, y); ctx.stroke(cardOutline(width, height, standard, squircle)); ctx.restore();
}
