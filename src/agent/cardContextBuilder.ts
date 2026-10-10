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
    const parentCleanName = (parentCard.fileName || '').replace(/\.[^/.]+$/, "").trim().toLowerCase();
    if (mentions.some(m => m.toLowerCase() === parentCleanName || m.toLowerCase() === (parentCard.id || '').toLowerCase())) {
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
 * Builds the complete auto-injected context and extracts multimodal images
 * STRICT SCOPE: Only extracts the focused card's own image and its attached reference images!
 */
export async function buildAutoInjectedCardContext(
  targetCard: CardData,
  allCards: CardData[],
  extractCardImageBase64: (card: CardData) => Promise<string | undefined>
): Promise<InjectedCardContextResult> {
  const lineage = resolveCardLineage(targetCard, allCards);

  // 1. Extract Target Card's Own Image
  const targetImageB64 = await extractCardImageBase64(targetCard);
  const seenB64 = new Set<string>();
  if (targetImageB64) {
    seenB64.add(targetImageB64);
  }

  // 2. Extract Target Card's Attached Reference Images (strictly belonging to targetCard)
  const refImages: { label: string; b64: string }[] = [];

  if (Array.isArray(targetCard.referenceImages) && targetCard.referenceImages.length > 0) {
    for (let i = 0; i < targetCard.referenceImages.length; i++) {
      const ref = targetCard.referenceImages[i];
      let b64: string | undefined = undefined;

      // A. If reference points to a canvas card, retrieve from that source card
      if (ref.sourceCardId) {
        const sourceCard = allCards.find(c => c.id === ref.sourceCardId);
        if (sourceCard) {
          b64 = await extractCardImageBase64(sourceCard);
        }
      }

      // B. If reference has direct fileData Blob
      if (!b64 && ref.fileData instanceof Blob && ref.fileData.size > 0) {
        try {
          b64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(ref.fileData as Blob);
          });
        } catch {}
      }

      // C. If reference has data URL
      if (!b64 && ref.url && ref.url.startsWith('data:image/')) {
        b64 = ref.url;
      }

      // D. If reference has remote URL or thumbnail URL, extract via pipeline
      if (!b64 && (ref.url || ref.thumbnailUrl)) {
        const mockRefCard: Partial<CardData> = {
          id: `ref_${targetCard.id}_${i}`,
          imageUrl: ref.url || ref.thumbnailUrl,
        };
        b64 = await extractCardImageBase64(mockRefCard as CardData);
      }

      if (b64 && !seenB64.has(b64)) {
        seenB64.add(b64);
        const refName = ref.name || `参考图 ${i + 1}`;
        refImages.push({
          label: `参考图 ${refImages.length + 1} (${refName})`,
          b64,
        });
      }
    }
  } else if (targetCard.referenceImageUrl || targetCard.referenceImageFileData) {
    const mockRefCard: Partial<CardData> = {
      id: `ref_single_${targetCard.id}`,
      fileData: targetCard.referenceImageFileData as Blob,
      imageUrl: targetCard.referenceImageUrl,
    };
    const b64 = await extractCardImageBase64(mockRefCard as CardData);
    if (b64 && !seenB64.has(b64)) {
      seenB64.add(b64);
      refImages.push({
        label: `关联参考图 (${targetCard.referenceImageUrl?.slice(-20) || '参考原图'})`,
        b64,
      });
    }
  }

  const images: string[] = [];
  const imageLabels: string[] = [];

  if (targetImageB64) {
    images.push(targetImageB64);
    imageLabels.push(`图 ${images.length} (当前聚焦卡片画面 - ${targetCard.fileName || '卡片 #' + targetCard.id.slice(-6)})`);
  }

  for (const refItem of refImages) {
    images.push(refItem.b64);
    imageLabels.push(`图 ${images.length} (${refItem.label})`);
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

  // 3. Existing Visual Element Annotations / Landmarks (if available)
  const landmarks = targetCard.landmarks;
  const elements = landmarks?.elements || landmarks?.interestPoints || [];

  if (elements.length > 0 || landmarks?.summary) {
    lines.push(``);
    lines.push(`## 3. 已有画面元素标注与空间坐标 (Existing Visual Annotations)`);
    if (landmarks?.requirement) {
      lines.push(`- 历史标注需求: "${landmarks.requirement}"`);
    }
    if (landmarks?.summary) {
      lines.push(`- 视觉语义摘要: ${landmarks.summary}`);
    }
    if (landmarks?.shotType) {
      lines.push(`- 景别分类: ${landmarks.shotType}`);
    }
    lines.push(`- 已标注元素清单 (${elements.length} 项):`);
    elements.forEach((el: any) => {
      const coordStr = el.point ? `坐标 [${el.point.x}, ${el.point.y}]` : (el.box ? `检测框 [${el.box.join(', ')}]` : '');
      const descStr = el.description ? ` - ${el.description}` : '';
      lines.push(`  * ID: \`${el.id}\` | 标签: **${el.label}** (${el.category || '元素'}${coordStr ? ` | ${coordStr}` : ''})${descStr}`);
    });
    lines.push(`*提示：可直接利用已有标注元素 ID 进行 \`card.detectLandmarks\` 的 update / delete，或在 mode="append" 下追加新元素。*`);
  }

  if (imageLabels.length > 0) {
    lines.push(``);
    lines.push(`## 4. 多模态视觉图像对照 (Visual Images Injected)`);
    imageLabels.forEach(label => lines.push(`- ${label}`));
    lines.push(`*提示：仅精准注入当前聚焦卡片及其关联参考图，无需在 UI 上重复打开弹窗即可直接观察分析。*`);
  }

  const markdownSummary = lines.join('\n');

  const structuredContext = {
    targetId: targetCard.id,
    title: targetCard.fileName || '未命名卡片',
    prompt: targetCard.prompt,
    ratio: targetCard.ratio,
    res: targetCard.res,
    model: targetCard.mcpModel,
    annotations: elements,
    landmarks: landmarks ? {
      detectedAt: landmarks.detectedAt,
      requirement: landmarks.requirement,
      summary: landmarks.summary,
      shotType: landmarks.shotType,
      elementCount: elements.length,
      elements,
    } : undefined,
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

/**
 * Builds auto-injected context when multiple cards are selected
 */
export async function buildMultiCardInjectedContext(
  selectedCards: CardData[],
  allCards: CardData[],
  extractCardImageBase64: (card: CardData) => Promise<string | undefined>
): Promise<InjectedCardContextResult> {
  const images: string[] = [];
  const imageLabels: string[] = [];
  const seenB64 = new Set<string>();

  const cardDetails: Array<{
    card: CardData;
    imageB64?: string;
    imageLabelIndex?: number;
    refImages: { label: string; b64: string }[];
  }> = [];

  for (let idx = 0; idx < selectedCards.length; idx++) {
    const card = selectedCards[idx];
    const b64 = await extractCardImageBase64(card);
    let imageLabelIndex: number | undefined = undefined;

    if (b64 && !seenB64.has(b64)) {
      seenB64.add(b64);
      images.push(b64);
      imageLabelIndex = images.length;
      imageLabels.push(`图 ${imageLabelIndex} (选中卡片 #${idx + 1} 画面 - ${card.fileName || '卡片 #' + card.id.slice(-6)})`);
    }

    // Extract reference images for this card if any
    const refImages: { label: string; b64: string }[] = [];
    if (Array.isArray(card.referenceImages) && card.referenceImages.length > 0) {
      for (let i = 0; i < card.referenceImages.length; i++) {
        const ref = card.referenceImages[i];
        let refB64: string | undefined = undefined;
        if (ref.sourceCardId) {
          const sourceCard = allCards.find(c => c.id === ref.sourceCardId);
          if (sourceCard) {
            refB64 = await extractCardImageBase64(sourceCard);
          }
        }
        if (!refB64 && ref.url && ref.url.startsWith('data:image/')) {
          refB64 = ref.url;
        }
        if (!refB64 && (ref.url || ref.thumbnailUrl)) {
          const mockRefCard: Partial<CardData> = {
            id: `ref_${card.id}_${i}`,
            imageUrl: ref.url || ref.thumbnailUrl,
          };
          refB64 = await extractCardImageBase64(mockRefCard as CardData);
        }

        if (refB64 && !seenB64.has(refB64)) {
          seenB64.add(refB64);
          images.push(refB64);
          const refIndex = images.length;
          const refName = ref.name || `参考图 ${i + 1}`;
          const label = `图 ${refIndex} (卡片 #${idx + 1} 关联参考图: ${refName})`;
          imageLabels.push(label);
          refImages.push({ label, b64: refB64 });
        }
      }
    }

    cardDetails.push({
      card,
      imageB64: b64,
      imageLabelIndex,
      refImages,
    });
  }

  // Format rich Markdown summary
  const lines: string[] = [
    `# 🎯 画布多选卡片批量自动注入 (Multi-Selected Cards Context - 共 ${selectedCards.length} 张)`,
    ``,
    `当前选中的卡片包含以下 ${selectedCards.length} 张焦点卡片及其多模态画面与标注，请综合这些卡片的信息进行分析或调整：`,
    ``,
  ];

  selectedCards.forEach((card, idx) => {
    const detail = cardDetails[idx];
    const cardTitle = card.fileName ? `**[${card.fileName}]**` : `卡片 #${card.id.slice(-6)}`;
    const imgRefStr = detail.imageLabelIndex ? ` (对应 [图 ${detail.imageLabelIndex}])` : '';

    lines.push(`## 📌 卡片 ${idx + 1}: ${cardTitle}${imgRefStr}`);
    lines.push(`- 卡片ID: \`${card.id}\``);
    lines.push(`- 类型: ${card.isVideo ? '视频生成卡片' : (card.isAsset ? '素材/参考资产' : '生图卡片')}`);
    lines.push(`- 提示词 (Prompt): ${card.prompt ? `"${card.prompt}"` : '(空)'}`);
    if (card.lastGeneratedPrompt && card.lastGeneratedPrompt !== card.prompt) {
      lines.push(`- 历史生成提示词: "${card.lastGeneratedPrompt}"`);
    }
    lines.push(`- 画幅比例与分辨率: ${card.ratio || '9:16'} · ${card.res || '2K'}`);
    if (card.mcpModel) {
      lines.push(`- 关联模型: ${card.mcpModel}`);
    }
    lines.push(`- 画布坐标: (X: ${Math.round(card.x)}, Y: ${Math.round(card.y)})`);

    // Landmarks / Annotations
    const landmarks = card.landmarks;
    const elements = landmarks?.elements || landmarks?.interestPoints || [];
    if (elements.length > 0 || landmarks?.summary) {
      lines.push(`- **已存标注与语义**: ${landmarks?.summary || `${elements.length} 项标注`}`);
      elements.forEach((el: any) => {
        const coordStr = el.point ? `坐标 [${el.point.x}, ${el.point.y}]` : (el.box ? `检测框 [${el.box.join(', ')}]` : '');
        lines.push(`  * 标注 \`${el.id}\`: **${el.label}** (${el.category || '元素'}${coordStr ? ` | ${coordStr}` : ''})`);
      });
    }
    lines.push(``);
  });

  if (imageLabels.length > 0) {
    lines.push(`## 🖼️ 多模态视觉图像对照 (Visual Images Injected)`);
    imageLabels.forEach(label => lines.push(`- ${label}`));
    lines.push(`*提示：已将当前所有选中卡片的画面自动拼接注入至多模态上下文供多视角对比分析。*`);
  }

  const markdownSummary = lines.join('\n');

  const structuredContext = {
    isMultiSelect: true,
    selectedCardsCount: selectedCards.length,
    selectedCardIds: selectedCards.map(c => c.id),
    cards: selectedCards.map(c => ({
      id: c.id,
      title: c.fileName || '未命名卡片',
      prompt: c.prompt,
      ratio: c.ratio,
      res: c.res,
      model: c.mcpModel,
      x: c.x,
      y: c.y,
      annotations: c.landmarks?.elements || c.landmarks?.interestPoints || [],
      landmarks: c.landmarks,
    })),
    imageLabels,
  };

  return {
    markdownSummary,
    structuredContext,
    images,
    imageLabels,
  };
}
