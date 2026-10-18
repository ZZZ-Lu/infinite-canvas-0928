const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const compile=s=>ts.transpileModule(s,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
const app=fs.readFileSync('src/App.tsx','utf8');
const start=app.indexOf('  // A save owns both');
const effect=app.slice(start,app.indexOf('  // Best effort only',start));
function schedule(snapshot,loaded=snapshot){
 const jobs=new Map(),writes=[];let cleanup;const owner={current:'A'};
 const ctx={useEffect:fn=>cleanup=fn(),isLoading:false,currentProjectId:'A',loadedProjectIdRef:owner,loadedCardsSnapshotRef:{current:loaded},observedSaveCardsRef:{current:[]},cards:snapshot,setTimeout:fn=>{jobs.set(1,fn);return 1},clearTimeout:id=>jobs.delete(id),saveCards:(cards,project)=>{writes.push({cards,project});return Promise.resolve()},console};
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

(async()=>{
 const data=new Map([['cards_A',[{id:'old'}]]]),transactions=[],events=[];
 const db={close(){},transaction(){
  const staged=new Map();const tx={error:null,abort(){this.error=new Error('aborted');this.onabort();},objectStore(){return {get(key){const request={result:data.get(key)};queueMicrotask(()=>request.onsuccess?.());return request;},put(value,key){staged.set(key,value);return {};}}},commit(){for(const [k,v] of staged)data.set(k,v);this.oncomplete();}};
  transactions.push(tx);return tx;
 }};
 const indexedDB={open(){const request={result:db};queueMicrotask(()=>request.onsuccess());return request;}};
 const context={exports:{},indexedDB,console,Date};vm.runInNewContext(compile(fs.readFileSync('src/db.ts','utf8')),context);
 const store=context.exports;store.subscribeCardSaves(e=>events.push(e));
 const tick=()=>new Promise(resolve=>setImmediate(resolve));
 let done=false;const save=store.saveCards([{id:'new'}],'A').then(()=>done=true);await tick();assert.equal(done,false,'request processing is not transaction commit');assert.equal(data.get('cards_A')[0].id,'old');transactions[0].commit();await save;assert.equal(data.get('cards_A')[0].id,'new');assert.equal(data.get('cards_A_backup')[0].id,'old');
 const bad=store.saveCards([],'A');const rejection=assert.rejects(bad,/aborted/);await tick();transactions[1].abort();await rejection;assert.equal(data.get('cards_A')[0].id,'new','abort preserves previous record');assert.equal(events.at(-1).state,'error');
 const one=store.saveCards([{id:'one'}],'A'),two=store.saveCards([{id:'two'}],'A');await tick();assert.equal(transactions.length,3,'second write waits for first');transactions[2].commit();await one;await tick();assert.equal(transactions.length,4);transactions[3].commit();await two;assert.equal(data.get('cards_A')[0].id,'two');assert.equal(data.get('cards_A_backup')[0].id,'one');
 const original=[{id:'undo-original'}], edited=[{id:'edited'}];
 let pending=store.saveCards(original,'A');await tick();transactions.at(-1).commit();await pending;
 const count=transactions.length;await store.saveCards(original,'A');assert.equal(transactions.length,count,'identical committed snapshot is not written twice');
 pending=store.saveCards(edited,'A');await tick();transactions.at(-1).commit();await pending;
 pending=store.saveCards(original,'A');await tick();transactions.at(-1).commit();await pending;assert.equal(data.get('cards_A')[0].id,'undo-original','undo must persist an older snapshot again');
 pending=store.saveCards([],'A');await tick();transactions.at(-1).commit();await pending;assert.equal(data.get('cards_A').length,0);assert.equal(data.get('cards_A_backup')[0].id,'undo-original','intentional clearing retains recovery copy');
 
 const validBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
 const corruptBlob = { size: 100, type: 'image/jpeg', arrayBuffer: () => Promise.reject(new Error('Corrupt blob source')) };
 const nestedCard = { id: 'nested', fileData: validBlob, baselineConfig: { referenceImageFileData: validBlob, referenceImages: [{ url: 'u', fileData: corruptBlob }] } };
 let nestSave = store.saveCards([nestedCard], 'A');
 await tick();
 transactions.at(-1).commit();
 await nestSave;
 assert.equal(data.get('cards_A')[0].id, 'nested');
 assert.equal(data.get('cards_A')[0].fileData.__isBlob, true);
 assert.equal(data.get('cards_A')[0].baselineConfig.referenceImageFileData.__isBlob, true);
 console.log('PASS: project ownership, cancellation, empty-load protection, bounded image retries, transaction completion/abort, atomic backup, write ordering, and recursive blob serialization');
})().catch(e=>{console.error(e);process.exitCode=1;});
