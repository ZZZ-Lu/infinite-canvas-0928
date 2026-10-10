import { useState, useEffect, useCallback, useRef } from 'react';
import { Save, LoaderCircle, Check, Copy, RotateCcw, Cpu, TerminalSquare, AlertCircle, Zap, Eye } from 'lucide-react';

type PromptTabType = 'main' | 'state' | 'jsonAdapter' | 'landmarks';

interface TabConfig {
  id: PromptTabType;
  label: string;
  icon: typeof TerminalSquare;
  filename: string;
  description: string;
  storageKey: string;
  dirtyKey: string;
}

const TABS: TabConfig[] = [
  {
    id: 'main',
    label: '主循环 Agent Prompt',
    icon: TerminalSquare,
    filename: 'systemPrompt.txt',
    description: '配置主循环系统的思考与工具调用指令，改动将直接保存至 src/agent/systemPrompt.txt。',
    storageKey: 'mira_custom_system_prompt',
    dirtyKey: 'mira_prompt_dirty_main',
  },
  {
    id: 'state',
    label: '认知状态提取节点 Prompt',
    icon: Cpu,
    filename: 'stateNodePrompt.txt',
    description: '配置每轮循环后自动调用的“认知状态提取节点”指令，改动将直接保存至 src/agent/stateNodePrompt.txt。',
    storageKey: 'mira_custom_state_prompt',
    dirtyKey: 'mira_prompt_dirty_state',
  },
  {
    id: 'jsonAdapter',
    label: '工具 JSON 转译节点 Prompt',
    icon: Zap,
    filename: 'jsonAdapterPrompt.txt',
    description: '配置负责将非标指令、自然语言或伪代码重构为标准工具 Schema 参数的转译大模型指令，改动将直接保存至 src/agent/jsonAdapterPrompt.txt。',
    storageKey: 'mira_custom_json_adapter_prompt',
    dirtyKey: 'mira_prompt_dirty_json_adapter',
  },
  {
    id: 'landmarks',
    label: '画面元素标注节点 Prompt',
    icon: Eye,
    filename: 'subjectLandmarksPrompt.txt',
    description: '配置执行空间定位与意图驱动 Visual Grounding 画面元素标注的专家模型指令，改动将直接保存至 src/agent/subjectLandmarksPrompt.txt。',
    storageKey: 'mira_custom_landmarks_prompt',
    dirtyKey: 'mira_prompt_dirty_landmarks',
  },
];

