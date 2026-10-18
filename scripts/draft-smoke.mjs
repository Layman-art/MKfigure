// Real Electron + Store + Workflow + IPC; only the model service is a local barrier stub.
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=process.cwd(),version=JSON.parse(await fs.readFile('package.json','utf8')).version;
const out=path.join(root,'output','drafts',version),fixture=path.join(root,'.runtime','draft-fixture',Date.now().toString());
const data=path.join(fixture,'data');await fs.mkdir(out,{recursive:true});await fs.mkdir(fixture,{recursive:true});
const provider=`
import fs from 'node:fs/promises';import path from 'node:path';
globalThis.__multiTest={calls:[],active:0,maxActive:0,resolve:[],catalogReads:0,cancelled:[],wait:Promise.resolve()};
export function createProviders(){return {
status:async()=>({available:true,authenticated:true,label:'隔离测试服务'}),loginCodex:async()=>({available:true,authenticated:true,label:'隔离测试服务'}),
listModels:async()=>{globalThis.__multiTest.catalogReads++;return [{id:'test-model',name:'Local test',isDefault:true,supportsVision:true,reasoningEfforts:['low','medium']}];},dispose:()=>{},complete:async()=>{throw new Error('Unexpected text model call');},
generateImage:async request=>{const state=globalThis.__multiTest;const index=state.calls.length;
state.calls.push({prompt:request.prompt,reference:request.references?.[0]?.dataUrl,effort:request.reasoningEffort,outputDir:request.outputDir});state.active++;state.maxActive=Math.max(state.maxActive,state.active);
request.onEvent?.('测试模型处理中');request.onUsage?.({inputTokens:100+index,outputTokens:10,totalTokens:110+index});
try {await new Promise((resolve,reject)=>{const abort=()=>{state.cancelled.push(index);reject(new Error('Test cancelled'));};state.resolve[index]=()=>{request.signal?.removeEventListener('abort',abort);resolve();};request.signal?.addEventListener('abort',abort,{once:true});});
if (state.fail) throw new Error('Injected model failure');
return {dataUrl:request.references?.[0]?.dataUrl || state.calls.find(call=>call.reference)?.reference,model:'local-test'};
} finally {state.active--;}}
};}`;
await build({entryPoints:['src/main/main.ts'],outfile:path.join(fixture,'main.cjs'),platform:'node',format:'cjs',bundle:true,external:['electron','pdf-parse'],define:{__dirname:JSON.stringify(path.join(root,'dist/main'))},plugins:[{name:'isolated-model-service',setup(b){b.onResolve({filter:/^\.\/providers$/},args=>args.importer.endsWith('main.ts')?{path:'stub',namespace:'model-stub'}:null);b.onLoad({filter:/.*/,namespace:'model-stub'},()=>({contents:provider,loader:'js'}));}}]});
await fs.writeFile(path.join(fixture,'package.json'),JSON.stringify({name:'mk-figure-panes-test',version,main:'main.cjs'}));
const env={...process.env,MK_FIGURE_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
let client=await electron.launch({executablePath:electronPath,args:[fixture],cwd:root,env,timeout:60000});


const until=async(fn,label)=>{for(let i=0;i<200;i++){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Timed out: '+label);};
const errors=[];
try {
 let page=await client.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 await page.locator('.workspace-empty').waitFor();
 const folderA=path.join(fixture,'Research A'),folderB=path.join(fixture,'Research B');
 await fs.mkdir(folderA,{recursive:true});await fs.mkdir(folderB,{recursive:true});
 const open=async folder=>{await client.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},folder);await page.getByRole('button',{name:'打开文件夹',exact:true}).click();await page.waitForFunction(name=>document.querySelector('.active-folder strong')?.textContent===name,path.basename(folder));await page.locator('.studio-switching').waitFor({state:'hidden'});};
 const count=()=>page.evaluate(async()=>(await window.mkFigure.bootstrap()).projects.length);
 await open(folderA);
 await page.locator('.studio-route').filter({hasText:'单图创作'}).click();
 await page.locator('textarea.composer:visible').waitFor();assert.equal(await count(),0);
 const draft=await page.evaluate(()=>window.mkFigure.panes[0].createDraft('full'));
 assert.equal(draft.draftSlot,1);
 await assert.rejects(()=>page.evaluate(id=>window.mkFigure.panes[0].run(id,'generate'),draft.id));
 assert.equal(await count(),0);
 await page.locator('textarea.composer:visible').fill('神经 ODE 草稿验证');
 await page.locator('.studio-navigation').getByRole('button',{name:'首页',exact:true}).click();
 assert.equal(await count(),0);
 await page.locator('.studio-route').filter({hasText:'单图创作'}).click();
 assert.equal(await page.locator('textarea.composer:visible').inputValue(),'神经 ODE 草稿验证');
 await page.evaluate(async()=>{await window.mkFigure.saveSharedStyle({prompt:'蓝灰学术风格',palette:'蓝灰',background:'白色',lines:'细线'});await window.mkFigure.setSharedReference('pastel-method');});
 await open(folderB);assert.equal(await count(),0);
 await open(folderA);await page.locator('.studio-route').filter({hasText:'单图创作'}).click();
 assert.equal(await page.locator('textarea.composer:visible').inputValue(),'神经 ODE 草稿验证');
 const recovered=await page.evaluate(()=>window.mkFigure.panes[0].createDraft('full'));assert.equal(recovered.id,draft.id);
 await client.close();client=await electron.launch({executablePath:electronPath,args:[fixture],cwd:root,env,timeout:60000});
 page=await client.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 await page.locator('.studio-home').waitFor();assert.equal(await count(),0);
 await page.locator('.studio-route').filter({hasText:'单图创作'}).click();
 assert.equal(await page.locator('textarea.composer:visible').inputValue(),'神经 ODE 草稿验证');
 assert.equal((await page.evaluate(()=>window.mkFigure.panes[0].createDraft('full'))).id,draft.id);
 await client.evaluate(({dialog})=>{dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});});
 await page.getByRole('button',{name:'已有图片',exact:true}).click();
 assert.equal(await count(),0);assert.equal((await page.evaluate(()=>window.mkFigure.panes[0].createDraft('full'))).id,draft.id);
 // Attach a genuine local image through the native import handler; still a draft.
 await client.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},path.join(root,'resources/references/pastel-method.png'));
 await page.evaluate(id=>window.mkFigure.panes[0].importFiles(id,'reference'),draft.id);
 assert.equal(await count(),0);
 await page.locator('.studio-navigation').getByRole('button',{name:'单图创作',exact:true}).click();
 await page.locator('.step-button').filter({hasText:'内容与风格'}).click();
 await page.screenshot({path:path.join(out,'01-draft-not-in-sidebar.png')});
 await client.evaluate(()=>{globalThis.__multiTest.fail=true;});
 await page.locator('fieldset').getByRole('button',{name:'生成视觉稿',exact:true}).click();
 await until(()=>client.evaluate(()=>globalThis.__multiTest.active===1),'first run');
 assert.equal(await count(),1);
 const active=(await page.evaluate(()=>window.mkFigure.bootstrap())).projects[0];assert.equal(active.id,draft.id);assert.equal(active.name,'神经 ODE 草稿验证');
 await assert.rejects(()=>page.evaluate(id=>window.mkFigure.panes[0].run(id,'generate'),draft.id));
 assert.equal(await client.evaluate(()=>globalThis.__multiTest.calls.length),1);
 await client.evaluate(()=>globalThis.__multiTest.resolve[0]());
 await until(()=>page.locator('.progress-banner').count().then(n=>n===0),'failed run ends');assert.equal(await count(),1);
 await client.evaluate(()=>{globalThis.__multiTest.fail=false;});
 await page.locator('fieldset').getByRole('button',{name:'生成视觉稿',exact:true}).click();
 await until(()=>client.evaluate(()=>globalThis.__multiTest.calls.length===2),'retry');
 await client.evaluate(()=>globalThis.__multiTest.resolve[1]());
 await until(()=>page.locator('.progress-banner').count().then(n=>n===0),'retry ends');
 assert.equal(await count(),1);
 const finished=await page.evaluate(id=>window.mkFigure.panes[0].openProject(id),draft.id);
 const staleSaved=await page.evaluate(p=>window.mkFigure.panes[0].saveProject({...p,draftSlot:1}),finished);
 assert.equal(staleSaved.draftSlot,undefined);assert.equal(await count(),1);
 assert.equal(finished.draftSlot,undefined);assert.equal(finished.runs.length,2);assert.equal(finished.runs[0].status,'failed');assert.equal(finished.runs[1].status,'completed');
 await page.screenshot({path:path.join(out,'02-first-run-in-sidebar.png')});
 assert.deepEqual(errors,[]);
 const report={passed:true,enteringCreationDoesNotCreateListedProject:true,invalidRunKeepsDraft:true,contentAndStyleKeepDraftHidden:true,pageAndFolderSwitchRestoreDraft:true,restartRestoresHiddenDraft:true,cancelledUploadKeepsDraftHidden:true,uploadedImageKeepsDraftHidden:true,firstRunPromotesSameId:true,topicNamesProject:true,duplicateRunRejected:true,failureAndRetryKeepOneProject:true,staleDraftCannotDemoteProject:true,liveModelCalls:0,pageErrors:errors};
 await fs.writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
} catch(error){const page=(await client.windows())[0];await page?.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw error;}
finally{await client.evaluate(({app})=>app.exit()).catch(()=>{});await client.close().catch(()=>{});}
