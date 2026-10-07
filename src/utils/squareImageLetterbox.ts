/**
 * 图像 1:1 白盒正方形 Letterbox 规整与逆向坐标还原工具
 * 
 * 解决大模型对极端长宽比（9:16 竖屏 / 16:9 宽屏）视觉注意力失真问题：
 * 1. 在调用模型前，将图片主动居中垫入 1:1 正方形画布中（去除黑盒 Padding）；
 * 2. 模型在 1:1 标准正方形中以最高精度完成 Visual Grounding 定位；
 * 3. 通过确定性线性几何公式将点坐标百分比无损反解还原回原图坐标。
 */

export interface SquarePadInfo {
  isPadded: boolean;
  padXPercent: number; // 左右 padding 占正方形宽度的百分比 (0~50%)
  padYPercent: number; // 上下 padding 占正方形高度的百分比 (0~50%)
  scaleX: number; // 原图宽度在正方形中的缩放比例 (0~1)
  scaleY: number; // 原图高度在正方形中的缩放比例 (0~1)
  originalWidth: number;
  originalHeight: number;
  targetDimension: number;
}

/**
 * 将任意长宽比的图像垫入 1:1 正方形画布，返回 1:1 数据 URL 与 padding 几何参数
 */
export async function createSquareLetterboxImage(
  imageUrl: string,
  maxDimension: number = 1024
): Promise<{ paddedUrl: string; padInfo: SquarePadInfo }> {
  return new Promise((resolve) => {
    const fallbackInfo: SquarePadInfo = {
      isPadded: false,
      padXPercent: 0,
      padYPercent: 0,
      scaleX: 1,
      scaleY: 1,
      originalWidth: 0,
      originalHeight: 0,
      targetDimension: maxDimension,
    };

    if (!imageUrl || typeof window === 'undefined') {
      resolve({ paddedUrl: imageUrl, padInfo: fallbackInfo });
      return;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';

    img.onload = () => {
      const origW = img.naturalWidth || img.width;
      const origH = img.naturalHeight || img.height;

      if (!origW || !origH) {
        resolve({ paddedUrl: imageUrl, padInfo: fallbackInfo });
        return;
      }

      // 如果原本就是 1:1 正方形，无需 padding
      if (Math.abs(origW - origH) < 2) {
        resolve({
          paddedUrl: imageUrl,
          padInfo: {
            isPadded: false,
            padXPercent: 0,
            padYPercent: 0,
            scaleX: 1,
            scaleY: 1,
            originalWidth: origW,
            originalHeight: origH,
            targetDimension: Math.min(maxDimension, Math.max(origW, origH)),
          }
        });
        return;
      }

      const targetDim = Math.min(maxDimension, Math.max(origW, origH, 512));
      const canvas = document.createElement('canvas');
      canvas.width = targetDim;
      canvas.height = targetDim;
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        resolve({ paddedUrl: imageUrl, padInfo: fallbackInfo });
        return;
      }

      // 填充中性深灰底色（减少模型对比度突变干扰）
      ctx.fillStyle = '#121212';
      ctx.fillRect(0, 0, targetDim, targetDim);

      let drawW = targetDim;
      let drawH = targetDim;
      let offsetX = 0;
      let offsetY = 0;

      if (origW < origH) {
        // 竖图 (Height > Width)：上下占满 100%，左右居中 padding
        const ratio = origW / origH;
        drawW = targetDim * ratio;
        drawH = targetDim;
        offsetX = (targetDim - drawW) / 2;
        offsetY = 0;
      } else {
        // 横图 (Width > Height)：左右占满 100%，上下居中 padding
        const ratio = origH / origW;
        drawW = targetDim;
        drawH = targetDim * ratio;
        offsetX = 0;
        offsetY = (targetDim - drawH) / 2;
      }

      ctx.drawImage(img, offsetX, offsetY, drawW, drawH);

      const padInfo: SquarePadInfo = {
        isPadded: true,
        padXPercent: (offsetX / targetDim) * 100,
        padYPercent: (offsetY / targetDim) * 100,
        scaleX: drawW / targetDim,
        scaleY: drawH / targetDim,
        originalWidth: origW,
        originalHeight: origH,
        targetDimension: targetDim,
      };

      try {
        const paddedUrl = canvas.toDataURL('image/jpeg', 0.90);
        resolve({ paddedUrl, padInfo });
      } catch (err) {
        console.warn('[SquareLetterbox] toDataURL error (CORS fallback to original):', err);
        resolve({ paddedUrl: imageUrl, padInfo: fallbackInfo });
      }
    };

    img.onerror = () => {
      resolve({ paddedUrl: imageUrl, padInfo: fallbackInfo });
    };

    img.src = imageUrl;
  });
}

/**
 * 将 1:1 正方形空间中的坐标 (0~100) 逆向反解回原图空间 (0~100)
 */
export function unpadCoordinates(
  x: number,
  y: number,
  padInfo?: SquarePadInfo | null
): { x: number; y: number } {
  if (!padInfo || !padInfo.isPadded) {
    return { x, y };
  }

  const { padXPercent = 0, padYPercent = 0, scaleX = 1, scaleY = 1 } = padInfo;
  const rawX = scaleX > 0 ? (x - padXPercent) / scaleX : x;
  const rawY = scaleY > 0 ? (y - padYPercent) / scaleY : y;

  return {
    x: Math.max(0, Math.min(100, Math.round(rawX * 10) / 10)),
    y: Math.max(0, Math.min(100, Math.round(rawY * 10) / 10)),
  };
}
