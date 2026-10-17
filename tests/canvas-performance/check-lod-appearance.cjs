const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
class Path {
  constructor(){this.ops=[];}
  rect(...args){this.ops.push(['rect',...args]);}
  roundRect(...args){this.ops.push(['roundRect',...args]);}
  moveTo(...args){this.ops.push(['moveTo',...args]);}
  lineTo(...args){this.ops.push(['lineTo',...args]);}
  closePath(){this.ops.push(['close']);}
}
const context={exports:{},Path2D:Path,require:()=>({getNanoLodThreshold:()=>.4})};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/utils/cardLodAppearance.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
const {cardOutline,isStandardCardLod,CARD_CORNER_RADIUS,cardCornerStyle}=context.exports;
assert.equal(isStandardCardLod(.399),false);assert.equal(isStandardCardLod(.4),true);
assert.equal(cardCornerStyle['--card-corner-radius'],CARD_CORNER_RADIUS+'px');
assert.equal(cardOutline(480,640,false).ops[0][0],'rect');
const standard=cardOutline(480,640,true);
assert.ok(standard.ops.some(op=>op[0]==='lineTo'));assert.equal(standard.ops.at(-1)[0],'close');
for(const op of standard.ops) for(const value of op.slice(1)) assert.ok(Number.isFinite(value));
for(let i=0;i<10000;i++)assert.equal(cardOutline(480,640,true),standard);
assert.equal(cardOutline(480,640,true,false).ops[0][0],'roundRect');
assert.ok(cardOutline(8,8,true).ops.every(op=>op.slice(1).every(Number.isFinite)));
console.log('PASS: live 40% boundary, shared native radius, squircle geometry, browser fallback, cached paths, small dimensions');
