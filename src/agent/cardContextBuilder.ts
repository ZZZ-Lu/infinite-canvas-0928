import type { CardData } from '../components/GenerationCard';
import type { ScriptProject } from '../types/script';

export interface CardLineageNode {
  id: string;
  title: string;
  type: 'root_asset' | 'parent_iteration' | 'target_focus' | 'child_derivative' | 'sibling_variant';
  roleDescription: string;
  prompt: string;
  lastGeneratedPrompt?: string;
  ratio?: string;
  res?: string;
  model?: string;
  hasImage: boolean;
  imageBase64?: string;
  refCount: number;
  refNames: string[];
}

export interface CardLineageGraph {
  targetId: string;
  rootNodes: CardLineageNode[];
  parentNodes: CardLineageNode[];
  targetNode: CardLineageNode;
  childNodes: CardLineageNode[];
  siblingNodes: CardLineageNode[];
  orderedChain: CardLineageNode[];
  evolutionSummary: string;
}

export interface InjectedCardContextResult {
  markdownSummary: string;
  structuredContext: Record<string, any>;
  images: string[];
  imageLabels: string[];
}

/**
 * Parses @mentions like @列车36集(1) from prompt
 */
export function extractPromptMentions(prompt: string): string[] {
  if (!prompt) return [];
  const matches = prompt.match(/@([^\s@]+)/g);
  if (!matches) return [];
  return matches.map(m => m.slice(1).trim());
}

/**
 * Finds reference matches between cards
 */
export function isCardReferencedBy(parentCard: CardData, childCard: CardData): boolean {
  if (childCard.derivedFromId && childCard.derivedFromId === parentCard.id) return true;
  if (childCard.referenceSourceIds && childCard.referenceSourceIds.includes(parentCard.id)) return true;
  
  if (Array.isArray(childCard.referenceImages)) {
    const matched = childCard.referenceImages.some(ref => {
      if (ref.sourceCardId && ref.sourceCardId === parentCard.id) return true;
      if (ref.url && (ref.url === parentCard.imageUrl || ref.url === parentCard.originalImageUrl || ref.url === parentCard.thumbnailUrl)) return true;
      if (ref.name && parentCard.fileName && ref.name.toLowerCase() === parentCard.fileName.toLowerCase()) return true;
      return false;
    });
    if (matched) return true;
  }

  // Check @Mentions in prompt
  const mentions = extractPromptMentions(childCard.prompt || '');
  if (mentions.length > 0 && parentCard.fileName) {
    const parentCleanName = parentCard.fileName.replace(/\.[^/.]+$/, "").trim().toLowerCase();
    if (mentions.some(m => m.toLowerCase() === parentCleanName || m.toLowerCase() === parentCard.id.toLowerCase())) {
      return true;
    }
  }

  return false;
}

/**
 * Builds the complete lineage graph for a given target card
 */
