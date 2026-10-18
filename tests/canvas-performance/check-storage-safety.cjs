const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=s=>ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const app=fs.readFileSync('src/App.tsx','utf8');
const start=app.indexOf('  // A save owns both');
const effect=app.slice(start,app.indexOf('  // Best effort only',start));
function schedule(snapshot,loaded=snapshot){
 const jobs=new Map(),writes=[];let cleanup;const owner={current:'A'};
 const ctx={saveDeadlineRef:{current:null},markStorageDirty:()=>{},Date,useEffect:fn=>cleanup=fn(),isLoading:false,currentProjectId:'A',loadedProjectIdRef:owner,loadedCardsSnapshotRef:{current:loaded},observedSaveCardsRef:{current:[]},cards:snapshot,setTimeout:fn=>{jobs.set(1,fn);return 1},clearTimeout:id=>jobs.delete(id),saveCards:(cards,project)=>{writes.push({cards,project});return Promise.resolve()},console};
 vm.runInNewContext(compile(effect),ctx);return {jobs,writes,owner,cleanup};
}
const empty=[];assert.equal(schedule(empty).jobs.size,0,'loaded empty state must not auto-write');
const job=schedule([{id:'A'}],[]),late=[...job.jobs.values()][0];job.owner.current='B';job.cleanup();late();assert.equal(job.writes.length,0,'late callback must reject changed owner');
assert.equal(job.jobs.size,0,'cleanup cancels scheduler');
const stable=schedule([{id:'A'}],[]);[...stable.jobs.values()][0]();assert.equal(stable.writes[0].project,'A');assert.equal(stable.writes[0].cards[0].id,'A');

let clock=0;const timers=[],images=[];
class Image {constructor(){images.push(this);this.complete=false;this.naturalWidth=0;}}
const texture={exports:{},Image,Date:{now:()=>clock},setTimeout:(fn,ms)=>timers.push({fn,ms}),console:{warn(){},error:console.error}};
vm.runInNewContext(compile(fs.readFileSync('src/utils/imageTextureCache.ts','utf8')),texture);
const api=texture.exports;let painted=0;
api.getOrLoadCanvasImage('blob:test',()=>painted++);images[0].onerror();assert.equal(api.fullImageCache.has('blob:test'),false);
for(let n=0;n<20;n++) api.getOrLoadCanvasImage('blob:test');assert.equal(images.length,1,'backoff must block render-loop retries');
clock=500;timers.shift().fn();assert.equal(images.length,2);images[1].complete=true;images[1].naturalWidth=1200;images[1].onload();assert.equal(painted,1,'successful retry redraws original consumer');
api.getOrLoadCanvasImage('blob:bad');images.at(-1).onerror();clock+=500;timers.shift().fn();images.at(-1).onerror();clock+=1000;timers.shift().fn();images.at(-1).onerror();assert.equal(timers.length,0,'retry budget stops permanent failures');

console.log('PASS: scheduler ownership/cancellation, empty-load protection and bounded image retries');
