// Renderer-only group state: all members share one world-space pivot and clock.
type EntryGroup = { start?: number; x: number; y: number };
const entries = new Map<string, EntryGroup>();
let project: string | null = null;
let known = new Set<string>();
export const CARD_ENTRY_MS = 360;
export function registerCardEntries(projectId: string, cards: { id: string; x: number; y: number; width: number; height: number }[], visible: Set<string>, now: number, reduced: boolean, pivot: { x: number; y: number }) {
  if (project !== projectId) { project = projectId; known = new Set(); entries.clear(); }
  const next = new Set(cards.map(card => card.id));
  const added = reduced ? [] : cards.filter(card => !known.has(card.id) && visible.has(card.id));
  if (added.length) {
    const group: EntryGroup = { x: pivot.x, y: pivot.y };
    for (const card of added) entries.set(card.id, group);
  }
  for (const [id, group] of entries) if (!next.has(id) || (group.start !== undefined && now >= group.start + CARD_ENTRY_MS)) entries.delete(id);
  known = next;
}
// Accelerate toward the surface and brake to rest without overshoot.
export function sampleCardEntry(progress: number) {
  const t = Math.max(0, Math.min(1, progress));
  const smooth = (v: number) => v * v * (3 - 2 * v);
  // Cubic acceleration/deceleration: low launch speed, pronounced peak, firm stop.
  const travel = t < 0.6
    ? 0.6 * Math.pow(t / 0.6, 3)
    : 1 - 0.4 * Math.pow((1 - t) / 0.4, 3);
  const scale = 1 + 0.38 * (1 - travel);
  return { scale, opacity: smooth(Math.min(1, t / 0.22)) };
}
export function cardEntryFrame(id: string, now = performance.now(), keyframes = false) {
  const group = entries.get(id);
  if (!group) return null;
  group.start ??= now;
  const start = group.start;
  if (now >= start + CARD_ENTRY_MS) return null;
  const progress = Math.max(0, (now - start) / CARD_ENTRY_MS);
  const samples = keyframes ? Array.from({ length: 41 }, (_, i) => sampleCardEntry(progress + (1 - progress) * i / 40)) : [];
  return { pivotX: group.x, pivotY: group.y, ...sampleCardEntry(progress), scales: samples.map(frame => frame.scale), opacities: samples.map(frame => frame.opacity), delay: Math.max(0, start - now) / 1000, duration: (1 - progress) * CARD_ENTRY_MS / 1000 };
}
