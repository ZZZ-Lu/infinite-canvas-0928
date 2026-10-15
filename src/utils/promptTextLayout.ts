/** Browser CSS line layout, used only to produce a cached rendering bitmap. */
const layouts = new Map<string, { lines: { text: string; start: number }[]; baseline: number }>();
let layoutCharacters = 0;
export function layoutPromptText(content: string, width: number, style: CSSStyleDeclaration) {
  const key = JSON.stringify([content, width, style.font, style.letterSpacing]);
  const cached = layouts.get(key);
  if (cached) { layouts.delete(key); layouts.set(key, cached); return cached; }
  const mirror = document.createElement('div');
  Object.assign(mirror.style, {
    position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden', pointerEvents: 'none',
    width: `${width}px`, padding: '0', margin: '0', border: '0',
    font: style.font, fontFamily: style.fontFamily, fontWeight: style.fontWeight,
    fontSize: style.fontSize, lineHeight: '22px', letterSpacing: style.letterSpacing,
    whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineBreak: 'anywhere', overflowWrap: 'anywhere',
  });
  mirror.setAttribute('aria-hidden', 'true');
  document.body.appendChild(mirror);
  try {
    mirror.appendChild(document.createTextNode('Hg'));
    const marker = document.createElement('span');
    Object.assign(marker.style, { display: 'inline-block', width: '0', height: '0', padding: '0', margin: '0' });
    mirror.appendChild(marker);
    const baseline = marker.getBoundingClientRect().top - mirror.getBoundingClientRect().top;
    const lines: { text: string; start: number }[] = [];
    let offset = 0;
    for (const paragraph of content.split('\n')) {
      const node = document.createTextNode(paragraph);
      mirror.replaceChildren(node);
      if (!paragraph) lines.push({ text: '', start: offset });
      else {
        const range = document.createRange();
        const topAt = (index: number) => {
          range.setStart(node, index); range.setEnd(node, index + 1);
          return range.getBoundingClientRect().top;
        };
        let start = 0;
        while (start < paragraph.length) {
          const top = topAt(start);
          let low = start + 1, high = paragraph.length;
          while (low < high) {
            const mid = Math.floor((low + high) / 2);
            if (topAt(mid) > top + 1) high = mid;
            else low = mid + 1;
          }
          lines.push({ text: paragraph.slice(start, low), start: offset + start });
          start = low;
        }
      }
      offset += paragraph.length + 1;
    }
    const result = { lines, baseline };
    // Survives card unmount and shares identical prompts across duplicate cards.
    if (key.length <= 500000) {
      while (layouts.size && (layouts.size >= 128 || layoutCharacters + key.length > 500000)) {
        const oldest = layouts.keys().next().value!;
        layouts.delete(oldest); layoutCharacters -= oldest.length;
      }
      layouts.set(key, result); layoutCharacters += key.length;
    }
    return result;
  } finally { mirror.remove(); }
}
