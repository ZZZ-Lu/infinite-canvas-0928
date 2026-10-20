import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { StorageBackend } from '../../src/storage/backend';
import { CardRepository } from '../../src/storage/repository';
import { CardCodec } from '../../src/storage/codec';

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
test('cross-tab stale revision rejects without replacing newer data', async () => {
  const first = harness();
  await first.repo.save([card('a')], 'p');
  const second = harness();
  await second.repo.load('p');
  await first.repo.save([card('a', { x: 3 })], 'p');
  await assert.rejects(second.repo.save([card('a', { x: 7 })], 'p'), /其他页面/);
  assert.equal((await first.backend.load('p'))!.cards[0].data.x, 3);
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
