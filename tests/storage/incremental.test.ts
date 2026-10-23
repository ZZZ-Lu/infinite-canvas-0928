import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { StorageBackend } from '../../src/storage/backend';
import { CardRepository } from '../../src/storage/repository';
import { CardCodec } from '../../src/storage/codec';
import { getVideoThumbnailDimensions } from '../../src/utils/thumbnail';

test('native video posters retain source dimensions and survive storage separately from Nano thumbnails', async () => {
  assert.deepEqual(getVideoThumbnailDimensions(3840, 2160, 0), { width: 3840, height: 2160 });
  assert.deepEqual(getVideoThumbnailDimensions(1080, 1920, 0), { width: 1080, height: 1920 });
  assert.deepEqual(getVideoThumbnailDimensions(3840, 2160, 256), { width: 256, height: 144 });
  const { repo, rpc } = harness();
  const video = new Blob(['video-bytes'], { type: 'video/mp4' });
  const poster = 'data:image/webp;base64,cG9zdGVy';
  const thumb = 'data:image/webp;base64,dGh1bWI=';
  await repo.save([card('v', { isVideo: true, fileData: video, videoPosterUrl: poster, thumbnailUrl: thumb })], 'poster-test');
  const loaded = await new CardRepository(rpc).load('poster-test');
  assert.equal(loaded![0].videoPosterUrl, poster);
  assert.equal(loaded![0].thumbnailUrl, thumb);
  assert.equal(await loaded![0].fileData.text(), 'video-bytes');
});

beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });
function harness(backend = new StorageBackend()) {
  const calls: { method: string; args: any[] }[] = [];
  const rpc = async (method: string, ...args: any[]) => {
    calls.push({ method, args: structuredClone(args) });
    return structuredClone(await (backend as any)[method](...structuredClone(args)));
  };
  return { backend, repo: new CardRepository(rpc), calls, rpc };
}
function card(id: string, extra = {}) {
  return { id, x: 0, y: 0, ratio: '1:1', res: '1K', state: 'draft', prompt: 'prompt', imageUrl: null, ...extra } as any;
}
async function seedLegacy(key: string, value: any[]) {
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open('InfiniteCanvasDB');
    open.onupgradeneeded = () => open.result.createObjectStore('workspace');
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('workspace', 'readwrite');
      tx.objectStore('workspace').put(value, key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => reject(tx.error);
    };
  });
}
test('2632 cards: moving one card sends no media and writes one card; no-op writes nothing', async () => {
  const { repo, calls } = harness();
  const blob = new Blob(['original-image'], { type: 'image/png' });
  const cards = Array.from({ length: 2632 }, (_, i) => card(`c${i}`, { fileData: blob, thumbnailUrl: 'data:image/png;base64,YQ==' }));
  await repo.save(cards, 'p');
  const uploads = calls.filter(c => c.method === 'assets').flatMap(c => c.args[0]);
  assert.equal(uploads.length, 2, 'shared Blob and thumbnail are stored once');
  assert.ok(calls.some(c => c.method === 'stage'), 'bulk metadata is sent in small messages');
  assert.ok(calls.filter(c => c.method === 'stage').every(c => c.args[1].length <= 16));
  calls.length = 0;
  const moved = cards.map((c, i) => i === 12 ? { ...c, x: 9 } : c);
  await repo.save(moved, 'p');
  const commit = calls.find(c => c.method === 'commit')!;
  assert.equal(commit.args[2].length, 1);
  assert.equal(commit.args[2][0].data.x, 9);
  assert.equal(calls.filter(c => c.method === 'assets').length, 0);
  calls.length = 0;
  await repo.save(moved, 'p');
  assert.equal(calls.length, 0);
});
test('legacy migration retains original bytes, references, empty projects and order', async () => {
  const original = new Blob(['original']);
  const reference = new Blob(['reference']);
  await seedLegacy('cards_old', [card('b', { fileData: original, originalFileData: original, trueOriginalFileData: original, referenceImages: [{ fileData: reference, name: 'ref' }] }), card('a')]);
  await seedLegacy('cards_empty', []);
  const { repo, backend } = harness();
  const result = await repo.load('cards_old');
  assert.deepEqual(result!.map(c => c.id), ['b', 'a']);
  assert.equal(await result![0].trueOriginalFileData!.text(), 'original');
  assert.equal(await result![0].referenceImages![0].fileData!.text(), 'reference');
  assert.deepEqual(await repo.load('cards_empty'), []);
  assert.equal(await repo.load('cards_missing'), null);
  await repo.save([], 'cards_old');
  const reloaded = harness(backend);
  assert.deepEqual(await reloaded.repo.load('cards_old'), []);
});
test('failed transaction retains old revision and retry commits the pending change', async () => {
  const { repo, backend } = harness();
  await repo.save([card('a')], 'p');
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(...args: any[]) {
    if (this.name === 'cards') throw new DOMException('Quota exceeded', 'QuotaExceededError');
    return originalPut.apply(this, args as any);
  };
  try { await assert.rejects(repo.save([card('a', { x: 5 })], 'p')); }
  finally { IDBObjectStore.prototype.put = originalPut; }
  assert.equal((await backend.load('p'))!.cards[0].data.x, 0);
  assert.equal(repo.hasPending(), true);
  await repo.save([card('a', { x: 5 })], 'p');
  assert.equal((await backend.load('p'))!.cards[0].data.x, 5);
});
test('cross-tab same field uses last committed edit', async () => {
  const first = harness();
  await first.repo.save([card('a')], 'p');
  const second = harness();
  await second.repo.load('p');
  await first.repo.save([card('a', { x: 3 })], 'p');
  await second.repo.save([card('a', { x: 7 })], 'p');
  assert.equal((await first.backend.load('p'))!.cards[0].data.x, 7);
});
test('deletion tombstone prevents stale saves and legacy resurrection', async () => {
  await seedLegacy('p', [card('a')]);
  const one = harness();
  await one.repo.load('p');
  const two = harness();
  await two.repo.load('p');
  await one.repo.remove('p');
  await assert.rejects(two.repo.save([card('a', { x: 7 })], 'p'));
  assert.deepEqual(await harness().repo.load('p'), []);
  await assert.rejects(one.repo.save([card('a')], 'p'), /已删除/);
});
test('interrupted migration never publishes partial data and can retry', async () => {
  await seedLegacy('p', Array.from({ length: 40 }, (_, i) => card(String(i))));
  const backend = new StorageBackend();
  const originalPut = IDBObjectStore.prototype.put;
  let count = 0;
  IDBObjectStore.prototype.put = function(...args: any[]) {
    if (this.name === 'cards' && ++count === 18) throw new DOMException('full', 'QuotaExceededError');
    return originalPut.apply(this, args as any);
  };
  try { await assert.rejects(backend.load('p')); }
  finally { IDBObjectStore.prototype.put = originalPut; }
  assert.equal((await backend.load('p'))!.cards.length, 40);
});
test('resource URL round-trip is durable and broken blob URLs fail closed', async () => {
  const codec = new CardCodec();
  const blob = new Blob(['bytes']);
  const encoded = await codec.card(card('a', { imageUrl: 'blob:test', fileData: blob }));
  const resources = codec.pending(encoded.resources);
  assert.equal(resources.length, 1);
  codec.accept(resources);
  const decoded = codec.decode(encoded.data);
  assert.equal(await (await fetch(decoded.imageUrl)).text(), 'bytes');
  assert.equal(await decoded.fileData.text(), 'bytes');
  await assert.rejects(codec.card(card('bad', { imageUrl: 'blob:missing' })));
});
test('project ownership and consecutive saves remain isolated; duplicate IDs rejected', async () => {
  const { repo, backend } = harness();
  await Promise.all([repo.save([card('a')], 'one'), repo.save([card('a', { x: 2 })], 'two')]);
  for (let i = 1; i <= 8; i++) await repo.save([card('a', { x: i })], 'one');
  assert.equal((await backend.load('one'))!.cards[0].data.x, 8);
  assert.equal((await backend.load('two'))!.cards[0].data.x, 2);
  await assert.rejects(repo.save([card('a'), card('a')], 'one'), /重复/);
});
test('request success followed by transaction abort must reject and keep old cards', async () => {
  const { repo, backend } = harness();
  await repo.save([card('a')], 'p');
  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(...args: any[]) {
    const req = originalPut.apply(this, args as any);
    if (this.name === 'projects') req.addEventListener('success', () => this.transaction.abort());
    return req;
  };
  try { await assert.rejects(repo.save([card('a', { x: 99 })], 'p')); }
  finally { IDBObjectStore.prototype.put = originalPut; }
  assert.equal((await backend.load('p'))!.cards[0].data.x, 0);
});
test('edits arriving during save are coalesced and the final edit is committed', async () => {
  const backend = new StorageBackend();
  let release!: () => void;
  let notify!: () => void;
  const entered = new Promise<void>(r => { notify = r; });
  const gate = new Promise<void>(r => { release = r; });
  let block = false;
  const repo = new CardRepository(async (method, ...args) => {
    if (method === 'commit' && block) { block = false; notify(); await gate; }
    return (backend as any)[method](...args);
  });
  await repo.save([card('a')], 'p');
  block = true;
  const first = repo.save([card('a', { x: 1 })], 'p');
  await entered;
  const second = repo.save([card('a', { x: 2 })], 'p');
  const third = repo.save([card('a', { x: 3 })], 'p');
  release();
  await Promise.all([first, second, third]);
  const stored = (await backend.load('p'))!;
  assert.equal(stored.cards[0].data.x, 3);
  assert.equal(stored.head.revision, 3);
});
test('recovery journal restores edit, deletion and original media', async () => {
  const { repo } = harness();
  await repo.save([card('a', { fileData: new Blob(['keep']) })], 'p');
  await repo.save([card('a', { x: 5, fileData: new Blob(['changed']) })], 'p');
  const restored = await repo.restore('p');
  assert.equal(restored![0].x, 0);
  assert.equal(await restored![0].fileData!.text(), 'keep');
  await repo.remove('p');
  const undeleted = await repo.restore('p');
  assert.equal(await undeleted![0].fileData!.text(), 'keep');
});
test('failed bulk staging never publishes a partial project and can retry', async () => {
  const backend = new StorageBackend();
  let stageCount = 0, fail = false, discarded = false;
  const repo = new CardRepository(async (method, ...args) => {
    if (method === 'stage' && fail && ++stageCount === 2) throw Error('worker message failed');
    if (method === 'discard') discarded = true;
    return (backend as any)[method](...args);
  });
  await repo.save([card('old')], 'p');
  const next = Array.from({ length: 48 }, (_, i) => card(String(i)));
  fail = true;
  await assert.rejects(repo.save(next, 'p'));
  assert.ok(discarded);
  assert.deepEqual((await backend.load('p'))!.head.order, ['old']);
  fail = false;
  await repo.save(next, 'p');
  assert.equal((await backend.load('p'))!.cards.length, 48);
});

