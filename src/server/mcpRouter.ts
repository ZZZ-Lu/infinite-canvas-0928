import { Router, Request, Response } from 'express';
import COS from 'cos-nodejs-sdk-v5';
import fs from 'fs';
import path from 'path';
import {
  WORKRALLY_IMAGE_MODELS,
  WORKRALLY_IMAGE_RATIOS,
  WORKRALLY_IMAGE_TOOL,
  WorkRallyImageModel,
} from '../config/workrallyImageModels';
import {
  WORKRALLY_VIDEO_MODELS,
  WORKRALLY_VIDEO_RATIOS,
  WORKRALLY_VIDEO_TOOL,
  WorkRallyVideoModel,
} from '../config/workrallyVideoModels';

export const mcpRouter = Router();

const DEFAULT_MCP_URL = 'https://workrally.qq.com/zenstudio/api/mcp';
const MCP_CACHE_FILE = path.join(process.cwd(), '.mcp_last_known.json');

function loadPersistedMcp(): { token: string; serverUrl: string; lastUpdated: number } {
  try {
    if (fs.existsSync(MCP_CACHE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(MCP_CACHE_FILE, 'utf-8'));
      if (parsed && typeof parsed.token === 'string') return parsed;
    }
  } catch {}
  return { token: '', serverUrl: DEFAULT_MCP_URL, lastUpdated: 0 };
}

function persistMcpCredentials(token: string, serverUrl: string) {
  try {
    if (token) {
      fs.writeFileSync(MCP_CACHE_FILE, JSON.stringify({ token, serverUrl, lastUpdated: Date.now() }));
    }
  } catch {}
}

// Persisted & in-memory MCP connection credentials & tools cache for ultra-fast task status checking & self-healing media proxy
let lastKnownMcp = loadPersistedMcp();
const toolsCache = new Map<string, { tools: any[]; expiresAt: number }>();

async function getCachedTools(serverUrl: string, token: string) {
  const cacheKey = `${serverUrl}:${token}`;
  const now = Date.now();
  const cached = toolsCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.tools;
  }
  const toolsResult = await callMcpEndpoint(serverUrl, token, 'tools/list', {});
  const tools: Array<{ name: string; description: string; inputSchema: any }> = toolsResult?.tools || [];
  if (tools.length > 0) {
    toolsCache.set(cacheKey, { tools, expiresAt: now + 3600_000 });
  }
  return tools;
}

const PROMPT_KEYS = ['prompt', 'text', 'query', 'input', 'description'];
const RATIO_KEYS = ['ratio', 'aspect_ratio', 'aspectRatio', 'size_ratio', 'image_ratio'];
const RESOLUTION_KEYS = ['resolution', 'res', 'quality', 'definition', 'image_resolution'];
const MODEL_KEYS = ['model', 'model_name', 'modelName', 'model_id', 'modelId'];
const REF_IMAGE_KEYS = [
  'input_images',
  'inputImages',
  'reference_images',
  'referenceImages',
  'ref_images',
  'images',
  'image_urls',
  'imageUrls',
];
const SINGLE_REF_IMAGE_KEYS = ['single_image_url', 'image_url', 'imageUrl', 'image'];
const MODEL_LIST_HINTS = ['model_list', 'models', 'list_model', 'available_model', 'canvas_image_model_list', 'canvas_video_model_list'];

interface McpRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, any>;
}

function toSafeStatus(statusCode?: any): number {
  const code = typeof statusCode === 'number' ? statusCode : 500;
  if (code >= 400 && code < 600) {
    // Cloud Run GFE intercepts 502/503/504 and replaces JSON responses with HTML error pages
    if (code === 502 || code === 503 || code === 504) return 500;
    return code;
  }
  return 500;
}

/**
 * Execute raw JSON-RPC call to WorkRally MCP endpoint
 */
