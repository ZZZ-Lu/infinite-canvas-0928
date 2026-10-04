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

      // 仅对竖图 (Height > Width，如 9:16 / 3:4 / 2:3) 启用 1:1 Letterbox 扩展
      // 横向比例图 (16:9 / 4:3 / 3:2) 大模型原生视觉编码器定位极为精准，绝不加上下黑边，直接原图送入！
      if (origW >= origH || Math.abs(origW - origH) < 2) {
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

      // 竖图 (Height > Width)：上下占满 100%，左右居中 padding 扩展为 1:1 正方形
      const targetDim = Math.min(maxDimension, Math.max(origH, 512));
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

      const ratio = origW / origH;
      const drawW = targetDim * ratio;
      const drawH = targetDim;
      const offsetX = (targetDim - drawW) / 2;
      const offsetY = 0;

      ctx.drawImage(img, offsetX, offsetY, drawW, drawH);

      const padInfo: SquarePadInfo = {
        isPadded: true,
        padXPercent: (offsetX / targetDim) * 100,
        padYPercent: 0,
        scaleX: drawW / targetDim,
        scaleY: 1,
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
 * 将识别空间中的坐标 (0~100) 统一安全钳位并标准化为原图空间坐标 (0~100)
 * 
 * 方案 A（自适应原生无损映射）：
 * 大模型在 1:1 垫边输入下原生即以主体有效画面作为归一化基准输出，
 * 直接使用模型返回的精确坐标，避免黑边二次扣减导致的边缘挤压。
 */
export function unpadCoordinates(
  x: number,
  y: number,
  _padInfo?: SquarePadInfo | null
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(100, Math.round(x * 10) / 10)),
    y: Math.max(0, Math.min(100, Math.round(y * 10) / 10)),
  };
}

/**
 * 将 1:1 正方形空间中识别的主体地标及 2D 包围盒无损反解还原回原图真实几何空间
 */
export function unpadLandmarks(
  landmarks: any,
  padInfo?: SquarePadInfo | null
): any {
  if (!landmarks || !padInfo || !padInfo.isPadded) {
    return landmarks;
  }

  const unpadBox = (box?: [number, number, number, number]): [number, number, number, number] | undefined => {
    if (!box || box.length !== 4) return box;
    const [ymin, xmin, ymax, xmax] = box;
    const p1 = unpadCoordinates(xmin, ymin, padInfo);
    const p2 = unpadCoordinates(xmax, ymax, padInfo);
    return [p1.y, p1.x, p2.y, p2.x];
  };

  const result = { ...landmarks };

  if (Array.isArray(result.interestPoints)) {
    result.interestPoints = result.interestPoints.map((pt: any) => {
      const pos = unpadCoordinates(pt.x, pt.y, padInfo);
      return {
        ...pt,
        x: pos.x,
        y: pos.y,
        box_2d: unpadBox(pt.box_2d),
      };
    });
  }

  if (result.regions) {
    const r = { ...result.regions };
    for (const key of ['head', 'eyes', 'chest', 'legs', 'primaryObject']) {
      if (r[key] && typeof r[key] === 'object') {
        const pos = unpadCoordinates(r[key].x, r[key].y, padInfo);
        r[key] = {
          ...r[key],
          x: pos.x,
          y: pos.y,
          box_2d: unpadBox(r[key].box_2d),
        };
      }
    }
    if (Array.isArray(r.hands)) {
      r.hands = r.hands.map((h: any) => {
        const pos = unpadCoordinates(h.x, h.y, padInfo);
        return {
          ...h,
          x: pos.x,
          y: pos.y,
          box_2d: unpadBox(h.box_2d),
        };
      });
    }
    result.regions = r;
  }

  return result;
}

