// Real Electron + Store + Workflow + IPC; only the model service is a local barrier stub.
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=process.cwd(),version=JSON.parse(await fs.readFile('package.json','utf8')).version;
const out=path.join(root,'output','panes',version),fixture=path.join(root,'.runtime','panes-fixture',Date.now().toString());
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
return {dataUrl:request.references?.[0]?.dataUrl || state.calls.find(call=>call.reference)?.reference,model:'local-test'};
} finally {state.active--;}}
};}`;
await build({entryPoints:['src/main/main.ts'],outfile:path.join(fixture,'main.cjs'),platform:'node',format:'cjs',bundle:true,external:['electron','pdf-parse'],define:{__dirname:JSON.stringify(path.join(root,'dist/main'))},plugins:[{name:'isolated-model-service',setup(b){b.onResolve({filter:/^\.\/providers$/},args=>args.importer.endsWith('main.ts')?{path:'stub',namespace:'model-stub'}:null);b.onLoad({filter:/.*/,namespace:'model-stub'},()=>({contents:provider,loader:'js'}));}}]});
await fs.writeFile(path.join(fixture,'package.json'),JSON.stringify({name:'mk-figure-panes-test',version,main:'main.cjs'}));
const env={...process.env,MK_FIGURE_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
const client=await electron.launch({executablePath:electronPath,args:[fixture],cwd:root,env,timeout:60000});

const errors=[],projects=[];
const paneDraftReady=page=>page.locator('textarea.composer:visible').waitFor();
const until=async(fn,label)=>{for(let i=0;i<160;i++){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Timed out: '+label);};
try{
 const page=await client.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 await page.locator('.workspace-empty').waitFor();
 // Explicit legacy selection keeps this IPC/concurrency fixture's original storage paths.
 await page.evaluate(()=>window.mkFigure.closeFolder());
 await page.locator('.studio-route').filter({hasText:'单图创作'}).click();
 await paneDraftReady(page);
 assert.equal(await page.evaluate(async()=> (await window.mkFigure.bootstrap()).projects.length),0);
 await page.locator('.studio-navigation').getByRole('button',{name:'单图创作',exact:true}).click();
 assert.equal(await page.evaluate(async()=> (await window.mkFigure.bootstrap()).projects.length),0);
 await page.locator('.studio-navigation').getByRole('button',{name:'并行创作',exact:true}).click();
 await page.locator('.creation-card').first().waitFor();
 assert.equal(await page.locator('.creation-card').count(),6);assert.equal((await client.windows()).length,1);
 await client.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];win.webContents.setBackgroundThrottling(false);win.setContentSize(1440,940);win.show();win.focus();});
 const pane=i=>page.locator('.pane-host').nth(i);
 const overview=()=>page.locator('.studio-header').getByRole('button',{name:'六窗总览',exact:true}).click();
 const shot=async(name)=>{await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(out,name+'.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));};
 await shot('01-six-panels');
 const styles=['统一蓝灰细线','统一蓝灰细线','统一蓝灰细线','黑白线稿','', '紫色模块'];
 const modes=['shared','shared','shared','custom','none','custom'];
 await page.evaluate(async()=>{const api=window.mkFigure;await api.saveSharedStyle({prompt:'统一蓝灰细线',palette:'蓝灰',background:'白色',lines:'细线'});await api.setSharedReference('pastel-method');});
 for(let i=0;i<6;i++){
  if(i>0)await pane(i).getByRole('button',{name:'新建科研图',exact:true}).click();
  await pane(i).getByRole('textbox',{name:'主题与内容',exact:true}).fill('子窗口 '+(i+1)+' 的科研图');
  await pane(i).locator('.creation-style-badge').click();
  if(modes[i]==='custom'){
   await pane(i).getByRole('button',{name:'本图自定义',exact:true}).click();
   await pane(i).getByRole('textbox',{name:'风格描述',exact:true}).fill(styles[i]);
   await pane(i).getByRole('button',{name:'从素材库选择',exact:true}).click();
   await pane(i).locator(`[data-library-id="${i===3?'algorithm-flow':'voltage-control'}"]`).getByRole('button',{name:'用作风格',exact:true}).click();
   await pane(i).getByText('主题与重点',{exact:true}).waitFor();
  }else if(modes[i]==='none') await pane(i).getByRole('button',{name:'不用参考风格',exact:true}).click();
  // Commit pending draft through the normal pane navigation before reading back.
  await overview();
  await new Promise(r=>setTimeout(r,750));
  const p=await page.evaluate(async i=>window.mkFigure.panes[i].createDraft('full'),i);projects.push(p);assert.equal(p.styleMode,modes[i]);
 }
 assert.equal((await client.windows()).length,1);
 assert.equal(await page.evaluate(async()=> (await window.mkFigure.bootstrap()).projects.length),0);
 await assert.rejects(()=>page.evaluate(id=>window.mkFigure.panes[1].openProject(id),projects[0].id),/另一个子窗口/);
 await assert.rejects(()=>page.evaluate(p=>window.mkFigure.panes[1].saveProject(p),projects[0]),/作品已切换/);
 await page.evaluate(()=>{window.__paneProgress=Array.from({length:6},()=>[]);window.mkFigure.panes.forEach((api,i)=>api.onProgress(e=>window.__paneProgress[i].push(e.projectId)));});
 await shot('02-independent-styles');
 assert.equal(await page.getByRole('button',{name:/开始就绪任务/}).count(),0);
 for(let i=0;i<6;i++)await pane(i).getByRole('button',{name:'开始',exact:true}).click();
 await until(()=>client.evaluate(()=>globalThis.__multiTest.active===6),'six concurrent tasks');
 assert.equal(await page.evaluate(async()=> (await window.mkFigure.bootstrap()).projects.length),6);
 const calls=await client.evaluate(()=>globalThis.__multiTest.calls);assert.equal(calls.length,6);assert.equal(new Set(calls.map(c=>c.outputDir)).size,6);
 for(let i=0;i<6;i++){
  const call=calls.find(c=>c.prompt.includes('子窗口 '+(i+1)+' 的科研图'));assert.ok(call);
  if(styles[i])assert.ok(call.prompt.includes(styles[i]));
  if(modes[i]==='none'){assert.ok(!call.reference);assert.ok(!call.prompt.includes(styles[0]));}
  assert.deepEqual(await page.evaluate(i=>[...new Set(window.__paneProgress[i])],i),[projects[i].id]);
 }
 const readsBefore=await client.evaluate(()=>globalThis.__multiTest.catalogReads);
 await page.evaluate(async()=>{await window.mkFigure.getModelCatalog(true);await window.mkFigure.saveSharedStyle({prompt:'新一轮橙金风格',palette:'橙金',background:'白',lines:'圆角'});});
 assert.equal(await client.evaluate(()=>globalThis.__multiTest.active),6);
 assert.ok(await client.evaluate(()=>globalThis.__multiTest.catalogReads)>readsBefore);
 assert.deepEqual(await client.evaluate(()=>globalThis.__multiTest.calls),calls);
 await until(()=>page.locator('.creation-card.is-running').count().then(n=>n===6),'all six visible running');
 await shot('03-six-running');
 await pane(1).getByRole('button',{name:'展开子窗口 2',exact:true}).click();
 await pane(1).locator('.progress-banner').waitFor();assert.equal(await page.locator('.workspace-task').count(),6);
 assert.equal(await page.locator('.pane-host').count(),6);assert.equal((await client.windows()).length,1);
 assert.equal(await client.evaluate(()=>globalThis.__multiTest.active),6);await shot('04-expanded-other-jobs-running');
 await overview();
 await assert.rejects(()=>page.evaluate(async()=>{const api=window.mkFigure.panes[4],b=await api.bootstrap();return api.saveSettings(b.settings);}),/所有.*任务完成/);
 await pane(0).getByRole('button',{name:'停止',exact:true}).click();
 await until(()=>client.evaluate(()=>globalThis.__multiTest.active===5),'only first cancelled');
 await until(()=>pane(0).getByRole('button',{name:'开始',exact:true}).count().then(n=>n===1),'first pane unblocked');
 assert.equal(await page.locator('.creation-card.is-running').count(),5);
 await client.evaluate(()=>globalThis.__multiTest.resolve.forEach(resolve=>resolve?.()));
 await until(()=>page.locator('.creation-card.is-running').count().then(n=>n===0),'all operations finish');
 for(let i=1;i<6;i++){const p=await page.evaluate(({i,id})=>window.mkFigure.panes[i].openProject(id),{i,id:projects[i].id});assert.equal(p.generated.length,1);assert.equal(p.styleMode,modes[i]);if(modes[i]==='custom')assert.equal(p.brief.stylePrompt,styles[i]);assert.equal(p.runs.at(-1).status,'completed');}
 const cancelled=await page.evaluate(id=>window.mkFigure.panes[0].openProject(id),projects[0].id);assert.equal(cancelled.runs.at(-1).status,'cancelled');assert.equal(cancelled.generated.length,0);
 await pane(0).getByRole('button',{name:'开始',exact:true}).click();
 await until(()=>client.evaluate(()=>globalThis.__multiTest.calls.length===7),'new task snapshots updated shared style');
 const nextCall=await client.evaluate(()=>globalThis.__multiTest.calls[6]);assert.ok(nextCall.prompt.includes('新一轮橙金风格'));assert.ok(!nextCall.prompt.includes('统一蓝灰细线'));
 await client.evaluate(()=>globalThis.__multiTest.resolve[6]());
 await until(()=>page.locator('.creation-card.is-running').count().then(n=>n===0),'rerun completes');

 await client.evaluate(({BrowserWindow},id)=>BrowserWindow.getAllWindows()[0].webContents.send('mk:progress',{paneId:2,event:{projectId:id,action:'generate',message:'Late completion',metrics:{status:'completed'}}}),projects[1].id);
 assert.equal(await page.locator('.creation-card.is-running').count(),0);
 await shot('05-completed-panels');
 // Changing a shared setting is visible across the mounted panes.
 await page.evaluate(async()=>{const b=await window.mkFigure.panes[2].bootstrap();b.settings.reasoningEffort='low';await window.mkFigure.panes[2].saveSettings(b.settings);});
 await pane(2).getByRole('button',{name:'展开子窗口 3',exact:true}).click();await pane(2).getByText(/Codex.*推理低/).waitFor();await overview();
 // Close-save failure must keep the sole desktop window and all pane drafts.
 const file=path.join(data,'projects',projects[4].id,'project.json'),held=file+'.held';await fs.rename(file,held);
 await client.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
 await page.getByRole('alert').filter({hasText:'关闭前保存失败'}).first().waitFor();assert.equal(page.isClosed(),false);await fs.rename(held,file);
 // Close with six fresh edits before the debounce deadline.
 await page.evaluate(()=>{document.querySelectorAll('.creation-inputs textarea').forEach((el,i)=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'关窗前草稿 '+(i+1));el.dispatchEvent(new Event('input',{bubbles:true}));});});
 const closed=client.waitForEvent('close',{timeout:20000});await client.evaluate(({app})=>{setTimeout(()=>app.quit(),0);});await closed;
 for(let i=0;i<6;i++){const p=JSON.parse(await fs.readFile(path.join(data,'projects',projects[i].id,'project.json'),'utf8'));assert.equal(p.brief.topic,'关窗前草稿 '+(i+1));}
 assert.deepEqual(errors,[]);
 const report={passed:true,draftsHiddenBeforeRun:true,sixDraftsPromotedOnce:true,desktopWindows:1,panels:6,maxConcurrent:6,singleNavigationKeepsCurrentProject:true,allProgressVisible:true,expandedKeepsOtherAppsMounted:true,stylesIsolated:true,sharedStyleSnapshot:true,customAndNoneOverrides:true,catalogRefreshPreservesRunningTasks:true,resultsIsolated:true,cancelOneKeepsFiveRunning:true,closeFlushesAllSix:true,closeFailurePreservesWindow:true,lateProgressIgnored:true,sharedSettingsBroadcast:true,pageErrors:errors,liveModelCalls:0,modelService:'local barrier stub, production workflow and IPC'};
 await fs.writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}catch(error){console.error(error);const page=(await client.windows())[0];if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw error;}
finally{await client.evaluate(({app})=>app.exit()).catch(()=>{});await client.close().catch(()=>{});}
