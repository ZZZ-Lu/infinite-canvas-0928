const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const source=fs.readFileSync('src/components/GenerationCard.tsx','utf8');
const ast=ts.createSourceFile('GenerationCard.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const declarations=new Map();
function visit(node){if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&['checkCursorMention','handleTextareaKeyDown'].includes(node.name.text))declarations.set(node.name.text,node.getText(ast));ts.forEachChild(node,visit);}visit(ast);
let selected=0,inserted=null; const pending={}; const flush=()=>{Object.assign(context,pending);for(const key of Object.keys(pending))delete pending[key];};
const context={exports:{},referenceDisplayName:name=>name,mentionMenuOpen:true,mentionQuery:'',allMentionItems:[{name:'one'},{name:'two'},{name:'three'}],filteredMentionCandidates:[{name:'one'},{name:'two'},{name:'three'}],selectedMentionIndex:0,
setMentionMenuOpen:value=>pending.mentionMenuOpen=value,setMentionQuery:value=>pending.mentionQuery=value,
setSelectedMentionIndex:value=>{selected=typeof value==='function'?value(selected):value;context.selectedMentionIndex=selected;},insertMention:item=>inserted=item};
vm.runInNewContext(ts.transpileModule([...declarations.values()].map(text=>'const '+text+';').join('\n')+'\nexports.check=checkCursorMention;exports.key=handleTextareaKeyDown;', {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context);
const {key}=context.exports; const check=(...args)=>{context.exports.check(...args);flush();};
const press=(name,composing=false)=>{let prevented=false;key({key:name,nativeEvent:{isComposing:composing},keyCode:composing?229:0,preventDefault(){prevented=true;},stopPropagation(){}});flush();return prevented;};
assert.equal(press('ArrowDown'),true);assert.equal(selected,1);
check('text@',5);assert.equal(selected,1); // Same check performed by textarea keyup/select.
press('ArrowDown');check('text@',5);assert.equal(selected,2);
press('ArrowDown');assert.equal(selected,0);press('ArrowUp');assert.equal(selected,2);
assert.equal(press('ArrowDown',true),false);assert.equal(selected,2);
press('Enter');assert.equal(inserted.name,'three');
check('text@t',6);assert.equal(selected,0);
context.mentionMenuOpen=false;check('text@t',6);assert.equal(selected,0);assert.equal(context.mentionMenuOpen,true);
press('Escape');assert.equal(context.mentionMenuOpen,false);
console.log('PASS: arrow navigation survives keyup/select, wraparound, query reset, Enter selection, Escape, IME candidate keys');

