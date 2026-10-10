import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import fs from "fs";
import dotenv from "dotenv";
import { AGENT_TOOL_REGISTRY } from './src/agent/toolRegistry';
import { mcpRouter } from './src/server/mcpRouter';
dotenv.config();
const defaultPromptFilePath = path.join(process.cwd(), "src/agent/systemPrompt.txt");
const defaultStatePromptFilePath = path.join(process.cwd(), "src/agent/stateNodePrompt.txt");
const defaultLandmarksPromptFilePath = path.join(process.cwd(), "src/agent/subjectLandmarksPrompt.txt");
const defaultJsonAdapterPromptFilePath = path.join(process.cwd(), "src/agent/jsonAdapterPrompt.txt");
const customPromptDir = path.join(process.cwd(), ".data");
const customPromptFilePath = path.join(customPromptDir, "systemPrompt.txt");
const customStatePromptFilePath = path.join(customPromptDir, "stateNodePrompt.txt");
const customLandmarksPromptFilePath = path.join(customPromptDir, "subjectLandmarksPrompt.txt");
const customJsonAdapterPromptFilePath = path.join(customPromptDir, "jsonAdapterPrompt.txt");

function getPrompt(type: 'main' | 'state' | 'landmarks' | 'jsonAdapter' = 'main') {
  try {
    const isProd = process.env.NODE_ENV === 'production';
    const customPath = type === 'state'
      ? customStatePromptFilePath
      : type === 'landmarks'
      ? customLandmarksPromptFilePath
      : type === 'jsonAdapter'
      ? customJsonAdapterPromptFilePath
      : customPromptFilePath;
    const defaultPath = type === 'state'
      ? defaultStatePromptFilePath
      : type === 'landmarks'
      ? defaultLandmarksPromptFilePath
      : type === 'jsonAdapter'
      ? defaultJsonAdapterPromptFilePath
      : defaultPromptFilePath;
    if (isProd) {
      if (fs.existsSync(customPath)) {
        return fs.readFileSync(customPath, "utf-8");
      }
      if (fs.existsSync(defaultPath)) {
        return fs.readFileSync(defaultPath, "utf-8");
      }
    } else {
      if (fs.existsSync(defaultPath)) {
        return fs.readFileSync(defaultPath, "utf-8");
      }
      if (fs.existsSync(customPath)) {
        return fs.readFileSync(customPath, "utf-8");
      }
    }
    return "";
  } catch (e) {
    return "";
  }
}

function getSystemPrompt() {
  return getPrompt('main');
}

const functionNameForTool = (toolId: string) => toolId.replaceAll('.', '_');

const parametersForTool = (toolId: string) => {
  const target = { type: 'string', description: '来自最近一次 page.inspect 的 visible components 的 targetId。' };
  const observationProperties = { scope: { type: 'string', description: 'overview 返回主要入口概览（默认，剧本正文不直接展开注入）；填可见组件 ID（如 "script.text"）申请查看该区域的可见内容。' }, offset: { type: 'integer', minimum: 0, description: '同一可见区域的返回分页偏移，不会滚动页面。' }, limit: { type: 'integer', minimum: 1, maximum: 100 } };
  const schemas: Record<string, { properties: Record<string, unknown>; required?: string[] }> = {
    'ui.actAndObserve': { properties: { targetId: target, action: { type: 'string', enum: ['mouse.move', 'mouse.click', 'mouse.doubleClick', 'mouse.longPress', 'mouse.hover', 'mouse.drag', 'mouse.scroll', 'mouse.type', 'mouse.keyPress'] }, arguments: { type: 'object', description: '鼠标动作的附加参数。例如：mouse.scroll 可传 { delta: number }（正数向下，负数向上）；mouse.type 可传 { text: string, clear?: boolean }（输入文本，clear 为 true 时先清空原有内容）；mouse.keyPress 可传 { key: string, shiftKey?: boolean }（如 key="Enter"）' }, observe: { type: 'object', properties: observationProperties } }, required: ['targetId', 'action'] },
    'page.inspect': { properties: observationProperties },
    'guide.lookup': { properties: { query: { type: 'string' } }, required: ['query'] },
    'card.inspect': { properties: { cardId: { type: 'string', description: '需要深入查看的目标卡片 ID' }, includeImage: { type: 'boolean', description: '是否提取高清图像并注入多模态视觉上下文' }, includePrompt: { type: 'boolean', description: '是否提取提示词' }, includeReference: { type: 'boolean', description: '是否提取参考图列表' }, includeParameters: { type: 'boolean', description: '是否提取画幅、模型、渲染状态等参数' } }, required: ['cardId'] },
    'card.detectLandmarks': {
      properties: {
        cardId: { type: 'string', description: '需要进行画面元素空间标注的目标卡片 ID（例如 card_xxx 或 canvas.card.xxx）' },
        action: {
          type: 'string',
          enum: ['detect', 'list', 'update', 'delete', 'clear'],
          description: '操作动作：detect（默认，调用大模型空间定位与语义标注）、list（查询卡片已有标注列表）、update（修改指定标注）、delete（删除指定 ID 标注）、clear（清空卡片全部标注）'
        },
        requirement: { type: 'string', description: '具体标注要求（自然语言意图描述，如"标注主要角色手持的长剑与腰间玉佩"、"识别所有光源与反光表面"等，不限部位、不限数量）' },
        prompt: { type: 'string', description: '兼容参数，等同于 requirement' },
        mode: {
          type: 'string',
          enum: ['append', 'overwrite'],
          description: '合并模式：append（在卡片已有标注基础上追加新标注）、overwrite（覆写已有标注，默认）'
        },
        updates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '要修改的标注元素 ID（如 elem_1）' },
              label: { type: 'string', description: '新的标签文本' },
              description: { type: 'string', description: '新的视觉外观细节描述' },
              category: { type: 'string', description: '元素类别' },
              point: {
                type: 'object',
                properties: { x: { type: 'number' }, y: { type: 'number' } },
                description: '新的归一化坐标百分比 (0~100)'
              },
              box: {
                type: 'array',
                items: { type: 'number' },
                description: '2D 归一化包围盒 [ymin, xmin, ymax, xmax]'
              }
            },
            required: ['id']
          },
          description: '更新项列表（action="update" 时生效）'
        },
        deleteIds: {
          type: 'array',
          items: { type: 'string' },
          description: '要删除的标注元素 ID 数组（action="delete" 时生效，如 ["elem_1"]）'
        },
        force: { type: 'boolean', description: '是否强制重新识别（默认为 true）' }
      },
      required: ['cardId']
    },
    'card.annotateElements': {
      properties: {
        cardId: { type: 'string', description: '目标卡片 ID（与 card.detectLandmarks 功能完全相同）' },
        action: {
          type: 'string',
          enum: ['detect', 'list', 'update', 'delete', 'clear'],
          description: '操作动作：detect（默认检测）、list（列表）、update（更新）、delete（删除）、clear（清空）'
        },
        requirement: { type: 'string', description: '具体标注要求描述' },
        prompt: { type: 'string', description: '兼容参数，等同于 requirement' },
        mode: { type: 'string', enum: ['append', 'overwrite'], description: '合并模式：append 追加或 overwrite 覆写' },
        updates: { type: 'array', items: { type: 'object' }, description: '更新项列表' },
        deleteIds: { type: 'array', items: { type: 'string' }, description: '删除 ID 数组' },
        force: { type: 'boolean', description: '是否强制重新识别' }
      },
      required: ['cardId']
    },
    'card.generate': { properties: { name: { type: 'string', description: '卡片名称（尽可能简短、辨识度高）' }, targetCardId: { type: 'string', description: '目标卡片 ID（"new" 表示新建衍生生图卡片，或已有卡片 ID）' }, prompt: { type: 'string', description: '正向生图提示词' }, aspectRatio: { type: 'string', description: '画幅比例，如 16:9, 9:16, 1:1 等' }, referenceCardIds: { type: 'array', items: { type: 'string' }, description: '参考图卡片 ID 列表' }, autoStart: { type: 'boolean', description: '是否直接排队启动生成（默认为 true）' }, forceOverwrite: { type: 'boolean', description: '是否强制在原卡片覆盖（慎用，默认已出图卡片会触发 Fork 衍生）' } }, required: ['name'] },
    'sys.updateState': { properties: { taskTitle: { type: 'string' }, goal: { type: 'string' }, subGoal: { type: 'string' }, progress: { type: 'string' }, notes: { type: 'string' }, notesMode: { type: 'string', enum: ['append', 'overwrite'], description: '重点笔记模式：append（追加，默认）或 overwrite（重写替换现有笔记）' }, plan: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' } } } } } },
    'sys.endTask': { properties: { success: { type: 'boolean' }, finalResponse: { type: 'string' }, waitForUser: { type: 'string' }, paused: { type: 'boolean', description: '若任务属于等待后台异步生图/排队渲染，设置为 true 挂起任务等待出图事件唤醒' } }, required: ['success', 'finalResponse'] },
    'user.ask': { properties: { question: { type: 'string' } }, required: ['question'] },
  };
  const schema = schemas[toolId] || { properties: {} };
  return { type: 'object', properties: schema.properties, ...(schema.required ? { required: schema.required } : {}) };
};

