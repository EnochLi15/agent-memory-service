import {test} from 'node:test';import assert from 'node:assert/strict';
import {parseModelJson} from '../dist/model-json.js';
test('trailing comma normalization preserves every scalar, escaped string and rejection',()=>{
 const text='{"fact_checks":[[0,false,true,0,"literal ,] and \\\"quote\\\"",],],"value":null,"enabled":false,}';
 assert.deepEqual(parseModelJson(text),{value:{fact_checks:[[0,false,true,0,'literal ,] and "quote"']],value:null,enabled:false},trailingCommas:3});
 assert.deepEqual(parseModelJson('{"value":1}'),{value:{value:1},trailingCommas:0});
});
test('missing values, structural corruption, comments and truncated output cannot become valid JSON',()=>{
 for(const text of ['[,]','[1,,]','[1, ,]','{"a":,}','{"a":1,','{"a":1, "b" 2,}','{"x":[[6,"represented",[0],[],[5]],"message":8,"verdict_note":"represented"}]}','{"x":"unterminated,}','{"x":NaN,}','{"x":1,//comment\n}','prefix {"x":1,}'])assert.throws(()=>parseModelJson(text),SyntaxError,text);
});
