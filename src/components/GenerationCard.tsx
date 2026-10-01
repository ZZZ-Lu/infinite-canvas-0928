import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, MotionValue } from 'motion/react';
import { 
  RefreshCw,
  Plus,
  ChevronDown,
  ArrowUp,
  Layers,
  Trash2,
  Upload,
  Sparkles,
  LayoutGrid,
  X,
  Search,
  Image as ImageIcon,
  User,
  MapPin,
  Box,
  AlertCircle,
  Download,
  Eye,
  Copy
} from 'lucide-react';
import { isCardIntersectingRectangle } from '../utils/viewportCulling';
import { getPromptAreaHeight, calculatePromptLines } from '../utils/cardLayout';
import { CardImageCanvas } from './CardImageCanvas';
import { ScriptProject } from '../types/script';
import { generateImageThumbnail, generateVideoThumbnail, thumbCache, MAX_THUMBNAIL_EDGE } from '../utils/thumbnail';
import { getActiveMcpKey, getActiveMcpKeySync, getActiveMcpTokenSync } from '../utils/mcpStorage';
import { useMcpKey } from '../hooks/useMcpKey';
import { useWorkrallyModels } from '../hooks/useWorkrallyModels';
import { WORKRALLY_IMAGE_MODELS, WORKRALLY_IMAGE_RATIOS, WORKRALLY_IMAGE_TOOL, WorkRallyImageModel } from '../config/workrallyImageModels';
import { WORKRALLY_VIDEO_MODELS, WORKRALLY_VIDEO_RATIOS, WORKRALLY_VIDEO_TOOL, WorkRallyVideoModel } from '../config/workrallyVideoModels';

export type CardState = 'draft' | 'generating' | 'completed';
export type AspectRatio = string;
export type Resolution = string;
type McpSchemaParameter = {
  name: string;
  title?: string;
  description?: string;
  type?: string;
  enum?: Array<string | number | boolean>;
  default?: any;
  required?: boolean;
};
export const CARD_DIMENSIONS: Record<AspectRatio, { width: number, height: number }> = {
  '1:1': { width: 480, height: 480 },
  '3:4': { width: 420, height: 560 },
  '9:16': { width: 360, height: 640 },
  '16:9': { width: 640, height: 360 }
};

export function getCardSize(data: { ratio: AspectRatio; customWidth?: number; customHeight?: number }): { width: number, height: number } {
  if (data.customWidth && data.customHeight) {
    return { width: data.customWidth, height: data.customHeight };
  }
  if (CARD_DIMENSIONS[data.ratio]) return CARD_DIMENSIONS[data.ratio];
  const match = String(data.ratio || '').match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (match) {
    const ratioW = Number(match[1]);
    const ratioH = Number(match[2]);
    if (ratioW > 0 && ratioH > 0) {
      const area = 480 * 480;
      const width = Math.round(Math.sqrt(area * (ratioW / ratioH)));
      const height = Math.round(width * (ratioH / ratioW));
      return { width, height };
    }
  }
  return CARD_DIMENSIONS['1:1'];
}

const generateThumbnail = (video: HTMLVideoElement) => {
  try {
    if (!video.videoWidth || !video.videoHeight) return undefined;
    const canvas = document.createElement('canvas');
    const width = 256;
    const aspect = video.videoHeight / video.videoWidth;
    if (!aspect || !isFinite(aspect)) return undefined;
    canvas.width = width;
    canvas.height = width * aspect;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      try {
        const sample = ctx.getImageData(Math.floor(canvas.width / 2) - 5, Math.floor(canvas.height / 2) - 5, 10, 10).data;
        let isBlack = true;
        for (let i = 0; i < sample.length; i += 4) {
          if (sample[i] > 18 || sample[i + 1] > 18 || sample[i + 2] > 18) {
            isBlack = false;
            break;
          }
        }
        if (isBlack && video.currentTime < 0.1 && video.duration > 0.3) {
          return undefined;
        }
      } catch {}
      return canvas.toDataURL('image/jpeg', 0.6);
    }
  } catch (e) {
    // Ignore Cross-Origin errors
  }
  return undefined;
};

export async function safeParseJsonResponse(response: Response): Promise<{ success: boolean; data: any; error?: string }> {
  const contentType = response.headers.get('content-type') || '';
  let data: any = null;
  if (contentType.includes('application/json')) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  } else {
    try {
      const text = await response.text();
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (data !== null && typeof data === 'object') {
    return { success: true, data };
  }

  const status = response.status;
  let errorMsg = '服务器返回了异常的非 JSON 响应';
  if (status === 502) errorMsg = '服务网关异常 (502 Bad Gateway)，请稍后重试';
  else if (status === 504) errorMsg = '服务网关超时 (504 Gateway Timeout)，请稍后重试';
  else if (status === 413) errorMsg = '请求体体积过大 (413 Payload Too Large)，请减少参考图大小';
  else if (status >= 500) errorMsg = `服务器错误 (HTTP ${status})，请稍后重试`;
  else if (status >= 400) errorMsg = `请求失败 (HTTP ${status})`;

  return { success: false, data: null, error: errorMsg };
}

export async function compressImageBlob(blob: Blob, maxDimension = 2048, quality = 0.85): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (!blob.type.startsWith('image/') || blob.size < 400 * 1024) {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
      return;
    }

    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxDimension || height > maxDimension) {
        if (width > height) {
          height = Math.round((height * maxDimension) / width);
          width = maxDimension;
        } else {
          width = Math.round((width * maxDimension) / height);
          height = maxDimension;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    };
    img.src = url;
  });
}

export async function resolveReferenceToPayload(
  ref: { url?: string; fileData?: Blob; sourceCardId?: string; name?: string },
  cards?: CardData[]
): Promise<string> {
  // 1. If ref has direct binary Blob
  if (ref.fileData instanceof Blob) {
    try {
      const dataUrl = await compressImageBlob(ref.fileData);
      if (dataUrl) return dataUrl;
    } catch {}
  }

  // 2. If ref points to another card on canvas (sourceCardId)
  if (ref.sourceCardId && Array.isArray(cards)) {
    const srcCard = cards.find(c => c.id === ref.sourceCardId);
    if (srcCard) {
      const cardBlob = srcCard.trueOriginalFileData || srcCard.originalFileData || srcCard.fileData || srcCard.referenceImageFileData;
      if (cardBlob instanceof Blob) {
        try {
          const dataUrl = await compressImageBlob(cardBlob);
          if (dataUrl) return dataUrl;
        } catch {}
      }
      if (srcCard.imageUrl && !srcCard.imageUrl.startsWith('blob:')) {
        return srcCard.imageUrl;
      }
    }
  }

  // 3. If ref.url is provided
  const url = ref.url;
  if (!url) return '';

  if (url.startsWith('data:')) {
    return url;
  }

  // If it is a remote GTImg/WorkRally CDN URL
  if (/^https?:\/\/([^/]+\.)?gtimg\.com\//i.test(url) || /^\/s\//i.test(url)) {
    return url;
  }

  // If it's a blob: URL, relative URL, or local URL, convert via fetch -> Blob -> compressImageBlob
  try {
    const resp = await fetch(url);
    if (resp.ok) {
      const blob = await resp.blob();
      const dataUrl = await compressImageBlob(blob);
      if (dataUrl) return dataUrl;
    }
  } catch (err) {
    console.warn('[RefPayload] Direct fetch failed for ref url:', url, err);
  }

  // Fallback: draw image using HTMLImageElement to offscreen canvas to extract base64
  return new Promise<string>((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(2048, img.naturalWidth || 1024);
        canvas.height = Math.min(2048, img.naturalHeight || 1024);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
          return;
        }
      } catch {}
      resolve(url);
    };
    img.onerror = () => resolve(url);
    img.src = url;
  });
}

export interface CardBaselineConfig {
  prompt: string;
  ratio: AspectRatio;
  res: Resolution;
  mcpModel?: string;
  mcpToolName?: string;
  mcpParameters?: Record<string, any>;
  referenceImages?: Array<{
    url: string;
    thumbnailUrl?: string;
    microLodThumbnailUrl?: string;
    fullDetailThumbnailUrl?: string;
    closeupThumbnailUrl?: string;
    name?: string;
    fileData?: Blob;
    sourceCardId?: string;
  }>;
  referenceImageUrl?: string | null;
  referenceImageName?: string;
  referenceImageFileData?: Blob;
  derivedFromId?: string;
  referenceSourceIds?: string[];
}

export interface CardData {
  id: string;
  x: number;
  y: number;
  state: CardState;
  ratio: AspectRatio;
  res: Resolution;
  prompt: string;
  imageUrl: string | null;
  isVideo?: boolean;
  fileData?: Blob;
  originalFileData?: Blob; // Up to 4K proxy
  trueOriginalFileData?: Blob; // The actual original file if > 4K
  originalImageUrl?: string | null;
  trueOriginalImageUrl?: string | null;
  currentTime?: number;
  thumbnailUrl?: string;
  microLodThumbnailUrl?: string; // 64px max edge
  fullDetailThumbnailUrl?: string; // 128px max edge
  closeupThumbnailUrl?: string; // 256px max edge
  customWidth?: number;
  customHeight?: number;
  fileName?: string;
  isAsset?: boolean;
  nativeWidth?: number;
  nativeHeight?: number;
  derivedFromId?: string; // Parent card id this was forked/derived from
  referenceSourceIds?: string[]; // Card ids referenced as input/reference media
  referenceImages?: Array<{
    url: string;
    thumbnailUrl?: string;
    microLodThumbnailUrl?: string; // 64px max edge
    fullDetailThumbnailUrl?: string; // 128px max edge
    closeupThumbnailUrl?: string; // 256px max edge
    name?: string;
    fileData?: Blob;
    sourceCardId?: string;
  }>;
  referenceImageUrl?: string | null;
  referenceImageName?: string;
  referenceImageFileData?: Blob;
  mcpToolName?: string;
  mcpModel?: string;
  mcpParameters?: Record<string, any>;
  mcpTaskId?: string;
  generationError?: string;
  lastGeneratedPrompt?: string;
  baselineConfig?: CardBaselineConfig;
  chatHistory?: Array<{
    id: string;
    role: 'user' | 'assistant';
    text: string;
    timestamp?: number;
  }>;
}

const refDimensionsCache = new Map<string, { width: number; height: number }>();

const ReferenceThumbItem = React.memo(function ReferenceThumbItem({
  item,
  idx,
  currentScale,
  removeReferenceImage,
  setOpenMenu,
  hoveredRefUrl,
  setHoveredRefUrl,
  onMentionItem,
}: {
  item: {
    url: string;
    thumbnailUrl?: string;
    microLodThumbnailUrl?: string;
    fullDetailThumbnailUrl?: string;
    closeupThumbnailUrl?: string;
    name?: string;
    fileData?: Blob;
    sourceCardId?: string;
  };
  idx: number;
  currentScale: number;
  removeReferenceImage: (index: number) => void;
  setOpenMenu: React.Dispatch<React.SetStateAction<{ type: 'ratio' | 'res' | 'ref' | 'model' | 'param'; ownerId: string } | null>>;
  hoveredRefUrl: string | null;
  setHoveredRefUrl: React.Dispatch<React.SetStateAction<string | null>>;
  onMentionItem?: (item: { name: string; url?: string; fileData?: Blob }) => void;
}) {
  // Select the appropriate URL based on the scale:
  let displaySrc = item.url;
  if (currentScale < 1.0) {
    displaySrc = item.microLodThumbnailUrl || item.thumbnailUrl || item.url;
  } else if (currentScale < 2.0) {
    displaySrc = item.fullDetailThumbnailUrl || item.thumbnailUrl || item.url;
  } else {
    displaySrc = item.closeupThumbnailUrl || item.thumbnailUrl || item.url;
  }

  const targetUrl = item.url || item.thumbnailUrl || '';
  const isPreviewing = hoveredRefUrl === targetUrl;

  const togglePreview = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (targetUrl) {
      if (!refDimensionsCache.has(targetUrl)) {
        const img = new Image();
        img.referrerPolicy = 'no-referrer';
        img.src = targetUrl;
        img.onload = () => {
          if (img.naturalWidth && img.naturalHeight) {
            refDimensionsCache.set(targetUrl, {
              width: img.naturalWidth,
              height: img.naturalHeight,
            });
          }
        };
      }
      setHoveredRefUrl(prev => prev === targetUrl ? null : targetUrl);
    }
  };

  return (
    <div
      className="group/thumb relative w-12 h-12 cursor-pointer select-none"
      title={item.name || `参考图 ${idx + 1}`}
      onClick={(e) => {
        e.stopPropagation();
        const isAgent = !e.nativeEvent.isTrusted;
        setOpenMenu((prev) =>
          prev?.type === 'ref' ? null : { type: 'ref', ownerId: isAgent ? 'agent' : 'user' }
        );
      }}
    >
      <div className="w-full h-full bg-gray-50 dark:bg-neutral-800/60 rounded-lg border border-gray-200 dark:border-neutral-700/60 flex items-center justify-center overflow-hidden hover:border-gray-300 dark:hover:border-neutral-500 transition-colors duration-150 shadow-xs relative translate-z-0 transform-gpu">
        {/* @Mention Tag (Top Left) */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (onMentionItem) {
              onMentionItem({ name: item.name || `参考图 ${idx + 1}`, url: item.url, fileData: item.fileData });
            }
          }}
          className="absolute top-0.5 left-0.5 right-0.5 z-20 pointer-events-auto hover:bg-blue-500/20 dark:hover:bg-blue-400/20 rounded px-0.5 transition-colors cursor-pointer text-left block"
          title="点击在提示词中@此参考图"
        >
          <span className="text-[6.5px] font-bold text-[#3b82f6] dark:text-blue-400 select-none block truncate leading-none text-left tracking-tight hover:underline">
            @{item.name || `图 ${idx + 1}`}
          </span>
        </button>

        {/* Thumbnail Image */}
        <img
          src={displaySrc}
          alt={item.name || `参考图 ${idx + 1}`}
          loading="lazy"
          decoding="async"
          className="max-w-full max-h-full object-contain pointer-events-none"
          referrerPolicy="no-referrer"
        />

        {/* Center Hover Overlay with Eye Icon */}
        <button
          type="button"
          onClick={togglePreview}
          className={`absolute inset-0 z-10 flex items-center justify-center bg-black/40 transition-opacity duration-150 cursor-pointer rounded-lg ${
            isPreviewing ? 'opacity-100 bg-black/55' : 'opacity-0 group-hover/thumb:opacity-100'
          }`}
          title={isPreviewing ? "关闭大图" : "点击查看大图"}
        >
          <div className="w-3.5 h-3.5 rounded-full bg-black/70 hover:bg-black/90 text-white flex items-center justify-center shadow-xs transform transition-transform group-hover/thumb:scale-100 scale-90">
            <Eye className="w-2 h-2 stroke-[2.2]" />
          </div>
        </button>
      </div>

      {/* Remove Button (Top Right) */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (isPreviewing) {
            setHoveredRefUrl(null);
          }
          removeReferenceImage(idx);
        }}
        className="absolute -top-1 -right-1 w-3.5 h-3.5 bg-red-500 hover:bg-red-600 text-white rounded-full flex items-center justify-center opacity-0 group-hover/thumb:opacity-100 transition-opacity duration-150 shadow-md z-30 p-0 cursor-pointer"
        title="移除参考图"
      >
        <X className="w-2 h-2 stroke-[3]" />
      </button>
    </div>
  );
});

// Cache specifically for 128px mention menu thumbnails
const mentionThumb128Cache = new Map<string, string>();

