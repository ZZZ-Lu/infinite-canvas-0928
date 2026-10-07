import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { AgentCursor } from './components/AgentCursor';
import { AgentContextMenu } from './components/AgentContextMenu';
import { GenerationCard, CardData, CARD_DIMENSIONS, getCardSize, safeParseJsonResponse, compressImageBlob, resolveReferenceToPayload } from './components/GenerationCard';
import { WORKRALLY_IMAGE_MODELS, WORKRALLY_IMAGE_TOOL } from './config/workrallyImageModels';
import { WORKRALLY_VIDEO_MODELS, WORKRALLY_VIDEO_TOOL } from './config/workrallyVideoModels';
import { NanoLodCanvas } from './components/NanoLodCanvas';
import { FpsCounter } from './components/FpsCounter';
import { generateImageThumbnail, generateVideoThumbnail, getOrCreateMediaThumbnail, thumbCache, MAX_THUMBNAIL_EDGE } from './utils/thumbnail';
import { fastGetImageDimensions } from './utils/imageHeader';
import { isCardIntersectingRectangle, getLodMountQuota, getNanoLodThreshold } from './utils/viewportCulling';
import { buildCardQuadTree, QuadTree, BoundingBox } from './utils/quadTree';
import { getBottomPanelHeight } from './utils/cardLayout';
import { createSquareLetterboxImage, createVerticalWidescreenSlices, unpadLandmarks } from './utils/squareImageLetterbox';
import { Plus, Minus, Undo2, Redo2, Bot, Sun, Moon, Settings, RefreshCw, Sparkles, Send, X, MousePointerClick, Video, ArrowUp } from 'lucide-react';
import { loadCards, saveCards, deleteCardsForProject, requestPersistence, loadAgentTraces, saveAgentTraces } from './db';
import { SettingsPage } from './components/SettingsPage';
import { getDrafts, saveDraft, deleteDraft } from './utils/draftDb';
import { McpKeyButton } from './components/McpKeyButton';
import { ProjectScriptBible } from './components/ProjectScriptBible';
import { ScriptProject, DEFAULT_PROJECT } from './types/script';
import { ScriptView } from './agent/scriptTools';
import type { AgentToolCall, AgentTurnResult } from './agent/protocol';
import { AgentRuntime, type RuntimeTask } from './agent/runtime';
import { snapshotRuntimeTask, type AgentRuntimeTrace } from './agent/debugTrace';
import { assetExtractionService } from './services/assetExtractionService';
import { getActiveMcpKey, getActiveMcpTokenSync, getMcpConfig } from './utils/mcpStorage';
import { CanvasLineageOverlay } from './components/CanvasLineageOverlay';
import { AGENT_TOOL_REGISTRY, getAgentToolConfig } from './agent/toolRegistry';
import { getPageComponentDefinition, type MouseActionName } from './agent/pageComponentRegistry';
import { buildAutoInjectedCardContext } from './agent/cardContextBuilder';
import { agentFocusManager, type AgentFocusSnapshot } from './agent/agentFocusManager';
import { AnimatePresence, motion, useMotionValue, animate, useMotionTemplate, useMotionValueEvent, useTransform } from 'motion/react';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const safeCreateObjectURL = (data: any): string | null => {
  if (!data) return null;
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    try {
      return URL.createObjectURL(data);
    } catch {
      return null;
    }
  }
  if (typeof MediaSource !== 'undefined' && data instanceof MediaSource) {
    try {
      return URL.createObjectURL(data);
    } catch {
      return null;
    }
  }
  return null;
};

export function dedupeReferenceImages(refs: any[]): any[] {
  if (!Array.isArray(refs)) return [];
  const seen = new Set<string>();
  return refs.filter(r => {
    const key = r.sourceCardId || r.url || r.name;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Reads only the portion of a textarea that is currently rendered in its
 * viewport. The temporary mirror is measurement infrastructure, never state:
 * the full textarea value is not returned to the Agent or persisted here.
 */
const getVisibleTextareaSnapshot = (textarea: HTMLTextAreaElement) => {
  const { value, scrollTop, clientHeight, scrollHeight } = textarea;
  const empty = {
    visibleText: '',
    characterRange: { start: 0, end: 0 },
    scroll: { top: 0, height: scrollHeight, viewportHeight: clientHeight, atTop: true, atBottom: true },
  };
  if (!value) return empty;

  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement('div');
  const copiedProperties = [
    'boxSizing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
    'textTransform', 'wordSpacing', 'wordBreak', 'wordWrap', 'tabSize',
  ] as const;
  mirror.style.position = 'fixed';
  mirror.style.left = '-100000px';
  mirror.style.top = '0';
  mirror.style.visibility = 'hidden';
  mirror.style.pointerEvents = 'none';
  mirror.style.overflow = 'hidden';
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  copiedProperties.forEach(property => { mirror.style[property] = style[property]; });
  const textNode = document.createTextNode(value);
  mirror.appendChild(textNode);
  document.body.appendChild(mirror);

  try {
    const mirrorTop = mirror.getBoundingClientRect().top;
    const topAt = (offset: number) => {
      const safe = Math.min(Math.max(offset, 0), Math.max(value.length - 1, 0));
      const range = document.createRange();
      range.setStart(textNode, safe);
      range.setEnd(textNode, Math.min(safe + 1, value.length));
      const rect = range.getClientRects()[0];
      return (rect?.top ?? mirror.scrollHeight) - mirrorTop;
    };
    const firstAtOrAfter = (verticalOffset: number) => {
      let low = 0;
      let high = value.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (topAt(middle) < verticalOffset) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    const start = firstAtOrAfter(Math.max(0, scrollTop - 2));
    const end = Math.min(value.length, Math.max(start, firstAtOrAfter(scrollTop + clientHeight + 2) + 1));
    return {
      visibleText: value.slice(start, Math.min(end, start + 2000)),
      characterRange: { start, end: Math.min(end, start + 2000) },
      scroll: {
        top: Math.round(scrollTop),
        height: Math.round(scrollHeight),
        viewportHeight: Math.round(clientHeight),
        atTop: scrollTop <= 1,
        atBottom: scrollTop + clientHeight >= scrollHeight - 2,
      },
    };
  } finally {
    mirror.remove();
  }
};

type AgentTaskLog = {
  id: string;
  title: string;
  status: 'running' | 'completed' | 'failed' | 'waiting_user' | 'paused' | 'cancelled';
  events: Array<{ id: string; text: string; kind: 'work' | 'tool' | 'answer' }>;
  cardContext?: Record<string, any>;
};

type ScriptSelection = {
  text: string;
  start: number;
  end: number;
  lineStart: number;
  lineEnd: number;
} | null;

interface MediaDimensions {
  width: number;
  height: number;
}

const getImageDimensions = (url: string): Promise<MediaDimensions> => {
  return new Promise((resolve) => {
    if (!url || url.trim() === '') {
      resolve({ width: 420, height: 560 });
      return;
    }
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 420, height: 560 });
    img.src = url;
  });
};

const getVideoDimensions = (url: string): Promise<MediaDimensions> => {
  return new Promise((resolve) => {
    if (!url || url.trim() === '') {
      resolve({ width: 640, height: 360 });
      return;
    }
    const video = document.createElement('video');
    (video as any).referrerPolicy = 'no-referrer';
    video.preload = 'metadata';
    video.onloadedmetadata = () => resolve({ width: video.videoWidth, height: video.videoHeight });
    video.onerror = () => resolve({ width: 640, height: 360 });
    video.src = url;
  });
};

const compressAndResizeImage = (file: File, maxDim = 1200, quality = 0.85): Promise<Blob> => {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.naturalWidth;
        let height = img.naturalHeight;
        
        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          const mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
          canvas.toBlob((blob) => {
            resolve(blob || file);
          }, mimeType, quality);
        } else {
          resolve(file);
        }
      };
      img.onerror = () => resolve(file);
      img.src = e.target?.result as string;
    };
    reader.onerror = () => resolve(file);
    reader.readAsDataURL(file);
  });
};

const getClosestAspectRatio = (width: number, height: number): '1:1' | '3:4' | '9:16' | '16:9' => {
  if (!width || !height) return '3:4';
  const fileRatio = width / height;
  const presets: { ratio: '1:1' | '3:4' | '9:16' | '16:9'; value: number }[] = [
    { ratio: '1:1', value: 1.0 },
    { ratio: '3:4', value: 0.75 },
    { ratio: '9:16', value: 0.5625 },
    { ratio: '16:9', value: 1.7778 }
  ];

  let closestRatio: '1:1' | '3:4' | '9:16' | '16:9' = '3:4';
  let minDiff = Infinity;

  presets.forEach((preset) => {
    const diff = Math.abs(fileRatio - preset.value);
    if (diff < minDiff) {
      minDiff = diff;
      closestRatio = preset.ratio;
    }
  });

  return closestRatio;
};

// Isolated Zoom Indicator HUD: Subscribes to tScale without triggering App root re-renders
const ZoomControlGroup: React.FC<{
  tScale: any;
  isOverviewMode: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
}> = React.memo(({ tScale, isOverviewMode, onZoomIn, onZoomOut, onZoomReset }) => {
  const [scaleVal, setScaleVal] = useState(() => tScale.get());

  useEffect(() => {
    let rafId: number | null = null;
    const unsub = tScale.on('change', (s: number) => {
      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          setScaleVal(s);
        });
      }
    });
    return () => {
      unsub();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [tScale]);

  const pct = Math.round(scaleVal * 100);
  let text = "";
  let colorClass = "";
  if (pct < 40) {
    text = "远景";
    colorClass = "text-blue-500 dark:text-blue-400";
  } else if (pct < 100) {
    text = "中景";
    colorClass = "text-emerald-500 dark:text-emerald-400";
  } else if (pct < 200) {
    text = "近景";
    colorClass = "text-amber-500 dark:text-amber-400";
  } else {
    text = "特写";
    colorClass = "text-rose-500 dark:text-rose-400";
  }

  return (
    <div 
      className="fixed bottom-6 left-6 z-50 flex items-center bg-gray-100/90 dark:bg-neutral-800/90 backdrop-blur-md border border-gray-200/80 dark:border-[#404040]/80 shadow-md rounded-[20px] corner-squircle p-1.5 gap-1 select-none"
      onPointerDown={e => e.stopPropagation()}
    >
      <button
        onClick={onZoomOut}
        disabled={isOverviewMode}
        className="p-1.5 rounded-xl corner-squircle hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-40 transition-colors"
        title="缩小"
      >
        <Minus className="w-3.5 h-3.5 text-gray-700 dark:text-neutral-300" />
      </button>
      
      <button
        onClick={onZoomReset}
        className="px-2 py-1 rounded-xl corner-squircle hover:bg-gray-200 dark:hover:bg-neutral-700 transition-colors text-[11px] font-bold font-mono text-gray-800 dark:text-neutral-200 min-w-[54px] flex items-center justify-center gap-1.5"
        title="重置到 100%"
      >
        {isOverviewMode ? (
          <span className="text-blue-500 dark:text-blue-400 font-semibold tracking-wide">
            全景
          </span>
        ) : (
          <>
            <span className={colorClass}>{text}</span>
            <span>{pct}%</span>
          </>
        )}
      </button>

      <button
        onClick={onZoomIn}
        disabled={scaleVal >= 4.99}
        className="p-1.5 rounded-xl corner-squircle hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-40 transition-colors"
        title="放大"
      >
        <Plus className="w-3.5 h-3.5 text-gray-700 dark:text-neutral-300" />
      </button>
    </div>
  );
});