export function resolveCardLineage(targetCard: CardData, allCards: CardData[]): CardLineageGraph {
  const cardsMap = new Map<string, CardData>(allCards.map(c => [c.id, c]));
  
  // 1. Trace upwards for parents and root nodes
  const directParents: CardData[] = [];
  const visitedParents = new Set<string>();

  for (const candidate of allCards) {
    if (candidate.id === targetCard.id) continue;
    if (isCardReferencedBy(candidate, targetCard)) {
      directParents.push(candidate);
      visitedParents.add(candidate.id);
    }
  }

  // Also trace grandparent / root assets
  const rootAncestors: CardData[] = [];
  for (const p of directParents) {
    for (const candidate of allCards) {
      if (candidate.id === targetCard.id || visitedParents.has(candidate.id)) continue;
      if (isCardReferencedBy(candidate, p)) {
        rootAncestors.push(candidate);
        visitedParents.add(candidate.id);
      }
    }
  }

  // 2. Trace downwards for children
  const directChildren: CardData[] = [];
  for (const candidate of allCards) {
    if (candidate.id === targetCard.id || visitedParents.has(candidate.id)) continue;
    if (isCardReferencedBy(targetCard, candidate)) {
      directChildren.push(candidate);
    }
  }

  // 3. Trace siblings (cards that share the same parents or derived from the same source)
  const siblings: CardData[] = [];
  if (directParents.length > 0) {
    const parentIds = new Set(directParents.map(p => p.id));
    for (const candidate of allCards) {
      if (candidate.id === targetCard.id || directChildren.some(c => c.id === candidate.id)) continue;
      const sharesParent = allCards.some(p => parentIds.has(p.id) && isCardReferencedBy(p, candidate));
      if (sharesParent) {
        siblings.push(candidate);
      }
    }
  }

  const toNode = (card: CardData, type: CardLineageNode['type'], roleDescription: string): CardLineageNode => {
    const refNames = (card.referenceImages || [])
      .map(r => r.name || '')
      .filter(Boolean);
    const hasImage = Boolean(card.imageUrl || card.originalImageUrl || card.thumbnailUrl || card.fileData);

    return {
      id: card.id,
      title: card.fileName || `卡片 #${card.id.slice(-6)}`,
      type,
      roleDescription,
      prompt: card.prompt || card.lastGeneratedPrompt || '',
      lastGeneratedPrompt: card.lastGeneratedPrompt,
      ratio: card.ratio,
      res: card.res,
      model: card.mcpModel,
      hasImage,
      refCount: card.referenceImages?.length || (card.referenceImageUrl ? 1 : 0),
      refNames,
    };
  };

  const targetNode = toNode(targetCard, 'target_focus', '当前右键/选中的目标聚焦卡片');
  const rootNodes = rootAncestors.map(c => toNode(c, 'root_asset', '根溯源资产/故事板分镜'));
  const parentNodes = directParents.map(c => toNode(c, 'parent_iteration', '直接前置参考图/父级迭代'));
  const childNodes = directChildren.map(c => toNode(c, 'child_derivative', '下游衍生卡片'));
  const siblingNodes = siblings.map(c => toNode(c, 'sibling_variant', '同源衍生变体卡片'));

  // Ordered visual chain from Root -> Direct Parents -> Target -> Children
  const orderedChain: CardLineageNode[] = [
    ...rootNodes,
    ...parentNodes,
    targetNode,
    ...childNodes,
  ];

  // Summarize prompt delta / intent
  let evolutionSummary = '当前卡片为独立创作卡片。';
  if (rootNodes.length > 0 || parentNodes.length > 0) {
    const ancestorTitles = [...rootNodes, ...parentNodes].map(n => `[${n.title}]`).join(' -> ');
    evolutionSummary = `谱系传承链：${ancestorTitles} -> [当前卡片: ${targetNode.title}]。`;
    if (targetNode.prompt) {
      evolutionSummary += ` 迭代意图：基于上游参考图进行重绘与微调（提示词："${targetNode.prompt.slice(0, 60)}${targetNode.prompt.length > 60 ? '...' : ''}"）。`;
    }
  }

  return {
    targetId: targetCard.id,
    rootNodes,
    parentNodes,
    targetNode,
    childNodes,
    siblingNodes,
    orderedChain,
    evolutionSummary,
  };
}

/**
 * Builds the complete auto-injected context and extracts multimodal images for the lineage
 */
