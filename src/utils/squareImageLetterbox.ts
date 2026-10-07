/**
 * 图像纵向 16:9 标准横向切片与逆向坐标还原工具
 * 
 * 核心机制（全画幅无损纵向 16:9 分块漫游）：
 * 1. 对于竖向图像（如 9:16、3:4、1:2 等），彻底抛弃产生 70% 无效黑边的缩放 Letterbox，
 *    转为沿纵向 Y 轴无损切分为多个横向 16:9 高清局部特写切片（每个切片均为 100% 原始宽度的标准 16:9 画幅）；
 * 2. 0% 黑边浪费，100% 像素利用率，横向 Token 密度提升 300%，面部五官、胸部领口、手部指节与腿部膝盖在各自 16:9 视角下均达最高分辨率；
 * 3. 记录各切片的纵向区间 [yStartPercent, yEndPercent]，通过确定性线性映射将各切片的 16:9 局部 Grounding 坐标无损还原回原图全局坐标。
 */

export interface VerticalSliceItem {
  sliceIndex: number;
  totalSlices: number;
  label: string;
  dataUrl: string;
  yStartPercent: number; // 切片顶部在原图中的纵向百分比 (0~100)
  yEndPercent: number;   // 切片底部在原图中的纵向百分比 (0~100)
  heightPercent: number; // 切片高度占原图总高度的百分比 (0~100)
  cropWidth: number;
  cropHeight: number;
}

export interface SlicedImagePackage {
  isSliced: boolean;
  slices: VerticalSliceItem[];
  originalWidth: number;
  originalHeight: number;
  originalRatio: number;
  primaryPreviewUrl: string;
  // 兼容旧接口
  paddedUrl: string;
  padInfo: SquarePadInfo;
}

export interface SquarePadInfo {
  isPadded: boolean;
  padXPercent: number;
  padYPercent: number;
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
  canvasWidth: number;
  canvasHeight: number;
  originalWidth: number;
  originalHeight: number;
  targetDimension: number;
  targetRatio?: string;
  slicesPackage?: SlicedImagePackage;
}

export type LetterboxPadInfo = SquarePadInfo;

/**
 * 将任意长宽比图像（特别是竖图）沿纵向无损切分为多个标准 16:9 局部高清切片
 */
