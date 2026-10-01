import React, { useEffect } from 'react';
import { Sparkles, Image as ImageIcon, Trash2, Wand2, Video } from 'lucide-react';
import { motion } from 'motion/react';
import type { CardData } from './GenerationCard';

interface AgentContextMenuProps {
  key?: string;
  isOpen: boolean;
  x: number;
  y: number;
  targetId: string | null;
  targetCard?: CardData | null;
  agentPrompt?: string;
  onPromptChange?: (val: string) => void;
  onSubmit?: () => void;
  onClose: () => void;
  onAction: (actionType: string, targetId: string | null) => void;
}

export function AgentContextMenu({
  isOpen,
  x,
  y,
  targetId,
  targetCard: _targetCard,
  onClose,
  onAction,
}: AgentContextMenuProps) {

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Viewport clamping
  const menuWidth = 260;
  const clampedX = typeof window !== 'undefined' ? Math.max(12, Math.min(x, window.innerWidth - menuWidth - 20)) : x;
  const clampedY = typeof window !== 'undefined' ? Math.max(12, Math.min(y, window.innerHeight - 240)) : y;

  return (
    <div
      className="fixed z-[100] flex flex-col gap-2 pointer-events-auto select-none"
      style={{ top: clampedY, left: clampedX }}
      onPointerDown={e => e.stopPropagation()} // Prevent canvas drag
      onContextMenu={e => e.preventDefault()} // Prevent another context menu inside
    >
      {/* Main Menu Panel */}
      <motion.div
        initial={{ opacity: 0, y: 5 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 5 }}
        transition={{ duration: 0.15 }}
        className="bg-gray-100 dark:bg-neutral-800 border border-gray-200/80 dark:border-[#404040]/80 shadow-[0_12px_40px_rgb(0,0,0,0.12)] rounded-2xl corner-squircle w-[260px] overflow-hidden"
      >
        {/* Quick Actions */}
        <div className="p-1.5 flex flex-col">
          {targetId ? (
            <>
              <ActionButton icon={<Wand2 size={14} />} label="生成变体" onClick={() => { onAction('variant', targetId); onClose(); }} />
              <ActionButton icon={<Video size={14} />} label="以此图生视频" onClick={() => { onAction('video_from_card', targetId); onClose(); }} />
              <ActionButton icon={<ImageIcon size={14} />} label="设为参考图" onClick={() => { onAction('reference', targetId); onClose(); }} />
              <ActionButton icon={<Trash2 size={14} />} label="删除卡片" destructive onClick={() => { onAction('delete', targetId); onClose(); }} />
            </>
          ) : (
            <>
              <ActionButton icon={<Sparkles size={14} />} label="新建生图卡片" onClick={() => { onAction('new_card', null); onClose(); }} />
              <ActionButton icon={<Video size={14} />} label="新建生视频卡片" onClick={() => { onAction('new_video_card', null); onClose(); }} />
              <ActionButton icon={<Trash2 size={14} />} label="清理画布" destructive onClick={() => { onAction('clear', null); onClose(); }} />
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}

function ActionButton({ icon, label, onClick, destructive = false }: { icon: React.ReactNode; label: string; onClick: () => void; destructive?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] font-medium transition-colors text-left cursor-pointer ${
        destructive 
          ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/60' 
          : 'text-gray-700 dark:text-neutral-300 hover:bg-gray-200 dark:hover:bg-neutral-700/60'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
