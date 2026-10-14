import React, { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { motion, MotionValue, useTransform, useMotionValue, animate, AnimatePresence } from 'motion/react';
import { ArrowUp } from 'lucide-react';
import { CardData } from './GenerationCard';

export function buildDynamicSelectionPrompt(cards: CardData[]): string {
  if (!cards || cards.length === 0) {
    return "我能帮什么忙？";
  }

  if (cards.length === 1) {
    const card = cards[0];
    const rawName = (card.name || card.fileName || card.prompt || '')
      .replace(/\.(png|jpg|jpeg|webp|gif|mp4|mov|webm)$/i, '')
      .trim();
    const cleanName = rawName.replace(/[\r\n]+/g, ' ').trim();

    if (cleanName && cleanName.length <= 12) {
      return `选了【${cleanName}】，需要我做什么？`;
    }

    if (card.isVideo) {
      return "选了 1 个视频，需要我做什么？";
    }
    if (card.imageUrl || card.fileData || card.isAsset || card.thumbnailUrl) {
      return "选了 1 张图片，需要我做什么？";
    }
    return "选了 1 个卡片，需要我做什么？";
  }

  let videoCount = 0;
  let imageCount = 0;
  let otherCount = 0;

  for (const c of cards) {
    if (c.isVideo) {
      videoCount++;
    } else if (c.imageUrl || c.fileData || c.isAsset || c.thumbnailUrl) {
      imageCount++;
    } else {
      otherCount++;
    }
  }

  const total = cards.length;

  if (imageCount === total) {
    return `选了 ${total} 张图片，需要我做什么？`;
  }
  if (videoCount === total) {
    return `选了 ${total} 个视频，需要我做什么？`;
  }
  if (otherCount === total) {
    return `选了 ${total} 个卡片，需要我做什么？`;
  }

  if (imageCount > 0 && videoCount > 0 && otherCount === 0) {
    return `选了 ${imageCount} 张图片和 ${videoCount} 个视频，需要我做什么？`;
  }

  return `选了 ${total} 个卡片，需要我做什么？`;
}

export interface HudContextMessage {
  text: string;
  speaker: 'user' | 'agent';
}

export interface QuickInputConfig {
  isOpen: boolean;
  targetId: string | null;
  placeholder?: string;
  contextHistory?: HudContextMessage | null;
  lastReply?: string;
  onSubmit: (text: string) => void;
  onClose: () => void;
  focusTrigger?: number;
  value: string;
  onChange: (text: string) => void;
  onAskResolve?: ((answer: string) => void) | null;
}

interface AgentCursorProps {
  agentState: {
    x: number;
    y: number;
    visible: boolean;
    isActive: boolean;
    isMoving: boolean;
    speak?: string;
    lastPrompt?: string;
    lastPromptTargetId?: string | null;
    cursorMode?: 'default' | 'inspect' | 'working' | 'interact';
  };
  transform: {
    tx: MotionValue<number>;
    ty: MotionValue<number>;
    tScale: MotionValue<number>;
  };
  isIdle?: boolean;
  isZooming?: boolean;
  isAgentRunning?: boolean;
  isAgentThinking?: boolean;
  selectedCards?: CardData[];
  quickInput?: QuickInputConfig | null;
  onClickPointer?: () => void;
  onDragAgent?: (newCanvasX: number, newCanvasY: number) => void;
  onDragAgentEnd?: (finalCanvasX: number, finalCanvasY: number, screenX: number, screenY: number) => void;
  onDismissSpeak?: () => void;
  isDarkMode?: boolean;
  onStartAgentBoxSelect?: (canvasX: number, canvasY: number) => void;
  onUpdateAgentBoxSelect?: (canvasX: number, canvasY: number) => void;
  onEndAgentBoxSelect?: () => void;
}

const CURSOR_FLOAT_VARIANTS = {
  floating: {
    y: [0, -6],
    transition: {
      duration: 1.5,
      repeat: Infinity,
      repeatType: 'reverse' as const,
      ease: 'easeInOut',
    },
  },
  still: {
    y: 0,
    transition: {
      duration: 0.2,
      ease: 'easeOut',
    },
  },
};

function isThinkingPhrase(text?: string): boolean {
  if (!text) return false;
  const clean = text.trim();
  if (!clean) return false;
  if (
    clean.includes('正在操作') || 
    clean.includes('正在标注') || 
    clean.includes('正在生成') || 
    clean.includes('排队渲染') ||
    clean.includes('正在查看') ||
    clean.includes('正在对照') ||
    clean.includes('正在质检')
  ) {
    return false;
  }
  return (
    clean === '...' ||
    clean === '…' ||
    clean === 'thinking' ||
    clean === 'loading' ||
    clean === '正在思考...' ||
    clean === '正在思考' ||
    clean === '图生好了，我先看下...' ||
    clean === '图生好了，我先看下' ||
    clean.includes('正在思考') ||
    clean.includes('正在拉取')
  );
}

function SingleLineMarquee({ 
  text, 
  isDarkMode, 
  isHistory = false,
  speaker = 'agent',
}: { 
  text: string; 
  isDarkMode?: boolean; 
  isHistory?: boolean; 
  speaker?: 'user' | 'agent';
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  const cleanText = (text || '').trim();
  const isThinking = isThinkingPhrase(cleanText);

  useLayoutEffect(() => {
    if (containerRef.current && textRef.current) {
      const containerWidth = containerRef.current.clientWidth;
      const textWidth = textRef.current.scrollWidth;
      if (textWidth > containerWidth) {
        setOverflow(Math.ceil(textWidth - containerWidth));
      } else {
        setOverflow(0);
      }
    }
  }, [text]);

  const textStyleClass = speaker === 'user'
    ? (isHistory
        ? (isDarkMode 
            ? "inline-block text-[12px] font-medium leading-none text-white/70 tracking-wide antialiased"
            : "inline-block text-[12px] font-medium leading-none text-slate-800/70 tracking-wide antialiased")
        : (isDarkMode 
            ? "inline-block text-[13px] font-semibold leading-none text-white tracking-wide antialiased"
            : "inline-block text-[13px] font-semibold leading-none text-slate-900 tracking-wide antialiased"))
    : (isHistory
        ? (isDarkMode 
            ? "inline-block text-[12px] font-medium leading-none text-[#a45cf8]/70 tracking-wide antialiased"
            : "inline-block text-[12px] font-medium leading-none text-purple-600/70 tracking-wide antialiased")
        : (isDarkMode 
            ? "inline-block text-[13px] font-semibold leading-none text-[#a45cf8] tracking-wide antialiased"
            : "inline-block text-[13px] font-semibold leading-none text-purple-600 tracking-wide antialiased"));

  const dotColorClass = speaker === 'user'
    ? (isHistory ? (isDarkMode ? 'bg-white/60' : 'bg-slate-800/60') : (isDarkMode ? 'bg-white' : 'bg-slate-900'))
    : (isHistory ? (isDarkMode ? 'bg-[#a45cf8]/60' : 'bg-purple-600/60') : (isDarkMode ? 'bg-[#a45cf8]' : 'bg-purple-600'));

  return (
    <div
      ref={containerRef}
      className={`overflow-hidden whitespace-nowrap max-w-[420px] min-w-[24px] flex items-center ${isThinking ? 'justify-center' : 'justify-start text-left'} gap-1.5`}
      style={{
        transform: 'translateZ(0)',
        backfaceVisibility: 'hidden',
        WebkitFontSmoothing: 'antialiased',
      }}
    >
      {isThinking ? (
        <span className="flex items-center gap-1.5 px-1 py-0.5 shrink-0 select-none">
          <span className={textStyleClass}>正在思考</span>
          <span className="inline-flex items-center gap-1 shrink-0">
            <motion.span 
              className={`inline-block w-1.5 h-1.5 rounded-full ${dotColorClass}`}
              animate={{ y: [0, -3.5, 0] }}
              transition={{ duration: 0.8, repeat: Infinity, ease: 'easeInOut', delay: 0 }}
            />
            <motion.span 
              className={`inline-block w-1.5 h-1.5 rounded-full ${dotColorClass}`}
              animate={{ y: [0, -3.5, 0] }}
              transition={{ duration: 0.8, repeat: Infinity, ease: 'easeInOut', delay: 0.15 }}
            />
            <motion.span 
              className={`inline-block w-1.5 h-1.5 rounded-full ${dotColorClass}`}
              animate={{ y: [0, -3.5, 0] }}
              transition={{ duration: 0.8, repeat: Infinity, ease: 'easeInOut', delay: 0.3 }}
            />
          </span>
        </span>
      ) : overflow > 0 ? (
        <motion.span
          ref={textRef}
          key={text}
          className={`${textStyleClass} shrink-0 will-change-transform`}
          style={{
            transform: 'translateZ(0)',
            backfaceVisibility: 'hidden',
          }}
          animate={{ x: [0, 0, -overflow, -overflow, 0] }}
          transition={{
            duration: Math.max(5, (overflow / 30) + 2.5),
            repeat: Infinity,
            repeatDelay: 1.2,
            times: [0, 0.15, 0.55, 0.75, 1],
            ease: 'easeInOut',
          }}
        >
          {text}
        </motion.span>
      ) : (
        <span
          ref={textRef}
          key={text}
          className={`${textStyleClass} shrink-0`}
          style={{
            transform: 'translateZ(0)',
            backfaceVisibility: 'hidden',
          }}
        >
          {text}
        </span>
      )}
    </div>
  );
}

export function AgentCursor({ 
  agentState, 
  transform, 
  isIdle = true, 
  isZooming = false, 
  isAgentRunning,
  isAgentThinking,
  selectedCards = [],
  quickInput, 
  onClickPointer, 
  onDragAgent, 
  onDragAgentEnd, 
  isDarkMode = false,
  onStartAgentBoxSelect,
  onUpdateAgentBoxSelect,
  onEndAgentBoxSelect
}: AgentCursorProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isAgentBoxSelecting, setIsAgentBoxSelecting] = useState(false);
  const isAgentBoxSelectingRef = useRef(false);
  const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
  const dragStartRef = useRef<{ pointerX: number; pointerY: number; startCanvasX: number; startCanvasY: number; hasMoved: boolean } | null>(null);

  const quickInputRef = useRef<HTMLInputElement>(null);

  // Submit stage machine:
  const [submitStep, setSubmitStep] = useState<'idle' | 'submitting'>('idle');
  const [submittedUserPrompt, setSubmittedUserPrompt] = useState<string | null>(null);

  const submitTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (submitTimerRef.current) {
        clearTimeout(submitTimerRef.current);
      }
    };
  }, []);

  const rawIsThinking = isThinkingPhrase(agentState.speak);
  const isActuallyThinking = isAgentThinking !== undefined
    ? isAgentThinking
    : ((isAgentRunning !== false) && rawIsThinking);

  const dynamicPromptText = useMemo(() => {
    return buildDynamicSelectionPrompt(selectedCards || []);
  }, [selectedCards]);

  // When regular quickInput opens or target card changes, settle state and clear any old transient submitted prompt.
  // When user.ask triggers quickInput (onAskResolve is present), preserve the user's prompt in Row 1!
  useEffect(() => {
    if (quickInput?.isOpen && !quickInput?.onAskResolve) {
      setSubmitStep('idle');
      setSubmittedUserPrompt(null);
    }
  }, [quickInput?.isOpen, quickInput?.targetId, quickInput?.onAskResolve]);

  useEffect(() => {
    if (!agentState.speak && !agentState.lastPrompt && !quickInput?.isOpen) {
      setSubmitStep('idle');
      setSubmittedUserPrompt(null);
    }
  }, [agentState.speak, agentState.lastPrompt, quickInput?.isOpen]);

  useEffect(() => {
    if (!isAgentRunning && !isActuallyThinking && !quickInput?.isOpen && submitStep === 'idle') {
      if (!agentState.speak) {
        setSubmittedUserPrompt(null);
      }
    }
  }, [isAgentRunning, isActuallyThinking, quickInput?.isOpen, submitStep, agentState.speak]);

  const isSubmitting = submitStep === 'submitting';

  // Row 1 (Top History/Context Message Model):
  // Structured data-driven message model with intrinsic speaker identity:
  // 1. If user has actively submitted a prompt in this input: speaker is 'user'.
  // 2. If running active task or in user.ask workflow for this target: speaker is 'user'.
  // 3. Otherwise (idle inspection), strictly use target-scoped contextHistory from active target.
  const rawRow1Message = useMemo<HudContextMessage | null>(() => {
    // 1. Active submission stream in this cursor
    if (submittedUserPrompt && submittedUserPrompt.trim()) {
      return {
        text: submittedUserPrompt.trim(),
        speaker: 'user',
      };
    }

    // 2. Active task or user.ask execution
    const isExecutionActive = isAgentRunning || Boolean(quickInput?.onAskResolve);
    if (isExecutionActive && agentState.lastPrompt && agentState.lastPrompt.trim()) {
      const scopeMatches = !agentState.lastPromptTargetId || agentState.lastPromptTargetId === (quickInput?.targetId || 'global');
      if (scopeMatches) {
        return {
          text: agentState.lastPrompt.trim(),
          speaker: 'user',
        };
      }
    }

    // 3. Target-scoped persistent context history (from card's chatHistory or canvas globalHistory)
    if (quickInput?.contextHistory) {
      return quickInput.contextHistory;
    }

    // 4. Legacy fallback for lastReply (if contextHistory not explicitly provided)
    if (quickInput?.isOpen && quickInput.lastReply && quickInput.lastReply.trim() && !quickInput.onAskResolve) {
      return {
        text: quickInput.lastReply.trim(),
        speaker: 'agent',
      };
    }

    return null;
  }, [submittedUserPrompt, isAgentRunning, quickInput?.isOpen, quickInput?.onAskResolve, quickInput?.targetId, quickInput?.contextHistory, quickInput?.lastReply, agentState.lastPrompt, agentState.lastPromptTargetId]);

  const isDefaultOrSelectionSpeak = !agentState.speak ||
    rawIsThinking ||
    agentState.speak.startsWith('选了') ||
    agentState.speak === '我能帮什么忙？';

  // Effective agent speak for Row 2:
  // If user has submitted a prompt:
  //   - Never revert to dynamic selection prompt ("选了X张图片...") or greeting ("我能帮什么忙？")!
  //   - If agentState.speak has actual agent text (not selection or generic greeting), show it.
  //   - Otherwise show "正在思考..." during thinking/submitting.
  // When Agent is actively running/executing without submittedUserPrompt:
  //   - Strictly execution/thinking mode: show active speak or fallback to "正在思考..." / "正在操作...".
  // When idle and quickInput is open:
  //   - Show dynamic selection prompt.
  const effectiveAgentSpeak = submittedUserPrompt
    ? (agentState.speak && !agentState.speak.startsWith('选了') && agentState.speak !== '我能帮什么忙？' && !isThinkingPhrase(agentState.speak)
        ? agentState.speak
        : "正在思考...")
    : (isAgentRunning
        ? (agentState.speak && !agentState.speak.startsWith('选了') && agentState.speak !== '我能帮什么忙？' 
            ? agentState.speak 
            : (isActuallyThinking ? "正在思考..." : "正在操作..."))
        : (quickInput?.isOpen && submitStep === 'idle' && isDefaultOrSelectionSpeak)
            ? dynamicPromptText
            : (rawIsThinking && isAgentRunning === false)
              ? undefined
              : (agentState.speak || (quickInput?.isOpen ? dynamicPromptText : undefined)));

  const effectiveIsThinking = submittedUserPrompt
    ? (agentState.speak && !agentState.speak.startsWith('选了') && agentState.speak !== '我能帮什么忙？' && !isThinkingPhrase(agentState.speak)
        ? false
        : true)
    : (isAgentRunning
        ? (isAgentThinking !== undefined ? (isAgentThinking && isThinkingPhrase(effectiveAgentSpeak)) : isThinkingPhrase(effectiveAgentSpeak))
        : (quickInput?.isOpen && submitStep === 'idle' && rawIsThinking)
          ? false
          : isActuallyThinking);

  // Deduplication guard: Never display identical text simultaneously in Row 1 and Row 2 (except during submit upward motion)
  const row1Message = useMemo<HudContextMessage | null>(() => {
    if (!rawRow1Message) return null;
    if (isSubmitting) return rawRow1Message;
    if (effectiveAgentSpeak && rawRow1Message.text === effectiveAgentSpeak.trim()) {
      return null;
    }
    return rawRow1Message;
  }, [rawRow1Message, isSubmitting, effectiveAgentSpeak]);

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const val = quickInput?.value || '';
    const clean = val.trim();
    if (!clean || submitStep !== 'idle') return;

    // Upward scroll stream: User text takes flight from Row 3 to Row 1, Row 2 exits upward past Row 1 and hides
    setSubmittedUserPrompt(clean);
    setSubmitStep('submitting');

    if (submitTimerRef.current) {
      clearTimeout(submitTimerRef.current);
    }

    submitTimerRef.current = setTimeout(() => {
      quickInput?.onSubmit(clean);
      setSubmitStep('idle');
    }, 320);
  };

  const row2Content = isSubmitting
    ? null
    : (effectiveAgentSpeak ? { type: 'agent' as const, text: effectiveAgentSpeak, isThinking: effectiveIsThinking } : null);

  // Tracks horizontal breathing morphing (squeeze & expand) for text updates within the single persistent bubble
  const [morphTrigger, setMorphTrigger] = useState(0);
  const prevSpeakRef = useRef<string | undefined>(agentState.speak);

  useEffect(() => {
    if (
      prevSpeakRef.current && 
      agentState.speak && 
      prevSpeakRef.current !== agentState.speak &&
      !isSubmitting
    ) {
      setMorphTrigger(c => c + 1);
    }
    prevSpeakRef.current = agentState.speak;
  }, [agentState.speak, isSubmitting]);

  // Swapped: Light/Dark Mode Agent Pointer Styles Interchanged!
  const pointerFill = isDarkMode ? '#1c1c1e' : '#ffffff';
  const pointerStroke = isDarkMode ? '#a45cf8' : '#a855f7';
  const bubbleBgClass = isDarkMode 
    ? 'bg-[#18181c]/95 border border-[#a45cf8]/25 shadow-[0_4px_20px_rgba(0,0,0,0.7),0_0_14px_rgba(164,92,248,0.18)]' 
    : 'bg-white/95 border border-purple-200/80 shadow-[0_4px_20px_rgba(0,0,0,0.12),0_0_14px_rgba(168,85,247,0.15)]';
  // Plan 1: Receding memory archival layer for historical conversation bubble
  const historyBubbleBgClass = isDarkMode 
    ? 'bg-[#141417]/85 border border-[#a45cf8]/15 shadow-[0_2px_12px_rgba(0,0,0,0.55)]' 
    : 'bg-white/85 border border-purple-200/50 shadow-[0_2px_10px_rgba(0,0,0,0.06)]';
  const textClass = isDarkMode ? 'text-white font-semibold' : 'text-slate-900 font-semibold';
  const placeholderClass = isDarkMode ? 'placeholder-white/40' : 'placeholder-slate-400';
  const inputClass = isDarkMode ? 'text-white' : 'text-slate-900';
  const buttonClassActive = isDarkMode ? 'bg-[#a45cf8]/20 hover:bg-[#a45cf8]/35 text-[#a45cf8]' : 'bg-purple-500/15 hover:bg-purple-500/25 text-purple-600';
  const buttonClassInactive = isDarkMode ? 'text-white/30' : 'text-slate-400';

  const isOpen = quickInput?.isOpen;
  const focusTrigger = quickInput?.focusTrigger;

  useEffect(() => {
    if (isOpen) {
      // Resilient multi-stage focus strategy to bypass browser context menu and right-click focus-stealing cycles:
      // Stage 1: Immediate focus attempt
      quickInputRef.current?.focus();
      
      // Stage 2: Animation frame focus attempt
      const rId = requestAnimationFrame(() => {
        quickInputRef.current?.focus();
      });

      // Stage 3: Bulletproof timeout focus attempt (fires after browser mouse/selection events settle)
      const timer = setTimeout(() => {
        if (quickInputRef.current) {
          quickInputRef.current.focus();
          const len = quickInputRef.current.value.length;
          quickInputRef.current.setSelectionRange(len, len);
        }
      }, 120);

      return () => {
        cancelAnimationFrame(rId);
        clearTimeout(timer);
      };
    }
  }, [isOpen, focusTrigger]);

  // Auto-blur quick input when clicking elsewhere to release focus (without closing the agent dialogue)
  useEffect(() => {
    if (!isOpen) return;

    const handleDocumentClick = (e: PointerEvent) => {
      const formEl = quickInputRef.current?.form;
      const target = e.target as HTMLElement;
      
      // If the target is NOT inside the form, blur the input to cancel focus, but KEEP the dialogue open!
      if (formEl && !formEl.contains(target)) {
        quickInputRef.current?.blur();
      }
    };

    // Listen with capture on pointerdown to intercept click-away gestures across the application
    document.addEventListener('pointerdown', handleDocumentClick, true);
    return () => {
      document.removeEventListener('pointerdown', handleDocumentClick, true);
    };
  }, [isOpen]);

  // Animate the agent's canvas position smoothly when moved programmatically
  const agentCanvasX = useMotionValue(agentState.x);
  const agentCanvasY = useMotionValue(agentState.y);

  useEffect(() => {
    if (isDragging) {
      agentCanvasX.set(agentState.x);
      agentCanvasY.set(agentState.y);
    } else {
      const transition = isZooming 
        ? { type: 'tween', duration: 0.15, ease: 'easeOut' }
        : agentState.isMoving 
          ? { type: 'spring', damping: 28, stiffness: 450, mass: 0.35 }
          : { duration: 0 };
          
      animate(agentCanvasX, agentState.x, transition as any);
      animate(agentCanvasY, agentState.y, transition as any);
    }
  }, [agentState.x, agentState.y, isDragging, isZooming, agentState.isMoving, agentCanvasX, agentCanvasY]);

  // Derive screen position instantly from canvas position and viewport transform
  const targetScreenX = useTransform(
    [agentCanvasX, transform.tx, transform.tScale],
    ([ax, tx, s]: any[]) => ax * s + tx
  );
  
  const targetScreenY = useTransform(
    [agentCanvasY, transform.ty, transform.tScale],
    ([ay, ty, s]: any[]) => ay * s + ty
  );

  const handlePointerDown = (e: React.PointerEvent) => {
    if (isAgentRunning) return;
    e.stopPropagation();
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    isAgentBoxSelectingRef.current = false;
    setIsAgentBoxSelecting(false);

    dragStartRef.current = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      startCanvasX: agentState.x,
      startCanvasY: agentState.y,
      hasMoved: false
    };

    // Start a 350ms long-press timer for Agent box-selection mode!
    longPressTimerRef.current = setTimeout(() => {
      if (dragStartRef.current && !dragStartRef.current.hasMoved) {
        isAgentBoxSelectingRef.current = true;
        setIsAgentBoxSelecting(true);
        onStartAgentBoxSelect?.(agentState.x, agentState.y);
      }
    }, 350);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragStartRef.current) return;
    e.stopPropagation();
    e.preventDefault();

    const dist = Math.hypot(e.clientX - dragStartRef.current.pointerX, e.clientY - dragStartRef.current.pointerY);
    if (!dragStartRef.current.hasMoved && dist > 3) {
      dragStartRef.current.hasMoved = true;
      if (!isAgentBoxSelectingRef.current) {
        if (longPressTimerRef.current) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
        setIsDragging(true);
      }
    }

    if (isAgentBoxSelectingRef.current) {
      const currentCanvasX = dragStartRef.current.startCanvasX + (e.clientX - dragStartRef.current.pointerX) / transform.tScale.get();
      const currentCanvasY = dragStartRef.current.startCanvasY + (e.clientY - dragStartRef.current.pointerY) / transform.tScale.get();
      onUpdateAgentBoxSelect?.(currentCanvasX, currentCanvasY);
    } else if (dragStartRef.current.hasMoved) {
      const dx = (e.clientX - dragStartRef.current.pointerX) / transform.tScale.get();
      const dy = (e.clientY - dragStartRef.current.pointerY) / transform.tScale.get();

      const newX = dragStartRef.current.startCanvasX + dx;
      const newY = dragStartRef.current.startCanvasY + dy;

      onDragAgent?.(newX, newY);
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }

    if (!dragStartRef.current) return;
    e.stopPropagation();
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}

    const wasBoxSelecting = isAgentBoxSelectingRef.current;
    const wasMoved = dragStartRef.current.hasMoved;
    const dx = (e.clientX - dragStartRef.current.pointerX) / transform.tScale.get();
    const dy = (e.clientY - dragStartRef.current.pointerY) / transform.tScale.get();
    const finalX = dragStartRef.current.startCanvasX + dx;
    const finalY = dragStartRef.current.startCanvasY + dy;

    setIsDragging(false);
    setIsAgentBoxSelecting(false);
    isAgentBoxSelectingRef.current = false;
    dragStartRef.current = null;

    if (wasBoxSelecting) {
      onEndAgentBoxSelect?.();
    } else if (!wasMoved) {
      onClickPointer?.();
    } else {
      onDragAgentEnd?.(finalX, finalY, e.clientX, e.clientY);
      // 🚀 Bulletproof delayed focus on drag release to bypass browser mouseup focus-clearing cycles
      setTimeout(() => {
        if (quickInputRef.current) {
          quickInputRef.current.focus();
          const len = quickInputRef.current.value.length;
          quickInputRef.current.setSelectionRange(len, len);
        }
      }, 150);
    }
  };

  return (
    <motion.div
      className="fixed top-0 left-0 z-[9999] flex items-center select-none pointer-events-none"
      style={{ x: targetScreenX, y: targetScreenY }}
      initial={false}
      animate={{ 
        opacity: agentState.visible ? 1 : 0,
        scale: agentState.isActive ? 0.9 : isDragging ? 1.08 : 1
      }}
      transition={{ 
        opacity: { duration: 0.2 },
        scale: { type: 'spring', damping: 15, stiffness: 200 }
      }}
    >
      {/* Floating Wrapper that animates both the Cursor and Speech Bubble together on GPU Compositor */}
      <div
        className={`relative flex items-center ${!isDragging && isIdle ? 'animate-agent-float' : ''}`}
        style={{
          willChange: 'transform',
          transform: 'translate3d(0,0,0)',
          backfaceVisibility: 'hidden',
        }}
      >
        {/* Agent Pointer Cursor */}
        <div
          className="relative group cursor-grab active:cursor-grabbing p-2 -m-2 touch-none pointer-events-auto shrink-0"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {agentState.cursorMode === 'working' && isAgentRunning !== false && !effectiveIsThinking ? (
            <svg
              width="36"
              height="36"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="drop-shadow-lg relative z-10 transition-transform group-hover:scale-110 active:scale-95 cursor-pointer animate-pulse"
              style={{ marginLeft: '-4.5px', marginTop: '-3.5px' }}
            >
              <path
                d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z"
                fill={pointerFill}
                stroke={pointerStroke}
                strokeWidth="1.8"
                strokeLinejoin="round"
              />
              <circle cx="12" cy="12" r="2" fill="#ffffff" />
            </svg>
          ) : agentState.cursorMode === 'interact' ? (
            <svg
              width="36"
              height="36"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="drop-shadow-lg relative z-10 transition-transform group-hover:scale-110 active:scale-95 cursor-pointer"
              style={{ marginLeft: '-4.5px', marginTop: '-3.5px' }}
            >
              <path
                d="M8 13V4.5C8 3.67 8.67 3 9.5 3C10.33 3 11 3.67 11 4.5V11.5M11 11.5V6C11 5.17 11.67 4.5 12.5 4.5C13.33 4.5 14 5.17 14 6V11.5M14 11.5V7.5C14 6.67 14.67 6 15.5 6C16.33 6 17 6.67 17 7.5V13.5C17 17.5 14 21 10 21C6.5 21 4 18 4 14.5C4 13.5 4.5 12.5 5.5 11.5L8 13Z"
                fill={pointerFill}
                stroke={pointerStroke}
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg
              width="36"
              height="36"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
              className="drop-shadow-lg relative z-10 transition-transform group-hover:scale-110 active:scale-95 cursor-pointer"
              style={{ marginLeft: '-4.5px', marginTop: '-3.5px' }}
            >
              <path
                d="M4.5 3.5L19.5 11.5L12 13L10.5 20.5L4.5 3.5Z"
                fill={pointerFill} 
                stroke={pointerStroke}
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </div>
        
        {/* Stacked Agent HUD beside Cursor */}
        <div className="absolute left-7.5 top-0.5 flex flex-col gap-1.5 items-start pointer-events-none">
          {/* Primary Speech Row Anchor (Level with Agent Mouse Cursor Pointer) */}
          <div className="relative pointer-events-none min-h-[30px] flex items-center">
            {/* Row 1: Memory shelf - Anchored stably ABOVE Row 2 */}
            <AnimatePresence>
              {row1Message && (
                <motion.div
                  key={row1Message.text}
                  initial={isSubmitting ? { opacity: 1, y: 64, scale: 1 } : { opacity: 0, scale: 0.82, y: 0 }}
                  animate={{ opacity: 0.88, y: 0, scale: 0.96 }}
                  exit={isSubmitting ? { 
                    opacity: 0, 
                    y: -30, 
                    scale: 0.92,
                    transition: { duration: 0.24, ease: [0.16, 1, 0.3, 1] } 
                  } : { 
                    opacity: 0, 
                    scale: 0.82,
                    y: 0, 
                    transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] } 
                  }}
                  transition={isSubmitting ? { duration: 0.32, ease: [0.16, 1, 0.3, 1] } : { duration: 0.20, ease: [0.16, 1, 0.3, 1] }}
                  style={{ transformOrigin: '0% 100%' }}
                  className="absolute bottom-full mb-1.5 left-0 pointer-events-none select-none shrink-0 z-20 origin-bottom-left"
                >
                  <div className="relative px-3 py-1 flex items-center">
                    <div 
                      className={`absolute inset-0 rounded-xl corner-squircle ${historyBubbleBgClass}`} 
                      style={{
                        willChange: 'transform',
                        transform: 'translate3d(0,0,0)',
                        backfaceVisibility: 'hidden',
                      }}
                    />
                    <div className="relative z-10 flex items-center max-w-[340px]" style={{ transform: 'translateZ(0)' }}>
                      <SingleLineMarquee 
                        text={row1Message.text} 
                        isDarkMode={isDarkMode} 
                        isHistory={true} 
                        speaker={row1Message.speaker} 
                      />
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
   
            {/* Row 2: Speaking Text UI - Level with Cursor Pointer */}
            <AnimatePresence mode="wait">
              {row2Content && (
                <motion.div
                  key={row2Content.text}
                  initial={{ opacity: 0, scale: 0.82, y: 0 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={isSubmitting ? { 
                    opacity: 0, 
                    y: -50,
                    scale: 0.92,
                    transition: { duration: 0.28, ease: [0.16, 1, 0.3, 1] } 
                  } : { 
                    opacity: 0, 
                    scale: 0.82,
                    y: 0,
                    transition: { duration: 0.18, ease: [0.16, 1, 0.3, 1] } 
                  }}
                  transition={{ duration: 0.20, ease: [0.16, 1, 0.3, 1] }}
                  style={{ transformOrigin: '0% 50%' }}
                  className="pointer-events-none select-none shrink-0 origin-left"
                >
                  <div className="relative px-3.5 py-1.5 flex items-center origin-left">
                    <div 
                      className={`absolute inset-0 rounded-xl corner-squircle ${bubbleBgClass}`} 
                      style={{
                        willChange: 'transform',
                        transform: 'translate3d(0,0,0)',
                        backfaceVisibility: 'hidden',
                      }}
                    />
                    <div className="relative z-10 flex items-center" style={{ transform: 'translateZ(0)' }}>
                      <SingleLineMarquee text={row2Content.text} isDarkMode={isDarkMode} speaker={row2Content.type} />
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
 
          {/* Row 3: Quick Input Box - Spaced naturally below the speaking bubble, moves UP when submitted */}
          <AnimatePresence>
            {quickInput?.isOpen && (
              <motion.div
                initial={{ opacity: 0, y: -2, scale: 0.96 }}
                animate={isSubmitting ? { opacity: 0, scale: 0.96 } : { opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.14, ease: [0.16, 1, 0.3, 1] } }}
                transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
                className="pointer-events-auto select-none shrink-0"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <div className="relative flex items-center w-[290px]">
                  <div 
                    className={`absolute inset-0 rounded-xl corner-squircle ${bubbleBgClass}`} 
                    style={{
                      willChange: 'transform',
                      transform: 'translate3d(0,0,0)',
                      backfaceVisibility: 'hidden',
                    }}
                  />
                  
                  <form
                    onSubmit={handleFormSubmit}
                    className="relative z-10 flex items-center w-full px-3 py-1 gap-1.5"
                  >
                    <input
                      ref={quickInputRef}
                      type="text"
                      value={quickInput?.value || ''}
                      onChange={(e) => quickInput?.onChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          quickInput.onClose();
                        }
                      }}
                      placeholder={quickInput.placeholder || "输入你的想法..."}
                      style={{
                        transform: 'translateZ(0)',
                        backfaceVisibility: 'hidden',
                        WebkitFontSmoothing: 'antialiased',
                      }}
                      className={`flex-1 min-w-0 bg-transparent text-[13px] font-medium outline-none leading-none py-1 antialiased ${isDarkMode ? 'caret-[#a45cf8]' : 'caret-[#a855f7]'} ${inputClass} ${placeholderClass}`}
                    />
                    <button
                      type="submit"
                      disabled={!(quickInput?.value || '').trim() || submitStep !== 'idle'}
                      className={`w-6 h-6 rounded-full flex items-center justify-center transition-all shrink-0 ${
                        (quickInput?.value || '').trim() && submitStep === 'idle'
                          ? buttonClassActive + ' cursor-pointer active:scale-95'
                          : buttonClassInactive + ' cursor-not-allowed'
                      }`}
                    >
                      <motion.div
                        animate={isSubmitting ? { y: -8, opacity: 0, scale: 0.6 } : { y: 0, opacity: 1, scale: 1 }}
                        transition={{ duration: 0.14, ease: 'easeIn' }}
                      >
                        <ArrowUp size={13} strokeWidth={2.5} />
                      </motion.div>
                    </button>
                  </form>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}
