import type { AgentToolName } from './protocol';

export type ToolCategory = '页面观察' | '页面交互' | '操作知识' | '系统控制';

export type ToolRisk = '只读' | '交互动作' | '内部状态';

export interface AgentToolDefinition {
  id: AgentToolName;
  category: ToolCategory;
  description: string;
  input: string;
  output: string;
  mouse: boolean;
  risk: ToolRisk;
}

export const AGENT_TOOL_REGISTRY: AgentToolDefinition[] = [
  { id: 'guide.lookup', category: '操作知识', description: '查询应用的操作说明；只说明如何通过界面查找信息，不提供当前项目隐藏数据。', input: '{ query }', output: '操作路径与注意事项', mouse: false, risk: '只读' },
  { id: 'page.inspect', category: '页面观察', description: '默认返回页面入口概览，正文不直接展开注入；指定 scope 为可见组件 ID（如 script.text）时申请查看该区域的可见内容。动作集合去重，不返回坐标或隐藏数据；分页截断明确提示。', input: '{ scope?: "overview" | 组件ID, offset?: number, limit?: number }', output: '区域可见事实、组件、动作集合、分页及页面提示', mouse: true, risk: '只读' },
  { id: 'card.inspect', category: '页面观察', description: '深入探针查看指定的卡片，可选择性地调取高清生成图像、生成提示词、输入参考图集合及其他元参数（如画幅比例、渲染状态、模型等）。支持在复刻、对照时精细索取图片，节省全局Token并极大提高分析纯度。', input: '{ cardId: string, includeImage?: boolean, includePrompt?: boolean, includeReference?: boolean, includeParameters?: boolean }', output: '请求的卡片属性、文件资源或高清图像视觉反馈', mouse: true, risk: '只读' },
  { id: 'card.generate', category: '页面交互', description: '对指定卡片配置参数、触发生图或执行【复刻 (Fork)】衍生。必须传入卡片名称 name 参数（规范：尽可能简短，辨识度高，如"金发女郎晚礼服"、"赛博霓虹街景"）。遵循人机统一的画布生图哲学：若目标卡片为【已出图卡片 (completed)】或【资产卡片 (isAsset)】，再次生图时会自动触发与人类 UI 完全一致的【复刻 (Fork)】机制在右侧衍生创建新生图卡片，继承画幅/模型与参考图，建立父子血缘以保护历史生成成果；仅当目标卡片为【草稿 (draft)】或【失败卡片 (failed)】时才在原卡片上原地更新。支持多图参考 (referenceCardIds)、autoStart (控制草稿还是直接排队) 及 forceOverwrite 控制。生图默认使用免费模型 Hy Image3.5 preview。', input: '{ name: string, referenceCardIds?: string[], targetCardId?: "new" | string, prompt?: string, aspectRatio?: string, style?: string, autoStart?: boolean, forceOverwrite?: boolean }', output: '{ success: boolean, cardId: string, cardName: string, cardState: "draft" | "generating" | "completed", isForked: boolean, autoStarted: boolean, prompt: string, referenceCount: number, mcpTaskId?: string, imageUrl?: string, message: string }', mouse: true, risk: '交互动作' },
  { id: 'ui.actAndObserve', category: '页面交互', description: '在最近一次页面观察中出现的目标上执行一项鼠标动作，并返回动作后新的可见页面事实。', input: '{ targetId: string, action: string, arguments?: { delta?: number, text?: string } }', output: '动作状态与最新可见页面事实', mouse: true, risk: '交互动作' },
  { id: 'sys.endTask', category: '系统控制', description: '当任务成功完成、挂起暂停等待后台异步事件或需要等待用户进一步输入时结束当前任务循环。若任务属于等待后台异步生成/出图，可设置 paused: true 挂起暂停。', input: '{ success: boolean, finalResponse: string, waitForUser?: string, paused?: boolean }', output: '任务已结束', mouse: false, risk: '内部状态' },
  { id: 'user.ask', category: '系统控制', description: '向用户主动提问，请求用户输入必要信息或进行确认。调用后任务会暂停，等待用户回复。', input: '{ question: string }', output: '用户的回复', mouse: false, risk: '内部状态' },
];

export type AgentToolConfig = Record<AgentToolName, boolean>;

export const DEFAULT_AGENT_TOOL_CONFIG: AgentToolConfig = Object.fromEntries(
  AGENT_TOOL_REGISTRY.map((tool) => [tool.id, true]),
) as AgentToolConfig;

export const getAgentToolConfig = (): AgentToolConfig => {
  try {
    const saved = localStorage.getItem('agent_tool_config');
    return { ...DEFAULT_AGENT_TOOL_CONFIG, ...(saved ? JSON.parse(saved) : {}) };
  } catch {
    return { ...DEFAULT_AGENT_TOOL_CONFIG };
  }
};

export const saveAgentToolConfig = (config: AgentToolConfig) => {
  localStorage.setItem('agent_tool_config', JSON.stringify(config));
};