function robustParseJson<T = any>(str: string): T | null {
  if (!str || typeof str !== 'string') return null;

  let cleaned = str.trim();
  // 1. Strip Markdown code block if wrapped in ```json ... ```
  const mdMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (mdMatch) {
    cleaned = mdMatch[1].trim();
  }

  // 2. Find boundaries of outer JSON structure ({ ... } or [ ... ])
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  let startIdx = -1;
  let isObject = true;

  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
    isObject = true;
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    isObject = false;
  }

  if (startIdx !== -1) {
    const lastChar = isObject ? '}' : ']';
    const endIdx = cleaned.lastIndexOf(lastChar);
    if (endIdx > startIdx) {
      cleaned = cleaned.slice(startIdx, endIdx + 1);
    }
  }

  // First direct try
  try {
    return JSON.parse(cleaned);
  } catch {}

  // 3. Repair common LLM JSON formatting defects:
  let repaired = cleaned;

  // a) Missing commas between array elements (e.g. ["a" "b"] or ["a"\n"b"]):
  repaired = repaired
    .replace(/(["\d\]}])\s*\n\s*(["\d\[{])/g, '$1,\n$2')
    .replace(/(")\s+(")/g, '$1, $2')
    .replace(/(\})\s+(\{)/g, '$1, $2')
    .replace(/(\])\s+(\[)/g, '$1, $2');

  // b) Trailing commas before closing braces/brackets
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');

  // c) Unquoted keys: { key: "val" } -> { "key": "val" }
  repaired = repaired.replace(/([{,]\s*)([a-zA-Z0-9_$]+)\s*:/g, '$1"$2":');

  // d) Single-quoted strings to double-quoted strings
  repaired = repaired.replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ':"$1"');

  try {
    return JSON.parse(repaired);
  } catch {}

  // 4. Fallback: extract tool_calls using regex if it's a tool_calls payload
  try {
    const toolCallRegex = /"name"\s*:\s*"([^"]+)"[\s\S]*?"arguments"\s*:\s*(\{[\s\S]*?\})/g;
    const extractedCalls: any[] = [];
    let match;
    while ((match = toolCallRegex.exec(cleaned)) !== null) {
      const name = match[1];
      const argsRaw = match[2];
      try {
        const args = JSON.parse(argsRaw.replace(/,\s*([}\]])/g, '$1'));
        extractedCalls.push({ name, arguments: args });
      } catch {
        const repairedArgs = robustParseJson(argsRaw);
        if (repairedArgs) {
          extractedCalls.push({ name, arguments: repairedArgs });
        }
      }
    }
    if (extractedCalls.length > 0) {
      return { tool_calls: extractedCalls } as any;
    }
  } catch {}

  return null;
}

function trySanitizeAndParseJson(str: string): Record<string, any> | null {
  const result = robustParseJson(str);
  if (result && typeof result === 'object' && !Array.isArray(result)) return result;
  return null;
}

interface ModelConfig {
  endpoint: string;
  actualModel: string;
  apiKey: string;
  stream?: boolean;
  enableThinking?: boolean;
  reasoningEffort?: 'low' | 'high' | 'max';
}

function getModelConfig(modelType: string, userKey?: string): ModelConfig {
  let endpoint = 'https://api.deepseek.com/chat/completions';
  let actualModel = 'deepseek-flash';
  let apiKey = userKey || process.env.DEEPSEEK_API_KEY;
  let stream = true;
  let enableThinking = false;
  let reasoningEffort: 'low' | 'high' | 'max' = 'max';

  if (modelType === 'deepseek-v4-pro') {
    actualModel = 'deepseek-v4-pro';
    enableThinking = true;
    stream = true;
  } else if (
    modelType === 'deepseek-v4-flash' ||
    modelType === 'deepseek-v4.1-flash-expires-on-0910' ||
    modelType === 'deepseek-flash' ||
    modelType === 'deepseek' ||
    modelType === 'auto'
  ) {
    actualModel = 'deepseek-flash';
    enableThinking = false;
    stream = true;
  } else if (modelType === 'qwen3.8-flash') {
    endpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    actualModel = 'qwen3.8-flash';
    apiKey = userKey || process.env.DASHSCOPE_API_KEY || process.env.DEEPSEEK_API_KEY;
    stream = true;
  } else if (
    modelType === 'qwen3-vl-plus' ||
    modelType === 'qwen-vl-plus' ||
    modelType.toLowerCase().includes('qwen3-vl') ||
    modelType.toLowerCase().includes('vl-plus')
  ) {
    endpoint = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    actualModel = 'qwen3-vl-plus';
    apiKey = userKey || process.env.DASHSCOPE_API_KEY || process.env.DEEPSEEK_API_KEY;
    stream = true;
  } else if (
    modelType === 'doubao-seed-2-1-pro-260915' ||
    modelType === 'doubao-seed-2.1-pro' ||
    modelType === 'doubao-seed-2-1-pro' ||
    modelType.toLowerCase().includes('doubao') ||
    modelType.toLowerCase().includes('seed-2-1') ||
    modelType.toLowerCase().includes('seed-2.1') ||
    modelType.toLowerCase().includes('volces') ||
    modelType.toLowerCase().includes('ark')
  ) {
    endpoint = process.env.ARK_API_ENDPOINT || 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
    actualModel = process.env.ARK_MODEL_NAME || 'doubao-seed-2-1-pro-260915';
    apiKey = userKey || process.env.ARK_API_KEY || process.env.VOLCENGINE_API_KEY || process.env.DASHSCOPE_API_KEY || process.env.DEEPSEEK_API_KEY;
    stream = true;
    enableThinking = false;
  } else if (
    modelType.toLowerCase().includes('5.3-flash') ||
    modelType.toLowerCase().includes('glm-5.3')
  ) {
    endpoint = process.env.GLM_API_ENDPOINT || 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
    actualModel = process.env.GLM_MODEL_NAME || process.env.ZHIPU_MODEL_NAME || 'ZHIPU/GLM-5.3-Flash';
    apiKey = userKey || process.env.DASHSCOPE_API_KEY || process.env.ZHIPU_API_KEY || process.env.DEEPSEEK_API_KEY;
    stream = true;
    enableThinking = true;

    if (modelType.toLowerCase().endsWith('-low') || modelType.toLowerCase().includes('low')) {
      reasoningEffort = 'low';
    } else if (modelType.toLowerCase().endsWith('-high') || modelType.toLowerCase().includes('high')) {
      reasoningEffort = 'high';
    } else {
      reasoningEffort = 'max';
    }
  }

  if (!apiKey) throw new Error('未配置 API Key');
  return { endpoint, actualModel, apiKey, stream, enableThinking, reasoningEffort };
}

async function parseChatCompletionResponse(response: Response, isStream: boolean): Promise<{ content: string; reasoning_content?: string }> {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream') && !isStream) {
    const data = await response.json();
    const message = data.choices?.[0]?.message || {};
    return {
      content: message.content || '',
      reasoning_content: message.reasoning_content || message.reasoning || '',
    };
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    try {
      const data = JSON.parse(text);
      const message = data.choices?.[0]?.message || {};
      return { content: message.content || '', reasoning_content: message.reasoning_content || '' };
    } catch {
      throw new Error('无法读取响应流内容');
    }
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';
  let fullReasoning = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      if (trimmed === 'data: [DONE]') continue;
      if (trimmed.startsWith('data: ')) {
        const jsonStr = trimmed.slice(6);
        try {
          const chunk = JSON.parse(jsonStr);
          const delta = chunk.choices?.[0]?.delta;
          if (delta) {
            if (delta.content) {
              fullContent += delta.content;
            }
            if (delta.reasoning_content) {
              fullReasoning += delta.reasoning_content;
            } else if (delta.reasoning) {
              fullReasoning += delta.reasoning;
            }
          }
        } catch {
          // ignore incomplete JSON chunks
        }
      }
    }
  }

  if (buffer.trim().startsWith('data: ') && buffer.trim() !== 'data: [DONE]') {
    try {
      const chunk = JSON.parse(buffer.trim().slice(6));
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) fullContent += delta.content;
      if (delta?.reasoning_content) fullReasoning += delta.reasoning_content;
      else if (delta?.reasoning) fullReasoning += delta.reasoning;
    } catch {}
  }

  return { content: fullContent, reasoning_content: fullReasoning };
}

