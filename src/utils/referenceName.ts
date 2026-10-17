// Ten visible characters including the ellipsis. Never split surrogate pairs.
export function referenceDisplayName(name: string) {
  const characters = Array.from(name);
  return characters.length > 10 ? characters.slice(0, 9).join('') + '…' : name;
}

export function shortenReferenceMentions(prompt: string, names: string[]) {
  const unique = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!unique.length) return prompt;
  const escaped = unique.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return prompt.replace(new RegExp(`@(${escaped.join('|')})`, 'g'), (_, name: string) => '@' + referenceDisplayName(name));
}
