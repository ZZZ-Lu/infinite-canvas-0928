import { StrictMode, useSyncExternalStore, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { initializeStorage } from './storage/bootstrap';
import { appStorage, flushAppStorage } from './storage/appStorage';
import { getStorageState, hasUnsavedData, subscribeStorageState, requestPersistentStorage, retryFailedStorageWrites } from './storage/status';
import './index.css';

function StorageIndicator() {
  const status = useSyncExternalStore(subscribeStorageState, getStorageState);
  const [retrying, setRetrying] = useState(false);
  const errors = Object.values(status.errors);
  const label = errors.length ? '保存失败，请勿关闭页面' : status.pending || status.dirty ? '正在保存…' : '已保存到 IndexedDB';
  async function retry() {
    setRetrying(true);
    try {
      await retryFailedStorageWrites();
      await flushAppStorage();
    } catch {} finally { setRetrying(false); }
  }
  return <div className="fixed bottom-4 right-4 z-[10000] max-w-sm rounded-xl bg-black/80 px-3 py-2 text-xs text-white shadow-lg" role={errors.length ? 'alert' : 'status'}>
    <div>{label}</div>
    {errors.length > 0 && <><div className="mt-1 text-red-300">{errors[0]}</div><button className="mt-1 underline" disabled={retrying} onClick={retry}>重试保存</button></>}
    <div className="mt-1 text-gray-300">{status.persistence === 'granted' ? '持久存储已获准' : status.persistence === 'checking' ? '正在申请持久存储…' : '浏览器尚未授予持久存储'}</div>
    {status.persistence !== 'granted' && status.persistence !== 'checking' && <button className="mt-1 underline" onClick={() => void requestPersistentStorage()}>申请持久保存</button>}
  </div>;
}
const root = createRoot(document.getElementById('root')!);
async function start() {
  root.render(<div className="p-8">正在加载本地项目数据…</div>);
  try {
    await initializeStorage();
    // Import App only after hydrating settings; module-level reads must see real data.
    const { CODE_PIPELINE_PROMPTS } = await import('./constants/prompts');
    const prompts = appStorage.getItem('node_prompts_config');
    if (prompts) Object.assign(CODE_PIPELINE_PROMPTS, JSON.parse(prompts));
    const { default: App } = await import('./App');
    root.render(<StrictMode><App /><StorageIndicator /></StrictMode>);
  } catch (error) {
    root.render(<div role="alert" className="p-8"><p>本地数据加载失败，已停止启动，避免覆盖原数据。</p><p>{error instanceof Error ? error.message : String(error)}</p><button onClick={() => void start()}>重新读取</button></div>);
  }
}
window.addEventListener('beforeunload', event => {
  if (hasUnsavedData()) { event.preventDefault(); event.returnValue = ''; }
});
void start();
