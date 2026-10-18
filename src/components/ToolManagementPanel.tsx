import React, { useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, MousePointer2, Power, RotateCcw, ShieldCheck, TerminalSquare } from 'lucide-react';
import { AGENT_TOOL_REGISTRY, DEFAULT_AGENT_TOOL_CONFIG, getAgentToolConfig, saveAgentToolConfig, type AgentToolConfig, type ToolCategory } from '../agent/toolRegistry';
import { PAGE_COMPONENT_REGISTRY } from '../agent/pageComponentRegistry';

const categories: ToolCategory[] = ['操作知识', '页面观察', '页面交互', '系统控制'];

export function ToolManagementPanel() {
  const [config, setConfig] = useState<AgentToolConfig>(getAgentToolConfig);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [autoInspect, setAutoInspect] = useState(() => localStorage.getItem("auto_inspect_on_launch") !== "false");

  const handleCopy = (text: string, key: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((curr) => (curr === key ? null : curr)), 1800);
  };

  const handleAutoInspectChange = (checked: boolean) => {
    setAutoInspect(checked);
    localStorage.setItem("auto_inspect_on_launch", checked ? "true" : "false");
  };
  const grouped = useMemo(() => categories.map((category) => ({ category, tools: AGENT_TOOL_REGISTRY.filter((tool) => tool.category === category) })), []);
  const setEnabled = (id: keyof AgentToolConfig, enabled: boolean) => {
    const next = { ...config, [id]: enabled };
    setConfig(next);
    saveAgentToolConfig(next);
  };
  const enabledCount = Object.values(config).filter(Boolean).length;

  return (
    <section className="min-h-0 w-full flex-1 overflow-y-auto overscroll-contain bg-[#fbfbfc] p-6 pb-20 select-text dark:bg-[#121214]">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[.16em] text-violet-500">Runtime registry</p>
            <h2 className="mt-1 text-xl font-semibold select-text">工具管理</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500 select-text">
              这里展示 Agent 当前真实注册的工具。关闭工具后，它不会进入下一轮 Agent 的可用工具集合，也无法被 Runtime 执行。
            </p>
          </div>
          <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-3 py-2 text-right text-xs text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500 dark:text-emerald-300">
            <div className="font-semibold">{enabledCount} / {AGENT_TOOL_REGISTRY.length} 已启用</div>
            <div className="mt-0.5 opacity-70">配置仅保存在本机</div>
          </div>
        </div>

        <div className="mt-6 mb-6 rounded-2xl border border-slate-200 bg-gray-100 p-4 dark:border-white/10 dark:bg-[#18181b] flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">首轮自动页面观察</h3>
            <p className="mt-1 text-xs text-slate-500">每次用户发起对话后，优先静默调用一次 page.inspect 并将最新视野注入任务上下文。</p>
          </div>
          <button
            onClick={() => handleAutoInspectChange(!autoInspect)}
            className={`grid h-6 w-10 shrink-0 place-items-center rounded-full transition ${autoInspect ? "bg-violet-600" : "bg-slate-200 dark:bg-white/10"}`}
            aria-label={`${autoInspect ? "禁用" : "启用"}首轮自动观察`}
          >
            <span className={`h-4 w-4 rounded-full bg-white shadow-sm transition ${autoInspect ? "translate-x-2" : "-translate-x-2"}`} />
          </button>
        </div>

        <div className="mt-6 space-y-5">
          {grouped.map(({ category, tools }) => (
            <div key={category}>
              <h3 className="mb-2 text-xs font-semibold text-slate-400 select-text">{category}</h3>
              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-gray-100 dark:border-white/10 dark:bg-[#18181b]">
                {tools.map((tool, index) => {
                  const isExpanded = expanded === tool.id;
                  return (
                    <div key={tool.id} className={index ? 'border-t border-slate-100 dark:border-white/5' : ''}>
                      <div className="flex items-start sm:items-center gap-3 px-4 py-3">
                        <button
                          onClick={() => setEnabled(tool.id, !config[tool.id])}
                          className={`mt-1 sm:mt-0 grid h-6 w-10 shrink-0 place-items-center rounded-full transition ${config[tool.id] ? 'bg-violet-600' : 'bg-slate-200 dark:bg-white/10'}`}
                          aria-label={`${config[tool.id] ? '禁用' : '启用'} ${tool.id}`}
                        >
                          <span className={`h-4 w-4 rounded-full bg-white shadow-sm transition ${config[tool.id] ? 'translate-x-2' : '-translate-x-2'}`} />
                        </button>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <code className="text-sm font-semibold text-slate-800 dark:text-slate-100 select-text font-mono">
                              {tool.id}
                            </code>
                            {tool.mouse && (
                              <span title="该工具会驱动 Agent 鼠标">
                                <MousePointer2 size={13} className="text-violet-500" />
                              </span>
                            )}
                            <button
                              onClick={(e) => handleCopy(tool.id, `id_${tool.id}`, e)}
                              type="button"
                              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-white/10 transition cursor-pointer"
                              title="复制工具名称"
                            >
                              {copiedKey === `id_${tool.id}` ? (
                                <Check size={11} className="text-emerald-500" />
                              ) : (
                                <Copy size={11} />
                              )}
                              <span>{copiedKey === `id_${tool.id}` ? '已复制' : '复制ID'}</span>
                            </button>
                          </div>
                          <p className="mt-1 text-xs text-slate-500 leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere] select-text">
                            {tool.description}
                          </p>
                        </div>
                        <span className={`hidden rounded-md px-2 py-1 text-[10px] shrink-0 sm:inline ${tool.risk === '只读' ? 'bg-slate-100 text-slate-500 dark:bg-white/10' : 'bg-amber-50 text-amber-600 dark:bg-amber-500 dark:text-amber-300'}`}>
                          {tool.risk}
                        </span>
                        <button
                          onClick={() => setExpanded(isExpanded ? null : tool.id)}
                          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10 transition"
                          aria-label="查看工具契约"
                        >
                          {isExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        </button>
                      </div>

                      {/* Expanded tool details */}
                      {isExpanded && (
                        <div className="border-t border-slate-100 bg-slate-50/70 p-4 dark:border-white/5 dark:bg-black/40">
                          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/50 pb-2 dark:border-white/5">
                            <div className="flex items-center gap-2">
                              <span className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300">
                                {tool.mouse ? (
                                  <>
                                    <MousePointer2 size={13} className="text-violet-500" /> Agent 鼠标动作执行
                                  </>
                                ) : (
                                  <>
                                    <ShieldCheck size={13} className="text-emerald-500" /> 受限页面/系统只读观察
                                  </>
                                )}
                              </span>
                              <span className="rounded bg-slate-200/60 dark:bg-white/10 px-1.5 py-0.5 text-[10px] text-slate-600 dark:text-slate-300">
                                风险等级: {tool.risk}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={(e) => handleCopy(JSON.stringify(tool, null, 2), `full_${tool.id}`, e)}
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 shadow-2xs hover:bg-slate-50 dark:border-white/10 dark:bg-neutral-800 dark:text-slate-200 dark:hover:bg-neutral-700 transition cursor-pointer"
                            >
                              {copiedKey === `full_${tool.id}` ? (
                                <Check size={12} className="text-emerald-500" />
                              ) : (
                                <Copy size={12} />
                              )}
                              <span>{copiedKey === `full_${tool.id}` ? '已复制全量定义' : '复制工具 JSON'}</span>
                            </button>
                          </div>

                          <div className="grid gap-3 md:grid-cols-2">
                            {/* Input Schema */}
                            <div className="flex flex-col rounded-xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-[#161618]">
                              <div className="mb-1.5 flex items-center justify-between">
                                <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                                  输入参数 (Input Schema)
                                </span>
                                <button
                                  type="button"
                                  onClick={(e) => handleCopy(tool.input, `input_${tool.id}`, e)}
                                  className="inline-flex items-center gap-1 text-[10px] font-medium text-violet-600 hover:text-violet-700 dark:text-violet-400 transition cursor-pointer"
                                >
                                  {copiedKey === `input_${tool.id}` ? (
                                    <Check size={11} className="text-emerald-500" />
                                  ) : (
                                    <Copy size={11} />
                                  )}
                                  <span>{copiedKey === `input_${tool.id}` ? '已复制' : '复制'}</span>
                                </button>
                              </div>
                              <pre className="mt-1 flex-1 overflow-x-hidden whitespace-pre-wrap break-all [word-break:break-all] [overflow-wrap:anywhere] select-text font-mono text-[11px] leading-relaxed text-slate-800 dark:text-slate-200">
                                {tool.input}
                              </pre>
                            </div>

                            {/* Output Schema */}
                            <div className="flex flex-col rounded-xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-[#161618]">
                              <div className="mb-1.5 flex items-center justify-between">
                                <span className="text-[11px] font-semibold text-slate-500 dark:text-slate-400">
                                  返回结果格式 (Output Contract)
                                </span>
                                <button
                                  type="button"
                                  onClick={(e) => handleCopy(tool.output, `output_${tool.id}`, e)}
                                  className="inline-flex items-center gap-1 text-[10px] font-medium text-violet-600 hover:text-violet-700 dark:text-violet-400 transition cursor-pointer"
                                >
                                  {copiedKey === `output_${tool.id}` ? (
                                    <Check size={11} className="text-emerald-500" />
                                  ) : (
                                    <Copy size={11} />
                                  )}
                                  <span>{copiedKey === `output_${tool.id}` ? '已复制' : '复制'}</span>
                                </button>
                              </div>
                              <pre className="mt-1 flex-1 overflow-x-hidden whitespace-pre-wrap break-all [word-break:break-all] [overflow-wrap:anywhere] select-text font-mono text-[11px] leading-relaxed text-slate-800 dark:text-slate-200">
                                {tool.output}
                              </pre>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Page component registry section */}
        <div className="mt-8">
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 select-text">页面组件注册</h3>
              <p className="mt-1 text-xs leading-5 text-slate-500 select-text">
                组件声明位置和允许的鼠标动作；页面观察会只返回当前已挂载、可见的组件及其屏幕位置。
              </p>
            </div>
            <span className="shrink-0 text-xs text-slate-400">{PAGE_COMPONENT_REGISTRY.length} 个组件类型</span>
          </div>
          <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200 bg-gray-100 dark:border-white/10 dark:bg-[#18181b]">
            {PAGE_COMPONENT_REGISTRY.map((component, index) => (
              <div
                key={component.id}
                className={`grid gap-2 px-4 py-3 text-xs sm:grid-cols-[minmax(160px,0.8fr)_minmax(110px,0.5fr)_1.5fr] ${
                  index ? 'border-t border-slate-100 dark:border-white/5' : ''
                }`}
              >
                <div>
                  <code className="font-semibold text-slate-800 dark:text-slate-100 font-mono select-text">
                    {component.id}
                  </code>
                  <p className="mt-1 text-slate-500 select-text">{component.label}</p>
                </div>
                <div>
                  <p className="text-slate-400">位置</p>
                  <p className="mt-1 text-slate-600 dark:text-slate-300 select-text">{component.location}</p>
                </div>
                <div>
                  <p className="text-slate-400">允许动作</p>
                  <p className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-slate-600 dark:text-slate-300 select-text">
                    {component.actions.join(' · ')}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-8 pt-4 border-t border-slate-200/60 dark:border-white/10 flex items-center justify-between">
          <button
            onClick={() => {
              setConfig({ ...DEFAULT_AGENT_TOOL_CONFIG });
              saveAgentToolConfig({ ...DEFAULT_AGENT_TOOL_CONFIG });
            }}
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-800 dark:hover:text-white transition cursor-pointer"
          >
            <RotateCcw size={13} />
            恢复默认工具配置
          </button>
          <span className="text-[11px] text-slate-400">所有工具参数定义支持自动换行与全量复制</span>
        </div>
      </div>
    </section>
  );
}