export const PromptEditorPanel = () => {
  const [activeTab, setActiveTab] = useState<PromptTabType>('main');

  const [prompts, setPrompts] = useState<Record<PromptTabType, string>>(() => ({
    main: localStorage.getItem('mira_custom_system_prompt') || '',
    state: localStorage.getItem('mira_custom_state_prompt') || '',
    jsonAdapter: localStorage.getItem('mira_custom_json_adapter_prompt') || '',
    landmarks: localStorage.getItem('mira_custom_landmarks_prompt') || '',
  }));

  const [dirties, setDirties] = useState<Record<PromptTabType, boolean>>(() => ({
    main: localStorage.getItem('mira_prompt_dirty_main') === 'true',
    state: localStorage.getItem('mira_prompt_dirty_state') === 'true',
    jsonAdapter: localStorage.getItem('mira_prompt_dirty_json_adapter') === 'true',
    landmarks: localStorage.getItem('mira_prompt_dirty_landmarks') === 'true',
  }));

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const promptsRef = useRef(prompts);
  promptsRef.current = prompts;
  const dirtiesRef = useRef(dirties);
  dirtiesRef.current = dirties;

  const currentTabConfig = TABS.find(t => t.id === activeTab) || TABS[0];

  const fetchPrompt = useCallback(async (type: PromptTabType, force = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agent/prompt?type=${type}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      if (typeof data.prompt === 'string') {
        const isDirty = dirtiesRef.current[type];
        if (force || !isDirty) {
          const cfg = TABS.find(t => t.id === type);
          if (cfg) {
            setPrompts(prev => ({ ...prev, [type]: data.prompt }));
            localStorage.setItem(cfg.storageKey, data.prompt);
            setDirties(prev => ({ ...prev, [type]: false }));
            localStorage.setItem(cfg.dirtyKey, 'false');
          }
        }
      }
    } catch (err: any) {
      console.error(`Failed to load ${type} prompt:`, err);
      setError(`读取服务端 Prompt 失败: ${err.message || '网络或接口异常'}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPrompt(activeTab);
  }, [activeTab, fetchPrompt]);

  const currentPrompt = prompts[activeTab] || '';
  const isCurrentDirty = dirties[activeTab] || false;

  const setCurrentPrompt = (value: string) => {
    setError(null);
    const cfg = currentTabConfig;
    setPrompts(prev => ({ ...prev, [activeTab]: value }));
    localStorage.setItem(cfg.storageKey, value);
    setDirties(prev => ({ ...prev, [activeTab]: true }));
    localStorage.setItem(cfg.dirtyKey, 'true');
  };

  const savePrompt = async () => {
    const targetTab = activeTab;
    const textToSave = promptsRef.current[targetTab];
    const cfg = currentTabConfig;

    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/agent/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: textToSave, type: targetTab }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${res.status} ${res.statusText}`);
      }

      setDirties(prev => ({ ...prev, [targetTab]: false }));
      localStorage.setItem(cfg.dirtyKey, 'false');

      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err: any) {
      console.error('Failed to save prompt:', err);
      setError(`保存失败: ${err.message || '网络或服务端异常'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!confirm(`确定要放弃未保存草稿并重新拉取服务器最新的 ${currentTabConfig.label} 吗？`)) return;
    const cfg = currentTabConfig;
    localStorage.removeItem(cfg.storageKey);
    localStorage.setItem(cfg.dirtyKey, 'false');
    setDirties(prev => ({ ...prev, [activeTab]: false }));
    await fetchPrompt(activeTab, true);
  };

  const handleCopyPrompt = () => {
    navigator.clipboard.writeText(currentPrompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex h-full flex-col bg-[#fbfbfc] p-6 pb-8 select-text dark:bg-[#121214]">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold select-text">Prompt 提示词配置中心</h2>
            {isCurrentDirty && (
              <span className="inline-flex items-center rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400 border border-amber-500/20">
                未保存草稿
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-slate-500 select-text">
            {currentTabConfig.description}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopyPrompt}
            type="button"
            className="flex h-9 items-center gap-1.5 rounded-lg border border-slate-300 dark:border-white/20 bg-white dark:bg-neutral-800 px-3 text-sm font-medium text-slate-700 dark:text-neutral-200 transition hover:bg-slate-100 dark:hover:bg-neutral-700 cursor-pointer shadow-2xs"
            title="复制全部 Prompt 文本"
          >
            {copied ? <Check size={15} className="text-emerald-500" /> : <Copy size={15} />}
            {copied ? '已复制 Prompt' : '复制 Prompt'}
          </button>
          <button
            onClick={handleReset}
            disabled={loading || saving}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-slate-300 dark:border-white/20 bg-white dark:bg-neutral-800 px-3 text-sm font-medium text-slate-700 dark:text-neutral-200 transition hover:bg-slate-100 dark:hover:bg-neutral-700 disabled:opacity-50 cursor-pointer shadow-2xs"
            title="重新刷新"
          >
            <RotateCcw size={15} />
            重置刷新
          </button>
          <button
            onClick={savePrompt}
            disabled={loading || saving}
            className="flex h-9 items-center gap-2 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white transition hover:bg-violet-700 disabled:opacity-50 shadow-sm cursor-pointer"
          >
            {saving ? <LoaderCircle className="animate-spin" size={16} /> : saved ? <Check size={16} /> : <Save size={16} />}
            {saved ? '已保存至代码库' : '保存到代码库'}
          </button>
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-600 dark:text-red-400 font-medium">
          <AlertCircle size={15} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Tabs */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5 border-b border-slate-200 dark:border-white/10 pb-2.5">
        {TABS.map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          const isDirty = dirties[tab.id];
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition cursor-pointer ${
                isActive
                  ? 'bg-violet-600 text-white shadow-sm'
                  : 'bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10'
              }`}
            >
              <Icon size={14} />
              {tab.label} (`{tab.filename}`)
              {isDirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="有未保存草稿" />}
            </button>
          );
        })}
      </div>

      {/* Textarea */}
      <div className="min-h-0 flex-1 rounded-xl border border-slate-200 bg-gray-100 p-1 shadow-sm dark:border-white/10 dark:bg-black">
        {loading && !currentPrompt ? (
          <div className="grid h-full place-items-center">
            <LoaderCircle className="animate-spin text-slate-400" />
          </div>
        ) : (
          <textarea
            value={currentPrompt}
            onChange={e => setCurrentPrompt(e.target.value)}
            wrap="soft"
            className="h-full w-full resize-none bg-transparent p-4 font-mono text-sm leading-relaxed text-slate-800 outline-none whitespace-pre-wrap break-words [overflow-wrap:anywhere] select-text dark:text-slate-200"
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
};