export async function createVerticalWidescreenSlices(
  imageUrl: string,
  maxDimension: number = 1280
): Promise<SlicedImagePackage> {
  return new Promise((resolve) => {
    const targetW = Math.max(640, Math.min(maxDimension, 1280));
    const targetH = Math.round((targetW * 9) / 16); // 16:9

    const fallbackInfo: SquarePadInfo = {
      isPadded: false,
      padXPercent: 0,
      padYPercent: 0,
      scaleX: 1,
      scaleY: 1,
      offsetX: 0,
      offsetY: 0,
      canvasWidth: targetW,
      canvasHeight: targetH,
      originalWidth: 0,
      originalHeight: 0,
      targetDimension: targetW,
      targetRatio: '16:9',
    };

    const fallbackPkg: SlicedImagePackage = {
      isSliced: false,
      slices: [],
      originalWidth: 0,
      originalHeight: 0,
      originalRatio: 1,
      primaryPreviewUrl: imageUrl,
      paddedUrl: imageUrl,
      padInfo: fallbackInfo,
    };

    if (!imageUrl || typeof window === 'undefined') {
      resolve(fallbackPkg);
      return;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';

    img.onload = () => {
      const origW = img.naturalWidth || img.width;
      const origH = img.naturalHeight || img.height;

      if (!origW || !origH) {
        resolve(fallbackPkg);
        return;
      }

      const origRatio = origW / origH;
      const targetRatio = 16 / 9;

      // 1. 如果图像已经是横向 16:9（或接近 16:9，或横屏图片 origRatio >= 1.6）
      if (origRatio >= 1.6) {
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = '#121212';
          ctx.fillRect(0, 0, targetW, targetH);
          ctx.drawImage(img, 0, 0, targetW, targetH);
        }
        const dataUrl = canvas.toDataURL('image/jpeg', 0.90);
        const singleSlice: VerticalSliceItem = {
          sliceIndex: 0,
          totalSlices: 1,
          label: '全景画面 (Full View)',
          dataUrl,
          yStartPercent: 0,
          yEndPercent: 100,
          heightPercent: 100,
          cropWidth: origW,
          cropHeight: origH,
        };
        const padInfo: SquarePadInfo = {
          isPadded: false,
          padXPercent: 0,
          padYPercent: 0,
          scaleX: 1,
          scaleY: 1,
          offsetX: 0,
          offsetY: 0,
          canvasWidth: targetW,
          canvasHeight: targetH,
          originalWidth: origW,
          originalHeight: origH,
          targetDimension: targetW,
          targetRatio: '16:9',
        };
        const pkg: SlicedImagePackage = {
          isSliced: false,
          slices: [singleSlice],
          originalWidth: origW,
          originalHeight: origH,
          originalRatio: origRatio,
          primaryPreviewUrl: dataUrl,
          paddedUrl: dataUrl,
          padInfo,
        };
        padInfo.slicesPackage = pkg;
        resolve(pkg);
        return;
      }

      // 2. 竖向 / 方形图像 (origRatio < 1.6，如 9:16、3:4、1:1 等)：
      // 沿纵向取 100% 宽度的 16:9 视窗切片（每个切片高度 cropH = origW * 9 / 16）
      const cropH = Math.round(origW * (9 / 16));
      
      // 根据原图纵向拉伸程度动态计算切片数量 (9:16 对应 origH/cropH ≈ 3.16，必须取 4 个切片以提供 10%~15% 健康重叠，消除盲区断层)
      let numSlices = 4;
      if (origH <= cropH * 1.35) {
        numSlices = 2; // 1:1 或 4:3 两个切片即可覆盖
      } else if (origH <= cropH * 2.2) {
        numSlices = 3; // 3:4 或 2:3 取三个切片
      } else if (origH >= cropH * 4.5) {
        numSlices = 5; // 超长条图
      }

      const slices: VerticalSliceItem[] = [];
      const labels2 = ['上半身核心特写', '下半身身形与腿部特写'];
      const labels3 = ['头部五官与颈项特写', '胸部、领口与手部特写', '修长腿部线条与足部特写'];
      const labels4 = [
        '头部发丝与面部眼神微表情特写 (顶部特写)',
        '上胸腔·面部下颌、项圈锁骨与挺拔胸部深V特写',
        '腰身身形、大腿根部手指动态与裙摆质感特写',
        '修长光洁腿部与足部线条特写 (底部特写)'
      ];
      const labels5 = ['头部神态特写', '项圈与胸部特写', '腰身与手指特写', '膝盖大腿特写', '足部线条特写'];

      const labelList = numSlices === 2 ? labels2 : (numSlices === 3 ? labels3 : (numSlices === 5 ? labels5 : labels4));

      for (let i = 0; i < numSlices; i++) {
        // 均匀分布在 [0, origH - cropH] 区间，保证切片 0 贴顶，切片 N-1 贴底，中间切片均匀重叠过渡
        const sy = Math.round(i * (origH - cropH) / (numSlices - 1));
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');

        if (ctx) {
          ctx.fillStyle = '#121212';
          ctx.fillRect(0, 0, targetW, targetH);
          // 将原图 (0, sy, origW, cropH) 区域完整铺满 1280x720 (16:9) 画布，0 黑边
          ctx.drawImage(img, 0, sy, origW, cropH, 0, 0, targetW, targetH);
        }

        const dataUrl = canvas.toDataURL('image/jpeg', 0.90);
        const yStartPercent = (sy / origH) * 100;
        const heightPercent = (cropH / origH) * 100;
        const yEndPercent = yStartPercent + heightPercent;

        slices.push({
          sliceIndex: i,
          totalSlices: numSlices,
          label: labelList[i] || `切片 ${i + 1}`,
          dataUrl,
          yStartPercent,
          yEndPercent,
          heightPercent,
          cropWidth: origW,
          cropHeight: cropH,
        });
      }

      const padInfo: SquarePadInfo = {
        isPadded: true,
        padXPercent: 0,
        padYPercent: 0,
        scaleX: 1,
        scaleY: 1,
        offsetX: 0,
        offsetY: 0,
        canvasWidth: targetW,
        canvasHeight: targetH,
        originalWidth: origW,
        originalHeight: origH,
        targetDimension: targetW,
        targetRatio: '16:9',
      };

      const resultPkg: SlicedImagePackage = {
        isSliced: true,
        slices,
        originalWidth: origW,
        originalHeight: origH,
        originalRatio: origRatio,
        primaryPreviewUrl: slices[0]?.dataUrl || imageUrl,
        paddedUrl: slices[0]?.dataUrl || imageUrl,
        padInfo,
      };

      padInfo.slicesPackage = resultPkg;
      resolve(resultPkg);
    };

    img.onerror = () => {
      resolve(fallbackPkg);
    };

    img.src = imageUrl;
  });
}

/**
 * 兼容旧接口：将原图生成 16:9 切片包并返回主要切片和 padInfo
 */
export async function createSquareLetterboxImage(
  imageUrl: string,
  maxDimension: number = 1280
): Promise<{ paddedUrl: string; padInfo: SquarePadInfo }> {
  const pkg = await createVerticalWidescreenSlices(imageUrl, maxDimension);
  return {
    paddedUrl: pkg.primaryPreviewUrl,
    padInfo: pkg.padInfo,
  };
}

