import { CardRepository } from './repository';
let worker: Worker | undefined;
let sequence = 0;
const requests = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
function rpc(method: string, ...args: any[]): Promise<any> {
  if (!worker) {
    worker = new Worker(new URL('./storage.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const pending = requests.get(data.id);
      if (!pending) return;
      requests.delete(data.id);
      if (data.error) pending.reject(new Error(data.error));
      else pending.resolve(data.value);
    };
    const failed = () => {
      const error = new Error('后台保存进程失败，当前更改尚未保存，请重试');
      requests.forEach(p => p.reject(error));
      requests.clear();
      worker?.terminate();
      worker = undefined;
    };
    worker.onerror = failed;
    worker.onmessageerror = failed;
  }
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    requests.set(id, { resolve, reject });
    try { worker!.postMessage({ id, method, args }); }
    catch (error) { requests.delete(id); reject(error); }
  });
}
export const cardRepository = new CardRepository(rpc);
