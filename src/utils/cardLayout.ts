/**
 * Calculates the exact height of the generation card bottom panel in pixels,
 * matching Full Detail DOM CSS box model:
 * 
 * Outer Container:
 * - border: 1px top + 1px bottom (2px)
 * - p-4: top padding 16px, bottom padding 16px (32px)
 * - flex flex-col gap-2: 8px gap between direct children
 * 
 * Direct Children:
 * 1. Reference images container (ALWAYS rendered in Full Detail DOM via the + Add Button):
 *    - 448px content width / 56px per item = 8 items per row
 *    - total items = referenceCount + 1 (the + Add Button is always present)
 *    - rows = Math.ceil((referenceCount + 1) / 8)
 *    - height = rows * 56 - 8
 *    - gap-2 after ref container = 8px
 *    - Total ref section contribution = rows * 56
 * 
 * 2. Prompt area container:
 *    - mt-1 = 4px
 *    - font: text-[14px] leading-[22px] min-h-[50px] max-h-[300px]
 *    - 448px available content width / 14px per CJK char = 32 CJK chars per line (~58 ASCII chars)
 *    - prompt height = Math.max(50, Math.min(300, lines * 22))
 *    - Total prompt section contribution = 4 + prompt height
 * 
 * 3. Bottom action bar container:
 *    - gap-2 before action bar = 8px
 *    - mt-2 (8px) + pt-2 (8px) + border-t (1px) + controls (32px) = 49px
 * 
 * Total Panel Height = 2 (border) + 32 (padding) + 49 (action bar) + 8 (gap) + (rows * 56) + 4 (mt-1) + promptHeight
 *                    = 95 + (rows * 56) + promptHeight
 * 
 * Minimum Panel Height (empty prompt, 0 refs) = 95 + 56 + 50 = 201px
 * Maximum Panel Height (max prompt 300px, 1 row refs) = 95 + 56 + 300 = 451px
 */

export function calculatePromptLines(promptText: string | undefined | null): number {
  if (!promptText) return 1;
  return promptText.split('\n').reduce((acc, line) => {
    if (!line) return acc + 1;
    let weight = 0;
    for (let i = 0; i < line.length; i++) {
      const code = line.charCodeAt(i);
      weight += (code > 255) ? 1 : 0.55;
    }
    return acc + Math.max(1, Math.ceil(weight / 32));
  }, 0);
}

export function getPromptAreaHeight(promptText: string | undefined | null): number {
  const lines = calculatePromptLines(promptText);
  // Full Detail DOM textarea min-h-[50px] max-h-[300px] with leading-[22px]
  return Math.max(50, Math.min(300, lines * 22));
}

export function getBottomPanelHeight(promptText: string | undefined | null, referenceCount: number | undefined | null): number {
  const refCount = referenceCount || 0;
  const refRows = Math.ceil((refCount + 1) / 8);
  const refSectionHeight = refRows * 56;
  const promptHeight = getPromptAreaHeight(promptText);

  return 95 + refSectionHeight + promptHeight;
}