export default function App() {
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Replace useState with useMotionValue for high-frequency transforms
  const initialTransform = useMemo(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('canvas_transform');
      if (saved) {
        try { return JSON.parse(saved); } catch (e) { }
      }
    }
    return { x: 0, y: 0, scale: 1 };
  }, []);

  const tx = useMotionValue(initialTransform.x);
  const ty = useMotionValue(initialTransform.y);
  const tScale = useMotionValue(initialTransform.scale);
  
  // Create derived motion values for the infinite background grid
  const gridBackgroundPosition = useMotionTemplate`${tx}px ${ty}px`;
  const gridBackgroundSize = useTransform(tScale, (s: any) => `${s * 48}px ${s * 48}px`);

  // Inject real-time scale as CSS variable for GPU-accelerated constant-width borders
  const updateCurrentScale = (latestScale: number) => {
    const workspace = document.getElementById('canvas-workspace');
    if (workspace) {
      workspace.style.setProperty('--current-scale', latestScale.toString());
    }
  };
  
  useMotionValueEvent(tScale, "change", updateCurrentScale);
  
  // Set initial scale on mount
  useEffect(() => {
    updateCurrentScale(tScale.get());
  }, []);

  const transformValues = useMemo(() => ({ tx, ty, tScale }), [tx, ty, tScale]);
  const targetTransform = useRef({ x: initialTransform.x, y: initialTransform.y, scale: initialTransform.scale });

  // Load canvas transform per project
  // DEFERRED to a child component or moved down where currentProjectId is defined.
  // For now, we will just use a generic motion value init, and we will sync the values later down in the file.

  // Debounced persistence for transform
  // We will handle the actual saving in a separate useEffect below once currentProjectId is defined.
  useEffect(() => {
    let timeout: NodeJS.Timeout;
    const saveTransform = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        const data = JSON.stringify({ x: tx.get(), y: ty.get(), scale: tScale.get() });
        // Legacy fallback only for now, actual project-specific save happens below
        localStorage.setItem('canvas_transform', data); 
      }, 300);
    };
    const unsubX = tx.on('change', saveTransform);
    const unsubY = ty.on('change', saveTransform);
    const unsubS = tScale.on('change', saveTransform);
    return () => { unsubX(); unsubY(); unsubS(); clearTimeout(timeout); };
  }, [tx, ty, tScale]);

  // Theme State
  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('theme_mode');
      if (saved) return saved === 'dark';
      return window.matchMedia('(prefers-color-scheme: dark)').matches;
    }
    return false;
  });

  const [showSettings, setShowSettings] = useState(false);
  const showSettingsRef = useRef(showSettings);
  useEffect(() => {
    showSettingsRef.current = showSettings;
  }, [showSettings]);

  const [isOverviewMode, setIsOverviewMode] = useState(false);
  const isOverviewModeRef = useRef(false);
  const preOverviewTransform = useRef<{ x: number, y: number, scale: number } | null>(null);
  const lastStableTransformRef = useRef<{ x: number, y: number, scale: number }>({ x: initialTransform.x, y: initialTransform.y, scale: initialTransform.scale });
  const [overviewViewportBox, setOverviewViewportBox] = useState<{ x: number, y: number, width: number, height: number } | null>(null);
  const [overviewCursorBox, setOverviewCursorBox] = useState<{ x: number, y: number, width: number, height: number } | null>(null);
  const overviewBoxScaleRef = useRef(1.0);
  const lastMouseClientPosRef = useRef<{ clientX: number; clientY: number }>({
    clientX: typeof window !== 'undefined' ? window.innerWidth / 2 : 500,
    clientY: typeof window !== 'undefined' ? window.innerHeight / 2 : 500,
  });

  const updateOverviewCursorBoxAt = useCallback((clientX: number, clientY: number, overrideTx?: number, overrideTy?: number, overrideScale?: number) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const cursorX = clientX - rect.left;
    const cursorY = clientY - rect.top;
    const currentScale = overrideScale !== undefined ? overrideScale : tScale.get();
    const currentTx = overrideTx !== undefined ? overrideTx : tx.get();
    const currentTy = overrideTy !== undefined ? overrideTy : ty.get();
    const worldX = (cursorX - currentTx) / currentScale;
    const worldY = (cursorY - currentTy) / currentScale;

    const baseTargetScale = preOverviewTransform.current ? preOverviewTransform.current.scale : 1.0;
    const effectiveTargetScale = Math.min(Math.max(0.05, baseTargetScale / overviewBoxScaleRef.current), 10.0);

    const boxLeft = worldX - (cursorX / effectiveTargetScale);
    const boxTop = worldY - (cursorY / effectiveTargetScale);
    const boxWidth = rect.width / effectiveTargetScale;
    const boxHeight = rect.height / effectiveTargetScale;

    setOverviewCursorBox({
      x: boxLeft,
      y: boxTop,
      width: boxWidth,
      height: boxHeight,
    });
  }, [tScale, tx, ty]);

  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      lastMouseClientPosRef.current = { clientX: e.clientX, clientY: e.clientY };
    };
    window.addEventListener('mousemove', handleGlobalMouseMove, { passive: true });
    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
    };
  }, []);

  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);
  const isSpacePressedRef = useRef(false);
  const wheelZoomOutAccumulatorRef = useRef(0);
  const [showOverviewPromptToast, setShowOverviewPromptToast] = useState(false);
  const [overviewPromptProgress, setOverviewPromptProgress] = useState(0);
  const overviewToastTimerRef = useRef<NodeJS.Timeout | null>(null);
  const resetOverviewPromptRef = useRef<() => void>(() => {});
  const enterOverviewModeRef = useRef<() => void>(() => {});
  const exitOverviewToOriginalRef = useRef<() => void>(() => {});

  // Track stable transform when NOT in overview mode to capture pre-overview state accurately
  useEffect(() => {
    const updateStable = () => {
      if (!isOverviewModeRef.current) {
        lastStableTransformRef.current = { x: tx.get(), y: ty.get(), scale: tScale.get() };
      }
    };
    const unsubX = tx.on('change', updateStable);
    const unsubY = ty.on('change', updateStable);
    const unsubS = tScale.on('change', updateStable);
    return () => { unsubX(); unsubY(); unsubS(); };
  }, [tx, ty, tScale]);

  useEffect(() => {
    if (!isOverviewMode) {
      setOverviewCursorBox(null);
      const timer = setTimeout(() => {
        setOverviewViewportBox(null);
      }, 420);
      return () => clearTimeout(timer);
    }
  }, [isOverviewMode]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDarkMode);
    localStorage.setItem('theme_mode', isDarkMode ? 'dark' : 'light');
  }, [isDarkMode]);

  // Projects & Script Bible State
  const [projects, setProjects] = useState<ScriptProject[]>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('script_projects');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          // Filter out legacy sample project if present
          const filtered = Array.isArray(parsed) 
            ? parsed.filter((p: ScriptProject) => p && p.id !== 'proj_blackstone_night' && p.name !== '黑石之夜')
            : [];
          if (filtered.length > 0) {
            return filtered.map((p: Partial<ScriptProject>) => ({
              ...DEFAULT_PROJECT,
              ...p,
              characters: Array.isArray(p.characters) ? p.characters : [],
              locations: Array.isArray(p.locations) ? p.locations : [],
              props: Array.isArray(p.props) ? p.props : [],
              scenes: Array.isArray(p.scenes) ? p.scenes : [],
              scriptText: typeof p.scriptText === 'string' ? p.scriptText : '',
              universe: { ...DEFAULT_PROJECT.universe, ...(p.universe || {}) },
            }));
          }
        } catch (e) {
          console.error('Failed to parse saved projects', e);
        }
      }
    }
    return [DEFAULT_PROJECT];
  });

  const [currentProjectId, setCurrentProjectId] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const savedId = localStorage.getItem('current_project_id');
      if (savedId && savedId !== 'proj_blackstone_night') return savedId;
    }
    return DEFAULT_PROJECT.id;
  });
  const rawProject = projects.find(p => p.id === currentProjectId) || projects[0] || DEFAULT_PROJECT;
  const currentProject = useMemo<ScriptProject>(() => ({
    ...DEFAULT_PROJECT,
    ...rawProject,
    characters: Array.isArray(rawProject.characters) ? rawProject.characters : [],
    locations: Array.isArray(rawProject.locations) ? rawProject.locations : [],
    props: Array.isArray(rawProject.props) ? rawProject.props : [],
    scenes: Array.isArray(rawProject.scenes) ? rawProject.scenes : [],
    scriptText: typeof rawProject.scriptText === 'string' ? rawProject.scriptText : '',
    universe: { ...DEFAULT_PROJECT.universe, ...(rawProject.universe || {}) },
  }), [rawProject]);

  const [isScriptDrawerOpen, setIsScriptDrawerOpen] = useState(false);
  const [isScriptTocOpen, setIsScriptTocOpen] = useState(false);
  const [isScriptTocAtBottom, setIsScriptTocAtBottom] = useState(false);
  const [tocScrollRequest, setTocScrollRequest] = useState<{ id: number; delta: number } | null>(null);
  const [scriptViewRequest, setScriptViewRequest] = useState<ScriptView>('script');
  const [requestedTocItemId, setRequestedTocItemId] = useState<string | null>(null);
  const [scriptSelection, setScriptSelection] = useState<ScriptSelection>(null);
  const scriptViewRef = useRef({ drawerOpen: false, tocOpen: false, tocAtBottom: false, activeView: 'script' as ScriptView, activeEpisodeId: null as string | null });
  const [agentTask, setAgentTask] = useState<AgentTaskLog | null>(null);
  const agentTaskScrollRef = useRef<HTMLDivElement>(null);
  const [isTaskChatOpen, setIsTaskChatOpen] = useState(false);
  const [taskChatMessage, setTaskChatMessage] = useState('');
  const taskChatInputRef = useRef<HTMLInputElement>(null);
  
  useEffect(() => {
    if (agentTaskScrollRef.current) {
      agentTaskScrollRef.current.scrollTop = agentTaskScrollRef.current.scrollHeight;
    }
  }, [agentTask?.events]);
  const [agentRuntimeTraces, setAgentRuntimeTraces] = useState<AgentRuntimeTrace[]>([]);
  
  useEffect(() => {
    loadAgentTraces().then(saved => {
      if (saved && saved.length > 0) setAgentRuntimeTraces(saved);
    }).catch(console.error);
  }, []);

  useEffect(() => {
    if (agentRuntimeTraces.length > 0) {
      saveAgentTraces(agentRuntimeTraces).catch(console.error);
    }
  }, [agentRuntimeTraces]);

  const updateAgentRuntimeTrace = useCallback((task: RuntimeTask, update?: (trace: AgentRuntimeTrace) => AgentRuntimeTrace) => {
    const taskSnapshot = snapshotRuntimeTask(task);
    setAgentRuntimeTraces(current => {
      const now = Date.now();
      const existing = current.find(trace => trace.taskId === task.id);
      const base: AgentRuntimeTrace = existing || {
        id: `trace_${task.id}`,
        taskId: task.id,
        goal: task.goal,
        createdAt: now,
        updatedAt: now,
        task: taskSnapshot,
        turns: [],
      };
      const next = update ? update({ ...base, task: taskSnapshot, updatedAt: now }) : { ...base, task: taskSnapshot, updatedAt: now };
      return [...current.filter(trace => trace.taskId !== task.id), next].slice(-12);
    });
  }, []);

  // An Agent may act only on a target it has actually received from page.inspect.
  // This closes the gap between a semantic target registry and human-visible UI.
  const observedTargetsByTaskRef = useRef(new Map<string, Set<string>>());

  const setDrawerOpen = useCallback((open: boolean) => {
    scriptViewRef.current.drawerOpen = open;
    setIsScriptDrawerOpen(open);
    if (!open) {
      scriptViewRef.current.tocOpen = false;
      setIsScriptTocOpen(false);
      setScriptSelection(null);
    }
  }, []);
  const setTocOpen = useCallback((open: boolean) => {
    scriptViewRef.current.tocOpen = open;
    setIsScriptTocOpen(open);
  }, []);
  const setTocAtBottom = useCallback((atBottom: boolean) => {
    scriptViewRef.current.tocAtBottom = atBottom;
    setIsScriptTocAtBottom(atBottom);
  }, []);

  useEffect(() => {
    const updatePointer = (e: MouseEvent | PointerEvent | WheelEvent) => {
      (window as any).__lastMousePos = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('pointermove', updatePointer, { passive: true, capture: true });
    window.addEventListener('pointerdown', updatePointer, { passive: true, capture: true });
    window.addEventListener('wheel', updatePointer, { passive: true, capture: true });
    return () => {
      window.removeEventListener('pointermove', updatePointer, true);
      window.removeEventListener('pointerdown', updatePointer, true);
      window.removeEventListener('wheel', updatePointer, true);
    };
  }, []);

  useEffect(() => {
    scriptViewRef.current = {
      drawerOpen: isScriptDrawerOpen,
      tocOpen: isScriptTocOpen,
      tocAtBottom: isScriptTocAtBottom,
      activeView: scriptViewRef.current.activeView,
      activeEpisodeId: scriptViewRef.current.activeEpisodeId,
    };
  }, [isScriptDrawerOpen, isScriptTocOpen, isScriptTocAtBottom]);

  const setScriptView = useCallback((view: ScriptView) => {
    scriptViewRef.current.activeView = view;
    setScriptViewRequest(view);
  }, []);

  const handleTocItemOpened = useCallback((item: { id: string; type: string }) => {
    scriptViewRef.current.activeEpisodeId = item.type === 'episode' ? item.id : null;
    setRequestedTocItemId(null);
  }, []);

  // Sync projects to localStorage
  useEffect(() => {
    localStorage.setItem('script_projects', JSON.stringify(projects));
  }, [projects]);

  useEffect(() => {
    localStorage.setItem('current_project_id', currentProjectId);
  }, [currentProjectId]);

  const handleRenameProject = (projectId: string, newName: string) => {
    setProjects(prev => prev.map(p => p.id === projectId ? { ...p, name: newName, updatedAt: Date.now() } : p));
  };

  const handleUpdateCurrentProject = (updated: Partial<ScriptProject>) => {
    setProjects(prev => prev.map(p => p.id === currentProject.id ? { ...p, ...updated, updatedAt: Date.now() } : p));
  };

  const handleRequestGenerateAsset = (assetName: string, promptText: string) => {
    const centerX = (window.innerWidth / 2 - tx.get()) / tScale.get();
    const centerY = (window.innerHeight / 2 - ty.get()) / tScale.get();

    const newId = Math.random().toString(36).substring(2, 11);
    const newCard: CardData = {
      id: newId,
      x: centerX - 210,
      y: centerY - 280,
      state: 'draft',
      ratio: '3:4',
      res: '2K',
      prompt: promptText,
      imageUrl: null
    };

    setCards(prev => [...prev, newCard]);
    setSelectedCardIds([newId]);
    setDrawerOpen(false);
  };

  const [isDragging, setIsDragging] = useState(false);
  const [isZooming, setIsZooming] = useState(false);
  const isZoomingRef = useRef(false);
  const isZoomAnimationActiveRef = useRef(false);
  const [isZoomAnimationActive, setIsZoomAnimationActive] = useState(false);
  const zoomTimeoutRef = useRef<NodeJS.Timeout>();
  const doubleClickTimeoutRef = useRef<NodeJS.Timeout>();
  const lastPointer = useRef({ x: 0, y: 0 });
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([]);
  const [selectionBox, setSelectionBox] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    initialSelectedIds: string[];
  } | null>(null);

  const [agentSelectionBox, setAgentSelectionBox] = useState<{
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);

  // Agent State
  const [agentState, setAgentState] = useState<{
    x: number;
    y: number;
    visible: boolean;
    isActive: boolean;
    isMoving: boolean;
    speak?: string;
    lastPrompt?: string;
    cursorMode?: 'default' | 'inspect' | 'working' | 'interact';
  }>(() => ({ 
    x: typeof window !== 'undefined' ? window.innerWidth - 80 : 0, 
    y: typeof window !== 'undefined' ? window.innerHeight - 150 : 0, 
    visible: true, 
    isActive: false,
    isMoving: false,
    cursorMode: 'default',
  }));
  const [agentFocus, setAgentFocus] = useState<AgentFocusSnapshot>(() => agentFocusManager.getSnapshot());
  useEffect(() => {
    return agentFocusManager.subscribe((snapshot) => {
      setAgentFocus(snapshot);
      setAgentState(prev => prev.cursorMode !== snapshot.cursorMode ? { ...prev, cursorMode: snapshot.cursorMode } : prev);
    });
  }, []);
  const [isAgentRunning, setIsAgentRunning] = useState(false);
  const isAgentRunningRef = useRef(false);
  isAgentRunningRef.current = isAgentRunning;
  const [agentPrompt, setAgentPrompt] = useState("");
  const [agentQuestion, setAgentQuestion] = useState<{ question: string, resolve: (val: string) => void } | null>(null);
  const [isAgentThinking, setIsAgentThinking] = useState(false);
  const [agentQuickInput, setAgentQuickInput] = useState<{
    isOpen: boolean;
    x?: number;
    y?: number;
    canvasX?: number;
    canvasY?: number;
    targetId: string | null;
    targetIds?: string[];
    lastReply?: string;
    focusTrigger?: number;
  } | null>(null);
  const [cardDrafts, setCardDrafts] = useState<Record<string, string>>({});

  // Load drafts from IndexedDB on startup
  useEffect(() => {
    getDrafts().then(drafts => {
      if (drafts) {
        setCardDrafts(drafts);
      }
    });
  }, []);

  const isUserPointerDownRef = useRef(false);
  const runtimeRef = useRef<AgentRuntime | null>(null);
  const activeTaskIdRef = useRef<string | null>(null);
  const agentSpeakTimerRef = useRef<NodeJS.Timeout | null>(null);
  const spaceLongPressTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const onDown = () => { isUserPointerDownRef.current = true; };
    const onUp = () => { isUserPointerDownRef.current = false; };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, []);

  const parseAgentCommunication = useCallback((rawText: string) => {
    let shortText = '';
    let fullText = '';
    if (!rawText || typeof rawText !== 'string') {
      return { shortText: '', fullText: '' };
    }

    const lines = rawText.split('\n');
    let activeMode: 'none' | 'short' | 'full' = 'none';
    const shortBuffer: string[] = [];
    const fullBuffer: string[] = [];

    const shortStartRegex = /(?:简版|对用户说的话\s*[\(（]简版[\)）])\s*[:：]\s*(.*)/i;
    const fullStartRegex = /(?:完整版|对用户说的话\s*[\(（]完整版[\)）])\s*[:：]\s*(.*)/i;

    for (const line of lines) {
      const trimmedLine = line.trim();

      // Check if this line starts a new section
      const isShortStart = shortStartRegex.test(line);
      const isFullStart = fullStartRegex.test(line);
      
      // Stop collecting if we hit a block ending indicator on a new line
      const isBlockEnd = trimmedLine === '}' || trimmedLine === ']' || trimmedLine.startsWith('{{') || trimmedLine.startsWith('调用');

      if (isShortStart) {
        activeMode = 'short';
        const match = line.match(shortStartRegex);
        if (match) {
          shortBuffer.push(match[1]);
        }
        continue;
      } else if (isFullStart) {
        activeMode = 'full';
        const match = line.match(fullStartRegex);
        if (match) {
          fullBuffer.push(match[1]);
        }
        continue;
      } else if (isBlockEnd || (trimmedLine.startsWith('-') && (trimmedLine.includes('对用户') || trimmedLine.includes('简版') || trimmedLine.includes('完整版')))) {
        activeMode = 'none';
      }

      if (activeMode === 'short') {
        shortBuffer.push(line);
      } else if (activeMode === 'full') {
        fullBuffer.push(line);
      }
    }

    if (shortBuffer.length > 0) {
      // Join lines and clean up quotes/braces at the very ends of the gathered block
      shortText = shortBuffer.join('\n').trim();
      shortText = shortText.replace(/^[“"「‘]/, '').replace(/[”"」’]$/, '').trim();
    }
    if (fullBuffer.length > 0) {
      fullText = fullBuffer.join('\n').trim();
      fullText = fullText.replace(/^[“"「‘]/, '').replace(/[”"」’]$/, '').trim();
    }

    // --- FALLBACKS ---
    // 1. Regex fallback just in case lines are joined or on a single line
    if (!shortText) {
      const shortMatch = rawText.match(/(?:简版|对用户说的话\s*[\(（]简版[\)）])\s*[:：]\s*[“"「]?([^"\r\n”」]+)/i);
      if (shortMatch) {
        shortText = shortMatch[1].trim().replace(/^[“"「‘]/, '').replace(/[”"」’]$/, '').trim();
      }
    }
    if (!fullText) {
      const fullMatch = rawText.match(/(?:完整版|对用户说的话\s*[\(（]完整版[\)）])\s*[:：]\s*[“"「]?([^”」｝}]+)/i);
      if (fullMatch) {
        fullText = fullMatch[1].trim().replace(/^[“"「‘]/, '').replace(/[”"」’]$/, '').trim();
      }
    }

    // 2. Heuristic fallback
    if (!shortText) {
      const cleanPara = rawText.trim();
      const firstSentence = cleanPara.split(/[。！？\n]/)[0] || cleanPara;
      shortText = firstSentence.replace(/^[“"'「‘(（\-*\s]+/, '').replace(/[”"'」｝}）)；;\s]+$/, '').trim();
      if (shortText.length > 40) {
        shortText = shortText.slice(0, 38) + '...';
      }
    }
    if (!fullText) {
      fullText = rawText;
    }

    return { shortText, fullText };
  }, []);

  const panToCanvasPos = (canvasX: number, canvasY: number) => {
    if (isUserPointerDownRef.current) return;
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA') && !activeEl.hasAttribute('data-agent-target')) return;
    
    const targetTx = window.innerWidth / 2 - canvasX * tScale.get();
    const targetTy = window.innerHeight / 2 - canvasY * tScale.get();
    
    targetTransform.current.x = targetTx;
    targetTransform.current.y = targetTy;

    animate(tx, targetTx, { duration: 0.4, ease: [0.33, 1, 0.68, 1] });
    animate(ty, targetTy, { duration: 0.4, ease: [0.33, 1, 0.68, 1] });
  };

  const centerCardOnScreen = useCallback((cardX: number, cardY: number, cardW: number, cardH: number) => {
    const cardCenterX = cardX + cardW / 2;
    const cardCenterY = cardY + cardH / 2;
    const currentScale = tScale.get();
    
    const targetTx = window.innerWidth / 2 - cardCenterX * currentScale;
    const targetTy = window.innerHeight / 2 - cardCenterY * currentScale;
    
    targetTransform.current.x = targetTx;
    targetTransform.current.y = targetTy;

    animate(tx, targetTx, { duration: 0.45, ease: [0.16, 1, 0.3, 1] });
    animate(ty, targetTy, { duration: 0.45, ease: [0.16, 1, 0.3, 1] });
  }, [tScale, tx, ty]);

  // State for Cards & History
  const [isLoading, setIsLoading] = useState(true);
  const [history, setHistory] = useState<{ past: CardData[][], present: CardData[], future: CardData[][] }>({
    past: [],
    present: [],
    future: []
  });
  const cards = history.present;
  const cardsRef = useRef<CardData[]>(cards);
  cardsRef.current = cards;
  const clipboardRef = useRef<CardData[]>([]);

  const toChineseNumber = (n: number): string => {
    const digits = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'];
    if (n <= 10) return digits[n];
    return String(n);
  };

  const getSelectionPromptText = (selectedCards: CardData[] | null | undefined): string => {
    if (!selectedCards || selectedCards.length === 0) {
      return '我能帮什么忙？';
    }

    const count = selectedCards.length;
    if (count === 1) {
      const card = selectedCards[0];
      const isVideo = Boolean(card.isVideo);
      const mediaType = isVideo ? '视频' : '图片';
      const rawName = (card.name || card.fileName || '').replace(/\.[^/.]+$/, '').trim();

      if (rawName && rawName.length <= 14) {
        return `看到了，选择了${mediaType}“${rawName}”，有什么想法？`;
      }
      return `看到了，选择了${isVideo ? '一个视频' : '一张图片'}，有什么想法？`;
    }

    const videoCount = selectedCards.filter(c => c.isVideo).length;
    const imageCount = count - videoCount;

    if (videoCount === 0) {
      return `看到了，选择了${toChineseNumber(imageCount)}张图片，有什么想法？`;
    }
    if (imageCount === 0) {
      return `看到了，选择了${toChineseNumber(videoCount)}个视频，有什么想法？`;
    }
    return `看到了，选择了${toChineseNumber(imageCount)}张图片和${toChineseNumber(videoCount)}个视频，有什么想法？`;
  };

  const isSelectionPromptSpeak = (speak?: string): boolean => {
    if (!speak) return false;
    return (
      speak === '我能帮什么忙？' ||
      speak.includes('有什么想法？') ||
      speak.includes('要调整什么？') ||
      speak.startsWith('看到了') ||
      speak.startsWith('选中了')
    );
  };

  const handleStartAgentBoxSelect = useCallback((startX: number, startY: number) => {
    setAgentSelectionBox({
      startX,
      startY,
      currentX: startX,
      currentY: startY
    });
  }, []);

  const handleUpdateAgentBoxSelect = useCallback((currentX: number, currentY: number) => {
    setAgentSelectionBox(prev => {
      if (!prev) return null;
      const next = { ...prev, currentX, currentY };
      
      const minX = Math.min(next.startX, next.currentX);
      const maxX = Math.max(next.startX, next.currentX);
      const minY = Math.min(next.startY, next.currentY);
      const maxY = Math.max(next.startY, next.currentY);

      // Simple box intersection math against all cards
      const newlySelectedCards = cardsRef.current.filter(card => {
        const dim = getCardSize(card);
        return (
          card.x < maxX && 
          card.x + dim.width > minX && 
          card.y < maxY && 
          card.y + dim.height > minY
        );
      });
      const newlySelectedIds = newlySelectedCards.map(c => c.id);

      // Sync focus seamlessly into agentFocusManager
      if (newlySelectedIds.length > 0) {
        agentFocusManager.batchSetFocus({
          primary: newlySelectedIds[0],
          references: newlySelectedIds.slice(1),
          role: 'inspect',
          sourceTool: 'user.box_select',
          cursorMode: 'inspect',
        });
      } else {
        agentFocusManager.clearAll();
      }

      // Calculate screen position of the prompt bubble
      const screenX = next.startX * tScale.get() + tx.get();
      const screenY = next.startY * tScale.get() + ty.get();

      // Dynamically target these cards under the Agent!
      setAgentQuickInput(prevQuick => {
        const targetId = newlySelectedIds[0] || null;
        const promptText = getSelectionPromptText(newlySelectedCards);
        
        setAgentState(prevAgent => ({
          ...prevAgent,
          speak: promptText
        }));

        if (!prevQuick) {
          return {
            isOpen: true,
            x: screenX,
            y: screenY,
            canvasX: next.startX,
            canvasY: next.startY,
            targetId,
            targetIds: newlySelectedIds,
            focusTrigger: Date.now()
          };
        }
        return {
          ...prevQuick,
          targetId,
          targetIds: newlySelectedIds,
        };
      });

      return next;
    });
  }, [tScale, tx, ty]);

  const handleEndAgentBoxSelect = useCallback(() => {
    setAgentSelectionBox(null);
  }, []);

  const handleDragAgentEnd = useCallback((finalCanvasX: number, finalCanvasY: number, screenX: number, screenY: number) => {
    // Perform hit test on cards using pure data layer (reverse order for top-most z-index)
    const allCards = cardsRef.current.length > 0 ? cardsRef.current : cards;
    let hitCard: CardData | null = null;
    for (let i = allCards.length - 1; i >= 0; i--) {
      const c = allCards[i];
      const dim = getCardSize(c);
      if (finalCanvasX >= c.x && finalCanvasX <= c.x + dim.width && finalCanvasY >= c.y && finalCanvasY <= c.y + dim.height) {
        hitCard = c;
        break;
      }
    }

    // Dismiss any standard context menu
    setContextMenus(prev => { const next = {...prev}; delete next['user']; return next; });

    if (hitCard) {
      setSelectedCardIds([hitCard.id]);
      agentFocusManager.setPrimaryFocus(hitCard.id, 'inspect', 'user.drag_agent');
      agentFocusManager.setCursorMode('inspect');
      const promptText = getSelectionPromptText([hitCard]);
      const lastReplyObj = hitCard.chatHistory && hitCard.chatHistory.length > 0
        ? [...hitCard.chatHistory].reverse().find(m => m.role === 'assistant' && !m.text.includes('生好了，我先看下'))
        : undefined;
      const lastReply = lastReplyObj ? ((lastReplyObj as any).shortText || lastReplyObj.text) : undefined;

      setAgentState(prev => ({
        ...prev,
        x: finalCanvasX,
        y: finalCanvasY,
        speak: promptText,
        isMoving: false,
        visible: true
      }));
      setAgentQuickInput({
        isOpen: true,
        x: screenX,
        y: screenY,
        canvasX: finalCanvasX,
        canvasY: finalCanvasY,
        targetId: hitCard.id,
        lastReply,
        focusTrigger: Date.now()
      });
    } else {
      setSelectedCardIds([]);
      agentFocusManager.clearAll();
      const promptText = getSelectionPromptText([]);
      setAgentState(prev => ({
        ...prev,
        x: finalCanvasX,
        y: finalCanvasY,
        speak: promptText,
        isMoving: false,
        visible: true
      }));
      setAgentQuickInput({
        isOpen: true,
        x: screenX,
        y: screenY,
        canvasX: finalCanvasX,
        canvasY: finalCanvasY,
        targetId: null,
        lastReply: undefined,
        focusTrigger: Date.now()
      });
    }
  }, [cards]);

  // Click on Agent pointer to toggle hide/show
  const handleClickAgentPointer = useCallback(() => {
    // If HUD is open/visible (has speak or quickInput), clicking hides it
    if (agentState.speak || agentQuickInput?.isOpen) {
      if (agentSpeakTimerRef.current) clearTimeout(agentSpeakTimerRef.current);
      setAgentState(prev => ({ ...prev, speak: undefined }));
      
      // Clear the current active card draft and persist delete to IndexedDB on close
      const currentTarget = agentQuickInput?.targetId || 'global';
      setCardDrafts(prev => ({ ...prev, [currentTarget]: '' }));
      deleteDraft(currentTarget);

      setAgentQuickInput(null);
      agentFocusManager.clearAll();
    } else {
      // If HUD is hidden, clicking restores it
      const allCards = cardsRef.current.length > 0 ? cardsRef.current : cards;
      let hitCard: CardData | null = null;
      for (let i = allCards.length - 1; i >= 0; i--) {
        const c = allCards[i];
        const dim = getCardSize(c);
        if (agentState.x >= c.x && agentState.x <= c.x + dim.width && agentState.y >= c.y && agentState.y <= c.y + dim.height) {
          hitCard = c;
          break;
        }
      }

      const screenX = agentState.x * tScale.get() + tx.get();
      const screenY = agentState.y * tScale.get() + ty.get();

      if (hitCard) {
        setSelectedCardIds([hitCard.id]);
        agentFocusManager.setPrimaryFocus(hitCard.id, 'inspect', 'user.click_pointer');
        agentFocusManager.setCursorMode('inspect');
        const promptText = getSelectionPromptText([hitCard]);
        const lastReplyObj = hitCard.chatHistory && hitCard.chatHistory.length > 0
          ? [...hitCard.chatHistory].reverse().find(m => m.role === 'assistant' && !m.text.includes('生好了，我先看下'))
          : undefined;
        const lastReply = lastReplyObj ? ((lastReplyObj as any).shortText || lastReplyObj.text) : undefined;

        setAgentState(prev => ({
          ...prev,
          speak: promptText,
          isMoving: false,
          visible: true
        }));
        setAgentQuickInput({
          isOpen: true,
          x: screenX,
          y: screenY,
          canvasX: agentState.x,
          canvasY: agentState.y,
          targetId: hitCard.id,
          lastReply,
          focusTrigger: Date.now()
        });
      } else {
        const promptText = getSelectionPromptText([]);
        setAgentState(prev => ({
          ...prev,
          speak: promptText,
          isMoving: false,
          visible: true
        }));
        setAgentQuickInput({
          isOpen: true,
          x: screenX,
          y: screenY,
          canvasX: agentState.x,
          canvasY: agentState.y,
          targetId: null,
          lastReply: undefined,
          focusTrigger: Date.now()
        });
      }
    }
  }, [agentState.speak, agentState.x, agentState.y, agentQuickInput?.isOpen, agentQuickInput?.targetId, cards, deleteDraft, setCardDrafts, tScale, tx, ty]);

  // Canvas Reference Picker Session State
  const [pickerSession, setPickerSession] = useState<{
    targetCardId: string;
    selectedReferences: Array<{
      url: string;
      name?: string;
      fileData?: Blob;
      sourceCardId?: string;
    }>;
    initialCamera: { x: number; y: number; scale: number };
  } | null>(null);
  const pickerSessionRef = useRef(pickerSession);
  pickerSessionRef.current = pickerSession;

  const nanoDragRef = useRef<{
    cardId: string;
    startX: number;
    startY: number;
    didMove: boolean;
    initialCards: { id: string; x: number; y: number }[];
  } | null>(null);
  const loadedProjectIdRef = useRef<string | null>(null);
  const recoveringTaskIdsRef = useRef(new Set<string>());

  // 🎯 Serialized Card Inspection Queue: ensures agent reviews multiple completed cards one by one
  interface InspectQueueItem {
    targetCard: CardData;
    mediaUrl: string;
    taskId: string;
  }
  const inspectQueueRef = useRef<InspectQueueItem[]>([]);
  const isProcessingInspectQueueRef = useRef(false);
  const processInspectQueueRef = useRef<() => Promise<void>>(async () => {});
  const extractCardImageBase64Ref = useRef<(card: CardData) => Promise<string | undefined>>(async () => undefined);

  const processInspectQueue = useCallback(async () => {
    // 🛡️ 统一排队互斥锁：如果当前 Agent 正在分发创建卡片或执行工具流，严禁中途抢占视角与打断鼠标！
    if (isAgentRunningRef.current || isProcessingInspectQueueRef.current) return;
    isProcessingInspectQueueRef.current = true;

    try {
      while (inspectQueueRef.current.length > 0) {
        const item = inspectQueueRef.current.shift();
        if (!item) break;
        const { targetCard, mediaUrl, taskId } = item;

        // Obtain fresh card from cardsRef to ensure latest coordinate/state
        const freshCard = cardsRef.current.find(c => c.id === targetCard.id) || targetCard;

        const taskCardContext = {
          cardId: freshCard.id,
          targetId: freshCard.id,
          title: freshCard.fileName || '生图卡片',
          prompt: freshCard.prompt,
          aspectRatio: freshCard.ratio,
          resolution: freshCard.res,
          imageUrl: mediaUrl,
          markdownSummary: `卡片【${freshCard.id}】AI 生图渲染完成。画面 URL: ${mediaUrl}`
        };

        const instantNotice = '图生好了，我先看下...';

        // 1. Calculate target card center position & dimensions
        const dim = getCardSize(freshCard);
        const cardCenterX = freshCard.x + dim.width / 2;
        const cardCenterY = freshCard.y + dim.height / 2;

        // 2. Smoothly center camera viewport to focus on this card
        centerCardOnScreen(freshCard.x, freshCard.y, dim.width, dim.height);

        // 3. Mark focus in agentFocusManager (inspect mode - QC scenario)
        // 触发开始：在显示“图生好了，我先看下...”开始时同步触发卡片质检端详
        agentFocusManager.setCursorMode('inspect');
        agentFocusManager.setPrimaryFocus(freshCard.id, 'inspect', 'card.inspect.qc');

        // 4. Move mouse cursor to target card with visible glide animation & speak HUD
        setAgentState(prev => ({
          ...prev,
          x: cardCenterX,
          y: cardCenterY,
          visible: true,
          isMoving: true,
          isActive: true,
          speak: instantNotice,
        }));

        // Wait for cursor glide to reach target card (350ms)
        await sleep(350);

        setAgentState(prev => ({
          ...prev,
          isMoving: false,
          isActive: true,
        }));

        // 5. Extract card image for vision evaluation
        let imgBase64: string | null = null;
        try {
          imgBase64 = await Promise.race([
            extractCardImageBase64Ref.current(freshCard),
            new Promise<null>((r) => setTimeout(() => r(null), 1200))
          ]);
        } catch {}

        // 6. 🌟 查看的时长完全由模型的回复时长决定：
        // 在大模型生成评语的整个在途期间，Mira 持续处于“图生好了，我先看下...”的端详状态，卡片端详漫游动效持续生动运行！
        let reviewText = '';
        const task = runtimeRef.current && taskId ? runtimeRef.current.getTask(taskId) : null;

        if (runtimeRef.current && task && task.status !== 'cancelled' && task.status !== 'failed') {
          // 主任务唤醒分支：将出图事实作为事件注入主任务，并调用 runtime.wake(taskId) 推进主循环（如 第 3 轮）
          // 这会自动触发 requestTurn，进而完整记录到【节点调试台 - 运行追踪】对应会话的轮次列表中！
          task.cardContext = taskCardContext;
          if (imgBase64) {
            task.images = [imgBase64];
          }
          const reawakeMsg = `[系统通知] 生图卡片【${freshCard.id}】已在后台成功完成 AI 图像渲染！最新画面 URL: ${mediaUrl}。请向用户汇报渲染已完成，并对生成效果做简要说明。`;
          const preEventsCount = task.events.length;
          runtimeRef.current.addUserInput(
            taskId,
            reawakeMsg,
            imgBase64 ? [imgBase64] : undefined,
            taskCardContext
          );

          try {
            const updatedTask = await runtimeRef.current.wake(taskId);
            if (updatedTask) {
              const turnAnswers = updatedTask.events.slice(preEventsCount).filter(e => e.type === 'answer' && e.text && e.text.trim() && !e.text.includes('我先看下'));
              const latestReview = turnAnswers[turnAnswers.length - 1];
              if (latestReview) {
                reviewText = latestReview.text;
              }
            }
          } catch (e) {
            console.warn('[App] Agent background re-awakening failed:', e);
          }
        }

        // 独立生图兜底分支（例如用户在画布直接点击生成，没有前置主任务）：
        // 也通过 updateAgentRuntimeTrace 创建规范的质检追踪会话并记录轮次！
        if (!reviewText) {
          const now = Date.now();
          const standaloneTaskId = taskId || `qc_${Date.now().toString(36)}`;
          const standaloneTask: RuntimeTask = {
            id: standaloneTaskId,
            sessionId: standaloneTaskId,
            goal: `自主质检查看卡片【${freshCard.id}】`,
            title: `卡片质检【${freshCard.id}】`,
            turn: 1,
            status: 'planning',
            summary: '',
            progress: '正在查看出图效果',
            plan: [{ id: '1', title: '查看出图效果', status: 'pending' }],
            history: [],
            observations: [],
            events: [{
              id: `evt_qc_in_${now}`,
              taskId: standaloneTaskId,
              turnId: `${standaloneTaskId}:turn:1`,
              type: 'user',
              text: `生图卡片【${freshCard.id}】已完成渲染，请向用户汇报出图效果。`,
              createdAt: now,
            }],
            pendingCallIds: [],
            negotiationLog: [{ role: 'user', content: `生图卡片【${freshCard.id}】已完成渲染，请向用户汇报出图效果。`, timestamp: now }],
            lastGoalUpdatedAt: now,
            lastUserInputAt: now,
            cardContext: taskCardContext,
            images: imgBase64 ? [imgBase64] : undefined,
          };
          const turnId = `${standaloneTaskId}:turn:1`;
          updateAgentRuntimeTrace(standaloneTask, trace => ({
            ...trace,
            turns: [{
              id: turnId,
              turn: 1,
              requireTool: false,
              startedAt: now,
              taskBefore: snapshotRuntimeTask(standaloneTask),
            }],
          }));

          try {
            const agentModel = assetExtractionService.getNodeModels().agentModel;
            const res = await fetch('/api/agent/turn', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                userMessage: `生图卡片【${freshCard.id}】提示词为“${freshCard.prompt}”，画面已渲染完成。请以你的专属助手口吻，用一两句话向用户汇报出图效果。`,
                history: [],
                events: standaloneTask.events,
                observations: [],
                project: { id: currentProject.id, name: currentProject.name },
                task: standaloneTask,
                images: imgBase64 ? [imgBase64] : undefined,
                cardContext: taskCardContext,
                modelType: agentModel,
                requireTool: false,
              })
            });
            if (res.ok) {
              const body = await res.json().catch(() => ({}));
              const result = body as AgentTurnResult;
              reviewText = result.speak || result.fullAnswer || result.response || '';
              updateAgentRuntimeTrace(standaloneTask, trace => ({
                ...trace,
                task: { ...standaloneTask, status: 'completed' },
                turns: trace.turns.map(turn => turn.id === turnId ? {
                  ...turn,
                  completedAt: Date.now(),
                  transport: result.debug,
                  parsedResult: result,
                } : turn),
              }));
            }
          } catch (e) {
            console.warn('[App] Standalone inspect turn call failed:', e);
          }
        }

        // 7. 模型生成完成到达瞬间：切换气泡文字为评语
        if (reviewText) {
          const parsed = parseAgentCommunication(reviewText);
          const speech = parsed.shortText || parsed.fullText;
          // 🛡️ 保持质检专注状态：在向用户汇报评语与留白阅读期间，继续无缝维持端详漫游动效！
          agentFocusManager.setCursorMode('inspect');
          agentFocusManager.setPrimaryFocus(freshCard.id, 'inspect', 'card.inspect.qc');
          setAgentState(prev => ({
            ...prev,
            speak: speech,
            visible: true,
            isActive: true,
          }));

          const reviewId = `review_${Date.now()}`;
          setCards(prevCards => prevCards.map(c => {
            if (c.id !== freshCard.id) return c;
            const cleanHistory = (c.chatHistory || []).filter(m => !m.text.includes('我先看下'));
            return {
              ...c,
              chatHistory: [
                ...cleanHistory,
                {
                  id: reviewId,
                  role: 'assistant' as const,
                  text: parsed.fullText,
                  shortText: parsed.shortText,
                  timestamp: Date.now(),
                }
              ]
            };
          }));

          // 同步记入运行时任务事件日志
          if (runtimeRef.current && taskId && runtimeRef.current.getTask(taskId)) {
            const runtimeTask = runtimeRef.current.getTask(taskId);
            if (runtimeTask) {
              runtimeTask.events.push({
                id: reviewId,
                turnId: `${taskId}:qc`,
                type: 'answer',
                text: reviewText,
                createdAt: Date.now(),
              });
            }
          }

          // 舒适留白：让用户完整阅读该卡片评语后，再移步下一张卡片
          const readingDwellMs = Math.min(6000, Math.max(3000, speech.length * 150));
          await sleep(readingDwellMs);
        }

        // 8. 完整结束本张卡片的端详
        agentFocusManager.removeFocus(freshCard.id);

        // 9. 若队列中还有待查看卡片，稍作平滑交接后开启下一张卡片的完整生命周期
        if (inspectQueueRef.current.length > 0) {
          await sleep(350);
        } else {
          agentFocusManager.setCursorMode('default');
        }
      }
    } finally {
      isProcessingInspectQueueRef.current = false;
      if (inspectQueueRef.current.length === 0) {
        agentFocusManager.setCursorMode('default');
      }
    }
  }, [centerCardOnScreen, currentProject]);
  processInspectQueueRef.current = processInspectQueue;

  const detectAndSaveCardLandmarks = useCallback(async (
    targetCard: CardData,
    mediaUrl?: string,
    customPrompt?: string,
    force: boolean = false
  ) => {
    if (!force && targetCard.landmarks) {
      const detectedParts = Object.keys(targetCard.landmarks.regions || {});
      const pointsCount = Array.isArray(targetCard.landmarks.interestPoints) ? targetCard.landmarks.interestPoints.length : 0;
      return {
        success: true,
        alreadyHadLandmarks: true,
        cardId: targetCard.id,
        landmarks: targetCard.landmarks,
        summary: targetCard.landmarks.summary || '已有主体标注产物',
        interestPointsCount: pointsCount,
        detectedParts,
        regions: targetCard.landmarks.regions,
        message: `卡片【${targetCard.name || targetCard.id}】已有主体与部位标注（共 ${pointsCount} 个关键点，覆盖: ${detectedParts.join('、') || '全身'}），无需重复计算。如需重新分析，请指定 force: true。`
      };
    }

    try {
      let effectiveUrl = mediaUrl || targetCard.imageUrl || (targetCard as any).url || (targetCard as any).originalUrl || '';
      const b64 = await extractCardImageBase64Ref.current(targetCard);
      if (b64) {
        effectiveUrl = b64;
      }

      if (!effectiveUrl) {
        throw new Error(`卡片【${targetCard.name || targetCard.id}】暂无可用图像内容（可能未出图或正在生成中）`);
      }

      // 直接全图传参（不使用切片机制，全画幅原生识别）
      const nodeModels = assetExtractionService.getNodeModels();
      const modelToUse = nodeModels.subjectLandmarksModel || 'deepseek-v4-flash';
      const deepseekKey = localStorage.getItem('deepseek_api_key') || '';
      const qwenKey = localStorage.getItem('qwen_api_key') || localStorage.getItem('glm_api_key') || '';
      const arkKey = localStorage.getItem('ark_api_key') || localStorage.getItem('volcengine_api_key') || '';
      const isArk = modelToUse.includes('doubao') || modelToUse.includes('seed-2-1') || modelToUse.includes('seed-2.1') || modelToUse.includes('ark') || modelToUse.includes('volces');
      const isDashscope = modelToUse.includes('qwen') || modelToUse.includes('GLM') || modelToUse.includes('ZHIPU');
      const apiKeyToSend = isArk ? (arkKey || deepseekKey || qwenKey) : isDashscope ? (qwenKey || deepseekKey) : (deepseekKey || qwenKey);

      const res = await fetch('/api/agent/detect-landmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageUrl: effectiveUrl,
          prompt: customPrompt || targetCard.prompt || targetCard.lastGeneratedPrompt || '',
          model: modelToUse,
          apiKey: apiKeyToSend || undefined,
        })
      });

      if (res.ok) {
        const data = await res.json();
        if (data && data.regions) {
          const restoredLandmarks = unpadLandmarks(data, null);

          setCards(prev => prev.map(c => {
            if (c.id !== targetCard.id) return c;
            return {
              ...c,
              landmarks: restoredLandmarks
            };
          }), false);

          const detectedParts = Object.keys(restoredLandmarks.regions || {});
          const pointsCount = Array.isArray(restoredLandmarks.interestPoints) ? restoredLandmarks.interestPoints.length : 0;

          return {
            success: true,
            cardId: targetCard.id,
            summary: restoredLandmarks.summary || '识别完成',
            interestPointsCount: pointsCount,
            detectedParts,
            regions: restoredLandmarks.regions,
            message: `成功完成卡片【${targetCard.name || targetCard.id}】的主体识别与部位标注（共提取 ${pointsCount} 个关键解剖兴趣点，覆盖部位: ${detectedParts.join('、') || '全身'}）。`
          };
        }
      }
      throw new Error(`主体识别节点未返回有效的部位标注数据`);
    } catch (err) {
      console.warn('[LandmarksNode] Auto-detection error:', err);
      throw err;
    }
  }, []);

  const enqueueCardInspection = useCallback((targetCard: CardData, mediaUrl: string) => {
    if (!mediaUrl) return;

    // 🌟 自动调用图像主体定位模型节点：识别并持久化记录人物头部、胸部、腿部及核心主体空间坐标
    void detectAndSaveCardLandmarks(targetCard, mediaUrl);

    // Deduplicate: avoid pushing the same card ID if already waiting in queue
    if (inspectQueueRef.current.some(item => item.targetCard.id === targetCard.id)) {
      return;
    }

    const activeTaskId = activeTaskIdRef.current || `qc_task_${Date.now().toString(36)}`;

    inspectQueueRef.current.push({
      targetCard,
      mediaUrl,
      taskId: activeTaskId,
    });

    // 🌟 统一排队控制：只有在 Agent 没有在忙碌创建卡片/下发工具时才立即消费队列；
    // 若 Agent 正在创建卡片，卡片安全入队挂起，等全部创建完成后自动触发消费！
    if (!isAgentRunningRef.current) {
      void processInspectQueue();
    }
  }, [detectAndSaveCardLandmarks, processInspectQueue]);

  const setCards = (updater: CardData[] | ((prev: CardData[]) => CardData[]), pushToHistory = true) => {
    setHistory(curr => {
      const nextPresent = typeof updater === 'function' ? updater(curr.present) : updater;
      if (pushToHistory) {
        const newPast = [...curr.past, curr.present].slice(-50); // limit history length to 50
        return { past: newPast, present: nextPresent, future: [] };
      } else {
        return { ...curr, present: nextPresent };
      }
    });
  };

  useEffect(() => {
    if (isLoading || loadedProjectIdRef.current !== currentProjectId) return;
    for (const card of cards) {
      if (!card.mcpTaskId || (card.state !== 'generating' && !(card.state === 'draft' && !card.imageUrl && !card.generationError))) continue;
      const recoveryKey = `${currentProjectId}:${card.id}:${card.mcpTaskId}`;
      if (recoveringTaskIdsRef.current.has(recoveryKey)) continue;
      recoveringTaskIdsRef.current.add(recoveryKey);

      void (async () => {
        try {
          const activeMcp = await getActiveMcpKey();
          if (!activeMcp?.token) {
            recoveringTaskIdsRef.current.delete(recoveryKey);
            return;
          }

          let pollCount = 0;
          const maxPolls = 150; // up to 7.5 minutes

          while (pollCount < maxPolls) {
            pollCount++;
            if (loadedProjectIdRef.current !== currentProjectId) break;

            const response = await fetch('/api/mcp/workrally/task', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                token: activeMcp.token,
                serverUrl: activeMcp.serverUrl,
                taskId: card.mcpTaskId,
                isVideo: !!card.isVideo,
              }),
            });
            const parsed = await safeParseJsonResponse(response);
            if (!parsed.success || !response.ok) {
              const pollInterval = pollCount <= 15 ? 800 : pollCount <= 30 ? 1500 : 3000;
              await sleep(pollInterval);
              continue;
            }

            const result = parsed.data;
            if (result.completed && result.mediaUrl) {
              let thumb: string | undefined;
              if (card.isVideo) {
                try {
                  thumb = await generateVideoThumbnail(result.mediaUrl, MAX_THUMBNAIL_EDGE);
                  if (thumb) {
                    thumbCache.set(card.id, thumb);
                    thumbCache.set(result.mediaUrl, thumb);
                  }
                } catch (e) {
                  console.warn('[App] Auto video thumb generation in task recovery info:', e);
                }
              }
              if (loadedProjectIdRef.current !== currentProjectId) break;

              setCards(prev => prev.map(current =>
                current.id === card.id && current.mcpTaskId === card.mcpTaskId
                  ? {
                      ...current,
                      imageUrl: result.mediaUrl,
                      isVideo: result.isVideo !== undefined ? result.isVideo : current.isVideo,
                      ...(thumb ? { thumbnailUrl: thumb } : {}),
                      state: 'completed',
                      generationError: undefined,
                    }
                  : current
              ), false);

              const updatedCard: CardData = {
                ...card,
                imageUrl: result.mediaUrl,
                state: 'completed',
              };
              enqueueCardInspection(updatedCard, result.mediaUrl);
              break;
            }

            if (result.failed) {
              if (loadedProjectIdRef.current !== currentProjectId) break;
              setCards(prev => prev.map(current =>
                current.id === card.id && current.mcpTaskId === card.mcpTaskId
                  ? { ...current, state: 'draft', generationError: result.error || '生成失败，请稍后重试' }
                  : current
              ), false);
              break;
            }

            if (result.pending) {
              // 🚀 Optimization 3: Adaptive high-frequency polling (800ms initial window)
              const pollInterval = pollCount <= 15 ? 800 : pollCount <= 30 ? 1500 : 3000;
              await sleep(pollInterval);
              continue;
            }

            if (result.mediaUrl) {
              let thumb: string | undefined;
              if (card.isVideo) {
                try {
                  thumb = await generateVideoThumbnail(result.mediaUrl, MAX_THUMBNAIL_EDGE);
                  if (thumb) {
                    thumbCache.set(card.id, thumb);
                    thumbCache.set(result.mediaUrl, thumb);
                  }
                } catch (e) {}
              }
              if (loadedProjectIdRef.current !== currentProjectId) break;
              setCards(prev => prev.map(current =>
                current.id === card.id && current.mcpTaskId === card.mcpTaskId
                  ? {
                      ...current,
                      imageUrl: result.mediaUrl,
                      isVideo: result.isVideo !== undefined ? result.isVideo : current.isVideo,
                      ...(thumb ? { thumbnailUrl: thumb } : {}),
                      state: 'completed',
                      generationError: undefined,
                    }
                  : current
              ), false);

              const updatedCard: CardData = {
                ...card,
                imageUrl: result.mediaUrl,
                state: 'completed',
              };
              enqueueCardInspection(updatedCard, result.mediaUrl);
              break;
            }

            const pollInterval = pollCount <= 15 ? 800 : pollCount <= 30 ? 1500 : 3000;
            await sleep(pollInterval);
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          console.warn('[App] WorkRally task recovery notice:', errMsg);
        } finally {
          recoveringTaskIdsRef.current.delete(recoveryKey);
        }
      })();
    }
  }, [cards, currentProjectId, isLoading]);


  // --- Local File Drag and Drop Support ---
  const [isDragOver, setIsDragOver] = useState(false);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Simple validation to ensure drag is actually leaving the container
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      if (
        e.clientX < rect.left ||
        e.clientX >= rect.right ||
        e.clientY < rect.top ||
        e.clientY >= rect.bottom
      ) {
        setIsDragOver(false);
      }
    } else {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    if (!e.dataTransfer || !e.dataTransfer.files) return;
    const files = Array.from(e.dataTransfer.files) as File[];
    if (files.length === 0) return;

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    // Calculate canvas drop coordinates
    const dropClientX = e.clientX;
    const dropClientY = e.clientY;
    const dropCanvasX = (dropClientX - tx.get()) / tScale.get();
    const dropCanvasY = (dropClientY - ty.get()) / tScale.get();

    // Step 1: Ultra-fast header parsing (<1ms per image) to get true aspect ratio immediately
    const cardInitPromises = files.map(async (file, index) => {
      const isImage = file.type.startsWith('image/');
      const isVideo = file.type.startsWith('video/');
      if (!isImage && !isVideo) return null;

      const fileUrl = URL.createObjectURL(file);
      let width = 0;
      let height = 0;

      try {
        if (isImage) {
          const dims = await fastGetImageDimensions(file);
          width = dims.width;
          height = dims.height;
        } else if (isVideo) {
          const dims = await getVideoDimensions(fileUrl);
          width = dims.width;
          height = dims.height;
        }
      } catch (err) {
        console.warn('Fast dimensions parsing failed, fallback:', err);
      }

      // Preserve natural aspect ratio and scale to standard visual area
      const ratio = getClosestAspectRatio(width, height);
      let customWidth: number | undefined;
      let customHeight: number | undefined;
      if (width > 0 && height > 0) {
        const TARGET_AREA = 230400; // 480x480 standard equivalent
        const scaleFactor = Math.sqrt(TARGET_AREA / (width * height));
        customWidth = Math.round(width * scaleFactor);
        customHeight = Math.round(height * scaleFactor);
      }

      const dim = customWidth && customHeight ? { width: customWidth, height: customHeight } : CARD_DIMENSIONS[ratio];
      const newId = Math.random().toString(36).substring(2, 11);
      const offset = index * 40;

      // Card is created immediately at the exact aspect ratio with the image visible!
      const initialCard: CardData = {
        id: newId,
        x: dropCanvasX - dim.width / 2 + offset,
        y: dropCanvasY - dim.height / 2 + offset,
        state: 'generating', // shows the sleek loading spinner overlay on top of the image
        ratio: ratio,
        res: '2K',
        prompt: `Dropped local ${isVideo ? 'video' : 'image'}: ${file.name}`,
        imageUrl: fileUrl, // Visible on the canvas instantly!
        isVideo: isVideo,
        customWidth: customWidth,
        customHeight: customHeight,
        fileName: file.name,
        nativeWidth: width,
        nativeHeight: height,
      };

      return {
        card: initialCard,
        file,
        fileUrl,
        isImage,
        isVideo,
        width,
        height,
      };
    });

    const parsedItems = (await Promise.all(cardInitPromises)).filter(Boolean);
    if (parsedItems.length === 0) return;

    // Immediately place all cards on canvas with their true aspect ratio and visible image!
    const initialCards = parsedItems.map(item => item!.card);
    setCards(prev => [...prev, ...initialCards]);
    setSelectedCardIds(initialCards.map(c => c.id));

    // Step 2: Background processing (non-blocking) - compress preview, check texture limits, generate thumbnails
    parsedItems.forEach(async (item) => {
      if (!item) return;
      const { file, fileUrl, isImage, isVideo, width, height, card } = item;

      let processedFile: Blob = file;
      let originalFileData: Blob | undefined = undefined;
      let trueOriginalFileData: Blob | undefined = undefined;
      let originalImageUrl: string | undefined = undefined;
      let trueOriginalImageUrl: string | undefined = undefined;

      if (isImage) {
        try {
          // Generate 1200px preview for optimal performance when zoomed
          processedFile = await compressAndResizeImage(file, 1200);

          // Check if original is > 4K (4096px) (GPU texture limit safety & LOD optimization)
          const MAX_TEXTURE_DIM = 4096;
          if (width > MAX_TEXTURE_DIM || height > MAX_TEXTURE_DIM) {
            trueOriginalFileData = file;
            trueOriginalImageUrl = fileUrl;

            // Create a safe 4K proxy for the "original" view in the UI to prevent GPU crashes and optimize VRAM
            originalFileData = await compressAndResizeImage(file, MAX_TEXTURE_DIM, 0.9);
            originalImageUrl = URL.createObjectURL(originalFileData);
          } else {
            // Under 4K, original file is proxy itself
            originalFileData = file;
            originalImageUrl = fileUrl;
          }
        } catch (err) {
          console.error("Failed to process image in background", err);
          processedFile = await compressAndResizeImage(file, 1200);
          originalFileData = file;
          originalImageUrl = fileUrl;
        }
      }

      const processedFileUrl = URL.createObjectURL(processedFile);

      let thumbnailUrl: string | undefined;
      let microLodThumbnailUrl: string | undefined;
      let fullDetailThumbnailUrl: string | undefined;
      let closeupThumbnailUrl: string | undefined;
      try {
        if (isVideo) {
          closeupThumbnailUrl = await generateVideoThumbnail(processedFile, 256);
          thumbnailUrl = closeupThumbnailUrl;
          microLodThumbnailUrl = await generateVideoThumbnail(processedFile, 64);
          fullDetailThumbnailUrl = await generateVideoThumbnail(processedFile, 128);
        } else {
          closeupThumbnailUrl = await generateImageThumbnail(processedFile, 256);
          thumbnailUrl = closeupThumbnailUrl;
          microLodThumbnailUrl = await generateImageThumbnail(processedFile, 64);
          fullDetailThumbnailUrl = await generateImageThumbnail(processedFile, 128);
        }
      } catch (thumbErr) {
        console.warn('Could not pre-generate thumbnail on drop:', thumbErr);
      }

      // Step 3: Seamlessly complete import - spinner fades away, optimized preview & thumbnail saved
      setCards(prev => prev.map(c => c.id === card.id ? {
        ...c,
        state: 'completed',
        imageUrl: processedFileUrl,
        fileData: processedFile,
        originalFileData: originalFileData,
        trueOriginalFileData: trueOriginalFileData,
        originalImageUrl: originalImageUrl,
        trueOriginalImageUrl: trueOriginalImageUrl,
        thumbnailUrl: thumbnailUrl,
        microLodThumbnailUrl: microLodThumbnailUrl,
        fullDetailThumbnailUrl: fullDetailThumbnailUrl,
        closeupThumbnailUrl: closeupThumbnailUrl,
      } : c));
    });
  }, [tx, ty, tScale]);


  // --- Canvas Transform Project Sync ---
  // Load canvas transform per project
  useEffect(() => {
    if (currentProjectId) {
      const saved = localStorage.getItem(`canvas_transform_${currentProjectId}`);
      let x = 0, y = 0, scale = 1;
      let hasSaved = false;
      
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          x = parsed.x; y = parsed.y; scale = parsed.scale;
          hasSaved = true;
        } catch (e) {}
      } else if (currentProjectId === DEFAULT_PROJECT.id) {
        // Fallback to legacy global key for the default project
        const legacy = localStorage.getItem('canvas_transform');
        if (legacy) {
          try {
            const parsed = JSON.parse(legacy);
            x = parsed.x; y = parsed.y; scale = parsed.scale;
            hasSaved = true;
          } catch (e) {}
        }
      }

      if (hasSaved) {
        tx.set(x);
        ty.set(y);
        tScale.set(scale);
        targetTransform.current = { x, y, scale };
      } else {
        // Center default positions if no save
        tx.set(0); ty.set(0); tScale.set(1);
        targetTransform.current = { x: 0, y: 0, scale: 1 };
      }
    }
  }, [currentProjectId, tx, ty, tScale]);

  // Project-specific debounced persistence for transform
  useEffect(() => {
    let timeout: NodeJS.Timeout;
    const saveTransform = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        if (currentProjectId) {
            const data = JSON.stringify({ x: tx.get(), y: ty.get(), scale: tScale.get() });
            localStorage.setItem(`canvas_transform_${currentProjectId}`, data);
        }
      }, 300);
    };
    const unsubX = tx.on('change', saveTransform);
    const unsubY = ty.on('change', saveTransform);
    const unsubS = tScale.on('change', saveTransform);
    return () => { unsubX(); unsubY(); unsubS(); clearTimeout(timeout); };
  }, [tx, ty, tScale, currentProjectId]);
  // -------------------------------------

  const handleSelectProject = (projectId: string) => {
    if (projectId === currentProjectId) return;
    // Save current cards first before switching
    if (loadedProjectIdRef.current === currentProjectId && !isLoading) {
      saveCards(cardsRef.current, currentProjectId).catch(console.error);
    }
    loadedProjectIdRef.current = null;
    setIsLoading(true);
    setCurrentProjectId(projectId);
  };

  const handleCreateProject = async (name: string) => {
    // Save current project's cards first
    if (loadedProjectIdRef.current === currentProjectId && !isLoading) {
      await saveCards(cardsRef.current, currentProjectId).catch(console.error);
    }
    loadedProjectIdRef.current = null;
    setIsLoading(true);

    const newId = `proj_${Date.now()}`;
    const newProj: ScriptProject = {
      ...DEFAULT_PROJECT,
      id: newId,
      name,
      logline: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      characters: [],
      locations: [],
      props: [],
      scriptText: ''
    };

    // Create a pristine initial card for the new project
    const initialNewCards: CardData[] = [{
      id: `card_${Date.now()}_1`,
      x: 360,
      y: 120,
      state: 'draft',
      ratio: '3:4',
      res: '2K',
      prompt: '',
      imageUrl: null
    }];
    await saveCards(initialNewCards, newId).catch(console.error);

    setProjects(prev => [newProj, ...prev]);
    setCurrentProjectId(newId);
  };

  const handleDeleteProject = async (projectId: string) => {
    if (projects.length <= 1) return;
    await deleteCardsForProject(projectId).catch(console.error);
    setProjects(prev => {
      const remaining = prev.filter(p => p.id !== projectId);
      if (currentProjectId === projectId) {
        loadedProjectIdRef.current = null;
        setIsLoading(true);
        setCurrentProjectId(remaining[0].id);
      }
      return remaining;
    });
  };

  // Load cards from IndexedDB whenever currentProjectId changes
  useEffect(() => {
    let mounted = true;
    const fetchProjectCards = async () => {
      setIsLoading(true);
      await requestPersistence();
      
      // Artificial delay to allow the Gaussian blur mask to fade in smoothly
      // and hide the jump cut, especially on smaller projects.
      await sleep(250);

      try {
        const saved = await loadCards(currentProjectId);
        if (!mounted) return;
        
        if (saved && saved.length > 0) {
          const processedSaved = saved.map(card => {
            const updates: any = {};
            if (card.generationError) {
              const start = card.generationError.indexOf('{');
              const end = card.generationError.indexOf('}', start + 1);
              if (start >= 0 && end > start) {
                try {
                  const taskError = JSON.parse(card.generationError.slice(start, end + 1));
                  if (typeof taskError.error_message === 'string') updates.generationError = taskError.error_message;
                } catch { /* Keep the original error when it is not JSON. */ }
              }
            }
            if (card.fileData && (card.fileData as any) instanceof Blob) {
              const url = safeCreateObjectURL(card.fileData);
              if (url) updates.imageUrl = url;
            } else if (card.fileData) {
              updates.fileData = undefined;
            }

            if (card.originalFileData && (card.originalFileData as any) instanceof Blob) {
              const url = safeCreateObjectURL(card.originalFileData);
              if (url) updates.originalImageUrl = url;
            } else if (card.originalFileData) {
              updates.originalFileData = undefined;
            }

            if (card.trueOriginalFileData && (card.trueOriginalFileData as any) instanceof Blob) {
              const url = safeCreateObjectURL(card.trueOriginalFileData);
              if (url) updates.trueOriginalImageUrl = url;
            } else if (card.trueOriginalFileData) {
              updates.trueOriginalFileData = undefined;
            }

            // Restore local reference image Blob URLs to prevent broken image references on reload
            if (card.referenceImages && Array.isArray(card.referenceImages)) {
              updates.referenceImages = card.referenceImages.map(ref => {
                if (ref.fileData && (ref.fileData as any) instanceof Blob) {
                  const blobUrl = safeCreateObjectURL(ref.fileData);
                  return {
                    ...ref,
                    url: blobUrl || ref.url
                  };
                } else if (ref.fileData) {
                  return {
                    ...ref,
                    fileData: undefined
                  };
                }
                return ref;
              });
              if (updates.referenceImages[0]?.url) {
                updates.referenceImageUrl = updates.referenceImages[0].url;
              }
            } else if (card.referenceImageFileData && (card.referenceImageFileData as any) instanceof Blob) {
              const url = safeCreateObjectURL(card.referenceImageFileData);
              if (url) updates.referenceImageUrl = url;
            } else if (card.referenceImageFileData) {
              updates.referenceImageFileData = undefined;
            }
            const savedPos = (() => {
              try {
                const pos = localStorage.getItem(`mira_vid_pos_${card.id}`);
                if (pos) {
                  const val = parseFloat(pos);
                  if (!isNaN(val) && val > 0) return val;
                }
              } catch {}
              return card.currentTime;
            })();
            if (typeof savedPos === 'number') updates.currentTime = savedPos;
            return {
              ...card,
              ...updates
            };
          });
          setHistory({ past: [], present: processedSaved, future: [] });
          loadedProjectIdRef.current = currentProjectId;

          // Asynchronously pre-generate 64px thumbnails for historical cards missing them
          setTimeout(() => {
            if (!mounted) return;
            processedSaved.forEach(async (card) => {
              if (!card.thumbnailUrl && (card.fileData || card.imageUrl || card.originalImageUrl)) {
                const thumb = await getOrCreateMediaThumbnail(card);
                if (thumb && mounted) {
                  setCards(prev => prev.map(c => c.id === card.id ? { ...c, thumbnailUrl: thumb } : c), false);
                }
              }
            });
          }, 300);
        } else {
          // If this is the default project, check if legacy un-scoped cards exist first
          let fallbackCards: CardData[] | null = null;
          if (currentProjectId === DEFAULT_PROJECT.id) {
            fallbackCards = await loadCards(); // legacy un-scoped key
          }
          if (fallbackCards && fallbackCards.length > 0) {
            const processedFallback = fallbackCards.map(card => {
              const updates: any = {};
              if (card.fileData && (card.fileData as any) instanceof Blob) {
                const url = safeCreateObjectURL(card.fileData);
                if (url) updates.imageUrl = url;
              } else if (card.fileData) {
                updates.fileData = undefined;
              }

              if (card.originalFileData && (card.originalFileData as any) instanceof Blob) {
                const url = safeCreateObjectURL(card.originalFileData);
                if (url) updates.originalImageUrl = url;
              } else if (card.originalFileData) {
                updates.originalFileData = undefined;
              }

              if (card.trueOriginalFileData && (card.trueOriginalFileData as any) instanceof Blob) {
                const url = safeCreateObjectURL(card.trueOriginalFileData);
                if (url) updates.trueOriginalImageUrl = url;
              } else if (card.trueOriginalFileData) {
                updates.trueOriginalFileData = undefined;
              }

              // Restore local reference image Blob URLs to prevent broken image references on reload for legacy scoped cards
              if (card.referenceImages && Array.isArray(card.referenceImages)) {
                updates.referenceImages = card.referenceImages.map(ref => {
                  if (ref.fileData && (ref.fileData as any) instanceof Blob) {
                    const blobUrl = safeCreateObjectURL(ref.fileData);
                    return {
                      ...ref,
                      url: blobUrl || ref.url
                    };
                  } else if (ref.fileData) {
                    return {
                      ...ref,
                      fileData: undefined
                    };
                  }
                  return ref;
                });
                if (updates.referenceImages[0]?.url) {
                  updates.referenceImageUrl = updates.referenceImages[0].url;
                }
              } else if (card.referenceImageFileData && (card.referenceImageFileData as any) instanceof Blob) {
                const url = safeCreateObjectURL(card.referenceImageFileData);
                if (url) updates.referenceImageUrl = url;
              } else if (card.referenceImageFileData) {
                updates.referenceImageFileData = undefined;
              }
              const savedPos = (() => {
                try {
                  const pos = localStorage.getItem(`mira_vid_pos_${card.id}`);
                  if (pos) {
                    const val = parseFloat(pos);
                    if (!isNaN(val) && val > 0) return val;
                  }
                } catch {}
                return card.currentTime;
              })();
              if (typeof savedPos === 'number') updates.currentTime = savedPos;

              if (!card.baselineConfig && (card.imageUrl || card.originalImageUrl || card.fileData)) {
                updates.baselineConfig = {
                  prompt: card.lastGeneratedPrompt || card.prompt || '',
                  ratio: card.ratio || '16:9',
                  res: card.res || '2K',
                  mcpModel: card.mcpModel,
                  mcpToolName: card.mcpToolName,
                  mcpParameters: card.mcpParameters,
                  referenceImages: updates.referenceImages || card.referenceImages,
                  referenceImageUrl: updates.referenceImageUrl || card.referenceImageUrl,
                  referenceImageName: card.referenceImageName,
                  referenceImageFileData: card.referenceImageFileData,
                };
              }

              return {
                ...card,
                ...updates
              };
            });
            setHistory({ past: [], present: processedFallback, future: [] });
            await saveCards(processedFallback, currentProjectId).catch(console.error);
          } else {
            const initialCards: CardData[] = [{
              id: `card_${Date.now()}_1`,
              x: 360,
              y: 120,
              state: 'draft',
              ratio: '3:4',
              res: '2K',
              prompt: '',
              imageUrl: null
            }];
            setHistory({ past: [], present: initialCards, future: [] });
            await saveCards(initialCards, currentProjectId).catch(console.error);
          }
          loadedProjectIdRef.current = currentProjectId;
        }
      } catch (e) {
        console.error('Failed to load project cards from DB:', e);
      } finally {
        if (mounted) {
          setIsLoading(false);
          setSelectedCardIds([]);
        }
      }
    };
    fetchProjectCards();
    return () => { mounted = false; };
  }, [currentProjectId]);

  // Save cards to IndexedDB for current project ONLY when cards belong to current project (debounced & idle-scheduled)
  const saveCardsTimerRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (!isLoading && currentProjectId && loadedProjectIdRef.current === currentProjectId) {
      if (saveCardsTimerRef.current) {
        clearTimeout(saveCardsTimerRef.current);
      }
      saveCardsTimerRef.current = setTimeout(() => {
        const doSave = () => {
          if (isUserPointerDownRef.current || (window as any).isDraggingCard || isDraggingCanvasRef.current) {
            // Postpone save if user is actively interacting with the canvas/cards
            saveCardsTimerRef.current = setTimeout(doSave, 1500);
            return;
          }
          saveCards(cardsRef.current, currentProjectId).catch(console.error);
        };

        if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
          (window as any).requestIdleCallback(doSave, { timeout: 3000 });
        } else {
          doSave();
        }
      }, 1500);

      return () => {
        if (saveCardsTimerRef.current) {
          clearTimeout(saveCardsTimerRef.current);
        }
      };
    }
  }, [cards, isLoading, currentProjectId]);

  // Synchronous flush on page reload or close to prevent in-flight video playback state from being lost
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (currentProjectId && loadedProjectIdRef.current === currentProjectId && cardsRef.current.length > 0) {
        saveCards(cardsRef.current, currentProjectId).catch(() => {});
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [currentProjectId]);

  const handleUpdateCard = useCallback((id: string, updates: Partial<CardData>, isSignificant = false) => {
    if (typeof updates.currentTime === 'number' && updates.currentTime > 0) {
      try {
        localStorage.setItem(`mira_vid_pos_${id}`, updates.currentTime.toFixed(2));
      } catch {}
    }
    const isOnlyPrompt = Object.keys(updates).length === 1 && 'prompt' in updates;
    const shouldPush = isSignificant && !isOnlyPrompt;
    setCards(prev => prev.map(c => {
      if (c.id !== id) return c;
      // 🛡️ Automatic Queue Trigger: Detect whenever a card transitions to 'completed' with mediaUrl
      if (
        updates.state === 'completed' &&
        (updates.imageUrl || c.imageUrl) &&
        c.state === 'generating'
      ) {
        const finishedMedia = updates.imageUrl || c.imageUrl || '';
        const updatedCard = { ...c, ...updates };
        setTimeout(() => {
          enqueueCardInspection(updatedCard, finishedMedia);
        }, 60);
      }
      // If the card has completed media, ALWAYS preserve and establish baselineConfig before applying user modifications
      let baselineConfig = c.baselineConfig;
      if (!baselineConfig && (c.imageUrl || c.originalImageUrl || c.fileData) && !updates.baselineConfig) {
        baselineConfig = {
          prompt: c.lastGeneratedPrompt || c.prompt || '',
          ratio: c.ratio || '16:9',
          res: c.res || '2K',
          mcpModel: c.mcpModel,
          mcpToolName: c.mcpToolName,
          mcpParameters: c.mcpParameters ? { ...c.mcpParameters } : undefined,
          referenceImages: c.referenceImages ? c.referenceImages.map(r => ({ ...r })) : [],
          referenceImageUrl: c.referenceImageUrl,
          referenceImageName: c.referenceImageName,
          referenceImageFileData: c.referenceImageFileData,
        };
      }
      return {
        ...c,
        ...(baselineConfig ? { baselineConfig } : {}),
        ...updates
      };
    }), shouldPush);
  }, []);

  // Fork / Duplicate Card with intelligent collision avoidance and optional auto-generate
  const handleForkCard = useCallback(async (
    sourceCardId: string,
    customConfigOrPrompt?: string | Partial<CardData>,
    autoStart = false
  ) => {
    const sourceCard = cardsRef.current.find(c => c.id === sourceCardId);
    if (!sourceCard) return;

    const customConfig = typeof customConfigOrPrompt === 'string'
      ? { prompt: customConfigOrPrompt }
      : (customConfigOrPrompt || {});

    const newId = Math.random().toString(36).substring(2, 11);
    const sourceDim = getCardSize(sourceCard);

    // Calculate placement to the right of the source card (+32px margin)
    let newX = sourceCard.x + sourceDim.width + 32;
    let newY = sourceCard.y;

    // Intelligent collision avoidance (check if space is occupied by any existing card)
    const allCards = cardsRef.current;
    let attempts = 0;
    while (attempts < 10) {
      const collides = allCards.some(c => {
        return Math.abs(c.x - newX) < 80 && Math.abs(c.y - newY) < 80;
      });
      if (collides) {
        newX += sourceDim.width + 32;
        attempts++;
      } else {
        break;
      }
    }

    const effectivePrompt = (customConfig.prompt !== undefined ? customConfig.prompt : sourceCard.prompt) || '';
    const effectiveRatio = customConfig.ratio || sourceCard.ratio || '16:9';
    const effectiveRes = customConfig.res || sourceCard.res || '2K';
    const effectiveModel = customConfig.mcpModel || sourceCard.mcpModel || (sourceCard.isVideo ? WORKRALLY_VIDEO_MODELS[0].id : WORKRALLY_IMAGE_MODELS[0].id);
    const effectiveToolName = customConfig.mcpToolName || sourceCard.mcpToolName;
    const effectiveParameters = customConfig.mcpParameters !== undefined
      ? customConfig.mcpParameters
      : (sourceCard.mcpParameters ? { ...sourceCard.mcpParameters } : undefined);

    const rawRefList = customConfig.referenceImages !== undefined
      ? customConfig.referenceImages
      : (sourceCard.referenceImages || []);

    const effectiveReferenceImages = dedupeReferenceImages(rawRefList ? rawRefList.map(r => {
      let fileData = r.fileData instanceof Blob ? r.fileData : undefined;
      if (!fileData && r.sourceCardId) {
        const src = cardsRef.current.find(c => c.id === r.sourceCardId);
        const srcBlob = src?.trueOriginalFileData || src?.originalFileData || src?.fileData;
        if (srcBlob instanceof Blob) fileData = srcBlob;
      }
      return {
        ...r,
        fileData,
      };
    }) : []);

    const effectiveReferenceImageUrl = customConfig.referenceImageUrl !== undefined ? customConfig.referenceImageUrl : sourceCard.referenceImageUrl;
    const effectiveReferenceImageName = customConfig.referenceImageName !== undefined ? customConfig.referenceImageName : sourceCard.referenceImageName;
    const effectiveReferenceImageFileData = customConfig.referenceImageFileData instanceof Blob
      ? customConfig.referenceImageFileData
      : (sourceCard.referenceImageFileData instanceof Blob ? sourceCard.referenceImageFileData : undefined);

    const effectiveReferenceSourceIds = Array.from(new Set(
      effectiveReferenceImages.map(r => r.sourceCardId).filter(Boolean) as string[]
    ));

    const forkedCard: CardData = {
      id: newId,
      x: newX,
      y: newY,
      state: autoStart ? 'generating' : 'draft',
      ratio: effectiveRatio,
      res: effectiveRes,
      prompt: effectivePrompt,
      lastGeneratedPrompt: autoStart ? effectivePrompt : undefined,
      imageUrl: null,
      originalImageUrl: null,
      thumbnailUrl: undefined,
      fileData: undefined,
      isVideo: customConfig.isVideo !== undefined ? customConfig.isVideo : sourceCard.isVideo,
      derivedFromId: sourceCard.id,
      referenceSourceIds: effectiveReferenceSourceIds,
      referenceImages: effectiveReferenceImages,
      referenceImageUrl: effectiveReferenceImageUrl,
      referenceImageName: effectiveReferenceImageName,
      referenceImageFileData: effectiveReferenceImageFileData,
      mcpToolName: effectiveToolName,
      mcpModel: effectiveModel,
      mcpParameters: effectiveParameters,
    };

    // If custom config was passed for auto-forking from a completed media card, restore sourceCard's config in state to its baseline config
    if (customConfigOrPrompt !== undefined && (sourceCard.imageUrl || sourceCard.originalImageUrl || sourceCard.fileData)) {
      const baseline = sourceCard.baselineConfig || {
        prompt: sourceCard.lastGeneratedPrompt ?? sourceCard.prompt ?? '',
        ratio: sourceCard.ratio || '16:9',
        res: sourceCard.res || '2K',
        mcpModel: sourceCard.mcpModel,
        mcpToolName: sourceCard.mcpToolName,
        mcpParameters: sourceCard.mcpParameters ? { ...sourceCard.mcpParameters } : undefined,
        referenceImages: sourceCard.referenceImages ? sourceCard.referenceImages.map(r => ({ ...r })) : [],
        referenceImageUrl: sourceCard.referenceImageUrl,
        referenceImageName: sourceCard.referenceImageName,
        referenceImageFileData: sourceCard.referenceImageFileData,
      };

      setCards(prev => [
        ...prev.map(c => c.id === sourceCardId ? {
          ...c,
          prompt: baseline.prompt,
          lastGeneratedPrompt: baseline.prompt,
          ratio: baseline.ratio,
          res: baseline.res,
          mcpModel: baseline.mcpModel,
          mcpToolName: baseline.mcpToolName,
          mcpParameters: baseline.mcpParameters,
          referenceImages: baseline.referenceImages ? baseline.referenceImages.map(r => ({ ...r })) : [],
          referenceImageUrl: baseline.referenceImageUrl,
          referenceImageName: baseline.referenceImageName,
          referenceImageFileData: baseline.referenceImageFileData,
          baselineConfig: baseline,
        } : c),
        forkedCard
      ], true);
    } else {
      setCards(prev => [...prev, forkedCard], true);
    }
    // Synchronously register forkedCard in cardsRef.current so immediate agent animations can resolve its world coordinates
    cardsRef.current = [...cardsRef.current.filter(c => c.id !== forkedCard.id), forkedCard];
    setSelectedCardIds([newId]);

    // Center the newly forked card in the page viewport
    const forkedDim = getCardSize(forkedCard);
    centerCardOnScreen(newX, newY, forkedDim.width, forkedDim.height);

    // If autoStart is requested, trigger generation immediately on the new card
    if (autoStart && effectivePrompt.trim()) {
      try {
        const activeMcp = await getActiveMcpKey();
        const effectiveRefImages = forkedCard.referenceImages && forkedCard.referenceImages.length > 0
          ? forkedCard.referenceImages
          : forkedCard.referenceImageUrl
            ? [{ url: forkedCard.referenceImageUrl, name: forkedCard.referenceImageName, fileData: forkedCard.referenceImageFileData }]
            : [];

        if (activeMcp && activeMcp.token) {
          const refPayloads: string[] = [];
          for (const ref of effectiveRefImages) {
            const payload = await resolveReferenceToPayload(ref, cardsRef.current);
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
              prompt: effectivePrompt.trim(),
              ratio: forkedCard.ratio,
              res: forkedCard.res,
              isVideo: !!forkedCard.isVideo,
              referenceImages: refPayloads,
              toolName: forkedCard.mcpToolName || (forkedCard.isVideo ? WORKRALLY_VIDEO_TOOL : WORKRALLY_IMAGE_TOOL),
              model: forkedCard.mcpModel || effectiveModel,
              parameters: {
                ...(forkedCard.mcpParameters || {}),
                ...(forkedCard.isVideo ? {
                  duration: Number(forkedCard.mcpParameters?.duration || 5),
                } : {}),
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
            handleUpdateCard(newId, {
              mcpTaskId: result.taskIds[0],
              state: 'generating',
              generationError: undefined,
            }, true);
            return forkedCard;
          }
          if (resResult.ok && result.success && result.mediaUrl) {
            let thumb: string | undefined;
            if (forkedCard.isVideo) {
              try {
                thumb = await generateVideoThumbnail(result.mediaUrl, MAX_THUMBNAIL_EDGE);
                if (thumb) {
                  thumbCache.set(newId, thumb);
                  thumbCache.set(result.mediaUrl, thumb);
                }
              } catch (e) {
                console.warn('Auto video thumb generation in handleForkCard error:', e);
              }
            }
            handleUpdateCard(newId, { 
              imageUrl: result.mediaUrl,
              isVideo: result.isVideo ?? forkedCard.isVideo,
              ...(thumb ? { thumbnailUrl: thumb } : {}),
              state: 'completed',
              mcpTaskId: result.taskIds?.[0],
              generationError: undefined,
            }, true);
            return forkedCard;
          } else {
            const errMsg = result.error || '生成失败，请稍后重试';
            handleUpdateCard(newId, { state: 'draft', generationError: errMsg }, true);
            return forkedCard;
          }
        }

        // Fallback demo timeout
        setTimeout(() => {
          handleUpdateCard(newId, { 
            imageUrl: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=800&auto=format&fit=crop",
            state: 'completed'
          }, true);
        }, 2000);
      } catch (err: any) {
        console.error('Fork card generation error:', err);
        const userFacingError = err?.message?.includes('Failed to fetch')
          ? '网络请求失败，请检查网络连接或 MCP 服务配置'
          : (err?.message || '生成失败');
        handleUpdateCard(newId, { state: 'draft', generationError: userFacingError }, true);
      }
    }

    return forkedCard;
  }, [handleUpdateCard]);

  // Start Canvas Reference Picker Session
  const handleStartCanvasPicker = useCallback((targetCardId: string) => {
    const currentCamera = {
      x: tx.get(),
      y: ty.get(),
      scale: tScale.get()
    };
    
    // Find already existing references on the target card to pre-populate the picker
    const targetCard = cards.find(c => c.id === targetCardId);
    const existingRefs = targetCard?.referenceImages && targetCard.referenceImages.length > 0
      ? targetCard.referenceImages
      : targetCard?.referenceImageUrl
        ? [{ url: targetCard.referenceImageUrl, name: targetCard.referenceImageName, fileData: targetCard.referenceImageFileData }]
        : [];

    // Create a fast map of card image URLs to card IDs
    const canvasCardUrlMap = new Map<string, string>();
    cards.forEach(c => {
      if (c.imageUrl) canvasCardUrlMap.set(c.imageUrl, c.id);
      if (c.originalImageUrl) canvasCardUrlMap.set(c.originalImageUrl, c.id);
      if (c.thumbnailUrl) canvasCardUrlMap.set(c.thumbnailUrl, c.id);
    });

    // Backfill sourceCardId if missing but matches a canvas card URL
    const populatedRefs = existingRefs.map(ref => {
      if (ref.sourceCardId) return ref;
      const matchedId = canvasCardUrlMap.get(ref.url);
      if (matchedId) {
        return { ...ref, sourceCardId: matchedId };
      }
      return ref;
    });

    setPickerSession({
      targetCardId,
      selectedReferences: populatedRefs,
      initialCamera: currentCamera
    });
  }, [tx, ty, tScale, cards]);

  // Toggle a card selection in picker session
  const handleTogglePickerCard = useCallback((cardId: string) => {
    setPickerSession(prev => {
      if (!prev) return null;
      if (prev.targetCardId === cardId) return prev; // Cannot pick target itself
      
      const targetCardObj = cardsRef.current.find(c => c.id === cardId);
      if (!targetCardObj) return prev;

      const isSelected = prev.selectedReferences.some(ref => 
        ref.sourceCardId === cardId || 
        (ref.url && (
          ref.url === targetCardObj.imageUrl || 
          ref.url === targetCardObj.originalImageUrl || 
          ref.url === targetCardObj.thumbnailUrl
        ))
      );

      let nextRefs;
      if (isSelected) {
        // Remove from reference list
        nextRefs = prev.selectedReferences.filter(ref => 
          ref.sourceCardId !== cardId && 
          (!ref.url || (
            ref.url !== targetCardObj.imageUrl && 
            ref.url !== targetCardObj.originalImageUrl && 
            ref.url !== targetCardObj.thumbnailUrl
          ))
        );
      } else {
        // Add to reference list
        const thumbUrl = targetCardObj.thumbnailUrl || thumbCache.get(cardId) || (targetCardObj.imageUrl ? thumbCache.get(targetCardObj.imageUrl) : undefined);
        const newRef = {
          sourceCardId: cardId,
          url: targetCardObj.imageUrl || targetCardObj.originalImageUrl || targetCardObj.thumbnailUrl || '',
          thumbnailUrl: thumbUrl,
          microLodThumbnailUrl: targetCardObj.microLodThumbnailUrl,
          fullDetailThumbnailUrl: targetCardObj.fullDetailThumbnailUrl,
          closeupThumbnailUrl: targetCardObj.closeupThumbnailUrl,
          name: targetCardObj.fileName 
            ? targetCardObj.fileName.replace(/\.[^/.]+$/, "") 
            : (targetCardObj.prompt 
              ? (targetCardObj.prompt.length > 14 ? targetCardObj.prompt.slice(0, 14) + '...' : targetCardObj.prompt) 
              : '画布卡片'),
          fileData: targetCardObj.trueOriginalFileData || targetCardObj.originalFileData || targetCardObj.fileData
        };
        nextRefs = [...prev.selectedReferences, newRef];
      }

      return { ...prev, selectedReferences: nextRefs };
    });
  }, []);

  // Remove a picker reference by direct index from the tray
  const handleRemovePickerReference = useCallback((indexToRemove: number) => {
    setPickerSession(prev => {
      if (!prev) return null;
      const nextRefs = prev.selectedReferences.filter((_, idx) => idx !== indexToRemove);
      return { ...prev, selectedReferences: nextRefs };
    });
  }, []);

  const selectedCardIdsRef = useRef(selectedCardIds);
  useEffect(() => {
    selectedCardIdsRef.current = selectedCardIds;
  }, [selectedCardIds]);

  const lastVisibleSetUpdateTimeRef = useRef<number>(0);
  const cullingThrottleTimerRef = useRef<any>(null);

  const [paintEpoch, setPaintEpoch] = useState(0);
  useEffect(() => {
    const handleCardPainted = () => {
      setPaintEpoch(n => (n + 1) % 1000000);
    };
    window.addEventListener('card-painted', handleCardPainted);
    return () => window.removeEventListener('card-painted', handleCardPainted);
  }, []);

  // --- Viewport Spatial Culling with QuadTree (Virtualization) ---
  // Uses O(log N + K) QuadTree spatial index to rapidly query visible cards out of 25,000+ items in < 0.05ms.
  const [visibleCardIdSet, setVisibleCardIdSet] = useState<Set<string>>(() => new Set());
  const mountFrameCounterRef = useRef<number>(0);
  const quadTreeRef = useRef<QuadTree<CardData> | null>(null);

  // Synchronize QuadTree spatial index on cards change
  useEffect(() => {
    quadTreeRef.current = buildCardQuadTree(cards);
  }, [cards]);

  const updateCircularCulling = useCallback((_forceImmediate = false) => {
    if (typeof window === 'undefined') return;

    if (cullingThrottleTimerRef.current) {
      clearTimeout(cullingThrottleTimerRef.current);
      cullingThrottleTimerRef.current = null;
    }

    const currentScale = tScale.get() || 1;
    const currentTx = tx.get();
    const currentTy = ty.get();
    const vpWidth = window.innerWidth;
    const vpHeight = window.innerHeight;

    // Add scale-adaptive pre-load buffer zone
    const buffer = Math.max(40, Math.min(150, Math.round(150 * Math.sqrt(currentScale))));

    // World coordinates query bounding box
    const queryBounds: BoundingBox = {
      minX: (-currentTx - buffer) / currentScale,
      minY: (-currentTy - buffer) / currentScale,
      maxX: (vpWidth - currentTx + buffer) / currentScale,
      maxY: (vpHeight - currentTy + buffer) / currentScale,
    };

    const tree = quadTreeRef.current;
    const candidateCards = tree ? tree.query(queryBounds) : cardsRef.current;
    const selectedIds = selectedCardIdsRef.current;
    const nextSet = new Set<string>();

    for (let i = 0; i < selectedIds.length; i++) {
      nextSet.add(selectedIds[i]);
    }
    for (let i = 0; i < candidateCards.length; i++) {
      nextSet.add(candidateCards[i].id);
    }

    let didChange = false;
    setVisibleCardIdSet(prev => {
      if (prev.size === nextSet.size) {
        let identical = true;
        for (const id of nextSet) {
          if (!prev.has(id)) {
            identical = false;
            break;
          }
        }
        if (identical) return prev;
      }
      didChange = true;
      return nextSet;
    });

    if (didChange) {
      lastVisibleSetUpdateTimeRef.current = Date.now();
    }
  }, [tx, ty, tScale]);

  // Initial and window resize listeners
  useEffect(() => {
    updateCircularCulling(true);
    const handleResize = () => updateCircularCulling(true);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [updateCircularCulling]);

  // Immediate sync when cards collection or active selection changes
  useEffect(() => {
    updateCircularCulling(true);
  }, [cards, selectedCardIds, updateCircularCulling]);

  const [mountEpoch, setMountEpoch] = useState(0);

  // Programmatic tween zooming state (active during double-click zoom or overview mode transition)
  const [isTweenZooming, setIsTweenZooming] = useState(false);
  const isTweenZoomingRef = useRef(false);
  const tweenTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const triggerTweenZoom = useCallback((durationMs: number = 400) => {
    setIsTweenZooming(true);
    isTweenZoomingRef.current = true;
    if (tweenTimeoutRef.current) {
      clearTimeout(tweenTimeoutRef.current);
    }
    tweenTimeoutRef.current = setTimeout(() => {
      isTweenZoomingRef.current = false;
      setIsTweenZooming(false);
      updateCircularCulling(true);
      setMountEpoch(n => (n + 1) % 1000000);
    }, durationMs);
  }, [updateCircularCulling]);

  // Cancel picker session and fly back
  const handleCancelPickerSession = useCallback(() => {
    if (!pickerSession) return;
    const { initialCamera } = pickerSession;
    
    // Freeze rendering and layout updates during flight
    triggerTweenZoom(450);

    // Sync the virtual camera target position to prevent wheel jump
    targetTransform.current = {
      x: initialCamera.x,
      y: initialCamera.y,
      scale: initialCamera.scale
    };

    // Animate smoothly back to initial camera
    animate(tx, initialCamera.x, { duration: 0.4, ease: [0.16, 1, 0.3, 1] });
    animate(ty, initialCamera.y, { duration: 0.4, ease: [0.16, 1, 0.3, 1] });
    animate(tScale, initialCamera.scale, { duration: 0.4, ease: [0.16, 1, 0.3, 1] });
    setPickerSession(null);
  }, [pickerSession, tx, ty, tScale, triggerTweenZoom]);

  // Confirm picker session and apply reference images
  const handleConfirmPickerSession = useCallback(() => {
    if (!pickerSession) return;
    const { targetCardId, selectedReferences, initialCamera } = pickerSession;
    
    // Freeze rendering and layout updates during flight
    triggerTweenZoom(450);

    if (selectedReferences.length > 0) {
      const sourceIds = Array.from(new Set(
        selectedReferences.map(r => r.sourceCardId).filter(Boolean) as string[]
      ));
      handleUpdateCard(targetCardId, {
        referenceImages: selectedReferences,
        referenceSourceIds: sourceIds,
        referenceImageUrl: selectedReferences[0].url,
        referenceImageName: selectedReferences.length > 1 ? `参考图 (${selectedReferences.length})` : selectedReferences[0].name,
        referenceImageFileData: selectedReferences[0].fileData
      }, true);
    } else {
      handleUpdateCard(targetCardId, {
        referenceImages: [],
        referenceSourceIds: [],
        referenceImageUrl: null,
        referenceImageName: undefined,
        referenceImageFileData: undefined
      }, true);
    }

    // Cinematic fly back to target card position
    const targetCard = cardsRef.current.find(c => c.id === targetCardId);
    const finalX = targetCard ? -targetCard.x * initialCamera.scale + window.innerWidth / 2 - (CARD_DIMENSIONS[targetCard.ratio]?.width || 320) * initialCamera.scale / 2 : initialCamera.x;
    const finalY = targetCard ? -targetCard.y * initialCamera.scale + window.innerHeight / 2 - (CARD_DIMENSIONS[targetCard.ratio]?.height || 320) * initialCamera.scale / 2 : initialCamera.y;

    // Sync the virtual camera target position to prevent wheel jump
    targetTransform.current = {
      x: finalX,
      y: finalY,
      scale: initialCamera.scale
    };

    animate(tx, finalX, { duration: 0.45, ease: [0.16, 1, 0.3, 1] });
    animate(ty, finalY, { duration: 0.45, ease: [0.16, 1, 0.3, 1] });
    animate(tScale, initialCamera.scale, { duration: 0.45, ease: [0.16, 1, 0.3, 1] });

    setPickerSession(null);
  }, [pickerSession, handleUpdateCard, tx, ty, tScale, triggerTweenZoom]);

  // High-performance batched check (via rAF) during canvas panning/zooming
  useEffect(() => {
    let rafId: number | null = null;
    const scheduleCheck = () => {
      // Real-time culling updates throttled via rAF during manual user interaction (wheel, drag) & smooth zoom animations
      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          updateCircularCulling();
        });
      }
    };

    const unsubX = tx.on('change', scheduleCheck);
    const unsubY = ty.on('change', scheduleCheck);
    const unsubScale = tScale.on('change', scheduleCheck);

    return () => {
      unsubX();
      unsubY();
      unsubScale();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [tx, ty, tScale, updateCircularCulling]);

  // Micro-LOD state tracking (scale < dynamic threshold)
  const [isMicroLod, setIsMicroLod] = useState(() => tScale.get() < getNanoLodThreshold());
  // Nano-LOD state tracking (scale < dynamic threshold)
  const [isNanoLod, setIsNanoLod] = useState(() => tScale.get() < getNanoLodThreshold());
  // Extended Nano-LOD state to act as a backend backdrop during DOM card fade-in
  const [isNanoCanvasActive, setIsNanoCanvasActive] = useState(() => tScale.get() < getNanoLodThreshold());
  // Extended DOM card state to act as a frontend backdrop while Canvas prepares to render
  const [isDomCardsActive, setIsDomCardsActive] = useState(() => tScale.get() >= getNanoLodThreshold());

  const handleNanoCanvasReady = useCallback(() => {
    if (isNanoLod) {
      setIsDomCardsActive(false);
    }
  }, [isNanoLod]);

  useEffect(() => {
    if (isNanoLod) {
      setIsNanoCanvasActive(true);
      // isDomCardsActive will be disabled by the onReady callback from NanoLodCanvas once its first frame renders
    } else {
      setIsDomCardsActive(true);
      // Give DOM cards a brief window to mount and paint before destroying the backdrop Canvas
      const t = setTimeout(() => setIsNanoCanvasActive(false), 150);
      return () => clearTimeout(t);
    }
  }, [isNanoLod]);

  useEffect(() => {
    const unsub = tScale.on('change', (s) => {
      const threshold = getNanoLodThreshold();
      const isMicro = s < threshold;
      const isNano = s < threshold;
      
      setIsMicroLod(isMicro);
      setIsNanoLod(isNano);
    });
    return unsub;
  }, [tScale]);

  // Set of DOM-mounted card IDs (asynchronous frame-budgeted progressive mounting)
  const [renderedCardIds, setRenderedCardIds] = useState<Set<string>>(() => new Set());

  const handleCardDrag = useCallback((id: string, dx: number, dy: number) => {
    // No-op. Real-time dragging is now fully handled in DOM by GenerationCard.tsx (Master-Slave architecture).
    // This function is kept to avoid prop-type errors if needed, though we removed it from GenerationCard's active calls.
  }, []);

  const handleCardDragEnd = useCallback((id: string, totalDx: number, totalDy: number) => {
    if (Math.abs(totalDx) < 0.5 && Math.abs(totalDy) < 0.5) return;
    setCards(prev => {
      const selectedIds = selectedCardIdsRef.current;
      const isDraggingSelected = selectedIds.includes(id);
      
      return prev.map(c => {
        if (isDraggingSelected ? selectedIds.includes(c.id) : c.id === id) {
          return { ...c, x: c.x + totalDx, y: c.y + totalDy };
        }
        return c;
      });
    }, true);
  }, []);

  const handleCardSelect = useCallback((e: React.PointerEvent, id: string, selectOnlyOnPointerUp?: boolean) => {
    setContextMenus(prev => {
      const next = { ...prev };
      delete next['user'];
      return next;
    });
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      if (!selectOnlyOnPointerUp) {
        setSelectedCardIds(prev => prev.includes(id) ? prev.filter(cid => cid !== id) : [...prev, id]);
      }
    } else {
      if (selectOnlyOnPointerUp) {
        setSelectedCardIds([id]);
      } else {
        setSelectedCardIds(prev => {
          if (prev.includes(id)) {
            return prev;
          }
          return [id];
        });
      }
    }
  }, []);

  const handleCardSelectWrapped = useCallback((e: React.PointerEvent, id: string, selectOnlyOnPointerUp?: boolean) => {
    const session = pickerSessionRef.current;
    if (session) {
      if (id !== session.targetCardId) {
        e.stopPropagation();
        handleTogglePickerCard(id);
      }
    } else {
      handleCardSelect(e, id, selectOnlyOnPointerUp);
    }
  }, [handleCardSelect, handleTogglePickerCard]);

  const handleCardDelete = useCallback((id: string) => {
    setCards(prev => prev.filter(c => c.id !== id));
    setSelectedCardIds(prev => prev.filter(cid => cid !== id));
  }, []);

  // State for Context Menu
  const [contextMenus, setContextMenus] = useState<Record<string, { x: number, y: number, canvasX: number, canvasY: number, targetId?: string | null }>>({});

  // Undo / Redo logic
  const undo = () => {
    setHistory(curr => {
      if (curr.past.length === 0) return curr;
      const previous = curr.past[curr.past.length - 1];
      return {
        past: curr.past.slice(0, -1),
        present: previous,
        future: [curr.present, ...curr.future]
      };
    });
  };

  const redo = () => {
    setHistory(curr => {
      if (curr.future.length === 0) return curr;
      const next = curr.future[0];
      return {
        past: [...curr.past, curr.present],
        present: next,
        future: curr.future.slice(1)
      };
    });
  };

  // Global keydown for deletion and undo/redo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeTag = document.activeElement?.tagName;
      const isInputActive = activeTag === 'TEXTAREA' || activeTag === 'INPUT' || document.activeElement?.hasAttribute('contenteditable');
      const isSpaceKey = e.code === 'Space' || e.key === ' ' || e.keyCode === 32;

      if (isSpaceKey) {
        if (!isInputActive) {
          if (isSpacePressedRef.current || isOverviewModeRef.current) {
            e.preventDefault();
            return;
          }
          e.preventDefault();
          isSpacePressedRef.current = true;
          enterOverviewModeRef.current();
        } else {
          // If the user is currently composing text using an IME (e.g. Chinese input method),
          // pressing Space selects the text candidate, so we must let it proceed natively!
          const isComposing = e.isComposing || e.keyCode === 229;
          if (isComposing) {
            return;
          }

          // Scheme A (Improved): Prevent default character input immediately so no space is typed!
          e.preventDefault();

          if (!spaceLongPressTimerRef.current && !e.repeat) {
            const activeEl = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
            spaceLongPressTimerRef.current = setTimeout(() => {
              if (activeEl) {
                activeEl.blur(); // Release focus to unfetter keyboard events
              }

              isSpacePressedRef.current = true;
              enterOverviewModeRef.current(); // Enter Pan/Overview Mode
              spaceLongPressTimerRef.current = null;
            }, 250); // Natural 250ms hold threshold
          }
        }
      }

      if ((e.ctrlKey || e.metaKey) && !isInputActive) {
        if (e.code === 'KeyZ' || e.key.toLowerCase() === 'z') {
          e.preventDefault();
          if (e.shiftKey) {
            redo();
          } else {
            undo();
          }
          return;
        }
        if (e.code === 'KeyY' || e.key.toLowerCase() === 'y') {
          e.preventDefault();
          redo();
          return;
        }
        // Copy (Ctrl+C)
        if (e.code === 'KeyC' || e.key.toLowerCase() === 'c') {
          const currentSelection = selectedCardIdsRef.current;
          if (currentSelection.length > 0) {
            e.preventDefault();
            clipboardRef.current = cardsRef.current.filter(c => currentSelection.includes(c.id));
          }
          return;
        }
        // Paste (Ctrl+V)
        if (e.code === 'KeyV' || e.key.toLowerCase() === 'v') {
          if (clipboardRef.current.length > 0) {
            e.preventDefault();
            const newSelectedIds: string[] = [];
            const newCards = clipboardRef.current.map(c => {
              const newId = Math.random().toString(36).substring(2, 11);
              newSelectedIds.push(newId);
              return {
                ...c,
                id: newId,
                x: c.x + 200, // Offset for visibility
                y: c.y + 200,
                // Make sure to reset state to draft if we want, or keep it. We'll just keep it exactly as is, maybe without imageUrl?
                // For now, exact clone is fine.
              };
            });
            setCards(prev => [...prev, ...newCards], true);
            setSelectedCardIds(newSelectedIds);
          }
          return;
        }
      }

      if (e.code === 'Backspace' || e.code === 'Delete' || e.key === 'Backspace' || e.key === 'Delete') {
        if (isInputActive) return;
        const currentSelection = selectedCardIdsRef.current;
        if (currentSelection.length > 0) {
          setCards(prev => prev.filter(c => !currentSelection.includes(c.id)));
          setSelectedCardIds([]);
        }
      }
    };
    
    const handleKeyUp = (e: KeyboardEvent) => {
      const activeTag = document.activeElement?.tagName;
      const isInputActive = activeTag === 'TEXTAREA' || activeTag === 'INPUT' || document.activeElement?.hasAttribute('contenteditable');
      const isSpaceKey = e.code === 'Space' || e.key === ' ' || e.keyCode === 32;

      if (isSpaceKey) {
        // Stop and clean up long-press timer if space is released before timeout
        if (spaceLongPressTimerRef.current) {
          clearTimeout(spaceLongPressTimerRef.current);
          spaceLongPressTimerRef.current = null;

          // Since the timer was still active, this is a short press / normal typing!
          // We manually insert the space character at the cursor position.
          if (isInputActive) {
            const activeEl = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
            if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
              const val = activeEl.value;
              const start = activeEl.selectionStart ?? val.length;
              const end = activeEl.selectionEnd ?? val.length;

              activeEl.value = val.slice(0, start) + ' ' + val.slice(end);
              activeEl.setSelectionRange(start + 1, start + 1);

              // Dispatch native input event to synchronize with React state and save drafts
              const event = new Event('input', { bubbles: true });
              activeEl.dispatchEvent(event);
            }
          }
        }

        isSpacePressedRef.current = false;
        if (!isInputActive && (preOverviewTransform.current || isOverviewModeRef.current)) {
          exitOverviewToOriginalRef.current();
        }
      }
    };

    const handleBlur = () => {
      if (spaceLongPressTimerRef.current) {
        clearTimeout(spaceLongPressTimerRef.current);
        spaceLongPressTimerRef.current = null;
      }
      isSpacePressedRef.current = false;
      if (preOverviewTransform.current || isOverviewModeRef.current) {
        exitOverviewToOriginalRef.current();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []); // We use refs for state to avoid re-binding on every selection change

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;
    const canvasX = (cursorX - tx.get()) / tScale.get();
    const canvasY = (cursorY - ty.get()) / tScale.get();
    
    const cardElement = (e.target as Element).closest('[data-card-id]');
    let targetId = cardElement ? cardElement.getAttribute('data-card-id') : null;
    
    // Perform instant world-coordinate hit-testing to identify the target card if not found from DOM
    if (!targetId) {
      const allCards = cardsRef.current.length > 0 ? cardsRef.current : cards;
      for (let i = allCards.length - 1; i >= 0; i--) {
        const c = allCards[i];
        const dim = getCardSize(c);
        if (canvasX >= c.x && canvasX <= c.x + dim.width && canvasY >= c.y && canvasY <= c.y + dim.height) {
          targetId = c.id;
          break;
        }
      }
    }
    
    // Determine the target IDs for the Agent.
    // If the right-clicked card is part of the user's active multi-selection, 
    // we inherit the multi-selection, so all of them are targeted!
    let targetIds: string[] = [];
    if (targetId) {
      if (selectedCardIds.includes(targetId)) {
        targetIds = [...selectedCardIds];
      } else {
        targetIds = [targetId];
        setSelectedCardIds([targetId]);
      }
    } else {
      setSelectedCardIds([]);
    }

    const ownerId = e.nativeEvent.isTrusted ? 'user' : 'agent';
    if (ownerId === 'user' && !isAgentRunning) {
      const hitCard = targetId ? cardsRef.current.find(c => c.id === targetId) : undefined;
      const lastReplyObj = hitCard && hitCard.chatHistory && hitCard.chatHistory.length > 0
        ? [...hitCard.chatHistory].reverse().find(m => m.role === 'assistant' && !m.text.includes('生好了，我先看下'))
        : undefined;
      const lastReply = lastReplyObj ? (lastReplyObj.shortText || lastReplyObj.text) : undefined;

      // Sync focus into agentFocusManager
      if (targetIds && targetIds.length > 0) {
        agentFocusManager.batchSetFocus({
          primary: targetIds[0],
          references: targetIds.slice(1),
          role: 'inspect',
          sourceTool: 'user.context_menu',
          cursorMode: 'inspect',
        });
      } else if (targetId) {
        agentFocusManager.setPrimaryFocus(targetId, 'inspect', 'user.context_menu');
        agentFocusManager.setCursorMode('inspect');
      } else {
        agentFocusManager.clearAll();
      }

      setAgentQuickInput({
        isOpen: true,
        targetId,
        targetIds,
        lastReply,
        focusTrigger: Date.now()
      });
    } else {
      setAgentQuickInput(null);
      agentFocusManager.clearAll();
    }

    const menuWidth = 260;
    const clampedX = typeof window !== 'undefined' ? Math.max(12, Math.min(e.clientX, window.innerWidth - menuWidth - 20)) : e.clientX;
    const clampedY = typeof window !== 'undefined' ? Math.max(50, Math.min(e.clientY, window.innerHeight - 340)) : e.clientY;
    const clampedCanvasX = (clampedX - tx.get()) / tScale.get();
    const clampedCanvasY = (clampedY - ty.get()) / tScale.get();
    
    if (!targetId) {
      setContextMenus(prev => ({
        ...prev,
        [ownerId]: {
          x: clampedX,
          y: clampedY,
          canvasX: clampedCanvasX,
          canvasY: clampedCanvasY,
          targetId
        }
      }));
    } else {
      setContextMenus(prev => {
        const next = { ...prev };
        delete next[ownerId];
        return next;
      });
    }

    if (ownerId === 'user' && !isAgentRunning) {
      const selectedCards = targetIds && targetIds.length > 0
        ? cardsRef.current.filter(c => targetIds.includes(c.id))
        : (targetId ? (cardsRef.current.find(c => c.id === targetId) ? [cardsRef.current.find(c => c.id === targetId)!] : []) : (selectedCardIds.length > 0 ? cardsRef.current.filter(c => selectedCardIds.includes(c.id)) : []));
      const promptText = getSelectionPromptText(selectedCards);
      const yOffset = targetId ? 40 : 82;
      setAgentState(prev => ({
        ...prev,
        x: clampedCanvasX - 8 / tScale.get(), // Aligned to the top-left of the menu
        y: clampedCanvasY - yOffset / tScale.get(), // Comfortably lifted based on whether context menu is present
        speak: promptText,
        isMoving: true,
        visible: true
      }));
      setTimeout(() => {
        setAgentState(prev => ({ ...prev, isMoving: false }));
      }, 400);
    }
  };

  const handleCreateCard = (ownerId: string = 'user', isVideo = false) => {
    const menu = contextMenus[ownerId];
    if (!menu) return;
    const newId = Math.random().toString(36).substring(2, 11);
    const newCard: CardData = {
      id: newId,
      x: menu.canvasX,
      y: menu.canvasY,
      state: 'draft',
      ratio: isVideo ? '16:9' : '3:4',
      res: isVideo ? '720p' : '2K',
      prompt: '',
      imageUrl: null,
      isVideo,
      ...(isVideo ? {
        mcpToolName: 'canvas_generate_video',
        mcpModel: 'vuhkzt245c',
        mcpParameters: { mode: 'SubjectToVideo', duration: 5, enable_sound: false, resolution: 3 },
      } : {}),
    };
    setCards(prev => [...prev, newCard]);
    if (ownerId === 'user') setSelectedCardIds([newCard.id]);
    
    setContextMenus(prev => {
      const next = { ...prev };
      delete next[ownerId];
      return next;
    });
    return newId;
  };

  const inspectPage = useCallback(async (options: Record<string, unknown> = {}) => {
    // If the script drawer is open and in script view, but the textarea is still settling (due to the 210ms anti-jank delay),
    // wait a brief moment for it to mount so the observation accurately reflects the visible state.
    if (scriptViewRef.current.drawerOpen && scriptViewRef.current.activeView === 'script' && !document.querySelector('[data-agent-target="script.text"]')) {
      await sleep(120);
    }
    const scope = typeof options.scope === 'string' ? options.scope : 'overview';
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('[data-agent-target]'));
    const scopeElement = candidates.find(element => element.dataset.agentTarget === scope);
    const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
    const limit = Math.min(100, Math.max(1, Math.floor(Number(options.limit) || 40)));
    const view = scriptViewRef.current;
    const isVisible = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      let top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.bottom);
      let left = Math.max(0, rect.left), right = Math.min(window.innerWidth, rect.right);
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const bounds = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
      }
      const style = getComputedStyle(element);
      return bottom > top && right > left && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const scopedComponents = candidates.flatMap((element) => {
      // In overview mode, include both top-level UI components and visible canvas cards
      if (scope === 'overview') {
        if (element.dataset.agentTarget?.startsWith('script.toc.item.')) return [];
      } else {
        if (!scopeElement || !(element === scopeElement || scopeElement.contains(element))) return [];
      }
      const rect = element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0
        && rect.bottom >= 0 && rect.right >= 0
        && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
      if (!visible || !isVisible(element)) return [];
      const id = element.dataset.agentTarget!;
      const definition = getPageComponentDefinition(id);
      const actions = (element.dataset.agentActions || '').split(' ').filter(Boolean);
      if (actions.length === 0) return [];
      
      const isSelected = element.getAttribute('aria-selected') === 'true' || element.getAttribute('aria-current') === 'true' || element.getAttribute('aria-current') === 'page' || element.getAttribute('aria-expanded') === 'true' || element.getAttribute('aria-pressed') === 'true' || element.getAttribute('data-selected') === 'true';
      const isDisabled = element.hasAttribute('disabled') || (element as HTMLButtonElement).disabled === true || element.getAttribute('aria-disabled') === 'true';
      const badge = element.dataset.agentBadge || (id === 'script.toc.open' ? element.querySelector('.rounded-full')?.textContent?.trim() : undefined);
      const isInput = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
      const inputValue = isInput ? (element as HTMLInputElement | HTMLTextAreaElement).value : undefined;
      const placeholder = isInput ? (element as HTMLInputElement | HTMLTextAreaElement).placeholder : undefined;

      let label = id.startsWith('script.toc.item.')
        ? (element.textContent?.trim() || '').replace(/\s+/g, ' ') || id
        : (id === 'script.toc.open' && badge
            ? `${definition?.label || '目录按钮'} (${badge})`
            : definition?.label || element.getAttribute('aria-label') || (element.textContent?.trim() || '').slice(0, 40) || id);

      if (id.startsWith('canvas.card.')) {
        const rawCardId = id.replace('canvas.card.', '');
        const cardObj = cardsRef.current.find(c => c.id === rawCardId);
        if (cardObj) {
          const cardType = cardObj.isVideo ? '视频' : (cardObj.isAsset ? '资产' : '生图');
          const title = cardObj.fileName ? `[${cardObj.fileName}]` : '未命名卡片';
          const promptSnip = cardObj.prompt ? `"${cardObj.prompt.slice(0, 24)}..."` : '(无提示词)';
          label = `画布卡片 ${title} (${cardType}, ${cardObj.state}, ${cardObj.ratio}, ${promptSnip})`;
        }
      } else if (id === 'script.search.counter') {
        const counterText = element.textContent?.trim();
        if (counterText) label = `搜索匹配: ${counterText}`;
      } else if (id === 'script.replace.feedback') {
        const feedbackText = element.textContent?.trim();
        if (feedbackText) label = `替换反馈: "${feedbackText}"`;
      } else if (id === 'script.text') {
        label = `${definition?.label || '剧本文本编辑区'} [正文未直接展开，可申请查看]`;
      } else if (isInput) {
        if (inputValue) {
          label += ` [当前内容: "${inputValue.slice(0, 30)}"]`;
        } else if (placeholder) {
          label += ` [提示: "${placeholder.slice(0, 25)}"]`;
        }
      }

      if (isSelected) {
        label += ' (已选)';
      }
      if (isDisabled) {
        label += ' (禁用)';
      }

      const numericBadge = badge !== undefined && !isNaN(Number(badge)) ? Number(badge) : badge;

      return [{
        id,
        label,
        ...(inputValue !== undefined && id !== 'script.text' ? { text: inputValue.slice(0, 100) } : {}),
        ...(numericBadge !== undefined ? { badge: numericBadge } : {}),
        ...(id === 'script.toc.open' && numericBadge !== undefined ? { episodeCount: numericBadge } : {}),
        actionSet: actions.join(' '),
      }];
    });
    const selected = scopedComponents.slice(offset, offset + limit);
    const actionSets = Object.fromEntries([...new Set(selected.map(item => item.actionSet))].map((value, index) => [`a${index}`, value.split(' ')]));
    const components = selected.map(item => ({ ...item, actionSet: Object.keys(actionSets).find(key => actionSets[key].join(' ') === item.actionSet)! }));
    const tocList = document.querySelector<HTMLElement>('[data-agent-target="script.toc.list"]');
    const tocButton = document.querySelector<HTMLElement>('[data-agent-target="script.toc.open"]');
    const tocBadge = tocButton?.dataset.agentBadge || tocButton?.querySelector('.rounded-full')?.textContent?.trim();
    const numericTocBadge = tocBadge !== undefined && !isNaN(Number(tocBadge)) ? Number(tocBadge) : tocBadge;

    const searchPanel = document.querySelector<HTMLElement>('[data-agent-target="script.search.panel"]');
    const searchInput = document.querySelector<HTMLInputElement>('[data-agent-target="script.search.input"]');
    const replaceInput = document.querySelector<HTMLInputElement>('[data-agent-target="script.replace.input"]');
    const searchCounter = document.querySelector<HTMLElement>('[data-agent-target="script.search.counter"]');
    const caseButton = document.querySelector<HTMLElement>('[data-agent-target="script.search.case"]');
    const replaceFeedbackEl = document.querySelector<HTMLElement>('[data-agent-target="script.replace.feedback"]');
    const searchOpenButton = document.querySelector<HTMLElement>('[data-agent-target="script.search.open"]');
    const isSearchPanelVisible = Boolean(searchPanel && isVisible(searchPanel));

    const textArea = document.querySelector<HTMLTextAreaElement>('[data-agent-target="script.text"]');
    const isExplicitTextScope = scope === 'script.text' || Boolean(scopeElement && (scopeElement === textArea || scopeElement.contains(textArea)));
    const textViewport = textArea && isVisible(textArea) && isExplicitTextScope ? getVisibleTextareaSnapshot(textArea) : null;

    // Check if inspection scope is targeting a specific canvas card
    let focusedCardInfo: any = undefined;
    const targetCardId = scope.startsWith('canvas.card.') ? scope.replace('canvas.card.', '') : (scope === 'overview' ? selectedCardIdsRef.current[0] : undefined);
    if (targetCardId) {
      const cardObj = cardsRef.current.find(c => c.id === targetCardId);
      if (cardObj) {
        focusedCardInfo = {
          id: cardObj.id,
          title: cardObj.fileName || '未命名卡片',
          state: cardObj.state,
          ratio: cardObj.ratio,
          resolution: cardObj.res,
          prompt: cardObj.prompt,
          lastGeneratedPrompt: cardObj.lastGeneratedPrompt,
          model: cardObj.mcpModel,
          referenceImagesCount: cardObj.referenceImages?.length || 0,
          hasImage: Boolean(cardObj.imageUrl || cardObj.thumbnailUrl || cardObj.fileData),
        };
      }
    }

    return {
      scope,
      status: scope === 'overview' || (scopeElement && isVisible(scopeElement)) ? 'visible' : 'not_visible',
      pagination: { offset, returned: components.length, truncated: offset + components.length < scopedComponents.length, nextOffset: offset + components.length < scopedComponents.length ? offset + components.length : null },
      actionSets,
      notices: Array.from(document.querySelectorAll<HTMLElement>('[role="alert"], [role="status"], [role="dialog"]')).filter(isVisible).map(element => ({ role: element.getAttribute('role'), label: element.getAttribute('aria-label') || (element.textContent?.trim() || '').slice(0, 200) })),
      project: { id: currentProject.id, name: currentProject.name },
      canvas: {
        scale: tScale.get(),
        lodMode: isNanoLod ? 'nano' : (isMicroLod ? 'micro' : 'standard'),
        totalCards: cardsRef.current.length,
        visibleCount: scopedComponents.filter(c => c.id.startsWith('canvas.card.')).length,
        focusedCard: focusedCardInfo,
      },
      script: {
        drawerOpen: view.drawerOpen,
        activeView: view.activeView,
        tocOpen: view.tocOpen,
        search: {
          isOpen: isSearchPanelVisible,
          buttonVisible: Boolean(searchOpenButton && isVisible(searchOpenButton)),
          ...(isSearchPanelVisible ? {
            searchText: searchInput?.value || '',
            replaceText: replaceInput?.value || '',
            matchStatus: searchCounter?.textContent?.trim() || (searchInput?.value ? '无匹配' : '未搜索'),
            isCaseSensitive: caseButton?.getAttribute('aria-pressed') === 'true',
            ...(replaceFeedbackEl && isVisible(replaceFeedbackEl) ? { feedback: replaceFeedbackEl.textContent?.trim() } : {}),
          } : {}),
        },
        tocButton: tocButton && isVisible(tocButton) ? {
          visible: true,
          label: '目录',
          badge: numericTocBadge,
          episodeCount: numericTocBadge,
        } : undefined,
        directory: scope === 'script.toc.list' && tocList && isVisible(tocList)
          ? { atTop: tocList.scrollTop <= 1, atBottom: tocList.scrollTop + tocList.clientHeight >= tocList.scrollHeight - 1, progress: tocList.scrollHeight <= tocList.clientHeight ? 1 : tocList.scrollTop / (tocList.scrollHeight - tocList.clientHeight) }
          : undefined,
        text: textArea && isVisible(textArea)
          ? (textViewport
              ? {
                  status: 'visible',
                  visibleText: textViewport.visibleText,
                  characterRange: textViewport.characterRange,
                  scroll: textViewport.scroll,
                  selection: scriptSelection,
                  hint: '当前为申请查看的正文视口片段。如需翻阅更多，可使用 mouse.scroll 滚动后再观察。',
                }
              : {
                  status: 'visible',
                  hint: '剧本正文未直接展开注入上下文。如需阅读当前正文视野，可调用 page.inspect({ scope: "script.text" }) 申请查看；或通过目录、搜索定位。',
                  scroll: {
                    atTop: textArea.scrollTop <= 1,
                    atBottom: textArea.scrollTop + textArea.clientHeight >= textArea.scrollHeight - 2,
                  },
                }
            )
          : { status: 'not_visible' },
      },
      components,
    };
  }, [currentProject.id, currentProject.name, scriptSelection, tScale, isNanoLod, isMicroLod]);

  // The cursor is the Agent's public action path. It performs the same visible
  // UI step a person would take; only the resulting page observation exposes data.
  const animateMouseAction = useCallback(async (action: MouseActionName, targetId: string, arguments_: Record<string, unknown>) => {
    let target = document.querySelector(`[data-agent-target="${targetId}"]`);
    if (!(target instanceof HTMLElement)) {
      if (targetId.startsWith('canvas.card.')) {
        const cardId = targetId.replace('canvas.card.', '');
        const cardObj = cardsRef.current.find(c => c.id === cardId);
        if (cardObj) {
          const dim = getCardSize(cardObj);
          setAgentState(prev => ({ ...prev, x: cardObj.x + dim.width / 2, y: cardObj.y + dim.height / 2, visible: true, isMoving: true }));
          await sleep(350);
          setAgentState(prev => ({ ...prev, isMoving: false, isActive: action !== 'mouse.move' && action !== 'mouse.hover' }));
          await sleep(150);
          setAgentState(prev => ({ ...prev, isActive: false }));
          await sleep(120);
          return { action, targetId };
        }
      }
      throw new Error(`当前页面找不到操作目标：${targetId}`);
    }
    const supportedActions = (target.dataset.agentActions || '').split(' ').filter(Boolean);
    if (!supportedActions.includes(action)) throw new Error(`组件 ${targetId} 不支持动作：${action}`);
    const rect = target.getBoundingClientRect();
    setAgentState(prev => ({ ...prev, x: (rect.left + rect.width / 2 - tx.get()) / tScale.get(), y: (rect.top + rect.height / 2 - ty.get()) / tScale.get(), visible: true, isMoving: true }));
    await sleep(350);
    setAgentState(prev => ({ ...prev, isMoving: false, isActive: action !== 'mouse.move' && action !== 'mouse.hover' }));
    // The semantic UI adapter below applies the same page transition after the
    // visible cursor action has reached the target.
    if (action === 'mouse.hover') await sleep(Number(arguments_.duration || 350));
    else if (action === 'mouse.longPress') await sleep(Math.min(Math.max(Number(arguments_.duration || 700), 400), 2000));
    else await sleep(150);
    setAgentState(prev => ({ ...prev, isActive: false }));
    await sleep(120);
    return { action, targetId };
  }, [inspectPage, tScale, tx, ty]);

  // Animate cursor movement to visually focus and inspect a specific target component
  const animateMoveToTarget = useCallback(async (targetId: string) => {
    if (targetId === 'canvas.viewport' || targetId === 'overview') {
      const scaleVal = tScale.get() || 1;
      const centerX = (window.innerWidth / 2 - tx.get()) / scaleVal;
      const centerY = (window.innerHeight / 2 - ty.get()) / scaleVal;
      setAgentState(prev => ({
        ...prev,
        x: centerX + 20,
        y: centerY - 20,
        visible: true,
        isMoving: true,
        isActive: false,
      }));
      await sleep(350);
      setAgentState(prev => ({ ...prev, isMoving: false, isActive: false }));
      await sleep(160);
      return;
    }

    let moved = false;
    let target = document.querySelector(`[data-agent-target="${targetId}"]`);
    if (!target) {
      await sleep(60);
      target = document.querySelector(`[data-agent-target="${targetId}"]`);
    }
    if (target instanceof HTMLElement) {
      const rect = target.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.top <= window.innerHeight && rect.right >= 0 && rect.left <= window.innerWidth) {
        const centerX = rect.width > 360 ? rect.left + Math.min(rect.width / 2, 240) : rect.left + rect.width / 2;
        const centerY = rect.height > 200 ? rect.top + Math.min(rect.height / 4, 90) : rect.top + rect.height / 2;
        const scaleVal = tScale.get() || 1;
        const targetX = (centerX - tx.get()) / scaleVal;
        const targetY = (centerY - ty.get()) / scaleVal;

        setAgentState(prev => ({
          ...prev,
          x: targetX,
          y: targetY,
          visible: true,
          isMoving: true,
          isActive: false,
        }));

        await sleep(350);
        setAgentState(prev => ({ ...prev, isMoving: false, isActive: false }));
        await sleep(160);
        moved = true;
      }
    }
    
    // Fallback: If DOM element is not mounted or not fully within viewport, directly resolve world coordinates from data layer
    if (!moved && targetId.startsWith('canvas.card.')) {
      const cardId = targetId.replace('canvas.card.', '');
      const cardObj = cardsRef.current.find(c => c.id === cardId);
      if (cardObj) {
        const dim = getCardSize(cardObj);
        setAgentState(prev => ({
          ...prev,
          x: cardObj.x + dim.width / 2,
          y: cardObj.y + dim.height / 2,
          visible: true,
          isMoving: true,
          isActive: false,
        }));
        await sleep(350);
        setAgentState(prev => ({ ...prev, isMoving: false, isActive: false }));
        await sleep(160);
      }
    }
  }, [tScale, tx, ty]);

  // Helper to ensure smooth scroll animations finish completely and layout settles before page observation
  const scrollElementAndWait = (element: HTMLElement, delta: number): Promise<void> => {
    return new Promise((resolve) => {
      const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
      if (maxScroll <= 0) {
        resolve();
        return;
      }

      const startingScroll = element.scrollTop;
      if ((delta > 0 && startingScroll >= maxScroll - 1) || (delta < 0 && startingScroll <= 1)) {
        resolve();
        return;
      }

      let settledTimer: any = null;
      let safetyTimer: any = null;
      let lastTop = element.scrollTop;
      let stableCount = 0;
      let hasMoved = false;

      const cleanup = () => {
        element.removeEventListener('scrollend', onScrollEnd);
        element.removeEventListener('scroll', onScroll);
        if (settledTimer) clearInterval(settledTimer);
        if (safetyTimer) clearTimeout(safetyTimer);
      };

      const done = () => {
        cleanup();
        requestAnimationFrame(() => {
          setTimeout(resolve, 60);
        });
      };

      const onScrollEnd = () => {
        done();
      };

      const onScroll = () => {
        hasMoved = true;
        stableCount = 0;
        lastTop = element.scrollTop;
      };

      element.addEventListener('scrollend', onScrollEnd, { once: true });
      element.addEventListener('scroll', onScroll, { passive: true });

      settledTimer = setInterval(() => {
        const current = element.scrollTop;
        if (Math.abs(current - lastTop) < 1) {
          stableCount++;
          if ((hasMoved && stableCount >= 3) || stableCount >= 5) {
            done();
          }
        } else {
          hasMoved = true;
          stableCount = 0;
          lastTop = current;
        }
      }, 40);

      safetyTimer = setTimeout(done, 1200);

      element.scrollBy({ top: delta, behavior: 'smooth' });
    });
  };

  // This adapter maps a visible component to its real UI transition. It never
  // returns project facts; a later page.inspect remains the only evidence path.
  const applyPageCommand = useCallback(async (action: MouseActionName, targetId: string, arguments_: Record<string, unknown>) => {
    if (action === 'mouse.click') {
      const target = document.querySelector(`[data-agent-target="${targetId}"]`);
      if (target instanceof HTMLElement) {
        // Dispatch both native click and React-compatible MouseEvent to ensure maximum compatibility
        target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
        // target.click() inherently dispatches a native click event that bubbles and triggers React's onClick.
        // Doing both dispatchEvent('click') AND .click() causes a double-fire, which breaks toggle buttons (prev => !prev).
        target.click();
      } else {
        // Manual fallback for critical global state views just in case the element wasn't found in DOM
        if (targetId.startsWith('canvas.card.')) {
          const cardId = targetId.replace('canvas.card.', '');
          setSelectedCardIds([cardId]);
        }
        else if (targetId === 'script-bible-toggle') setDrawerOpen(!scriptViewRef.current.drawerOpen);
        else if (targetId === 'script.close') setDrawerOpen(false);
        else if (targetId === 'script.view.script') setScriptView('script');
        else if (targetId === 'script.view.assets') setScriptView('assets');
        else if (targetId === 'script.view.universe') setScriptView('universe');
        else if (targetId === 'script.toc.open') setTocOpen(!scriptViewRef.current.tocOpen);
        else if (targetId.startsWith('script.toc.item.')) {
          setRequestedTocItemId(targetId.replace('script.toc.item.', ''));
        }
      }
    }
    if (action === 'mouse.scroll') {
      if (targetId === 'canvas.viewport') {
        const delta = Number(arguments_.delta) || (arguments_.direction === 'up' ? -120 : (arguments_.direction === 'down' ? 120 : 0));
        // Positive delta zooms in, negative zooms out (or standard wheel zoom)
        const zoomFactor = delta > 0 ? 1.25 : 0.8;
        const currentScale = tScale.get();
        const newScale = Math.min(Math.max(0.1, currentScale * zoomFactor), 5.0);
        
        // Zoom towards screen center
        const centerX = window.innerWidth / 2;
        const centerY = window.innerHeight / 2;
        const worldX = (centerX - tx.get()) / currentScale;
        const worldY = (centerY - ty.get()) / currentScale;
        const newTx = centerX - worldX * newScale;
        const newTy = centerY - worldY * newScale;

        triggerTweenZoom(300);
        targetTransform.current = { x: newTx, y: newTy, scale: newScale };
        animate(tScale, newScale, { duration: 0.3, ease: [0.16, 1, 0.3, 1] });
        animate(tx, newTx, { duration: 0.3, ease: [0.16, 1, 0.3, 1] });
        animate(ty, newTy, { duration: 0.3, ease: [0.16, 1, 0.3, 1] });
        await sleep(320);
        return;
      }

      let delta = 480;
      if (arguments_.direction === 'top') delta = -999999;
      else if (arguments_.direction === 'bottom') delta = 999999;
      else if (arguments_.direction === 'up') delta = -480;
      else if (arguments_.direction === 'down') delta = 480;
      else {
        const requestedDelta = Number(arguments_.delta);
        if (Number.isFinite(requestedDelta) && requestedDelta !== 0) delta = requestedDelta;
      }
      
      if (targetId === 'script.toc.list') {
        setTocOpen(true);
      }

      const target = document.querySelector(`[data-agent-target="${targetId}"]`);
      if (target instanceof HTMLElement) {
        await scrollElementAndWait(target, delta);
        if (targetId === 'script.toc.list') {
          const atBottom = target.scrollTop + target.clientHeight >= target.scrollHeight - 2;
          setTocAtBottom(atBottom);
        }
      }
    }
    if (action === 'mouse.drag') {
      if (targetId === 'canvas.viewport') {
        const deltaX = Number(arguments_.deltaX || arguments_.dx || 0);
        const deltaY = Number(arguments_.deltaY || arguments_.dy || 0);
        const newTx = tx.get() + (deltaX !== 0 ? deltaX : 300);
        const newTy = ty.get() + (deltaY !== 0 ? deltaY : 0);
        targetTransform.current = { x: newTx, y: newTy, scale: tScale.get() };
        animate(tx, newTx, { duration: 0.35, ease: [0.16, 1, 0.3, 1] });
        animate(ty, newTy, { duration: 0.35, ease: [0.16, 1, 0.3, 1] });
        await sleep(380);
        return;
      }
      if (targetId.startsWith('canvas.card.')) {
        const cardId = targetId.replace('canvas.card.', '');
        const cardObj = cardsRef.current.find(c => c.id === cardId);
        if (cardObj) {
          const deltaX = Number(arguments_.deltaX || arguments_.dx || 0);
          const deltaY = Number(arguments_.deltaY || arguments_.dy || 0);
          handleUpdateCard(cardId, { x: cardObj.x + deltaX, y: cardObj.y + deltaY }, true);
          await sleep(200);
          return;
        }
      }
      if (targetId === 'script.text') {
        const target = document.querySelector(`[data-agent-target="${targetId}"]`);
        const start = Number(arguments_.start);
        const end = Number(arguments_.end);
        if (target instanceof HTMLTextAreaElement && Number.isInteger(start) && Number.isInteger(end)) {
          target.focus({ preventScroll: true });
          target.setSelectionRange(Math.max(0, start), Math.max(0, end));
          target.dispatchEvent(new Event('select', { bubbles: true }));
        }
      }
    }
    if (action === 'mouse.type') {
      const target = document.querySelector(`[data-agent-target="${targetId}"]`);
      const text = typeof arguments_.text === 'string' ? arguments_.text : '';
      if ((target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) && typeof text === 'string') {
        const shouldClear = arguments_.clear === true;
        const start = shouldClear ? 0 : (target.selectionStart || 0);
        const end = shouldClear ? target.value.length : (target.selectionEnd || 0);
        target.focus({ preventScroll: true });
        
        // For React 16+, we must bypass the synthetic value setter to trigger a real onChange
        const prototype = target instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        
        if (nativeInputValueSetter) {
          const currentValue = target.value;
          const newValue = (shouldClear ? '' : currentValue.substring(0, start)) + text + (shouldClear ? '' : currentValue.substring(end));
          nativeInputValueSetter.call(target, newValue);
          target.dispatchEvent(new Event('input', { bubbles: true }));
          target.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          target.setRangeText(text, start, end, 'end');
          target.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        }
      }
    }
    if (action === 'mouse.keyPress') {
      const target = document.querySelector(`[data-agent-target="${targetId}"]`);
      const key = typeof arguments_.key === 'string' ? arguments_.key : '';
      const shiftKey = Boolean(arguments_.shiftKey || arguments_.shift);
      if (target instanceof HTMLElement && key) {
        target.focus({ preventScroll: true });
        // Use a more complete mock for React's synthetic event system
        const keydownEvent = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, code: key === 'Enter' ? 'Enter' : undefined, shiftKey });
        target.dispatchEvent(keydownEvent);
        target.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, cancelable: true, key, shiftKey }));
        target.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key, shiftKey }));
      }
    }
    // Allow React to mount any target needed by the next presentation step.
    // When toggling drawers or views with 200ms+ transition locks, wait for layout to settle completely.
    if (action !== 'mouse.scroll') {
      const isDrawerOrViewToggle = targetId === 'script-bible-toggle' || targetId.startsWith('script.view.') || targetId === 'script.toc.open' || targetId === 'script.search.open';
      const isSearchOrReplaceAction = targetId.startsWith('script.search.') || targetId.startsWith('script.replace.');
      await sleep(isDrawerOrViewToggle ? 280 : (isSearchOrReplaceAction ? 220 : 180));
    }
  }, [setDrawerOpen, setScriptView, setTocOpen, setTocAtBottom]);

  const executeAgentTool = useCallback(async (call: AgentToolCall, task: RuntimeTask, signal?: AbortSignal) => {
    if (signal?.aborted) return { aborted: true };
    const rememberObservation = (page: Awaited<ReturnType<typeof inspectPage>>) => {
      observedTargetsByTaskRef.current.set(task.id, new Set(page.components.map(component => component.id)));
      return page;
    };
    if (call.name === 'page.inspect') {
      agentFocusManager.setCursorMode('inspect');
      const scope = typeof call.arguments?.scope === 'string' && call.arguments.scope !== 'overview'
        ? call.arguments.scope
        : (typeof call.arguments?.targetId === 'string' && call.arguments.targetId !== 'overview' ? call.arguments.targetId : undefined);

      if (scope) {
        if (scope.startsWith('canvas.card.')) {
          agentFocusManager.setPrimaryFocus(scope.replace('canvas.card.', ''), 'inspect', 'page.inspect.compare');
        } else if (scope.startsWith('card_')) {
          agentFocusManager.setPrimaryFocus(scope, 'inspect', 'page.inspect.compare');
        }
        await animateMoveToTarget(scope);
        if (signal?.aborted) return { aborted: true };
      } else {
        await animateMoveToTarget('overview');
        if (signal?.aborted) return { aborted: true };
      }
      return rememberObservation(await inspectPage(call.arguments));
    }
    if (call.name === 'guide.lookup') {
      const query = String(call.arguments.query || '');
      return {
        query,
        guidance: /画布|缩放|拖拽|平移|zoom|pan|canvas/i.test(query)
          ? '操作说明：在无限画布主界面中，针对“canvas.viewport”执行 mouse.scroll 可缩放画布（正数放大，负数缩小）；执行 mouse.drag 并传入 { deltaX, deltaY } 可平移画布视野；点击或悬停画布上的卡片(如 canvas.card.xxx)可聚焦卡片。'
          : /卡片|图片|生图|生成|详情|card|image/i.test(query)
          ? '操作说明：在无限画布上，所有卡片均以 "canvas.card.<id>" 命名。可调用 page.inspect 观察视野内的可见卡片；指定 scope 为特定卡片 ID（如 canvas.card.xxx）可深入观察其提示词、比例、分辨率及生成状态；通过 ui.actAndObserve 对卡片执行 mouse.click 可选中该卡片。'
          : /搜索|替换|查找|replace|search/i.test(query)
          ? '操作说明：在剧本正文视图中，点击二级菜单的“搜索替换按钮(script.search.open)”展开面板；在“搜索输入框(script.search.input)”输入目标关键词（可点击“区分大小写切换(script.search.case)”）；通过“下一个匹配项(script.search.next)”或“上一个匹配项(script.search.prev)”在正文中高亮定位；在“替换输入框(script.replace.input)”中输入新文本，可执行“单处替换(script.replace.single)”或“全部替换(script.replace.all)”。操作说明不包含当前项目的具体文本内容。'
          : /正文|文本|阅读|内容|script\.text/.test(query)
          ? '操作说明：页面观察默认不直接展开剧本正文全文。若需阅读正文当前视野，可调用 page.inspect 并指定 scope 为 "script.text" 申请查看；也可通过目录快速跳转或通过搜索定位特定内容。'
          : /剧本|目录|集数|分集/.test(query)
          ? '操作说明：先通过左上角“剧本”入口打开剧本面板；从当前可见的面板按钮进入“目录”；目录可滚动，需以页面观察到的最后可见条目和到底状态作为依据。操作说明不包含当前项目的集数、目录或剧本内容。'
          : '操作说明只描述界面如何操作，不提供当前项目的隐藏数据。先用 page.inspect 了解用户此刻可见的页面与目标。',
      };
    }
    if (call.name === 'ui.actAndObserve') {
      const action = call.arguments.action as MouseActionName;
      const targetId = String(call.arguments.targetId || '');
      if (!action?.startsWith('mouse.')) throw new Error('ui.actAndObserve 缺少合法鼠标动作。');

      if (!observedTargetsByTaskRef.current.get(task.id)?.has(targetId)) {
        throw new Error(`尚未从 page.inspect 观察到可操作目标：${targetId}`);
      }

      await animateMouseAction(action, targetId, call.arguments.arguments as Record<string, unknown> || {});
      if (signal?.aborted) return { aborted: true };
      await applyPageCommand(action, targetId, call.arguments.arguments as Record<string, unknown> || {});

      // Use the provided observe payload, or fallback to sensible defaults
      const observePayload = (call.arguments.observe && typeof call.arguments.observe === 'object')
        ? (call.arguments.observe as Record<string, unknown>)
        : { scope: (action === 'mouse.scroll' || action === 'mouse.type') ? targetId : 'overview' };

      const observeScope = typeof observePayload?.scope === 'string' && observePayload.scope !== 'overview' ? observePayload.scope : undefined;
      if (observeScope && observeScope !== targetId) {
        await animateMoveToTarget(observeScope);
        if (signal?.aborted) return { aborted: true };
      }

      return { action, targetId, page: rememberObservation(await inspectPage(observePayload)) };
    }
    if (call.name === 'card.inspect') {
      const cardId = String(call.arguments.cardId || '');
      const includeImage = Boolean(call.arguments.includeImage);
      const includePrompt = Boolean(call.arguments.includePrompt);
      const includeReference = Boolean(call.arguments.includeReference);
      const includeParameters = Boolean(call.arguments.includeParameters);

      // Support stripping 'canvas.card.' prefix if used by the Agent
      const cleanCardId = cardId.startsWith('canvas.card.') ? cardId.replace('canvas.card.', '') : cardId;

      const allCards = cardsRef.current.length > 0 ? cardsRef.current : cards;
      const card = allCards.find(c => c.id === cleanCardId);

      if (!card) {
        throw new Error(`未找到 ID 为 ${cardId} 的卡片。请核对当前页面观察可见卡片。`);
      }

      agentFocusManager.setCursorMode('inspect');
      agentFocusManager.setPrimaryFocus(cleanCardId, 'inspect', 'card.inspect.compare');
      await animateMoveToTarget('canvas.card.' + cleanCardId);

      const response: Record<string, any> = {
        cardId: card.id,
        name: card.name || '未命名卡片'
      };

      if (includePrompt) {
        response.prompt = card.prompt || '该卡片目前暂无提示词';
      }

      if (includeReference) {
        const refList = card.referenceImages || card.references || [];
        response.references = refList.map(r => ({
          name: r.name || r.sourceCardId || '参考图',
          url: r.url || r.originalUrl || '',
          sourceCardId: r.sourceCardId
        }));
      }

      if (includeParameters) {
        response.parameters = {
          aspectRatio: card.ratio || card.aspectRatio || '1:1',
          style: card.style || 'None',
          status: card.state || card.status || 'completed',
          mcpModel: card.mcpModel,
          res: card.res || '2K',
          type: card.isVideo ? 'video' : 'image',
          createdAt: card.createdAt || Date.now()
        };
      }

      if (includeImage) {
        try {
          const imgBase64 = await extractCardImageBase64(card);
          if (imgBase64) {
            if (!task.images) task.images = [];
            if (!task.images.includes(imgBase64)) {
              task.images.push(imgBase64);
            }
            response.imageObservation = '[已注入高清卡片图像到您的多模态视觉上下文。您在当前轮次中已可真实看清并仔细分析此图片内容。]';
          } else {
            response.imageObservation = '[该卡片尚未成功生成可用画面，或画面正在排队/渲染中。]';
          }
        } catch (e) {
          response.imageObservation = `[提取高清卡片图像Base64失败: ${(e as Error).message}]`;
        }
      }

      if (includeReference) {
        const refList = card.referenceImages || card.references || [];
        for (const ref of refList) {
          const refUrl = ref.url || ref.originalUrl;
          if (refUrl && refUrl.startsWith('data:image/')) {
            if (!task.images) task.images = [];
            if (!task.images.includes(refUrl)) {
              task.images.push(refUrl);
            }
          }
        }
      }

      return response;
    }
    if (call.name === 'card.detectLandmarks') {
      const cardId = String(call.arguments.cardId || call.arguments.targetCardId || '');
      const cleanCardId = cardId.startsWith('canvas.card.') ? cardId.replace('canvas.card.', '') : cardId;
      const customPrompt = typeof call.arguments.prompt === 'string' ? call.arguments.prompt.trim() : undefined;
      const force = call.arguments.force !== false; // 默认 true: 强制执行重新识别

      const allCards = cardsRef.current.length > 0 ? cardsRef.current : cards;
      const card = allCards.find(c => c.id === cleanCardId);

      if (!card) {
        throw new Error(`未找到 ID 为 ${cardId} 的卡片。请核对当前页面观察可见卡片。`);
      }

      agentFocusManager.setCursorMode('working');
      agentFocusManager.setPrimaryFocus(cleanCardId, 'working', 'card.detectLandmarks');
      await animateMoveToTarget('canvas.card.' + cleanCardId);

      const mediaUrl = card.imageUrl || card.url || card.originalUrl || '';
      const result = await detectAndSaveCardLandmarks(card, mediaUrl, customPrompt, force);
      return result;
    }
    if (call.name === 'card.generate') {
      const rawTargetCardId = String(call.arguments.targetCardId || call.arguments.cardId || '');
      const prompt = typeof call.arguments.prompt === 'string' ? call.arguments.prompt.trim() : '';
      const aspectRatio = typeof call.arguments.aspectRatio === 'string' ? call.arguments.aspectRatio : undefined;
      const autoStart = call.arguments.autoStart !== false; // Defaults to true unless explicitly set to false

      // 提取规范的卡片名称（短小精炼、辨识度高）
      const rawName = typeof call.arguments.name === 'string' ? call.arguments.name.trim() :
                      typeof call.arguments.cardName === 'string' ? call.arguments.cardName.trim() :
                      typeof call.arguments.title === 'string' ? call.arguments.title.trim() : '';
      const fallbackName = prompt ? prompt.slice(0, 10).replace(/[^\w\u4e00-\u9fa5]/g, '') : '生图卡片';
      const cardName = rawName || fallbackName || '生图卡片';

      // Extract referenceCardIds array from tool arguments
      let rawRefIds: string[] = [];
      if (Array.isArray(call.arguments.referenceCardIds)) {
        rawRefIds = call.arguments.referenceCardIds.map(String);
      } else if (typeof call.arguments.referenceCardIds === 'string' && call.arguments.referenceCardIds.trim()) {
        rawRefIds = [call.arguments.referenceCardIds.trim()];
      } else if (typeof call.arguments.referenceCardId === 'string' && call.arguments.referenceCardId.trim()) {
        rawRefIds = [call.arguments.referenceCardId.trim()];
      }

      const allCards = cardsRef.current.length > 0 ? cardsRef.current : cards;

      const forceOverwrite = call.arguments.forceOverwrite === true;

      // Clean target card ID
      const cleanTargetId = rawTargetCardId.startsWith('canvas.card.') ? rawTargetCardId.replace('canvas.card.', '') : rawTargetCardId;
      const targetCard = allCards.find(c => c.id === cleanTargetId);

      const targetIsAsset = Boolean(targetCard?.fileName || targetCard?.isAsset);
      const targetIsCompleted = Boolean(targetCard && (targetCard.state === 'completed' || Boolean(targetCard.imageUrl)));

      // 🛡️ Human UI Unified Rule:
      // Asset cards are always automatically added to referenceCardIds.
      // Completed generation cards are FORKED (衍生新卡片保留历史)，
      // but their rendered image is NOT forcibly turned into a reference image unless explicitly passed in referenceCardIds!
      if (targetCard && targetIsAsset && !rawRefIds.includes(targetCard.id)) {
        rawRefIds.push(targetCard.id);
      }

      // Collect all reference image items & source IDs
      const collectedRefImages: any[] = [];
      const collectedRefSourceIds: string[] = [];

      rawRefIds.forEach(id => {
        const cleanId = id.startsWith('canvas.card.') ? id.replace('canvas.card.', '') : id;
        const refCard = allCards.find(c => c.id === cleanId);
        if (refCard) {
          collectedRefSourceIds.push(refCard.id);
          collectedRefImages.push({
            url: refCard.imageUrl || refCard.originalImageUrl || '',
            name: refCard.fileName || refCard.id,
            sourceCardId: refCard.id,
            fileData: refCard.trueOriginalFileData || refCard.originalFileData || refCard.fileData,
          });
        }
      });

      let activeCard: CardData | undefined = undefined;

      // 🛡️ Human UI Unified Fork Philosophy:
      // If target is missing, "new", Asset Card, or ALREADY COMPLETED (and forceOverwrite is false),
      // we AUTOMATICALLY Fork (复刻) to create a new card next to it, protecting historical results!
      const isNewTarget = !cleanTargetId || cleanTargetId === 'new' || targetIsAsset || (targetIsCompleted && !forceOverwrite);
      const isForked = isNewTarget;

      if (isNewTarget) {
        // Create a brand new generation card next to the reference card or target
        const sourceForPos = targetCard || (rawRefIds.length > 0 ? allCards.find(c => c.id === rawRefIds[0]) : undefined);
        if (sourceForPos) {
          // 🛡️ Single Source of Truth: Reuse exact human UI Forking pipeline
          // Inherit sourceForPos parameters (prompt, ratio, res, mcpModel, referenceImages)
          // UNLESS Agent explicitly provided custom overrides in arguments!
          const forkConfig: Partial<CardData> = {
            name: cardName,
            fileName: cardName,
            prompt: prompt || sourceForPos.prompt || '基于参考素材创作的生图卡片',
            ratio: aspectRatio || sourceForPos.ratio || '16:9',
            res: sourceForPos.res || '2K',
            mcpModel: sourceForPos.mcpModel || WORKRALLY_IMAGE_MODELS[0].id,
            mcpToolName: sourceForPos.mcpToolName,
            mcpParameters: sourceForPos.mcpParameters ? { ...sourceForPos.mcpParameters } : undefined,
          };

          // If Agent explicitly provided referenceCardIds, use them.
          // Otherwise leave referenceImages undefined so handleForkCard inherits sourceForPos's reference assets!
          if (rawRefIds.length > 0) {
            forkConfig.referenceSourceIds = collectedRefSourceIds;
            forkConfig.referenceImages = collectedRefImages;
          }

          // 🛡️ Card is instantiated instantly without blocking on network requests;
          // autoStart generation is performed downstream after visual cursor action!
          activeCard = (await handleForkCard(sourceForPos.id, forkConfig, false)) || undefined;
        } else {
          const newId = `card_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const newCardObj: CardData = {
            id: newId,
            name: cardName,
            fileName: cardName,
            x: 200,
            y: 200,
            imageUrl: '',
            prompt: prompt || '基于参考素材创作的生图卡片',
            ratio: aspectRatio || '1:1',
            res: '2K',
            state: 'draft',
            referenceSourceIds: collectedRefSourceIds,
            referenceImages: collectedRefImages,
            mcpModel: WORKRALLY_IMAGE_MODELS[0].id,
          };
          setCards(prev => [...prev, newCardObj]);
          cardsRef.current = [...cardsRef.current.filter(c => c.id !== newCardObj.id), newCardObj];
          activeCard = newCardObj;
        }
      } else {
        // Target is a draft or failed card, or forceOverwrite === true (in-place update)
        activeCard = targetCard;
        if (activeCard && (collectedRefImages.length > 0 || collectedRefSourceIds.length > 0)) {
          handleUpdateCard(activeCard.id, {
            name: cardName,
            fileName: cardName,
            referenceSourceIds: Array.from(new Set([...(activeCard.referenceSourceIds || []), ...collectedRefSourceIds])),
            referenceImages: dedupeReferenceImages([...(activeCard.referenceImages || []), ...collectedRefImages]),
          }, false);
        }
      }

      const activeCardId = activeCard?.id || cleanTargetId || `card_${Date.now()}`;
      const effectivePrompt = prompt || activeCard?.prompt || '美观生动的画面';
      const effectiveRatio = aspectRatio || activeCard?.ratio || '16:9';

      if (activeCard) {
        handleUpdateCard(activeCard.id, {
          name: cardName,
          fileName: cardName,
          prompt: effectivePrompt,
          ratio: effectiveRatio,
        }, false);

        agentFocusManager.setCursorMode('working');
        agentFocusManager.batchSetFocus({
          primary: activeCard.id,
          references: rawRefIds,
          role: 'working',
          sourceTool: 'card.generate',
          cursorMode: 'working',
        });
        await animateMoveToTarget('canvas.card.' + activeCard.id);

        // Perform physical generation gesture: press down to trigger generation, then release
        setAgentState(prev => ({ ...prev, isActive: true }));
        await sleep(180);
        setAgentState(prev => ({ ...prev, isActive: false }));
        await sleep(120);
      }

      // 🛡️ Mode A: autoStart === false -> Draft Configuration Only
      if (!autoStart) {
        if (activeCard) {
          handleUpdateCard(activeCard.id, { state: 'draft' }, false);
        }
        return {
          success: true,
          cardId: activeCardId,
          cardName: cardName,
          cardState: 'draft',
          isForked,
          autoStarted: false,
          prompt: effectivePrompt,
          referenceCount: collectedRefImages.length,
          message: isForked
            ? `从卡片【${cleanTargetId || '源卡片'}】复刻衍生出生图卡片【${cardName} (${activeCardId})】，参考图与新提示词已就位（处于草稿待生成状态）。`
            : `生图卡片【${cardName} (${activeCardId})】已配置完成，参考图与提示词已就位（处于草稿待生成状态）。`
        };
      }

      // 🛡️ Mode B: autoStart === true -> Real Background Submission
      if (activeCard) {
        handleUpdateCard(activeCard.id, {
          state: 'generating',
          prompt: effectivePrompt,
          ratio: effectiveRatio,
        }, true);
      }

      try {
        const savedApiKey = localStorage.getItem('deepseek_api_key') || localStorage.getItem('qwen_api_key') || '';
        const activeMcp = getMcpConfig();

        // 🛡️ Resolve reference image items into valid Base64 / proxy URLs for WorkRally MCP
        const rawRefList = dedupeReferenceImages(activeCard?.referenceImages || collectedRefImages || []);
        const resolvedRefPayloads: string[] = [];
        for (const ref of rawRefList) {
          const payload = await resolveReferenceToPayload(ref, allCards);
          if (payload) {
            resolvedRefPayloads.push(payload);
          }
        }

        const resResult = await fetch('/api/mcp/workrally/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            token: activeMcp.token,
            serverUrl: activeMcp.serverUrl,
            prompt: effectivePrompt,
            ratio: effectiveRatio,
            res: activeCard?.res || '2K',
            isVideo: false,
            referenceImages: resolvedRefPayloads,
            toolName: WORKRALLY_IMAGE_TOOL,
            model: activeCard?.mcpModel || WORKRALLY_IMAGE_MODELS[0].id,
            defer: true,
          })
        });

        const parsed = await safeParseJsonResponse(resResult);

        // Async Pending Return Handler
        if (parsed.data?.pending && parsed.data?.taskIds?.[0]) {
          const taskId = parsed.data.taskIds[0];
          if (activeCard) {
            handleUpdateCard(activeCard.id, {
              state: 'generating',
              mcpTaskId: taskId,
              lastGeneratedPrompt: effectivePrompt,
            }, true);
          }

          return {
            success: true,
            status: 'pending',
            cardId: activeCardId,
            cardName: cardName,
            cardState: 'generating',
            isForked,
            autoStarted: true,
            mcpTaskId: taskId,
            prompt: effectivePrompt,
            message: isForked
              ? `已从【${cleanTargetId || '源卡片'}】复刻衍生新卡片【${cardName} (${activeCardId})】并在界面启动排队渲染，任务句柄 [${taskId}]。`
              : `生图卡片【${cardName} (${activeCardId})】已在界面启动加载渲染，任务句柄 [${taskId}] 正在排队中。`
          };
        }

        let newMediaUrl = parsed.data?.mediaUrl;

        if (!parsed.success || !parsed.data?.success || !newMediaUrl) {
          const fallbackRes = await fetch('/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: effectivePrompt,
              aspectRatio: effectiveRatio,
              apiKey: savedApiKey
            })
          });
          const fallbackJson = await fallbackRes.json().catch(() => ({}));
          if (fallbackRes.ok && (fallbackJson.imageUrl || fallbackJson.data?.[0]?.url)) {
            newMediaUrl = fallbackJson.imageUrl || fallbackJson.data[0].url;
          } else {
            let rawErrMsg = parsed.error || fallbackJson.error || '生成服务响应失败，请检查 API Key / MCP 密钥额度与网络连接';
            if (rawErrMsg.includes('积分额度已用完')) {
              rawErrMsg = 'WorkRally MCP 积分额度已用完，请点击顶部「密钥设置」切换额度充足的 MCP 密钥，或在设置页面配置 API Key。';
            }
            throw new Error(rawErrMsg);
          }
        }

        handleUpdateCard(activeCard.id, {
          imageUrl: newMediaUrl,
          state: 'idle',
          lastGeneratedPrompt: effectivePrompt,
        }, true);

        return {
          success: true,
          cardId: activeCard.id,
          cardName: cardName,
          cardState: 'completed',
          imageUrl: newMediaUrl,
          prompt: effectivePrompt,
          message: isNewTarget
            ? `已自动新建独立生图卡片【${cardName} (${activeCard.id})】并绑定 ${collectedRefImages.length} 张参考图素材，画面已成功渲染发布！`
            : `卡片【${cardName}】画面已成功生成并实时更新挂载到画布卡片上！`
        };
      } catch (err) {
        handleUpdateCard(activeCard.id, {
          state: 'error',
          generationError: (err as Error).message,
        }, true);
        throw err;
      }
    }
    if (call.name === 'user.ask') {
      const question = String(call.arguments.question || '需要您的确认或输入：');
      task.negotiationLog.push({ role: 'agent', content: question, timestamp: Date.now() });
      return new Promise<string>((resolve) => {
        setAgentQuestion({
          question,
          resolve: (answer: string) => {
            const finalAnswer = answer || '（用户未回答）';
            task.negotiationLog.push({ role: 'user', content: finalAnswer, timestamp: Date.now() });
            task.lastUserInputAt = Date.now();
            setAgentQuestion(null);
            resolve(finalAnswer);
          }
        });
      });
    }
    throw new Error(`未注册工具：${call.name}`);
  }, [animateMouseAction, applyPageCommand, inspectPage]);



  const extractCardImageBase64 = useCallback(async (card: CardData): Promise<string | undefined> => {
    const compressImageToJpegBase64 = async (source: Blob | string): Promise<string | undefined> => {
      try {
        const url = typeof source === 'string' ? source : URL.createObjectURL(source);
        const res = await new Promise<string | undefined>((resolve) => {
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.referrerPolicy = 'no-referrer';
          img.onload = () => {
            try {
              const maxEdge = 1024;
              let width = img.naturalWidth || img.width || 1024;
              let height = img.naturalHeight || img.height || 1024;
              if (width > maxEdge || height > maxEdge) {
                if (width >= height) {
                  height = Math.round((height * maxEdge) / width);
                  width = maxEdge;
                } else {
                  width = Math.round((width * maxEdge) / height);
                  height = maxEdge;
                }
              }
              const canvas = document.createElement('canvas');
              canvas.width = width;
              canvas.height = height;
              const ctx = canvas.getContext('2d');
              if (ctx) {
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.82));
                return;
              }
            } catch {}
            resolve(undefined);
          };
          img.onerror = () => resolve(undefined);
          img.src = url;
        });
        if (typeof source !== 'string') URL.revokeObjectURL(url);
        return res;
      } catch {
        return undefined;
      }
    };

    const convertBlobToBase64 = async (blob: Blob): Promise<string | undefined> => {
      const compressed = await compressImageToJpegBase64(blob);
      if (compressed) return compressed;
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    };

    const convertUrlToBase64 = async (url: string): Promise<string | undefined> => {
      if (!url) return undefined;
      if (url.startsWith('data:image/')) {
        return (await compressImageToJpegBase64(url)) || url;
      }

      // 1. Try direct fetch
      try {
        const resp = await fetch(url);
        if (resp.ok) {
          const blob = await resp.blob();
          if (blob && blob.size > 0) {
            return await convertBlobToBase64(blob);
          }
        }
      } catch {}

      // 2. If remote URL, try proxy fetch to bypass CORS
      if (/^https?:\/\//i.test(url) && !url.includes('/api/mcp/workrally/proxy-media')) {
        try {
          const activeToken = getActiveMcpTokenSync();
          const taskId = card.mcpTaskId || url.match(/(2k[a-z0-9]{6,16})/i)?.[1] || url.match(/\/(2k[a-z0-9]+)_MAIN_/i)?.[1] || '';
          const proxyUrl = `/api/mcp/workrally/proxy-media?url=${encodeURIComponent(url)}${taskId ? `&taskId=${encodeURIComponent(taskId)}` : ''}${activeToken ? `&token=${encodeURIComponent(activeToken)}` : ''}`;
          const proxyResp = await fetch(proxyUrl);
          if (proxyResp.ok) {
            const blob = await proxyResp.blob();
            if (blob && blob.size > 0) {
              return await convertBlobToBase64(blob);
            }
          }
        } catch {}
      }

      // 3. Fallback: draw using HTMLImageElement onto offscreen canvas
      return await compressImageToJpegBase64(url);
    };

    // 1. Check raw binary data on the card's OWN image (Rule 3: trueOriginalFileData > originalFileData > fileData)
    const directBlobs = [
      card.trueOriginalFileData,
      card.originalFileData,
      card.fileData,
    ];
    for (const b of directBlobs) {
      if (b instanceof Blob && b.size > 0) {
        try {
          const res = await convertBlobToBase64(b);
          if (res) return res;
        } catch {}
      }
    }

    // 2. Check direct card own image URLs (trueOriginalImageUrl > originalImageUrl > imageUrl > thumbnailUrl)
    const candidateUrls = [
      card.trueOriginalImageUrl,
      card.originalImageUrl,
      card.imageUrl,
      card.thumbnailUrl,
    ].filter((u): u is string => typeof u === 'string' && u.trim().length > 0);

    for (const url of candidateUrls) {
      const res = await convertUrlToBase64(url);
      if (res) return res;
    }

    // 3. Check global thumbnail cache for card's own image
    const cachedThumb = thumbCache.get(card.id) || (card.imageUrl ? thumbCache.get(card.imageUrl) : undefined);
    if (cachedThumb && cachedThumb.startsWith('data:image/')) {
      return cachedThumb;
    }

    return undefined;
  }, []);
  extractCardImageBase64Ref.current = extractCardImageBase64;

  const formatCardContextInfo = useCallback((card: CardData, hasImage: boolean): string => {
    const cardType = card.isVideo ? '视频生成卡片' : (card.isAsset ? '素材/参考卡片' : '生图卡片');
    const prompt = card.prompt || card.lastGeneratedPrompt || '';
    const refCount = card.referenceImages?.length || 0;
    
    const lines: string[] = [
      `【当前右键聚焦的目标卡片信息】`,
      `- 卡片ID: ${card.id}`,
      `- 标题/分集: ${card.fileName || '未命名卡片'}`,
      `- 卡片类型: ${cardType}`,
      `- 提示词 (Prompt): ${prompt ? `"${prompt}"` : '(空)'}`,
      `- 画幅比例: ${card.ratio || '默认'}`,
      `- 分辨率: ${card.res || '2K'}`,
    ];

    if (card.lastGeneratedPrompt && card.lastGeneratedPrompt !== prompt) {
      lines.push(`- 历史生成提示词: "${card.lastGeneratedPrompt}"`);
    }

    if (card.mcpModel) {
      lines.push(`- 关联模型: ${card.mcpModel}`);
    }

    if (refCount > 0) {
      lines.push(`- 关联参考图: ${refCount} 张`);
    }

    if (hasImage) {
      lines.push(`- 卡片图像: [已注入卡片图像至多模态上下文供观察]`);
    }

    return lines.join('\n');
  }, []);

  const handleRunAgent = async (
    overrideMessage?: string,
    overrideImages?: string[],
    cardContext?: Record<string, any>
  ) => {
    const rawMessage = overrideMessage !== undefined ? overrideMessage : agentPrompt;
    if (!rawMessage.trim()) return;
    if (isAgentRunning || isAgentThinking) return;
    const userMessage = rawMessage.trim();
    if (overrideMessage === undefined) {
      setAgentPrompt('');
    }
    isAgentRunningRef.current = true;
    setIsAgentThinking(true);
    setIsAgentRunning(true);

    // If cardContext not provided but user has a single selected card, auto-enrich context with lineage
    let effectiveCardContext = cardContext;
    let effectiveImages = overrideImages;

    if (!effectiveCardContext && selectedCardIdsRef.current.length === 1) {
      const selectedId = selectedCardIdsRef.current[0];
      const allCards = cardsRef.current.length > 0 ? cardsRef.current : cards;
      const targetCard = allCards.find(c => c.id === selectedId);
      if (targetCard) {
        try {
          const autoCtx = await buildAutoInjectedCardContext(targetCard, allCards, extractCardImageBase64);
          effectiveCardContext = {
            ...autoCtx.structuredContext,
            markdownSummary: autoCtx.markdownSummary,
            images: autoCtx.images,
          };
          if (!effectiveImages || effectiveImages.length === 0) {
            effectiveImages = autoCtx.images;
          }
        } catch (e) {
          console.warn('Auto card context generation failed:', e);
        }
      }
    }

    try {
      const nodeModels = assetExtractionService.getNodeModels();
      const agentModel = nodeModels.agentModel;
      const isArkModel = agentModel.includes('doubao') || agentModel.includes('seed-2-1') || agentModel.includes('seed-2.1') || agentModel.includes('ark') || agentModel.includes('volces');
      const isDashscopeModel = agentModel.startsWith('qwen') || agentModel.includes('glm') || agentModel.includes('ZHIPU') || agentModel.includes('zhipu');
      const savedKey = isArkModel
        ? (localStorage.getItem('ark_api_key') || localStorage.getItem('volcengine_api_key') || localStorage.getItem('deepseek_api_key') || localStorage.getItem('qwen_api_key'))
        : isDashscopeModel
        ? (localStorage.getItem('qwen_api_key') || localStorage.getItem('glm_api_key') || localStorage.getItem('deepseek_api_key'))
        : localStorage.getItem('deepseek_api_key');

      const jsonAdapterModel = nodeModels.jsonAdapterModel || 'deepseek-v4-flash';
      const isArkAdapter = jsonAdapterModel.includes('doubao') || jsonAdapterModel.includes('seed-2-1') || jsonAdapterModel.includes('seed-2.1') || jsonAdapterModel.includes('ark') || jsonAdapterModel.includes('volces');
      const isDashscopeAdapter = jsonAdapterModel.startsWith('qwen') || jsonAdapterModel.includes('glm') || jsonAdapterModel.includes('ZHIPU') || jsonAdapterModel.includes('zhipu');
      const jsonAdapterKey = isArkAdapter
        ? (localStorage.getItem('ark_api_key') || localStorage.getItem('volcengine_api_key') || localStorage.getItem('deepseek_api_key') || localStorage.getItem('qwen_api_key'))
        : isDashscopeAdapter
        ? (localStorage.getItem('qwen_api_key') || localStorage.getItem('glm_api_key') || localStorage.getItem('deepseek_api_key'))
        : localStorage.getItem('deepseek_api_key');

      const toolConfig = getAgentToolConfig();
      const enabledTools = AGENT_TOOL_REGISTRY.filter((tool) => toolConfig[tool.id]).map((tool) => tool.id);

      let runtime = runtimeRef.current;
      let isNewTask = false;
      let taskId = activeTaskIdRef.current;

      const existingTask = runtime && taskId ? runtime.getTask(taskId) : undefined;
      if (!runtime || !taskId || !existingTask || ['cancelled', 'failed', 'completed'].includes(existingTask.status) || Boolean(cardContext)) {
        isNewTask = true;
        taskId = `task_${Date.now().toString(36)}`;
        activeTaskIdRef.current = taskId;
        runtime = new AgentRuntime({
          requestTurn: async (task: RuntimeTask, requireTool, signal) => {
            const turnId = `${task.id}:turn:${task.turn}`;
            const startedAt = Date.now();
            const latestUserMsg = task.negotiationLog?.filter(l => l.role === 'user').slice(-1)[0]?.content || userMessage;
            const requestBody = {
              userMessage: latestUserMsg,
              history: task.history,
              events: task.events,
              observations: task.observations,
              project: { id: currentProject.id, name: currentProject.name },
              task: { 
                id: task.id, 
                goal: task.goal, 
                title: task.title, 
                plan: task.plan, 
                progress: task.progress, 
                subGoal: task.subGoal, 
                notes: task.notes, 
                turn: task.turn, 
                pendingCallIds: task.pendingCallIds,
                negotiationLog: task.negotiationLog,
                lastGoalUpdatedAt: task.lastGoalUpdatedAt,
                lastUserInputAt: task.lastUserInputAt,
                cardContext: task.cardContext || effectiveCardContext,
              },
              images: task.images || overrideImages,
              cardContext: task.cardContext || effectiveCardContext,
              apiKey: savedKey, 
              modelType: agentModel, 
              enabledTools, 
              requireTool,
              jsonAdapterModel,
              jsonAdapterKey,
            };
            updateAgentRuntimeTrace(task, trace => ({
              ...trace,
              turns: [...trace.turns.filter(turn => turn.id !== turnId), {
                id: turnId,
                turn: task.turn,
                requireTool,
                startedAt,
                taskBefore: snapshotRuntimeTask(task),
              }],
            }));
            try {
              if (!isProcessingInspectQueueRef.current) {
                setAgentState(prev => ({ ...prev, speak: '...', visible: true }));
              }
              const res = await fetch('/api/agent/turn', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
                signal,
              });
              const body = await res.json().catch(() => ({}));
              if (!res.ok) throw new Error(body.error || 'Agent 轮次失败');
              const result = body as AgentTurnResult;

              // Immediately notify agentFocusManager with the validated tool calls from the JSON adapter node
              if (Array.isArray(result.toolCalls) && result.toolCalls.length > 0) {
                result.toolCalls.forEach(call => {
                  agentFocusManager.handleJsonNodeToolCall(call);
                });
              } else if (result.complete && !isProcessingInspectQueueRef.current) {
                agentFocusManager.clearAll(2500);
              }

              updateAgentRuntimeTrace(task, trace => ({
                ...trace,
                turns: trace.turns.map(turn => turn.id === turnId ? {
                  ...turn,
                  completedAt: Date.now(),
                  transport: result.debug,
                  parsedResult: result,
                } : turn),
              }));
              
              if (result.speak) {
                const parsedShort = parseAgentCommunication(result.speak).shortText || result.speak;
                setAgentState(prev => ({ ...prev, speak: parsedShort, visible: true }));
              }
              
              return result;
            } catch (error) {
              if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
                return { narration: [], toolCalls: [], complete: false };
              }
              const rawMsg = error instanceof Error ? error.message : 'Agent 轮次失败';
              const isBalanceError = /insufficient\s*balance|quota|402|out\s*of\s*credit|余额不足|欠费/i.test(rawMsg);
              const displayMsg = isBalanceError
                ? '⚠️ API Key 余额不足，请在设置中更新 Key'
                : rawMsg;

              setAgentState(prev => ({ ...prev, speak: displayMsg, visible: true }));

              updateAgentRuntimeTrace(task, trace => ({
                ...trace,
                turns: trace.turns.map(turn => turn.id === turnId ? { ...turn, completedAt: Date.now(), error: displayMsg } : turn),
              }));
              throw new Error(displayMsg);
            }
          },
          executeTool: async (call, task, signal) => {
            const output = await executeAgentTool(call, task, signal);
            if (signal?.aborted) return output;

            // 🛡️ Output-Driven Action Resolver (基于工具输出的动作解析器)
            // 契约：凡是依赖执行结果产出/实例化实体对象的工具（如 card.generate 产出具体的 cardId），
            // 一旦监测到工具产生有效输出，系统第一时间截获并解析 output.cardId，
            // 立即驱动 Agent 聚焦锁定并调度鼠标毫秒级飞赴新卡片执行下压手势！
            if (call.name === 'card.generate' && output && typeof output === 'object') {
              const outputCardId = (output as any).cardId;
              const outMsg = (output as any).message || `生图卡片【${outputCardId}】已成功创建并进入排队渲染。`;
              if (typeof outputCardId === 'string' && outputCardId) {
                agentFocusManager.setCursorMode('working');
                agentFocusManager.setPrimaryFocus(outputCardId, 'working', 'card.generate');
                await animateMoveToTarget('canvas.card.' + outputCardId);
                setAgentState(prev => ({ ...prev, isActive: true }));
                await sleep(180);
                setAgentState(prev => ({ ...prev, isActive: false }));
              }

              // 🚀 Optimization 1: 乐观即时状态汇报 (Optimistic Instant Feedback)
              // 无需等待第二轮大模型漫长的 4 秒推理，在工具返回的第 0 毫秒立即将进展注入事件流与 HUD
              if (runtimeRef.current) {
                runtimeRef.current.addFeedback(task.id, outMsg, 'answer');
              }
              const shortText = parseAgentCommunication(outMsg).shortText || `卡片【${outputCardId}】已启动排队渲染...`;
              setAgentState(prev => ({
                ...prev,
                speak: shortText,
                visible: true,
              }));
            }

            return output;
          },
          requireVisibleInteraction: false,
          isParallelSafe: (call) => {
            if (call.name === 'guide.lookup') return true;
            if (call.name === 'page.inspect') {
              const scope = typeof call.arguments?.scope === 'string' ? call.arguments.scope : 'overview';
              return !scope || scope === 'overview';
            }
            return false;
          },
          updateStateNode: async (task, lastTurnResult, signal) => {
            if (signal?.aborted) return;
            const targetTurnId = `${task.id}:turn:${task.turn}`;
            let debugPromptText = '';
            let responseData: any = null;

            try {
              const agentModel = assetExtractionService.getNodeModels().agentModel;
              const isArkModel = agentModel.includes('doubao') || agentModel.includes('seed-2-1') || agentModel.includes('seed-2.1') || agentModel.includes('ark') || agentModel.includes('volces');
              const isDashscopeModel = agentModel.startsWith('qwen') || agentModel.includes('glm') || agentModel.includes('ZHIPU') || agentModel.includes('zhipu');
              const savedKey = isArkModel
                ? (localStorage.getItem('ark_api_key') || localStorage.getItem('volcengine_api_key') || localStorage.getItem('deepseek_api_key') || localStorage.getItem('qwen_api_key') || '')
                : isDashscopeModel
                ? (localStorage.getItem('qwen_api_key') || localStorage.getItem('glm_api_key') || localStorage.getItem('deepseek_api_key') || '')
                : (localStorage.getItem('deepseek_api_key') || '');

              const lastUserMessage = task.negotiationLog?.[task.negotiationLog.length - 1]?.content || task.goal;
              const res = await fetch('/api/agent/update-state-node', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  currentTask: {
                    title: task.title,
                    goal: task.goal,
                    subGoal: task.subGoal,
                    progress: task.progress,
                    plan: task.plan,
                    notes: task.notes,
                  },
                  userMessage: lastUserMessage,
                  lastTurnOutput: {
                    narration: lastTurnResult.narration,
                    speak: lastTurnResult.speak,
                    toolCalls: lastTurnResult.toolCalls,
                  },
                  apiKey: savedKey,
                  model: agentModel,
                }),
                signal,
              });

              responseData = await res.json().catch((e) => ({ error: '无法解析 JSON 响应', details: String(e) }));
              if (responseData && responseData.debugPrompt) {
                debugPromptText = responseData.debugPrompt;
              }

              if (res.ok && responseData && !responseData.error) {
                if (responseData.taskTitle) task.title = responseData.taskTitle;
                if (responseData.goal) task.goal = responseData.goal;
                if (responseData.subGoal) task.subGoal = responseData.subGoal;
                if (responseData.progress) task.progress = responseData.progress;
                if (Array.isArray(responseData.plan)) task.plan = responseData.plan;
                if (typeof responseData.notes === 'string' && responseData.notes.trim()) {
                  if (responseData.notesMode === 'overwrite') {
                    task.notes = responseData.notes.trim();
                  } else {
                    const cleanNote = responseData.notes.trim().replace(/^- \s*/, '');
                    task.notes = task.notes ? `${task.notes}\n- ${cleanNote}` : `- ${cleanNote}`;
                  }
                }
                task.lastGoalUpdatedAt = Date.now();
              }
            } catch (e) {
              console.warn('Dedicated state node update execution error:', e);
              responseData = { error: '请求发起异常', details: String(e) };
            } finally {
              const { debugPrompt: _p, ...cleanOutput } = responseData || {};
              updateAgentRuntimeTrace(task, (trace) => {
                const turns = trace.turns.map(turn => {
                  if (turn.id === targetTurnId || turn.turn === task.turn) {
                    return {
                      ...turn,
                      stateNodeTrace: {
                        prompt: debugPromptText || '状态提取节点已触发运行',
                        response: cleanOutput,
                      },
                    };
                  }
                  return turn;
                });
                return { ...trace, turns };
              });
            }
          },
          onTaskChange: (task) => {
            updateAgentRuntimeTrace(task);
            const status = task.status;
            setAgentTask({
              id: task.id,
              title: task.title,
              status,
              cardContext: task.cardContext,
              events: task.events.slice(-16).map(event => ({
                id: event.id,
                text: event.type === 'answer' ? parseAgentCommunication(event.text || '').fullText : event.text,
                kind: event.type === 'tool' ? 'tool' : event.type === 'answer' ? 'answer' : 'work',
              })),
            });

            // Live speech synchronization for Agent Pointer HUD
            // Only update speech if not currently protected by active card inspection queue
            if (!isProcessingInspectQueueRef.current) {
              const latestAnswer = [...task.events].reverse().find(e => e.type === 'answer' && e.text && e.text.trim());
              if (latestAnswer) {
                const shortSpeech = parseAgentCommunication(latestAnswer.text).shortText;
                if (shortSpeech) {
                  if (agentSpeakTimerRef.current) clearTimeout(agentSpeakTimerRef.current);
                  setAgentState(prev => ({
                    ...prev,
                    speak: shortSpeech,
                    visible: true,
                  }));
                }
              }
            }

            if (status === 'completed' || status === 'cancelled' || status === 'failed') {
              if (agentSpeakTimerRef.current) clearTimeout(agentSpeakTimerRef.current);
              if (!isProcessingInspectQueueRef.current) {
                agentFocusManager.clearAll();
              }
            }

            // If task is bound to a specific card context, sync answer events to that card's chat history
            const cardId = task.cardContext?.cardId || task.cardContext?.targetId;
            if (cardId) {
              const answers = task.events.filter(e => e.type === 'answer' && e.text && e.text.trim() && !e.text.includes('生好了，我先看下'));
              if (answers.length > 0) {
                setCards(prevCards => prevCards.map(c => {
                  if (c.id !== cardId) return c;
                  const currentHistory = (c.chatHistory || []).filter(m => !m.text.includes('生好了，我先看下'));
                  const newAnswers = answers.filter(a => !currentHistory.some(m => m.id === a.id));
                  if (newAnswers.length === 0) return c;
                  return {
                    ...c,
                    chatHistory: [
                      ...currentHistory,
                      ...newAnswers.map(a => {
                        const parsed = parseAgentCommunication(a.text);
                        return {
                          id: a.id,
                          role: 'assistant' as const,
                          text: parsed.fullText,
                          shortText: parsed.shortText,
                          timestamp: a.createdAt || Date.now(),
                        };
                      })
                    ]
                  };
                }));
              }
            }
          },
        });
        runtimeRef.current = runtime;
      }

      let task: RuntimeTask;
      if (isNewTask) {
        task = runtime.createTask({
          id: taskId!,
          sessionId: currentProject.id,
          goal: userMessage,
          images: overrideImages,
          cardContext: effectiveCardContext,
        });
        updateAgentRuntimeTrace(task);
        // Auto inspect if enabled
        if (localStorage.getItem('auto_inspect_on_launch') !== 'false') {
          try {
            const initObservation = await inspectPage({ scope: 'overview' });
            observedTargetsByTaskRef.current.set(task.id, new Set(initObservation.components.map(component => component.id)));
            
            task.observations.push({
              role: 'tool',
              content: {
                name: 'page.inspect',
                status: 'succeeded',
                output: initObservation
              }
            });
            
            task.events.push({
              id: `auto_${Date.now()}`,
              taskId: task.id,
              turnId: `${task.id}:turn:0`,
              type: 'tool',
              toolName: 'page.inspect',
              text: '首轮自动执行 page.inspect (overview) 获取最新状态',
              status: 'succeeded',
              output: initObservation,
              createdAt: Date.now()
            });
          } catch (e) {
            console.error("Auto inspect failed", e);
          }
        }
      } else {
        runtime.addUserInput(taskId!, userMessage, overrideImages, effectiveCardContext);
        task = runtime.requireTask(taskId!);
      }

      await runtime.wake(taskId!);
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      setAgentTask(previous => previous ? {
        ...previous,
        status: 'failed',
        events: [...previous.events, { id: `${Date.now()}_${Math.random()}`, text: err.message || 'Agent 执行失败', kind: 'answer' }].slice(-16),
      } : previous);
    } finally {
      setIsAgentThinking(false);
      setIsAgentRunning(false);
      isAgentRunningRef.current = false;
      // 🌟 本轮卡片分发与创建完毕，平滑启动出图检视队列，按序消费出图卡片！
      setTimeout(() => {
        void processInspectQueueRef.current();
      }, 150);
    }
  };

  const handleCardAgentChat = useCallback(async (targetCardId: string, promptText: string) => {
    const allCards = cardsRef.current.length > 0 ? cardsRef.current : cards;
    const targetCard = allCards.find(c => c.id === targetCardId) || cards.find(c => c.id === targetCardId);
    if (!targetCard) {
      await handleRunAgent(promptText);
      return;
    }

    // Immediately record the user message in the target card's chatHistory
    const userMsgId = `msg_user_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setCards(prev => prev.map(c => {
      if (c.id !== targetCardId) return c;
      const history = c.chatHistory || [];
      return {
        ...c,
        chatHistory: [
          ...history,
          {
            id: userMsgId,
            role: 'user',
            text: promptText,
            timestamp: Date.now(),
          }
        ]
      };
    }));

    try {
      const autoCtx = await buildAutoInjectedCardContext(targetCard, allCards, extractCardImageBase64);

      await handleRunAgent(
        promptText,
        autoCtx.images.length > 0 ? autoCtx.images : undefined,
        {
          ...autoCtx.structuredContext,
          markdownSummary: autoCtx.markdownSummary,
          images: autoCtx.images,
        }
      );
    } catch (err) {
      console.warn('buildAutoInjectedCardContext failed, fallback to direct info:', err);
      const imageBase64 = await extractCardImageBase64(targetCard);
      const cardInfo = formatCardContextInfo(targetCard, !!imageBase64);

      await handleRunAgent(promptText, imageBase64 ? [imageBase64] : undefined, {
        cardId: targetCard.id,
        title: targetCard.fileName || '未命名卡片',
        prompt: targetCard.prompt,
        aspectRatio: targetCard.ratio,
        resolution: targetCard.res,
        imageUrl: imageBase64,
        markdownSummary: cardInfo,
      });
    }
  }, [cards, extractCardImageBase64, formatCardContextInfo]);

  const handlePauseTask = () => {
    if (!runtimeRef.current || !activeTaskIdRef.current) return;
    runtimeRef.current.pause(activeTaskIdRef.current);
    setIsAgentRunning(false);
    setIsAgentThinking(false);
  };

  const handleResumeTask = async () => {
    if (!runtimeRef.current || !activeTaskIdRef.current) return;
    isAgentRunningRef.current = true;
    setIsAgentRunning(true);
    try {
      await runtimeRef.current.resume(activeTaskIdRef.current);
    } catch (err: any) {
      console.error('Resume failed:', err);
    } finally {
      setIsAgentRunning(false);
      isAgentRunningRef.current = false;
      setIsAgentThinking(false);
      setTimeout(() => {
        void processInspectQueueRef.current();
      }, 150);
    }
  };

  const handleCancelTask = () => {
    inspectQueueRef.current = [];
    agentFocusManager.clearAll();
    if (!runtimeRef.current || !activeTaskIdRef.current) return;
    runtimeRef.current.cancel(activeTaskIdRef.current);
    setIsAgentRunning(false);
    setIsAgentThinking(false);
    setAgentState(prev => ({ ...prev, isMoving: false, isActive: false, visible: false }));
  };

  const handleSendTaskChat = async () => {
    const msg = taskChatMessage.trim();
    if (!msg) return;
    setTaskChatMessage('');
    setIsTaskChatOpen(false);
    await handleRunAgent(msg);
  };

  // Close user context menu on any pointer down
  useEffect(() => {
    const closeMenu = (e: PointerEvent) => {
      const clickerId = e.isTrusted ? 'user' : 'agent';
      setContextMenus(prev => {
        if (prev[clickerId]) {
          const next = { ...prev };
          delete next[clickerId];
          return next;
        }
        return prev;
      });
      if (clickerId === 'user') {
        setAgentState(prev => {
          // 🛡️ Intelligent state lock: If the agent's quick input overlay is open, DO NOT dismiss its speaking bubbles on click-away!
          if (agentQuickInput?.isOpen) {
            return prev;
          }
          if (isSelectionPromptSpeak(prev.speak)) {
            return { ...prev, speak: undefined };
          }
          return prev;
        });
      }
    };
    document.addEventListener('pointerdown', closeMenu);
    return () => document.removeEventListener('pointerdown', closeMenu);
  }, [agentQuickInput]);

  const isDraggingCanvasRef = useRef(false);

  // Intent-driven lazy restoration logic
  const restoreCanvasStyles = useCallback(() => {
    // If the user is actively dragging the canvas, strictly forbid restoration
    if (isDraggingCanvasRef.current) return;
    
    (window as any).isDraggingCard = false;

    // Resume playing videos that were paused during gesture
    try {
      const allVideosToResume = document.querySelectorAll('video[data-was-playing="true"]');
      allVideosToResume.forEach(v => {
        v.removeAttribute('data-was-playing');
        (v as HTMLVideoElement).play().catch(() => {});
      });
    } catch (err) {
      console.warn('Failed to resume background videos:', err);
    }

    // Cleanup Direct DOM Performance Classes
    try {
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
    } catch (err) {
      console.warn('Failed to cleanup performance classes:', err);
    }
    
    // Garbage Collection / Mount Trigger: Update circular culling bounds
    updateCircularCulling(true);
    
    // Restore accurate LOD states now that the user has stopped zooming or dragging
    const currentScale = tScale.get();
    const threshold = getNanoLodThreshold();
    setIsMicroLod(currentScale < threshold);
    setIsNanoLod(currentScale < threshold);
    setMountEpoch(n => (n + 1) % 1000000);
    
    const workspace = document.getElementById('canvas-workspace');
    if (workspace) {
      workspace.removeAttribute('data-zooming');
      workspace.removeAttribute('data-panning');
      workspace.removeAttribute('data-gesture');
      isZoomingRef.current = false;
      setIsZooming(false); // MUST sync React state so it doesn't revert on next render
      window.dispatchEvent(new CustomEvent('canvas-styles-restored'));
    }
  }, [updateCircularCulling, tScale]);

  useEffect(() => {
    (window as any).resetGlobalZoomTimer = () => {
      clearTimeout(zoomTimeoutRef.current);
      // Idle Fallback: 300ms idle delay before restoring styles/textures
      const idleDelay = 300;
      zoomTimeoutRef.current = setTimeout(restoreCanvasStyles, idleDelay);
    };
    return () => { delete (window as any).resetGlobalZoomTimer; };
  }, [restoreCanvasStyles]);

  const resetOverviewPrompt = useCallback(() => {
    wheelZoomOutAccumulatorRef.current = 0;
    if (overviewToastTimerRef.current) {
      clearTimeout(overviewToastTimerRef.current);
      overviewToastTimerRef.current = null;
    }
    setShowOverviewPromptToast(false);
    setOverviewPromptProgress(0);
  }, []);
  resetOverviewPromptRef.current = resetOverviewPrompt;

  const enterOverviewMode = useCallback(() => {
    resetOverviewPrompt();
    if (isOverviewModeRef.current) return;

    triggerTweenZoom(400);

    // Save current transform state to revert if needed
    if (!preOverviewTransform.current) {
      preOverviewTransform.current = {
        x: lastStableTransformRef.current.x,
        y: lastStableTransformRef.current.y,
        scale: lastStableTransformRef.current.scale
      };
    }

    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    
    // Record original viewport box in world space at the moment overview is triggered
    const origTransform = preOverviewTransform.current || targetTransform.current;
    const originWorldX = (0 - origTransform.x) / origTransform.scale;
    const originWorldY = (0 - origTransform.y) / origTransform.scale;
    const originWorldW = rect.width / origTransform.scale;
    const originWorldH = rect.height / origTransform.scale;
    setOverviewViewportBox({
      x: originWorldX,
      y: originWorldY,
      width: originWorldW,
      height: originWorldH
    });
    
    // Calculate world bounding box including bottom panels
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    if (cardsRef.current.length === 0) {
       minX = -1000; minY = -1000; maxX = 1000; maxY = 1000;
    } else {
       cardsRef.current.forEach(c => {
         const dim = getCardSize(c);
         const isGenerationCard = !c.fileName && !c.isAsset;
         const panelH = isGenerationCard ? getBottomPanelHeight(c.prompt, c.referenceImages?.length) + 12 : 0;
         const panelW = 480;
         const effectiveLeft = Math.min(c.x, isGenerationCard ? c.x + (dim.width - panelW) / 2 : c.x);
         const effectiveRight = Math.max(c.x + dim.width, isGenerationCard ? c.x + (dim.width + panelW) / 2 : c.x + dim.width);

         if (effectiveLeft < minX) minX = effectiveLeft;
         if (c.y < minY) minY = c.y;
         if (effectiveRight > maxX) maxX = effectiveRight;
         if (c.y + dim.height + panelH > maxY) maxY = c.y + dim.height + panelH;
       });
    }
    
    // Add padding
    const padding = 1500;
    minX -= padding;
    minY -= padding;
    maxX += padding;
    maxY += padding;
    
    const worldW = maxX - minX;
    const worldH = maxY - minY;
    
    // Calculate scale to fit screen
    const targetScale = Math.min(rect.width / worldW, rect.height / worldH);
    
    // Calculate tx and ty to center the bounding box
    const targetTx = (rect.width / 2) - ((minX + maxX) / 2) * targetScale;
    const targetTy = (rect.height / 2) - ((minY + maxY) / 2) * targetScale;
    
    targetTransform.current = { x: targetTx, y: targetTy, scale: targetScale };
    
    // Prepare LOD transition
    const workspace = document.getElementById('canvas-workspace');
    if (workspace && workspace.getAttribute('data-zooming') !== 'true') {
      workspace.setAttribute('data-zooming', 'true');
      workspace.setAttribute('data-gesture', 'true');
      isZoomingRef.current = true;
      setIsZooming(true);
    }
    clearTimeout(zoomTimeoutRef.current);
    zoomTimeoutRef.current = setTimeout(restoreCanvasStyles, 400);
    
    const animConfig: any = { type: 'tween', duration: 0.4, ease: [0.16, 1, 0.3, 1] };
    animate(tScale, targetScale, animConfig);
    animate(tx, targetTx, animConfig);
    animate(ty, targetTy, animConfig);

    setIsDomCardsActive(false);
    setIsNanoCanvasActive(true);
    setIsOverviewMode(true);
    isOverviewModeRef.current = true;
    overviewBoxScaleRef.current = 1.0;

    // Immediately calculate and display the blue viewport box at current mouse position
    updateOverviewCursorBoxAt(
      lastMouseClientPosRef.current.clientX,
      lastMouseClientPosRef.current.clientY,
      targetTx,
      targetTy,
      targetScale
    );
  }, [tScale, tx, ty, restoreCanvasStyles, resetOverviewPrompt, updateOverviewCursorBoxAt]);

  const exitOverviewToOriginal = useCallback(() => {
    resetOverviewPrompt();
    overviewBoxScaleRef.current = 1.0;
    setOverviewCursorBox(null);
    if (preOverviewTransform.current) {
      triggerTweenZoom(400);
      
      const workspace = document.getElementById('canvas-workspace');
      if (workspace && workspace.getAttribute('data-zooming') !== 'true') {
        workspace.setAttribute('data-zooming', 'true');
        workspace.setAttribute('data-gesture', 'true');
        isZoomingRef.current = true;
        setIsZooming(true);
      }

      const { x, y, scale } = preOverviewTransform.current;
      targetTransform.current = { x, y, scale };
      
      const animConfig: any = { type: 'tween', duration: 0.4, ease: [0.16, 1, 0.3, 1] };
      animate(tScale, scale, animConfig);
      animate(tx, x, animConfig);
      animate(ty, y, animConfig);
      
      clearTimeout(zoomTimeoutRef.current);
      zoomTimeoutRef.current = setTimeout(restoreCanvasStyles, 400);
      
      preOverviewTransform.current = null;
    }
    setIsOverviewMode(false);
    isOverviewModeRef.current = false;
  }, [tScale, tx, ty, restoreCanvasStyles, resetOverviewPrompt, triggerTweenZoom]);

  enterOverviewModeRef.current = enterOverviewMode;
  exitOverviewToOriginalRef.current = exitOverviewToOriginal;

  const animateZoomTo = useCallback((newScale: number) => {
    resetOverviewPrompt();
    preOverviewTransform.current = null;
    setIsOverviewMode(false);
    isOverviewModeRef.current = false;

    const prevScale = tScale.get();
    if (Math.abs(prevScale - newScale) < 0.001) return;
    
    // 1. Degrade styles during active animation to keep frames buttery smooth (Intent-Driven Lazy Restoration)
    const workspace = document.getElementById('canvas-workspace');
    if (workspace && workspace.getAttribute('data-zooming') !== 'true') {
      workspace.setAttribute('data-zooming', 'true');
      workspace.setAttribute('data-gesture', 'true');
      isZoomingRef.current = true;
      setIsZooming(true);
    }
    
    // 2. Clear previous restoration timers
    clearTimeout(zoomTimeoutRef.current);
    
    // 3. Set restoration timer after tween animation finishes
    zoomTimeoutRef.current = setTimeout(restoreCanvasStyles, 400);

    // 4. Calculate coordinate transition zooming toward center of screen
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const scaleRatio = newScale / prevScale;
    
    const newX = centerX - (centerX - tx.get()) * scaleRatio;
    const newY = centerY - (centerY - ty.get()) * scaleRatio;
    
    targetTransform.current = { x: newX, y: newY, scale: newScale };
    
    animate(tScale, newScale, { type: 'tween', duration: 0.22, ease: 'easeOut' });
    animate(tx, newX, { type: 'tween', duration: 0.22, ease: 'easeOut' });
    animate(ty, newY, { type: 'tween', duration: 0.22, ease: 'easeOut' });
  }, [tScale, tx, ty, restoreCanvasStyles, resetOverviewPrompt]);

  const handleZoomIn = useCallback(() => {
    resetOverviewPrompt();
    preOverviewTransform.current = null;
    setIsOverviewMode(false);
    isOverviewModeRef.current = false;
    const prevScale = tScale.get();
    const newScale = Math.min(prevScale * 1.2, 5);
    animateZoomTo(newScale);
  }, [tScale, animateZoomTo, resetOverviewPrompt]);

  const handleZoomOut = useCallback(() => {
    const prevScale = tScale.get();
    if (prevScale <= 0.105) {
      wheelZoomOutAccumulatorRef.current += 1;
      const progress = Math.min(1, wheelZoomOutAccumulatorRef.current / 8);
      setOverviewPromptProgress(progress);
      setShowOverviewPromptToast(true);

      if (overviewToastTimerRef.current) {
        clearTimeout(overviewToastTimerRef.current);
      }
      overviewToastTimerRef.current = setTimeout(() => {
        resetOverviewPrompt();
      }, 1800);

      if (wheelZoomOutAccumulatorRef.current >= 8) {
        resetOverviewPrompt();
        enterOverviewMode();
      }
      return;
    }
    const newScale = Math.max(prevScale / 1.2, 0.1);
    animateZoomTo(newScale);
  }, [tScale, animateZoomTo, enterOverviewMode, resetOverviewPrompt]);

  const handleZoomReset = useCallback(() => {
    preOverviewTransform.current = null;
    setIsOverviewMode(false);
    isOverviewModeRef.current = false;
    animateZoomTo(1);
  }, [animateZoomTo]);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    // 1. Ignore double-clicks on interactive elements (inputs, textareas, buttons, modal dialogs, etc.)
    const target = e.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('input, textarea, select, button, [contenteditable="true"], [role="button"], [role="dialog"], aside, [data-prevent-canvas-wheel]')) {
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    // Prevent default selection side-effects
    e.preventDefault();
    window.getSelection()?.removeAllRanges();

    clearTimeout(doubleClickTimeoutRef.current);

    const rect = container.getBoundingClientRect();
    const cursorX = e.clientX - rect.left;
    const cursorY = e.clientY - rect.top;

    // Calculate clicked world position
    const currentScale = tScale.get();
    const currentTx = tx.get();
    const currentTy = ty.get();
    const worldX = (cursorX - currentTx) / currentScale;
    const worldY = (cursorY - currentTy) / currentScale;

    // Intent-Driven Lazy Restoration: degrade heavy effects during rapid tween
    const workspace = document.getElementById('canvas-workspace');
    if (workspace && workspace.getAttribute('data-zooming') !== 'true') {
      workspace.setAttribute('data-zooming', 'true');
      workspace.setAttribute('data-gesture', 'true');
      isZoomingRef.current = true;
      setIsZooming(true);
    }

    // Direct Double Click Zoom Toggle:
    // 1. If zoomed in past 100% (scale > 1.001), zoom directly back to 100% (1.0) anchored at the mouse cursor
    // 2. If at normal zoom (0.20 <= scale <= 1.001), zoom directly out to 10% (0.1) anchored at the mouse cursor
    // 3. If zoomed out (scale < 0.20), zoom directly into 100% (1.0) anchored at the mouse cursor
    if (currentScale > 1.001) {
      const targetScale = 1.0;
      const targetTx = cursorX - worldX * targetScale;
      const targetTy = cursorY - worldY * targetScale;

      targetTransform.current = { x: targetTx, y: targetTy, scale: targetScale };

      clearTimeout(zoomTimeoutRef.current);
      zoomTimeoutRef.current = setTimeout(restoreCanvasStyles, 360);

      animate(tScale, targetScale, { type: 'tween', duration: 0.36, ease: [0.16, 1, 0.3, 1] });
      animate(tx, targetTx, { type: 'tween', duration: 0.36, ease: [0.16, 1, 0.3, 1] });
      animate(ty, targetTy, { type: 'tween', duration: 0.36, ease: [0.16, 1, 0.3, 1] });
    } else if (currentScale >= 0.20) {
      const targetScale = 0.1;
      const targetTx = cursorX - worldX * targetScale;
      const targetTy = cursorY - worldY * targetScale;

      targetTransform.current = { x: targetTx, y: targetTy, scale: targetScale };

      clearTimeout(zoomTimeoutRef.current);
      zoomTimeoutRef.current = setTimeout(restoreCanvasStyles, 400);

      animate(tScale, targetScale, { type: 'tween', duration: 0.40, ease: [0.16, 1, 0.3, 1] });
      animate(tx, targetTx, { type: 'tween', duration: 0.40, ease: [0.16, 1, 0.3, 1] });
      animate(ty, targetTy, { type: 'tween', duration: 0.40, ease: [0.16, 1, 0.3, 1] });
    } else {
      // Zoom directly into 100% anchored at the exact mouse cursor position
      const targetScale = 1.0;
      const targetTx = cursorX - worldX * targetScale;
      const targetTy = cursorY - worldY * targetScale;

      targetTransform.current = { x: targetTx, y: targetTy, scale: targetScale };

      clearTimeout(zoomTimeoutRef.current);
      zoomTimeoutRef.current = setTimeout(restoreCanvasStyles, 360);

      // Set state to defer mounting until zoom animation completes
      isZoomAnimationActiveRef.current = true;
      setIsZoomAnimationActive(true);

      animate(tScale, targetScale, { 
        type: 'tween', 
        duration: 0.36, 
        ease: [0.16, 1, 0.3, 1],
        onComplete: () => {
          isZoomAnimationActiveRef.current = false;
          setIsZoomAnimationActive(false);
          setMountEpoch(n => (n + 1) % 1000000);
        }
      });
      animate(tx, targetTx, { type: 'tween', duration: 0.36, ease: [0.16, 1, 0.3, 1] });
      animate(ty, targetTy, { type: 'tween', duration: 0.36, ease: [0.16, 1, 0.3, 1] });
    }
  }, [tScale, tx, ty, restoreCanvasStyles]);

    useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      // If settings page is currently open, never zoom canvas and let settings page scroll naturally
      if (showSettingsRef.current) {
        return;
      }

      // If wheel event originated from an overlay (drawer, modal, dropdown, scrollable area, editor), don't zoom canvas
      // For inputs/textareas, only prevent zoom if they are actively focused.
      const target = e.target as HTMLElement | null;
      if (target) {
        const closestInput = target.closest('textarea, input, select') as HTMLElement | null;
        const isFocusedInput = closestInput && document.activeElement === closestInput;
        
        const isInsideOverlay = target.closest(
          '[data-prevent-canvas-wheel], [data-modal], aside, .overflow-y-auto, .overflow-x-auto, .overflow-auto, [role="dialog"]'
        );

        if (isFocusedInput || isInsideOverlay) {
          return;
        }
      }

      e.preventDefault();
      clearTimeout(doubleClickTimeoutRef.current);
      
      // Per user request: Mouse wheel directly zooms the canvas (no Ctrl required).
      // If deltaY is 0 (e.g. pure horizontal trackpad swipe), we ignore it since zoom relies on vertical scroll axis.
      if (e.deltaY === 0) return;

      // If currently in overview mode:
      if (isOverviewModeRef.current) {
        // In overview mode, mouse wheel scales the blue box, with direction opposite of normal canvas zoom
        const isDiscrete = Math.abs(e.deltaY) >= 20;
        const sensitivity = isDiscrete ? 0.0018 : 0.001;
        const delta = e.deltaY * sensitivity;
        overviewBoxScaleRef.current = Math.min(Math.max(0.15, overviewBoxScaleRef.current * Math.exp(delta)), 8.0);
        updateOverviewCursorBoxAt(e.clientX, e.clientY);
        return;
      }

      const prevTarget = targetTransform.current;

      // Special breakout to Overview Mode when already at 10% min zoom and continuing to scroll out:
      if (prevTarget.scale <= 0.105 && e.deltaY > 0) {
        const isDiscreteWheel = Math.abs(e.deltaY) >= 20;
        const step = isDiscreteWheel ? 1 : Math.max(e.deltaY / 100, 0.25);
        wheelZoomOutAccumulatorRef.current += step;
        const progress = Math.min(1, wheelZoomOutAccumulatorRef.current / 8);
        setOverviewPromptProgress(progress);
        setShowOverviewPromptToast(true);

        if (overviewToastTimerRef.current) {
          clearTimeout(overviewToastTimerRef.current);
        }
        overviewToastTimerRef.current = setTimeout(() => {
          resetOverviewPromptRef.current();
        }, 1800);

        if (wheelZoomOutAccumulatorRef.current >= 8) {
          resetOverviewPromptRef.current();
          enterOverviewModeRef.current();
          return;
        }
        return;
      } else if (e.deltaY < 0) {
        if (wheelZoomOutAccumulatorRef.current > 0 || overviewToastTimerRef.current) {
          resetOverviewPromptRef.current();
        }
      }

      const isDiscrete = Math.abs(e.deltaY) >= 20;
      
      // 1. Bypass React's 16ms delay: synchronously mutate DOM for immediate style degradation (Fixes start stutter)
      const workspace = document.getElementById('canvas-workspace');
      if (workspace && workspace.getAttribute('data-zooming') !== 'true') {
        workspace.setAttribute('data-zooming', 'true');
        workspace.setAttribute('data-gesture', 'true');
        isZoomingRef.current = true;
        setIsZooming(true);

        // Synchronously pause all active videos to free hardware decoders during zoom
        try {
          const allVideos = document.querySelectorAll('video');
          allVideos.forEach(v => {
            if (!v.paused) {
              v.pause();
              v.setAttribute('data-was-playing', 'true');
            }
          });
        } catch (err) {
          console.warn('Failed to pause background videos during zoom:', err);
        }
      }

      // 2. Clear the fallback timeout on every wheel tick
      clearTimeout(zoomTimeoutRef.current);
      
      // Continuous pinch on touchpad produces smaller deltaY, discrete mouse wheel produces larger deltaY
      const zoomSensitivity = isDiscrete ? 0.002 : 0.004;
      const delta = -e.deltaY * zoomSensitivity;
      
      const newScale = Math.min(Math.max(0.1, prevTarget.scale * Math.exp(delta)), 5);
      
      // 3. Intent-Driven Lazy Restoration: 300ms idle fallback
      zoomTimeoutRef.current = setTimeout(restoreCanvasStyles, 300);
      
      const rect = container.getBoundingClientRect();
      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;
      
      const scaleRatio = newScale / prevTarget.scale;
      const newX = cursorX - (cursorX - prevTarget.x) * scaleRatio;
      const newY = cursorY - (cursorY - prevTarget.y) * scaleRatio;
      
      targetTransform.current = { x: newX, y: newY, scale: newScale };

      if (isDiscrete) {
        animate(tScale, newScale, { type: 'tween', duration: 0.15, ease: 'easeOut' });
        animate(tx, newX, { type: 'tween', duration: 0.15, ease: 'easeOut' });
        animate(ty, newY, { type: 'tween', duration: 0.15, ease: 'easeOut' });
      } else {
        tScale.set(newScale);
        tx.set(newX);
        ty.set(newY);
      }
    };

    const preventGesture = (e: Event) => e.preventDefault();
    container.addEventListener('gesturestart', preventGesture);
    container.addEventListener('gesturechange', preventGesture);
    container.addEventListener('gestureend', preventGesture);
    container.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      container.removeEventListener('gesturestart', preventGesture);
      container.removeEventListener('gesturechange', preventGesture);
      container.removeEventListener('gestureend', preventGesture);
      container.removeEventListener('wheel', handleWheel);
    };
  }, [tx, ty, tScale, restoreCanvasStyles]);

  const onPointerDown = (e: React.PointerEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    if (e.button === 0 && (preOverviewTransform.current || isOverviewModeRef.current)) {
      e.stopPropagation();
      e.preventDefault();
      setOverviewCursorBox(null);
      
      const currentScale = tScale.get();
      const currentTx = tx.get();
      const currentTy = ty.get();
      
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;
      
      const worldX = (clickX - currentTx) / currentScale;
      const worldY = (clickY - currentTy) / currentScale;
      
      const baseTargetScale = preOverviewTransform.current ? preOverviewTransform.current.scale : 1.0;
      const targetScale = Math.min(Math.max(0.1, baseTargetScale / overviewBoxScaleRef.current), 5.0);
      const targetTx = clickX - worldX * targetScale;
      const targetTy = clickY - worldY * targetScale;
      
      targetTransform.current = { x: targetTx, y: targetTy, scale: targetScale };
      
      triggerTweenZoom(400);
      
      const animConfig: any = { type: 'tween', duration: 0.4, ease: [0.16, 1, 0.3, 1] };
      animate(tScale, targetScale, animConfig);
      animate(tx, targetTx, animConfig);
      animate(ty, targetTy, animConfig);
      
      clearTimeout(zoomTimeoutRef.current);
      zoomTimeoutRef.current = setTimeout(restoreCanvasStyles, 400);
      
      // Clear overview state to commit the new position
      preOverviewTransform.current = null;
      overviewBoxScaleRef.current = 1.0;
      setIsOverviewMode(false);
      isOverviewModeRef.current = false;
      return;
    }

    if (e.button === 0) {
      // Level 1 Intent Trigger: User left-clicks on canvas, instantly restore high-fidelity styles.
      // If the click is inside a card, we bypass to prevent selection stutter.
      const target = e.target as HTMLElement;
      if (!target.closest('[data-card-id]')) {
        restoreCanvasStyles();
      }

      const cursorX = e.clientX - rect.left;
      const cursorY = e.clientY - rect.top;
        const canvasX = (cursorX - tx.get()) / tScale.get();
        const canvasY = (cursorY - ty.get()) / tScale.get();

        // In Nano-LOD mode, DOM cards are unmounted for 60fps performance.
        // Hit-test against pure world coordinates to select or drag cards:
        if (isNanoLod) {
          let clickedCard: CardData | undefined;
          for (let i = cards.length - 1; i >= 0; i--) {
            const c = cards[i];
            const dim = getCardSize(c);
            if (canvasX >= c.x && canvasX <= c.x + dim.width && canvasY >= c.y && canvasY <= c.y + dim.height) {
              clickedCard = c;
              break;
            }
          }

          if (clickedCard && pickerSession) {
            e.stopPropagation();
            handleTogglePickerCard(clickedCard.id);
            return;
          }

          if (clickedCard) {
            handleCardSelect(e, clickedCard.id);
            nanoDragRef.current = {
              cardId: clickedCard.id,
              startX: e.clientX,
              startY: e.clientY,
              didMove: false,
              initialCards: cards.map(c => ({ id: c.id, x: c.x, y: c.y })),
            };
            try {
              const allVideos = document.querySelectorAll('video');
              allVideos.forEach(v => {
                if (!v.paused) {
                  v.pause();
                  v.setAttribute('data-was-playing', 'true');
                }
              });
            } catch (err) {}
            containerRef.current?.setPointerCapture(e.pointerId);
            return;
          }
        }

        const isBackgroundTarget = 
          e.target === containerRef.current || 
          (e.target as Element).id === 'grid-bg-overlay' || 
          (e.target as Element).id === 'nano-lod-canvas' ||
          (e.target as Element).id === 'canvas-workspace';

        if (isBackgroundTarget) {
          if (!e.shiftKey && !e.ctrlKey && !e.metaKey) {
            setSelectedCardIds([]);
          }
          setSelectionBox({
            startX: canvasX,
            startY: canvasY,
            currentX: canvasX,
            currentY: canvasY,
            initialSelectedIds: e.shiftKey || e.ctrlKey || e.metaKey ? [...selectedCardIds] : []
          });
        }
    }
    // Only start dragging on middle click
    if (e.button !== 1) return;
    
    // Bypass React state to eliminate the 16ms start-of-drag stutter
    isDraggingCanvasRef.current = true;
    
    document.body.style.cursor = 'grabbing';
    
    const workspace = document.getElementById('canvas-workspace');
    if (workspace) {
      workspace.setAttribute('data-panning', 'true');
      workspace.setAttribute('data-gesture', 'true');
    }

    // Synchronously pause all active videos to free hardware decoders during canvas drag
    try {
      const allVideos = document.querySelectorAll('video');
      allVideos.forEach(v => {
        if (!v.paused) {
          v.pause();
          v.setAttribute('data-was-playing', 'true');
        }
      });
    } catch (err) {
      console.warn('Failed to pause background videos during canvas drag:', err);
    }
    
    lastPointer.current = { x: e.clientX, y: e.clientY };
    containerRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    lastMouseClientPosRef.current = { clientX: e.clientX, clientY: e.clientY };

    if (isOverviewModeRef.current) {
      updateOverviewCursorBoxAt(e.clientX, e.clientY);
    } else if (overviewCursorBox) {
      setOverviewCursorBox(null);
    }

    if (isDraggingCanvasRef.current) {
      const dx = e.clientX - lastPointer.current.x;
      const dy = e.clientY - lastPointer.current.y;
      lastPointer.current = { x: e.clientX, y: e.clientY };
      
      const newX = tx.get() + dx;
      const newY = ty.get() + dy;
      
      targetTransform.current.x = newX;
      targetTransform.current.y = newY;
      
      tx.set(newX);
      ty.set(newY);
    } else if (nanoDragRef.current) {
      const currentScale = tScale.get();
      const dx = (e.clientX - nanoDragRef.current.startX) / currentScale;
      const dy = (e.clientY - nanoDragRef.current.startY) / currentScale;
      if (Math.hypot(e.clientX - nanoDragRef.current.startX, e.clientY - nanoDragRef.current.startY) > 3) {
        nanoDragRef.current.didMove = true;
      }
      if (nanoDragRef.current.didMove) {
        const draggingId = nanoDragRef.current.cardId;
        const isDraggingSelected = selectedCardIdsRef.current.includes(draggingId);
        
        // Zero-React-Latency: Save real-time dragging state in window and trigger custom event
        (window as any).__nanoDragging = {
          cardId: draggingId,
          dx,
          dy,
          isDraggingSelected,
          selectedCardIds: selectedCardIdsRef.current
        };
        window.dispatchEvent(new CustomEvent('nano-dragging'));
      }
    } else if (selectionBox) {
      const canvasX = (e.clientX - tx.get()) / tScale.get();
      const canvasY = (e.clientY - ty.get()) / tScale.get();
      
      setSelectionBox(prev => prev ? { ...prev, currentX: canvasX, currentY: canvasY } : null);
      
      const minX = Math.min(selectionBox.startX, canvasX);
      const maxX = Math.max(selectionBox.startX, canvasX);
      const minY = Math.min(selectionBox.startY, canvasY);
      const maxY = Math.max(selectionBox.startY, canvasY);
      
      const queryBox: BoundingBox = { minX, minY, maxX, maxY };
      const candidateList = quadTreeRef.current ? quadTreeRef.current.query(queryBox) : cards;

      const newlySelected = candidateList.filter(card => {
        const dim = getCardSize(card);
        const cw = dim.width;
        const ch = dim.height;
        return (
          card.x < maxX && 
          card.x + cw > minX && 
          card.y < maxY && 
          card.y + ch > minY
        );
      }).map(c => c.id);
      
      // Merge with initial selection if modifiers were used
      const merged = new Set([...selectionBox.initialSelectedIds, ...newlySelected]);
      setSelectedCardIds(Array.from(merged));
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    isDraggingCanvasRef.current = false;
    document.body.style.cursor = 'default';
    
    // Per Intent-Driven Lazy Restoration:
    // DO NOT synchronously remove data-panning/data-gesture immediately on pointer up!
    // Removing them on every quick click-drag triggers synchronous reflow and layout recalculation storms.
    // Instead, maintain persistent degradation and let the 300ms idle fallback timer or left-click intent restore it.

    if (nanoDragRef.current) {
      if (nanoDragRef.current.didMove) {
        // Zero-React-Latency Drag Release: Apply final coordinates once to React State and push to History
        const draggingId = nanoDragRef.current.cardId;
        const isDraggingSelected = selectedCardIdsRef.current.includes(draggingId);
        const currentScale = tScale.get();
        const dragDx = (e.clientX - nanoDragRef.current.startX) / currentScale;
        const dragDy = (e.clientY - nanoDragRef.current.startY) / currentScale;
        
        const initMap = new Map<string, { id: string; x: number; y: number }>(
          nanoDragRef.current.initialCards.map(c => [c.id, c])
        );
        
        (window as any).__nanoDragging = null;
        // Trigger a final repaint event to clear offset rendering
        window.dispatchEvent(new CustomEvent('nano-dragging'));

        setCards(prev => prev.map(c => {
          if (isDraggingSelected ? selectedCardIdsRef.current.includes(c.id) : c.id === draggingId) {
            const init = initMap.get(c.id);
            if (init) return { ...c, x: init.x + dragDx, y: init.y + dragDy };
          }
          return c;
        }), true);
      } else {
        // Simple click in nano-LOD mode: deselect other cards if clicked card was already selected
        handleCardSelect(e, nanoDragRef.current.cardId, true);
      }
      nanoDragRef.current = null;
    }

    // Reset idle timer after drag
    if (e.button === 1) {
      clearTimeout(zoomTimeoutRef.current);
      zoomTimeoutRef.current = setTimeout(restoreCanvasStyles, 300);
    }
    
    setSelectionBox(null);
    containerRef.current?.releasePointerCapture(e.pointerId);
  };

  useEffect(() => {
    // Escape key listener to exit picker session
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && pickerSession) {
        e.preventDefault();
        handleCancelPickerSession();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pickerSession, handleCancelPickerSession]);

  useEffect(() => {
    // INTENT SIGNAL: The user opened a massive overlay. The canvas is now a background.
    if (showSettings || isScriptDrawerOpen) {
      restoreCanvasStyles();
    }
  }, [showSettings, isScriptDrawerOpen, restoreCanvasStyles]);

  const visibleCards = useMemo(() => {
    // If visibleCardIdSet has not yet initialized, calculate directly for first frame
    if (visibleCardIdSet.size === 0 && cards.length > 0) {
      if (typeof window === 'undefined') return cards;
      const vp = {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        tx: tx.get(),
        ty: ty.get(),
        scale: tScale.get()
      };
      const selectedIds = selectedCardIdsRef.current;
      return cards.filter(card => 
        selectedIds.includes(card.id) || isCardIntersectingRectangle(card, vp)
      );
    }
    return cards.filter(card => visibleCardIdSet.has(card.id));
  }, [cards, visibleCardIdSet, tx, ty, tScale]);

  // --- Strictly Frame-Based Progressive LOD Mounting Engine ---
  // Guarantees 60fps zooming and panning fluid motion by budgeting DOM node mounting per frame (rAF).
  // 1. Under Nano-LOD (scale < threshold): NanoLodCanvas renders 2D canvas thumbnails underneath (0 DOM cards).
  // 2. While actively dragging/zooming (gesture active): Mounts at a steady 1 card / frame budget.
  // 3. When idle / static: Adaptive frame quotas (Macro: 1/frame, Standard: 2/frame, Micro: 3/frame).
  // 4. Mounts progressively starting from the center of the viewport outwards.
  useEffect(() => {
    if (!isDomCardsActive || isZoomAnimationActive) {
      if (!isDomCardsActive) {
        setRenderedCardIds(prev => prev.size === 0 ? prev : new Set());
      }
      return;
    }

    const isGestureActive = isZooming || isDraggingCanvasRef.current || document.getElementById('canvas-workspace')?.getAttribute('data-gesture') === 'true';

    const visibleIds = new Set(visibleCards.map(c => c.id));
    const pendingCards = visibleCards.filter(c => !renderedCardIds.has(c.id));
    const hasCulled = Array.from(renderedCardIds).some(id => !visibleIds.has(id));

    // If no new cards need mounting and no culled cards need unmounting (when not gesturing), we are settled
    if (pendingCards.length === 0 && (!hasCulled || isGestureActive)) {
      return;
    }

    // When NOT gesturing, if only culled cards need unmounting, clean them up immediately
    if (pendingCards.length === 0 && hasCulled && !isGestureActive) {
      setRenderedCardIds(prev => {
        const next = new Set<string>();
        for (const id of prev) {
          if (visibleIds.has(id)) next.add(id);
        }
        return next;
      });
      return;
    }

    let rafId: number;

    const mountStep = () => {
      mountFrameCounterRef.current++;
      const frameIndex = mountFrameCounterRef.current;
      const scaleVal = tScale.get() || 1;
      const quota = getLodMountQuota(scaleVal, isGestureActive, frameIndex);
      if (quota <= 0) {
        if (!isGestureActive && pendingCards.length > 0) {
          rafId = requestAnimationFrame(mountStep);
        }
        return;
      }

      // Calculate distance to viewport center for center-out progressive reveal
      const centerX = (window.innerWidth / 2 - tx.get()) / scaleVal;
      const centerY = (window.innerHeight / 2 - ty.get()) / scaleVal;

      const sortedPending = [...pendingCards].sort((a, b) => {
        // Preemptive top priority for Agent-focused cards (Primary & References)
        const aAgentFocused = Boolean(agentFocus.primaryCardId === a.id || agentFocus.referenceCardIds.includes(a.id));
        const bAgentFocused = Boolean(agentFocus.primaryCardId === b.id || agentFocus.referenceCardIds.includes(b.id));
        if (aAgentFocused && !bAgentFocused) return -1;
        if (!aAgentFocused && bAgentFocused) return 1;

        const aSel = selectedCardIdsRef.current.includes(a.id);
        const bSel = selectedCardIdsRef.current.includes(b.id);
        if (aSel && !bSel) return -1;
        if (!aSel && bSel) return 1;

        const dimA = getCardSize(a);
        const dimB = getCardSize(b);
        const distA = Math.pow((a.x + dimA.width / 2) - centerX, 2) + Math.pow((a.y + dimA.height / 2) - centerY, 2);
        const distB = Math.pow((b.x + dimB.width / 2) - centerX, 2) + Math.pow((b.y + dimB.height / 2) - centerY, 2);
        return distA - distB;
      });

      const batchToMount = sortedPending.slice(0, quota).map(c => c.id);

      setRenderedCardIds(prev => {
        const next = new Set<string>(prev);
        // During gestures, keep existing mounted cards to avoid DOM relayout storms
        if (!isGestureActive) {
          next.clear();
          for (const id of prev) {
            if (visibleIds.has(id)) next.add(id);
          }
        }
        for (const id of batchToMount) {
          next.add(id);
        }
        return next;
      });
    };

    rafId = requestAnimationFrame(mountStep);

    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [isDomCardsActive, isZoomAnimationActive, mountEpoch, visibleCards, renderedCardIds, tx, ty, tScale, isZooming]);

  return (
    <div 
      ref={containerRef}
      data-agent-target="canvas.viewport"
      data-agent-actions="mouse.move mouse.hover mouse.drag mouse.scroll mouse.click mouse.doubleClick"
      className={`w-screen h-screen overflow-hidden bg-[#e7e7e7] dark:bg-[#1c1c1e] relative select-none touch-none ${isOverviewMode ? 'overview-active-mode' : ''}`}
      onPointerDownCapture={(e) => {
        // If in overview mode and user left-clicks, navigate and dive down into the clicked position!
        if (e.button === 0 && (preOverviewTransform.current || isOverviewModeRef.current)) {
          e.stopPropagation();
          e.preventDefault();
          setOverviewCursorBox(null);
          
          const rect = containerRef.current?.getBoundingClientRect();
          if (!rect) return;
          
          const currentScale = tScale.get();
          const currentTx = tx.get();
          const currentTy = ty.get();
          
          const clickX = e.clientX - rect.left;
          const clickY = e.clientY - rect.top;
          
          const worldX = (clickX - currentTx) / currentScale;
          const worldY = (clickY - currentTy) / currentScale;
          
          const baseTargetScale = preOverviewTransform.current ? preOverviewTransform.current.scale : 1.0;
          const targetScale = Math.min(Math.max(0.1, baseTargetScale / overviewBoxScaleRef.current), 5.0);
          const targetTx = clickX - worldX * targetScale;
          const targetTy = clickY - worldY * targetScale;
          
          targetTransform.current = { x: targetTx, y: targetTy, scale: targetScale };
          
          triggerTweenZoom(400);
          
          // Defer progressive DOM card mounting until the zoom animation finishes
          isZoomAnimationActiveRef.current = true;
          setIsZoomAnimationActive(true);

          const animConfig: any = { 
            type: 'tween', 
            duration: 0.4, 
            ease: [0.16, 1, 0.3, 1],
            onComplete: () => {
              isZoomAnimationActiveRef.current = false;
              setIsZoomAnimationActive(false);
              setMountEpoch(n => (n + 1) % 1000000);
            }
          };
          animate(tScale, targetScale, animConfig);
          animate(tx, targetTx, { type: 'tween', duration: 0.4, ease: [0.16, 1, 0.3, 1] });
          animate(ty, targetTy, { type: 'tween', duration: 0.4, ease: [0.16, 1, 0.3, 1] });
          
          clearTimeout(zoomTimeoutRef.current);
          zoomTimeoutRef.current = setTimeout(restoreCanvasStyles, 400);
          
          // Clear overview state to commit the new position
          preOverviewTransform.current = null;
          overviewBoxScaleRef.current = 1.0;
          setIsOverviewMode(false);
          isOverviewModeRef.current = false;
          return;
        }

        // If in overview mode, clicking doesn't restore styles yet (until animation ends or it commits)
        if (preOverviewTransform.current || isOverviewModeRef.current) return;

        // INTENT SIGNAL: Intercept left-clicks in the capture phase.
        // If they click on a card, the card's `isSelected` state will grant it "privilege" 
        // to restore its own shadow instantly via CSS, so we DO NOT restore globally here.
        // If they click the background or UI, we globally restore.
        if (e.button === 0) {
          const target = e.target as HTMLElement;
          if (!target.closest('[data-card-id]')) {
            restoreCanvasStyles();
          }
        }
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Local Drag and Drop Overlay */}
      <AnimatePresence>
        {isDragOver && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 z-40 bg-blue-500/10 dark:bg-blue-500/5 backdrop-blur-[2px] pointer-events-none flex items-center justify-center border-4 border-dashed border-blue-500/40 m-4 rounded-[28px]"
          >
            <div className="flex flex-col items-center gap-3 p-8 rounded-[24px] bg-white/90 dark:bg-neutral-900/90 shadow-2xl border border-gray-200/50 dark:border-neutral-700/50 scale-100 max-w-sm text-center">
              <div className="w-16 h-16 rounded-2xl bg-blue-50 dark:bg-blue-900/20 flex items-center justify-center text-blue-500 dark:text-blue-400">
                <Plus className="w-8 h-8 animate-bounce" />
              </div>
              <h3 className="text-base font-semibold text-gray-900 dark:text-white">放置媒体文件到画布</h3>
              <p className="text-xs text-gray-500 dark:text-neutral-400 leading-relaxed">
                支持直接拖拽一个或多个本地图片、视频文件。松开即可自动创建画布卡片。
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      {/* Unified Project & Script Bible Hub */}
      <ProjectScriptBible
        currentProject={currentProject}
        projects={projects}
        onSelectProject={handleSelectProject}
        onCreateProject={handleCreateProject}
        onRenameProject={handleRenameProject}
        onDeleteProject={handleDeleteProject}
        onUpdateProject={handleUpdateCurrentProject}
        isOpen={isScriptDrawerOpen}
        onToggleOpen={() => setDrawerOpen(!scriptViewRef.current.drawerOpen)}
        onClose={() => setDrawerOpen(false)}
        isTocOpen={isScriptTocOpen}
        onTocOpenChange={setTocOpen}
        tocScrollRequest={tocScrollRequest}
        onTocAtBottomChange={setTocAtBottom}
        requestedView={scriptViewRequest}
        onViewChange={setScriptView}
        requestedTocItemId={requestedTocItemId}
        onTocItemOpened={handleTocItemOpened}
        onSelectionChange={setScriptSelection}
        onRequestGenerateAsset={handleRequestGenerateAsset}
      />

      {/* Top Right Controls */}
      <div className="fixed top-4 right-4 z-50 flex items-center gap-2">
        <McpKeyButton />
        <button
          onClick={() => setShowSettings(true)}
          onPointerDown={e => e.stopPropagation()}
          className="w-[36px] h-[36px] rounded-2xl corner-squircle bg-gray-100 dark:bg-neutral-800 border border-gray-200/80 dark:border-[#404040]/80 shadow-md flex items-center justify-center text-gray-600 dark:text-neutral-300 hover:bg-gray-50 dark:hover:bg-neutral-700 transition-colors"
          title="后台配置"
        >
          <Settings className="w-4 h-4" />
        </button>
        <button
          onClick={() => {
            document.documentElement.classList.add('theme-transitioning');
            setIsDarkMode(!isDarkMode);
            setTimeout(() => {
              document.documentElement.classList.remove('theme-transitioning');
            }, 600);
          }}
          onPointerDown={e => e.stopPropagation()}
          className="w-[36px] h-[36px] rounded-2xl corner-squircle bg-gray-100 dark:bg-neutral-800 border border-gray-200/80 dark:border-[#404040]/80 shadow-md flex items-center justify-center text-gray-600 dark:text-neutral-300 hover:bg-gray-50 dark:hover:bg-neutral-700 transition-colors"
          title="Toggle Dark Mode"
        >
          <Sun className="w-4 h-4 hidden dark:block" />
          <Moon className="w-4 h-4 block dark:hidden" />
        </button>
      </div>

      <AnimatePresence>
        {showSettings && (
          <SettingsPage 
            onClose={() => setShowSettings(false)} 
            currentProject={currentProject}
            onUpdateProject={handleUpdateCurrentProject}
            agentRuntimeTraces={agentRuntimeTraces}
          />
        )}
      </AnimatePresence>

      {/* Infinite Dotted Grid Background - Lifted outside of transform workspace to fix compositor memory crash */}
      <motion.div 
        id="grid-bg-overlay"
        className="fixed inset-0 pointer-events-none opacity-30 dark:opacity-15 z-0"
        style={{
          backgroundImage: 'radial-gradient(circle, #a1a1aa 2px, transparent 2px)',
          backgroundPosition: gridBackgroundPosition,
          backgroundSize: gridBackgroundSize,
        }}
      />

      {/* Nano-LOD High Performance Hybrid Canvas Layer (Active when scale < 0.40 or during staggered DOM loading) */}
      <NanoLodCanvas
        cards={cards}
        selectedCardIds={selectedCardIds}
        renderedCardIds={renderedCardIds}
        agentTargetCardId={
          agentFocus.primaryCardId || 
          (agentQuickInput?.isOpen && agentQuickInput.targetId ? agentQuickInput.targetId : null)
        }
        agentReferenceCardIds={agentFocus.referenceCardIds}
        pickerSession={pickerSession}
        scale={tScale}
        tx={tx}
        ty={ty}
        isDarkMode={isDarkMode}
        isOverviewMode={isOverviewMode}
        isActive={
          isNanoCanvasActive || 
          (renderedCardIds.size < visibleCards.length && visibleCards.length > 0) ||
          (() => {
            if (typeof window === 'undefined') return false;
            const paintedSet = (window as any).__paintedCardIds;
            if (!paintedSet) return visibleCards.length > 0;
            return visibleCards.some(c => !paintedSet.has(c.id));
          })()
        }
        onReady={handleNanoCanvasReady}
        onThumbnailGenerated={(id, thumbnailUrl) => {
          handleUpdateCard(id, { thumbnailUrl }, false);
        }}
      />

      {/* Canvas Workspace for Nodes/Cards */}
      <motion.div 
        id="canvas-workspace"
        className={`absolute top-0 left-0 transform-gpu group/canvas z-0 ${isZooming || isDraggingCanvasRef.current || isTweenZooming ? 'will-change-transform' : ''}`}
        data-zooming={isZooming ? 'true' : undefined}
        data-scale-micro={isMicroLod}
        data-scale-nano={isNanoLod}
        style={{ transformOrigin: '0 0', x: tx, y: ty, scale: tScale }}
      >

        {/* Canvas Items: In Overview mode or Nano-LOD mode (scale < 0.40), unmount all DOM cards for ultra-fast Hybrid Canvas rendering */}
        {!isOverviewMode && isDomCardsActive && visibleCards.map(card => {
          if (!renderedCardIds.has(card.id)) return null;
          const hasImage = Boolean(card.imageUrl || card.originalImageUrl || card.thumbnailUrl);
          const isPickerSelectable = Boolean(pickerSession && card.id !== pickerSession.targetCardId && hasImage);
          const pickerIndex = pickerSession 
            ? pickerSession.selectedReferences.findIndex(ref => 
                ref.sourceCardId === card.id || 
                (ref.url && (ref.url === card.imageUrl || ref.url === card.originalImageUrl || ref.url === card.thumbnailUrl))
              )
            : -1;
          const pickerSelectionIndex = pickerIndex !== -1 ? pickerIndex + 1 : undefined;
          const focusItem = agentFocus.focusedMap[card.id];
          const isQuickInputTarget = Boolean(
            agentQuickInput?.isOpen && (agentQuickInput.targetIds?.includes(card.id) || agentQuickInput.targetId === card.id)
          );
          const agentFocusRole = focusItem?.role || (isQuickInputTarget ? 'inspect' : null);
          const isAgentTarget = Boolean(focusItem?.role || isQuickInputTarget);
          const isQcInspectTarget = Boolean(focusItem?.sourceTool?.includes('qc'));
          const agentInspectScenario: 'qc' | 'quickInput' | 'compare' = isQcInspectTarget
            ? 'qc'
            : (focusItem?.sourceTool?.includes('compare') ? 'compare' : 'quickInput');

          return (
            <GenerationCard 
              key={card.id}
              data={card}
              scale={tScale}
              tx={tx}
              ty={ty}
              isPickerTarget={pickerSession?.targetCardId === card.id}
              isPickerSelectable={isPickerSelectable}
              pickerSelectionIndex={pickerSelectionIndex}
              onStartCanvasPicker={handleStartCanvasPicker}
              isSelected={selectedCardIds.includes(card.id)}
              isAgentTarget={isAgentTarget}
              agentFocusRole={agentFocusRole}
              agentInspectScenario={agentInspectScenario}
              isZooming={isZooming}
              allCards={cards}
              currentProject={currentProject}
              onSelect={handleCardSelectWrapped}
              onDrag={handleCardDrag}
              onDragEnd={handleCardDragEnd}
              onDelete={handleCardDelete}
              onUpdate={handleUpdateCard}
              onForkCard={handleForkCard}
              onHover={setHoveredCardId}
            />
          );
        })}

        {/* Visual Lineage Connection Overlay (Selected cards only, direct straight lines, scale-invariant) */}
        <CanvasLineageOverlay
          cards={cards}
          selectedCardIds={selectedCardIds}
          scale={tScale}
        />

        {/* Selection Box */}
        {selectionBox && (
          <div
            className="absolute border-blue-500/50 bg-blue-500/20 pointer-events-none z-[200]"
            style={{
              left: Math.min(selectionBox.startX, selectionBox.currentX),
              top: Math.min(selectionBox.startY, selectionBox.currentY),
              width: Math.abs(selectionBox.currentX - selectionBox.startX),
              height: Math.abs(selectionBox.currentY - selectionBox.startY),
              borderWidth: `2px`, // Scale border is tricky without re-rendering, 2px is fine
              borderStyle: 'solid'
            }}
          />
        )}

        {/* Agent Marquee Selection Box */}
        {agentSelectionBox && (
          <div
            className="absolute border-[#a45cf8]/60 bg-[#a45cf8]/12 pointer-events-none z-[200] rounded-xl shadow-[0_0_15px_rgba(164,92,248,0.15)]"
            style={{
              left: Math.min(agentSelectionBox.startX, agentSelectionBox.currentX),
              top: Math.min(agentSelectionBox.startY, agentSelectionBox.currentY),
              width: Math.abs(agentSelectionBox.currentX - agentSelectionBox.startX),
              height: Math.abs(agentSelectionBox.currentY - agentSelectionBox.startY),
              borderWidth: `2.5px`,
              borderStyle: 'dashed'
            }}
          />
        )}

        {/* Overview Mode Viewport Indicator Box */}
        <AnimatePresence>
          {overviewViewportBox && (
            <motion.div
              key="overview-viewport-indicator"
              initial={{ opacity: 0.9 }}
              animate={{ opacity: isOverviewMode ? 1 : 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.38, ease: [0.16, 1, 0.3, 1] }}
              className="absolute pointer-events-none z-[80] border border-solid border-blue-500/90 dark:border-blue-400/95 bg-blue-500/[0.04] dark:bg-blue-400/[0.06]"
              style={{
                left: overviewViewportBox.x,
                top: overviewViewportBox.y,
                width: overviewViewportBox.width,
                height: overviewViewportBox.height,
                borderWidth: 'calc(2px / var(--current-scale, 1))',
                borderRadius: 0,
                boxShadow: '0 0 0 calc(1px / var(--current-scale, 1)) rgba(59, 130, 246, 0.25)',
              }}
            />
          )}
        </AnimatePresence>

        {/* Overview Mode Dynamic Cursor Viewport Reticle Box */}
        {isOverviewMode && overviewCursorBox && (
          <div
            key="overview-cursor-viewport-reticle"
            className="absolute pointer-events-none z-[85] border border-solid border-blue-500/90 dark:border-blue-400/95 bg-blue-500/[0.06] dark:bg-blue-400/[0.08]"
            style={{
              left: overviewCursorBox.x,
              top: overviewCursorBox.y,
              width: overviewCursorBox.width,
              height: overviewCursorBox.height,
              borderWidth: 'calc(2px / var(--current-scale, 1))',
              borderRadius: 0,
              boxShadow: '0 0 0 calc(1px / var(--current-scale, 1)) rgba(59, 130, 246, 0.25)',
            }}
          />
        )}
        
        {/* Agent Context Menus (Canvas Space) */}
        {Object.entries(contextMenus)
          .filter(([ownerId]) => ownerId !== 'user')
          .map(([ownerId, menu]: [string, any]) => (
          <div 
            key={ownerId}
            className="absolute z-[100] bg-gray-100 dark:bg-neutral-800 border border-gray-100 dark:border-[#404040] rounded-xl corner-squircle shadow-[0_8px_30px_rgb(0,0,0,0.12)] p-1.5 flex flex-col min-w-[160px]"
            style={{ top: menu.canvasY, left: menu.canvasX }}
            onPointerDown={e => e.stopPropagation()}
          >
            <button
              data-agent-target={`create-card-btn-${ownerId}`}
              onClick={() => handleCreateCard(ownerId)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg corner-squircle text-[13px] font-medium text-gray-700 dark:text-neutral-200 hover:bg-gray-50 dark:hover:bg-neutral-700 hover:text-gray-900 dark:hover:text-white transition-colors w-full text-left"
            >
              <Plus className="w-4 h-4" />
              生成图片
            </button>
            <button
              data-agent-target={`create-video-card-btn-${ownerId}`}
              onClick={() => handleCreateCard(ownerId, true)}
              className="flex items-center gap-2 px-3 py-2 rounded-lg corner-squircle text-[13px] font-medium text-gray-700 dark:text-neutral-200 hover:bg-gray-50 dark:hover:bg-neutral-700 hover:text-gray-900 dark:hover:text-white transition-colors w-full text-left"
            >
              <Video className="w-4 h-4" />
              生成视频
            </button>
          </div>
        ))}

        {/* Agent Cursor Overlay in absolute window space - Moved OUTSIDE transform-gpu */}
      </motion.div>
      
      {/* Project Loading Blur Mask */}
      <AnimatePresence>
        {isLoading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
            className="absolute inset-0 z-30 bg-gray-100 dark:bg-black pointer-events-auto flex items-center justify-center"
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col items-center gap-4 text-gray-600 dark:text-neutral-400">
              <RefreshCw className="w-8 h-8 animate-spin text-purple-500" />
              <span className="text-sm font-medium tracking-widest shadow-sm">正在同步工作区...</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AgentCursor 
        agentState={agentState}
        transform={transformValues}
        isIdle={true}
        isZooming={isZooming}
        isDarkMode={isDarkMode}
        quickInput={
          agentQuickInput?.isOpen
            ? {
                isOpen: true,
                targetId: agentQuickInput.targetId,
                placeholder: "输入你的想法...",
                lastReply: agentQuickInput.lastReply,
                focusTrigger: agentQuickInput.focusTrigger,
                value: cardDrafts[agentQuickInput.targetId || 'global'] || '',
                onChange: (text: string) => {
                  const target = agentQuickInput.targetId || 'global';
                  setCardDrafts(prev => ({ ...prev, [target]: text }));
                  saveDraft(target, text); // Persist draft to IndexedDB
                },
                onSubmit: async (prompt: string) => {
                  const currentTarget = agentQuickInput.targetId;
                  const targetIds = agentQuickInput.targetIds || (currentTarget ? [currentTarget] : []);
                  const currentKey = currentTarget || 'global';
                  setCardDrafts(prev => ({ ...prev, [currentKey]: '' }));
                  deleteDraft(currentKey); // Delete draft from IndexedDB on submit

                  // Unbroken Focus Relay: seamlessly retain focus on targeted cards while Agent thinks
                  if (targetIds.length > 0) {
                    agentFocusManager.batchSetFocus({
                      primary: targetIds[0],
                      references: targetIds.slice(1),
                      role: 'inspect',
                      sourceTool: 'user.prompt.thinking',
                      cursorMode: 'inspect',
                    });
                  } else if (currentTarget) {
                    agentFocusManager.setPrimaryFocus(currentTarget, 'inspect', 'user.prompt.thinking');
                  }

                  setAgentQuickInput(null);
                  if (agentSpeakTimerRef.current) clearTimeout(agentSpeakTimerRef.current);
                  setAgentState(prev => ({
                    ...prev,
                    lastPrompt: prompt,
                    speak: "正在思考...",
                    visible: true
                  }));
                  if (!prompt) return;
                  if (currentTarget) {
                    await handleCardAgentChat(currentTarget, prompt);
                  } else {
                    await handleRunAgent(prompt);
                  }
                },
                onClose: () => {
                  const currentTarget = agentQuickInput.targetId || 'global';
                  setCardDrafts(prev => ({ ...prev, [currentTarget]: '' }));
                  deleteDraft(currentTarget); // Delete draft from IndexedDB on close
                  setAgentQuickInput(null);
                  agentFocusManager.clearAll();
                  setAgentState(prev => {
                    if (isSelectionPromptSpeak(prev.speak)) {
                      return { ...prev, speak: undefined };
                    }
                    return prev;
                  });
                },
              }
            : null
        }
        onClickPointer={handleClickAgentPointer}
        onDragAgent={(newCanvasX, newCanvasY) => {
          setAgentState(prev => ({
            ...prev,
            x: newCanvasX,
            y: newCanvasY,
            isMoving: false
          }));
        }}
        onDragAgentEnd={handleDragAgentEnd}
        onDismissSpeak={() => {
          setAgentState(prev => ({ ...prev, speak: undefined }));
        }}
        onStartAgentBoxSelect={handleStartAgentBoxSelect}
        onUpdateAgentBoxSelect={handleUpdateAgentBoxSelect}
        onEndAgentBoxSelect={handleEndAgentBoxSelect}
      />

      {agentTask && (
        <aside className="fixed bottom-5 right-5 z-[90] w-[330px] rounded-[22px] corner-squircle border border-gray-200/90 bg-white p-3.5 shadow-[0_16px_48px_rgba(0,0,0,0.18)] dark:border-[#3a3a3a] dark:bg-neutral-800/95 flex flex-col gap-2.5 backdrop-blur-md">
          {/* Header */}
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-[12px] font-semibold text-purple-600 dark:text-purple-400 tracking-wide">
                Mira · 当前任务
              </p>
              <p className="mt-0.5 text-[13px] font-medium text-slate-800 dark:text-slate-100 truncate">
                {agentTask.title}
              </p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {(() => {
                const isWaitingGeneration = (agentTask.status === 'paused' || (agentTask.status === 'completed' && cards.some(c => c.state === 'generating'))) && (
                  cards.some(c => c.state === 'generating') ||
                  agentTask.events.some(e => /生成|排队|渲染|正在生成/i.test(e.text))
                );

                return (
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap flex items-center gap-1.5 ${
                    ['planning', 'waiting_tools'].includes(agentTask.status) ? 'bg-purple-100 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300' :
                    isWaitingGeneration ? 'bg-purple-50 text-purple-700 border border-purple-200/90 dark:bg-purple-950/50 dark:text-purple-300 dark:border-purple-800/80 shadow-xs' :
                    agentTask.status === 'completed' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300' :
                    agentTask.status === 'paused' || agentTask.status === 'waiting_user' ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300' :
                    'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300'
                  }`}>
                    {isWaitingGeneration && <span className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-pulse" />}
                    {['planning', 'waiting_tools'].includes(agentTask.status) ? '执行中' :
                     isWaitingGeneration ? '等待生成' :
                     agentTask.status === 'completed' ? '已完成' :
                     agentTask.status === 'paused' ? '已暂停' :
                     agentTask.status === 'waiting_user' ? '等待用户' :
                     agentTask.status === 'cancelled' ? '已取消' : '失败'}
                  </span>
                );
              })()}
              <button 
                onClick={() => setAgentTask(null)}
                className="p-1 rounded-full bg-gray-100 hover:bg-gray-200 dark:bg-neutral-700/60 dark:hover:bg-neutral-700 text-gray-500 dark:text-neutral-300 transition-colors cursor-pointer"
                title="关闭任务窗"
              >
                <X size={13} strokeWidth={2.5} />
              </button>
            </div>
          </div>

          {/* Messages / Events Stream */}
          <div ref={agentTaskScrollRef} className="max-h-[220px] min-h-[50px] overflow-y-auto space-y-2.5 pr-1 text-xs no-scrollbar flex flex-col">
            {agentTask.events.map(event => {
              if (event.kind === 'answer') {
                return (
                  <div key={event.id} className="flex justify-start">
                    <div className="bg-gray-100 dark:bg-neutral-700/70 text-slate-800 dark:text-slate-100 rounded-2xl corner-squircle px-3.5 py-2 text-[13px] leading-relaxed max-w-[95%] break-words whitespace-pre-wrap shadow-sm">
                      {event.text}
                    </div>
                  </div>
                );
              }
              if (event.kind === 'tool') {
                return (
                  <div key={event.id} className="flex justify-start">
                    <div className="text-[11px] text-slate-500 dark:text-slate-400 px-2.5 py-1 bg-gray-50 dark:bg-neutral-900/40 rounded-xl border border-gray-100 dark:border-neutral-800 truncate max-w-[95%]">
                      {event.text}
                    </div>
                  </div>
                );
              }
              return (
                <p key={event.id} className="text-slate-600 dark:text-slate-300 px-1 text-[12px] leading-relaxed">
                  {event.text}
                </p>
              );
            })}

            {isAgentRunning && (
              <div className="flex items-center gap-1.5 py-1 px-1 text-purple-600 dark:text-purple-400 text-xs">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-purple-500 animate-bounce" />
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-purple-500 animate-bounce [animation-delay:0.2s]" />
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-purple-500 animate-bounce [animation-delay:0.4s]" />
                <span className="ml-1 text-[11px] font-medium text-slate-500 dark:text-slate-400">Mira 正在执行...</span>
              </div>
            )}
          </div>

          {/* Bottom Chat Input inside Task Card */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendTaskChat();
            }}
            className="flex items-center gap-1.5 bg-gray-50 dark:bg-neutral-900/70 border border-gray-200/90 dark:border-neutral-700 rounded-xl px-2.5 py-1.5 mt-0.5"
          >
            <input
              ref={taskChatInputRef}
              type="text"
              value={taskChatMessage}
              onChange={(e) => setTaskChatMessage(e.target.value)}
              placeholder="输入你的想法..."
              className="flex-1 min-w-0 bg-transparent text-[13px] text-gray-800 dark:text-neutral-100 placeholder-gray-400 dark:placeholder-neutral-500 outline-none font-medium"
            />
            <button
              type="submit"
              disabled={!taskChatMessage.trim() || isAgentRunning}
              className={`shrink-0 p-1.5 rounded-lg transition-colors cursor-pointer ${
                taskChatMessage.trim() && !isAgentRunning
                  ? 'bg-purple-600 text-white hover:bg-purple-700 dark:bg-purple-600 dark:hover:bg-purple-500'
                  : 'bg-gray-200/80 text-gray-400 dark:bg-neutral-800 dark:text-neutral-500 cursor-not-allowed opacity-50'
              }`}
              title="发送"
            >
              <ArrowUp size={14} strokeWidth={2.5} />
            </button>
          </form>
          
          {/* Action Controls (Pause / Resume / Stop) */}
          {agentTask.status !== 'completed' && agentTask.status !== 'cancelled' && agentTask.status !== 'failed' && (
            <div className="flex items-center gap-1.5 pt-1">
              {agentTask.status === 'paused' ? (
                <button 
                  onClick={handleResumeTask}
                  className="flex-1 py-1 px-2.5 text-xs font-medium rounded-lg bg-emerald-100 text-emerald-700 hover:bg-emerald-200 transition-colors corner-squircle dark:bg-emerald-950/40 dark:text-emerald-400 cursor-pointer"
                >
                  继续
                </button>
              ) : (
                <button 
                  onClick={handlePauseTask}
                  className="flex-1 py-1 px-2.5 text-xs font-medium rounded-lg bg-amber-100 text-amber-700 hover:bg-amber-200 transition-colors corner-squircle dark:bg-amber-900/30 dark:text-amber-400 cursor-pointer"
                >
                  暂停
                </button>
              )}
              <button 
                onClick={handleCancelTask}
                className="flex-1 py-1 px-2.5 text-xs font-medium rounded-lg bg-red-100 text-red-700 hover:bg-red-200 transition-colors corner-squircle dark:bg-red-900/30 dark:text-red-400 cursor-pointer"
              >
                停止
              </button>
            </div>
          )}
        </aside>
      )}

      {/* User Context Menu Overlay (Screen Space) */}
      <AnimatePresence>
        {Object.entries(contextMenus)
          .filter(([ownerId]) => ownerId === 'user')
          .map(([ownerId, menu]: [string, any]) => (
            <AgentContextMenu
              key={ownerId}
              isOpen={true}
              x={menu.x}
              y={menu.y}
              targetId={menu.targetId}
              targetCard={menu.targetId ? (cards.find(c => c.id === menu.targetId) || null) : null}
              agentPrompt={agentPrompt}
              onPromptChange={setAgentPrompt}
              onSubmit={async () => {
                const currentTarget = menu.targetId;
                const prompt = agentPrompt.trim();
                setAgentPrompt('');
                setContextMenus(prev => { const next = {...prev}; delete next['user']; return next; });
                if (currentTarget) {
                  agentFocusManager.setPrimaryFocus(currentTarget, 'inspect', 'user.prompt.thinking');
                }
                setAgentState(prev => {
                  if (isSelectionPromptSpeak(prev.speak)) {
                    return { ...prev, speak: undefined };
                  }
                  return prev;
                });
                if (!prompt) return;
                if (currentTarget) {
                  await handleCardAgentChat(currentTarget, prompt);
                } else {
                  await handleRunAgent(prompt);
                }
              }}
              onClose={() => {
                setContextMenus(prev => { const next = {...prev}; delete next['user']; return next; });
                setAgentQuickInput(null);
                agentFocusManager.clearAll();
                setAgentState(prev => {
                  if (isSelectionPromptSpeak(prev.speak)) {
                    return { ...prev, speak: undefined };
                  }
                  return prev;
                });
              }}
              onAction={async (action, targetId) => {
                setAgentState(prev => {
                  if (isSelectionPromptSpeak(prev.speak)) {
                    return { ...prev, speak: undefined };
                  }
                  return prev;
                });
                if (action === 'new_card') handleCreateCard(ownerId);
                else if (action === 'new_video_card') handleCreateCard(ownerId, true);
                else if (action === 'delete' && targetId) {
                  setCards(prev => prev.filter(c => c.id !== targetId));
                }
                else if (action === 'clear') {
                  setCards([]);
                }
                else if (action === 'variant' && targetId) {
                  await handleCardAgentChat(targetId, '请以该卡片为基准，参考其构图与主体，生成一张新的变体卡片。');
                }
                else if (action === 'video_from_card' && targetId) {
                  await handleCardAgentChat(targetId, '以此卡片的图像为首帧/参考图，生成一段视频。');
                }
                else if (action === 'reference' && targetId) {
                  await handleCardAgentChat(targetId, '将此卡片的图像作为参考基准，在此基础上进行新的创作。');
                }
              }}
            />
          ))}
      </AnimatePresence>

      {/* Agent Question Modal */}
      <AnimatePresence>
        {agentQuestion && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/20"
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-gray-100 dark:bg-neutral-800 border border-gray-200 dark:border-[#404040] shadow-2xl p-6 rounded-[24px] corner-squircle w-[420px] max-w-[90vw]"
            >
              <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-2 flex items-center gap-2">
                <Sparkles className="w-5 h-5 text-purple-500" />
                Mira 的提问
              </h3>
              <p className="text-sm font-medium text-gray-700 dark:text-neutral-300 mb-5 leading-relaxed">
                {agentQuestion.question}
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const fd = new FormData(e.currentTarget);
                  agentQuestion.resolve(fd.get('answer') as string);
                }}
              >
                <input
                  autoFocus
                  name="answer"
                  className="w-full bg-white dark:bg-neutral-800 border border-gray-200 dark:border-[#404040] rounded-xl corner-squircle px-3 py-2.5 text-[14px] text-gray-900 dark:text-white outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 mb-5 transition-all placeholder-gray-400 dark:placeholder-neutral-500 font-medium"
                  placeholder="输入你的回答..."
                  autoComplete="off"
                />
                <div className="flex justify-end gap-2.5">
                  <button
                    type="button"
                    onClick={() => agentQuestion.resolve('')}
                    className="px-4 py-2 text-[13px] font-semibold text-gray-500 hover:bg-gray-200 dark:hover:bg-neutral-800 rounded-xl corner-squircle transition-colors"
                  >
                    跳过
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 text-[13px] font-semibold bg-purple-600 hover:bg-purple-700 text-white shadow-md rounded-xl corner-squircle transition-colors"
                  >
                    回复
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bottom Left Scale Indicator HUD */}
      <ZoomControlGroup
        tScale={tScale}
        isOverviewMode={isOverviewMode}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomReset={handleZoomReset}
      />

      {/* Floating Toolbar */}
      <div 
        className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-gray-100 dark:bg-neutral-800 border border-gray-200 dark:border-[#404040] shadow-lg rounded-[20px] corner-squircle p-1.5 z-50"
        onPointerDown={e => e.stopPropagation()}
      >
        <button 
          onClick={undo}
          disabled={history.past.length === 0}
          className="p-2 rounded-xl corner-squircle hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
          title="撤销 (Ctrl+Z)"
        >
          <Undo2 className="w-4 h-4 text-gray-700 dark:text-neutral-300" />
        </button>
        <div className="w-[1px] h-4 bg-gray-300 dark:bg-neutral-600" />
        <button 
          onClick={redo}
          disabled={history.future.length === 0}
          className="p-2 rounded-xl corner-squircle hover:bg-gray-200 dark:hover:bg-neutral-700 disabled:opacity-50 disabled:hover:bg-transparent transition-colors"
          title="重做 (Ctrl+Y / Ctrl+Shift+Z)"
        >
          <Redo2 className="w-4 h-4 text-gray-700 dark:text-neutral-300" />
        </button>
      </div>

      {/* Toast: Overview Mode Navigation Hint */}
      <AnimatePresence>
        {isOverviewMode && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -16, scale: 0.94 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            className="fixed top-5 left-1/2 -translate-x-1/2 z-[100] pointer-events-none select-none"
          >
            <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-white/95 dark:bg-[#252528]/95 backdrop-blur-md border border-neutral-200/90 dark:border-neutral-700/80 shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.35)] text-xs md:text-sm font-medium text-neutral-800 dark:text-neutral-100">
              <MousePointerClick className="w-4 h-4 text-blue-500 dark:text-blue-400 shrink-0" />
              <span className="tracking-wide">鼠标点击任意位置跳转</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toast: Prompt to enter Overview Mode */}
      <AnimatePresence>
        {showOverviewPromptToast && !isOverviewMode && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -16, scale: 0.94 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="fixed top-5 left-1/2 -translate-x-1/2 z-[100] pointer-events-none select-none"
          >
            <div className="relative overflow-hidden flex items-center justify-center px-5 py-2 rounded-full bg-white/95 dark:bg-[#252528]/95 backdrop-blur-md border border-neutral-200/90 dark:border-neutral-700/80 shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.35)] text-xs md:text-sm font-medium text-neutral-800 dark:text-neutral-100 min-w-[200px]">
              {/* Full-bleed background progress bar from left to right */}
              <div 
                className="absolute inset-y-0 left-0 bg-blue-500/20 dark:bg-blue-400/25 border-r border-blue-500/50 dark:border-blue-400/50 transition-[width] duration-150 ease-out pointer-events-none"
                style={{ width: `${Math.min(100, Math.max(0, overviewPromptProgress * 100))}%` }}
              />
              <span className="relative z-10 tracking-wide font-medium">继续缩小进入全景视图</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Top Reference Picker Control Bar & Tray (Positioned below the top toast area) */}
      <AnimatePresence>
        {pickerSession && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className={`fixed ${showOverviewPromptToast && !isOverviewMode ? 'top-20' : 'top-5'} left-1/2 -translate-x-1/2 z-[110] flex flex-col items-center gap-2 w-max max-w-[98vw] select-none pointer-events-auto`}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {/* 1. Control Bar (Main HUD Toast) */}
            <div className="flex items-center gap-4 px-4 py-2.5 rounded-2xl bg-neutral-900/95 dark:bg-[#1a1a1d]/95 backdrop-blur-md border border-neutral-700/80 shadow-[0_16px_40px_rgba(0,0,0,0.35)] text-xs text-neutral-100">
              <div className="flex items-center gap-2">
                <span className="flex h-2.5 w-2.5 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500"></span>
                </span>
                <span className="font-semibold tracking-wide text-xs">画布拾取模式</span>
                <span className="text-neutral-500">|</span>
                <span className="text-neutral-300">点击画布上的任意图片卡片添加/取消</span>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2 pl-3 border-l border-neutral-700">
                <button
                  type="button"
                  onClick={handleCancelPickerSession}
                  className="px-3 py-1.5 rounded-xl text-neutral-300 hover:text-white hover:bg-neutral-800 transition-colors font-medium text-xs flex items-center gap-1"
                >
                  <span>取消</span>
                  <span className="text-[10px] opacity-60 bg-neutral-800 px-1 py-0.5 rounded">Esc</span>
                </button>

                 <button
                  type="button"
                  onClick={handleConfirmPickerSession}
                  disabled={pickerSession.selectedReferences.length === 0}
                  className={`px-3.5 py-1.5 rounded-xl font-semibold text-xs flex items-center gap-1.5 transition-all shadow-sm ${
                    pickerSession.selectedReferences.length > 0
                      ? 'bg-blue-600 hover:bg-blue-500 text-white cursor-pointer active:scale-95 shadow-[0_0_16px_rgba(37,99,235,0.4)]'
                      : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'
                  }`}
                >
                  <span>确认导入</span>
                  {pickerSession.selectedReferences.length > 0 && (
                    <span className="px-1.5 py-0.2 rounded-full bg-white/25 text-white text-[10px]">
                      {pickerSession.selectedReferences.length}
                    </span>
                  )}
                </button>
              </div>
            </div>

            {/* 2. Independent Reference Image Preview Tray (Positioned below Toast, Aspect-Ratio Display) */}
            {pickerSession.selectedReferences.length > 0 && (
              <motion.div 
                initial={{ opacity: 0, y: -8, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8, scale: 0.95 }}
                transition={{ duration: 0.15 }}
                className="p-2 px-3 rounded-2xl bg-neutral-950/90 backdrop-blur-md border border-neutral-800 shadow-[0_16px_36px_rgba(0,0,0,0.4)] w-fit max-w-[98vw] max-h-[34vh] overflow-y-auto scrollbar-thin"
              >
                <div className="flex flex-wrap items-start justify-center gap-x-4 gap-y-2">
                  {pickerSession.selectedReferences.map((ref, idx) => {
                    const img = ref.url || ref.thumbnailUrl;
                    const cardName = ref.name || `参考图 #${idx + 1}`;
                    return (
                      <div 
                        key={idx} 
                        className="flex flex-col items-center gap-1 group flex-shrink-0 cursor-pointer"
                        onClick={() => handleRemovePickerReference(idx)}
                        title={`${cardName} (点击移除)`}
                      >
                        <div className="relative h-16 rounded-xl overflow-hidden border-2 border-blue-500 shadow-md bg-neutral-900 transition-all group-hover:scale-[1.03] group-hover:border-red-500">
                          {img ? (
                            <img 
                              src={img} 
                              alt={cardName} 
                              loading="lazy"
                              decoding="async"
                              referrerPolicy="no-referrer"
                              className="h-full w-auto max-w-[110px] object-contain block" 
                            />
                          ) : (
                            <div className="h-full w-16 bg-neutral-800 flex items-center justify-center text-xs font-bold text-neutral-300">
                              #{idx + 1}
                            </div>
                          )}
                          
                          {/* Index badge */}
                          <div className="absolute top-1 left-1 px-1.5 py-0.5 rounded-md bg-blue-600/90 text-[10px] text-white font-bold leading-none backdrop-blur-xs shadow-xs">
                            {idx + 1}
                          </div>

                          {/* Hover remove overlay */}
                          <div className="absolute inset-0 bg-red-600/80 opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center transition-opacity text-white">
                            <span className="text-sm font-bold leading-none">✕</span>
                            <span className="text-[9px] font-medium mt-1">移除</span>
                          </div>
                        </div>

                        {/* Name text below asset */}
                        <span className="text-[11px] text-neutral-300 max-w-[100px] truncate text-center font-medium leading-tight group-hover:text-red-400 transition-colors">
                          {cardName}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Real-time FPS Counter */}
      <FpsCounter hasActiveTask={!!agentTask} />

    </div>
  );
}
