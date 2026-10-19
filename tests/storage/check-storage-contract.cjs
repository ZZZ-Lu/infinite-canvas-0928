const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { IDBFactory, IDBObjectStore } = require('fake-indexeddb');

// Each runtime models a separate tab; every test uses isolated in-memory IDB.
function runtime(factory) {
  const modules = new Map();
  function load(name) {
    const file = path.resolve(name.endsWith('.ts') ? name : name + '.ts');
    if (modules.has(file)) return modules.get(file).exports;
    const module = { exports: {} }; modules.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    vm.runInNewContext(code, {
      module, exports: module.exports,
      require: ref => ref.startsWith('.') ? load(path.resolve(path.dirname(file), ref)) : require(ref),
      indexedDB: factory, navigator: {}, Blob, crypto: webcrypto, console, Date,
    });
    return module.exports;
  }
  return load('src/db.ts');
}

// A backend migration must deliberately update this contract, not silently switch imports.
const app = ts.createSourceFile('App.tsx', fs.readFileSync('src/App.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const imports = app.statements.filter(ts.isImportDeclaration);
const persistenceImports = imports.filter(n => n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings) &&
  n.importClause.namedBindings.elements.some(e => ['saveCards', 'loadCards', 'deleteCardsForProject', 'restoreCardBackup'].includes((e.propertyName || e.name).text)));
assert.equal(persistenceImports.length, 1, 'Card persistence must have one explicit backend in App');
assert.equal(persistenceImports[0].moduleSpecifier.text, './db', 'Backend migration requires updating the storage contract');
const dbSource = ts.createSourceFile('db.ts', fs.readFileSync('src/db.ts', 'utf8'), ts.ScriptTarget.Latest, true);
function check(node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    assert.notEqual(node.expression.name.text, 'deleteDatabase', 'Active backend must never delete an unfamiliar database');
    assert.notEqual(node.expression.name.text, 'clear', 'Active backend must not clear an entire object store');
  }
  ts.forEachChild(node, check);
}
check(dbSource);

(async () => {
  const factory = new IDBFactory(), a = runtime(factory), b = runtime(factory);
  const original = [{ id: 'stable-id', x: -20.5, y: 81, prompt: 'original',
    fileData: new Blob(['proxy']), originalFileData: new Blob(['original']),
    trueOriginalFileData: new Blob(['lossless']), referenceImages: [{ url: 'blob:reference', fileData: new Blob(['reference']) }] }];
  await a.saveCards(original, 'project-A');
  const first = await a.loadCards('project-A');
  assert.equal(first[0].id, 'stable-id'); assert.equal(first[0].x, -20.5);
  for (const [field, expected] of [['fileData', 'proxy'], ['originalFileData', 'original'], ['trueOriginalFileData', 'lossless']]) {
    assert.equal(await first[0][field].text(), expected);
  }
  assert.equal(await first[0].referenceImages[0].fileData.text(), 'reference');

  const events = []; const unsubscribe = a.subscribeCardSaves(event => events.push(event));
  const write = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function(value, key) {
    if (key === 'cards_project-A' && value[0]?.prompt === 'local edit') throw new DOMException('simulated full disk', 'QuotaExceededError');
    return write.call(this, value, key);
  };
  try {
    await assert.rejects(a.saveCards(first.map(c => ({ ...c, prompt: 'local edit' })), 'project-A'), /full disk/);
  } finally { IDBObjectStore.prototype.put = write; }
  assert.equal(events.at(-1).state, 'error');
  assert.equal(a.hasPendingStorage(), true, 'A failed save must keep exit protection active');
  assert.equal((await a.loadCards('project-A'))[0].prompt, 'original');
  assert.equal(await a.loadCardBackup('project-A'), null, 'Failed transaction must not create a misleading backup');

  const remote = await b.loadCards('project-A');
  await b.saveCards(remote.map(c => ({ ...c, x: 900 })), 'project-A');
  await a.retryFailedCardSaves();
  const merged = await a.loadCards('project-A');
  assert.equal(merged[0].prompt, 'local edit'); assert.equal(merged[0].x, 900, 'Retry must preserve unrelated remote edits');
  assert.equal(a.hasPendingStorage(), false); assert.equal(events.at(-1).state, 'saved');
  const backup = await a.loadCardBackup('project-A'); assert.equal(backup[0].prompt, 'original');
  await a.restoreCardBackup('project-A');
  const restored = await a.loadCards('project-A');
  assert.equal(restored[0].prompt, 'original'); assert.equal(await restored[0].trueOriginalFileData.text(), 'lossless');

  await a.saveCards([{ id: 'isolated', prompt: 'B' }], 'project-B');
  await assert.rejects(a.saveCards([{ id: 'duplicate' }, { id: 'duplicate' }], 'project-A'), /重复/);
  assert.equal((await a.loadCards('project-A'))[0].id, 'stable-id', 'Invalid save must not replace the original project');
  await a.saveCards(restored, 'project-A');
  await a.deleteCardsForProject('project-A');
  await assert.rejects(a.loadCards('project-A'), /删除/);
  assert.equal((await a.loadCards('project-B'))[0].prompt, 'B', 'Deleting A must never delete B');
  await a.restoreCardBackup('project-A'); assert.equal((await a.loadCards('project-A'))[0].id, 'stable-id');
  unsubscribe();
  console.log('PASS: active backend contract, non-destructive API guard, binary/original retention, quota rollback, retry merge, restore, validation, project isolation');
})().catch(error => { console.error(error); process.exitCode = 1; });