export async function buildAutoInjectedCardContext(
  targetCard: CardData,
  allCards: CardData[],
  extractCardImageBase64: (card: CardData) => Promise<string | undefined>
): Promise<InjectedCardContextResult> {
  const lineage = resolveCardLineage(targetCard, allCards);
  const cardsMap = new Map(allCards.map(c => [c.id, c]));

  // Extract images in order of lineage chain (Root -> Parent -> Target)
  const images: string[] = [];
  const imageLabels: string[] = [];

  for (const node of lineage.orderedChain) {
    const card = cardsMap.get(node.id);
    if (card) {
      const b64 = await extractCardImageBase64(card);
      if (b64) {
        images.push(b64);
        const roleLabel = node.type === 'root_asset' ? '根资产/故事板' : (node.type === 'parent_iteration' ? '父级参考' : (node.type === 'target_focus' ? '当前目标卡片' : '下游衍生'));
        imageLabels.push(`图 ${images.length} (${roleLabel} - ${node.title}, ID: ${node.id})`);
        node.imageBase64 = b64;
      }
    }
  }

  // Format rich Markdown summary for System / User turn prompt
  const lines: string[] = [
    `# 🎯 画布焦点与卡片谱系自动注入 (Focused Card & Lineage Context)`,
    ``,
    `## 1. 当前目标卡片 (Target Focus)`,
    `- 卡片ID: \`${targetCard.id}\``,
    `- 标题/标签: ${targetCard.fileName ? `**[${targetCard.fileName}]**` : '未命名卡片'}`,
    `- 类型: ${targetCard.isVideo ? '视频生成卡片' : (targetCard.isAsset ? '素材/参考资产' : '生图卡片')}`,
    `- 提示词 (Prompt): ${targetCard.prompt ? `"${targetCard.prompt}"` : '(空)'}`,
    ...(targetCard.lastGeneratedPrompt && targetCard.lastGeneratedPrompt !== targetCard.prompt ? [`- 历史生成提示词: "${targetCard.lastGeneratedPrompt}"`] : []),
    `- 画幅比例与分辨率: ${targetCard.ratio || '9:16'} · ${targetCard.res || '2K'}`,
    ...(targetCard.mcpModel ? [`- 关联模型: ${targetCard.mcpModel}`] : []),
    `- 关联参考图数量: ${targetCard.referenceImages?.length || (targetCard.referenceImageUrl ? 1 : 0)} 张`,
    ``,
    `## 2. 谱系拓扑与引用关系 (Lineage & DAG Topology)`,
    `- **演进摘要**: ${lineage.evolutionSummary}`,
  ];

  if (lineage.rootNodes.length > 0) {
    lines.push(`- **根溯源资产 (Root Asset)**:`);
    lineage.rootNodes.forEach(rn => {
      lines.push(`  * ID: \`${rn.id}\` | 标题: **${rn.title}** | 提示词: "${rn.prompt || '(无)'}"`);
    });
  }

  if (lineage.parentNodes.length > 0) {
    lines.push(`- **直接父级/参考源 (Direct Parent)**:`);
    lineage.parentNodes.forEach(pn => {
      lines.push(`  * ID: \`${pn.id}\` | 标题: **${pn.title}** | 提示词: "${pn.prompt || '(无)'}"`);
    });
  }

  if (lineage.siblingNodes.length > 0) {
    lines.push(`- **同源变体/兄弟卡片 (Sibling Variants)**: ${lineage.siblingNodes.map(sn => `\`${sn.id}\`(${sn.title})`).join(', ')}`);
  }

  if (lineage.childNodes.length > 0) {
    lines.push(`- **下游衍生卡片 (Children)**: ${lineage.childNodes.map(cn => `\`${cn.id}\`(${cn.title})`).join(', ')}`);
  }

  if (imageLabels.length > 0) {
    lines.push(``);
    lines.push(`## 3. 多模态视觉图像对照 (Visual Images Injected)`);
    imageLabels.forEach(label => lines.push(`- ${label}`));
    lines.push(`*提示：图像已按谱系顺序传入模型视觉上下文，无需在 UI 上重复点击或打开弹窗即可直接观察分析。*`);
  }

  const markdownSummary = lines.join('\n');

  const structuredContext = {
    targetId: targetCard.id,
    title: targetCard.fileName || '未命名卡片',
    prompt: targetCard.prompt,
    ratio: targetCard.ratio,
    res: targetCard.res,
    model: targetCard.mcpModel,
    lineage: {
      roots: lineage.rootNodes.map(n => ({ id: n.id, title: n.title, prompt: n.prompt })),
      parents: lineage.parentNodes.map(n => ({ id: n.id, title: n.title, prompt: n.prompt })),
      target: { id: targetCard.id, title: targetCard.fileName, prompt: targetCard.prompt },
      siblings: lineage.siblingNodes.map(n => ({ id: n.id, title: n.title })),
      children: lineage.childNodes.map(n => ({ id: n.id, title: n.title })),
      evolutionSummary: lineage.evolutionSummary,
    },
    imageLabels,
  };

  return {
    markdownSummary,
    structuredContext,
    images,
    imageLabels,
  };
}