async function callMcpEndpoint(
  url: string,
  token: string,
  method: string,
  params: Record<string, any> = {}
) {
  const cleanToken = token.replace(/^Bearer\s+/i, '').trim();
  const rpcBody: McpRpcRequest = {
    jsonrpc: '2.0',
    id: `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    method,
    params,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };

  if (cleanToken) {
    headers['Authorization'] = `Bearer ${cleanToken}`;
  }

  try {
    const response = await fetch(url || DEFAULT_MCP_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(rpcBody),
      signal: AbortSignal.timeout(30_000),
    });

    const contentType = response.headers.get('content-type') || '';
    let responseData: any;

    if (contentType.includes('application/json')) {
      responseData = await response.json();
    } else {
      const text = await response.text();
      try {
        responseData = JSON.parse(text);
      } catch {
        responseData = { raw: text };
      }
    }

    if (!response.ok) {
      const errorMsg = responseData?.error?.message || responseData?.message || `MCP Server returned HTTP ${response.status}`;
      const err = new Error(errorMsg);
      (err as any).statusCode = toSafeStatus(response.status);
      (err as any).responseBody = responseData;
      throw err;
    }

    if (responseData.error) {
      const errorMsg = responseData.error.message || 'MCP JSON-RPC error';
      const err = new Error(errorMsg);
      (err as any).rpcError = responseData.error;
      throw err;
    }

    return responseData.result;
  } catch (err: any) {
    if (err.name === 'TimeoutError' || err.message?.includes('timeout') || err.message?.includes('aborted')) {
      const timeoutErr = new Error('WorkRally MCP 服务连接超时 (30s)，请稍后重试');
      (timeoutErr as any).statusCode = 500;
      throw timeoutErr;
    }
    throw err;
  }
}

function normalizeTool(tool: any) {
  const props = tool?.inputSchema?.properties || {};
  const parameters = Object.entries(props).map(([name, schema]: [string, any]) => ({
    name,
    title: schema?.title || name,
    description: schema?.description || '',
    type: Array.isArray(schema?.type) ? schema.type.join(' | ') : schema?.type || 'string',
    enum: Array.isArray(schema?.enum) ? schema.enum : undefined,
    default: schema?.default,
    required: Array.isArray(tool?.inputSchema?.required) && tool.inputSchema.required.includes(name),
  }));

  return {
    name: tool.name,
    description: tool.description || '',
    inputSchema: tool.inputSchema || {},
    parameters,
  };
}

function chooseKey(props: Record<string, any>, candidates: string[]) {
  return candidates.find(key => key in props);
}

function isLikelyModelField(name: string, schema: any) {
  const lower = name.toLowerCase();
  return MODEL_KEYS.map(k => k.toLowerCase()).includes(lower) ||
    lower.includes('model') ||
    lower === 'engine' ||
    lower === 'provider';
}

function findFirstEnumDefault(schema: any) {
  return Array.isArray(schema?.enum) && schema.enum.length > 0 ? schema.enum[0] : schema?.default;
}

function coerceResolutionForSchema(value: any, schema: any) {
  if (value === undefined || value === null) return value;
  const enumValues = Array.isArray(schema?.enum) ? schema.enum : [];
  if (enumValues.includes(value)) return value;

  const isNumericType = schema?.type === 'integer' || schema?.type === 'number' || (enumValues.length > 0 && enumValues.every((v: any) => typeof v === 'number'));
  const normValue = String(value).toUpperCase().trim();

  // 1. Exact match case-insensitive
  const exactHit = enumValues.find((item: any) => String(item).toUpperCase().trim() === normValue);
  if (exactHit !== undefined) return exactHit;

  // 2. Comprehensive canonical mapping dictionary for WorkRally and standard AI models
  const resolutionMap: Record<string, { numeric: number; aliases: string[] }> = {
    '2K': {
      numeric: 5,
      aliases: ['5', '2k', '2048', '2560', '1440', 'hd', 'high', '2k_hd', 'qhd'],
    },
    '1K': {
      numeric: 4,
      aliases: ['4', '1k', '1080', '1080p', '1024', 'standard', 'medium', 'fullhd', 'fhd'],
    },
    '1080P': {
      numeric: 4,
      aliases: ['4', '1080p', '1080', '1k', '1024', 'standard', 'medium', 'high', 'fhd'],
    },
    '4K': {
      numeric: 6,
      aliases: ['6', '4k', '4096', '3840', '2160', 'uhd', 'ultra', 'ultra_hd', 'max'],
    },
    '720P': {
      numeric: 3,
      aliases: ['3', '720p', '720', 'low', 'standard', 'sd'],
    },
  };

  const targetConfig = resolutionMap[normValue] || Object.values(resolutionMap).find(cfg => cfg.aliases.includes(String(value).toLowerCase().trim()));

  if (enumValues.length > 0) {
    if (targetConfig) {
      // Match by numeric value in enum (e.g. 5 for 2K)
      const numHit = enumValues.find((item: any) => Number(item) === targetConfig.numeric);
      if (numHit !== undefined) return numHit;

      // Match by string alias
      const aliasHit = enumValues.find((item: any) => {
        const itemStr = String(item).toLowerCase().trim();
        return targetConfig.aliases.includes(itemStr) || targetConfig.aliases.some(a => itemStr === a || itemStr.includes(a));
      });
      if (aliasHit !== undefined) return aliasHit;
    }
  }

  // If schema expects integer/number (with or without enum)
  if (isNumericType && targetConfig) {
    return targetConfig.numeric;
  }

  if (isNumericType && /^\d+$/.test(String(value))) {
    return Number(value);
  }

  return value;
}

function coerceModelForSchema(value: string, schema: any): string {
  if (!value) return value;
  const enumValues = Array.isArray(schema?.enum) ? schema.enum : [];
  if (enumValues.includes(value)) return value;

  const normalize = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '').trim();
  const targetNorm = normalize(value);

  // Special alias mapping for WorkRally official models
  if (targetNorm === 'rallyvideo' || targetNorm === 'vuhkzt245c') {
    const rallyHit = enumValues.find((item: any) => {
      const norm = normalize(String(item));
      return norm === 'vuhkzt245c' || norm === 'rallyvideo';
    });
    if (rallyHit) return rallyHit;
  }

  // 1. Case-insensitive & separator-insensitive exact match
  const hit = enumValues.find((item: any) => normalize(String(item)) === targetNorm);
  if (hit) return hit;

  // 2. Partial containment match
  const partialHit = enumValues.find((item: any) => {
    const itemNorm = normalize(String(item));
    return itemNorm.includes(targetNorm) || targetNorm.includes(itemNorm);
  });
  if (partialHit) return partialHit;

  return value;
}

function coerceRatioForSchema(value: string, schema: any): string {
  if (!value) return value;
  const enumValues = Array.isArray(schema?.enum) ? schema.enum : [];
  if (enumValues.includes(value)) return value;

  const normalize = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '').trim();
  const targetNorm = normalize(value);

  // 1. Exact match case/delimiter insensitive (e.g. "9:16" matches "9/16" or "9:16")
  const exactHit = enumValues.find((item: any) => normalize(String(item)) === targetNorm);
  if (exactHit !== undefined) return exactHit;

  // 2. Common alias mapping
  const ratioAliases: Record<string, string[]> = {
    '169': ['169', '16:9', '16/9', 'landscape', 'wide', 'horizontal'],
    '916': ['916', '9:16', '9/16', 'portrait', 'vertical', 'tall'],
    '11': ['11', '1:1', '1/1', 'square'],
    '43': ['43', '4:3', '4/3'],
    '34': ['34', '3:4', '3/4'],
    '219': ['219', '21:9', '21/9', 'ultrawide'],
  };

  const matchedAliases = ratioAliases[targetNorm];
  if (matchedAliases && enumValues.length > 0) {
    const aliasHit = enumValues.find((item: any) => {
      const itemNorm = normalize(String(item));
      return matchedAliases.includes(itemNorm) || matchedAliases.some(a => itemNorm === a);
    });
    if (aliasHit !== undefined) return aliasHit;
  }

  return value;
}

function coerceModeForSchema(value: string, schema: any): string {
  if (!value) return value;
  const enumValues = Array.isArray(schema?.enum) ? schema.enum : [];
  if (enumValues.includes(value)) return value;

  const normalize = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '').trim();
  const targetNorm = normalize(value);

  // 1. Exact or case-insensitive exact match
  const hit = enumValues.find((item: any) => normalize(String(item)) === targetNorm);
  if (hit) return hit;

  // 2. Fuzzy mapping for common synonyms
  if (['subjecttovideo', 'imagetovideo', 'i2v'].includes(targetNorm)) {
    const fallback = enumValues.find((item: any) => {
      const norm = normalize(String(item));
      return norm.includes('subjecttovideo') || norm.includes('imagetovideo') || norm.includes('i2v') || norm === 'i2v';
    });
    if (fallback) return fallback;
  }

  // 3. Fallback to any non-Text mode
  if (enumValues.length > 0) {
    const nonText = enumValues.find((item: any) => {
      const norm = normalize(String(item));
      return norm !== 'text' && norm !== 't2v' && norm !== 'texttovideo';
    });
    if (nonText) return nonText;
  }

  return value;
}

function pickGenerationTool(
  tools: Array<{ name: string; description: string; inputSchema: any }>,
  isVideo: boolean,
  explicitToolName?: string
) {
  if (explicitToolName) {
    const exact = tools.find(t => t.name === explicitToolName);
    if (exact) return exact;
  }

  const scored = tools
    .map(tool => {
      const text = `${tool.name} ${tool.description || ''}`.toLowerCase();
      let score = 0;
      if (MODEL_LIST_HINTS.some(hint => text.includes(hint))) score -= 30;
      if (isVideo) {
        if (tool.name === 'canvas_generate_video') score += 50;
        if (/(video|t2v|i2v|text.?to.?video|image.?to.?video|生视频|视频生成)/i.test(text)) score += 20;
        if (!/(video|t2v|i2v|视频)/i.test(text) && /(image|t2i|生图|图片)/i.test(text)) score -= 40;
      } else {
        if (tool.name === 'canvas_generate_image') score += 50;
        if (/(image|t2i|txt2img|text.?to.?image|draw|paint|生图|图片生成|图像生成)/i.test(text)) score += 20;
        if (/(video|t2v|i2v|视频)/i.test(text)) score -= 40;
      }
      const props = tool.inputSchema?.properties || {};
      if (chooseKey(props, PROMPT_KEYS)) score += 5;
      if (Object.entries(props).some(([name, schema]) => isLikelyModelField(name, schema))) score += 3;
      return { tool, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.tool || tools[0];
}

function pickModelListTool(tools: Array<{ name: string; description: string; inputSchema: any }>, isVideo: boolean) {
  const best = tools
    .map(tool => {
      const text = `${tool.name} ${tool.description || ''}`.toLowerCase();
      let score = 0;
      if (isVideo) {
        if (tool.name === 'canvas_video_model_list') score += 50;
        if (text.includes('video') && (text.includes('model') || text.includes('list'))) score += 25;
        if (!text.includes('video') && text.includes('image')) score -= 40;
      } else {
        if (tool.name === 'canvas_image_model_list') score += 50;
        if ((text.includes('image') || text.includes('img')) && (text.includes('model') || text.includes('list'))) score += 25;
        if (text.includes('video')) score -= 50;
      }
      if (MODEL_LIST_HINTS.some(hint => text.includes(hint))) score += 5;
      return { tool, score };
    })
    .sort((a, b) => b.score - a.score)[0];
  return best && best.score > 0 ? best.tool : undefined;
}

function parseMaybeJson(value: any): any {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    const match = value.match(/```(?:json)?\s*([\s\S]*?)```/i) || value.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (match?.[1]) {
      try {
        return JSON.parse(match[1]);
      } catch {
        return value;
      }
    }
    return value;
  }
}

function extractObjectResult(result: any): Record<string, any> {
  const parsed = parseMaybeJson(result);
  if (!parsed || typeof parsed !== 'object') return {};
  if (!Array.isArray(parsed)) {
    if (parsed.bucket && parsed.region) return parsed;
    for (const key of ['data', 'result', 'structuredContent']) {
      const nested = extractObjectResult(parsed[key]);
      if (Object.keys(nested).length > 0) return nested;
    }
    if (Array.isArray(parsed.content)) {
      for (const item of parsed.content) {
        const nested = extractObjectResult(item?.text ?? item?.data ?? item);
        if (Object.keys(nested).length > 0) return nested;
      }
    }
  }
  return {};
}

function parseImageDataUrl(value: string) {
  const match = /^data:(image\/(?:jpeg|png|webp|gif|bmp));base64,([\s\S]+)$/i.exec(value);
  if (!match) return null;
  const mimeType = match[1].toLowerCase();
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) throw new Error('参考图内容为空，请重新添加图片');
  return { mimeType, extension, buffer };
}

async function uploadReferenceImage(serverUrl: string, token: string, dataUrl: string) {
  if (typeof dataUrl !== 'string' || !dataUrl) return dataUrl;

  // If it's already a safe WorkRally CDN URL, return directly
  if (/^https?:\/\/[^/]*\.gtimg\.com/i.test(dataUrl)) {
    return dataUrl;
  }

  let imageBuffer: Buffer;
  let mimeType = 'image/png';
  let extension = 'png';

  const image = parseImageDataUrl(dataUrl);
  if (image) {
    imageBuffer = image.buffer;
    mimeType = image.mimeType;
    extension = image.extension;
  } else if (/^https?:\/\//i.test(dataUrl) || dataUrl.startsWith('/')) {
    let absoluteUrl = dataUrl;
    try {
      if (dataUrl.startsWith('/')) {
        absoluteUrl = `http://localhost:3000${dataUrl}`;
      } else {
        // Rewrite local / container loopback URLs (e.g. *.run.app, localhost, 127.0.0.1, aistudio.google) to 127.0.0.1:3000
        try {
          const parsed = new URL(dataUrl);
          const isLocal = parsed.hostname === 'localhost' || 
                          parsed.hostname === '127.0.0.1' || 
                          parsed.hostname.includes('.run.app') || 
                          parsed.hostname.includes('aistudio.google');
          if (isLocal) {
            absoluteUrl = `http://localhost:3000${parsed.pathname}${parsed.search}${parsed.hash}`;
          }
        } catch (e) {
          // ignore parsing error
        }
      }
      const fetchResponse = await fetch(absoluteUrl);
      if (!fetchResponse.ok) {
        throw new Error(`Failed to fetch image from URL: ${fetchResponse.statusText} (HTTP ${fetchResponse.status})`);
      }
      const contentType = (fetchResponse.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('text/html') || contentType.includes('application/json') || contentType.includes('text/plain')) {
        throw new Error(`The target URL returned a non-image document (Content-Type: "${contentType}"). This usually means the image file does not exist on the server.`);
      }
      const arrayBuffer = await fetchResponse.arrayBuffer();
      imageBuffer = Buffer.from(arrayBuffer);
      mimeType = contentType || 'image/png';
      extension = mimeType === 'image/jpeg' ? 'jpg' : (mimeType.split('/')[1] || 'png').split(';')[0];
    } catch (err: any) {
      console.warn(`[MCP] Failed to fetch image from URL "${dataUrl}" (resolved to "${absoluteUrl}"):`, err.message);
      
      const isLocalUrl = dataUrl.startsWith('/') || 
                         dataUrl.includes('localhost') || 
                         dataUrl.includes('127.0.0.1') || 
                         dataUrl.includes('.run.app') || 
                         dataUrl.includes('aistudio.google');
      if (isLocalUrl) {
        throw new Error(`参考图加载失败：目标文件在服务器上可能已不存在或已失效，请重新添加或上传参考图（详情：${err.message}）`);
      }
      return dataUrl; // fallback only for genuine external 3P absolute URLs
    }
  } else {
    // Neither a dataUrl nor a fetchable URL
    return dataUrl;
  }

  if (!imageBuffer || !imageBuffer.length) {
    return dataUrl;
  }

  const tokenResult = await callMcpEndpoint(serverUrl, token, 'tools/call', {
    name: 'get_upload_token',
    arguments: { file_ext: extension, upload_type: 200 },
  });
  const upload = extractObjectResult(tokenResult);
  const required = ['bucket', 'region', 'tmp_secret_id', 'tmp_secret_key', 'tmp_token'];
  const missing = required.filter(key => !upload[key]);
  if (missing.length > 0) {
    throw new Error(`WorkRally 未返回完整的参考图上传凭证（缺少 ${missing.join(', ')}）。MCP 原始返回结果：${JSON.stringify(tokenResult)}`);
  }

  const uploadKey = upload.key || `zenstudio/uploads/image_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${extension}`;

  const cos = new COS({
    SecretId: upload.tmp_secret_id,
    SecretKey: upload.tmp_secret_key,
    SecurityToken: upload.tmp_token,
  });
  const result = await cos.putObject({
    Bucket: upload.bucket,
    Region: upload.region,
    Key: uploadKey,
    Body: imageBuffer,
    ContentLength: imageBuffer.length,
    Headers: { 'Content-Type': mimeType },
  });

  let location = String(result.Location || '');
  if (!location) throw new Error('参考图已上传，但 WorkRally 未返回图片地址');
  if (upload.host && upload.cdn_path) location = `//${location}`.replace(String(upload.host), String(upload.cdn_path));
  let imageUrl = /^https?:\/\//i.test(location)
    ? location
    : location.startsWith('//') ? `https:${location}` : `https://${location}`;
  const parsedUrl = new URL(imageUrl);
  if (!parsedUrl.hostname.endsWith('.gtimg.com')) {
    const configuredCdnHost = String(upload.cdn_path || 'zenvideo-pro.gtimg.com')
      .replace(/^https?:\/\//i, '')
      .replace(/^\/\//, '')
      .split('/')[0];
    parsedUrl.hostname = configuredCdnHost || 'zenvideo-pro.gtimg.com';
    imageUrl = parsedUrl.toString();
  }
  if (!new URL(imageUrl).hostname.endsWith('.gtimg.com')) {
    throw new Error('参考图上传后未能转换为 WorkRally CDN 地址');
  }
  console.log(`[MCP] Uploaded reference image (${imageBuffer.length} bytes) to ${new URL(imageUrl).hostname}`);
  return imageUrl;
}

async function normalizeReferenceImages(serverUrl: string, token: string, references: any[]) {
  const normalized = await Promise.all((Array.isArray(references) ? references : []).map(async reference => {
    const value = typeof reference === 'string' ? reference : reference?.url || reference?.dataUrl || '';
    if (!value) return '';
    if (value.startsWith('blob:')) {
      console.warn('[MCP] Reference image is still a blob URL:', value);
      return '';
    }
    try {
      return await uploadReferenceImage(serverUrl, token, value);
    } catch (err: any) {
      console.warn(`[MCP] Gracefully skipped broken reference image "${value}":`, err.message);
      return ''; // Gracefully skip broken reference images instead of crashing the whole generation
    }
  }));
  return normalized.filter(Boolean);
}

function isIgnoredToolName(nameOrId: string): boolean {
  const str = String(nameOrId || '').toLowerCase().trim();
  if (!str) return true;
  if (str.includes('canvas_generate') || str.includes('model_list') || str.includes('get_task') || str.includes('upload_token')) return true;
  if (str.includes('在无限画布中') || str.includes('获取画布中') || str.includes('生成视频') || str.includes('生成图片')) return true;
  return false;
}

function flattenContentResult(result: any): any[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.models)) return result.models;
  if (Array.isArray(result.data)) return result.data;
  if (Array.isArray(result.list)) return result.list;
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.model_list)) return result.model_list;
  if (Array.isArray(result.modelList)) return result.modelList;
  if (Array.isArray(result.records)) return result.records;
  if (Array.isArray(result.content)) {
    return result.content.flatMap((item: any) => flattenContentResult(parseMaybeJson(item.text ?? item.data ?? item.resource ?? item)));
  }
  if (typeof result === 'object') {
    if (result.data && typeof result.data === 'object') {
      const nestedData = flattenContentResult(parseMaybeJson(result.data));
      if (nestedData.length > 0) return nestedData;
    }
    for (const key of ['model_list', 'modelList', 'models', 'items', 'records', 'result', 'list', 'providers', 'data']) {
      if (Array.isArray(result[key])) return result[key];
      if (result[key] && typeof result[key] === 'object') {
        const nested = flattenContentResult(parseMaybeJson(result[key]));
        if (nested.length > 0) return nested;
      }
    }
    const values = Object.values(result);
    if (values.length > 0 && values.every(v => typeof v === 'object' && v !== null && !Array.isArray(v))) {
      return Object.entries(result).map(([k, v]: [string, any]) => ({ id: k, ...(typeof v === 'object' ? v : {}) }));
    }
  }
  return [];
}

