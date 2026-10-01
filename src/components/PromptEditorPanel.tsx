import { useState, useEffect, useCallback, useRef } from 'react';
import { Save, LoaderCircle, Check, RotateCcw, Cpu, TerminalSquare, AlertCircle } from 'lucide-react';

export const PromptEditorPanel = () => {
  const [activeTab, setActiveTab] = useState<'main' | 'state'>('main');

  const [mainPrompt, setMainPrompt] = useState<string>(() => {
    return localStorage.getItem('mira_custom_system_prompt') || '';
  });
  const [statePrompt, setStatePrompt] = useState<string>(() => {
    return localStorage.getItem('mira_custom_state_prompt') || '';
  });

  const [mainDirty, setMainDirty] = useState<boolean>(() => {
    return localStorage.getItem('mira_prompt_dirty_main') === 'true';
  });
  const [stateDirty, setStateDirty] = useState<boolean>(() => {
    return localStorage.getItem('mira_prompt_dirty_state') === 'true';
  });

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mainPromptRef = useRef(mainPrompt);
  mainPromptRef.current = mainPrompt;
  const statePromptRef = useRef(statePrompt);
  statePromptRef.current = statePrompt;

  const mainDirtyRef = useRef(mainDirty);
  mainDirtyRef.current = mainDirty;
  const stateDirtyRef = useRef(stateDirty);
  stateDirtyRef.current = stateDirty;

  const fetchPrompt = useCallback(async (type: 'main' | 'state', force = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/agent/prompt?type=${type}`);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const data = await res.json();
      if (typeof data.prompt === 'string') {
        const isDirty = type === 'main' ? mainDirtyRef.current : stateDirtyRef.current;
        if (force || !isDirty) {
          if (type === 'main') {
            setMainPrompt(data.prompt);
            localStorage.setItem('mira_custom_system_prompt', data.prompt);
            setMainDirty(false);
            localStorage.setItem('mira_prompt_dirty_main', 'false');
          } else {
            setStatePrompt(data.prompt);
            localStorage.setItem('mira_custom_state_prompt', data.prompt);
            setStateDirty(false);
            localStorage.setItem('mira_prompt_dirty_state', 'false');
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

  const currentPrompt = activeTab === 'main' ? mainPrompt : statePrompt;
  const isCurrentDirty = activeTab === 'main' ? mainDirty : stateDirty;

  const setCurrentPrompt = (value: string) => {
    setError(null);
    if (activeTab === 'main') {
      setMainPrompt(value);
      localStorage.setItem('mira_custom_system_prompt', value);
      setMainDirty(true);
      localStorage.setItem('mira_prompt_dirty_main', 'true');
    } else {
      setStatePrompt(value);
      localStorage.setItem('mira_custom_state_prompt', value);
      setStateDirty(true);
      localStorage.setItem('mira_prompt_dirty_state', 'true');
    }
  };

  const savePrompt = async () => {
    const targetTab = activeTab;
    const textToSave = targetTab === 'main' ? mainPromptRef.current : statePromptRef.current;

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

      if (targetTab === 'main') {
        if (mainPromptRef.current === textToSave) {
          setMainDirty(false);
          localStorage.setItem('mira_prompt_dirty_main', 'false');
        }
      } else {
        if (statePromptRef.current === textToSave) {
          setStateDirty(false);
          localStorage.setItem('mira_prompt_dirty_state', 'false');
        }
      }

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
    if (!confirm(`确定要放弃未保存草稿并重新拉取服务器最新的 ${activeTab === 'main' ? '主循环 Prompt' : '认知状态提取节点 Prompt'} 吗？`)) return;
    if (activeTab === 'main') {
      localStorage.removeItem('mira_custom_system_prompt');
      localStorage.setItem('mira_prompt_dirty_main', 'false');
      setMainDirty(false);
    } else {
      localStorage.removeItem('mira_custom_state_prompt');
      localStorage.setItem('mira_prompt_dirty_state', 'false');
      setStateDirty(false);
    }
    await fetchPrompt(activeTab, true);
  };

  return (
    <div className="flex h-full flex-col bg-[#fbfbfc] p-6 dark:bg-[#121214]">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-semibold">Prompt 提示词配置中心</h2>
            {isCurrentDirty && (
              <span className="inline-flex items-center rounded-md bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-600 dark:text-amber-400 border border-amber-500/20">
                未保存草稿
              </span>
            )}
          </div>
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

      {/* Error message */}
      {error && (
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-600 dark:text-red-400 font-medium">
          <AlertCircle size={15} className="shrink-0" />
          <span>{error}</span>
        </div>
      )}

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
          {mainDirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="有未保存草稿" />}
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
          {stateDirty && <span className="h-1.5 w-1.5 rounded-full bg-amber-400" title="有未保存草稿" />}
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