test('concurrent fields/additions merge; explicit deletion wins; sync adopts latest', async () => {
  const { repo, rpc } = harness();
  await repo.save([card('a'),card('b')], 'p');
  const other = new CardRepository(rpc);
  const local = (await repo.load('p'))!;
  const remote = (await other.load('p'))!;
  await other.save([{...remote[0],prompt:'remote'},remote[1],card('c')], 'p');
  const edited = [{...local[0],x:17},local[1]];
  await repo.save(edited,'p');
  const latest = (await repo.synchronize('p',edited,()=>true))!;
  assert.equal(latest[0].prompt,'remote'); assert.equal(latest[0].x,17);
  assert.deepEqual(latest.map(c=>c.id),['a','b','c']);
  await repo.save(latest.filter(c=>c.id!=='a'),'p');
  await other.save([{...remote[0],prompt:'stale edit'},remote[1],card('c')],'p');
  const reader = new CardRepository(rpc);
  assert.deepEqual((await reader.load('p'))!.map(c=>c.id),['b','c']);
});
test('nested fields merge and removed fields do not overwrite unrelated edits', async () => {
  const {repo,rpc}=harness();
  await repo.save([card('a',{mcpParameters:{quality:'low',duration:5}})],'p');
  const other=new CardRepository(rpc);
  const a=(await repo.load('p'))!, b=(await other.load('p'))!;
  await repo.save([{...a[0],mcpParameters:{duration:5}}],'p');
  await other.save([{...b[0],mcpParameters:{quality:'low',duration:10}}],'p');
  assert.deepEqual((await new CardRepository(rpc).load('p'))![0].mcpParameters,{duration:10});
});
test('sync rejects stale UI snapshot and catches changes on a later sync', async () => {
  const {repo,rpc}=harness(); await repo.save([card('a')],'p');
  const base=(await repo.load('p'))!;
  const other=new CardRepository(rpc); await other.load('p');
  await other.save([card('a',{prompt:'remote'})],'p');
  assert.equal(await repo.synchronize('p',base,()=>false),null);
  const local=[{...base[0],x:42}];
  const result=(await repo.synchronize('p',local,()=>true))!;
  assert.equal(result[0].x,42); assert.equal(result[0].prompt,'remote');
});
test('stale bulk edits merge without dropping remote cards and preserve media', async () => {
  const {repo,rpc}=harness();
  const original = new Blob(['original']);
  await repo.save(Array.from({length:20},(_,i)=>card(String(i),{fileData:original})), 'p');
  const local=(await repo.load('p'))!;
  const other=new CardRepository(rpc); const remote=(await other.load('p'))!;
  await other.save([{...remote[0],prompt:'remote'},...remote.slice(1),card('extra')],'p');
  await repo.save(local.map(c=>({...c,x:99})),'p');
  const result=(await new CardRepository(rpc).load('p'))!;
  assert.equal(result.length,21); assert.equal(result[0].prompt,'remote');
  assert.equal(result[0].x,99); assert.equal(await result[0].fileData!.text(),'original');
});
test('unchanged sync checks only head, with no full load or assets', async () => {
  const {repo,calls}=harness(); const cards=[card('a')];
  await repo.save(cards,'p'); calls.length=0;
  assert.equal(await repo.synchronize('p',cards,()=>true),cards);
  assert.deepEqual(calls.map(c=>c.method),['getHead']);
});