function uniqStrings(values: any[]) {
  return Array.from(new Set(values.map(v => String(v)).filter(Boolean)));
}

function enrichDiscoveredModels(
  discovered: Array<{
    id: string;
    name: string;
    description?: string;
    ratios?: string[];
    resolutions?: any[];
    qualities?: any[];
    durations?: number[];
    supportAudio?: boolean;
    mode?: string;
    toolName?: string;
  }>,
  isVideo: boolean,
  fallbackToolName?: string
) {
  const presets = isVideo ? WORKRALLY_VIDEO_MODELS : WORKRALLY_IMAGE_MODELS;
  const defaultRatios = isVideo ? WORKRALLY_VIDEO_RATIOS : WORKRALLY_IMAGE_RATIOS;
  const defaultResolutions = isVideo
    ? [{ label: '720p', value: 720 }, { label: '1080p', value: 1080 }]
    : [{ label: '1K', value: 1024 }, { label: '2K', value: 2048 }, { label: '4K', value: 4096 }];

  const validDiscovered = discovered.filter(d => !isIgnoredToolName(d.id) && !isIgnoredToolName(d.name));

  if (validDiscovered.length === 0) {
    return presets;
  }

  const result: any[] = [];
  const seenIds = new Set<string>();

  const formatModelName = (id: string): string => {
    return id
      .replace(/[_-]/g, ' ')
      .replace(/\b\w/g, char => char.toUpperCase())
      .replace(/Flux/i, 'FLUX')
      .replace(/Sd/i, 'SD')
      .replace(/Kling/i, 'Kling (可灵)')
      .replace(/Kolors/i, 'Kolors (可图)')
      .replace(/Minimax/i, 'MiniMax (海螺)')
      .replace(/Runway/i, 'Runway');
  };

  for (const disc of validDiscovered) {
    const rawId = String(disc.id || disc.name).trim();
    if (!rawId || isIgnoredToolName(rawId) || seenIds.has(rawId.toLowerCase())) continue;
    seenIds.add(rawId.toLowerCase());

    const preset = presets.find(p =>
      p.id.toLowerCase() === rawId.toLowerCase() ||
      p.name.toLowerCase() === rawId.toLowerCase() ||
      rawId.toLowerCase().includes(p.id.toLowerCase()) ||
      p.id.toLowerCase().includes(rawId.toLowerCase())
    );

    const formatResolutions = (resList: any[]) => {
      if (!Array.isArray(resList) || resList.length === 0) {
        return preset ? preset.resolutions : defaultResolutions;
      }
      return resList.map((r: any) => {
        if (typeof r === 'object' && r !== null && r.label) return r;
        const str = String(r);
        let val: string | number = str;
        if (/^\d+$/.test(str)) val = Number(str);
        else if (str === '1K') val = 1024;
        else if (str === '2K') val = 2048;
        else if (str === '4K') val = 4096;
        else if (str === '720p') val = 720;
        else if (str === '1080p') val = 1080;
        return { label: str, value: val };
      });
    };

    const cleanName = disc.name && disc.name !== rawId && !disc.name.startsWith('{')
      ? disc.name
      : (preset ? preset.name : formatModelName(rawId));

    if (isVideo) {
      const videoPreset = preset as any;
      result.push({
        id: rawId,
        name: cleanName,
        description: disc.description || preset?.description || `WorkRally ${cleanName} 视频生成模型`,
        mode: disc.mode || videoPreset?.mode || 'Text',
        durations: Array.isArray(disc.durations) && disc.durations.length > 0 ? disc.durations : (videoPreset?.durations || [5, 10]),
        supportAudio: disc.supportAudio !== undefined ? disc.supportAudio : (videoPreset?.supportAudio ?? true),
        ratios: Array.isArray(disc.ratios) && disc.ratios.length > 0 ? disc.ratios : (preset?.ratios || defaultRatios),
        resolutions: formatResolutions(disc.resolutions || []),
        qualities: Array.isArray(disc.qualities) && disc.qualities.length > 0 ? disc.qualities : preset?.qualities,
        toolName: disc.toolName || fallbackToolName || WORKRALLY_VIDEO_TOOL,
      });
    } else {
      result.push({
        id: rawId,
        name: cleanName,
        description: disc.description || preset?.description || `WorkRally ${cleanName} 图像生成模型`,
        ratios: Array.isArray(disc.ratios) && disc.ratios.length > 0 ? disc.ratios : (preset?.ratios || defaultRatios),
        resolutions: formatResolutions(disc.resolutions || []),
        qualities: Array.isArray(disc.qualities) && disc.qualities.length > 0 ? disc.qualities : preset?.qualities,
        toolName: disc.toolName || fallbackToolName || WORKRALLY_IMAGE_TOOL,
      });
    }
  }

  return result.length > 0 ? result : presets;
}

