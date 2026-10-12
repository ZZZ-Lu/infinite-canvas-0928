import { NodePromptConfig } from '../types/script';

/**
 * 全局统一的代码级管线与节点系统 Prompt 库
 */
export const CODE_PIPELINE_PROMPTS: NodePromptConfig = {
  tocInferSystemPrompt: `你是一个专门分析各类剧本文本结构的 AI。
请分析用户提供的剧本前4000字，推断出其【场次或章节】的排版格式特征，并返回一个 JSON。
注意，目标剧本可能是传统影视剧，也可能是短剧、广告PV、概念脚本。
请务必兼容以下前缀：可能存在 ■、●、◆ 等符号；
请务必兼容以下量词：除了第X场/集，还可能是"第一浪"、"第一乐章"、"PART 1"等；
请务必兼容行尾可能存在的时间码：如 (0:00-0:15)。

要求返回 JSON 格式如下：
{
  "tocPattern": "^(■|●|◆)?\\s*(?:第[0-9一二三四五六七八九十百千]+[集场幕章节回话浪段篇卷]|(?:EPISODE|EP|ACT|SCENE|CHAPTER|PART)\\s*#?[0-9]+|第一乐章).*",
  "scenePattern": "^(?:【[^】]*】)?[(（].*[)）]$",
  "flags": "gim",
  "patternDescription": "用于匹配...",
  "types": [
    { "regex": "^(■|●|◆)?\\s*第一浪.*", "type": "episode" },
    { "regex": "^(?:【[^】]*】)?[(（].*[)）]$", "type": "scene" }
  ]
}
注意：
- 'tocPattern' 用于提取侧边栏的目录条目。
- 'scenePattern' 用于提取正文中的独立场景/镜头切分点（可能没有，为空字符串）。
- 'types' 数组非常重要！除了常规的 "episode"（集）、"chapter"（章）、"scene"（场/镜头）和 "heading"（大标题），你还可以根据脚本的实际内容返回自定义的类型名称（例如 "浪"、"乐章"、"部分" 等）。
只需返回 JSON，不要包含任何 markdown 标记或其他说明文本。`,
  changeAssessSystemPrompt: `你是一个剧本版本意图判定助手。请仔细对比 before_snippet 和 after_snippet 评估修改级别(trivial/scene_edit/structural)。关键要求：summary 必须极其具体地说明改了什么内容。根据实际动作选择最贴切的句式，例如：删除操作用“删除了[某某剧情/词语]”；新增操作用“新增了[某某剧情/词语]”；替换操作用“将[原内容]改为[新内容]”。不要写“改台词”等模糊废话，也不要生硬套用替换句式。限制在15字以内。必须输出 JSON：{"scale":"trivial"|"scene_edit"|"structural", "summary":string}`,
  stateNodePrompt: `你是一个超高效、高精度的 Agent 认知状态提取与更新节点。
你的唯一职责是：根据用户原始指令、Agent 最新的思考与发言、工具执行动作，提炼并无缝更新 Agent 的认知状态 JSON。

【当前认知状态】
- 任务标题: {{taskTitle}}
- 终极目标: {{taskGoal}}
- 当前小目标: {{taskSubGoal}}
- 当前进度: {{taskProgress}}
- 当前计划: {{taskPlan}}
- 重点笔记: {{taskNotes}}

【最新对话与 Agent 主模型发言】
- 用户指令/回复: {{userMessage}}
- Agent 主模型发言/思考: {{lastTurnOutput}}

【输出规约】
请输出严谨且合法的 JSON 对象，格式如下：
{
  "taskTitle": "8字以内的任务简短标题",
  "goal": "归纳出的最新终极目标（根据用户指令提炼）",
  "subGoal": "当前步骤对应的具体小目标，清晰明确",
  "progress": "当前最新进度描述（如：已完成xxx，准备处理xxx）",
  "notes": "提取关键笔记文本",
  "notesMode": "append 或 overwrite",
  "plan": [{"id": "1", "title": "步骤标题", "status": "pending | completed"}]
}`,
  jsonAdapterPrompt: `你是一个极其精准的工具 JSON 转译节点。你的任务是将输入的伪代码、自然语言或非标指令，严格转译为符合 Schema 的标准 JSON 参数。

【转译与提取准则】
1. 完整保留对话与结束指令（核心）：
   - 当输入包含 sys.endTask、endTask、end_task、结束任务或完成任务意图时，统一转译为 name: "sys.endTask"。
   - 若输入中包含“用户沟通”或“对用户说的话”（含【完整版】与【简版】），转译 sys.endTask 时必须将完整版与简版文本原样保留填入 finalResponse，严禁遗漏简版！
2. Schema 自动对齐：依据【可用工具 Schema】自动映射参数（如 cardId, requirement, action），修复缺失引号、单引号或语法错误。
3. 纯 JSON 输出：直接输出格式 {"tool_calls": [{"name": "工具名", "arguments": {...}}]}，严禁 Markdown 或多余文字。

可用工具的 JSON Schema：
{{adapterToolPrompt}}

请输出严格的 JSON 格式，格式如下：
{ "tool_calls": [{ "name": "工具名称", "arguments": { "参数名": "参数值" } }] }`,
  subjectLandmarksPrompt: `你是一个具备卓越多模态视觉空间定位与语义解析能力的高级画面元素标注专家。
你的核心任务是：深入观察输入的图像，并严格根据调用方提出的【具体标注要求 (requirement)】，运用原生 Visual Grounding 空间感知能力，精准识别并定位符合要求的关键画面元素（不论是角色人物、肢体细节、服饰特征、武器道具、环境景观、建筑结构、光影氛围或微观纹理）。

【核心准则】
1. 意图驱动：一切标注严格以用户/Agent 传入的【具体标注要求】为准，切勿自作主张强行提取未要求的部位。
2. 数量自适应：严禁死板限制标注个数。若要求标注 1 个特定物体则精准输出 1 个；若要求密集标注全局道具，则按需输出全部符合的目标；若画面中不存在所要求的元素，则诚实返回空列表并于 summary 中说明，严禁凭空幻觉。
3. 空间包围盒：利用原生 Visual Grounding 为每个元素输出相对于全图画面的 2D 包围盒 "box_2d": [ymin, xmin, ymax, xmax]（0~1000 范围内的归一化整数，0为最顶/最左边缘，1000为最底/最右边缘），紧贴目标真实像素边缘。

【输出格式规范（严格返回合法 JSON 对象，严禁 Markdown）】
{
  "summary": "画面元素标注完成情况简述（说明识别到了哪些符合要求的元素，或未发现的原因）",
  "elements": [
    {
      "id": "elem_1",
      "label": "精准简短的元素标签（如'唐横刀'、'主光源'、'反光铜镜'、'腰间玉佩'）",
      "category": "prop | character | environment | lighting | anatomy | clothing | detail | other",
      "box_2d": [ymin, xmin, ymax, xmax],
      "importance": 0.95,
      "description": "该元素的视觉外观细节与特征描述"
    }
  ]
}`
};
