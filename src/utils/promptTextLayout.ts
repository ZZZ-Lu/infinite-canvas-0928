/** Browser CSS line layout, used only to produce a cached rendering bitmap. */
const layouts = new Map<string, { lines: { text: string; start: number }[]; baseline: number }>();
let layoutCharacters = 0;

export function layoutPromptText(
  content: string,
  width: number,
  style: CSSStyleDeclaration,
  mentionNames: string[] = []
) {
  const sortedNames = [...new Set(mentionNames.filter(Boolean))].sort((a, b) => b.length - a.length);
  const mentionKey = JSON.stringify(sortedNames);
  const key = JSON.stringify([content, width, style.fontFamily, style.fontWeight, style.fontSize, style.letterSpacing, mentionKey]);
  const cached = layouts.get(key);
  if (cached) {
    layouts.delete(key);
    layouts.set(key, cached);
    return cached;
  }

  const mirror = document.createElement('div');
  Object.assign(mirror.style, {
    position: 'fixed',
    left: '-100000px',
    top: '0',
    visibility: 'hidden',
    pointerEvents: 'none',
    width: `${width}px`,
    padding: '0',
    margin: '0',
    border: '0',
    fontFamily: style.fontFamily || 'inherit',
    fontWeight: style.fontWeight || '500',
    fontSize: style.fontSize || '14px',
    lineHeight: '22px',
    letterSpacing: style.letterSpacing || 'normal',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    lineBreak: 'anywhere',
    overflowWrap: 'anywhere',
    boxSizing: 'border-box',
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

    const pattern = sortedNames.length > 0
      ? new RegExp(`(@(?:${sortedNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}))`, 'g')
      : null;
    const validMentionTags = new Set(sortedNames.map(n => `@${n}`));

    for (const paragraph of content.split('\n')) {
      mirror.replaceChildren();

      if (!paragraph) {
        lines.push({ text: '', start: offset });
        offset += 1;
        continue;
      }

      // Recreate the exact same span structure as renderHighlightedPrompt in Native DOM
      if (pattern) {
        const parts = paragraph.split(pattern);
        for (const part of parts) {
          if (!part) continue;
          const span = document.createElement('span');
          if (validMentionTags.has(part)) {
            span.className = 'font-medium';
            span.style.borderRadius = '2px';
          }
          span.textContent = part;
          mirror.appendChild(span);
        }
      } else {
        const span = document.createElement('span');
        span.textContent = paragraph;
        mirror.appendChild(span);
      }

      // Collect all text nodes in document order
      const textNodes: { node: Text; start: number; length: number }[] = [];
      const walker = document.createTreeWalker(mirror, NodeFilter.SHOW_TEXT);
      let currOffset = 0;
      while (walker.nextNode()) {
        const node = walker.currentNode as Text;
        const len = node.textContent?.length || 0;
        textNodes.push({ node, start: currOffset, length: len });
        currOffset += len;
      }

      const range = document.createRange();
      const topAt = (index: number) => {
        if (index >= paragraph.length) {
          if (textNodes.length === 0) return 0;
          const last = textNodes[textNodes.length - 1];
          range.setStart(last.node, last.length);
          range.setEnd(last.node, last.length);
          return range.getBoundingClientRect().top;
        }
        for (const item of textNodes) {
          if (index >= item.start && index < item.start + item.length) {
            const offsetInNode = index - item.start;
            range.setStart(item.node, offsetInNode);
            range.setEnd(item.node, offsetInNode + 1);
            return range.getBoundingClientRect().top;
          }
        }
        return 0;
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

      offset += paragraph.length + 1;
    }

    const result = { lines, baseline };
    if (key.length <= 500000) {
      while (layouts.size && (layouts.size >= 128 || layoutCharacters + key.length > 500000)) {
        const oldest = layouts.keys().next().value!;
        layouts.delete(oldest);
        layoutCharacters -= oldest.length;
      }
      layouts.set(key, result);
      layoutCharacters += key.length;
    }
    return result;
  } finally {
    mirror.remove();
  }
}