function normalizeModelList(result: any) {
  const items = flattenContentResult(parseMaybeJson(result));
  return items.map((item: any) => {
    if (typeof item === 'string') {
      if (isIgnoredToolName(item)) return null;
      return { id: item, name: item };
    }
    const id = item.id || item.model || item.model_id || item.modelId || item.model_name || item.modelName || item.name || item.value || item.key;
    const name = item.name || item.label || item.title || item.model_name || item.modelName || id;
    const description = item.description || item.desc || item.detail || '';
    if (isIgnoredToolName(String(id)) || isIgnoredToolName(String(name))) return null;
    const ratios = uniqStrings([
      ...(Array.isArray(item.ratios) ? item.ratios : []),
      ...(Array.isArray(item.aspect_ratios) ? item.aspect_ratios : []),
      ...(Array.isArray(item.aspectRatios) ? item.aspectRatios : []),
      ...(Array.isArray(item.supported_ratios) ? item.supported_ratios : []),
    ]);
    const resolutions = uniqStrings([
      ...(Array.isArray(item.resolutions) ? item.resolutions : []),
      ...(Array.isArray(item.supported_resolutions) ? item.supported_resolutions : []),
      ...(Array.isArray(item.qualities) ? item.qualities : []),
    ]);
    const durations = Array.isArray(item.durations) ? item.durations : (item.duration ? [item.duration] : undefined);
    const supportAudio = item.support_audio ?? item.supportAudio ?? item.enable_sound ?? item.audio;
    return {
      id: String(id || name || ''),
      name: String(name || id || ''),
      description,
      ratios,
      resolutions,
      durations,
      supportAudio,
      mode: item.mode,
      raw: item,
    };
  }).filter((item: any) => item && (item.id || item.name));
}

function collectStrings(value: any, output: string[] = []): string[] {
  if (typeof value === 'string') {
    output.push(value);
    const parsed = parseMaybeJson(value);
    if (parsed !== value) collectStrings(parsed, output);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach(item => collectStrings(item, output));
    return output;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach(item => collectStrings(item, output));
  }
  return output;
}

function extractTaskIds(result: any): string[] {
  const parsed = parseMaybeJson(result);
  const found: string[] = [];
  const visit = (value: any) => {
    if (!value) return;
    if (typeof value === 'string') {
      const nested = parseMaybeJson(value);
      if (nested !== value) visit(nested);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (['task_ids', 'taskIds'].includes(key) && Array.isArray(item)) {
          item.forEach(id => found.push(String(id)));
        } else if (['task_id', 'taskId'].includes(key) && item) {
          found.push(String(item));
        } else {
          visit(item);
        }
      }
    }
  };
  visit(parsed);
  return uniqStrings(found);
}

