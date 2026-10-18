/**
 * Calculates line breaks and baseline alignment for prompt text rendering on Canvas.
 */

export interface PromptLine {
  text: string;
  start: number;
}

export interface PromptLayoutResult {
  lines: PromptLine[];
  baseline: number;
}

let offscreenCtx: CanvasRenderingContext2D | null = null;

function getMeasurementCtx(style?: CSSStyleDeclaration): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  if (!offscreenCtx) {
    const canvas = document.createElement('canvas');
    offscreenCtx = canvas.getContext('2d');
  }
  if (offscreenCtx && style) {
    offscreenCtx.font = `${style.fontWeight || '500'} ${style.fontSize || '14px'} ${style.fontFamily || 'sans-serif'}`;
  }
  return offscreenCtx;
}

export function layoutPromptText(
  text: string,
  maxWidth: number,
  style: CSSStyleDeclaration
): PromptLayoutResult {
  const ctx = getMeasurementCtx(style);
  const fontSize = parseFloat(style.fontSize || '14') || 14;
  const baseline = Math.round(fontSize * 1.15);

  if (!text) {
    return { lines: [{ text: '', start: 0 }], baseline };
  }

  const padding = 16;
  const effectiveWidth = Math.max(50, maxWidth - padding);
  const lines: PromptLine[] = [];
  
  const paragraphs = text.split('\n');
  let currentOffset = 0;

  for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
    const paragraph = paragraphs[pIdx];
    
    if (paragraph.length === 0) {
      lines.push({ text: '', start: currentOffset });
      currentOffset += 1;
      continue;
    }

    if (!ctx) {
      lines.push({ text: paragraph, start: currentOffset });
      currentOffset += paragraph.length + 1;
      continue;
    }

    let lineStart = 0;
    let currentLineText = '';

    for (let charIdx = 0; charIdx < paragraph.length; charIdx++) {
      const char = paragraph[charIdx];
      const testLine = currentLineText + char;
      const testWidth = ctx.measureText(testLine).width;

      if (testWidth > effectiveWidth && currentLineText.length > 0) {
        lines.push({
          text: currentLineText,
          start: currentOffset + lineStart,
        });
        lineStart = charIdx;
        currentLineText = char;
      } else {
        currentLineText = testLine;
      }
    }

    if (currentLineText.length > 0) {
      lines.push({
        text: currentLineText,
        start: currentOffset + lineStart,
      });
    }

    currentOffset += paragraph.length + 1;
  }

  return {
    lines: lines.length > 0 ? lines : [{ text: '', start: 0 }],
    baseline,
  };
}
