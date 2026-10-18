// Pure data helpers. Blobs are immutable; preserve their identity while capturing
// metadata so an asynchronous save cannot observe later object mutations.
export function capture<T>(value: T, ancestors = new Set<object>()): T {
  if (value instanceof Blob || value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') throw new Error('数据包含不可保存的内容');
    return value;
  }
  if (ancestors.has(value)) throw new Error('数据存在循环引用');
  ancestors.add(value);
  const result = Array.isArray(value) ? value.map(v => capture(v, ancestors))
    : Object.fromEntries(Object.entries(value).map(([k, v]) => [k, capture(v, ancestors)]));
  ancestors.delete(value);
  return result as T;
}
export function equal(a: any, b: any): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || a instanceof Blob || b instanceof Blob) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
}
const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Blob);
// Apply only local changes. Same-field conflicts use commit order; the previous
// database value remains available as a backup in the enclosing transaction.
export function mergeChanges(base: any, local: any, remote: any): any {
  if (equal(base, local)) return remote;
  if (equal(base, remote)) return local;
  if ([base, local, remote].every(Array.isArray) && [...base, ...local, ...remote].every(v => object(v) && typeof v.id === 'string')) {
    const b = new Map(base.map((v: any) => [v.id, v])), l = new Map(local.map((v: any) => [v.id, v])), r = new Map(remote.map((v: any) => [v.id, v]));
    return [...new Set([...remote.map((v: any) => v.id), ...local.map((v: any) => v.id)])]
      .map(id => mergeChanges(b.get(id), l.get(id), r.get(id))).filter(v => v !== undefined);
  }
  if (object(base) && object(local) && object(remote)) {
    return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])]
      .map(k => [k, mergeChanges(base[k], local[k], remote[k])]).filter(([, v]) => v !== undefined));
  }
  return local;
}