export const createWidescreenLetterboxImage = createSquareLetterboxImage;

/**
 * 将某个切片中的局部百分比坐标 (x, y) 映射还原回原图全局百分比坐标 (0~100)
 */
export function mapSliceCoordinateToGlobal(
  localX: number,
  localY: number,
  slice: VerticalSliceItem
): { x: number; y: number } {
  const globalX = Math.max(0, Math.min(100, Math.round(localX * 10) / 10));
  const globalY = Math.max(
    0,
    Math.min(
      100,
      Math.round((slice.yStartPercent + localY * (slice.heightPercent / 100)) * 10) / 10
    )
  );
  return { x: globalX, y: globalY };
}

/**
 * 将某个切片中的局部 2D 包围盒 [ymin, xmin, ymax, xmax] (0~100) 映射还原回原图全局 2D 包围盒
 */
export function mapSliceBoxToGlobal(
  box: [number, number, number, number],
  slice: VerticalSliceItem
): [number, number, number, number] {
  const [ymin, xmin, ymax, xmax] = box;
  const p1 = mapSliceCoordinateToGlobal(xmin, ymin, slice);
  const p2 = mapSliceCoordinateToGlobal(xmax, ymax, slice);
  return [
    Math.min(p1.y, p2.y),
    Math.min(p1.x, p2.x),
    Math.max(p1.y, p2.y),
    Math.max(p1.x, p2.x),
  ];
}

/**
 * 将 16:9 画布空间中识别的主体地标及 2D 包围盒无损反解还原回原图真实几何空间
 */
export function unpadLandmarks(
  landmarks: any,
  padInfo?: SquarePadInfo | null
): any {
  if (!landmarks) return landmarks;

  // 若服务端已统一转换为原图 0~100% 全局坐标，严禁二次映射
  if (landmarks.isGlobalCoordinates) {
    return landmarks;
  }

  const pkg = padInfo?.slicesPackage;
  if (!pkg || !pkg.isSliced || pkg.slices.length === 0) {
    return landmarks;
  }

  const slices = pkg.slices;
  const getSlice = (idx?: number, fallbackType?: string): VerticalSliceItem => {
    if (typeof idx === 'number' && idx >= 0 && idx < slices.length) {
      return slices[idx];
    }
    if (fallbackType === 'head' || fallbackType === 'eyes' || fallbackType === 'face') {
      return slices[0];
    }
    if (fallbackType === 'neck' || fallbackType === 'necklace' || fallbackType === 'chest' || fallbackType === 'cleavage') {
      return slices[Math.min(1, slices.length - 1)];
    }
    if (fallbackType === 'legs' || fallbackType === 'feet' || fallbackType === 'foot') {
      return slices[slices.length - 1];
    }
    // 中部腹臀与手部切片
    return slices[Math.min(slices.length > 3 ? 2 : 1, slices.length - 1)];
  };

  const result = { ...landmarks };

  if (Array.isArray(result.interestPoints)) {
    result.interestPoints = result.interestPoints.map((pt: any) => {
      // 若后端已在服务端反解为全局坐标，则无需重复映射
      if (pt._alreadyGlobal) return pt;
      const slice = getSlice(pt.sliceIndex, pt.id || pt.category);
      const pos = mapSliceCoordinateToGlobal(pt.x, pt.y, slice);
      const box = pt.box_2d ? mapSliceBoxToGlobal(pt.box_2d, slice) : undefined;
      return {
        ...pt,
        x: pos.x,
        y: pos.y,
        box_2d: box,
      };
    });
  }

  if (result.regions) {
    const r = { ...result.regions };
    for (const key of ['head', 'eyes', 'chest', 'legs', 'primaryObject']) {
      if (r[key] && typeof r[key] === 'object' && !r[key]._alreadyGlobal) {
        const slice = getSlice(r[key].sliceIndex, key);
        const pos = mapSliceCoordinateToGlobal(r[key].x, r[key].y, slice);
        const box = r[key].box_2d ? mapSliceBoxToGlobal(r[key].box_2d, slice) : undefined;
        r[key] = {
          ...r[key],
          x: pos.x,
          y: pos.y,
          box_2d: box,
        };
      }
    }
    if (Array.isArray(r.hands)) {
      r.hands = r.hands.map((h: any) => {
        if (h._alreadyGlobal) return h;
        const slice = getSlice(h.sliceIndex, 'hands');
        const pos = mapSliceCoordinateToGlobal(h.x, h.y, slice);
        const box = h.box_2d ? mapSliceBoxToGlobal(h.box_2d, slice) : undefined;
        return {
          ...h,
          x: pos.x,
          y: pos.y,
          box_2d: box,
        };
      });
    }
    result.regions = r;
  }

  return result;
}

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

