const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript'), assert = require('node:assert/strict');
function load(path, dependencies) {
  const context = { exports: {}, require: name => {
    if (!(name in dependencies)) throw new Error(`Unexpected import ${name}`);
    return dependencies[name];
  }};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
  return context.exports;
}
const layout = load('src/utils/cardLayout.ts', {});
const geometry = load('src/utils/viewportCulling.ts', {
  '../components/GenerationCard': { getCardSize: c => ({ width: c.customWidth, height: c.customHeight }) },
  './cardLayout': layout,
});
const spatial = load('src/utils/quadTree.ts', { './viewportCulling': geometry });
const card = { id: 'top-panel', x: 20, y: -250, customWidth: 200, customHeight: 200, ratio: '1:1', prompt: 'Visible panel' };
const bounds = geometry.getCardVisualBounds(card);
assert.ok(card.y + card.customHeight < 0, 'image is above viewport');
assert.ok(bounds.maxY > 0, 'prompt panel remains visible');
assert.equal(bounds.minX, -120, 'centered panel extends left of narrow image');
assert.ok(geometry.isCardIntersectingRectangle(card, { viewportWidth: 800, viewportHeight: 600, scale: 1, tx: 0, ty: 0 }));
assert.equal(spatial.buildCardQuadTree([card]).query({ minX: -100, minY: 0, maxX: -90, maxY: 10 }).length, 1, 'spatial query retains panel-only intersection');
const asset = geometry.getCardVisualBounds({ ...card, isAsset: true });
assert.equal(asset.maxY, -50, 'assets do not gain phantom prompt panels');
assert.equal(spatial.buildCardQuadTree([{ ...card, isAsset: true }]).query({ minX: 0, minY: 0, maxX: 800, maxY: 600 }).length, 0);
console.log('PASS: top-edge panel visibility, centered panel extent, spatial index and asset culling');