// Heuristic fallback for script TOC pattern recognition
function inferPatternHeuristically(sampleText: string): { tocPattern: string; scenePattern: string; flags: string; patternDescription: string } {
  const lines = sampleText.split('\n').map(l => l.trim()).filter(Boolean);
  
  const bracketEpisodeMatch = lines.some(l => /^【\s*第?\s*[0-9一二三四五六七八九十百]+\s*[集话回].*?】/i.test(l));
  const bracketSceneMatch = lines.some(l => /^【\s*(?:场|场景|场次)?\s*[0-9一二三四五六七八九十百]+.*?】/i.test(l));
  const plainEpisodeMatch = lines.some(l => /^第\s*[0-9一二三四五六七八九十百]+\s*[集话回]/i.test(l));
  const plainSceneMatch = lines.some(l => /^第\s*[0-9一二三四五六七八九十百]+\s*[场幕]/i.test(l));
  const englishEpisodeMatch = lines.some(l => /^(?:EPISODE|EP|CHAPTER)\s*#?\s*\d+/i.test(l));
  const englishSceneMatch = lines.some(l => /^SCENE\s*#?\s*\d+/i.test(l));

  let tocPattern = "";
  let scenePattern = "";
  let patternDescription = "";

  if (bracketEpisodeMatch) {
    tocPattern = "^【\\s*第?\\s*[0-9一二三四五六七八九十百千]+\\s*[集话回][^】]*】.*";
    patternDescription += "方括号集数格式";
  } else if (plainEpisodeMatch) {
    tocPattern = "^第\\s*[0-9一二三四五六七八九十百千]+\\s*[集话回].*";
    patternDescription += "标准集数格式";
  } else if (englishEpisodeMatch) {
    tocPattern = "^(?:EPISODE|EP|CHAPTER)\\s*#?\\s*\\d+.*";
    patternDescription += "英文Episode格式";
  }

  if (bracketSceneMatch) {
    scenePattern = "^【\\s*(?:场|场景|场次)?\\s*[0-9一二三四五六七八九十百千]+[^】]*】.*";
    patternDescription += (patternDescription ? " + " : "") + "方括号场次格式";
  } else if (plainSceneMatch) {
    scenePattern = "^第\\s*[0-9一二三四五六七八九十百千]+\\s*[场幕].*";
    patternDescription += (patternDescription ? " + " : "") + "标准场次格式";
  } else if (englishSceneMatch) {
    scenePattern = "^SCENE\\s*#?\\s*\\d+.*";
    patternDescription += (patternDescription ? " + " : "") + "英文Scene格式";
  }

  // Fallbacks
  if (!scenePattern) {
    scenePattern = "^第\\s*[0-9一二三四五六七八九十百千]+\\s*场.*";
  }

  return { tocPattern, scenePattern, flags: "gim", patternDescription };
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));

  // WorkRally MCP Proxy Routes
  app.use('/api/mcp/workrally', mcpRouter);
  app.use('/api/mcp', mcpRouter);

  // API Route for AI Episode / TOC Pattern Recognition
  app.post('/api/save-prompts', express.json(), (req, res) => {
    try {
      const { prompts } = req.body;
      if (!prompts) return res.status(400).json({ error: 'Missing prompts data' });
      const promptFileContent = `import { NodePromptConfig } from '../types/script';

/**
 * 全局统一的代码级管线与节点系统 Prompt 库
 */
export const CODE_PIPELINE_PROMPTS: NodePromptConfig = ${JSON.stringify(prompts, null, 2)};
`;
      fs.writeFileSync(path.join(process.cwd(), 'src/constants/prompts.ts'), promptFileContent, 'utf-8');
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/script-toc-pattern", async (req, res) => {
    const { sampleText, systemPrompt, modelType = 'auto', apiKey, deepseekKey } = req.body;
    if (!sampleText || typeof sampleText !== "string") {
      return res.status(400).json({ error: "Missing sampleText in request body" });
    }

    try {
      if (modelType !== 'heuristic') {
        const { endpoint, actualModel, apiKey: keyToUse, enableThinking } = getModelConfig(modelType, apiKey || deepseekKey);
        const requestPayload: Record<string, unknown> = {
          model: actualModel,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt || '分析剧本标题格式并返回 pattern、flags、patternDescription 的 JSON。' },
            { role: 'user', content: sampleText.slice(0, 4000) }
          ]
        };
        if (enableThinking) {
          requestPayload.enable_thinking = true;
          requestPayload.extra_body = { thinking: { type: 'enabled' } };
        } else {
          requestPayload.thinking = { type: 'disabled' };
          requestPayload.extra_body = { thinking: { type: 'disabled' } };
        }
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keyToUse}` },
          body: JSON.stringify(requestPayload)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        const parsed = robustParseJson(body.choices?.[0]?.message?.content || '{}') || {};
        if (parsed.scenePattern || parsed.pattern || parsed.tocPattern) {
          return res.json({ 
            ...parsed,
            confidence: 'ai' 
          });
        }
      }

    } catch (error: any) {
      console.warn("DeepSeek pattern recognition unavailable, falling back to heuristic engine:", error.message || error);
    }

    // Heuristic inference fallback when DeepSeek is unavailable or explicitly disabled.
    const fallbackResult = inferPatternHeuristically(sampleText);
    return res.json({
      tocPattern: fallbackResult.tocPattern,
      scenePattern: fallbackResult.scenePattern,
      flags: fallbackResult.flags,
      patternDescription: fallbackResult.patternDescription,
      confidence: "heuristic"
    });
  });

  // API Route for DeepSeek Generation
  app.post("/api/script/assess-change", async (req, res) => {
    try {
      const { action, affected_scene_orders, char_delta, before_snippet, after_snippet, apiKey, modelType = 'auto' } = req.body;
      const { endpoint, actualModel, apiKey: keyToUse, enableThinking } = getModelConfig(modelType, apiKey);

      const requestPayload: Record<string, unknown> = {
        model: actualModel,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: "system",
            content: '你是一个剧本版本意图判定助手。请仔细对比 before_snippet 和 after_snippet 评估修改级别(trivial/scene_edit/structural)。关键要求：summary 必须极其具体地说明改了什么内容。根据实际动作选择最贴切的句式，例如：删除操作用“删除了[某某剧情/词语]”；新增操作用“新增了[某某剧情/词语]”；替换操作用“将[原内容]改为[新内容]”。不要写“改台词”等模糊废话，也不要生硬套用替换句式。限制在15字以内。必须输出 JSON：{"scale":"trivial"|"scene_edit"|"structural", "summary":string}'
          },
          {
            role: "user",
            content: JSON.stringify({
              action,
              affected_scene_orders,
              char_delta,
              before_snippet,
              after_snippet
            })
          }
        ]
      };

      if (enableThinking) {
        requestPayload.enable_thinking = true;
        requestPayload.extra_body = { thinking: { type: 'enabled' } };
      } else {
        requestPayload.thinking = { type: 'disabled' };
        requestPayload.extra_body = { thinking: { type: 'disabled' } };
      }

      const fetchOptions: RequestInit = {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${keyToUse}`,
        },
        body: JSON.stringify(requestPayload),
      };

      const response = await fetch(endpoint, fetchOptions);
      if (!response.ok) {
        throw new Error(`Model API error: HTTP ${response.status}`);
      }

      const body = await response.json();
      const resultText = body.choices?.[0]?.message?.content || '{}';
      const parsed = robustParseJson(resultText) || {};
      
      return res.json({
        scale: parsed.scale || 'trivial',
        should_version: parsed.should_version || false,
        summary: parsed.summary || ''
      });

    } catch (error: any) {
      console.error('Assess change error:', error);
      // Fallback
      return res.json({ scale: 'trivial', should_version: false, summary: '' });
    }
  });

  app.post("/api/generate", async (req, res) => {
    try {
      const { prompt, apiKey, systemPrompt, modelType = 'auto' } = req.body;
      if (modelType === 'heuristic') return res.status(400).json({ error: '该节点不支持启发式模型。' });
      const { endpoint, actualModel, apiKey: keyToUse, stream, enableThinking, reasoningEffort } = getModelConfig(modelType, apiKey);

      const requestPayload: Record<string, unknown> = {
        model: actualModel,
        messages: [
          {
            role: "system",
            content: systemPrompt || "You are an AI assistant that generates highly descriptive image prompts based on user input. Only reply with the prompt text."
          },
          {
            role: "user",
            content: prompt
          }
        ]
      };

      if (stream) {
        requestPayload.stream = true;
      }
      if (enableThinking) {
        requestPayload.enable_thinking = true;
        requestPayload.reasoning_effort = reasoningEffort;
        requestPayload.extra_body = {
          enable_thinking: true,
          reasoning_effort: reasoningEffort,
          thinking: { type: 'enabled' },
        };
      } else {
        requestPayload.thinking = { type: 'disabled' };
        requestPayload.extra_body = {
          thinking: { type: 'disabled' },
        };
      }

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${keyToUse}`
        },
        body: JSON.stringify(requestPayload)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `API Error: ${response.status}`);
      }
      const data = await parseChatCompletionResponse(response, !!stream);
      res.json({ result: data.content });
    } catch (error: any) {
      console.error("DeepSeek API Error:", error);
      res.status(500).json({ error: error.message || "Internal Server Error" });
    }
  });

  app.get('/api/agent/prompt', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const reqType = String(req.query.type || 'main');
    const type: 'main' | 'state' | 'landmarks' | 'jsonAdapter' = 
      reqType === 'state' ? 'state' :
      reqType === 'landmarks' || reqType === 'subject_landmarks' ? 'landmarks' :
      reqType === 'jsonAdapter' || reqType === 'json_adapter' ? 'jsonAdapter' : 'main';
    res.json({ prompt: getPrompt(type), type });
  });

  app.post('/api/agent/prompt', express.json(), (req, res) => {
    try {
      const { prompt, type = 'main' } = req.body;
      if (typeof prompt !== 'string') {
        return res.status(400).json({ error: 'Invalid prompt content' });
      }
      const reqType = String(type);
      const targetType: 'main' | 'state' | 'landmarks' | 'jsonAdapter' =
        reqType === 'state' ? 'state' :
        reqType === 'landmarks' || reqType === 'subject_landmarks' ? 'landmarks' :
        reqType === 'jsonAdapter' || reqType === 'json_adapter' ? 'jsonAdapter' : 'main';
      const defaultPath = targetType === 'state'
        ? defaultStatePromptFilePath
        : targetType === 'landmarks'
        ? defaultLandmarksPromptFilePath
        : targetType === 'jsonAdapter'
        ? defaultJsonAdapterPromptFilePath
        : defaultPromptFilePath;
      const customPath = targetType === 'state'
        ? customStatePromptFilePath
        : targetType === 'landmarks'
        ? customLandmarksPromptFilePath
        : targetType === 'jsonAdapter'
        ? customJsonAdapterPromptFilePath
        : customPromptFilePath;

      if (fs.existsSync(path.dirname(defaultPath))) {
        fs.writeFileSync(defaultPath, prompt, 'utf-8');
      }
      if (!fs.existsSync(customPromptDir)) {
        fs.mkdirSync(customPromptDir, { recursive: true });
      }
      fs.writeFileSync(customPath, prompt, 'utf-8');
      res.json({ success: true, type: targetType });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post('/api/agent/turn', async (req, res) => {
    try {
      const { 
        userMessage, 
        history = [], 
        events = [], 
        observations = [], 
        project, 
        task, 
        apiKey, 
        modelType = 'deepseek-v4-flash', 
        enabledTools, 
        requireTool = false, 
        images = [], 
        cardContext,
        jsonAdapterModel,
        jsonAdapterKey,
        jsonAdapterPrompt: customJsonAdapterPrompt,
      } = req.body;
      const { endpoint, actualModel, apiKey: keyToUse, stream, enableThinking, reasoningEffort } = getModelConfig(modelType, apiKey);
      if (!userMessage || typeof userMessage !== 'string') return res.status(400).json({ error: '缺少用户消息。' });

      const allToolIds = new Set<string>(AGENT_TOOL_REGISTRY.map((tool) => tool.id));
      const enabledToolIds = new Set(Array.isArray(enabledTools)
        ? enabledTools.filter((tool): tool is string => typeof tool === 'string' && allToolIds.has(tool))
        : AGENT_TOOL_REGISTRY.map((tool) => tool.id));
      const toolPrompt = AGENT_TOOL_REGISTRY
        .filter((tool) => enabledToolIds.has(tool.id))
        .map((tool) => `【${tool.id}】\n  描述：${tool.description}\n  支持的参数：${tool.input}\n  调用示例：{{调用 ${tool.id}, ${tool.input}}}`)
        .join('\n\n');
      const systemPrompt = getSystemPrompt().replace('{toolPrompt}', toolPrompt);

            const formatObservations = (obsList: any[]) => {
        let pageObs: string[] = [];
        let toolObs: string[] = [];

        const formatPage = (page: any) => {
          let text = `【观察结果】 (区域: ${page.scope || 'overview'})\n`;
          if (page.notices && page.notices.length) {
            text += `页面提示：${page.notices.map((n: any) => n.label).join(' | ')}\n`;
          }
          if (page.canvas) {
            text += `画布状态：缩放比例 ${(page.canvas.scale * 100).toFixed(0)}% (LOD模式: ${page.canvas.lodMode}) | 画布卡片总数: ${page.canvas.totalCards} | 视口内可见卡片数: ${page.canvas.visibleCount}\n`;
            if (page.canvas.focusedCard) {
              const fc = page.canvas.focusedCard;
              text += `【聚焦卡片详情】ID: ${fc.id} | 标题: ${fc.title} | 状态: ${fc.state} | 比例: ${fc.ratio} | 分辨率: ${fc.resolution}\n- 提示词: "${fc.prompt || '无'}"\n`;
              if (fc.lastGeneratedPrompt && fc.lastGeneratedPrompt !== fc.prompt) {
                text += `- 历史生成提示词: "${fc.lastGeneratedPrompt}"\n`;
              }
              if (fc.model) text += `- 关联模型: ${fc.model}\n`;
              if (fc.referenceImagesCount) text += `- 参考图: ${fc.referenceImagesCount} 张\n`;
              if (fc.hasImage) text += `- 图像画面: 已生成可用\n`;
            }
          }
          if (page.script) {
            if (page.script.directory) {
              text += `目录滚动状态：[${page.script.directory.atTop ? '已到顶' : '未到顶'} | ${page.script.directory.atBottom ? '已到底' : '未到底'}]\n`;
            }
            if (page.script.search) {
              text += `搜索替换面板：[${page.script.search.isOpen ? '已展开' : '已收起'}]`;
              if (page.script.search.isOpen) {
                text += ` | 搜索词: "${page.script.search.searchText}" | 匹配状态: ${page.script.search.matchStatus} | 替换为: "${page.script.search.replaceText}" | 区分大小写: [${page.script.search.isCaseSensitive ? '开启' : '关闭'}]`;
                if (page.script.search.feedback) {
                  text += ` | 反馈提示: "${page.script.search.feedback}"`;
                }
              }
              text += '\n';
            }
            if (page.script.text?.status === 'visible') {
              if (page.script.text.visibleText) {
                text += `\n【剧本正文可见内容（已申请查看）】\n${page.script.text.visibleText}\n【正文滚动状态：${page.script.text.scroll?.atTop ? '已到顶' : '未到顶'} | ${page.script.text.scroll?.atBottom ? '已到底' : '未到底'}】\n`;
                if (page.script.text.hint) {
                  text += `提示：${page.script.text.hint}\n`;
                }
                text += '\n';
              } else if (page.script.text.hint) {
                text += `剧本正文提示：${page.script.text.hint}\n`;
              }
            }
          }
          if (page.components && page.components.length) {
            text += `可见组件列表：\n`;
            page.components.forEach((c: any) => {
              const actions = page.actionSets && page.actionSets[c.actionSet] ? page.actionSets[c.actionSet].join(', ') : '';
              const textSnippet = (c.id !== 'script.text' && c.text) ? ` | 文本: "${String(c.text).slice(0, 100)}"` : '';
              text += `- ID: ${c.id} | ${c.label || '无标签'}${textSnippet} | 可用动作: [${actions}]\n`;
            });
          } else {
            text += `无可见组件。\n`;
          }
          if (page.pagination?.truncated) {
            text += `\n注意：当前区域内容已被截断，请向下滚动或请求 nextOffset 继续查看。\n`;
          }
          return text.trim();
        };

        if (obsList && obsList.length) {
          obsList.forEach(obs => {
            if (obs.role !== 'tool' || !obs.content) return;
            const { name, status, output, error } = obs.content;
            if (status === 'failed') {
              toolObs.push(`【执行工具 ${name} 失败】\n原因：${error || '未知'}`);
              return;
            }
            
            if (name === 'page.inspect') {
              pageObs.push(formatPage(output as any));
            } else if (name === 'ui.actAndObserve') {
              const pageText = output.page ? formatPage(output.page) : '无最新页面数据。';
              pageObs.push(`【UI交互成功】动作 ${output.action} 作用于 ${output.targetId}。\n${pageText}`);
            } else if (name === 'guide.lookup') {
              toolObs.push(`【操作指南查询结果】\n查询词：${output.query || '未提供'}\n指南内容：${output.guidance}`);
            } else {
              toolObs.push(`【工具 ${name} 执行成功】\n${typeof output === 'string' ? output : JSON.stringify(output)}`);
            }
          });
        }

        return {
          pageObservations: pageObs.length ? pageObs.join('\n\n') : '暂无页面事实，请先调用 page.inspect 观察。',
          toolResults: toolObs.length ? toolObs.join('\n\n') : '暂无。'
        };
      };

      const formatHistory = (histList: any[], eventList: any[]) => {
        let text = '';
        if (histList && histList.length) {
          const failures = histList.map(item => {
            if (item.role === 'agent' && item.content?.name === 'agent.failure_summary') return `【经验总结】${item.content.summary}`;
            if (item.role === 'tool' && item.content?.status === 'failed') return `【失败尝试】调用 ${item.content.name} 失败：${item.content.error || item.content.message}`;
            return '';
          }).filter(Boolean);
          if (failures.length) text += failures.join('\n') + '\n\n';
        }
        if (!eventList || !eventList.length) return text || '暂无。';
        const recentEvents = eventList.slice(-15);
        let currentTurn = '';
        recentEvents.forEach(ev => {
          if (ev.turnId && ev.turnId !== currentTurn) {
            currentTurn = ev.turnId;
            text += `\n[第 ${currentTurn.split(':').pop()} 轮]\n`;
          }
          if (ev.type === 'user') text += `用户指令：${ev.text}\n`;
          // 注意：思考过程（thought）不沉淀入 Agent 认知记录与历史上下文中，仅保留明确的事实和工具动作
          else if (ev.type === 'tool') {
            text += `执行动作：调用 ${ev.toolName}, 参数：${JSON.stringify(ev.input || {})}\n`;
            if (ev.status === 'succeeded') {
              if (ev.toolName === 'page.inspect') text += `执行结果：[已观察页面，详见当前最新观察]\n`;
              else if (ev.toolName === 'guide.lookup') text += `执行结果：[已查阅操作指南]\n`;
              else {
                let out = typeof ev.output === 'string' ? ev.output : JSON.stringify(ev.output || '');
                if (out.length > 200) out = out.substring(0, 200) + '...';
                text += `执行结果：${out}\n`;
              }
            } else if (ev.status === 'failed') {
              text += `执行结果：[失败] ${ev.error}\n`;
            }
          }
        });
        return text.trim() || '暂无。';
      };

      const formatPlan = (plan: any[]) => {
        if (!Array.isArray(plan) || plan.length === 0) return '暂无计划';
        return plan.map(item => `[${item.status === 'completed' ? 'x' : ' '}] ${item.title}`).join('\n');
      };

      const formattedObs = formatObservations(observations);
      
      const cleanUserGoalText = (text: string): string => {
        if (!text) return '';
        let cleaned = text.replace(/# 目标卡片与拓扑上下文信息[\s\S]*?用户针对该卡片的指令[:：]\s*/gi, '');
        cleaned = cleaned.replace(/【当前右键聚焦的目标卡片信息】[\s\S]*?用户针对该卡片的指令[:：]\s*/gi, '');
        return cleaned.trim() || text.trim();
      };

      const displayUserMessage = cleanUserGoalText(userMessage) || '（无新指令）';

      const effectiveCardContext = cardContext || task?.cardContext;
      let cardContextInjection = '';
      if (effectiveCardContext) {
        if (effectiveCardContext.markdownSummary) {
          cardContextInjection = `\n${effectiveCardContext.markdownSummary}\n\n`;
        } else {
          const rawAnnotations = Array.isArray(effectiveCardContext.annotations)
            ? effectiveCardContext.annotations
            : (Array.isArray(effectiveCardContext.landmarks?.elements) ? effectiveCardContext.landmarks.elements : []);
          let annotationsText = '';
          if (rawAnnotations.length > 0) {
            annotationsText = `\n- 已有元素标注 (${rawAnnotations.length} 项):\n` +
              rawAnnotations.map((a: any) => `  * [${a.id}] ${a.label} (${a.category || '元素'}${a.point ? ` 坐标[${a.point.x},${a.point.y}]` : ''})${a.description ? ` - ${a.description}` : ''}`).join('\n');
          }
          cardContextInjection = `
# 目标卡片上下文信息 (Selected Card Context)
- 卡片ID：${effectiveCardContext.cardId || effectiveCardContext.id || '未知'}
- 标题/分集：${effectiveCardContext.title || effectiveCardContext.fileName || '未命名卡片'}
- 卡片提示词：${effectiveCardContext.prompt || '无提示词'}
- 比例/分辨率：${effectiveCardContext.aspectRatio || effectiveCardContext.ratio || '默认'} (${effectiveCardContext.resolution || effectiveCardContext.res || '2K'})
${effectiveCardContext.imageUrl ? '- 图像数据：已随请求注入多模态视觉上下文' : ''}${annotationsText}
`;
        }
      }

      const finalPrompt = (cardContextInjection + getSystemPrompt())
        .replace('{{taskTitle}}', task.title || '尚未命名')
        .replace('{{taskGoal}}', cleanUserGoalText(task.goal) || '尚未设定')
        .replace('{{taskSubGoal}}', task.subGoal || '暂未设定')
        .replace('{{taskProgress}}', task.progress || '刚刚开始')
        .replace('{{taskPlan}}', formatPlan(task.plan))
        .replace('{{taskNotes}}', task.notes || '暂无笔记')
        .replace('{{userMessage}}', displayUserMessage)
        .replace('{{history}}', formatHistory(history, events))
        .replace('{{toolPrompt}}', toolPrompt)
        .replace('{{pageObservations}}', formattedObs.pageObservations)
        .replace('{{toolResults}}', formattedObs.toolResults);

      const allImages: string[] = [
        ...(Array.isArray(images) ? images : []),
        ...(Array.isArray(task?.images) ? task.images : []),
        ...(Array.isArray(effectiveCardContext?.images) ? effectiveCardContext.images : []),
        ...(effectiveCardContext?.imageUrl ? [effectiveCardContext.imageUrl] : []),
      ].filter((img, idx, arr) => typeof img === 'string' && img.length > 0 && arr.indexOf(img) === idx);

      let userContent: any = finalPrompt;
      if (allImages.length > 0) {
        userContent = [
          { type: 'text', text: finalPrompt },
          ...allImages.map((img: string) => ({
            type: 'image_url',
            image_url: {
              url: img,
              detail: 'auto',
            }
          }))
        ];
      }

      const messages = [
        { role: 'user', content: userContent },
      ];
      const requestPayload: Record<string, unknown> = {
        model: actualModel,
        messages,
      };

      if (stream) {
        requestPayload.stream = true;
      }
      if (enableThinking) {
        requestPayload.thinking = { type: 'enabled' };
        requestPayload.enable_thinking = true;
        requestPayload.reasoning_effort = reasoningEffort;
        requestPayload.extra_body = {
          enable_thinking: true,
          reasoning_effort: reasoningEffort,
          thinking: { type: 'enabled' },
        };
      } else {
        requestPayload.thinking = { type: 'disabled' };
        requestPayload.extra_body = {
          thinking: { type: 'disabled' },
        };
      }

      let response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyToUse}` },
        body: JSON.stringify(requestPayload),
      });

      // If multimodal payload was rejected (e.g. text-only model or provider error), transparently retry with text-only payload
      if (!response.ok && Array.isArray(userContent)) {
        console.warn(`Vision payload rejected (${response.status}), retrying with text-only payload`);
        requestPayload.messages = [{ role: 'user', content: finalPrompt }];
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyToUse}` },
          body: JSON.stringify(requestPayload),
        });
      }
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        const rawMsg = detail?.error?.message || detail?.message || `HTTP ${response.status}`;
        const isBalanceError = /insufficient\s*balance|quota|402|out\s*of\s*credit|余额不足|欠费/i.test(rawMsg);
        
        const fallbackSystemKey = process.env.DEEPSEEK_API_KEY || process.env.DASHSCOPE_API_KEY || process.env.ZHIPU_API_KEY || process.env.SILICONFLOW_API_KEY;
        if (isBalanceError && fallbackSystemKey && keyToUse !== fallbackSystemKey) {
          console.warn(`User Key insufficient balance (${rawMsg}), retrying with system fallback API key...`);
          const retryRes = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fallbackSystemKey}` },
            body: JSON.stringify(requestPayload),
          });
          if (retryRes.ok) {
            response = retryRes;
          } else {
            throw new Error('API Key 账户余额不足 (Insufficient Balance)。请在设置页面更新有效的 API Key 或切换模型。');
          }
        } else if (isBalanceError) {
          throw new Error('API Key 账户余额不足 (Insufficient Balance)。请在设置页面更新有效的 API Key 或切换模型。');
        } else {
          throw new Error(rawMsg);
        }
      }
      const message = await parseChatCompletionResponse(response, !!stream);
      
      const narration: string[] = [];
      let speakText = '';
      let fullAnswerText = '';

      if (message.reasoning_content && message.reasoning_content.trim()) {
        narration.push(message.reasoning_content.trim());
      }
      if (typeof message.content === 'string' && message.content.trim()) {
        const fullContent = message.content;

        // 1. Match short version: 对用户说的话（简版） or 对用户说的话(简版)
        const shortMatch = fullContent.match(/(?:-|\*|\+)?\s*对用户说的话\s*[（(]\s*简版\s*[）)]\s*[:：]\s*[“"']?([\s\S]*?)[”"']?(?=(?:(?:-|\*|\+)?\s*对用户说的话\s*[（(]\s*完整版\s*[）)]|\{\{|$))/i);
        if (shortMatch && shortMatch[1]) {
          speakText = shortMatch[1].replace(/^[“"'\s]+|[”"'\s]+$/g, '').trim();
        }

        // 2. Match full version: 对用户说的话（完整版） or 对用户说的话(完整版)
        const fullMatch = fullContent.match(/(?:-|\*|\+)?\s*对用户说的话\s*[（(]\s*完整版\s*[）)]\s*[:：]\s*[“"']?([\s\S]*?)[”"']?(?=(?:(?:-|\*|\+)?\s*对用户说的话\s*[（(]\s*简版\s*[）)]|\{\{|$))/i);
        if (fullMatch && fullMatch[1]) {
          fullAnswerText = fullMatch[1].replace(/^[“"'\s]+|[”"'\s]+$/g, '').trim();
        }

        // 3. Fallback for legacy format: 对用户说的话：...
        if (!speakText && !fullAnswerText) {
          const legacyMatch = fullContent.match(/(?:-|\*|\+)?\s*对用户说的话\s*[:：]\s*[“"']?([\s\S]*?)[”"']?(?=\{\{|$)/i);
          if (legacyMatch && legacyMatch[1]) {
            const raw = legacyMatch[1].replace(/^[“"'\s]+|[”"'\s]+$/g, '').trim();
            if (raw.length <= 40) {
              speakText = raw;
              fullAnswerText = raw;
            } else {
              speakText = raw.slice(0, 30) + '...';
              fullAnswerText = raw;
            }
          }
        }

        // If only full version exists, extract first sentence for speakText
        if (!speakText && fullAnswerText) {
          const firstSentence = fullAnswerText.split(/[。！？\n]/)[0] || fullAnswerText;
          speakText = firstSentence.length > 30 ? firstSentence.slice(0, 28) + '...' : firstSentence;
        }
        // If only short version exists, fullAnswerText defaults to speakText
        if (!fullAnswerText && speakText) {
          fullAnswerText = speakText;
        }

        let cleanContent = fullContent
          .replace(/(?:-|\*|\+)?\s*对用户说的话\s*[（(][^）)]*[）)]\s*[:：][\s\S]*?(?=(?:(?:-|\*|\+)?\s*对用户说的话|\{\{|$))/gi, '')
          .replace(/(?:-|\*|\+)?\s*对用户说的话\s*[:：][\s\S]*?(?=\{\{|$)/gi, '')
          .replace(/\{\{[\s\S]*?\}\}/g, '')
          .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
          .replace(/<thought>/g, '').replace(/<\/thought>/g, '')
          .trim();

        if (cleanContent) {
          narration.push(cleanContent);
        }
      }
      
      let parsed: any = { narration, speak: speakText, response: fullAnswerText, fullAnswer: message.content || '' };
      const allowedTools = enabledToolIds;
      const toolNameByFunction = new Map(AGENT_TOOL_REGISTRY.map((tool) => [functionNameForTool(tool.id), tool.id]));
      
      const adapterToolPrompt = AGENT_TOOL_REGISTRY
        .filter((tool) => enabledToolIds.has(tool.id))
        .map((tool) => JSON.stringify({ name: tool.id, description: tool.description, parameters: parametersForTool(tool.id) }))
        .join('\n');

      let parsedToolCalls: any[] = [];
      let jsonAdapterTrace: any = null;

      if (typeof message.content === 'string') {
        const matches = [...message.content.matchAll(/\{\{([\s\S]*?)\}\}/g)];
        let actionDesc = matches.length > 0 ? matches.map(m => m[0]).join('\n') : null;
        
        // Fallback: if no {{ }} but text contains "调用" and a tool name, pass the whole text to the adapter
        if (!actionDesc && message.content.includes('调用')) {
          const hasKnownTool = AGENT_TOOL_REGISTRY.some(tool => 
            message.content.includes(tool.id) || message.content.includes(functionNameForTool(tool.id))
          ) || /标注|生图|卡片|检测|观察|actAndObserve|inspect|generate|landmarks|annotate/i.test(message.content);
          if (hasKnownTool) {
            actionDesc = message.content;
          }
        }

        if (actionDesc) {
          try {
            const adapterModelType = jsonAdapterModel || 'deepseek-v4-flash';
            const adapterKeyToUse = jsonAdapterKey || keyToUse;
            const { endpoint: adapterEndpoint, actualModel: adapterActualModel, apiKey: adapterApiKey } = getModelConfig(adapterModelType, adapterKeyToUse);

            const systemPromptTemplate = customJsonAdapterPrompt || getPrompt('jsonAdapter') || `你是一个极其精准的工具 JSON 转换与转译节点。你的任务是将 Agent 主循环输出的不标准 JSON、JS 对象结构、伪代码或自然语言动作指令，严格转译为符合对应工具 Schema 的标准 JSON 参数。\n\n【转换与纠错规则】\n1. 提取参数与 ID：\n   - 对于 card.detectLandmarks / card.annotateElements（画面元素标注节点）：\n     * 精准提取目标卡片 ID cardId（如 "card_xxx" 或 "canvas.card.xxx"）。\n     * 精准提取操作动作 action：可选值为 "detect"（默认，调用大模型检测标注）、"list"（查看已有标注列表）、"update"（修改指定标注）、"delete"（删除指定 ID 标注）、"clear"（清空所有标注）。\n     * 提取具体标注要求 requirement（支持任意自然语言要求，如"标注主要角色手持的长剑与腰间玉佩"、"识别所有光源与反光表面"等，不限部位、不限数量；若输入写作 prompt，统一映射为 requirement）。\n     * 提取合并模式 mode：可选值为 "append"（在卡片已有标注基础上追加新标注）或 "overwrite"（覆写已有标注，默认）。\n     * 提取更新数据 updates：对象数组，每一项包含 id，可选包含 label、description、category、point ({x, y})、box ([ymin, xmin, ymax, xmax])。\n     * 提取删除 ID 数组 deleteIds：如 ["elem_1", "elem_2"]。\n     * 提取 force 标识（布尔值，是否强制重新检测）。\n   - 对于 card.inspect，精准提取目标卡片 ID cardId 及 includeImage / includePrompt / includeReference / includeParameters 布尔开关。\n   - 对于 card.generate，必须精准提取卡片名称 name（规范：尽可能简短、辨识度高，如"金发女郎晚礼服"；若原输入缺失则根据 prompt 提炼 4~8 字短名）、参考卡片 ID 数组 referenceCardIds（如 ["rshuewfmu", "yow33r73x"]）和 targetCardId（如 "new" 表示新建生图卡片）、完整的 prompt 文本（保留全部句子与逗号，不得截断）及 aspectRatio 等属性。绝不能将字段名误当作卡片 ID！\n2. 修复非标格式：遇到未加双引号的 Key（如 cardId: "xxx"）或单引号文本，一律重写纠正为标准合法 JSON。\n3. 数值转化 (特别是 mouse.scroll)：严禁输出方向字符串。必须将滚动意图转换为 delta 像素数值。\n4. 状态提取：对于 sys.updateState，准确提取对应字段（如 taskTitle, goal, subGoal, progress, notes, notesMode, plan 等）。\n\n可用工具的 JSON Schema：\n{{adapterToolPrompt}}\n\n请输出严格的 JSON 格式，格式如下：\n{ "tool_calls": [{ "name": "工具名称", "arguments": { "参数名": "参数值" } }] }`;

            const finalAdapterPrompt = systemPromptTemplate.includes('{{adapterToolPrompt}}')
              ? systemPromptTemplate.replace('{{adapterToolPrompt}}', adapterToolPrompt)
              : systemPromptTemplate + `\n\n可用工具的 JSON Schema：\n${adapterToolPrompt}`;

            const parseResponse = await fetch(adapterEndpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adapterApiKey}` },
              body: JSON.stringify({
                model: adapterActualModel,
                response_format: { type: 'json_object' },
                thinking: { type: 'disabled' },
                extra_body: { thinking: { type: 'disabled' } },
                messages: [
                  { 
                    role: 'system', 
                    content: finalAdapterPrompt
                  },
                  { role: 'user', content: actionDesc }
                ]
              })
            });
            if (parseResponse.ok) {
              const parseBody = await parseResponse.json();
              const rawContent = parseBody.choices?.[0]?.message?.content || '{}';
              const parsedResult = robustParseJson(rawContent) || {};
              if (Array.isArray(parsedResult.tool_calls)) {
                parsedToolCalls = parsedResult.tool_calls;
              }
              jsonAdapterTrace = {
                mode: 'llm_adapter_node',
                description: '工具 JSON 转译节点 LLM 语义转译（移除本地解析器，统一大模型结构化提取）',
                rawInput: actionDesc,
                adapterModel: adapterActualModel,
                parsedOutput: parsedToolCalls,
              };
            } else {
              console.warn('Failed to parse natural language tool call. Status:', parseResponse.status);
            }
          } catch (e) {
            console.warn('Failed to parse natural language tool call:', e);
          }
        }
      }

      const toolCalls = parsedToolCalls.flatMap((call: any, index: number) => {
        let name = call?.name;
        // fallback matching underscore names to dot names
        if (toolNameByFunction.has(name)) name = toolNameByFunction.get(name);
        
        if (!name || !allowedTools.has(name)) return [];
        try {
          const arguments_ = typeof call.arguments === 'object' ? call.arguments : (robustParseJson(call.arguments || '{}') || {});
          if (!arguments_ || typeof arguments_ !== 'object') return [];
          const id = call.id || `call_${Date.now()}_${index}`;
          return [{ id, name, arguments: arguments_ }];
        } catch { return []; }
      });

      const hasEndTask = toolCalls.some(c => c.name === 'sys.endTask');
      const isComplete = hasEndTask || parsed.complete === true;

      if (requireTool && toolCalls.length === 0 && !isComplete) {
        console.warn('Agent required a tool call but returned none:', JSON.stringify({ content: message.content }));
      }
      res.json({
        narration: Array.isArray(parsed.narration) ? parsed.narration.filter((item: unknown) => typeof item === 'string') : [],
        speak: typeof parsed.speak === 'string' ? parsed.speak : undefined,
        fullAnswer: typeof parsed.fullAnswer === 'string' ? parsed.fullAnswer : undefined,
        taskTitle: typeof parsed.taskTitle === 'string' ? parsed.taskTitle : undefined,
        goal: typeof parsed.goal === 'string' ? parsed.goal : undefined,
        progress: typeof parsed.progress === 'string' ? parsed.progress : undefined,
        failureSummaries: Array.isArray(parsed.failureSummaries) ? parsed.failureSummaries.filter((item: unknown) => typeof item === 'string' && item.trim()) : undefined,
        plan: Array.isArray(parsed.plan) ? parsed.plan.flatMap((item: any) => item && typeof item.id === 'string' && typeof item.title === 'string'
          ? [{ id: item.id, title: item.title, status: item.status === 'completed' ? 'completed' : 'pending' }]
          : []) : undefined,
        toolCalls,
        jsonAdapterTrace,
        response: typeof parsed.response === 'string' ? parsed.response : undefined,
        waitForUser: typeof parsed.waitForUser === 'string' ? parsed.waitForUser : undefined,
        complete: isComplete,
        // This is a local development endpoint. The browser debugging panel
        // receives the assembled model request and raw provider response, but
        // never API credentials.
        debug: {
          request: {
            model: actualModel,
            messages,
          },
          response: {
            content: message.content ?? null,
            toolCalls: parsedToolCalls,
          },
        },
      });
    } catch (error: any) {
      console.error('Agent turn error:', error);
      res.status(500).json({ error: error.message || 'Agent turn failed' });
    }
  });

  // Dedicated Lightweight Cognitive State Update Node
  app.post('/api/agent/update-state-node', async (req, res) => {
    try {
      const { currentTask, userMessage, lastTurnOutput, apiKey, model } = req.body || {};
      const { endpoint, actualModel, apiKey: keyToUse } = getModelConfig(model || 'deepseek-v4-flash', apiKey);

      let statePromptTemplate = getPrompt('state');
      if (!statePromptTemplate || !statePromptTemplate.trim()) {
        statePromptTemplate = `你是一个超高效、高精度的 Agent 认知状态提取与更新节点。
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
}
`;
      }

      const prompt = statePromptTemplate
        .replace('{{taskTitle}}', currentTask?.title || '尚未命名')
        .replace('{{taskGoal}}', currentTask?.goal || '尚未设定')
        .replace('{{taskSubGoal}}', currentTask?.subGoal || '暂未设定')
        .replace('{{taskProgress}}', currentTask?.progress || '刚刚开始')
        .replace('{{taskPlan}}', JSON.stringify(currentTask?.plan || []))
        .replace('{{taskNotes}}', currentTask?.notes || '暂无笔记')
        .replace('{{userMessage}}', userMessage || '（无新指令）')
        .replace('{{lastTurnOutput}}', typeof lastTurnOutput === 'string' ? lastTurnOutput : JSON.stringify(lastTurnOutput || {}));

      const requestPayload = {
        model: actualModel,
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
        extra_body: { thinking: { type: 'disabled' } },
        messages: [
          { role: 'system', content: '你是一个严格输出 JSON 的认知状态更新节点。' },
          { role: 'user', content: prompt }
        ]
      };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyToUse}` },
        body: JSON.stringify(requestPayload),
      });

      if (!response.ok) {
        const errText = await response.text();
        const speakText = typeof lastTurnOutput === 'object' && lastTurnOutput?.speak ? String(lastTurnOutput.speak) : '';
        const fallbackTitle = (userMessage || currentTask?.title || '任务运行').slice(0, 10);
        const fallbackSubGoal = speakText ? speakText.slice(0, 30) : (currentTask?.subGoal || userMessage || '正在推进任务');

        return res.status(200).json({
          taskTitle: fallbackTitle,
          goal: userMessage || currentTask?.goal,
          subGoal: fallbackSubGoal,
          progress: speakText ? '已完成本轮回答与分析' : (currentTask?.progress || '步骤运行中'),
          notes: speakText ? speakText.slice(0, 100) : undefined,
          notesMode: 'append',
          debugPrompt: prompt,
          fallbackNotice: `接口响应异常 (${response.status})，已启用启发式保底提炼机制`,
          apiError: errText,
        });
      }

      const data = await parseChatCompletionResponse(response, false);
      let parsed: any = {};
      try {
        parsed = JSON.parse(data.content || '{}');
      } catch {
        console.warn('Failed to parse json from state node output:', data.content);
      }

      res.json({
        taskTitle: typeof parsed.taskTitle === 'string' && parsed.taskTitle.trim() ? parsed.taskTitle.trim() : undefined,
        goal: typeof parsed.goal === 'string' && parsed.goal.trim() ? parsed.goal.trim() : undefined,
        subGoal: typeof parsed.subGoal === 'string' && parsed.subGoal.trim() ? parsed.subGoal.trim() : undefined,
        progress: typeof parsed.progress === 'string' && parsed.progress.trim() ? parsed.progress.trim() : undefined,
        plan: Array.isArray(parsed.plan) ? parsed.plan : undefined,
        notes: typeof parsed.notes === 'string' ? parsed.notes : undefined,
        notesMode: parsed.notesMode === 'overwrite' ? 'overwrite' : 'append',
        debugPrompt: prompt,
      });
    } catch (err: any) {
      console.error('Update state node error:', err);
      res.status(500).json({ error: err.message || 'State node update failed' });
    }
  });

  // Dedicated JSON Adapter Node (/api/agent/json-adapter)
  app.post('/api/agent/json-adapter', express.json(), async (req, res) => {
    try {
      const { sampleText, input, systemPrompt, modelType = 'deepseek-v4-flash', apiKey } = req.body;
      const rawInput = sampleText || input || '';
      const { endpoint, actualModel, apiKey: keyToUse } = getModelConfig(modelType, apiKey);

      const allTools = AGENT_TOOL_REGISTRY;
      const adapterToolPrompt = allTools
        .map((tool) => JSON.stringify({ name: tool.id, description: tool.description, parameters: parametersForTool(tool.id) }))
        .join('\n');

      const systemPromptTemplate = systemPrompt || getPrompt('jsonAdapter') || `你是一个极其精准的工具 JSON 转换与转译节点。你的任务是将 Agent 主循环输出的不标准 JSON、JS 对象结构、伪代码或自然语言动作指令，严格转译为符合对应工具 Schema 的标准 JSON 参数。\n\n【转换与纠错规则】\n1. 提取参数与 ID：\n   - 对于 card.detectLandmarks / card.annotateElements（画面元素标注节点）：\n     * 精准提取目标卡片 ID cardId（如 "card_xxx" 或 "canvas.card.xxx"）。\n     * 精准提取操作动作 action：可选值为 "detect"（默认，调用大模型检测标注）、"list"（查看已有标注列表）、"update"（修改指定标注）、"delete"（删除指定 ID 标注）、"clear"（清空所有标注）。\n     * 提取具体标注要求 requirement（支持任意自然语言要求，如"标注主要角色手持的长剑与腰间玉佩"、"识别所有光源与反光表面"等，不限部位、不限数量；若输入写作 prompt，统一映射为 requirement）。\n     * 提取合并模式 mode：可选值为 "append"（在卡片已有标注基础上追加新标注）或 "overwrite"（覆写已有标注，默认）。\n     * 提取更新数据 updates：对象数组，每一项包含 id，可选包含 label、description、category、point ({x, y})、box ([ymin, xmin, ymax, xmax])。\n     * 提取删除 ID 数组 deleteIds：如 ["elem_1", "elem_2"]。\n     * 提取 force 标识（布尔值，是否强制重新检测）。\n   - 对于 card.inspect，精准提取目标卡片 ID cardId 及 includeImage / includePrompt / includeReference / includeParameters 布尔开关。\n   - 对于 card.generate，必须精准提取卡片名称 name（规范：尽可能简短、辨识度高，如"金发女郎晚礼服"；若原输入缺失则根据 prompt 提炼 4~8 字短名）、参考卡片 ID 数组 referenceCardIds（如 ["rshuewfmu", "yow33r73x"]）和 targetCardId（如 "new" 表示新建生图卡片）、完整的 prompt 文本（保留全部句子与逗号，不得截断）及 aspectRatio 等属性。绝不能将字段名误当作卡片 ID！\n2. 修复非标格式：遇到未加双引号的 Key（如 cardId: "xxx"）或单引号文本，一律重写纠正为标准合法 JSON。\n3. 数值转化 (特别是 mouse.scroll)：严禁输出方向字符串。必须将滚动意图转换为 delta 像素数值。\n4. 状态提取：对于 sys.updateState，准确提取对应字段（如 taskTitle, goal, subGoal, progress, notes, notesMode, plan 等）。\n\n可用工具的 JSON Schema：\n{{adapterToolPrompt}}\n\n请输出严格的 JSON 格式，格式如下：\n{ "tool_calls": [{ "name": "工具名称", "arguments": { "参数名": "参数值" } }] }`;

      const finalPrompt = systemPromptTemplate.includes('{{adapterToolPrompt}}')
        ? systemPromptTemplate.replace('{{adapterToolPrompt}}', adapterToolPrompt)
        : systemPromptTemplate + `\n\n可用工具的 JSON Schema：\n${adapterToolPrompt}`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyToUse}` },
        body: JSON.stringify({
          model: actualModel,
          response_format: { type: 'json_object' },
          thinking: { type: 'disabled' },
          extra_body: { thinking: { type: 'disabled' } },
          messages: [
            { role: 'system', content: finalPrompt },
            { role: 'user', content: rawInput }
          ]
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        return res.status(response.status).json({ error: `JSON 转译节点请求失败: ${errText}` });
      }

      const data = await parseChatCompletionResponse(response, false);
      const parsed = robustParseJson(data.content || '{}') || {};
      res.json(parsed);
    } catch (err: any) {
      console.error('Json adapter error:', err);
      res.status(500).json({ error: err.message || 'Json adapter failed' });
    }
  });

  // Dedicated Ultra-Fast Visual Element Annotation Node (DeepSeek / Qwen / GLM / Doubao)
  app.post('/api/agent/detect-landmarks', async (req, res) => {
    try {
      const { imageUrl, slices, prompt, requirement, apiKey, model, ratio } = req.body || {};
      if (!imageUrl && (!Array.isArray(slices) || slices.length === 0)) {
        return res.status(400).json({ error: 'Missing imageUrl or slices' });
      }

      const effectiveRequirement = (typeof requirement === 'string' && requirement.trim()) ||
                                   (typeof prompt === 'string' && prompt.trim()) || '';
      if (!effectiveRequirement) {
        return res.status(400).json({
          error: '画面元素标注节点必须传入具体的标注要求 (requirement 或 prompt)，例如："标注画面中主要人物手持的武器与腰间饰品"'
        });
      }

      const { endpoint, actualModel, apiKey: keyToUse } = getModelConfig(model || 'deepseek-v4-flash', apiKey);

      const hasSlices = Array.isArray(slices) && slices.length > 1;

      let landmarksPromptTemplate = getPrompt('landmarks');
      if (!landmarksPromptTemplate || !landmarksPromptTemplate.trim() || landmarksPromptTemplate.includes('人体核心解剖部位必选清单')) {
        landmarksPromptTemplate = `你是一个具备卓越多模态视觉空间定位与语义解析能力的高级画面元素标注专家。
你的核心任务是：深入观察输入的图像，并严格根据调用方提出的【具体标注要求 (requirement)】，运用原生 Visual Grounding 空间感知能力，精准识别并定位符合要求的关键画面元素（不论是角色人物、肢体细节、服饰特征、武器道具、环境景观、建筑结构、光影氛围或微观纹理）。

【核心准则】
1. 意图驱动：一切标注严格以调用方传入的【具体标注要求】为准，切勿自作主张强行提取未要求的部位。
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
}`;
      }

      let userMessagesContent: any[] = [];

      if (hasSlices) {
        userMessagesContent.push({
          type: 'text',
          text: `这是一张纵向切分的长图，已沿纵向切分为 ${slices.length} 个局部高清切片：`
        });

        for (let i = 0; i < slices.length; i++) {
          const s = slices[i];
          userMessagesContent.push({
            type: 'text',
            text: `【切片 ${i} (sliceIndex: ${i}) / 共 ${slices.length} 个切片：${s.label}】（对应原图纵向区间: ${Math.round(s.yStartPercent)}% ~ ${Math.round(s.yStartPercent + s.heightPercent)}%）`
          });
          userMessagesContent.push({
            type: 'image_url',
            image_url: {
              url: s.dataUrl || s.imageUrl,
              detail: 'low'
            }
          });
        }

        userMessagesContent.push({
          type: 'text',
          text: `【画面元素标注任务要求】:
${effectiveRequirement}

【规范说明】:
1. 观察所有切片中的局部画面，严格依照上述要求精准定位对应的元素（若包含多个则全部提取，若画面中不存在则返回空列表并在 summary 中说明）；
2. 为每个识别出的元素标注所在切片编号 "sliceIndex": 0, 1, 2...；
3. 以及在该切片局部画面中的 2D 包围盒 "box_2d": [ymin, xmin, ymax, xmax]（0~1000 范围整数，紧贴目标像素边缘）；
4. 提供简明标签 label、category 及细节特征描述 description。
严格返回纯 JSON 格式。`
        });
      } else {
        const userTextPrompt = `请深入观察图像，并严格执行以下【具体标注要求】:
【具体标注要求】:
${effectiveRequirement}

【规范说明】:
1. 根据上述要求，定位图像中对应的关键画面元素，不要提取与要求无关的无关干扰，也绝不限制元素个数（按要求输出全部符合的元素，若无则输出空数组并在 summary 说明）；
2. 为每个元素输出精确紧贴边缘的 2D 归一化包围盒 "box_2d": [ymin, xmin, ymax, xmax]（0~1000 范围整数）；
3. 给出简短准确的标签 label、category 和视觉细节描述 description。
严格返回纯 JSON 格式。`;

        userMessagesContent = [
          {
            type: 'image_url',
            image_url: {
              url: imageUrl || (slices && slices[0]?.dataUrl),
              detail: 'low'
            }
          },
          {
            type: 'text',
            text: userTextPrompt
          }
        ];
      }

      const requestPayload = {
        model: actualModel,
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
        extra_body: { thinking: { type: 'disabled' } },
        messages: [
          { role: 'system', content: landmarksPromptTemplate },
          {
            role: 'user',
            content: userMessagesContent
          }
        ]
      };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${keyToUse}`
        },
        body: JSON.stringify(requestPayload)
      });

      if (!response.ok) {
        const errText = await response.text();
        console.info(`[LandmarksNode] Model API returned status ${response.status}:`, errText);
        const fallback = generateFallbackLandmarks(effectiveRequirement);
        return res.json({
          ...fallback,
          requirement: effectiveRequirement,
          detectedAt: Date.now(),
          modelUsed: 'heuristic_fallback',
          fallbackNotice: `视觉接口响应异常 (${response.status})，已启用启发式保底定位`,
          apiError: errText,
        });
      }

      const data = await parseChatCompletionResponse(response, false);
      let parsed: any = {};
      try {
        parsed = JSON.parse(data.content || '{}');
      } catch {
        console.warn('Failed to parse landmarks json:', data.content);
        parsed = generateFallbackLandmarks(effectiveRequirement);
      }

      // Process regions from model (supports both Object and Array structures)
      let rawRegions: Record<string, any> = {};
      if (Array.isArray(parsed.regions)) {
        for (const item of parsed.regions) {
          if (item && typeof item === 'object') {
            const key = String(item.label || item.id || item.type || item.name || '').trim().toLowerCase();
            if (key) {
              if (key.includes('head') || key.includes('头') || key.includes('面') || key.includes('face')) rawRegions.head = item;
              else if (key.includes('eye') || key.includes('眼')) rawRegions.eyes = item;
              else if (key.includes('chest') || key.includes('胸') || key.includes('领口') || key.includes('cleavage') || key.includes('neck') || key.includes('锁骨')) rawRegions.chest = item;
              else if (key.includes('leg') || key.includes('腿') || key.includes('knee') || key.includes('foot') || key.includes('feet') || key.includes('足') || key.includes('鞋')) rawRegions.legs = item;
              else if (key.includes('hand') || key.includes('手') || key.includes('arm')) {
                if (!rawRegions.hands) rawRegions.hands = [];
                rawRegions.hands.push(item);
              } else {
                rawRegions[key] = item;
              }
            }
          }
        }
      } else if (parsed.regions && typeof parsed.regions === 'object') {
        rawRegions = parsed.regions;
      }

      // Helper function to extract and transform coordinates based on slices
      function parseCentroidAndBox(item: any, fallbackType?: string): { x: number; y: number; box_2d?: [number, number, number, number]; _alreadyGlobal?: boolean } | null {
        if (!item || typeof item !== 'object') return null;

        // Parse sliceIndex robustly (handle number, string "0", "1", slice_index, slice)
        let rawIdx = item.sliceIndex ?? item.slice_index ?? item.slice;
        let sliceIdx: number | undefined = undefined;
        if (typeof rawIdx === 'number' && !isNaN(rawIdx)) {
          sliceIdx = rawIdx;
        } else if (typeof rawIdx === 'string') {
          const match = rawIdx.match(/\d+/);
          if (match) sliceIdx = parseInt(match[0], 10);
        }

        // Detect 1-based indexing if sliceIdx equals slices.length
        if (hasSlices && typeof sliceIdx === 'number') {
          if (sliceIdx >= slices.length && sliceIdx === slices.length) {
            sliceIdx = sliceIdx - 1; // Convert 1-based to 0-based
          } else if (sliceIdx < 0 || sliceIdx >= slices.length) {
            sliceIdx = undefined;
          }
        }

        // Semantic fallback if sliceIdx is missing
        if (hasSlices && sliceIdx === undefined) {
          const semantic = `${fallbackType || ''} ${item.id || ''} ${item.name || ''} ${item.label || ''} ${item.category || ''}`.toLowerCase();
          if (/head|face|eye|hair|头|面|眼|发|表情/.test(semantic)) {
            sliceIdx = 0;
          } else if (/neck|necklace|collar|chest|cleavage|bust|胸|领口|锁骨|深v/.test(semantic)) {
            sliceIdx = Math.min(1, slices.length - 1);
          } else if (/waist|hand|finger|hip|body|腰|手|指|腹|身/.test(semantic)) {
            sliceIdx = Math.min(slices.length > 3 ? 2 : 1, slices.length - 1);
          } else if (/leg|foot|feet|knee|ankle|shoe|skirt|dress|腿|足|脚|膝|踝|鞋|裙/.test(semantic)) {
            sliceIdx = slices.length - 1;
          } else {
            sliceIdx = 0;
          }
        }

        const slice = (hasSlices && typeof sliceIdx === 'number' && slices[sliceIdx]) ? slices[sliceIdx] : null;

        const rawBox = Array.isArray(item.box_2d) ? item.box_2d : (Array.isArray(item.box) ? item.box : null);
        if (rawBox && rawBox.length === 4) {
          const [b0, b1, b2, b3] = rawBox.map((v: any) => typeof v === 'number' ? v : parseFloat(v) || 0);
          const isThousandScale = Math.max(b0, b1, b2, b3) > 100;
          const scale = isThousandScale ? 10 : 1;

          let ymin = Math.min(b0, b2) / scale;
          let ymax = Math.max(b0, b2) / scale;
          let xmin = Math.min(b1, b3) / scale;
          let xmax = Math.max(b1, b3) / scale;

          if (slice) {
            ymin = slice.yStartPercent + ymin * (slice.heightPercent / 100);
            ymax = slice.yStartPercent + ymax * (slice.heightPercent / 100);
          }

          const cx = Math.round(((xmin + xmax) / 2) * 10) / 10;
          const cy = Math.round(((ymin + ymax) / 2) * 10) / 10;

          return {
            x: Math.max(0, Math.min(100, cx)),
            y: Math.max(0, Math.min(100, cy)),
            box_2d: [ymin, xmin, ymax, xmax],
            _alreadyGlobal: true,
          };
        }

        if (typeof item.x === 'number' && typeof item.y === 'number') {
          let px = item.x;
          let py = item.y;
          if (px > 100) px /= 10;
          if (py > 100) py /= 10;
          if (slice) {
            py = slice.yStartPercent + py * (slice.heightPercent / 100);
          }
          return {
            x: Math.max(0, Math.min(100, Math.round(px * 10) / 10)),
            y: Math.max(0, Math.min(100, Math.round(py * 10) / 10)),
            _alreadyGlobal: true,
          };
        }

        return null;
      }

      // Process elements using Grounding Centroid Calculation
      let rawElements = Array.isArray(parsed.elements) ? parsed.elements : (Array.isArray(parsed.interestPoints) ? parsed.interestPoints : []);
      let elements: any[] = [];
      const seenElemIds = new Set<string>();

      for (let i = 0; i < rawElements.length; i++) {
        const item = rawElements[i];
        if (!item || typeof item !== 'object') continue;
        const pos = parseCentroidAndBox(item, item.id || item.name || item.category || item.label);
        if (pos) {
          const rawId = String(item.id || item.name || `elem_${i}`).trim();
          let uniqueId = rawId;
          let counter = 1;
          while (seenElemIds.has(uniqueId)) {
            uniqueId = `${rawId}_${counter++}`;
          }
          seenElemIds.add(uniqueId);

          elements.push({
            id: uniqueId,
            label: item.label || item.name || `元素_${i + 1}`,
            category: item.category || 'detail',
            point: { x: pos.x, y: pos.y },
            box: pos.box_2d,
            description: item.description || item.label || '',
            importance: typeof item.importance === 'number' ? item.importance : 0.85,
            source: 'ai_detected',
            createdAt: Date.now(),
          });
        }
      }

      // Populate backward-compatible interestPoints from elements
      let interestPoints = elements.map(el => ({
        id: el.id,
        label: el.label,
        x: el.point.x,
        y: el.point.y,
        importance: el.importance,
        dwellSeconds: 1.8,
        transitPace: 'steady_flow',
        category: el.category,
        box: el.box,
        box_2d: el.box,
        _alreadyGlobal: true,
      }));

      // Synthesize regions for backward compatibility
      const regions: any = {};
      for (const el of elements) {
        const labelLower = (el.label + ' ' + (el.category || '')).toLowerCase();
        if (/head|face|头|面|眼/.test(labelLower) && !regions.head) {
          regions.head = { x: el.point.x, y: el.point.y, box_2d: el.box, _alreadyGlobal: true };
        } else if (/chest|bust|cleavage|胸|领口/.test(labelLower) && !regions.chest) {
          regions.chest = { x: el.point.x, y: el.point.y, box_2d: el.box, _alreadyGlobal: true };
        } else if (/leg|feet|foot|腿|足/.test(labelLower) && !regions.legs) {
          regions.legs = { x: el.point.x, y: el.point.y, box_2d: el.box, _alreadyGlobal: true };
        } else if (!regions.primaryObject) {
          regions.primaryObject = { label: el.label, x: el.point.x, y: el.point.y, box_2d: el.box, _alreadyGlobal: true };
        }
      }

      res.json({
        summary: parsed.summary || (elements.length > 0 ? `成功定位并标注 ${elements.length} 个画面元素` : '未在画面中检测到符合要求的元素'),
        requirement: effectiveRequirement,
        elements,
        interestPoints,
        regions,
        isGlobalCoordinates: true,
        detectedAt: Date.now(),
        modelUsed: actualModel,
      });
    } catch (err: any) {
      console.error('Detect landmarks error:', err);
      const fallback = generateFallbackLandmarks(req.body?.requirement || req.body?.prompt);
      res.json({
        ...fallback,
        detectedAt: Date.now(),
        modelUsed: 'heuristic_error_fallback',
        error: err.message
      });
    }
  });

  function generateFallbackLandmarks(reqText = '') {
    const elemLabel = (reqText || '').slice(0, 15).trim() || '画面核心元素';
    return {
      summary: reqText ? `根据标注要求【${reqText.slice(0, 30)}】完成保底标注` : '画面核心元素标注',
      requirement: reqText,
      elements: [
        {
          id: 'elem_fallback_1',
          label: elemLabel,
          category: 'highlight',
          point: { x: 50, y: 50 },
          box: [25, 25, 75, 75],
          description: `对应标注要求: ${reqText || '画面核心焦点'}`,
          importance: 0.9,
          source: 'ai_detected',
          createdAt: Date.now(),
        }
      ],
      interestPoints: [
        { id: 'elem_fallback_1', label: elemLabel, x: 50, y: 50, importance: 0.9, dwellSeconds: 1.8, transitPace: 'steady_flow', category: 'highlight', box_2d: [25, 25, 75, 75], _alreadyGlobal: true }
      ],
      regions: {
        primaryObject: { label: elemLabel, x: 50, y: 50, box_2d: [25, 25, 75, 75], _alreadyGlobal: true }
      }
    };
  }

  // Catch-all 404 for unmatched /api routes - ALWAYS return JSON, never fallback to Vite SPA HTML
  app.all('/api/*', (req, res) => {
    res.status(404).json({ success: false, error: `API route not found: ${req.method} ${req.path}` });
  });

  // Global error handler for API routes - ALWAYS return JSON, never HTML
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      return next(err);
    }
    console.error('[API Error]:', err);
    const rawStatus = typeof err.status === 'number' && err.status >= 400 && err.status < 600
      ? err.status
      : (typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500);
    // Cloud Run GFE intercepts 502/503/504 and replaces JSON with HTML error pages, so normalize to 500
    const safeStatus = (rawStatus === 502 || rawStatus === 503 || rawStatus === 504) ? 500 : rawStatus;
    res.status(safeStatus).json({
      success: false,
      error: err.message || 'Internal server error',
      details: err.details || undefined,
    });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        ws: false,
        watch: null,
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
