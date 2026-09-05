// Mechanical method extraction. Algorithm bodies are copied byte-for-byte and
// hashed; the pinned upstream tree is never modified. Generated files are ignored.
import ts from 'typescript';
import {readFileSync,writeFileSync,cpSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=new URL('.',import.meta.url);
const original=new URL('upstream/src/oss/src/memory/index.ts',root);
const input=readFileSync(original,'utf8');
const ast=ts.createSourceFile('index.ts',input,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const memory=ast.statements.find(s=>ts.isClassDeclaration(s)&&s.name?.text==='Memory');
if(!memory)throw Error('Pinned Memory class missing');
cpSync(new URL('upstream',root),new URL('.data/u1',root),{recursive:true});
const dir=new URL('.data/u1/src/oss/src/memory/',root);
const imports=ast.statements.filter(ts.isImportDeclaration).map(s=>s.getText(ast)).join('\n');
const shared=ast.statements.filter(s=>!ts.isImportDeclaration(s)&&s!==memory);
const names=shared.flatMap(s=>ts.isVariableStatement(s)?s.declarationList.declarations.map(d=>d.name.getText(ast)):('name' in s&&s.name?[s.name.getText(ast)]:[]));
writeFileSync(new URL('stage-common.ts',dir),imports+'\n'+shared.map(s=>(s.modifiers?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)?'':'export ')+s.getText(ast)).join('\n'));
const common=`import {${names.join(',')}} from './stage-common';\n`;
let body=input.slice(memory.getStart(ast));const manifest=[];
const selected=['addToVectorStore','search'];
for(const name of selected){
 const method=memory.members.find(m=>ts.isMethodDeclaration(m)&&m.name.getText(ast)===name);
 if(!method?.body)throw Error('Method missing: '+name);
 const code=method.body.getText(ast);const params=method.parameters.map(p=>p.getText(ast)).join(',');const args=method.parameters.map(p=>p.name.getText(ast)).join(',');
 const stage=name+'Stage';
 writeFileSync(new URL(stage+'.ts',dir),imports+'\n'+common+`export async function ${stage}(this:any,${params}):${method.type.getText(ast)} `+code+'\n');
 body=body.replace(method.getText(ast),method.getText(ast).replace(code,`{ return ${stage}.call(this,${args}); }`));
 manifest.push({method:name,body_sha256:createHash('sha256').update(code).digest('hex'),bytes:Buffer.byteLength(code)});
}
writeFileSync(new URL('index.ts',dir),imports+'\n'+common+selected.map(n=>`import {${n}Stage} from './${n}Stage';`).join('\n')+'\nexport {LLMError} from "./stage-common";\n'+body);
writeFileSync(new URL('.data/u1-refactor-manifest.json',root),JSON.stringify({upstream_commit:'dae67f74f5cc7bf138c7d7d6f9cec5ce4b4373b3',transformation:'extract write preparation and search orchestration methods; preserve bodies, this binding, shared helper identity',methods:manifest},null,2));
console.log(JSON.stringify({status:'generated',methods:manifest}));
