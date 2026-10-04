import React, { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { motion, MotionValue, useTransform, useMotionValue, animate, AnimatePresence } from 'motion/react';
import { ArrowUp } from 'lucide-react';

export interface QuickInputConfig {
  isOpen: boolean;
  targetId: string | null;
  placeholder?: string;
  lastReply?: string;
  onSubmit: (text: string) => void;
  onClose: () => void;
  focusTrigger?: number;
  value: string;
  onChange: (text: string) => void;
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
    cursorMode?: 'default' | 'inspect' | 'working' | 'interact';
  };
  transform: {
    tx: MotionValue<number>;
    ty: MotionValue<number>;
    tScale: MotionValue<number>;
  };
  isIdle?: boolean;
  isZooming?: boolean;
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

function SingleLineMarquee({ 
  text, 
  isDarkMode, 
  isHistory = false 
}: { 
  text: string; 
  isDarkMode?: boolean; 
  isHistory?: boolean; 
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  const cleanText = (text || '').trim();
  const isThinking = !cleanText || cleanText === '...' || cleanText === 'thinking' || cleanText === 'loading';

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

  const textStyleClass = isHistory
    ? (isDarkMode 
        ? "inline-block text-[12px] font-medium leading-none text-[#a45cf8]/55 tracking-wide antialiased"
        : "inline-block text-[12px] font-medium leading-none text-purple-600/55 tracking-wide antialiased")
    : (isDarkMode 
        ? "inline-block text-[13px] font-semibold leading-none text-[#a45cf8] tracking-wide antialiased"
        : "inline-block text-[13px] font-semibold leading-none text-purple-600 tracking-wide antialiased");

  const dotColorClass = isHistory
    ? (isDarkMode ? 'bg-[#a45cf8]/40' : 'bg-purple-600/40')
    : (isDarkMode ? 'bg-[#a45cf8]' : 'bg-purple-600');

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
        <span className="flex items-center gap-1 px-1 py-1 shrink-0">
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
  // Step 1: 'user-at-row2' - User's dialogue first moves to the 2nd row
  // Step 2: 'user-at-row1' - User's dialogue promoted to 1st row, while agent's new dialogue emerges and grows in 2nd row
  const [submitStep, setSubmitStep] = useState<'idle' | 'user-at-row2' | 'user-at-row1'>('idle');
  const [submittedUserPrompt, setSubmittedUserPrompt] = useState<string | null>(null);

  const isThinkingMode = agentState.speak === '正在思考...' || agentState.speak === '...' || agentState.speak === 'thinking' || agentState.speak === 'loading';

  // When quickInput opens or target card changes, settle state and clear any old transient submitted prompt
  useEffect(() => {
    if (quickInput?.isOpen) {
      setSubmitStep('idle');
      setSubmittedUserPrompt(null);
    }
  }, [quickInput?.isOpen, quickInput?.targetId]);

  useEffect(() => {
    if (!agentState.speak && !quickInput?.isOpen) {
      setSubmitStep('idle');
      setSubmittedUserPrompt(null);
    }
  }, [agentState.speak, quickInput?.isOpen]);

  // Row 1 (Top History/Context):
  // 1. While quickInput is open: strictly show THIS specific card's conversation history (quickInput.lastReply).
  //    If this card has no history, Row 1 is null.
  // 2. When submitting and user text is temporarily in Row 2 (Stage 1, 260ms): Row 1 is null.
  // 3. During task execution & agent response (quickInput is closed, agent is active):
  //    Row 1 displays the prompt issued for this task (submittedUserPrompt || agentState.lastPrompt).
  const rawHistoryText = quickInput?.isOpen
    ? (quickInput.lastReply || null)
    : (
        submitStep === 'user-at-row2'
          ? null
          : (submittedUserPrompt || agentState.lastPrompt || null)
      );

  // Deduplication guard: Never display identical text simultaneously in Row 1 and Row 2
  const historyText = rawHistoryText && rawHistoryText.trim() !== (agentState.speak || '').trim()
    ? rawHistoryText
    : null;

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const val = quickInput?.value || '';
    const clean = val.trim();
    if (!clean || submitStep !== 'idle') return;

    // Stage 1 (0ms): User's dialogue takes over Row 2 from Row 3 below
    setSubmittedUserPrompt(clean);
    setSubmitStep('user-at-row2');

    // Stage 2 (260ms): User's dialogue is pushed up into Row 1; Agent's new dialogue grows from left-to-right in Row 2
    setTimeout(() => {
      setSubmitStep('user-at-row1');
      quickInput?.onSubmit(clean);
    }, 260);
  };

  const row2Content = submitStep === 'user-at-row2'
    ? { type: 'user' as const, text: submittedUserPrompt || '' }
    : (agentState.speak ? { type: 'agent' as const, text: agentState.speak, isThinking: isThinkingMode } : null);

  // Tracks horizontal breathing morphing (squeeze & expand) for text updates within the single persistent bubble
  const [morphTrigger, setMorphTrigger] = useState(0);
  const prevSpeakRef = useRef<string | undefined>(agentState.speak);

  useEffect(() => {
    if (
      prevSpeakRef.current && 
      agentState.speak && 
      prevSpeakRef.current !== agentState.speak &&
      submitStep !== 'user-at-row2'
    ) {
      setMorphTrigger(c => c + 1);
    }
    prevSpeakRef.current = agentState.speak;
  }, [agentState.speak, submitStep]);

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
  const textClass = isDarkMode ? 'text-[#a45cf8] font-semibold' : 'text-purple-600 font-semibold';
  const placeholderClass = isDarkMode ? 'placeholder-[#a45cf8]/45' : 'placeholder-purple-500/45';
  const inputClass = isDarkMode ? 'text-[#a45cf8]' : 'text-purple-600';
  const buttonClassActive = isDarkMode ? 'bg-[#a45cf8]/15 hover:bg-[#a45cf8]/25 text-[#a45cf8]' : 'bg-purple-500/10 hover:bg-purple-500/20 text-purple-600';
  const buttonClassInactive = isDarkMode ? 'text-[#a45cf8]/30' : 'text-purple-500/35';

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
          {agentState.cursorMode === 'working' ? (
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
          <div className="relative pointer-events-none">
            {/* Row 1: Memory shelf - Anchored stably ABOVE Row 2 */}
            <AnimatePresence>
              {historyText && (
                <motion.div
                  key={historyText}
                  initial={{ opacity: 0, y: 6, scale: 0.95 }}
                  animate={{ opacity: 0.88, y: 0, scale: 0.96 }}
                  exit={{ opacity: 0, y: -6, scale: 0.92 }}
                  transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
                  className="absolute bottom-full mb-1.5 left-0 pointer-events-none select-none shrink-0 z-20 origin-bottom-left"
                >
                  <div className="relative px-3 py-1 flex items-center">
                    <div 
                      className={`absolute inset-0 rounded-full ${historyBubbleBgClass}`} 
                      style={{
                        willChange: 'transform',
                        transform: 'translate3d(0,0,0)',
                        backfaceVisibility: 'hidden',
                      }}
                    />
                    <div className="relative z-10 flex items-center max-w-[340px]" style={{ transform: 'translateZ(0)' }}>
                      <SingleLineMarquee text={historyText} isDarkMode={isDarkMode} isHistory={true} />
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
   
            {/* Row 2: Speaking Text UI - Level with Cursor Pointer */}
            <AnimatePresence mode="wait">
              {row2Content && (
                <motion.div
                  key={`${quickInput?.targetId || 'global'}-${row2Content.text}`}
                  initial={{ opacity: 0, scale: 0.82 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ 
                    opacity: 0, 
                    scale: 0.82,
                    transition: { duration: 0.28, ease: 'easeInOut' } 
                  }}
                  transition={{ duration: 0.38, ease: 'easeInOut' }}
                  style={{ transformOrigin: '0% 50%' }}
                  className="pointer-events-none select-none shrink-0 origin-left"
                >
                  <div className="relative px-3.5 py-1.5 flex items-center origin-left">
                    <div 
                      className={`absolute inset-0 rounded-full ${bubbleBgClass}`} 
                      style={{
                        willChange: 'transform',
                        transform: 'translate3d(0,0,0)',
                        backfaceVisibility: 'hidden',
                      }}
                    />
                    <div className="relative z-10 flex items-center" style={{ transform: 'translateZ(0)' }}>
                      <SingleLineMarquee text={row2Content.text} isDarkMode={isDarkMode} />
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
                animate={submitStep !== 'idle' ? { opacity: 0, y: -24, scale: 0.94 } : { opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -24, scale: 0.94, transition: { duration: 0.2, ease: [0.16, 1, 0.3, 1] } }}
                transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                className="pointer-events-auto select-none shrink-0"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <div className="relative flex items-center w-[290px]">
                  <div 
                    className={`absolute inset-0 rounded-full ${bubbleBgClass}`} 
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
                        animate={submitStep !== 'idle' ? { y: -8, opacity: 0, scale: 0.6 } : { y: 0, opacity: 1, scale: 1 }}
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
