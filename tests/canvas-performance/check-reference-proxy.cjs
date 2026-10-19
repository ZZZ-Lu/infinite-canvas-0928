const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const calls=[],images=new Map();let fail=false;
const context={exports:{},require:name=>name==='./thumbnail'?{generateImageThumbnail:async(source,edge)=>{calls.push({source,edge});if(fail)throw Error('load failed');return 'proxy:'+source;}}:{fullImageCache:images}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/utils/referencePreview.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
const {resolveReferencePreviewSource:resolve,getStandardReferencePreview:preview}=context.exports;
(async()=>{
  const cards=[{id:'a',imageUrl:'standard',originalImageUrl:'original',trueOriginalImageUrl:'raw'}];
  assert.equal(resolve({url:'raw',sourceCardId:'a'},cards),'standard');
  assert.equal(resolve({url:'original'},cards),'standard');
  assert.equal(resolve({url:'upload'},cards),'upload');
  const first=preview('standard');assert.equal(preview('standard'),first);assert.equal(await first,'proxy:standard');
  assert.equal(calls.length,1);assert.equal(calls[0].edge,1200);
  images.set('decoded-standard',{complete:true,naturalWidth:800,naturalHeight:1200});
  assert.equal(await preview('decoded-standard'),'decoded-standard');assert.equal(calls.length,1);
  images.set('large',{complete:true,naturalWidth:4000,naturalHeight:6000});
  assert.equal(await preview('large'),'proxy:large');assert.equal(calls.at(-1).edge,1200);
  fail=true;await assert.rejects(preview('bad'));fail=false;assert.equal(await preview('bad'),'proxy:bad');
  console.log('PASS: source-card standard proxy preference, 1200px generation, decoded proxy reuse, deduplication, failed-request retry');
})().catch(error=>{console.error(error);process.exitCode=1;});