function extractGeneratedMediaUrl(result: any, expectedType: 'image' | 'video' = 'image'): string {
  const preferredKeys = expectedType === 'video'
    ? ['video_url', 'videoUrl', 'play_url', 'playUrl', 'download_url', 'downloadUrl', 'media_url', 'mediaUrl', 'asset_url', 'assetUrl', 'url', 'uri']
    : ['image_url', 'imageUrl', 'media_url', 'mediaUrl', 'download_url', 'downloadUrl', 'asset_url', 'assetUrl', 'url', 'uri'];
  const visit = (value: any): string => {
    if (!value) return '';
    if (typeof value === 'string') {
      if (/^https?:\/\/workrally\.qq\.com\/s\//i.test(value)) return '';
      if (/^https?:\/\//i.test(value)) {
        if (expectedType === 'video' && /\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/i.test(value)) return '';
        return value;
      }
      if (expectedType === 'image' && /^data:image\//i.test(value)) return value;
      const parsed = parseMaybeJson(value);
      if (parsed !== value) return visit(parsed);
      const match = value.match(/https?:\/\/[^\s"'<>]+/);
      return match?.[0] || '';
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const url = visit(item);
        if (url) return url;
      }
      return '';
    }
    if (typeof value === 'object') {
      for (const key of preferredKeys) {
        if (key in value) {
          const url = visit(value[key]);
          if (url) return url;
        }
      }
      for (const item of Object.values(value)) {
        const url = visit(item);
        if (url) return url;
      }
    }
    return '';
  };
  return visit(result);
}

function extractAssetId(result: any): string {
  const visit = (value: any): string => {
    if (!value) return '';
    if (typeof value === 'string') {
      const parsed = parseMaybeJson(value);
      return parsed !== value ? visit(parsed) : '';
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const id = visit(item);
        if (id) return id;
      }
      return '';
    }
    if (typeof value === 'object') {
      for (const key of ['asset_id', 'assetId']) {
        if (value[key]) return String(value[key]);
      }
      for (const item of Object.values(value)) {
        const id = visit(item);
        if (id) return id;
      }
    }
    return '';
  };
  return visit(result);
}

function extractWorkRallyShareUrl(result: any): string {
  return collectStrings(result)
    .map(value => value.match(/https?:\/\/workrally\.qq\.com\/s\/[A-Za-z0-9_-]+/i)?.[0] || '')
    .find(Boolean) || '';
}

async function resolveWorkRallyShareUrl(shareUrl: string) {
  if (!shareUrl) return '';
  const response = await fetch(shareUrl, { method: 'GET', redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    return response.headers.get('location') || '';
  }
  if (!response.ok) return '';
  return /^https?:\/\/workrally\.qq\.com\/s\//i.test(response.url) ? '' : response.url;
}

function getTaskFailure(result: any): string {
  const taskText = result?.content?.find((item: any) => item?.type === 'text')?.text;
  const task = taskText ? parseMaybeJson(taskText) : null;
  if (task && typeof task === 'object' && (task.state === 5 || /failed|canceled|cancelled/i.test(String(task.state_desc || '')))) {
    return String(task.error_message || task.message || task.state_desc || '生成失败');
  }
  const text = collectStrings(result).join(' ');
  if (/(failed|failure|error|失败|已取消|canceled|cancelled)/i.test(text)) return text.slice(0, 500);
  return '';
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function isExpiredSignedMediaUrl(url: string): boolean {
  try {
    const keyTime = new URL(url).searchParams.get('q-key-time');
    const expiresAt = keyTime?.split(';')[1];
    return !!expiresAt && Number(expiresAt) * 1000 <= Date.now() + 60_000;
  } catch {
    return false;
  }
}

async function resolveAssetUrl(
  url: string,
  token: string,
  assetId: string,
  tools: Array<{ name: string; description: string; inputSchema: any }>,
  expectedType: 'image' | 'video' = 'image'
) {
  const assetTool = tools.find(tool => /(^|_)asset(_|-)get$/i.test(tool.name)) ||
    tools.find(tool => /asset/i.test(tool.name) && /get|detail/i.test(tool.name));
  const toolName = assetTool?.name || 'asset_get';
  const props = assetTool?.inputSchema?.properties || {};
  const idKey = ['asset_ids', 'assetIds', 'asset_id', 'assetId', 'id'].find(key => key in props) || 'asset_ids';
  const idSchema = props[idKey] || {};
  const idValue = idSchema.type === 'array' || idKey.endsWith('s') ? [assetId] : assetId;
  
  let result: any = null;
  try {
    result = await callMcpEndpoint(url, token, 'tools/call', {
      name: toolName,
      arguments: { [idKey]: idValue },
    });
  } catch {
    try {
      const fallbackKey = idKey === 'asset_ids' ? 'asset_id' : 'asset_ids';
      const fallbackVal = fallbackKey === 'asset_ids' ? [assetId] : assetId;
      result = await callMcpEndpoint(url, token, 'tools/call', {
        name: toolName,
        arguments: { [fallbackKey]: fallbackVal },
      });
    } catch {
      return '';
    }
  }

  const directUrl = extractGeneratedMediaUrl(result, expectedType);
  if (directUrl && !isExpiredSignedMediaUrl(directUrl)) return directUrl;

  const text = result?.content?.find((item: any) => item?.type === 'text')?.text;
  const parsed = text ? parseMaybeJson(text) : (result?.structuredContent || result);
  const detailsUrl = parsed?.asset_url || parsed?.assets?.[0]?.url || parsed?.url || parsed?.download_url || '';
  if (detailsUrl && !isExpiredSignedMediaUrl(detailsUrl)) return detailsUrl;

  // WorkRally asset_detail intentionally returns short-lived share URLs. Resolve
  // those redirects server-side so the browser receives the signed CDN media URL.
  const shareUrls = uniqStrings(collectStrings(result).flatMap(value =>
    value.match(/https?:\/\/workrally\.qq\.com\/s\/[A-Za-z0-9_-]+/gi) || []
  ));
  for (const shareUrl of shareUrls) {
    const resolvedUrl = await resolveWorkRallyShareUrl(shareUrl);
    if (!resolvedUrl) continue;
    if (expectedType === 'video') {
      if (!/\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/i.test(resolvedUrl)) return resolvedUrl;
    } else {
      if (/\.(?:jpe?g|png|webp|gif)(?:[?#]|$)/i.test(resolvedUrl)) return resolvedUrl;
    }
  }
  return directUrl || detailsUrl || '';
}

async function fetchCanvasTaskStatus(
  url: string,
  token: string,
  taskId: string,
  tools: Array<{ name: string; description: string; inputSchema: any }>,
  expectedType: 'image' | 'video' = 'image'
) {
  const lastResult = await callMcpEndpoint(url, token, 'tools/call', {
    name: 'canvas_get_task',
    arguments: { task_id: taskId },
  });

  const taskText = lastResult?.content?.find((item: any) => item?.type === 'text')?.text;
  const task = taskText ? parseMaybeJson(taskText) : (lastResult?.structuredContent || lastResult);
  const asset = task?.output_assets?.[0] || task?.assets?.[0];
  let mediaUrl = asset?.url || task?.video_url || extractGeneratedMediaUrl(lastResult, expectedType);

  if (mediaUrl) {
    if (/^https?:\/\/workrally\.qq\.com\/s\//i.test(mediaUrl)) {
      const redirected = await resolveWorkRallyShareUrl(mediaUrl);
      if (redirected && !isExpiredSignedMediaUrl(redirected)) {
        return { completed: true, mediaUrl: redirected, result: lastResult };
      }
    } else if (!isExpiredSignedMediaUrl(mediaUrl)) {
      return { completed: true, mediaUrl, result: lastResult };
    }
  }

  const assetId = asset?.asset_id || asset?.id || extractAssetId(lastResult);
  const status = String(task?.status || lastResult?.structuredContent?.status || '').toLowerCase();

  if ((status === 'success' || status === 'completed' || status === '4' || mediaUrl || assetId) && assetId) {
    const assetUrl = await resolveAssetUrl(url, token, assetId, tools, expectedType);
    if (assetUrl && !isExpiredSignedMediaUrl(assetUrl)) return { completed: true, mediaUrl: assetUrl, result: lastResult };
    const redirectedUrl = await resolveWorkRallyShareUrl(extractWorkRallyShareUrl(lastResult));
    if (redirectedUrl && !isExpiredSignedMediaUrl(redirectedUrl)) return { completed: true, mediaUrl: redirectedUrl, result: lastResult };
    if (mediaUrl) throw new Error(`WorkRally 视频链接已过期，未能刷新素材地址（asset_id: ${assetId}）`);
  }

  const failure = getTaskFailure(lastResult);
  if (failure) return { failed: true, error: failure, result: lastResult };

  return { pending: true, taskId, status: task?.status || 'running', result: lastResult };
}

async function pollCanvasTask(
  url: string,
  token: string,
  taskId: string,
  tools: Array<{ name: string; description: string; inputSchema: any }>,
  timeoutMs = 120_000,
  expectedType: 'image' | 'video' = 'image'
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetchCanvasTaskStatus(url, token, taskId, tools, expectedType);
    if (res.completed && res.mediaUrl) {
      return { mediaUrl: res.mediaUrl, result: res.result };
    }
    if (res.failed) {
      throw new Error(res.error || 'WorkRally 任务执行失败');
    }
    await wait(2500);
  }
  throw new Error(`WorkRally 任务等待超时（task_id: ${taskId}）`);
}

function buildGenerationArgs(targetTool: any, input: {
  prompt: string;
  ratio: string;
  resolution: string;
  model?: string;
  parameters?: Record<string, any>;
  referenceImages?: any[];
}) {
  const schemaProps = targetTool.inputSchema?.properties || {};
  const args: Record<string, any> = {};

  const promptKey = chooseKey(schemaProps, PROMPT_KEYS) || 'prompt';
  args[promptKey] = input.prompt;

  const ratioKey = chooseKey(schemaProps, RATIO_KEYS);
  if (ratioKey) {
    args[ratioKey] = coerceRatioForSchema(input.ratio, schemaProps[ratioKey]);
  }

  const resolutionKey = chooseKey(schemaProps, RESOLUTION_KEYS);
  if (resolutionKey) {
    args[resolutionKey] = coerceResolutionForSchema(input.resolution, schemaProps[resolutionKey]);
  }

  const modelKey = Object.entries(schemaProps).find(([name, schema]) => isLikelyModelField(name, schema))?.[0];
  if (modelKey) {
    let rawModel = (input.model || '').trim() || findFirstEnumDefault(schemaProps[modelKey]) || '';
    if (!rawModel) {
      const isVideoTool = targetTool.name.includes('video') || /(video|t2v|i2v)/i.test(targetTool.description || '');
      rawModel = isVideoTool ? WORKRALLY_VIDEO_MODELS[0].id : WORKRALLY_IMAGE_MODELS[0].id;
    }
    args[modelKey] = coerceModelForSchema(rawModel, schemaProps[modelKey]);
  }

  if (input.parameters && typeof input.parameters === 'object') {
    // 1. Direct copy of exact matches
    for (const [key, value] of Object.entries(input.parameters)) {
      if (key in schemaProps && value !== undefined && value !== null && value !== '') {
        args[key] = value;
      }
    }

    // 2. Fuzzy mapping for standard generation options
    // Audio / Sound keys
    const audioSchemaKey = ['support_audio', 'enable_sound', 'audio', 'sound', 'enableSound', 'supportAudio'].find(k => k in schemaProps);
    if (audioSchemaKey && args[audioSchemaKey] === undefined) {
      const audioVal = input.parameters.enable_sound ?? input.parameters.support_audio ?? input.parameters.audio ?? input.parameters.sound;
      if (audioVal !== undefined && audioVal !== null && audioVal !== '') {
        const expectedType = schemaProps[audioSchemaKey]?.type;
        if (expectedType === 'boolean') {
          args[audioSchemaKey] = Boolean(audioVal);
        } else {
          args[audioSchemaKey] = audioVal;
        }
      }
    }

    // Duration keys
    const durationSchemaKey = ['duration', 'video_duration', 'length', 'videoDuration'].find(k => k in schemaProps);
    if (durationSchemaKey && args[durationSchemaKey] === undefined) {
      const durationVal = input.parameters.duration ?? input.parameters.video_duration ?? input.parameters.length;
      if (durationVal !== undefined && durationVal !== null && durationVal !== '') {
        const expectedType = schemaProps[durationSchemaKey]?.type;
        if (expectedType === 'integer' || expectedType === 'number') {
          args[durationSchemaKey] = Number(durationVal);
        } else {
          args[durationSchemaKey] = durationVal;
        }
      }
    }

    // Mode keys
    const modeSchemaKey = ['mode', 'generation_mode', 'generationMode', 'video_mode'].find(k => k in schemaProps);
    if (modeSchemaKey && args[modeSchemaKey] === undefined) {
      const modeVal = input.parameters.mode ?? input.parameters.generation_mode ?? input.parameters.video_mode;
      if (modeVal !== undefined && modeVal !== null && modeVal !== '') {
        args[modeSchemaKey] = coerceModeForSchema(modeVal, schemaProps[modeSchemaKey]);
      }
    }
  }

  const refUrls = Array.isArray(input.referenceImages)
    ? input.referenceImages.map((r: any) => (typeof r === 'string' ? r : r.url || r.dataUrl)).filter(Boolean)
    : [];

  // 3. Smart mode promotion for reference-based generation if mode is set to 'Text'
  const finalModeKey = ['mode', 'generation_mode', 'generationMode', 'video_mode'].find(k => k in schemaProps);
  if (finalModeKey && refUrls.length > 0) {
    const currentMode = String(args[finalModeKey] || '').toLowerCase();
    if (!currentMode || currentMode === 'text') {
      const modeSchema = schemaProps[finalModeKey];
      const enumValues = Array.isArray(modeSchema?.enum) ? modeSchema.enum.map(v => String(v)) : [];
      
      const targetMode = enumValues.find(v => v.toLowerCase() === 'subjecttovideo') || 
                         enumValues.find(v => v.toLowerCase() === 'imagetovideo') ||
                         enumValues.find(v => v.toLowerCase() === 'i2v') ||
                         enumValues.find(v => v !== 'Text' && v !== 'text');
      if (targetMode) {
        args[finalModeKey] = targetMode;
        console.log(`[MCP] Auto-promoted generation mode to "${targetMode}" due to active reference images.`);
      }
    }
  }

  if (refUrls.length > 0) {
    const finalMode = String(args[finalModeKey || 'mode'] || args.mode || '');
    const finalModeNorm = finalMode.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (finalModeNorm === 'subjecttovideo' && 'reference_assets' in schemaProps) {
      args.reference_assets = refUrls.map(url => ({ type: 'image', url }));
    } else {
      const refKey = chooseKey(schemaProps, REF_IMAGE_KEYS);
      const singleRefKey = chooseKey(schemaProps, SINGLE_REF_IMAGE_KEYS);
      if (refKey) args[refKey] = refUrls;
      else if (singleRefKey) args[singleRefKey] = refUrls[0];
    }
  }

  for (const [key, schema] of Object.entries<any>(schemaProps)) {
    if (args[key] !== undefined) continue;
    if (schema?.default !== undefined) args[key] = schema.default;
  }

  return args;
}

/**
 * 1. Test connection & Token validity
 */
mcpRouter.post('/test', async (req: Request, res: Response) => {
  const startTime = Date.now();
  const token = req.body?.token || (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, '') : '');
  const serverUrl = req.body?.serverUrl || DEFAULT_MCP_URL;

  if (!token) {
    return res.status(400).json({
      success: false,
      error: '请提供 WorkRally Token',
    });
  }

  try {
    // 1. Send initialize
    let initResult: any = null;
    try {
      initResult = await callMcpEndpoint(serverUrl, token, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {
          roots: { listChanged: true },
          sampling: {},
        },
        clientInfo: {
          name: 'mira-canvas-agent',
          version: '1.0.0',
        },
      });
    } catch (e: any) {
      console.warn('MCP initialize returned error (attempting tools/list directly):', e.message);
    }

    // 2. Fetch tools list
    const toolsResult = await callMcpEndpoint(serverUrl, token, 'tools/list', {});
    const tools = toolsResult?.tools || [];
    const latency = Date.now() - startTime;

    return res.json({
      success: true,
      latency,
      serverInfo: initResult?.serverInfo || { name: 'WorkRally MCP' },
      toolsCount: tools.length,
      tools: tools.map((t: any) => ({
        ...normalizeTool(t),
      })),
    });
  } catch (error: any) {
    const latency = Date.now() - startTime;
    console.error('WorkRally MCP test failed:', error);
    return res.status(toSafeStatus(error.statusCode)).json({
      success: false,
      latency,
      error: error.message || '连接 MCP 服务失败',
      details: error.rpcError || error.responseBody,
    });
  }
});

/**
 * 2. Fetch available tools list
 */
mcpRouter.post('/tools', async (req: Request, res: Response) => {
  const token = req.body?.token || (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, '') : '');
  const serverUrl = req.body?.serverUrl || DEFAULT_MCP_URL;

  if (!token) {
    return res.status(400).json({ error: 'Missing token' });
  }

  try {
    const result = await callMcpEndpoint(serverUrl, token, 'tools/list', {});
    res.json({
      ...result,
      tools: (result?.tools || []).map(normalizeTool),
    });
  } catch (error: any) {
    res.status(toSafeStatus(error.statusCode)).json({
      error: error.message || 'Failed to list tools',
      details: error.rpcError || error.responseBody,
    });
  }
});

/**
 * 2b. Fetch WorkRally concrete model names and supported options
 */
mcpRouter.post('/models', async (req: Request, res: Response) => {
  const token = req.body?.token || (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, '') : '');
  const serverUrl = req.body?.serverUrl || DEFAULT_MCP_URL;
  const isVideo = Boolean(req.body?.isVideo);

  if (!token) {
    return res.status(400).json({ error: 'Missing token' });
  }

  try {
    const toolsResult = await callMcpEndpoint(serverUrl, token, 'tools/list', {});
    const tools: Array<{ name: string; description: string; inputSchema: any }> = toolsResult?.tools || [];
    const generationTool = pickGenerationTool(tools, isVideo);
    const modelListTool = pickModelListTool(tools, isVideo);

    let discoveredModels: any[] = [];
    if (modelListTool) {
      try {
        const modelResult = await callMcpEndpoint(serverUrl, token, 'tools/call', {
          name: modelListTool.name,
          arguments: {},
        });
        discoveredModels = normalizeModelList(modelResult);
      } catch (err: any) {
        console.warn(`[MCP] Call model list tool ${modelListTool.name} failed:`, err.message);
      }
    }

    const schemaProps = generationTool?.inputSchema?.properties || {};
    const ratioKey = chooseKey(schemaProps, RATIO_KEYS);
    const resolutionKey = chooseKey(schemaProps, RESOLUTION_KEYS);
    const schemaRatios = ratioKey && Array.isArray(schemaProps[ratioKey]?.enum) ? schemaProps[ratioKey].enum : [];
    const schemaResolutions = resolutionKey && Array.isArray(schemaProps[resolutionKey]?.enum) ? schemaProps[resolutionKey].enum : [];
    const modelKey = Object.entries(schemaProps).find(([name, schema]) => isLikelyModelField(name, schema))?.[0];
    const schemaModels = modelKey && Array.isArray(schemaProps[modelKey]?.enum)
      ? schemaProps[modelKey].enum.map((name: any) => ({
          id: String(name),
          name: String(name),
          ratios: schemaRatios,
          resolutions: schemaResolutions,
          toolName: generationTool?.name,
        }))
      : [];

    const allDiscovered = [
      ...discoveredModels,
      ...schemaModels,
    ];

    const fallbackToolName = generationTool?.name || (isVideo ? WORKRALLY_VIDEO_TOOL : WORKRALLY_IMAGE_TOOL);
    const enrichedModels = enrichDiscoveredModels(allDiscovered, isVideo, fallbackToolName);

    return res.json({
      success: true,
      toolName: fallbackToolName,
      generationTool: generationTool ? normalizeTool(generationTool) : null,
      modelListTool: modelListTool ? normalizeTool(modelListTool) : null,
      models: enrichedModels,
      ratios: uniqStrings([...schemaRatios, ...enrichedModels.flatMap((model: any) => model.ratios || [])]),
      resolutions: uniqStrings([...schemaResolutions, ...enrichedModels.flatMap((model: any) => (Array.isArray(model.resolutions) ? model.resolutions.map((r: any) => (typeof r === 'object' ? r.label : r)) : []))]),
    });
  } catch (error: any) {
    res.status(toSafeStatus(error.statusCode)).json({
      error: error.message || 'Failed to list models',
      details: error.rpcError || error.responseBody,
    });
  }
});

/**
 * 3. Direct tools/call pass-through
 */
mcpRouter.post('/call', async (req: Request, res: Response) => {
  const token = req.body?.token || (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, '') : '');
  const serverUrl = req.body?.serverUrl || DEFAULT_MCP_URL;
  const { name, arguments: args } = req.body;

  if (!token) {
    return res.status(400).json({ error: 'Missing token' });
  }
  if (!name) {
    return res.status(400).json({ error: 'Missing tool name' });
  }

  try {
    const result = await callMcpEndpoint(serverUrl, token, 'tools/call', {
      name,
      arguments: args || {},
    });
    res.json(result);
  } catch (error: any) {
    res.status(toSafeStatus(error.statusCode)).json({
      error: error.message || 'Tool call failed',
      details: error.rpcError || error.responseBody,
    });
  }
});

/**
 * 4. High-level generate endpoint (Image / Video) with intelligent tool matching
 */
mcpRouter.post('/generate', async (req: Request, res: Response) => {
  const token = req.body?.token || (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, '') : '');
  const serverUrl = req.body?.serverUrl || DEFAULT_MCP_URL;
  const {
    prompt,
    ratio = '16:9',
    res: resolution = '2K',
    isVideo = false,
    referenceImages = [],
    toolName,
    model,
    parameters = {},
    defer = false,
  } = req.body;

  if (!token) {
    return res.status(400).json({
      success: false,
      error: '请先在页面右上角填入 WorkRally MCP 密钥',
    });
  }

  lastKnownMcp = { token, serverUrl, lastUpdated: Date.now() };
  persistMcpCredentials(token, serverUrl);

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({
      success: false,
      error: '提示词不能为空',
    });
  }

  try {
    // 1. Discover available tools
    const toolsResult = await callMcpEndpoint(serverUrl, token, 'tools/list', {});
    const tools: Array<{ name: string; description: string; inputSchema: any }> = toolsResult?.tools || [];

    // 2. Determine best matching tool
    const targetTool = pickGenerationTool(tools, Boolean(isVideo), toolName);

    if (!targetTool) {
      throw new Error(`MCP 服务中未找到可用的${isVideo ? '生视频' : '生图'}工具。请检查 MCP 服务器注册的工具列表。`);
    }

    // 3. WorkRally generation tools accept uploaded image URLs, not browser data URLs.
    const uploadedReferenceImages = await normalizeReferenceImages(serverUrl, token, referenceImages);

    // 4. Assemble arguments according to the tool's schema
    const args = buildGenerationArgs(targetTool, {
      prompt,
      ratio,
      resolution,
      model,
      parameters,
      referenceImages: uploadedReferenceImages,
    });

    const referenceKey = Object.keys(args).find(key => key === 'reference_assets' || REF_IMAGE_KEYS.includes(key) || SINGLE_REF_IMAGE_KEYS.includes(key));
    console.log(`[MCP] Calling ${targetTool.name}. Schema properties:`, JSON.stringify(targetTool.inputSchema?.properties), `Generated Args:`, JSON.stringify(args));

    // 5. Call MCP tool
    const callResult = await callMcpEndpoint(serverUrl, token, 'tools/call', {
      name: targetTool.name,
      arguments: args,
    });

    // WorkRally generation is asynchronous. A successful submit usually returns
    // task_ids, then canvas_get_task exposes the final asset URL.
    let generatedMediaUrl = extractGeneratedMediaUrl(callResult, isVideo ? 'video' : 'image');
    let taskIds = extractTaskIds(callResult);
    console.log('[MCP] Submitted task IDs:', JSON.stringify(taskIds));

    const inlineImage = Array.isArray(callResult?.content)
      ? callResult.content.find((item: any) => item?.type === 'image' && item?.data)
      : null;
    if (!generatedMediaUrl && inlineImage) {
      generatedMediaUrl = `data:${inlineImage.mimeType || 'image/png'};base64,${inlineImage.data}`;
    }

    if (!generatedMediaUrl && taskIds.length > 0) {
      if (defer) {
        return res.json({
          success: true,
          pending: true,
          toolUsed: targetTool.name,
          argumentsUsed: args,
          taskIds,
          isVideo,
        });
      }
      const completed = await pollCanvasTask(serverUrl, token, taskIds[0], tools, isVideo ? 600_000 : 120_000, isVideo ? 'video' : 'image');
      generatedMediaUrl = completed.mediaUrl;
    }

    if (!generatedMediaUrl) {
      throw new Error(`模型已响应但未返回任务 ID 或媒体链接。输出详情：${JSON.stringify(callResult)}`);
    }

    return res.json({
      success: true,
      toolUsed: targetTool.name,
      argumentsUsed: args,
      taskIds,
      mediaUrl: generatedMediaUrl,
      isVideo: isVideo || generatedMediaUrl.endsWith('.mp4') || generatedMediaUrl.endsWith('.webm'),
    });
  } catch (error: any) {
    console.error('[MCP Generate Error]:', error);
    return res.status(toSafeStatus(error.statusCode)).json({
      success: false,
      error: error.message || '生图/生视频调用失败',
      details: error.rpcError || error.responseBody,
    });
  }
});

