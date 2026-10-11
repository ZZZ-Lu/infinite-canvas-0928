# Fix Multi-Card Agent Focus Rendering in Nano LOD Mode

Ensure that when the Agent focuses on multiple cards (e.g., multi-card inspection, quick input on multiple selected images, or batch focus tool calls), all focused cards display solid purple focus borders and Agent status badges in Nano LOD canvas mode, matching Full LOD DOM behavior.

> [!IMPORTANT] Confirmed Requirements
> - **Solid Focus Borders**: All Agent-focused cards in Nano LOD mode will be rendered with solid purple focus borders (`#9333ea`), matching DOM focus styling.
> - **Status Badges & Labels**: Agent status badges (e.g. "Mira 正在查看", "选了 2 张图片") will be rendered on canvas for all focused cards in Nano LOD mode when scale permits.

---

## 1. Overview & Core Concept

### What It Does
When the Agent operates on or inspects multiple cards simultaneously on the infinite canvas, switching or zooming out to Nano LOD canvas mode (`scale < 0.40`) currently renders only a single primary card with focus styling. This fix propagates the complete multi-card Agent focus snapshot (`agentFocus.focusedMap` and `agentQuickInput.targetIds`) into `NanoLodCanvas`, rendering solid purple focus borders and status badges across all focused cards.

### Target Audience / Persona
Users interacting with the Mira Agent while zoomed out on a large canvas, enabling seamless multi-card visual feedback during batch operations, image comparisons, or multi-reference prompts.

---

## 2. User Experience & Visual Design

### Key User Flows
1. **Multi-Card Quick Input / Inspection**: User selects multiple image cards and triggers Agent Quick Input or Agent inspection tool.
2. **Full LOD View**: Both cards display solid glowing purple borders with "Mira 正在查看" badges and speech overlays.
3. **Zoom Out to Nano LOD**: Canvas switches to 2D Canvas rendering (`NanoLodCanvas`).
4. **Expected Result**: All focused cards render with solid purple focus borders (`#9333ea`) and top status badges, maintaining visual parity with Full LOD mode.

### Visual Identity & Theme
- **Agent Focus Border Color**: `#9333ea` (Purple-600) solid stroke.
- **Agent Badge**: Semi-transparent purple rounded badge (`rgba(147, 51, 234, 0.9)`) with crisp white text ("Mira 正在查看").
- **Co-Presence Border**: Double stroke (user selection blue `#3b82f6` inner + Agent purple `#9333ea` outer) when a card is both user-selected and Agent-focused.

---

## 3. Technical Architecture & Data Strategy

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Agent Focus State Manager                         │
│                    (agentFocusManager.ts & agentQuickInput)                 │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                      agentFocusSnapshot & targetIds[]
                                       │
                ┌──────────────────────┴──────────────────────┐
                ▼                                             ▼
┌───────────────────────────────┐             ┌───────────────────────────────┐
│     DOM Layer (Full LOD)      │             │   Canvas Layer (Nano LOD)     │
│    GenerationCard.tsx (DOM)   │             │      NanoLodCanvas.tsx        │
│   - Reads focusedMap[id]      │             │   - Accepts targetCardIds Set │
│   - Solid purple focus border │             │   - Renders solid purple      │
│   - Renders DOM status badge  │             │     borders & canvas badges   │
└───────────────────────────────┘             └───────────────────────────────┘
```

### Key Changes Needed in Codebase

1. **`src/components/NanoLodCanvas.tsx`**:
   - Update `NanoLodCanvasProps` to accept `agentTargetCardIds?: string[] | Set<string>` and `agentFocusMap?: Record<string, { role: string; sourceTool: string }>` in addition to primary/reference IDs.
   - Update card rendering loop to check if `card.id` is in `agentTargetCardIds` or `agentFocusMap`.
   - Render solid purple border (`#9333ea`) with standard focus stroke width for all focused cards (removing single-card restriction).
   - Draw canvas-native Agent status badge on top of each Agent-focused card when screen width $\ge 30\text{px}$.

2. **`src/App.tsx`**:
   - Compute `agentTargetCardIds` as a combined Set of `agentFocus.primaryCardId`, `agentFocus.referenceCardIds`, cards in `agentFocus.focusedMap`, and `agentQuickInput?.targetIds` or `agentQuickInput?.targetId`.
   - Pass `agentTargetCardIds` to `<NanoLodCanvas />`.

---

## 4. Pre-Flight & Performance Checklist

- [x] Pure data-DOM decoupling preserved (`agentFocusManager` data model is SSOT).
- [x] Zero-flicker handoff between DOM and Canvas LOD layers.
- [x] Single-pass canvas drawing in O(N) spatial quad-tree query.
- [x] Checked against `AGENTS.md` and `frontend-design` guidelines.