const MentionCandidateAvatar = React.memo(function MentionCandidateAvatar({
  item,
}: {
  item: {
    id: string;
    name: string;
    url?: string;
    thumbnailUrl?: string;
    fullDetailThumbnailUrl?: string;
    fileData?: Blob;
  };
}) {
  const [thumbSrc, setThumbSrc] = useState<string | undefined>(() => {
    if (item.fullDetailThumbnailUrl) return item.fullDetailThumbnailUrl;
    if (item.url && mentionThumb128Cache.has(item.url)) return mentionThumb128Cache.get(item.url);
    if (item.thumbnailUrl && mentionThumb128Cache.has(item.thumbnailUrl)) return mentionThumb128Cache.get(item.thumbnailUrl);
    return item.thumbnailUrl || undefined;
  });

  useEffect(() => {
    if (item.fullDetailThumbnailUrl) {
      setThumbSrc(item.fullDetailThumbnailUrl);
      if (item.url) mentionThumb128Cache.set(item.url, item.fullDetailThumbnailUrl);
      return;
    }

    const sourceKey = item.url || item.thumbnailUrl || '';
    if (sourceKey && mentionThumb128Cache.has(sourceKey)) {
      setThumbSrc(mentionThumb128Cache.get(sourceKey));
      return;
    }

    const source = item.fileData || item.url || item.thumbnailUrl;
    if (!source) return;

    let isMounted = true;
    generateImageThumbnail(source, 128, 0.90)
      .then((thumb) => {
        if (thumb && sourceKey) {
          mentionThumb128Cache.set(sourceKey, thumb);
        }
        if (isMounted && thumb) {
          setThumbSrc(thumb);
        }
      })
      .catch(() => {
        if (isMounted && item.url) {
          setThumbSrc(item.url);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [item.url, item.thumbnailUrl, item.fullDetailThumbnailUrl, item.fileData]);

  if (!thumbSrc && !item.url) {
    return <span className="text-[11px] font-bold text-gray-400">@</span>;
  }

  return (
    <img
      src={thumbSrc || item.url}
      alt={item.name}
      loading="lazy"
      decoding="async"
      className="w-full h-full object-cover"
      referrerPolicy="no-referrer"
    />
  );
});

export interface GenerationCardProps {
  key?: React.Key;
  data: CardData;
  scale: MotionValue<number>;
  tx: MotionValue<number>;
  ty: MotionValue<number>;
  isSelected?: boolean;
  isAgentTarget?: boolean;
  isZooming?: boolean;
  allCards?: CardData[];
  currentProject?: ScriptProject;
  isPickerTarget?: boolean;
  isPickerSelectable?: boolean;
  pickerSelectionIndex?: number;
  onStartCanvasPicker?: (cardId: string) => void;
  onSelect?: (e: React.PointerEvent, id: string, selectOnlyOnPointerUp?: boolean) => void;
  onDrag?: (id: string, dx: number, dy: number) => void;
  onDragEnd?: (id: string, totalDx: number, totalDy: number) => void;
  onDelete?: (id: string) => void;
  onUpdate: (id: string, updates: Partial<CardData>, isSignificant?: boolean) => void;
  onForkCard?: (cardId: string, customConfigOrPrompt?: string | Partial<CardData>, autoStart?: boolean) => void;
  onHover?: (cardId: string | null) => void;
}

export const GenerationCard = React.memo(function GenerationCard({ 
  data, 
  scale, 
  tx, 
  ty, 
  isSelected, 
  isAgentTarget,
  isZooming,
  allCards,
  currentProject,
  isPickerTarget,
  isPickerSelectable,
  pickerSelectionIndex,
  onStartCanvasPicker,
  onSelect, 
  onDrag, 
  onDragEnd, 
  onDelete,
  onUpdate,
  onForkCard,
  onHover
}: GenerationCardProps) {
  const { id, x, y, state, ratio, res, prompt, imageUrl, isVideo, currentTime } = data;
  
  const {
    models: dynamicMcpModels,
    toolName: defaultMcpToolName,
    isLoading: isMcpModelsLoading,
    isDynamic: isMcpModelsDynamic,
    refresh: refreshMcpModels,
  } = useWorkrallyModels(Boolean(data.isVideo));

  const [currentScale, setCurrentScale] = useState(() => scale.get());
  useEffect(() => {
    return scale.on('change', (v) => {
      // Only trigger React state updates when not actively zooming to avoid rendering thrashing
      if (!isZooming) {
        setCurrentScale(v);
      }
    });
  }, [scale, isZooming]);

  // Synchronize the scale immediately once zooming ends (Instant Restoration)
  useEffect(() => {
    if (!isZooming) {
      setCurrentScale(scale.get());
    }
  }, [isZooming, scale]);

  // If we don't render CardImageCanvas (which is when !imageUrl or isVideo is true),
  // we must manually manage __paintedCardIds for Zero-Flicker Handoff so that
  // the NanoLodCanvas knows the DOM card is fully painted and can skip drawing the canvas layer underneath.
  useEffect(() => {
    const hasImageCanvas = Boolean(imageUrl && !isVideo);
    let raf1: number | null = null;
    let raf2: number | null = null;

    if (!hasImageCanvas && typeof window !== 'undefined') {
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          if (typeof window !== 'undefined') {
            if (!(window as any).__paintedCardIds) {
              (window as any).__paintedCardIds = new Set<string>();
            }
            if (!(window as any).__paintedCardIds.has(id)) {
              (window as any).__paintedCardIds.add(id);
              window.dispatchEvent(new CustomEvent('card-painted', { detail: { cardId: id } }));
            }
          }
        });
      });
    }

    return () => {
      if (raf1 !== null) cancelAnimationFrame(raf1);
      if (raf2 !== null) cancelAnimationFrame(raf2);
      if (!hasImageCanvas && typeof window !== 'undefined') {
        if ((window as any).__paintedCardIds) {
          (window as any).__paintedCardIds.delete(id);
          window.dispatchEvent(new CustomEvent('card-painted', { detail: { cardId: id } }));
        }
      }
    };
  }, [id, imageUrl, isVideo]);

  const [openMenu, setOpenMenu] = useState<{ type: 'ratio' | 'res' | 'ref' | 'model' | 'param', ownerId: string } | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [videoHasError, setVideoHasError] = useState(false);
  const [videoLoadError, setVideoLoadError] = useState<string>('');
  const isRefreshingVideoRef = useRef(false);
  const [hasEverMountedVideo, setHasEverMountedVideo] = useState(false);
  const [localThumbnailUrl, setLocalThumbnailUrl] = useState<string | undefined>(
    data.thumbnailUrl || (imageUrl ? thumbCache.get(imageUrl) || thumbCache.get(id) : undefined)
  );

  useEffect(() => {
    if (isHovered || isPlaying) {
      setHasEverMountedVideo(true);
    }
  }, [isHovered, isPlaying]);

  const { activeKey } = useMcpKey();
  const activeToken = activeKey?.token || getActiveMcpTokenSync();

  const getStoredVideoProgress = useCallback((): number => {
    if (typeof window === 'undefined') return currentTime || 0;
    try {
      const local = localStorage.getItem(`mira_vid_pos_${id}`);
      if (local !== null) {
        const parsed = parseFloat(local);
        if (!isNaN(parsed) && parsed > 0) return parsed;
      }
    } catch {}
    return currentTime || 0;
  }, [id, currentTime]);

  const saveStoredVideoProgress = useCallback((time: number) => {
    if (typeof window === 'undefined' || !id || isNaN(time) || time <= 0.1) return;
    try {
      const existing = localStorage.getItem(`mira_vid_pos_${id}`);
      if (existing !== null) {
        const parsed = parseFloat(existing);
        // CRITICAL PROTECTION: Never let initial seek/mount timestamps (<= 0.2s) overwrite established progress (> 0.5s)
        if (!isNaN(parsed) && parsed > 0.5 && time <= 0.2) {
          return;
        }
      }
      localStorage.setItem(`mira_vid_pos_${id}`, time.toFixed(2));
    } catch {}
  }, [id]);

  const videoPlaySrc = useMemo(() => {
    if (!imageUrl) return '';
    if (imageUrl.startsWith('blob:') || imageUrl.startsWith('data:')) return imageUrl;
    if (/^https?:\/\//i.test(imageUrl)) {
      if (typeof window !== 'undefined' && imageUrl.startsWith(window.location.origin)) {
        return imageUrl;
      }
      const taskId = data.mcpTaskId || imageUrl.match(/(2k[a-z0-9]{6,16})/i)?.[1] || imageUrl.match(/\/(2k[a-z0-9]+)_MAIN_/i)?.[1] || '';
      return `/api/mcp/workrally/proxy-media?url=${encodeURIComponent(imageUrl)}${taskId ? `&taskId=${encodeURIComponent(taskId)}` : ''}${activeToken ? `&token=${encodeURIComponent(activeToken)}` : ''}`;
    }
    return imageUrl;
  }, [imageUrl, data.mcpTaskId, activeToken]);

  const [blobVideoUrl, setBlobVideoUrl] = useState<string | null>(null);
  useEffect(() => {
    if (data.fileData && isVideo) {
      const url = URL.createObjectURL(data.fileData);
      setBlobVideoUrl(url);
      return () => URL.revokeObjectURL(url);
    }
    setBlobVideoUrl(null);
  }, [data.fileData, isVideo]);

  // Background Cache Downloader:
  // Automatically download AI-generated remote video into IndexedDB as a local Blob
  // so zoom/refresh playback is 100% instant with 0ms network delay like local files.
  useEffect(() => {
    if (!isVideo || data.fileData || !videoPlaySrc || !/^https?:\/\//i.test(imageUrl || '')) return;

    let isMounted = true;
    const controller = new AbortController();

    const cacheVideoToIndexedDB = async () => {
      try {
        const response = await fetch(videoPlaySrc, { signal: controller.signal });
        if (response.ok) {
          const blob = await response.blob();
          if (isMounted && blob.size > 0) {
            onUpdate(id, { fileData: blob }, false);
          }
        }
      } catch {
        // Soft fallback to proxy stream if background cache fails
      }
    };

    cacheVideoToIndexedDB();

    return () => {
      isMounted = false;
      controller.abort();
    };
  }, [id, isVideo, data.fileData, imageUrl, videoPlaySrc, onUpdate]);

  const activeVideoSrc = blobVideoUrl || videoPlaySrc;

  const initialSeekPosRef = useRef<number | null>(null);

  useEffect(() => {
    initialSeekPosRef.current = null;
  }, [activeVideoSrc]);

  const effectiveVideoSrc = useMemo(() => {
    if (!activeVideoSrc) return '';
    if (activeVideoSrc.includes('#t=')) return activeVideoSrc;
    if (initialSeekPosRef.current === null) {
      initialSeekPosRef.current = getStoredVideoProgress();
    }
    const pos = initialSeekPosRef.current;
    if (pos > 0.1) {
      return `${activeVideoSrc}#t=${pos.toFixed(2)}`;
    }
    return activeVideoSrc;
  }, [activeVideoSrc]);

  // Synchronize playback with isPlaying state
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let isCancelled = false;

    if (isPlaying) {
      if (video.paused) {
        const playPromise = video.play();
        if (playPromise !== undefined) {
          playPromise.catch((err: any) => {
            if (isCancelled || err?.name === 'AbortError' || err?.message?.includes('pause')) {
              return;
            }
            if (err?.name === 'NotAllowedError') {
              video.muted = true;
              video.play().catch(() => {});
            }
          });
        }
      }
    } else {
      if (!video.paused) {
        video.pause();
      }
    }

    return () => {
      isCancelled = true;
    };
  }, [isPlaying, activeVideoSrc]);

  useEffect(() => {
    if (data.thumbnailUrl) {
      setLocalThumbnailUrl(data.thumbnailUrl);
    }
  }, [data.thumbnailUrl]);

  // Automatically generate first-frame thumbnail for video cards when mediaUrl becomes available
  useEffect(() => {
    if (!isVideo || !imageUrl || data.thumbnailUrl || localThumbnailUrl) return;

    let isMounted = true;
    const cached = thumbCache.get(imageUrl) || thumbCache.get(id);
    if (cached) {
      setLocalThumbnailUrl(cached);
      onUpdateRef.current(id, { thumbnailUrl: cached }, false);
      return;
    }

    void (async () => {
      try {
        const thumb = await generateVideoThumbnail(data.fileData || imageUrl, MAX_THUMBNAIL_EDGE);
        if (thumb && isMounted) {
          setLocalThumbnailUrl(thumb);
          thumbCache.set(id, thumb);
          thumbCache.set(imageUrl, thumb);
          onUpdateRef.current(id, { thumbnailUrl: thumb }, false);
        }
      } catch (err) {
        console.warn(`[GenerationCard] Failed to auto-generate video thumbnail for card ${id}:`, err);
      }
    })();

    return () => {
      isMounted = false;
    };
  }, [isVideo, imageUrl, data.thumbnailUrl, localThumbnailUrl, id, data.fileData]);

  // Local buffered prompt state for 0-latency typing (decouples typing from full canvas re-render)
  const [localPrompt, setLocalPrompt] = useState(prompt || '');
  const localPromptRef = useRef(localPrompt);
  localPromptRef.current = localPrompt;
  const isTypingRef = useRef(false);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Canonical baseline configuration for the completed media (to revert to when forking)
  const baselineConfigRef = useRef<CardBaselineConfig>(
    data.baselineConfig || {
      prompt: data.lastGeneratedPrompt ?? (Boolean(data.imageUrl || data.originalImageUrl || data.fileData) ? (data.prompt || '') : ''),
      ratio: data.ratio || '16:9',
      res: data.res || '2K',
      mcpModel: data.mcpModel,
      mcpToolName: data.mcpToolName,
      mcpParameters: data.mcpParameters ? { ...data.mcpParameters } : undefined,
      referenceImages: data.referenceImages ? data.referenceImages.map(r => ({ ...r })) : [],
      referenceImageUrl: data.referenceImageUrl,
      referenceImageName: data.referenceImageName,
      referenceImageFileData: data.referenceImageFileData,
    }
  );

  const baselinePromptRef = useRef<string>(
    data.baselineConfig?.prompt ?? data.lastGeneratedPrompt ?? (Boolean(data.imageUrl || data.originalImageUrl || data.fileData) ? (data.prompt || '') : '')
  );

  // Synchronize ONLY when data.baselineConfig is explicitly updated (e.g. from DB or generation completion)
  useEffect(() => {
    if (data.baselineConfig) {
      baselineConfigRef.current = data.baselineConfig;
      baselinePromptRef.current = data.baselineConfig.prompt || '';
    } else if (data.imageUrl || data.originalImageUrl || data.fileData) {
      if (!baselineConfigRef.current) {
        const initialBaseline: CardBaselineConfig = {
          prompt: data.lastGeneratedPrompt ?? data.prompt ?? '',
          ratio: data.ratio || '16:9',
          res: data.res || '2K',
          mcpModel: data.mcpModel,
          mcpToolName: data.mcpToolName,
          mcpParameters: data.mcpParameters ? { ...data.mcpParameters } : undefined,
          referenceImages: data.referenceImages ? data.referenceImages.map(r => ({ ...r })) : [],
          referenceImageUrl: data.referenceImageUrl,
          referenceImageName: data.referenceImageName,
          referenceImageFileData: data.referenceImageFileData,
        };
        baselineConfigRef.current = initialBaseline;
        baselinePromptRef.current = initialBaseline.prompt;
      }
    }
  }, [data.baselineConfig]);

  // Synchronize from external data.prompt when not actively typing or when external prompt changed significantly
  useEffect(() => {
    if (!isTypingRef.current && (prompt || '') !== localPromptRef.current) {
      setLocalPrompt(prompt || '');
    }
  }, [prompt]);

  // Flush pending prompt sync on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        onUpdate(id, { prompt: localPromptRef.current }, false);
      }
    };
  }, [id, onUpdate]);

  const commitPrompt = (newVal: string, isSignificant = false) => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    setLocalPrompt(newVal);
    onUpdate(id, { prompt: newVal }, isSignificant);
  };

  // Reference Image States
  const [showAssetPicker, setShowAssetPicker] = useState(false);
  const [assetFilter, setAssetFilter] = useState<'all' | 'characters' | 'locations' | 'props'>('all');
  const [assetSearch, setAssetSearch] = useState('');
  const [hoveredRefUrl, setHoveredRefUrl] = useState<string | null>(null);
  const [activePreviewUrl, setActivePreviewUrl] = useState<string | null>(null);
  const [isRebounding, setIsRebounding] = useState(false);
  const reboundTimerRef = useRef<NodeJS.Timeout | null>(null);

  // @ Mention State
  const [mentionMenuOpen, setMentionMenuOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const mentionMenuRef = useRef<HTMLDivElement>(null);
  const [previewDimensions, setPreviewDimensions] = useState<{ width: number; height: number } | null>(() => {
    return hoveredRefUrl ? refDimensionsCache.get(hoveredRefUrl) || null : null;
  });

  useEffect(() => {
    if (hoveredRefUrl) {
      if (reboundTimerRef.current) {
        clearTimeout(reboundTimerRef.current);
        reboundTimerRef.current = null;
      }
      setIsRebounding(false);
      setActivePreviewUrl(hoveredRefUrl);
    }
  }, [hoveredRefUrl]);

  useEffect(() => {
    return () => {
      if (reboundTimerRef.current) {
        clearTimeout(reboundTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!hoveredRefUrl) {
      setPreviewDimensions(null);
      return;
    }

    const cached = refDimensionsCache.get(hoveredRefUrl);
    if (cached) {
      setPreviewDimensions(cached);
      return;
    }

    let isMounted = true;
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.src = hoveredRefUrl;

    const onDims = () => {
      if (!isMounted) return;
      const dims = {
        width: img.naturalWidth || 16,
        height: img.naturalHeight || 9,
      };
      refDimensionsCache.set(hoveredRefUrl, dims);
      setPreviewDimensions(dims);
    };

    if (img.complete && img.naturalWidth > 0) {
      onDims();
    } else {
      img.onload = onDims;
    }

    return () => {
      isMounted = false;
    };
  }, [hoveredRefUrl]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const refMenuContainerRef = useRef<HTMLDivElement>(null);
  
  const cardRef = useRef<HTMLDivElement>(null);
  const promptContainerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const refreshedVideoUrlRef = useRef<string | null>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const lastSavedTimeRef = useRef<number>(currentTime || 0);
  const menuContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Intent-driven lazy restoration for Video Mounting:
  // When canvas zoom/pan/gesture ends and styles/tags restore, if mouse is inside the video card,
  // restore video mounting immediately alongside the card top text tags (.asset-heavy-dom).
  useEffect(() => {
    if (!isVideo) return;

    const checkAndRestoreHover = () => {
      const el = videoContainerRef.current;
      if (!el) return;
      const mouse = (window as any).__lastMousePos;
      if (!mouse || mouse.x < 0) return;

      const rect = el.getBoundingClientRect();
      const isInside = (
        mouse.x >= rect.left &&
        mouse.x <= rect.right &&
        mouse.y >= rect.top &&
        mouse.y <= rect.bottom
      );

      if (isInside) {
        setIsHovered(true);
      } else if (!isPlaying) {
        setIsHovered(false);
      }
    };

    window.addEventListener('canvas-styles-restored', checkAndRestoreHover);
    return () => {
      window.removeEventListener('canvas-styles-restored', checkAndRestoreHover);
    };
  }, [isVideo, isPlaying]);

  useEffect(() => {
    if (!isVideo || isZooming) return;
    const el = videoContainerRef.current;
    if (!el) return;
    const mouse = (window as any).__lastMousePos;
    if (!mouse || mouse.x < 0) return;

    const rect = el.getBoundingClientRect();
    const isInside = (
      mouse.x >= rect.left &&
      mouse.x <= rect.right &&
      mouse.y >= rect.top &&
      mouse.y <= rect.bottom
    );

    if (isInside) {
      setIsHovered(true);
    } else if (!isPlaying) {
      setIsHovered(false);
    }
  }, [isVideo, isZooming, isPlaying]);

  const stateRef = useRef({ id, onUpdate });
  stateRef.current = { id, onUpdate };
  const hasRestoredInitialTimeRef = useRef(false);

  useEffect(() => {
    hasRestoredInitialTimeRef.current = false;
  }, [activeVideoSrc]);

  const captureAndSaveVideoState = (video: HTMLVideoElement) => {
    const currTime = video.currentTime;
    const prevPos = getStoredVideoProgress();
    // CRITICAL: Never let 0s or uninitialized mount state overwrite an established valid progress
    if (currTime <= 0.1 && prevPos > 0.5) {
      return;
    }
    if (currTime > 0.1) {
      saveStoredVideoProgress(currTime);
    }
    lastSavedTimeRef.current = currTime;
    const updates: Partial<CardData> = { currentTime: currTime };
    const thumbUrl = generateThumbnail(video);
    if (thumbUrl) {
      updates.thumbnailUrl = thumbUrl;
      thumbCache.set(id, thumbUrl);
      if (imageUrl) thumbCache.set(imageUrl, thumbUrl);
    }
    stateRef.current.onUpdate(stateRef.current.id, updates, false);
  };

  useEffect(() => {
    return () => {
      if (videoRef.current) {
        captureAndSaveVideoState(videoRef.current);
      }
    };
  }, []);

  // Intent-driven lazy restoration for Video Performance
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!isZooming && isPlaying && video.paused) {
      video.play().catch(() => {});
    }
  }, [isZooming, isPlaying]);

  // Ensure playback starts when isPlaying becomes true or video element remounts with updated source
  useEffect(() => {
    if (isPlaying && videoRef.current && videoRef.current.paused) {
      videoRef.current.play().catch(() => {});
    }
  }, [isPlaying, activeVideoSrc]);

  const formatTime = (seconds: number) => {
    if (isNaN(seconds)) return "0:00";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
  };

  // Scale tracking for original high-resolution image swap (only active at extreme zoom > 2.0)
  const [showOriginal, setShowOriginal] = useState(() => {
    const s = scale.get();
    const hasImage = Boolean(data.originalImageUrl || data.imageUrl);
    if (s <= 2.0 || !hasImage) return false;
    const vp = {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      scale: s,
      tx: tx.get(),
      ty: ty.get()
    };
    return isCardIntersectingRectangle(data, vp);
  });
  const showOriginalRef = useRef(showOriginal);
  showOriginalRef.current = showOriginal;

  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;

    const onZoom = () => {
      const currentData = dataRef.current;
      const hasImage = Boolean(currentData.originalImageUrl || currentData.imageUrl);
      if (!hasImage) return;

      // Intent-driven lazy degradation on ZOOM (scaling):
      // Drop back to proxy immediately to save heavy rasterization
      if (showOriginalRef.current) {
        setShowOriginal(false);
      }

      clearTimeout(timeout);
      timeout = setTimeout(() => {
        const s = scale.get();
        if (s <= 2.0 || !hasImage) return;

        const vp = {
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          scale: s,
          tx: tx.get(),
          ty: ty.get()
        };
        if (isCardIntersectingRectangle(currentData, vp)) {
          setShowOriginal(true);
        }
      }, 300);
    };

    const onDrag = () => {
      const currentData = dataRef.current;
      const hasImage = Boolean(currentData.originalImageUrl || currentData.imageUrl);
      if (!hasImage) return;

      // During purely DRAG (panning, tx/ty change):
      // Do NOT degrade immediately! Keep showOriginal as true to maintain sharpness.
      // Simply debounce check viewport intersection to see if we should turn showOriginal off or on.
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        const s = scale.get();
        if (s <= 2.0 || !hasImage) {
          setShowOriginal(false);
          return;
        }

        const vp = {
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          scale: s,
          tx: tx.get(),
          ty: ty.get()
        };
        if (isCardIntersectingRectangle(currentData, vp)) {
          setShowOriginal(true);
        } else {
          setShowOriginal(false);
        }
      }, 300);
    };

    const unsubScale = scale.on('change', onZoom);
    const unsubTx = tx.on('change', onDrag);
    const unsubTy = ty.on('change', onDrag);

    window.addEventListener('resize', onZoom);

    return () => {
      unsubScale();
      unsubTx();
      unsubTy();
      clearTimeout(timeout);
      window.removeEventListener('resize', onZoom);
    };
  }, [scale, tx, ty]);

  const dpr = showOriginal ? Math.min(scale.get(), 8.0) : 1;
  const { width: w, height: h } = getCardSize(data);

  const isAssetCard = Boolean(data.fileName || data.isAsset);
  const isScaleMicro = currentScale < 0.4;

  // Bottom panel container is ALWAYS rendered for generation cards (!isAssetCard)
  const shouldRenderBottomPanel = !isAssetCard;

  // Prompt panel Low LOD exists strictly below 40% in 2D NanoLodCanvas.
  // Once scale >= 40%, DOM cards always render the complete original interactive panel.
  const isLowLodSkeleton = false;
  
  useEffect(() => {
    if (videoRef.current && videoRef.current.readyState >= 2) {
      // video ready
    }
  }, [imageUrl]);
  
  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const scrollHeight = el.scrollHeight;
    el.style.height = `${scrollHeight}px`;
    
    if (scrollHeight >= 300) {
      el.style.overflowY = 'auto';
    } else {
      el.style.overflowY = 'hidden';
    }

    if (mirrorRef.current) {
      mirrorRef.current.scrollTop = el.scrollTop;
    }
  }, []);

  useLayoutEffect(() => {
    if (shouldRenderBottomPanel && !isLowLodSkeleton) {
      adjustTextareaHeight();
      const raf = requestAnimationFrame(adjustTextareaHeight);
      return () => cancelAnimationFrame(raf);
    }
  }, [shouldRenderBottomPanel, isLowLodSkeleton, localPrompt, adjustTextareaHeight]);

  // Track dragging locally for 0-latency, then sync on pointer up
  const posRef = useRef({ x, y });
  const isDragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });
  const slaveNodesRef = useRef<{ el: HTMLElement, initialX: number, initialY: number }[]>([]);
  const totalDx = useRef(0);
  const totalDy = useRef(0);

  useEffect(() => {
    if (!openMenu) return;
    const closeMenu = (e: PointerEvent) => {
      const target = e.target as Node;
      const insideParamMenu = menuContainerRef.current && menuContainerRef.current.contains(target);
      const insideRefMenu = refMenuContainerRef.current && refMenuContainerRef.current.contains(target);
      if (!insideParamMenu && !insideRefMenu) {
        setOpenMenu(prev => {
          if (!prev) return null;
          // If a user clicks, don't close agent's menu
          if (e.isTrusted && prev.ownerId !== 'user') return prev;
          // If an agent clicks, don't close user's menu
          if (!e.isTrusted && prev.ownerId === 'user') return prev;
          
          return null;
        });
      }
    };
    document.addEventListener('pointerdown', closeMenu);
    return () => {
      document.removeEventListener('pointerdown', closeMenu);
    };
  }, [openMenu]);

  // Update transform if external x/y change and not dragging
  useEffect(() => {
    if (!isDragging.current && cardRef.current) {
      posRef.current = { x, y };
      cardRef.current.style.transform = `translate(${x}px, ${y}px)`;
    }
  }, [x, y]);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return; // Only left click
    e.stopPropagation();
    
    isDragging.current = true;
    (window as any).isDraggingCard = true;
    (window as any).draggingCardId = id;
    window.dispatchEvent(new CustomEvent('card-painted', { detail: { cardId: id } }));

    // Synchronously pause all active videos to free hardware decoders during drag
    try {
      const allVideos = document.querySelectorAll('video');
      allVideos.forEach(v => {
        if (!v.paused) {
          v.pause();
          v.setAttribute('data-was-playing', 'true');
        }
      });
    } catch (err) {
      console.warn('Failed to pause background videos:', err);
    }

    lastPos.current = { x: e.clientX, y: e.clientY };
    totalDx.current = 0;
    totalDy.current = 0;

    // Instant video physical unmount on drag click to release GPU decoding immediately
    if (isHovered) {
      setIsHovered(false);
    }

    let didApplyDegrade = false;

    // Build slave nodes list
    if (isSelected) {
      const slaves: { el: HTMLElement, initialX: number, initialY: number }[] = [];
      const nodes = document.querySelectorAll('[data-card-id][data-selected="true"]');
      nodes.forEach(node => {
        if (node !== cardRef.current) {
          const el = node as HTMLElement;
          const transform = el.style.transform;
          const match = transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
          if (match) {
            slaves.push({ el, initialX: parseFloat(match[1]), initialY: parseFloat(match[2]) });
          }
        }
      });
      slaveNodesRef.current = slaves;
    } else {
      slaveNodesRef.current = [];
    }

    const handleWindowPointerMove = (moveEvent: PointerEvent) => {
      if (!isDragging.current) return;
      
      const currentScale = scale.get();
      const dx = (moveEvent.clientX - lastPos.current.x) / currentScale;
      const dy = (moveEvent.clientY - lastPos.current.y) / currentScale;
      lastPos.current = { x: moveEvent.clientX, y: moveEvent.clientY };
      
      posRef.current.x += dx;
      posRef.current.y += dy;
      totalDx.current += dx;
      totalDy.current += dy;

      // Lazy Degradation: Apply heavy style removal & global class toggle ONLY when actual movement starts!
      if (!didApplyDegrade && Math.hypot(totalDx.current, totalDy.current) > 1.5) {
        didApplyDegrade = true;

        const workspace = document.getElementById('canvas-workspace');
        if (workspace) {
          workspace.setAttribute('data-gesture', 'true');
        }

        // Apply performance classes directly to the DOM for all dragged nodes
        const selectedNodes = isSelected
          ? document.querySelectorAll('[data-card-id][data-selected="true"]')
          : [cardRef.current];

        selectedNodes.forEach(node => {
          const el = node as HTMLElement;
          if (el) {
            el.classList.add('will-change-transform');
            const bottomPanel = el.querySelector('.generation-card-bottom-panel');
            if (bottomPanel) bottomPanel.classList.add('drag-degraded');
            const cardBody = el.querySelector('.generation-card-body');
            if (cardBody) cardBody.classList.add('drag-degraded');
          }
        });
      }

      // Update transient global drag delta for React-DOM seamless coordinate synchronization
      (window as any).__dragDelta = {
        dx: totalDx.current,
        dy: totalDy.current,
        draggingCardId: id
      };
      
      if (cardRef.current) {
        cardRef.current.style.transform = `translate(${posRef.current.x}px, ${posRef.current.y}px)`;
      }
      
      slaveNodesRef.current.forEach(slave => {
        slave.el.style.transform = `translate(${slave.initialX + totalDx.current}px, ${slave.initialY + totalDy.current}px)`;
      });
      window.dispatchEvent(new CustomEvent('card-drag-move'));
    };

    const handleWindowPointerUp = (upEvent: PointerEvent) => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);

      // Clean up the transient global drag delta registry immediately
      (window as any).__dragDelta = null;
      (window as any).isDraggingCard = false;
      (window as any).draggingCardId = null;
      window.dispatchEvent(new CustomEvent('card-painted', { detail: { cardId: id } }));
      window.dispatchEvent(new CustomEvent('card-drag-move'));

      if (isDragging.current) {
        isDragging.current = false;

        const movedDistance = Math.hypot(totalDx.current, totalDy.current);
        if (movedDistance > 2) {
          // Drag occurred: Maintain persistent degradation & arm absolute idle fallback (2000ms)
          if (typeof (window as any).resetGlobalZoomTimer === 'function') {
            (window as any).resetGlobalZoomTimer();
          }

          if (onDragEnd) {
            onDragEnd(id, totalDx.current, totalDy.current);
          } else {
            onUpdate(id, { x: posRef.current.x, y: posRef.current.y }, true);
          }
        } else {
          // Pure click intent: Instantly restore styles and cleanup
          (window as any).isDraggingCard = false;
          const workspace = document.getElementById('canvas-workspace');
          if (workspace) {
            workspace.removeAttribute('data-gesture');
          }

          // Cleanup Direct DOM Performance Classes
          const allCardNodes = document.querySelectorAll('[data-card-id]');
          allCardNodes.forEach(node => {
            const el = node as HTMLElement;
            el.classList.remove('will-change-transform');
            const bottomPanel = el.querySelector('.generation-card-bottom-panel');
            if (bottomPanel) {
              bottomPanel.classList.remove('drag-degraded');
            }
            const cardBody = el.querySelector('.generation-card-body');
            if (cardBody) {
              cardBody.classList.remove('drag-degraded');
            }
          });

          // Reset to exact original position if slight jitter happened without meaningful drag
          posRef.current = { x, y };
          if (cardRef.current) {
            cardRef.current.style.transform = `translate(${x}px, ${y}px)`;
          }
          slaveNodesRef.current.forEach(slave => {
            slave.el.style.transform = `translate(${slave.initialX}px, ${slave.initialY}px)`;
          });
          // Select only this card (deselect others) since no drag occurred
          onSelect?.(upEvent as any, id, true);
        }
      }
    };

    window.addEventListener('pointermove', handleWindowPointerMove, { passive: true });
    window.addEventListener('pointerup', handleWindowPointerUp);
  };

  const handleContainerPointerDown = (e: React.PointerEvent) => {
    // Prevent middle click from focusing or interacting with card content
    // so it smoothly falls through to the canvas drag handler
    if (e.button === 1) {
      e.preventDefault();
      return;
    }
    if (e.button === 0) {
      onSelect?.(e, id);
    }
  };

  const handleGenerate = async () => {
    const promptToGen = localPrompt.trim();
    if (!promptToGen) return;

    // Check if the current card already has an image/video completed
    const hasExistingMedia = Boolean(data.imageUrl || data.originalImageUrl || data.fileData);

    // If card already has an existing result and not currently generating:
    // Auto-fork a new card with the modified config and immediately start generation!
    if (hasExistingMedia && state !== 'generating' && onForkCard) {
      // 1. Pack the new user-edited configurations for the newly forked card
      const newForkConfig: Partial<CardData> = {
        prompt: promptToGen,
        ratio: ratio,
        res: res,
        mcpModel: data.mcpModel || selectedMcpModel?.id,
        mcpToolName: (selectedMcpModel as any)?.toolName || data.mcpToolName || defaultMcpToolName || (data.isVideo ? WORKRALLY_VIDEO_TOOL : WORKRALLY_IMAGE_TOOL),
        mcpParameters: data.mcpParameters ? { ...data.mcpParameters } : undefined,
        referenceImages: data.referenceImages ? data.referenceImages.map(r => ({ ...r })) : [],
        referenceImageUrl: data.referenceImageUrl,
        referenceImageName: data.referenceImageName,
        referenceImageFileData: data.referenceImageFileData,
        isVideo: !!data.isVideo,
      };

      // 2. Retrieve the baseline prompt of the current completed card for immediate local textarea sync
      const baseline = data.baselineConfig || baselineConfigRef.current;
      const restoredPrompt = baseline?.prompt || '';

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      isTypingRef.current = false;

      setLocalPrompt(restoredPrompt);
      localPromptRef.current = restoredPrompt;
      if (textareaRef.current) {
        textareaRef.current.value = restoredPrompt;
        textareaRef.current.blur();
      }

      // Fork a new card to generate the new configuration and atomically restore the source card!
      onForkCard(id, newForkConfig, true);
      return;
    }
    
    // Ensure prompt is committed
    commitPrompt(localPrompt);
    
    onUpdate(id, { state: 'generating', generationError: undefined, mcpTaskId: undefined }, true);

    try {
      const activeMcp = await getActiveMcpKey();
      
      // Normalize reference images
      const effectiveRefImages = data.referenceImages && data.referenceImages.length > 0
        ? data.referenceImages
        : data.referenceImageUrl
          ? [{ url: data.referenceImageUrl, name: data.referenceImageName, fileData: data.referenceImageFileData }]
          : [];

      if (selectedVideoModel?.mode === 'SubjectToVideo' && effectiveRefImages.length === 0) {
        throw new Error('Rally-Video 需要至少一张参考图');
      }

      if (activeMcp && activeMcp.token) {
        // Prepare reference image data/URLs with client-side compression to avoid oversized payloads
        const refPayloads: string[] = [];
        for (const ref of effectiveRefImages) {
          const payload = await resolveReferenceToPayload(ref, allCards);
          if (payload) {
            refPayloads.push(payload);
          }
        }

        const resResult = await fetch('/api/mcp/workrally/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: activeMcp.token,
            serverUrl: activeMcp.serverUrl,
            prompt: promptToGen,
            ratio: ratio,
            res: res,
            isVideo: !!data.isVideo,
            referenceImages: refPayloads,
            toolName: (selectedMcpModel as any)?.toolName || data.mcpToolName || defaultMcpToolName || (data.isVideo ? WORKRALLY_VIDEO_TOOL : WORKRALLY_IMAGE_TOOL),
            model: data.mcpModel || selectedMcpModel?.id || (data.isVideo ? WORKRALLY_VIDEO_MODELS[0].id : WORKRALLY_IMAGE_MODELS[0].id),
            parameters: {
              ...(data.mcpParameters || {}),
              ...(data.isVideo ? {
                mode: selectedVideoModel?.mode || 'Text',
                duration: Number(data.mcpParameters?.duration || selectedVideoModel?.durations?.[0] || 5),
                enable_sound: selectedVideoModel?.supportAudio ? data.mcpParameters?.enable_sound !== false : false,
              } : {}),
              ...(Array.isArray(selectedMcpModel.resolutions) && selectedMcpModel.resolutions.find((option: any) => (typeof option === 'object' ? option.label : option) === res)
                ? { resolution: (selectedMcpModel.resolutions.find((option: any) => (typeof option === 'object' ? option.label : option) === res) as any)?.value ?? res }
                : {}),
            },
            defer: true,
          })
        });

        const parsed = await safeParseJsonResponse(resResult);
        if (!parsed.success) {
          throw new Error(parsed.error || '生成服务响应异常');
        }
        const result = parsed.data;

        if (resResult.ok && result.success && result.pending && result.taskIds?.[0]) {
          onUpdate(id, {
            mcpTaskId: result.taskIds[0],
            state: 'generating',
            generationError: undefined,
          }, true);
          return;
        }
        if (resResult.ok && result.success && result.mediaUrl) {
          let thumb: string | undefined;
          if (data.isVideo) {
            try {
              thumb = await generateVideoThumbnail(result.mediaUrl, MAX_THUMBNAIL_EDGE);
              if (thumb) {
                setLocalThumbnailUrl(thumb);
                thumbCache.set(id, thumb);
                thumbCache.set(result.mediaUrl, thumb);
              }
            } catch (e) {
              console.warn('Auto video thumb generation in handleGenerate error:', e);
            }
          }
          const currentCompletedConfig: CardBaselineConfig = {
            prompt: promptToGen,
            ratio: ratio,
            res: res,
            mcpModel: data.mcpModel || selectedMcpModel?.id,
            mcpToolName: (selectedMcpModel as any)?.toolName || data.mcpToolName || defaultMcpToolName || (data.isVideo ? WORKRALLY_VIDEO_TOOL : WORKRALLY_IMAGE_TOOL),
            mcpParameters: data.mcpParameters ? { ...data.mcpParameters } : undefined,
            referenceImages: data.referenceImages ? data.referenceImages.map(r => ({ ...r })) : [],
            referenceImageUrl: data.referenceImageUrl,
            referenceImageName: data.referenceImageName,
            referenceImageFileData: data.referenceImageFileData,
          };
          baselineConfigRef.current = currentCompletedConfig;
          baselinePromptRef.current = promptToGen;
          onUpdate(id, { 
            imageUrl: result.mediaUrl,
            isVideo: result.isVideo ?? data.isVideo,
            ...(thumb ? { thumbnailUrl: thumb } : {}),
            state: 'completed',
            lastGeneratedPrompt: promptToGen,
            baselineConfig: currentCompletedConfig,
            mcpTaskId: result.taskIds?.[0],
            generationError: undefined,
          }, true);
          return;
        } else {
          const errMsg = result.error || '生成失败，请稍后重试';
          console.warn('MCP Model generation failed:', errMsg);
          onUpdate(id, { state: 'draft', generationError: errMsg }, true);
          return;
        }
      }

      // Fallback demo generation if no MCP token is configured yet
      setTimeout(() => {
        onUpdate(id, { 
          imageUrl: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=800&auto=format&fit=crop",
          state: 'completed'
        }, true);
      }, 2000);
    } catch (e: any) {
      console.error('Generation call error:', e);
      const userFacingError = e?.message?.includes('Failed to fetch')
        ? '网络请求失败，请检查网络连接或 MCP 服务配置'
        : (e?.message || '生成失败，请稍后重试');
      onUpdate(id, { state: 'draft', generationError: userFacingError }, true);
    }
  };

  const refreshVideoUrl = async (force = false) => {
    const taskId = data.mcpTaskId || data.imageUrl?.match(/(2k[a-z0-9]{6,16})/i)?.[1] || data.imageUrl?.match(/\/(2k[a-z0-9]+)_MAIN_/i)?.[1];
    if (!taskId) {
      setVideoHasError(true);
      setVideoLoadError('缺少关联任务 ID，无法重新获取视频地址');
      return;
    }
    if (isRefreshingVideoRef.current) return;
    if (!force && refreshedVideoUrlRef.current === data.imageUrl) return;
    
    isRefreshingVideoRef.current = true;
    refreshedVideoUrlRef.current = data.imageUrl || null;
    try {
      const activeMcp = await getActiveMcpKey();
      if (!activeMcp?.token) {
        setVideoHasError(true);
        setVideoLoadError('请先配置 WorkRally MCP 密钥以刷新视频地址');
        return;
      }
      let response: Response;
      try {
        response = await fetch('/api/mcp/workrally/task', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: activeMcp.token, serverUrl: activeMcp.serverUrl, taskId, isVideo: true }),
        });
      } catch (fetchError: any) {
        const fetchMsg = fetchError?.message || '网络连接异常';
        console.warn('MCP video URL refresh network issue:', fetchMsg);
        setVideoHasError(true);
        setVideoLoadError(`网络请求失败：${fetchMsg}`);
        return;
      }

      const parsed = await safeParseJsonResponse(response);
      if (!parsed.success || !response.ok) {
        const errorDetail = parsed.error || `视频链接刷新失败 (${response.status})`;
        console.warn('MCP video URL refresh failed:', errorDetail);
        setVideoHasError(true);
        setVideoLoadError(errorDetail);
        return;
      }
      const result = parsed.data;
      if (result.completed && result.mediaUrl) {
        setVideoHasError(false);
        setVideoLoadError('');
        onUpdateRef.current(id, {
          imageUrl: result.mediaUrl,
          isVideo: true,
          state: 'completed',
          mcpTaskId: taskId,
          generationError: undefined,
        }, true);
      } else if (result.pending) {
        setVideoHasError(false);
        setVideoLoadError('');
      } else if (result.failed) {
        setVideoHasError(true);
        setVideoLoadError(result.error || '视频生成失败');
      } else if (result.mediaUrl) {
        setVideoHasError(false);
        setVideoLoadError('');
        onUpdateRef.current(id, {
          imageUrl: result.mediaUrl,
          isVideo: true,
          state: 'completed',
          mcpTaskId: taskId,
          generationError: undefined,
        }, true);
      } else {
        const errorDetail = result.error || '未获取到有效视频链接';
        setVideoHasError(true);
        setVideoLoadError(errorDetail);
      }
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn('MCP video URL refresh warning:', msg);
      setVideoHasError(true);
      setVideoLoadError(msg || '视频加载失败');
    } finally {
      isRefreshingVideoRef.current = false;
    }
  };

  useEffect(() => {
    setVideoHasError(false);
  }, [data.imageUrl]);

  const handleLocalUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const objectUrl = URL.createObjectURL(file);
    const prevRefs = data.referenceImages && data.referenceImages.length > 0
      ? [...data.referenceImages]
      : data.referenceImageUrl ? [{ url: data.referenceImageUrl, name: data.referenceImageName, fileData: data.referenceImageFileData }] : [];

    Promise.all([
      generateImageThumbnail(file, 64, 0.90),
      generateImageThumbnail(file, 128, 0.90),
      generateImageThumbnail(file, 256, 0.90)
    ]).then(([micro, full, closeup]) => {
      thumbCache.set(objectUrl, closeup);
      onUpdate(id, {
        referenceImages: [
          ...prevRefs,
          {
            url: objectUrl,
            thumbnailUrl: closeup,
            microLodThumbnailUrl: micro,
            fullDetailThumbnailUrl: full,
            closeupThumbnailUrl: closeup,
            name: file.name,
            fileData: file
          }
        ],
        referenceImageUrl: objectUrl,
        referenceImageFileData: file,
        referenceImageName: prevRefs.length > 0 ? `参考图 (${prevRefs.length + 1})` : file.name
      }, true);
    }).catch(() => {
      onUpdate(id, {
        referenceImages: [...prevRefs, { url: objectUrl, name: file.name, fileData: file }],
        referenceImageUrl: objectUrl,
        referenceImageFileData: file,
        referenceImageName: prevRefs.length > 0 ? `参考图 (${prevRefs.length + 1})` : file.name
      }, true);
    });

    e.target.value = '';
    setOpenMenu(null);
  };

  const handleSelectAsset = (asset: { name: string; referenceImage?: string; description?: string }) => {
    const prevRefs = data.referenceImages && data.referenceImages.length > 0
      ? [...data.referenceImages]
      : data.referenceImageUrl ? [{ url: data.referenceImageUrl, name: data.referenceImageName, fileData: data.referenceImageFileData }] : [];
    const url = asset.referenceImage || '';
    if (url) {
      Promise.all([
        generateImageThumbnail(url, 64, 0.90).catch(() => ''),
        generateImageThumbnail(url, 128, 0.90).catch(() => ''),
        generateImageThumbnail(url, 256, 0.90).catch(() => '')
      ]).then(([micro, full, closeup]) => {
        const newRef = {
          url,
          thumbnailUrl: closeup || undefined,
          microLodThumbnailUrl: micro || undefined,
          fullDetailThumbnailUrl: full || undefined,
          closeupThumbnailUrl: closeup || undefined,
          name: asset.name
        };
        const updates: Partial<CardData> = {
          referenceImages: [...prevRefs, newRef],
          referenceImageUrl: url,
          referenceImageName: prevRefs.length > 0 ? `参考图 (${prevRefs.length + 1})` : asset.name,
          referenceImageFileData: undefined
        };
        if (!localPrompt.trim() && asset.description) {
          setLocalPrompt(asset.description);
          updates.prompt = asset.description;
        }
        onUpdate(id, updates, true);
      });
    } else {
      const updates: Partial<CardData> = {
        referenceImages: prevRefs,
        referenceImageUrl: data.referenceImageUrl || null,
        referenceImageName: prevRefs.length > 0 ? `参考图 (${prevRefs.length + 1})` : asset.name,
        referenceImageFileData: undefined
      };
      if (!localPrompt.trim() && asset.description) {
        setLocalPrompt(asset.description);
        updates.prompt = asset.description;
      }
      onUpdate(id, updates, true);
    }
    setShowAssetPicker(false);
  };

  const removeReferenceImage = (indexToRemove: number) => {
    const prevRefs = data.referenceImages && data.referenceImages.length > 0
      ? [...data.referenceImages]
      : data.referenceImageUrl ? [{ url: data.referenceImageUrl, name: data.referenceImageName, fileData: data.referenceImageFileData }] : [];
    const updated = prevRefs.filter((_, idx) => idx !== indexToRemove);
    if (updated.length === 0) {
      onUpdate(id, {
        referenceImages: [],
        referenceImageUrl: null,
        referenceImageFileData: undefined,
        referenceImageName: undefined
      }, true);
    } else {
      onUpdate(id, {
        referenceImages: updated,
        referenceImageUrl: updated[0].url,
        referenceImageName: updated.length > 1 ? `参考图 (${updated.length})` : updated[0].name,
        referenceImageFileData: updated[0].fileData
      }, true);
    }
  };

  const handleDownloadMedia = async (e: React.MouseEvent | React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();

    const isVideo = Boolean(data.isVideo);
    const ext = isVideo ? 'mp4' : 'png';
    const cleanPrompt = data.prompt ? data.prompt.slice(0, 24).replace(/[^\w\u4e00-\u9fa5]/g, '_') : 'media';
    const filename = `${data.fileName ? data.fileName.replace(/\.[^/.]+$/, "") : cleanPrompt}_${Date.now()}.${ext}`;

    const triggerDownload = (url: string, downloadName: string) => {
      const a = document.createElement('a');
      a.href = url;
      a.download = downloadName;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    };

    // 1. Direct local Blob in data.fileData
    if (data.fileData instanceof Blob) {
      const blobUrl = URL.createObjectURL(data.fileData);
      triggerDownload(blobUrl, filename);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
      return;
    }

    // 2. Active video or image source
    const mediaSrc = blobVideoUrl || videoPlaySrc || imageUrl || data.originalImageUrl;
    if (!mediaSrc) return;

    if (mediaSrc.startsWith('blob:')) {
      triggerDownload(mediaSrc, filename);
      return;
    }

    // 3. Try direct fetch for same-origin or CORS-enabled URLs
    try {
      const response = await fetch(mediaSrc);
      if (response.ok) {
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        triggerDownload(blobUrl, filename);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
        return;
      }
    } catch {
      // Direct fetch failed (likely CORS restriction on external domain)
    }

    // 4. Fallback: Fetch via same-origin media proxy endpoint
    if (/^https?:\/\//i.test(mediaSrc)) {
      try {
        const proxyUrl = `/api/mcp/workrally/proxy-media?url=${encodeURIComponent(mediaSrc)}`;
        const response = await fetch(proxyUrl);
        if (response.ok) {
          const blob = await response.blob();
          const blobUrl = URL.createObjectURL(blob);
          triggerDownload(blobUrl, filename);
          setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
          return;
        }
      } catch {
        // Proxy fetch failed
      }
    }

    // 5. Direct link download fallback
    triggerDownload(mediaSrc, filename);
  };

  // Asset list items (Only computed when Asset Picker modal is opened)
  const { characterItems, locationItems, propItems, allAssetItems, filteredAssets } = useMemo(() => {
    if (!showAssetPicker) {
      return {
        characterItems: [] as Array<{ id: string; category: 'characters'; categoryLabel: string; name: string; tag: string; description: string; referenceImage?: string }>,
        locationItems: [] as Array<{ id: string; category: 'locations'; categoryLabel: string; name: string; tag: string; description: string; referenceImage?: string }>,
        propItems: [] as Array<{ id: string; category: 'props'; categoryLabel: string; name: string; tag: string; description: string; referenceImage?: string }>,
        allAssetItems: [] as Array<{ id: string; category: 'characters' | 'locations' | 'props'; categoryLabel: string; name: string; tag: string; description: string; referenceImage?: string }>,
        filteredAssets: [] as Array<{ id: string; category: 'characters' | 'locations' | 'props'; categoryLabel: string; name: string; tag: string; description: string; referenceImage?: string }>
      };
    }
    const chars = (currentProject?.characters || []).map(c => ({
      id: `char-${c.id}`,
      category: 'characters' as const,
      categoryLabel: '角色',
      name: c.name,
      tag: c.role || '角色设定',
      description: c.appearance || c.performanceNotes || '',
      referenceImage: c.referenceImage
    }));
    const locs = (currentProject?.locations || []).map(l => ({
      id: `loc-${l.id}`,
      category: 'locations' as const,
      categoryLabel: '场景',
      name: l.name,
      tag: `${l.type === 'INT' ? '内景' : '外景'}${l.timeOfDay ? ` · ${l.timeOfDay}` : ''}`,
      description: l.atmosphere || l.visualDetails || '',
      referenceImage: l.referenceImage
    }));
    const props = (currentProject?.props || []).map(p => ({
      id: `prop-${p.id}`,
      category: 'props' as const,
      categoryLabel: '道具',
      name: p.name,
      tag: p.owner ? `归属: ${p.owner}` : '道具',
      description: p.materialAndState || p.storySignificance || '',
      referenceImage: p.referenceImage
    }));
    const all = [...chars, ...locs, ...props];
    const q = assetSearch.trim().toLowerCase();
    const filtered = all.filter(item => {
      const matchesFilter = assetFilter === 'all' || item.category === assetFilter;
      const matchesSearch = !q || item.name.toLowerCase().includes(q) || item.tag.toLowerCase().includes(q) || item.description.toLowerCase().includes(q);
      return matchesFilter && matchesSearch;
    });
    return {
      characterItems: chars,
      locationItems: locs,
      propItems: props,
      allAssetItems: all,
      filteredAssets: filtered
    };
  }, [showAssetPicker, currentProject, assetFilter, assetSearch]);

  const canvasCandidates = (allCards || []).filter(c => 
    c.id !== id && Boolean(c.imageUrl || c.originalImageUrl || c.thumbnailUrl)
  );

  // Normalized list of references for display
  const refList = data.referenceImages && data.referenceImages.length > 0
    ? data.referenceImages
    : data.referenceImageUrl
      ? [{ url: data.referenceImageUrl, name: data.referenceImageName, fileData: data.referenceImageFileData }]
      : [];

  // All candidate references and assets (unfiltered for prompt highlighting and parsing)
  const allMentionItems = useMemo(() => {
    const items: Array<{
      id: string;
      name: string;
      url?: string;
      thumbnailUrl?: string;
      fullDetailThumbnailUrl?: string;
      fileData?: Blob;
      source: 'current' | 'character' | 'location' | 'prop';
      subtitle?: string;
    }> = [];

    // 1. Current card reference images
    refList.forEach((r, idx) => {
      const name = r.name || `参考图 ${idx + 1}`;
      if (!items.some(it => it.name === name)) {
        items.push({
          id: `current-ref-${idx}`,
          name,
          url: r.url,
          thumbnailUrl: r.fullDetailThumbnailUrl || r.thumbnailUrl,
          fullDetailThumbnailUrl: r.fullDetailThumbnailUrl,
          fileData: r.fileData,
          source: 'current',
          subtitle: '当前卡片参考图',
        });
      }
    });

    // 2. Project Characters
    (currentProject?.characters || []).forEach(c => {
      if (!items.some(it => it.name === c.name)) {
        items.push({
          id: `char-${c.id}`,
          name: c.name,
          url: c.referenceImage,
          thumbnailUrl: c.referenceImage,
          source: 'character',
          subtitle: c.role || '角色',
        });
      }
    });

    // 3. Project Locations
    (currentProject?.locations || []).forEach(l => {
      if (!items.some(it => it.name === l.name)) {
        items.push({
          id: `loc-${l.id}`,
          name: l.name,
          url: l.referenceImage,
          thumbnailUrl: l.referenceImage,
          source: 'location',
          subtitle: '场景',
        });
      }
    });

    // 4. Project Props
    (currentProject?.props || []).forEach(p => {
      if (!items.some(it => it.name === p.name)) {
        items.push({
          id: `prop-${p.id}`,
          name: p.name,
          url: p.referenceImage,
          thumbnailUrl: p.referenceImage,
          source: 'prop',
          subtitle: '道具',
        });
      }
    });

    return items;
  }, [refList, currentProject]);

  // Filtered mention candidates strictly for the suggestion popup menu
  const filteredMentionCandidates = useMemo(() => {
    if (!mentionQuery.trim()) return allMentionItems;
    const q = mentionQuery.toLowerCase();
    return allMentionItems.filter(it => it.name.toLowerCase().includes(q) || (it.subtitle && it.subtitle.toLowerCase().includes(q)));
  }, [allMentionItems, mentionQuery]);

  // Insert mention into prompt with exact spacing: "前后分别空一格"
  const insertMention = (refItem: { name: string; url?: string; fileData?: Blob }) => {
    const refName = refItem.name;
    const textarea = textareaRef.current;
    const currentPrompt = localPrompt || '';
    const cursor = textarea?.selectionStart ?? currentPrompt.length;

    const textBeforeCursor = currentPrompt.slice(0, cursor);
    const textAfterCursor = currentPrompt.slice(cursor);
    const match = textBeforeCursor.match(/@([^\s@]*)$/);

    let prefix = '';
    let suffix = textAfterCursor;

    if (match && match.index !== undefined) {
      prefix = textBeforeCursor.slice(0, match.index);
    } else {
      prefix = textBeforeCursor;
    }

    // Ensure "前后分别空一格":
    const needsSpaceBefore = prefix.length > 0 && !/\s$/.test(prefix);
    const needsSpaceAfter = !/^\s/.test(suffix);

    const spaceBefore = needsSpaceBefore ? ' ' : '';
    const spaceAfter = needsSpaceAfter ? ' ' : '';

    const mentionText = `${spaceBefore}@${refName}${spaceAfter}`;
    const newPrompt = `${prefix}${mentionText}${suffix}`;

    setLocalPrompt(newPrompt);

    // If item is not in refList and has a URL, automatically attach it to referenceImages
    const alreadyInRef = refList.some(r => r.name === refName || (r.url && r.url === refItem.url));
    const updates: Partial<CardData> = { prompt: newPrompt };

    if (!alreadyInRef && refItem.url) {
      const prevRefs = data.referenceImages && data.referenceImages.length > 0
        ? [...data.referenceImages]
        : data.referenceImageUrl
          ? [{ url: data.referenceImageUrl, name: data.referenceImageName, fileData: data.referenceImageFileData }]
          : [];
      const url = refItem.url;
      Promise.all([
        generateImageThumbnail(url, 64, 0.90).catch(() => ''),
        generateImageThumbnail(url, 128, 0.90).catch(() => ''),
        generateImageThumbnail(url, 256, 0.90).catch(() => '')
      ]).then(([micro, full, closeup]) => {
        const newRef = {
          url,
          thumbnailUrl: closeup || undefined,
          microLodThumbnailUrl: micro || undefined,
          fullDetailThumbnailUrl: full || undefined,
          closeupThumbnailUrl: closeup || undefined,
          name: refItem.name,
          fileData: refItem.fileData
        };
        const upd: Partial<CardData> = {
          ...updates,
          referenceImages: [...prevRefs, newRef],
          referenceImageUrl: prevRefs.length === 0 ? url : data.referenceImageUrl,
          referenceImageName: prevRefs.length === 0 ? refItem.name : data.referenceImageName
        };
        onUpdate(id, upd);
      });
    } else {
      onUpdate(id, updates);
    }

    setMentionMenuOpen(false);

    // Restore focus and cursor position after insertion
    setTimeout(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        const newCursor = prefix.length + mentionText.length;
        textareaRef.current.setSelectionRange(newCursor, newCursor);
      }
    }, 10);
  };

  // Close mention menu when clicking outside
  useEffect(() => {
    if (!mentionMenuOpen) return;

    const handlePointerDownOutside = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (mentionMenuRef.current && mentionMenuRef.current.contains(target)) {
        return;
      }
      if (textareaRef.current && textareaRef.current.contains(target)) {
        return;
      }
      setMentionMenuOpen(false);
    };

    document.addEventListener('mousedown', handlePointerDownOutside);
    document.addEventListener('touchstart', handlePointerDownOutside);
    return () => {
      document.removeEventListener('mousedown', handlePointerDownOutside);
      document.removeEventListener('touchstart', handlePointerDownOutside);
    };
  }, [mentionMenuOpen]);

  const checkCursorMention = (val: string, cursor: number) => {
    const textBeforeCursor = val.slice(0, cursor);
    const match = textBeforeCursor.match(/@([^\s@]*)$/);
    if (match) {
      const query = match[1];
      // Check if this is already an exact completed mention name
      const isExactCompleted = query.length > 0 && allMentionItems.some(item => item.name === query);
      if (!isExactCompleted) {
        setMentionMenuOpen(true);
        setMentionQuery(query);
        setSelectedMentionIndex(0);
        return;
      }
    }
    setMentionMenuOpen(false);
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    const cursor = e.target.selectionStart;
    isTypingRef.current = true;
    setLocalPrompt(val);

    // Debounce syncing upstream to App.tsx & IndexedDB
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    debounceTimerRef.current = setTimeout(() => {
      onUpdate(id, { prompt: val }, false);
      debounceTimerRef.current = null;
    }, 250);

    checkCursorMention(val, cursor);
  };

  const handleTextareaBlur = () => {
    isTypingRef.current = false;
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
      onUpdate(id, { prompt: localPromptRef.current }, false);
    }
  };

  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionMenuOpen && filteredMentionCandidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedMentionIndex(prev => (prev + 1) % filteredMentionCandidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedMentionIndex(prev => (prev - 1 + filteredMentionCandidates.length) % filteredMentionCandidates.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const selected = filteredMentionCandidates[selectedMentionIndex];
        if (selected) {
          insertMention(selected);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionMenuOpen(false);
        return;
      }
    }

    // Atomic Backspace for @ reference mentions ("退格删除参考图任意一个字符时触发")
    if (e.key === 'Backspace') {
      const textarea = textareaRef.current;
      if (textarea && textarea.selectionStart === textarea.selectionEnd) {
        const cursor = textarea.selectionStart;
        const currentPrompt = localPrompt || '';

        // Find all reference mentions in currentPrompt
        const candidateNames = allMentionItems
          .map(c => c.name)
          .filter(Boolean)
          .sort((a, b) => b.length - a.length);

        let targetMention: { start: number; deleteEnd: number } | null = null;

        // Check mentions strictly from valid candidateNames
        if (candidateNames.length > 0) {
          const escapedNames = candidateNames
            .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('|');
          const regex = new RegExp(`@(?:${escapedNames})`, 'g');
          let m: RegExpExecArray | null;

          while ((m = regex.exec(currentPrompt)) !== null) {
            const start = m.index;
            const nameEnd = start + m[0].length;

            // Trigger atomic backspace strictly when backspacing would delete any character of the reference name itself:
            // cursor - 1 is a character of the reference name (between start + 1 and nameEnd).
            // Any deletion in subsequent prompt text or trailing spaces is handled normally by native backspace.
            if (cursor > start + 1 && cursor <= nameEnd) {
              targetMention = { start, deleteEnd: nameEnd };
              break;
            }
          }
        }

        if (targetMention) {
          e.preventDefault();

          // Retain the '@' symbol: delete the reference name, leaving '@' and keeping all other prompt content
          const newCursor = targetMention.start + 1;
          const newPrompt = currentPrompt.slice(0, newCursor) + currentPrompt.slice(targetMention.deleteEnd);
          commitPrompt(newPrompt);

          // Re-open mention candidates menu at the retained @ symbol with empty query
          setMentionMenuOpen(true);
          setMentionQuery('');
          setSelectedMentionIndex(0);

          // Position cursor directly after the preserved @ symbol
          setTimeout(() => {
            if (textareaRef.current) {
              textareaRef.current.focus();
              textareaRef.current.setSelectionRange(newCursor, newCursor);
            }
          }, 0);
          return;
        }
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleGenerate();
      return;
    }
  };

  // Close mention menu when clicking outside
  useEffect(() => {
    if (!mentionMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        mentionMenuRef.current &&
        !mentionMenuRef.current.contains(e.target as Node) &&
        textareaRef.current &&
        !textareaRef.current.contains(e.target as Node)
      ) {
        setMentionMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [mentionMenuOpen]);

  // Render prompt with mentions highlighted in blue
  const renderHighlightedPrompt = (text: string) => {
    if (!text) return null;

    // Use full list of candidate references so typing never filters out highlights
    const names = allMentionItems
      .map(c => c.name)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);

    if (names.length === 0) {
      return <span>{text}</span>;
    }

    const escapedNames = names
      .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');

    // Match exact @Name references without requiring trailing lookahead so typing directly after never breaks highlight
    const pattern = new RegExp(`(@(?:${escapedNames}))`, 'g');
    const validMentionTags = new Set(names.map(n => `@${n}`));

    const parts = text.split(pattern);

    return parts.map((part, i) => {
      // Only highlight if it matches an actual reference and is not a bare '@'
      if (validMentionTags.has(part)) {
        return (
          <span
            key={i}
            className="text-[#2563eb] dark:text-blue-400 font-medium bg-blue-500/15 dark:bg-blue-400/20 rounded-xs"
          >
            {part}
          </span>
        );
      }
      return <span key={i}>{part}</span>;
    });
  };

  let resolutionTag = '';
  if (data.nativeWidth && data.nativeHeight) {
    const maxDim = Math.max(data.nativeWidth, data.nativeHeight);
    const minDim = Math.min(data.nativeWidth, data.nativeHeight);
    if (data.isVideo) {
      if (minDim >= 2160 || maxDim >= 3840) resolutionTag = '4K';
      else if (minDim >= 1080) resolutionTag = '1080p';
      else if (minDim >= 720) resolutionTag = '720p';
      else resolutionTag = '480p';
    } else {
      if (maxDim >= 4000) resolutionTag = '4K+';
      else if (maxDim >= 3840) resolutionTag = '4K';
      else if (maxDim >= 2048) resolutionTag = '2K';
      else resolutionTag = '1K';
    }
  } else {
    // Fallback based on data.res
    if (data.isVideo) {
      if (data.res === '4K') resolutionTag = '4K';
      else if (data.res === '2K') resolutionTag = '1080p';
      else resolutionTag = '720p';
    } else {
      if (data.res === '4K') resolutionTag = '4K';
      else if (data.res === '2K') resolutionTag = '2K';
      else resolutionTag = '1K';
    }
  }

  const mcpModels = dynamicMcpModels && dynamicMcpModels.length > 0
    ? dynamicMcpModels
    : (data.isVideo ? WORKRALLY_VIDEO_MODELS : WORKRALLY_IMAGE_MODELS);
  const selectedMcpModel = mcpModels.find(model => model.id === data.mcpModel || model.name === data.mcpModel) || mcpModels[0] || (data.isVideo ? WORKRALLY_VIDEO_MODELS[0] : WORKRALLY_IMAGE_MODELS[0]);
  const selectedVideoModel = data.isVideo ? (selectedMcpModel as WorkRallyVideoModel) : undefined;
  const ratios: AspectRatio[] = data.isVideo
    ? ('ratios' in selectedMcpModel && selectedMcpModel.ratios?.length ? selectedMcpModel.ratios : WORKRALLY_VIDEO_RATIOS)
    : ('ratios' in selectedMcpModel && selectedMcpModel.ratios?.length ? selectedMcpModel.ratios : WORKRALLY_IMAGE_RATIOS);
  const resolutions: string[] = selectedMcpModel?.resolutions?.length
    ? selectedMcpModel.resolutions.map(option => (typeof option === 'object' ? option.label : option))
    : (data.isVideo ? ['720p', '1080p'] : ['1K', '2K', '4K']);
  const selectedModel = selectedMcpModel?.name || '选择模型';
  const enumParameters: McpSchemaParameter[] = data.isVideo ? [
    {
      name: 'duration',
      title: '时长',
      enum: selectedVideoModel?.durations || [5],
      default: selectedVideoModel?.durations?.[0] || 5,
    },
    ...(selectedVideoModel?.supportAudio ? [{
      name: 'enable_sound',
      title: '声音',
      enum: [true, false],
      default: true,
    }] : []),
  ] : ('qualities' in selectedMcpModel && selectedMcpModel.qualities?.length ? [{
    name: 'quality',
    title: '画质',
    enum: selectedMcpModel.qualities.map(option => option.value),
    default: selectedMcpModel.qualities[0].value,
  }] : []);

  // Dynamic height calculation based on hovered reference image aspect ratio
  const textareaHeight = textareaRef.current?.offsetHeight || 50;
  const targetPreviewHeight = previewDimensions
    ? Math.min(280, Math.max(80, Math.round(448 / (previewDimensions.width / previewDimensions.height))))
    : 200;
  const expandedPromptHeight = (hoveredRefUrl || activePreviewUrl) ? Math.max(textareaHeight, targetPreviewHeight) : 'auto';

  const handleExitComplete = () => {
    if (reboundTimerRef.current) {
      clearTimeout(reboundTimerRef.current);
      reboundTimerRef.current = null;
    }

    const currentTextareaHeight = textareaRef.current?.offsetHeight || 50;
    const currentPreviewHeight = previewDimensions
      ? Math.min(280, Math.max(80, Math.round(448 / (previewDimensions.width / previewDimensions.height))))
      : 200;

    // "当然，我说的是提示词区域本身高度不够的情况下，如果本来就够，没有被大图撑高，就不用回弹了"
    const wasStretched = currentPreviewHeight > currentTextareaHeight;

    if (!wasStretched) {
      setActivePreviewUrl(null);
      setIsRebounding(false);
      return;
    }

    // "可以在大图缩小后稍等300ms，再回弹"
    reboundTimerRef.current = setTimeout(() => {
      setIsRebounding(true);
      setActivePreviewUrl(null);
      setTimeout(() => {
        setIsRebounding(false);
      }, 250);
    }, 300);
  };

  // Dual-Path Coordinates Sync to prevent React render coordinate resetting during drag
  let displayX = x;
  let displayY = y;

  const dragDelta = (window as any).__dragDelta;
  if (dragDelta) {
    if (dragDelta.draggingCardId === id) {
      displayX = posRef.current.x;
      displayY = posRef.current.y;
    } else if (isSelected) {
      displayX = x + dragDelta.dx;
      displayY = y + dragDelta.dy;
    }
  } else {
    displayX = posRef.current.x;
    displayY = posRef.current.y;
  }

  return (
    <div 
      ref={cardRef}
      data-card-id={id}
      data-agent-target={`canvas.card.${id}`}
      data-agent-actions="mouse.move mouse.click mouse.doubleClick mouse.hover mouse.drag"
      data-selected={isSelected ? 'true' : 'false'}
      className={`absolute top-0 left-0 pointer-events-none will-change-transform ${isSelected ? 'z-10' : 'z-0'}`}
      style={{ transformOrigin: 'top left', transform: `translate(${displayX}px, ${displayY}px)` }}
      onPointerDownCapture={handleContainerPointerDown}
    >
      <motion.div
        initial={false}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transformTemplate={(_, generated) => generated.replace(/translateZ\([^)]+\)/g, '')}
        className={`flex flex-col gap-3 group items-start relative ${isAssetCard ? 'asset-card' : 'generation-card'}`}
        style={{ transformOrigin: '50% 50%' }}
        onMouseEnter={() => {
          setIsHovered(true);
          onHover?.(id);
        }}
        onMouseLeave={() => {
          setIsHovered(false);
          onHover?.(null);
        }}
      >
        {/* Floating Top Toolbar Card (Only visible when card is selected, horizontally centered with squircle corners) */}
        <div 
          className="absolute bottom-full mb-2.5 left-0 flex justify-center pointer-events-none z-[70]"
          style={{ width: `${w}px` }}
        >
          <AnimatePresence>
            {isSelected && (
              <motion.div
                initial={{ opacity: 0, y: 6, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 6, scale: 0.95 }}
                transition={{ duration: 0.15, ease: 'easeOut' }}
                className="pointer-events-auto flex items-center gap-1.5 bg-white/95 dark:bg-[#222222]/95 backdrop-blur-md border border-gray-200/90 dark:border-neutral-700/80 shadow-xl rounded-[14px] corner-squircle px-2 py-1.5 group-data-[zooming=true]/canvas:!opacity-0 group-data-[gesture=true]/canvas:!opacity-0"
                style={{
                  transform: 'scale(calc(1 / var(--current-scale, 1)))',
                  transformOrigin: 'bottom center',
                }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                {/* Fork / Duplicate Action Button (Left of Download button) */}
                <button
                  type="button"
                  title="复制卡片参数并创建副本"
                  onPointerDown={(e) => {
                    e.stopPropagation();
                  }}
                  onPointerUp={(e) => {
                    e.stopPropagation();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    onForkCard?.(id);
                  }}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[10px] corner-squircle bg-gray-100/80 dark:bg-neutral-800/80 hover:bg-gray-200/80 dark:hover:bg-neutral-700 text-gray-700 dark:text-gray-200 hover:text-gray-900 dark:hover:text-white text-xs font-medium transition-all duration-150 active:scale-95 cursor-pointer select-none"
                >
                  <Copy className="w-3.5 h-3.5 text-purple-500 dark:text-purple-400" />
                  <span>创建副本</span>
                </button>

                {/* Download Action Button */}
                {(imageUrl || data.fileData) && (state === 'completed' || !state || state === 'draft') && (
                  <button
                    type="button"
                    title="下载媒体文件"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                    }}
                    onPointerUp={(e) => {
                      e.stopPropagation();
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      handleDownloadMedia(e);
                    }}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-[10px] corner-squircle bg-gray-100/80 dark:bg-neutral-800/80 hover:bg-gray-200/80 dark:hover:bg-neutral-700 text-gray-700 dark:text-gray-200 hover:text-gray-900 dark:hover:text-white text-xs font-medium transition-all duration-150 active:scale-95 cursor-pointer select-none"
                  >
                    <Download className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />
                    <span>下载</span>
                  </button>
                )}

                {/* Reserved extensibility slot for future tools/actions */}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Top Layer: Image Placeholder & Drag Handle */}
        <div 
          className={`generation-card-body pointer-events-auto relative shrink-0 overflow-hidden cursor-grab active:cursor-grabbing bg-gray-100 dark:bg-neutral-800 squircle self-start ease-out [&.drag-degraded]:!shadow-none [&.drag-degraded]:!backdrop-filter-none ${
            pickerSelectionIndex && pickerSelectionIndex > 0
              ? 'outline outline-[4px] outline-[#2563eb] shadow-[0_0_25px_rgba(37,99,235,0.7)] scale-[1.015]'
              : isAgentTarget
                ? 'outline outline-[#a855f7]'
                : isPickerTarget
                  ? 'outline outline-[#3b82f6]'
                  : isSelected
                    ? 'outline outline-[#3b82f6]'
                    : 'outline-none'
          } ${
            pickerSelectionIndex && pickerSelectionIndex > 0
              ? 'translate-y-0'
              : isAgentTarget
                ? 'border-transparent shadow-[0_0_25px_rgba(168,85,247,0.45),0_20px_40px_-8px_rgba(0,0,0,0.18)] dark:shadow-[0_0_30px_rgba(168,85,247,0.55),0_24px_48px_-8px_rgba(0,0,0,0.65)] translate-y-0'
                : isSelected 
                  ? 'border-transparent shadow-[0_20px_40px_-8px_rgba(0,0,0,0.2),0_12px_24px_-6px_rgba(0,0,0,0.12)] dark:shadow-[0_24px_48px_-8px_rgba(0,0,0,0.6)] translate-y-0' 
                  : isPickerTarget
                    ? 'border-transparent shadow-[0_20px_40px_-8px_rgba(0,0,0,0.2),0_12px_24px_-6px_rgba(0,0,0,0.12)] dark:shadow-[0_24px_48px_-8px_rgba(0,0,0,0.6)]'
                    : isPickerSelectable
                      ? 'border border-gray-300 dark:border-neutral-600 shadow-[0_1px_3px_rgba(0,0,0,0.1)] translate-y-0 hover:shadow-[0_8px_16px_rgba(59,130,246,0.25)] hover:border-blue-400 dark:hover:border-blue-400/80 hover:outline hover:outline-2 hover:outline-blue-400/50 cursor-pointer'
                      : 'border border-gray-200/90 dark:border-[#404040]/90 shadow-[0_1px_2px_rgba(0,0,0,0.06),0_0_1px_rgba(0,0,0,0.08)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.35)] translate-y-0 hover:shadow-[0_3px_8px_rgba(0,0,0,0.08)] hover:border-gray-300 dark:hover:border-neutral-600'
          }`}
          style={{ 
            width: w, 
            height: h,
            outlineWidth: pickerSelectionIndex && pickerSelectionIndex > 0 
              ? 'calc(4px / var(--current-scale, 1))' 
              : isAgentTarget
                ? 'calc(2.5px / var(--current-scale, 1))'
                : isPickerTarget
                  ? 'calc(2px / var(--current-scale, 1))'
                  : isSelected 
                    ? 'calc(2px / var(--current-scale, 1))' 
                    : '0px',
            boxShadow: pickerSelectionIndex && pickerSelectionIndex > 0
              ? '0 12px 30px rgba(37, 99, 235, 0.45)'
              : isAgentTarget
                ? undefined // Allow beautiful classes with fluorescent glows in className to take precedence!
                : isSelected 
                  ? '0 20px 40px -8px rgba(0, 0, 0, 0.22)' 
                  : undefined,
            transitionProperty: 'box-shadow, border-color, width, height, outline-color, outline-width',
            transitionDuration: '180ms',
            transitionTimingFunction: 'ease-out'
          }}
          onPointerDown={onPointerDown}
        >
        {/* File Name Tag */}
        {data.fileName && (
          <div 
            className="absolute z-[60] pointer-events-none asset-heavy-dom"
            style={{
              top: 'calc(12px / var(--current-scale, 1))',
              left: 'calc(12px / var(--current-scale, 1))',
              transform: 'scale(calc(1 / var(--current-scale, 1)))',
              transformOrigin: 'top left',
              maxWidth: 'calc(var(--current-scale, 1) * 100% - 24px)'
            }}
          >
            <div className="bg-black/60 px-2.5 py-1.5 rounded-lg border border-white/10 shadow-sm flex items-center">
              <span className="text-white/95 text-[13px] font-medium truncate leading-none tracking-wide">
                {data.fileName.replace(/\.[^/.]+$/, "")}
              </span>
            </div>
          </div>
        )}

        {/* Resolution Tag */}
        {resolutionTag && (
          <div 
            className="absolute z-[60] pointer-events-none asset-heavy-dom"
            style={{
              top: 'calc(12px / var(--current-scale, 1))',
              right: 'calc(12px / var(--current-scale, 1))',
              transform: 'scale(calc(1 / var(--current-scale, 1)))',
              transformOrigin: 'top right',
            }}
          >
            <div className="bg-black/60 px-2 py-1.5 rounded-lg border border-white/10 shadow-sm flex items-center">
              <span className="text-white/90 text-[10px] font-bold tracking-wider leading-none">{resolutionTag}</span>
            </div>
          </div>
        )}

        {/* Empty State Placeholder (SVG matching user request) */}
        <div className={`absolute inset-0 flex items-center justify-center bg-gray-100 dark:bg-neutral-800 transition-opacity duration-500 ${!imageUrl ? 'opacity-100' : 'opacity-0'} group-data-[scale-micro=true]/canvas:!opacity-0`}>
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" className="text-gray-300 dark:text-neutral-600">
            {/* Star */}
            <path d="M8.5 2C8.8 4.5 10.5 6.2 13 6.5C10.5 6.8 8.8 8.5 8.5 11C8.2 8.5 6.5 6.8 4 6.5C6.5 6.2 8.2 4.5 8.5 2Z" fill="currentColor"/>
            {/* Big Mountain */}
            <path d="M15.5 10L22 20H9L15.5 10Z" fill="currentColor"/>
            {/* Small Mountain */}
            <path d="M8.5 13L13 20H4L8.5 13Z" fill="currentColor"/>
          </svg>
        </div>

        {/* Generated Image or Video */}
        {imageUrl && (
          isVideo ? (
            <div 
              ref={videoContainerRef}
              className="absolute inset-0 overflow-hidden squircle pointer-events-auto"
              onPointerDown={(e) => {
                // If middle click (pan) or right click, immediately drop hover to unmount video
                if (e.button === 1 || e.button === 2) {
                  if (!isPlaying) {
                    setIsHovered(false);
                  } else if (videoRef.current && !videoRef.current.paused) {
                    videoRef.current.pause();
                  }
                }
              }}
              onMouseEnter={() => {
                if ((window as any).isDraggingCard) return;
                const workspace = document.getElementById('canvas-workspace');
                if (
                  workspace?.getAttribute('data-gesture') === 'true' || 
                  workspace?.getAttribute('data-panning') === 'true' || 
                  workspace?.getAttribute('data-zooming') === 'true'
                ) {
                  return;
                }
                setIsHovered(true);
              }}
              onMouseMove={() => {
                if ((window as any).isDraggingCard) return;
                const workspace = document.getElementById('canvas-workspace');
                if (
                  workspace?.getAttribute('data-gesture') === 'true' || 
                  workspace?.getAttribute('data-panning') === 'true' || 
                  workspace?.getAttribute('data-zooming') === 'true'
                ) {
                  return;
                }
                if (!isHovered) {
                  setIsHovered(true);
                }
              }}
              onMouseLeave={() => {
                if ((window as any).isDraggingCard) return;
                const workspace = document.getElementById('canvas-workspace');
                const isCanvasMotion = 
                  workspace?.getAttribute('data-gesture') === 'true' || 
                  workspace?.getAttribute('data-panning') === 'true' || 
                  workspace?.getAttribute('data-zooming') === 'true';
                if (!isCanvasMotion && !isPlaying) {
                  setIsHovered(false);
                }
              }}
              style={{
                width: w * dpr,
                height: h * dpr,
                transform: dpr > 1 ? `scale(${1 / dpr})` : undefined,
                transformOrigin: 'top left',
                backgroundImage: (data.thumbnailUrl || localThumbnailUrl || (imageUrl ? thumbCache.get(imageUrl) || thumbCache.get(id) : undefined)) ? `url(${data.thumbnailUrl || localThumbnailUrl || (imageUrl ? thumbCache.get(imageUrl) || thumbCache.get(id) : undefined)})` : undefined,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }}
            >
              <div className="absolute inset-0 w-full h-full overflow-hidden squircle group/video pointer-events-auto">
                {((isHovered || isPlaying || hasEverMountedVideo) || (!data.thumbnailUrl && !localThumbnailUrl && !thumbCache.get(imageUrl) && !thumbCache.get(id))) && effectiveVideoSrc && effectiveVideoSrc.trim() !== '' && !videoHasError && (
                  <motion.video 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3, ease: 'easeOut' }}
                  ref={videoRef}
                  {...({ referrerPolicy: "no-referrer" } as any)}
                  src={effectiveVideoSrc} 
                  loop 
                  playsInline
                  muted={!isPlaying}
                  preload="auto"
                  autoPlay={isPlaying}
                  className="absolute inset-0 w-full h-full object-cover pointer-events-none transition-opacity duration-500 group-data-[zooming=true]/canvas:!transition-none group-data-[zooming=true]/canvas:!duration-0 group-data-[zooming=true]/canvas:will-change-transform"
                  onLoadedData={(e) => {
                    const video = e.currentTarget;
                    if (video.duration) {
                      setDuration(video.duration);
                    }
                    if (!data.thumbnailUrl && !localThumbnailUrl) {
                      const thumbUrl = generateThumbnail(video);
                      if (thumbUrl) {
                        setLocalThumbnailUrl(thumbUrl);
                        thumbCache.set(id, thumbUrl);
                        if (imageUrl) thumbCache.set(imageUrl, thumbUrl);
                        onUpdate(id, { thumbnailUrl: thumbUrl }, false);
                      }
                    }
                  }}
                  onLoadedMetadata={(e) => {
                    const video = e.currentTarget;
                    const dur = video.duration || 0;
                    setDuration(dur);
                    const savedPos = getStoredVideoProgress();
                    if (savedPos > 0 && dur > 0 && savedPos < (dur - 0.4)) {
                      video.currentTime = savedPos;
                      setProgress((savedPos / dur) * 100);
                    } else if (dur > 0.05) {
                      video.currentTime = 0.05;
                    }
                    if (!data.thumbnailUrl && !localThumbnailUrl) {
                      const thumbUrl = generateThumbnail(video);
                      if (thumbUrl) {
                        setLocalThumbnailUrl(thumbUrl);
                        thumbCache.set(id, thumbUrl);
                        if (imageUrl) thumbCache.set(imageUrl, thumbUrl);
                        onUpdate(id, { thumbnailUrl: thumbUrl }, false);
                      }
                    }
                  }}
                  onCanPlay={(e) => {
                    const video = e.currentTarget;
                    if (video.duration) setDuration(video.duration);
                    if (!hasRestoredInitialTimeRef.current) {
                      hasRestoredInitialTimeRef.current = true;
                      const savedPos = getStoredVideoProgress();
                      if (savedPos > 0 && video.duration > 0 && savedPos < (video.duration - 0.4) && Math.abs(video.currentTime - savedPos) > 0.3) {
                        video.currentTime = savedPos;
                      }
                    }
                    if (isPlaying && video.paused) {
                      const p = video.play();
                      if (p !== undefined) {
                        p.catch((err: any) => {
                          if (err?.name === 'NotAllowedError') {
                            video.muted = true;
                            video.play().catch(() => {});
                          }
                        });
                      }
                    }
                  }}
                  onPlay={() => {
                    if (!isPlaying) setIsPlaying(true);
                  }}
                  onTimeUpdate={(e) => {
                    const video = e.currentTarget;
                    const currTime = video.currentTime;
                    if (video.duration > 0 && currTime >= video.duration - 0.4) {
                      try { localStorage.removeItem(`mira_vid_pos_${id}`); } catch {}
                      initialSeekPosRef.current = 0;
                    } else if (currTime > 0.1) {
                      saveStoredVideoProgress(currTime);
                      initialSeekPosRef.current = currTime;
                    }
                    if (video.duration) {
                      setDuration(video.duration);
                      setProgress((currTime / video.duration) * 100);
                    }
                    if (Math.abs(currTime - lastSavedTimeRef.current) >= 1.5) {
                      lastSavedTimeRef.current = currTime;
                      const updates: Partial<CardData> = { currentTime: currTime };
                      const thumbUrl = generateThumbnail(video);
                      if (thumbUrl) updates.thumbnailUrl = thumbUrl;
                      onUpdate(id, updates, false);
                    }
                  }}
                  onPause={(e) => {
                    if (e.currentTarget.currentTime > 0) {
                      saveStoredVideoProgress(e.currentTarget.currentTime);
                    }
                    captureAndSaveVideoState(e.currentTarget);
                  }}
                  onSeeked={(e) => {
                    if (e.currentTarget.currentTime > 0) {
                      saveStoredVideoProgress(e.currentTarget.currentTime);
                    }
                    lastSavedTimeRef.current = e.currentTarget.currentTime;
                    if (e.currentTarget.paused) captureAndSaveVideoState(e.currentTarget);
                    if (!data.thumbnailUrl && !localThumbnailUrl) {
                      const thumbUrl = generateThumbnail(e.currentTarget);
                      if (thumbUrl) {
                        setLocalThumbnailUrl(thumbUrl);
                        thumbCache.set(id, thumbUrl);
                        if (imageUrl) thumbCache.set(imageUrl, thumbUrl);
                        onUpdate(id, { thumbnailUrl: thumbUrl }, false);
                      }
                    }
                  }}
                  onError={() => {
                    refreshVideoUrl(true);
                  }}
                />
                )}
                {videoHasError && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 p-4 text-center select-none pointer-events-auto z-[20]">
                    <AlertCircle className="w-8 h-8 text-amber-500 mb-2 animate-bounce" />
                    <span className="text-white text-xs font-semibold mb-1">视频加载失败</span>
                    {videoLoadError && (
                      <p className="text-white/70 text-[10px] mb-2 max-w-[200px] break-words line-clamp-2" role="alert">
                        {videoLoadError}
                      </p>
                    )}
                    <button
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setVideoHasError(false);
                        setVideoLoadError('');
                        refreshVideoUrl(true);
                        setIsPlaying(true);
                      }}
                      className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 text-white rounded-lg text-[10px] font-bold shadow-md transition-colors active:scale-95"
                    >
                      重新获取视频地址
                    </button>
                  </div>
                )}
                {!isPlaying ? (() => {
                  const narrowerSide = Math.min(w, h);
                  const playButtonDiameter = narrowerSide / 2;
                  const playButtonIconSize = playButtonDiameter * 0.76;
                  return (
                    <div 
                      className="absolute inset-0 flex items-center justify-center bg-black/25 hover:bg-black/35 transition-colors pointer-events-none"
                    >
                      <div 
                        className="rounded-full bg-white/40 dark:bg-black/50 border border-white/30 dark:border-white/10 shadow-xl flex items-center justify-center transform hover:scale-105 transition-transform cursor-pointer pointer-events-auto group-data-[scale-micro=true]/canvas:!scale-100"
                        style={{
                          width: playButtonDiameter,
                          height: playButtonDiameter,
                        }}
                        onPointerDown={(e) => {
                          // Prevent card drag only on left-click of play button, allow middle click to pan
                          if (e.button === 0) {
                            e.stopPropagation();
                          } else if (e.button === 1 || e.button === 2) {
                            if (!isPlaying) {
                              setIsHovered(false);
                            }
                          }
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setIsPlaying(true);
                          const video = videoRef.current;
                          if (video) {
                            video.muted = false;
                            const playPromise = video.play();
                            if (playPromise !== undefined) {
                              playPromise.catch((err: any) => {
                                if (err?.name === 'NotAllowedError') {
                                  video.muted = true;
                                  video.play().catch(() => {});
                                }
                              });
                            }
                          }
                        }}
                      >
                        <svg 
                          viewBox="0 0 24 24" 
                          fill="currentColor" 
                          xmlns="http://www.w3.org/2000/svg" 
                          className="text-white/85"
                          style={{
                            width: playButtonIconSize,
                            height: playButtonIconSize,
                          }}
                        >
                          <path d="M8 6.5v11c0 .8.9 1.3 1.6.9l8.5-5.5a1 1 0 0 0 0-1.8L9.6 5.6c-.7-.4-1.6.1-1.6.9z"/>
                        </svg>
                      </div>
                    </div>
                  );
                })() : (
                  (() => {
                    const narrowerSide = Math.min(w, h);
                    const playButtonDiameter = narrowerSide / 2;
                    const playButtonIconSize = playButtonDiameter * 0.76;
                    return (
                      <div 
                        className="absolute inset-0 bg-transparent hover:bg-black/5 transition-all duration-200 flex items-center justify-center pointer-events-none"
                      >
                        <div 
                          className="rounded-full bg-white/40 dark:bg-black/50 border border-white/30 dark:border-white/10 shadow-xl flex items-center justify-center transform hover:scale-105 transition-transform duration-200 opacity-0 hover:opacity-100 cursor-pointer pointer-events-auto"
                          style={{
                            width: playButtonDiameter,
                            height: playButtonDiameter,
                          }}
                          onPointerDown={(e) => {
                            // Prevent card drag only on left-click, allow middle click to pan
                            if (e.button === 0) {
                              e.stopPropagation();
                            }
                          }}
                          onClick={(e) => {
                            e.stopPropagation();
                            setIsPlaying(false);
                            if (videoRef.current) {
                              videoRef.current.pause();
                            }
                          }}
                        >
                          <svg 
                            viewBox="0 0 24 24" 
                            fill="currentColor" 
                            xmlns="http://www.w3.org/2000/svg" 
                            className="text-white/85"
                            style={{
                              width: playButtonIconSize,
                              height: playButtonIconSize,
                            }}
                          >
                            <rect x="6" y="4.5" width="4" height="15" rx="1.5" />
                            <rect x="14" y="4.5" width="4" height="15" rx="1.5" />
                          </svg>
                        </div>
                      </div>
                    );
                  })()
                )}

                {/* Progress Bar Controller Overlay */}
                {(isHovered || isPlaying) && (
                <div 
                  className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-4 pt-12 flex flex-col gap-2 transition-opacity duration-200 opacity-0 group-hover/video:opacity-100 group-data-[scale-micro=true]/canvas:hidden"
                  onPointerDown={(e) => {
                    // Prevent card dragging when interacting with controls
                    if (e.button === 0) {
                      e.stopPropagation();
                    }
                  }}
                >
                  <div className="flex items-center gap-3">
                    {/* Miniature Play/Pause Button */}
                    <button
                      type="button"
                      className="text-white hover:text-blue-400 transition-colors cursor-pointer focus:outline-none flex-shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        const nextPlaying = !isPlaying;
                        setIsPlaying(nextPlaying);
                        const video = videoRef.current;
                        if (video) {
                          if (nextPlaying) {
                            video.muted = false;
                            const playPromise = video.play();
                            if (playPromise !== undefined) {
                              playPromise.catch((err: any) => {
                                if (err?.name === 'NotAllowedError') {
                                  video.muted = true;
                                  video.play().catch(() => {});
                                }
                              });
                            }
                          } else {
                            video.pause();
                          }
                        }
                      }}
                    >
                      {isPlaying ? (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M6 19H10V5H6V19ZM14 5V19H18V5H14Z" fill="currentColor"/>
                        </svg>
                      ) : (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M8 5V19L19 12L8 5Z" fill="currentColor"/>
                        </svg>
                      )}
                    </button>

                    {/* Range Slider */}
                    <input
                      type="range"
                      min="0"
                      max="100"
                      step="0.1"
                      value={progress > 0 ? progress : (duration > 0 && getStoredVideoProgress() > 0 ? (getStoredVideoProgress() / duration) * 100 : 0)}
                      onChange={(e) => {
                        const pct = parseFloat(e.target.value);
                        setProgress(pct);
                        if (videoRef.current && duration) {
                          const targetTime = (pct / 100) * duration;
                          videoRef.current.currentTime = targetTime;
                          saveStoredVideoProgress(targetTime);
                        }
                      }}
                      className="w-full h-1 bg-transparent rounded-lg appearance-none cursor-pointer accent-blue-500 focus:outline-none [&::-webkit-slider-runnable-track]:bg-white/20 [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-lg [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-500 hover:[&::-webkit-slider-thumb]:scale-125 [&::-webkit-slider-thumb]:-translate-y-[4px]"
                    />

                    {/* Time Stamps */}
                    <span className="text-[10px] font-mono text-white/90 select-none flex-shrink-0">
                      {formatTime(videoRef.current?.currentTime ?? (getStoredVideoProgress() || 0))} / {formatTime(duration)}
                    </span>
                  </div>
                </div>
                )}
              </div>
            </div>
          ) : (
            <CardImageCanvas
              cardId={id}
              thumbnailUrl={data.thumbnailUrl}
              imageUrl={imageUrl}
              originalImageUrl={data.originalImageUrl || imageUrl}
              showOriginal={showOriginal}
              width={w}
              height={h}
              dpr={dpr}
              state={state}
              isZooming={isZooming}
              className="squircle"
            />
          )
        )}

        {/* Generating State Overlay */}
        <AnimatePresence>
          {state === 'generating' && (
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }}
              className={`absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-10 group-data-[zooming=true]/canvas:opacity-0 group-data-[zooming=true]/canvas:will-change-transform group-data-[scale-micro=true]/canvas:hidden ${
                imageUrl
                  ? 'bg-black/50'
                  : 'bg-gray-100 dark:bg-neutral-800'
              }`}
            >
              <RefreshCw className={`w-8 h-8 ${imageUrl ? 'text-white' : 'text-purple-600'} animate-spin mb-2 drop-shadow-md`} />
              <span className={`text-xs ${imageUrl ? 'text-white/95 font-medium' : 'text-purple-700 font-bold'} tracking-wider drop-shadow-md`}>
                {imageUrl ? '导入中...' : 'Rendering'}
              </span>
            </motion.div>
          )}
          {(state === 'error' || data.generationError) && (
            <motion.div 
              initial={{ opacity: 0 }} 
              animate={{ opacity: 1 }} 
              exit={{ opacity: 0 }}
              className="absolute inset-0 flex flex-col items-center justify-center p-6 bg-neutral-900/90 backdrop-blur-md z-20 text-center pointer-events-auto rounded-lg shadow-2xl"
            >
              <AlertCircle className="w-8 h-8 text-amber-400 mb-2 animate-bounce" />
              <span className="text-white text-xs font-bold mb-1">生图提示</span>
              <p className="text-white/80 text-[11px] leading-relaxed max-w-[320px] break-words line-clamp-3 mb-3">
                {data.generationError || '生成服务响应异常，请检查配置'}
              </p>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onUpdate(id, { state: 'idle', generationError: undefined }, true);
                }}
                className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/30 text-[11px] font-medium transition-colors cursor-pointer"
              >
                重试 / 恢复卡片
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Bottom Layer: Light Panel (Always rendered for generation cards; skeleton blocks in low LOD) */}
      {shouldRenderBottomPanel && (
      <div 
        className={`generation-card-bottom-panel pointer-events-auto flex flex-col bg-gray-100 dark:bg-neutral-800 ${isLowLodSkeleton ? '!rounded-none !corner-shape-none' : 'squircle'} p-4 gap-2 w-[480px] border border-gray-200/80 dark:border-[#404040] cursor-default self-start ease-out transform-gpu opacity-100 [&.drag-degraded]:!shadow-none [&.drag-degraded]:!backdrop-filter-none ${
        isZooming
          ? 'shadow-none dark:shadow-none' // Persistent Degradation: strip expensive drop shadows during high-frequency zoom
          : isSelected 
            ? 'shadow-[0_16px_36px_-6px_rgba(0,0,0,0.12),0_8px_16px_-4px_rgba(0,0,0,0.06)] dark:shadow-[0_20px_40px_-6px_rgba(0,0,0,0.45)] translate-y-0' 
            : 'shadow-[0_1px_3px_rgba(0,0,0,0.05),0_1px_2px_rgba(0,0,0,0.03)] dark:shadow-none translate-y-0'
      }`}
        style={{
          marginLeft: (w - 480) / 2,
          transitionProperty: 'box-shadow, opacity',
          transitionDuration: isZooming ? '0ms' : '180ms'
        }}
      >
        {isLowLodSkeleton ? (
          <div className="flex flex-col gap-2 w-full select-none pointer-events-none">
            {/* Reference images skeleton blocks - ALWAYS rendered to match Full Detail DOM's + Add Button */}
            <div className="flex items-center gap-2 flex-wrap w-full">
              {refList.map((_, idx) => (
                <div key={idx} className="w-12 h-12 rounded-none bg-gray-200/80 dark:bg-neutral-700/60 flex-shrink-0" />
              ))}
              <div className="w-12 h-12 rounded-none border-2 border-dashed border-gray-300/80 dark:border-neutral-700/60 flex-shrink-0" />
            </div>

            {/* Text lines skeleton blocks - matching Full Detail mt-1 min-h-[50px] max-h-[300px] flex flex-col gap-1.5 */}
            {(() => {
              const promptH = getPromptAreaHeight(localPrompt);
              const totalLines = calculatePromptLines(localPrompt);
              const displayLineCount = Math.max(1, Math.min(13, Math.round(promptH / 22)));
              return (
                <div 
                  className="relative w-full flex flex-col justify-center gap-1.5 mt-1"
                  style={{ height: promptH }}
                >
                  {Array.from({ length: displayLineCount }).map((_, i) => (
                    <div
                      key={i}
                      className={`h-3.5 bg-gray-200/90 dark:bg-neutral-700/80 rounded-none ${
                        i === displayLineCount - 1 && displayLineCount > 1 ? 'w-[55%]' : 'w-[92%]'
                      }`}
                    />
                  ))}
                </div>
              );
            })()}

            {/* Controls skeleton bar - matching Full Detail mt-2 pt-2 border-t */}
            <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-200/60 dark:border-neutral-700/50">
              <div className="flex items-center gap-2">
                <div className="h-7 w-16 bg-gray-200/80 dark:bg-neutral-700/60 rounded-none" />
                <div className="h-7 w-20 bg-gray-200/80 dark:bg-neutral-700/60 rounded-none" />
                <div className="h-7 w-14 bg-gray-200/80 dark:bg-neutral-700/60 rounded-none" />
              </div>
              <div className="w-8 h-8 rounded-none bg-gray-200/90 dark:bg-neutral-700/80" />
            </div>
          </div>
        ) : (
        <>
        {/* Top: Reference & Actions */}
        <div className="flex items-start justify-between relative" ref={refMenuContainerRef}>
          <div className="relative flex items-center gap-2 flex-wrap w-full">
            {refList.map((item, idx) => (
              <ReferenceThumbItem
                key={`${item.sourceCardId || item.url || 'ref'}_${idx}`}
                item={item}
                idx={idx}
                currentScale={currentScale}
                removeReferenceImage={removeReferenceImage}
                setOpenMenu={setOpenMenu}
                hoveredRefUrl={hoveredRefUrl}
                setHoveredRefUrl={setHoveredRefUrl}
                onMentionItem={insertMention}
              />
            ))}

            {/* Add button following on the right */}
            <button 
              type="button"
              data-agent-target={`ref-btn-${id}`}
              onClick={(e) => {
                e.stopPropagation();
                const isAgent = !e.nativeEvent.isTrusted;
                setOpenMenu(prev => prev?.type === 'ref' ? null : { type: 'ref', ownerId: isAgent ? 'agent' : 'user' });
              }}
              className={`w-12 h-12 flex flex-col items-center justify-center border-2 border-dashed border-gray-300 dark:border-neutral-700 hover:border-gray-450 dark:hover:border-neutral-500 bg-gray-50/50 dark:bg-neutral-800/40 hover:bg-gray-100/80 dark:hover:bg-neutral-800/80 rounded-lg text-gray-500 hover:text-gray-700 dark:hover:text-neutral-300 transition-all cursor-pointer ${openMenu?.type === 'ref' ? 'ring-2 ring-blue-500/50 dark:ring-blue-400/50' : ''}`}
              title="添加参考图"
            >
              <Plus className="w-4 h-4" />
            </button>

            {/* Dropdown with 3 options: 本地上传, 资产列表, 画布导入 */}
            <AnimatePresence>
              {openMenu?.type === 'ref' && (
                <motion.div
                  initial={{ opacity: 0, y: 4, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 4, scale: 0.96 }}
                  transition={{ duration: 0.15 }}
                  className="absolute top-[calc(100%+6px)] left-0 w-36 bg-white dark:bg-neutral-800 border border-gray-200 dark:border-[#404040] rounded-xl corner-squircle shadow-[0_12px_32px_rgba(0,0,0,0.18)] p-1.5 z-50 flex flex-col gap-0.5"
                >
                  <button
                    type="button"
                    data-agent-target={`ref-option-local-${id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      fileInputRef.current?.click();
                      setOpenMenu(null);
                    }}
                    className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[13px] font-medium text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700 transition-colors"
                  >
                    <Upload className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />
                    <span>本地上传</span>
                  </button>

                  <button
                    type="button"
                    data-agent-target={`ref-option-asset-${id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenu(null);
                      setShowAssetPicker(true);
                    }}
                    className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[13px] font-medium text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700 transition-colors"
                  >
                    <Sparkles className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
                    <span>资产列表</span>
                  </button>

                  <button
                    type="button"
                    data-agent-target={`ref-option-canvas-${id}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMenu(null);
                      onStartCanvasPicker?.(id);
                    }}
                    className="flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[13px] font-medium text-gray-700 dark:text-neutral-200 hover:bg-gray-100 dark:hover:bg-neutral-700 transition-colors"
                  >
                    <LayoutGrid className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
                    <span>画布导入</span>
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Hidden native file input for 本地上传 */}
            <input 
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleLocalUpload}
            />
          </div>
          
          {/* Picker Mode Indicator Badge on top of card */}
          {isPickerSelectable && (
            <div className={`absolute -top-3 -right-3 z-30 flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold transition-all transform shadow-md ${
              pickerSelectionIndex && pickerSelectionIndex > 0
                ? 'bg-blue-600 text-white scale-110 ring-4 ring-blue-500/30'
                : 'bg-neutral-800/85 hover:bg-blue-500 text-white hover:scale-105 border border-white/40'
            }`}>
              {pickerSelectionIndex && pickerSelectionIndex > 0 ? pickerSelectionIndex : '+'}
            </div>
          )}

          {isPickerTarget && (
            <div className="absolute -top-3 -left-3 z-30 px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-500 text-white shadow-md uppercase tracking-wider">
              当前目标
            </div>
          )}

          {/* Default selection delete button removed to leave space for reference images */}
        </div>

        {/* Middle: Prompt Textarea */}
        <div 
          ref={promptContainerRef}
          className="relative w-full mt-1 min-h-[50px] flex items-center"
          style={{
            height: activePreviewUrl
              ? expandedPromptHeight
              : isRebounding
                ? textareaHeight
                : undefined,
            transition: isRebounding ? 'height 0.24s cubic-bezier(0.16, 1, 0.3, 1)' : 'none',
          }}
        >
          {/* Highlight mirror backdrop */}
          <div
            ref={mirrorRef}
            aria-hidden="true"
            className="absolute inset-0 pointer-events-none text-gray-800 dark:text-neutral-100 text-[14px] leading-[22px] font-medium p-0 m-0 border-0 select-none overflow-hidden no-scrollbar"
            style={{
              wordBreak: 'break-all',
              lineBreak: 'anywhere',
              overflowWrap: 'anywhere',
              whiteSpace: 'pre-wrap',
              fontFamily: 'inherit',
              letterSpacing: 'normal',
              lineHeight: '22px',
              boxSizing: 'border-box',
              scrollbarWidth: 'none',
              msOverflowStyle: 'none',
            }}
          >
            {renderHighlightedPrompt(localPrompt)}
            {localPrompt?.endsWith('\n') && <br />}
          </div>

          <textarea
            ref={textareaRef}
            data-agent-target={`prompt-input-${id}`}
            value={localPrompt}
            onPointerDown={(e) => {
              // Prevent middle-click from focusing the textarea so canvas panning works smoothly
              if (e.button === 1) {
                e.preventDefault();
              }
            }}
            onChange={handleTextareaChange}
            onBlur={handleTextareaBlur}
            onKeyDown={handleTextareaKeyDown}
            onClick={(e) => checkCursorMention(e.currentTarget.value, e.currentTarget.selectionStart)}
            onSelect={(e) => checkCursorMention(e.currentTarget.value, e.currentTarget.selectionStart)}
            onKeyUp={(e) => {
              if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(e.key)) {
                checkCursorMention(e.currentTarget.value, e.currentTarget.selectionStart);
              }
            }}
            onScroll={() => {
              if (mirrorRef.current && textareaRef.current) {
                mirrorRef.current.scrollTop = textareaRef.current.scrollTop;
              }
            }}
            disabled={state === 'generating'}
            placeholder="输入文字指令，例如：清冷克制的女主，穿白衬衫..."
            className="relative z-10 w-full bg-transparent border-0 text-transparent caret-gray-800 dark:caret-neutral-100 selection:bg-blue-500/25 selection:text-transparent placeholder:text-gray-400 dark:placeholder:text-neutral-500 text-[14px] leading-[22px] resize-none focus:outline-none min-h-[50px] max-h-[300px] font-medium block p-0 m-0 no-scrollbar"
            style={{
              wordBreak: 'break-all',
              lineBreak: 'anywhere',
              overflowWrap: 'anywhere',
              whiteSpace: 'pre-wrap',
              fontFamily: 'inherit',
              letterSpacing: 'normal',
              lineHeight: '22px',
              boxSizing: 'border-box',
              scrollbarWidth: 'none',
              msOverflowStyle: 'none',
            }}
            rows={2}
          />

          {/* @ Mention Suggestion Dropdown */}
          {mentionMenuOpen && (
            <div
              ref={mentionMenuRef}
              className="absolute left-0 bottom-full mb-2 w-72 max-h-64 bg-white dark:bg-neutral-900 border border-gray-200 dark:border-neutral-700 rounded-xl shadow-xl overflow-hidden z-50 flex flex-col py-1 animate-in fade-in zoom-in-95 duration-100"
            >
              <div className="px-3 py-1.5 text-[11px] font-semibold text-gray-400 dark:text-neutral-500 uppercase tracking-wider border-b border-gray-100 dark:border-neutral-800 flex items-center justify-between">
                <span>选择参考图引用</span>
                <span className="text-[10px] font-normal text-gray-400">↑↓ 选择 · Enter 确定</span>
              </div>
              <div className="overflow-y-auto max-h-52 divide-y divide-gray-50 dark:divide-neutral-800/40">
                {filteredMentionCandidates.length > 0 ? (
                  filteredMentionCandidates.map((c, idx) => (
                    <button
                      key={`${c.id}_${idx}`}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        insertMention(c);
                      }}
                      className={`w-full px-3 py-2 flex items-center gap-2.5 text-left transition-colors cursor-pointer ${
                        idx === selectedMentionIndex
                          ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400'
                          : 'hover:bg-gray-50 dark:hover:bg-neutral-800/60 text-gray-700 dark:text-neutral-200'
                      }`}
                    >
                      <div className="w-8 h-8 rounded-md bg-gray-100 dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 flex items-center justify-center overflow-hidden shrink-0">
                        <MentionCandidateAvatar item={c} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] font-semibold truncate flex items-center gap-1">
                          <span className="text-blue-500 font-bold">@</span>
                          <span className="truncate">{c.name}</span>
                        </div>
                        {c.subtitle && (
                          <div className="text-[11px] text-gray-400 dark:text-neutral-500 truncate">
                            {c.subtitle}
                          </div>
                        )}
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="px-4 py-4 text-center text-xs text-gray-400 dark:text-neutral-500">
                    暂无可引用的参考图或角色
                  </div>
                )}
              </div>
            </div>
          )}
          
          {/* Direct large image with frosted glass backdrop: opacity fade-in and fade-out (no scale, no rounded corners) */}
          <AnimatePresence onExitComplete={handleExitComplete}>
            {hoveredRefUrl && (
              <motion.div
                key="large-ref-preview"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16, ease: 'easeOut' }}
                onClick={(e) => {
                  e.stopPropagation();
                  setHoveredRefUrl(null);
                  setActivePreviewUrl(null);
                }}
                className="absolute inset-0 z-30 pointer-events-auto cursor-pointer flex items-center justify-center overflow-hidden shadow-md transform-gpu group/large-preview"
                title="点击关闭大图预览"
              >
                {/* Frosted glass mask without rounded corners */}
                <div className="absolute inset-0 backdrop-blur-md bg-gray-100/90 dark:bg-neutral-800/90" />

                {/* Direct large image without rounded corners */}
                <img 
                  src={hoveredRefUrl} 
                  alt="Reference Preview" 
                  className="relative z-10 w-full h-full object-contain pointer-events-none select-none"
                  referrerPolicy="no-referrer"
                />

                {/* Close button at top right */}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setHoveredRefUrl(null);
                    setActivePreviewUrl(null);
                  }}
                  className="absolute top-2 right-2 z-40 w-6 h-6 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center transition-colors shadow-sm cursor-pointer"
                  title="关闭预览"
                >
                  <X className="w-3.5 h-3.5 stroke-[2.5]" />
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {data.generationError && (
          <div role="alert" className="mt-2 text-[12px] leading-5 text-red-600 dark:text-red-400 break-words">
            {data.generationError}
          </div>
        )}

        {/* Bottom Action Bar */}
        <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-100 dark:border-[#404040]">
          
          {/* Left Controls: Parameters */}
          <div ref={menuContainerRef} className="flex items-center gap-3 text-gray-500 dark:text-neutral-400 text-[13px]">
            {/* Quick @ mention button */}
            <button
              type="button"
              data-agent-target={`mention-btn-${id}`}
              onClick={(e) => {
                e.stopPropagation();
                if (textareaRef.current) {
                  textareaRef.current.focus();
                }
                setMentionMenuOpen(prev => !prev);
              }}
              className="flex items-center gap-1 text-[12px] font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 bg-blue-50 dark:bg-blue-950/40 hover:bg-blue-100 dark:hover:bg-blue-900/40 px-2 py-0.5 rounded-md transition-colors cursor-pointer"
              title="在提示词中@参考图"
            >
              <span className="font-bold text-[13px]">@</span>
              <span className="text-[12px]">引用</span>
            </button>

            {/* WorkRally model dropdown */}
            <div className="relative">
              <button
                type="button"
                data-agent-target={`model-btn-${id}`}
                onClick={(e) => {
                  const isAgent = !e.nativeEvent.isTrusted;
                  setOpenMenu(prev => prev?.type === 'model' ? null : { type: 'model', ownerId: isAgent ? 'agent' : 'user' });
                }}
                className={`flex items-center gap-1.5 max-w-[150px] transition-colors group ${openMenu?.type === 'model' ? 'text-gray-900 dark:text-neutral-100' : 'hover:text-gray-900 dark:hover:text-neutral-200'}`}
                title={selectedMcpModel?.description || `选择 WorkRally ${data.isVideo ? '视频' : '生图'}模型`}
              >
                <Sparkles className="w-3.5 h-3.5 opacity-70 shrink-0" />
                <span className="font-semibold truncate">{String(selectedModel)}</span>
                <ChevronDown className="w-3 h-3 opacity-50 group-hover:opacity-100 shrink-0" />
              </button>

              <AnimatePresence>
                {openMenu?.type === 'model' && (
                  <motion.div
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 5 }}
                    transition={{ duration: 0.15 }}
                    className="absolute bottom-[calc(100%+12px)] left-0 w-64 max-h-72 overflow-y-auto bg-gray-100 dark:bg-neutral-800 border border-gray-100 dark:border-[#404040] rounded-xl corner-squircle shadow-[0_8px_30px_rgb(0,0,0,0.12)] p-1.5 z-50 flex flex-col"
                  >
                    <div className="flex items-center justify-between px-2 py-1 mb-1 border-b border-gray-200 dark:border-neutral-700 text-[10px] text-gray-500 dark:text-neutral-400 font-medium">
                      <span className="flex items-center gap-1.5">
                        {isMcpModelsDynamic ? `WorkRally MCP ${data.isVideo ? '视频' : '生图'}模型 (${mcpModels.length})` : `可用${data.isVideo ? '视频' : '生图'}模型`}
                        {isMcpModelsDynamic && (
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" title="已从 WorkRally MCP 工具同步" />
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          refreshMcpModels();
                        }}
                        className="p-1 hover:text-blue-500 rounded transition-colors"
                        title="从 WorkRally MCP 重新探测工具与模型"
                      >
                        <RefreshCw className={`w-3 h-3 ${isMcpModelsLoading ? 'animate-spin text-blue-500' : ''}`} />
                      </button>
                    </div>
                    {mcpModels.map((model, idx) => (
                        <button
                          key={`${model.id || model.name}_${idx}`}
                          type="button"
                          data-agent-target={`model-option-${id}-${model.id || model.name}`}
                          onClick={() => {
                            const modelResolutions = (model.resolutions || []).map((option: any) => (typeof option === 'object' ? option.label : option));
                            onUpdate(id, {
                              mcpToolName: (model as any).toolName || defaultMcpToolName || (data.isVideo ? WORKRALLY_VIDEO_TOOL : WORKRALLY_IMAGE_TOOL),
                              mcpModel: model.id,
                              mcpParameters: {},
                              ...(model.ratios?.length && !model.ratios.includes(ratio) ? { ratio: model.ratios[0] } : {}),
                              ...(modelResolutions.length && !modelResolutions.includes(res)
                                ? { res: typeof model.resolutions[0] === 'object' ? model.resolutions[0].label : model.resolutions[0] }
                                : {}),
                            }, true);
                            setOpenMenu(null);
                          }}
                          className={`text-left px-3 py-2 rounded-lg corner-squircle text-[12px] font-medium transition-colors ${
                            (model.id === data.mcpModel || model.name === data.mcpModel)
                              ? 'bg-gray-100 dark:bg-neutral-700 text-gray-900 dark:text-white'
                              : 'text-gray-600 dark:text-neutral-300 hover:bg-gray-50 dark:hover:bg-neutral-700'
                          }`}
                          title={model.description || model.name}
                        >
                          <div className="truncate font-semibold">{model.name}</div>
                          {model.description && (
                            <div className="text-[10px] text-gray-400 dark:text-neutral-400 truncate mt-0.5 font-normal">
                              {model.description}
                            </div>
                          )}
                        </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {enumParameters.map(param => {
              const currentValue = data.mcpParameters?.[param.name] ?? param.default ?? param.enum?.[0];
              const currentLabel = param.name === 'quality'
                ? ('qualities' in selectedMcpModel ? selectedMcpModel.qualities.find(option => option.value === currentValue)?.label : undefined) || currentValue
                : param.name === 'duration' ? `${currentValue}秒`
                : param.name === 'enable_sound' ? (currentValue ? '有声' : '静音')
                : currentValue;
              return (
                <div className="relative" key={param.name}>
                  <button
                    type="button"
                    data-agent-target={`param-btn-${id}-${param.name}`}
                    onClick={(e) => {
                      const isAgent = !e.nativeEvent.isTrusted;
                      setOpenMenu(prev => prev?.type === 'param' && prev.ownerId === param.name ? null : { type: 'param', ownerId: isAgent ? param.name : param.name });
                    }}
                    className={`flex items-center gap-1.5 max-w-[120px] transition-colors group ${openMenu?.type === 'param' && openMenu.ownerId === param.name ? 'text-gray-900 dark:text-neutral-100' : 'hover:text-gray-900 dark:hover:text-neutral-200'}`}
                    title={param.description || param.title || param.name}
                  >
                    <Box className="w-3.5 h-3.5 opacity-70 shrink-0" />
                    <span className="font-semibold truncate">{String(currentLabel)}</span>
                    <ChevronDown className="w-3 h-3 opacity-50 group-hover:opacity-100 shrink-0" />
                  </button>
                  <AnimatePresence>
                    {openMenu?.type === 'param' && openMenu.ownerId === param.name && (
                      <motion.div
                        initial={{ opacity: 0, y: 5 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 5 }}
                        transition={{ duration: 0.15 }}
                        className="absolute bottom-[calc(100%+12px)] left-0 w-40 max-h-72 overflow-y-auto bg-gray-100 dark:bg-neutral-800 border border-gray-100 dark:border-[#404040] rounded-xl corner-squircle shadow-[0_8px_30px_rgb(0,0,0,0.12)] p-1.5 z-50 flex flex-col"
                      >
                        <div className="px-3 py-1 text-[10px] text-gray-400 truncate">{param.title || param.name}</div>
                        {param.enum?.map(option => (
                          <button
                            key={option}
                            type="button"
                            onClick={() => {
                              onUpdate(id, {
                                mcpParameters: {
                                  ...(data.mcpParameters || {}),
                                  [param.name]: option,
                                },
                              }, true);
                              setOpenMenu(null);
                            }}
                            className={`text-left px-3 py-2 rounded-lg corner-squircle text-[12px] font-medium transition-colors ${option === currentValue ? 'bg-gray-100 dark:bg-neutral-700 text-gray-900 dark:text-white' : 'text-gray-600 dark:text-neutral-300 hover:bg-gray-50 dark:hover:bg-neutral-700'}`}
                          >
                            {param.name === 'quality'
                              ? ('qualities' in selectedMcpModel ? selectedMcpModel.qualities.find(item => item.value === option)?.label : undefined) || String(option)
                              : param.name === 'duration' ? `${option}秒`
                              : param.name === 'enable_sound' ? (option ? '有声' : '静音')
                              : String(option)}
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}

            {/* Ratio Dropdown */}
            <div className="relative">
              <button
                data-agent-target={`ratio-btn-${id}`}
                onClick={(e) => {
                  const isAgent = !e.nativeEvent.isTrusted;
                  setOpenMenu(prev => prev?.type === 'ratio' ? null : { type: 'ratio', ownerId: isAgent ? 'agent' : 'user' });
                }}
                className={`flex items-center gap-1.5 transition-colors group ${openMenu?.type === 'ratio' ? 'text-gray-900 dark:text-neutral-100' : 'hover:text-gray-900 dark:hover:text-neutral-200'}`}
              >
                <div className="w-3.5 h-3 border-2 border-current rounded-[3px] opacity-70" />
                <span className="font-semibold">{ratio}</span>
                <ChevronDown className="w-3 h-3 opacity-50 group-hover:opacity-100" />
              </button>
              
              <AnimatePresence>
                {openMenu?.type === 'ratio' && (
                  <motion.div
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 5 }}
                    transition={{ duration: 0.15 }}
                    className="absolute bottom-[calc(100%+12px)] left-0 w-28 bg-gray-100 dark:bg-neutral-800 border border-gray-100 dark:border-[#404040] rounded-xl corner-squircle shadow-[0_8px_30px_rgb(0,0,0,0.12)] p-1.5 z-50 flex flex-col"
                  >
                    {ratios.map(r => (
                      <button 
                        key={r}
                        data-agent-target={`ratio-option-${id}-${r}`}
                        onClick={() => { onUpdate(id, { ratio: r }, true); setOpenMenu(null); }}
                        className={`text-left px-3 py-2 rounded-lg corner-squircle text-[13px] font-medium transition-colors ${r === ratio ? 'bg-gray-100 dark:bg-neutral-700 text-gray-900 dark:text-white' : 'text-gray-600 dark:text-neutral-300 hover:bg-gray-50 dark:hover:bg-neutral-700'}`}
                      >
                        {r}
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            
            <div className="w-[1px] h-3.5 bg-gray-300 dark:bg-neutral-700" />
            
            {/* Resolution Dropdown */}
            <div className="relative">
              <button 
                data-agent-target={`res-btn-${id}`}
                onClick={(e) => {
                  const isAgent = !e.nativeEvent.isTrusted;
                  setOpenMenu(prev => prev?.type === 'res' ? null : { type: 'res', ownerId: isAgent ? 'agent' : 'user' });
                }}
                className={`flex items-center gap-1.5 transition-colors group ${openMenu?.type === 'res' ? 'text-gray-900 dark:text-neutral-100' : 'hover:text-gray-900 dark:hover:text-neutral-200'}`}
              >
                <Layers className="w-3.5 h-3.5 opacity-70" />
                <span className="font-semibold">{res}</span>
                <ChevronDown className="w-3 h-3 opacity-50 group-hover:opacity-100" />
              </button>

              <AnimatePresence>
                {openMenu?.type === 'res' && (
                  <motion.div
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 5 }}
                    transition={{ duration: 0.15 }}
                    className="absolute bottom-[calc(100%+12px)] left-0 w-24 bg-gray-100 dark:bg-neutral-800 border border-gray-100 dark:border-[#404040] rounded-xl corner-squircle shadow-[0_8px_30px_rgb(0,0,0,0.12)] p-1.5 z-50 flex flex-col"
                  >
                    {resolutions.map(r => (
                      <button 
                        key={r}
                        data-agent-target={`res-option-${id}-${r}`}
                        onClick={() => { onUpdate(id, { res: r }, true); setOpenMenu(null); }}
                        className={`text-left px-3 py-2 rounded-lg corner-squircle text-[13px] font-medium transition-colors ${r === res ? 'bg-gray-100 dark:bg-neutral-700 text-gray-900 dark:text-white' : 'text-gray-600 dark:text-neutral-300 hover:bg-gray-50 dark:hover:bg-neutral-700'}`}
                      >
                        {r}
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Right Controls: Generate Arrow */}
          <button
            data-agent-target={`generate-btn-${id}`}
            onClick={handleGenerate}
            disabled={!localPrompt.trim() || state === 'generating'}
            className="w-8 h-8 rounded-full bg-gray-900 dark:bg-neutral-100 text-white dark:text-neutral-900 flex items-center justify-center hover:bg-black dark:hover:bg-white/10 disabled:opacity-50 transition-colors shadow-md"
          >
            <ArrowUp className="w-4 h-4 stroke-[3]" />
          </button>
        </div>
        </>
        )}
      </div>
      )}
      </motion.div>

      {/* Portal: Asset List Modal */}
      {showAssetPicker && typeof document !== 'undefined' && createPortal(
        <div 
          className="fixed inset-0 z-[1000] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm pointer-events-auto"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setShowAssetPicker(false)}
        >
          <div 
            className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col overflow-hidden text-neutral-900 dark:text-neutral-100"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 dark:border-neutral-800">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-amber-500/10 text-amber-500 dark:text-amber-400">
                  <Sparkles className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold">选择资产列表参考图</h3>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">从当前剧本中选择角色、场景或道具作为生图参考图</p>
                </div>
              </div>
              <button 
                type="button"
                onClick={() => setShowAssetPicker(false)}
                className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Filter and Search Bar */}
            <div className="px-6 py-3 border-b border-neutral-200 dark:border-neutral-800 flex items-center gap-3 bg-neutral-50/50 dark:bg-neutral-900/50">
              {/* Category tabs */}
              <div className="flex items-center gap-1 bg-neutral-200/60 dark:bg-neutral-800 p-1 rounded-xl text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setAssetFilter('all')}
                  className={`px-3 py-1.5 rounded-lg transition-colors ${assetFilter === 'all' ? 'bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm' : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'}`}
                >
                  全部 ({allAssetItems.length})
                </button>
                <button
                  type="button"
                  onClick={() => setAssetFilter('characters')}
                  className={`px-3 py-1.5 rounded-lg transition-colors ${assetFilter === 'characters' ? 'bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm' : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'}`}
                >
                  角色 ({characterItems.length})
                </button>
                <button
                  type="button"
                  onClick={() => setAssetFilter('locations')}
                  className={`px-3 py-1.5 rounded-lg transition-colors ${assetFilter === 'locations' ? 'bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm' : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'}`}
                >
                  场景 ({locationItems.length})
                </button>
                <button
                  type="button"
                  onClick={() => setAssetFilter('props')}
                  className={`px-3 py-1.5 rounded-lg transition-colors ${assetFilter === 'props' ? 'bg-white dark:bg-neutral-700 text-neutral-900 dark:text-white shadow-sm' : 'text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white'}`}
                >
                  道具 ({propItems.length})
                </button>
              </div>

              {/* Search input */}
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
                <input 
                  type="text"
                  value={assetSearch}
                  onChange={(e) => setAssetSearch(e.target.value)}
                  placeholder="搜索资产关键词..."
                  className="w-full pl-9 pr-3 py-1.5 text-xs rounded-xl bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 focus:outline-none focus:ring-2 focus:ring-amber-500/50 text-neutral-900 dark:text-neutral-100"
                />
              </div>
            </div>

            {/* Asset Items Grid */}
            <div className="flex-1 overflow-y-auto p-6 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {filteredAssets.length > 0 ? (
                filteredAssets.map((item, idx) => (
                  <button
                    key={`${item.id}_${idx}`}
                    type="button"
                    onClick={() => handleSelectAsset({ name: item.name, referenceImage: item.referenceImage, description: item.description })}
                    className="flex items-start gap-3 p-3 rounded-xl border border-neutral-200/80 dark:border-neutral-800 hover:border-amber-500/60 dark:hover:border-amber-500/60 hover:bg-amber-50/30 dark:hover:bg-amber-950/20 text-left transition-all group cursor-pointer"
                  >
                    <div className="w-14 h-14 rounded-lg overflow-hidden bg-neutral-100 dark:bg-neutral-800 flex-shrink-0 flex items-center justify-center border border-neutral-200 dark:border-neutral-700">
                      {item.referenceImage ? (
                        <img src={item.referenceImage} alt={item.name} referrerPolicy="no-referrer" className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                      ) : item.category === 'characters' ? (
                        <User className="w-6 h-6 text-neutral-400 group-hover:text-amber-500 transition-colors" />
                      ) : item.category === 'locations' ? (
                        <MapPin className="w-6 h-6 text-neutral-400 group-hover:text-amber-500 transition-colors" />
                      ) : (
                        <Box className="w-6 h-6 text-neutral-400 group-hover:text-amber-500 transition-colors" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold truncate group-hover:text-amber-600 dark:group-hover:text-amber-400 transition-colors">{item.name}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 font-medium">{item.categoryLabel}</span>
                      </div>
                      <p className="text-xs text-neutral-500 dark:text-neutral-400 truncate mt-0.5">{item.tag}</p>
                      {item.description && (
                        <p className="text-[11px] text-neutral-400 dark:text-neutral-500 line-clamp-2 mt-1 leading-snug">{item.description}</p>
                      )}
                    </div>
                  </button>
                ))
              ) : (
                <div className="col-span-full py-12 text-center text-neutral-400 dark:text-neutral-500 text-xs">
                  暂无匹配的资产条目
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
});