mcpRouter.post('/task', async (req: Request, res: Response) => {
  const token = req.body?.token || (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, '') : '');
  const serverUrl = req.body?.serverUrl || DEFAULT_MCP_URL;
  const taskId = String(req.body?.taskId || '');
  const isVideo = Boolean(req.body?.isVideo);
  const shouldBlock = Boolean(req.body?.blocking);

  if (!token || !taskId) {
    return res.status(400).json({ success: false, error: '缺少 WorkRally Token 或任务 ID' });
  }

  // Keep lastKnownMcp updated
  lastKnownMcp = { token, serverUrl, lastUpdated: Date.now() };
  persistMcpCredentials(token, serverUrl);

  try {
    const tools = await getCachedTools(serverUrl, token);

    if (shouldBlock) {
      const completed = await pollCanvasTask(
        serverUrl,
        token,
        taskId,
        tools,
        isVideo ? 30_000 : 20_000,
        isVideo ? 'video' : 'image'
      );
      return res.json({
        success: true,
        completed: true,
        taskId,
        mediaUrl: completed.mediaUrl,
        isVideo,
      });
    }

    const taskStatus = await fetchCanvasTaskStatus(
      serverUrl,
      token,
      taskId,
      tools,
      isVideo ? 'video' : 'image'
    );

    if (taskStatus.completed && taskStatus.mediaUrl) {
      return res.json({
        success: true,
        completed: true,
        taskId,
        mediaUrl: taskStatus.mediaUrl,
        isVideo,
      });
    }

    if (taskStatus.failed) {
      return res.json({
        success: false,
        failed: true,
        taskId,
        error: taskStatus.error || '任务生成失败',
      });
    }

    return res.json({
      success: true,
      pending: true,
      taskId,
      isVideo,
      status: taskStatus.status,
    });
  } catch (error: any) {
    return res.status(toSafeStatus(error.statusCode)).json({
      success: false,
      error: error.message || '查询 WorkRally 任务失败',
      details: error.rpcError || error.responseBody,
    });
  }
});

