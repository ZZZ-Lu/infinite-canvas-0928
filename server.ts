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
const customPromptDir = path.join(process.cwd(), ".data");
const customPromptFilePath = path.join(customPromptDir, "systemPrompt.txt");
const customStatePromptFilePath = path.join(customPromptDir, "stateNodePrompt.txt");

function getPrompt(type: 'main' | 'state' = 'main') {
  try {
    const isProd = process.env.NODE_ENV === 'production';
    const customPath = type === 'state' ? customStatePromptFilePath : customPromptFilePath;
    const defaultPath = type === 'state' ? defaultStatePromptFilePath : defaultPromptFilePath;
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
    'sys.updateState': { properties: { taskTitle: { type: 'string' }, goal: { type: 'string' }, subGoal: { type: 'string' }, progress: { type: 'string' }, notes: { type: 'string' }, notesMode: { type: 'string', enum: ['append', 'overwrite'], description: '重点笔记模式：append（追加，默认）或 overwrite（重写替换现有笔记）' }, plan: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' } } } } } },
    'sys.endTask': { properties: { success: { type: 'boolean' }, finalResponse: { type: 'string' }, waitForUser: { type: 'string' } }, required: ['success', 'finalResponse'] },
    'user.ask': { properties: { question: { type: 'string' } }, required: ['question'] },
  };
  const schema = schemas[toolId] || { properties: {} };
  return { type: 'object', properties: schema.properties, ...(schema.required ? { required: schema.required } : {}) };
};

function trySanitizeAndParseJson(str: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(str);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}

  try {
    // Sanitize unquoted JS object keys e.g. { cardId: "rshuewfmu", prompt: "..." } -> { "cardId": "rshuewfmu", "prompt": "..." }
    const sanitized = str
      .replace(/([{,]\s*)([a-zA-Z0-9_$]+)\s*:/g, '$1"$2":')
      .replace(/:\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g, ':"$1"'); // single quote string values to double quote
    const parsed = JSON.parse(sanitized);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}

  return null;
}

function tryFastParseToolCalls(actionDesc: string): any[] | null {
  try {
    const rawMatches = [...actionDesc.matchAll(/\{\{([\s\S]*?)\}\}/g)];
    const items = rawMatches.length > 0 ? rawMatches.map(m => m[1].trim()) : actionDesc.split('\n').map(l => l.trim()).filter(Boolean);
    const parsedCalls: any[] = [];
    
    for (const item of items) {
      const trimmed = item.replace(/^调用\s*|^call\s*/i, '').trim();
      const commaIdx = trimmed.search(/[,，:\s]/);
      let toolName = commaIdx > 0 ? trimmed.slice(0, commaIdx).trim() : trimmed;
      let rest = commaIdx > 0 ? trimmed.slice(commaIdx + 1).trim() : '';
      
      toolName = toolName.replaceAll('_', '.');

      const jsonMatch = rest.match(/(\{[\s\S]*\})/);
      if (jsonMatch) {
        const args = trySanitizeAndParseJson(jsonMatch[1]);
        if (args) {
          parsedCalls.push({ name: toolName, arguments: args });
          continue;
        }
      }

      // Simple zero-ambiguity fallbacks without fragile parameter regexes
      if (toolName === 'page.inspect') {
        if (!rest || rest.includes('overview') || rest.includes('概览')) {
          parsedCalls.push({ name: 'page.inspect', arguments: { scope: 'overview' } });
        }
      } else if (toolName === 'guide.lookup') {
        const cleanQuery = rest.replace(/^["'“]|["'”]$/g, '').trim();
        if (cleanQuery) {
          parsedCalls.push({ name: 'guide.lookup', arguments: { query: cleanQuery } });
        }
      } else if (toolName === 'sys.endTask') {
        const cleanMsg = rest.replace(/^["'“]|["'”]$/g, '').trim();
        parsedCalls.push({ name: 'sys.endTask', arguments: { success: true, finalResponse: cleanMsg || '任务完成。' } });
      } else if (toolName === 'user.ask') {
        const cleanQ = rest.replace(/^["'“]|["'”]$/g, '').trim();
        if (cleanQ) {
          parsedCalls.push({ name: 'user.ask', arguments: { question: cleanQ } });
        }
      }
    }
    return parsedCalls.length > 0 ? parsedCalls : null;
  } catch {
    return null;
  }
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
    actualModel = 'deepseek-reasoner';
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
        const parsed = JSON.parse(body.choices?.[0]?.message?.content || '{}');
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
      const parsed = JSON.parse(resultText);
      
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
    const type = req.query.type === 'state' ? 'state' : 'main';
    res.json({ prompt: getPrompt(type), type });
  });

  app.post('/api/agent/prompt', express.json(), (req, res) => {
    try {
      const { prompt, type = 'main' } = req.body;
      if (typeof prompt !== 'string') {
        return res.status(400).json({ error: 'Invalid prompt content' });
      }
      const targetType = type === 'state' ? 'state' : 'main';
      const defaultPath = targetType === 'state' ? defaultStatePromptFilePath : defaultPromptFilePath;
      const customPath = targetType === 'state' ? customStatePromptFilePath : customPromptFilePath;

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
      const { userMessage, history = [], events = [], observations = [], project, task, apiKey, modelType = 'deepseek-v4-flash', enabledTools, requireTool = false, images = [], cardContext } = req.body;
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
          cardContextInjection = `
# 目标卡片上下文信息 (Selected Card Context)
- 卡片ID：${effectiveCardContext.cardId || effectiveCardContext.id || '未知'}
- 标题/分集：${effectiveCardContext.title || effectiveCardContext.fileName || '未命名卡片'}
- 卡片提示词：${effectiveCardContext.prompt || '无提示词'}
- 比例/分辨率：${effectiveCardContext.aspectRatio || effectiveCardContext.ratio || '默认'} (${effectiveCardContext.resolution || effectiveCardContext.res || '2K'})
${effectiveCardContext.imageUrl ? '- 图像数据：已随请求注入多模态视觉上下文' : ''}
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
            image_url: { url: img }
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
          );
          if (hasKnownTool) {
            actionDesc = message.content;
          }
        }

        if (actionDesc) {
          const fastCalls = tryFastParseToolCalls(actionDesc);
          if (fastCalls && fastCalls.length > 0) {
            parsedToolCalls = fastCalls;
            jsonAdapterTrace = {
              mode: 'fast_sanitizer_0ms',
              description: '0 毫秒语法修复模式（修正无引号 Key / 单引号等普通 JS 对象语法）',
              rawInput: actionDesc,
              parsedOutput: fastCalls,
            };
          } else {
            try {
              const parseResponse = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyToUse}` },
                body: JSON.stringify({
                  model: actualModel,
                  response_format: { type: 'json_object' },
                  thinking: { type: 'disabled' },
                  extra_body: { thinking: { type: 'disabled' } },
                  messages: [
                    { 
                      role: 'system', 
                      content: `你是一个极其精准的工具 JSON 转换与转译节点。你的任务是将 Agent 主循环输出的不标准 JSON、JS 对象结构、伪代码或自然语言动作指令，严格转译为符合对应工具 Schema 的标准 JSON 参数。\n\n【转换与纠错规则】\n1. 提取参数与 ID：对于 card.generate，精确提取参考卡片 ID 数组 referenceCardIds（如 ["rshuewfmu", "yow33r73x"]）和 targetCardId（如 "new" 表示新建生图卡片）、完整的 prompt 文本（保留全部句子与逗号，不得截断）及 aspectRatio 等属性。绝不能将字段名误当作卡片 ID！\n2. 修复非标格式：遇到未加双引号的 Key（如 cardId: "xxx"）或单引号文本，一律重写纠正为标准合法 JSON。\n3. 数值转化 (特别是 mouse.scroll)：严禁输出方向字符串。必须将滚动意图转换为 delta 像素数值。\n4. 状态提取：对于 sys.updateState，准确提取对应字段（如 taskTitle, notes, notesMode 等）。\n\n可用工具的 JSON Schema：\n${adapterToolPrompt}\n\n请输出严格的 JSON 格式，格式如下：\n{ "tool_calls": [{ "name": "工具名称", "arguments": { "参数名": "参数值" } }] }` 
                    },
                    { role: 'user', content: actionDesc }
                  ]
                })
              });
              if (parseResponse.ok) {
                const parseBody = await parseResponse.json();
                const parsedResult = JSON.parse(parseBody.choices?.[0]?.message?.content || '{}');
                if (Array.isArray(parsedResult.tool_calls)) {
                  parsedToolCalls = parsedResult.tool_calls;
                }
                jsonAdapterTrace = {
                  mode: 'llm_adapter_node',
                  description: '工具 JSON 转译节点 LLM 重新组装（重构非标结构或自然语言参数）',
                  rawInput: actionDesc,
                  adapterModel: actualModel,
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
      }

      const toolCalls = parsedToolCalls.flatMap((call: any, index: number) => {
        let name = call?.name;
        // fallback matching underscore names to dot names
        if (toolNameByFunction.has(name)) name = toolNameByFunction.get(name);
        
        if (!name || !allowedTools.has(name)) return [];
        try {
          const arguments_ = typeof call.arguments === 'object' ? call.arguments : JSON.parse(call.arguments || '{}');
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
      server: { middlewareMode: true },
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
