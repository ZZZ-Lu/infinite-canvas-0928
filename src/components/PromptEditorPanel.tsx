import { useState, useEffect, useCallback } from 'react';
import { Save, LoaderCircle, Check, RotateCcw, Cpu, TerminalSquare } from 'lucide-react';

export const PromptEditorPanel = () => {
  const [activeTab, setActiveTab] = useState<'main' | 'state'>('main');
  
  const [mainPrompt, setMainPrompt] = useState<string>(() => {
    return localStorage.getItem('mira_custom_system_prompt') || '';
  });
  const [statePrompt, setStatePrompt] = useState<string>(() => {
    return localStorage.getItem('mira_custom_state_prompt') || '';
  });

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const fetchPrompt = useCallback(async (type: 'main' | 'state') => {
    setLoading(true);
    try {
      const res = await fetch(`/api/agent/prompt?type=${type}`);
      const data = await res.json();
      if (data.prompt) {
        if (type === 'main') {
          setMainPrompt(data.prompt);
          localStorage.setItem('mira_custom_system_prompt', data.prompt);
        } else {
          setStatePrompt(data.prompt);
          localStorage.setItem('mira_custom_state_prompt', data.prompt);
        }
      }
    } catch (err) {
      console.error(`Failed to load ${type} prompt:`, err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPrompt(activeTab);
  }, [activeTab, fetchPrompt]);

  const currentPrompt = activeTab === 'main' ? mainPrompt : statePrompt;

  const setCurrentPrompt = (value: string) => {
    if (activeTab === 'main') {
      setMainPrompt(value);
      localStorage.setItem('mira_custom_system_prompt', value);
    } else {
      setStatePrompt(value);
      localStorage.setItem('mira_custom_state_prompt', value);
    }
  };

  const savePrompt = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/agent/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: currentPrompt, type: activeTab }),
      });
      if (res.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch (error) {
      console.error(error);
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!confirm(`确定要重新拉取服务器最新的 ${activeTab === 'main' ? '主循环 Prompt' : '认知状态提取节点 Prompt'} 吗？`)) return;
    if (activeTab === 'main') localStorage.removeItem('mira_custom_system_prompt');
    else localStorage.removeItem('mira_custom_state_prompt');
    await fetchPrompt(activeTab);
  };

  return (
    <div className="flex h-full flex-col bg-[#fbfbfc] p-6 dark:bg-[#121214]">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Prompt 提示词配置中心</h2>
          <p className="mt-1 text-sm text-slate-500">
            {activeTab === 'main'
              ? '配置主循环系统的思考与工具调用指令，改动将直接保存至 src/agent/systemPrompt.txt。'
              : '配置每轮循环后自动调用的“认知状态提取节点”指令，改动将直接保存至 src/agent/stateNodePrompt.txt。'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleReset}
            disabled={loading || saving}
            className="flex h-9 items-center gap-1.5 rounded-lg border border-slate-300 dark:border-white/20 bg-white dark:bg-neutral-800 px-3 text-sm font-medium text-slate-700 dark:text-neutral-200 transition hover:bg-slate-100 dark:hover:bg-neutral-700 disabled:opacity-50"
            title="重新刷新"
          >
            <RotateCcw size={15} />
            重置刷新
          </button>
          <button
            onClick={savePrompt}
            disabled={loading || saving}
            className="flex h-9 items-center gap-2 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white transition hover:bg-violet-700 disabled:opacity-50 shadow-sm"
          >
            {saving ? <LoaderCircle className="animate-spin" size={16} /> : saved ? <Check size={16} /> : <Save size={16} />}
            {saved ? '已保存至代码库' : '保存到代码库'}
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="mb-3 flex items-center gap-1 border-b border-slate-200 dark:border-white/10 pb-2">
        <button
          onClick={() => setActiveTab('main')}
          className={`flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
            activeTab === 'main'
              ? 'bg-violet-600 text-white shadow-sm'
              : 'bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10'
          }`}
        >
          <TerminalSquare size={14} />
          主循环 Agent Prompt (`systemPrompt.txt`)
        </button>
        <button
          onClick={() => setActiveTab('state')}
          className={`flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition ${
            activeTab === 'state'
              ? 'bg-violet-600 text-white shadow-sm'
              : 'bg-slate-100 dark:bg-white/5 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-white/10'
          }`}
        >
          <Cpu size={14} />
          认知状态提取节点 Prompt (`stateNodePrompt.txt`)
        </button>
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
            className="h-full w-full resize-none bg-transparent p-4 font-mono text-sm leading-relaxed text-slate-800 outline-none dark:text-slate-200"
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
};
