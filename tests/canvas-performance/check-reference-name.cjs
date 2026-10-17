const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript'),assert=require('node:assert/strict');
const context={exports:{}};
vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/utils/referenceName.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,context);
const {referenceDisplayName:short,shortenReferenceMentions:mentions}=context.exports;
assert.equal(short('一二三四五六七八九十'),'一二三四五六七八九十');
assert.equal(short('一二三四五六七八九十十一'),'一二三四五六七八九…');
assert.equal(Array.from(short('😀😀😀😀😀😀😀😀😀😀😀')).length,10);
const name='jimeng-2025-11-30-女明星';
assert.equal(mentions('引用 @'+name+' 继续',[name]),'引用 @'+short(name)+' 继续');
assert.equal(mentions('普通文字 '+name,[name]),'普通文字 '+name);
assert.equal(mentions('@图[1].png',['图[1].png']),'@图[1].png');
const special='reference[123456].png';
assert.equal(mentions('@'+special,[special]),'@'+short(special));
console.log('PASS: ten-character name limit, ellipsis, Unicode safety, exact @ mentions, ordinary prompt text preserved');

