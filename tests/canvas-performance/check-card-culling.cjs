const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
function load(file,require){const context={exports:{},require};vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);return context.exports;}
const layout=load('src/utils/cardLayout.ts');
const size=card=>({width:card.customWidth||360,height:card.customHeight||640});
const bounds=load('src/utils/viewportCulling.ts',name=>name.includes('GenerationCard')?{getCardSize:size}:name.includes('cardLayout')?layout:{NANO_LOD_THRESHOLD:.4});
const tree=load('src/utils/quadTree.ts',()=>bounds);
const card={id:'top',x:100,y:-700,ratio:'9:16',prompt:'',referenceImages:[]};
const b=bounds.getCardWorldBounds(card);
assert.equal(b.minX,40);assert.equal(b.maxX,520);assert.equal(b.maxY,161);
assert.ok(card.y+640<0); // Image is entirely above the viewport, panel remains visible.
assert.ok(b.maxY>0);
const viewport={minX:0,minY:0,maxX:800,maxY:600};
assert.equal(tree.buildCardQuadTree([card]).query(viewport)[0].id,'top');
assert.equal(bounds.isCardIntersectingRectangle(card,{viewportWidth:800,viewportHeight:600,scale:1,tx:0,ty:0}),true);
assert.equal(tree.buildCardQuadTree([{...card,isAsset:true}]).query(viewport).length,0);
const legacy={...card,referenceImages:undefined,referenceImageUrl:'ref'};
assert.equal(bounds.getCardWorldBounds(legacy).maxY,161);
for(const scale of [.2,.4,1,3]){
  const ty=20-b.maxY*scale;
  assert.equal(bounds.isCardIntersectingRectangle(card,{viewportWidth:800,viewportHeight:600,scale,tx:0,ty}),true);
}
const leftOnly={...card,x:500,y:0};
assert.equal(tree.buildCardQuadTree([leftOnly]).query({minX:440,maxX:450,minY:650,maxY:700})[0].id,'top');
console.log('PASS: image above viewport/panel visible, centered panel edges, shared quadtree bounds, asset culling, legacy reference, zoom scales');
