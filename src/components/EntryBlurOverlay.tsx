import { useState } from 'react';
import { motion } from 'motion/react';
import { CARD_ENTRY_MS } from '../utils/cardEntrance';

// A single temporary compositor overlay, shared by DOM and Canvas renderers.
// Removed just before landing completes: no persistent filter or hit-test surface.
export function EntryBlurOverlay() {
  const [finished, setFinished] = useState(false);
  if (finished) return null;
  return <motion.div aria-hidden="true"
    className="fixed inset-0 pointer-events-none z-[200]"
    initial={{ backdropFilter: 'blur(24px)' }}
    animate={{ backdropFilter: 'blur(0px)' }}
    transition={{ duration: CARD_ENTRY_MS * 0.9 / 1000, ease: [0.55, 0, 0.85, 0.45] }}
    onAnimationComplete={() => setFinished(true)}
  />;
}
