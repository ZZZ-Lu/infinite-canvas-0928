// Apply only fields edited against this page's baseline. Arrays/resources are atomic.
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v) && !v.__infiniteCanvasResource;
export function mergeFields(base: any, local: any, remote: any): any {
  if (equal(base, local)) return remote;
  if (!object(base) || !object(local) || !object(remote)) return local;
  const result = { ...remote };
  for (const key of new Set([...Object.keys(base), ...Object.keys(local)])) {
    if (equal(base[key], local[key])) continue;
    if (!(key in local)) delete result[key];
    else result[key] = mergeFields(base[key], local[key], remote[key]);
  }
  return result;
}
export function resourceIds(data: any): string[] {
  const ids = new Set<string>();
  const visit = (value: any) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.__infiniteCanvasResource === 'string') ids.add(value.__infiniteCanvasResource);
    else Object.values(value).forEach(visit);
  };
  visit(data); return [...ids];
}
