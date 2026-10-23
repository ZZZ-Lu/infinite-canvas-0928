// Renderer-only group state: all members share one world-space pivot and clock.
type EntryGroup = { start: number; x: number; y: number };
const entries = new Map<string, EntryGroup>();
const awaitingEntryDom = new Set<string>();
let project: string | null = null;
let known = new Set<string>();
// Only creation/import commands may authorize individual entrances. Never persist.
const requested = new Map<string, string>();
export function requestCardEntries(projectId: string, ids: string[]) {
  for (const id of ids) requested.set(id, projectId);
}
export const CARD_ENTRY_MS = 450;
export function registerCardEntries(projectId: string, cards: { id: string; x: number; y: number; width: number; height: number }[], visible: Set<string>, now: number, reduced: boolean, pivot: { x: number; y: number }) {
  const isProjectEntry = project !== projectId;
  if (isProjectEntry) { project = projectId; known = new Set(); entries.clear(); awaitingEntryDom.clear(); }
  const next = new Set(cards.map(card => card.id));
  const added = reduced ? [] : cards.filter(card => !known.has(card.id) && visible.has(card.id) && (isProjectEntry || requested.get(card.id) === projectId));
  if (added.length) {
    const group: EntryGroup = { start: now, x: pivot.x, y: pivot.y };
    for (const card of added) {
      if (!isProjectEntry) awaitingEntryDom.add(card.id);
      entries.set(card.id, isProjectEntry ? group : { start: now, x: card.x + card.width / 2, y: card.y + card.height / 2 });
    }
  }
  for (const [id, group] of entries) if (!next.has(id) || (group.start !== undefined && now >= group.start + CARD_ENTRY_MS)) entries.delete(id);
  for (const id of awaitingEntryDom) if (!next.has(id)) awaitingEntryDom.delete(id);
  // Consume even offscreen/reduced-motion requests; a later viewport change is not entry.
  for (const [id, owner] of requested) if (next.has(id) || owner !== projectId) requested.delete(id);
  for (const id of next) known.add(id);
  // Only whole-project entrances trigger the shared blur overlay.
  // New cards retain their individual entry animation without blurring the page.
  return isProjectEntry && added.length > 0;
}
// Accelerate into the canvas, then give one small scale pulse on landing.
export function sampleCardEntry(progress: number) {
  const t = Math.max(0, Math.min(1, progress));
  const smooth = (v: number) => v * v * (3 - 2 * v);
  // Land at 72%, expand gently to 101.8%, then settle at normal size.
  const scale = t < 0.72
    ? 1 + 0.38 * (1 - Math.pow(t / 0.72, 4))
    : t < 0.86
      ? 1 + 0.018 * smooth((t - 0.72) / 0.14)
      : 1 + 0.018 * (1 - smooth((t - 0.86) / 0.14));
  return { scale, opacity: 1 };
}
export function cardEntryFrame(id: string, now = performance.now(), keyframes = false) {
  const group = entries.get(id);
  if (!group) return null;
  const start = group.start;
  if (now >= start + CARD_ENTRY_MS) { entries.delete(id); return null; }
  const progress = Math.max(0, (now - start) / CARD_ENTRY_MS);
  const samples = keyframes ? Array.from({ length: 41 }, (_, i) => sampleCardEntry(progress + (1 - progress) * i / 40)) : [];
  return { pivotX: group.x, pivotY: group.y, ...sampleCardEntry(progress), scales: samples.map(frame => frame.scale), opacities: samples.map(frame => frame.opacity), delay: Math.max(0, start - now) / 1000, duration: (1 - progress) * CARD_ENTRY_MS / 1000 };
}

// New cards at DOM scale wait for that renderer rather than showing a nano placeholder.
// Retire this one-time guard only after the normal painted/panel-ready handshake.
export function waitForEntryDom(id: string, ready: boolean) {
  if (!awaitingEntryDom.has(id)) return false;
  if (ready) awaitingEntryDom.delete(id);
  return true;
}
export function isNewCardAwaitingLod(id: string) { return awaitingEntryDom.has(id); }