/**
 * 6. Media proxy endpoint with CORS enabled for client-side canvas/video streaming & thumbnail extraction
 */
mcpRouter.all('/proxy-media', async (req: Request, res: Response) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  let targetUrl = String(req.query.url || '');
  if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
    return res.status(400).send('Invalid url');
  }

  const taskId = String(req.query.taskId || '') ||
    targetUrl.match(/(2k[a-z0-9]{6,16})/i)?.[1] ||
    targetUrl.match(/\/(2k[a-z0-9]+)_MAIN_/i)?.[1] || '';

  const token = String(req.query.token || '') ||
    (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, '') : '') ||
    lastKnownMcp.token;

  const serverUrl = String(req.query.serverUrl || '') || lastKnownMcp.serverUrl || DEFAULT_MCP_URL;

  if (token) {
    lastKnownMcp = { token, serverUrl, lastUpdated: Date.now() };
    persistMcpCredentials(token, serverUrl);
  }

  const tryRefreshUrl = async (): Promise<string | null> => {
    if (!taskId || !token) return null;
    try {
      const tools = await getCachedTools(serverUrl, token);
      const taskStatus = await fetchCanvasTaskStatus(serverUrl, token, taskId, tools, 'video');
      if (taskStatus.completed && taskStatus.mediaUrl && !isExpiredSignedMediaUrl(taskStatus.mediaUrl)) {
        console.log(`[MCP proxy-media] Successfully auto-healed video URL for task ${taskId}`);
        return taskStatus.mediaUrl;
      }
    } catch (e: any) {
      console.warn('[MCP proxy-media auto-refresh notice]:', e?.message || e);
    }
    return null;
  };

  // If already known to be expired before fetching, proactively refresh
  if (isExpiredSignedMediaUrl(targetUrl)) {
    const refreshed = await tryRefreshUrl();
    if (refreshed) {
      targetUrl = refreshed;
    }
  }

  try {
    // If targetUrl is a WorkRally short-link (/s/...), resolve it first
    if (/^https?:\/\/workrally\.qq\.com\/s\//i.test(targetUrl)) {
      const resolved = await resolveWorkRallyShareUrl(targetUrl);
      if (resolved) targetUrl = resolved;
    }

    const headers: Record<string, string> = {
      'Referer': 'https://workrally.qq.com/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };
    if (req.headers.range) {
      headers['Range'] = String(req.headers.range);
    }

    if (req.method === 'HEAD') {
      let headRes = await fetch(targetUrl, {
        method: 'HEAD',
        headers,
        signal: AbortSignal.timeout(15_000),
      });

      if ((headRes.status === 403 || headRes.status === 404) && taskId && token) {
        const refreshed = await tryRefreshUrl();
        if (refreshed && refreshed !== targetUrl) {
          targetUrl = refreshed;
          headRes = await fetch(targetUrl, {
            method: 'HEAD',
            headers,
            signal: AbortSignal.timeout(15_000),
          });
        }
      }

      const ct = headRes.headers.get('content-type') || 'video/mp4';
      res.setHeader('Content-Type', ct);
      const cl = headRes.headers.get('content-length');
      if (cl) res.setHeader('Content-Length', cl);
      const cr = headRes.headers.get('content-range');
      if (cr) res.setHeader('Content-Range', cr);
      const ar = headRes.headers.get('accept-ranges') || 'bytes';
      res.setHeader('Accept-Ranges', ar);
      return res.status(headRes.status).end();
    }

    let fetchRes = await fetch(targetUrl, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(600_000),
    });

    if ((fetchRes.status === 403 || fetchRes.status === 404) && taskId && token) {
      console.log(`[MCP proxy-media] Received HTTP ${fetchRes.status}, auto-healing media URL for task ${taskId}...`);
      const refreshed = await tryRefreshUrl();
      if (refreshed && refreshed !== targetUrl) {
        targetUrl = refreshed;
        fetchRes = await fetch(targetUrl, {
          method: 'GET',
          headers,
          signal: AbortSignal.timeout(600_000),
        });
      }
    }

    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (targetUrl) {
      res.setHeader('X-Refreshed-Media-Url', targetUrl);
    }

    const downloadFilename = String(req.query.filename || req.query.downloadName || '');
    if (req.query.download === 'true' || downloadFilename) {
      const safeFilename = downloadFilename || 'media_original';
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeFilename)}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`);
    }

    const contentType = fetchRes.headers.get('content-type') || 'video/mp4';
    res.setHeader('Content-Type', contentType);

    const contentLength = fetchRes.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const contentRange = fetchRes.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    const acceptRanges = fetchRes.headers.get('accept-ranges') || 'bytes';
    res.setHeader('Accept-Ranges', acceptRanges);

    res.status(fetchRes.status);
    if (!fetchRes.body) {
      return res.end();
    }

    const reader = fetchRes.body.getReader();
    req.on('close', () => {
      reader.cancel().catch(() => {});
    });

    try {
      while (true) {
        if (req.destroyed || res.writableEnded) break;
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      // client aborted or sought to a different timestamp
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(500).send(err.message || 'Failed to proxy media');
    }
  }
});
