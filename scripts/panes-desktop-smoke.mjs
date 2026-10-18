import {_electron as electron} from 'playwright';
import electronPath from 'electron';
import {spawn} from 'node:child_process';
import {build} from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=process.cwd(),version=JSON.parse(await fs.readFile('package.json','utf8')).version;
const out=path.join(root,'output','panes',version,process.env.MK_PACKAGED_EXE?'packaged':'desktop');await fs.mkdir(out,{recursive:true});
const data=path.join(root,'.runtime','panes-desktop',Date.now().toString());const env={...process.env,MK_FIGURE_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
const exe=process.env.MK_PACKAGED_EXE||electronPath,args=process.env.MK_PACKAGED_EXE?[]:[root];
const client=await electron.launch({executablePath:exe,args,cwd:root,env,timeout:60000});const errors=[],projects=[];
try{
 const page=await client.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 await page.getByRole('button',{name:'新建科研图',exact:true}).first().waitFor();assert.equal(await page.locator('.creation-card').count(),5);assert.equal((await client.windows()).length,1);
 await client.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.webContents.setBackgroundThrottling(false);w.setContentSize(1440,900);w.show();w.focus();});
 const pane=i=>page.locator('.pane-host').nth(i);
 const overview=()=>page.locator('.workspace-shell-header').getByRole('button',{name:'返回五窗总览',exact:true}).click();
 const shot=async(name)=>{await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(out,name+'.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));};
 await shot('01-overview');
 const files=['references/pastel-method.png','references/algorithm-flow.png','references/voltage-control.png','library/thumbs/icon-city-communication-tower.png','library/thumbs/icon-city-mobile-storage.png'];
 const styles=['浅蓝简约','暖橙学术','青绿信息图','黑白线稿','紫色模块'];
 for(let i=0;i<5;i++){
  await client.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},path.join(root,'resources',files[i]));
  await pane(i).getByRole('button',{name:'上传图片',exact:true}).click();await pane(i).locator('.creation-preview img').waitFor();
  await pane(i).getByRole('textbox',{name:'主题与内容',exact:true}).fill(`科研图 ${i+1}`);
  await pane(i).getByRole('textbox',{name:'风格要求',exact:true}).fill(styles[i]);
  await pane(i).getByRole('button',{name:`展开子窗口 ${i+1}`,exact:true}).click();
  await pane(i).getByRole('button',{name:/生成视觉稿/}).first().click(); // Flush via a save-triggering stage change.
  await pane(i).getByRole('button',{name:'返回首页',exact:true}).click();
  await pane(i).getByRole('button',{name:'新建科研图',exact:false}).first().waitFor();
  const b=await page.evaluate(i=>window.mkFigure.panes[i].bootstrap(),i);const p=await page.evaluate(({i,id})=>window.mkFigure.panes[i].openProject(id),{i,id:b.projects[0].id});projects.push(p);
  // Reopen through the UI to keep the scoped renderer and project lease aligned.
  await pane(i).getByRole('button',{name:`打开 ${p.name}`,exact:true}).first().click();
  await overview();assert.equal(await pane(i).getByRole('textbox',{name:'风格要求',exact:true}).inputValue(),styles[i]);
 }
 await shot('02-five-images');
 const layout=await page.locator('.creation-card').evaluateAll(cards=>cards.map(el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};}));
 assert.ok(layout.every(r=>r.bottom<=900),'All five cards should fit at 1440x900');
 const second=spawn(exe,args,{cwd:root,env,stdio:'ignore',windowsHide:true});
 const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{second.kill();reject(new Error('Duplicate instance did not exit'));},15000);second.on('error',reject);second.on('exit',code=>{clearTimeout(timer);resolve(code);});});assert.equal(code,0);assert.equal((await client.windows()).length,1);
 await pane(2).getByRole('button',{name:'展开子窗口 3',exact:true}).click();assert.equal(await page.locator('.pane-host').count(),5);assert.equal(await page.locator('.pane-host:visible').count(),1);await shot('03-expanded');await overview();
 await client.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(960,640));await shot('04-compact-overview');
 assert.equal(await page.locator('.workspace-task').count(),5);
 const fixture=await build({entryPoints:['tests/fixtures/example-scene.ts'],bundle:true,write:false,platform:'node',format:'esm'});const {EXAMPLE_SCENE}=await import('data:text/javascript;base64,'+Buffer.from(fixture.outputFiles[0].text).toString('base64'));
 await page.evaluate(({id,scene})=>window.mkFigure.panes[0].renderScene(id,scene),{id:projects[0].id,scene:EXAMPLE_SCENE});
 await client.evaluate(({dialog},directory)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[directory]});},out);
 const exported=await page.evaluate(id=>window.mkFigure.panes[0].exportProject(id,['pptx','svg','png']),projects[0].id);assert.deepEqual(exported.files.map(f=>path.extname(f)).sort(),['.png','.pptx','.svg']);
 const onlyPpt=await page.evaluate(id=>window.mkFigure.panes[0].exportProject(id,['pptx']),projects[0].id);assert.equal(onlyPpt.files.length,1);assert.ok(onlyPpt.files[0].endsWith('.pptx'));
 assert.deepEqual(errors,[]);await client.close();
 for(let i=0;i<5;i++){const p=JSON.parse(await fs.readFile(path.join(data,'projects',projects[i].id,'project.json'),'utf8'));assert.equal(p.brief.stylePrompt,styles[i]);}
 const result={passed:true,productionApp:true,packaged:!!process.env.MK_PACKAGED_EXE,desktopWindows:1,panels:5,stylesPersist:true,allCardsFit1440x900:true,expandedRetainsOtherPanes:true,duplicateInstanceExited:true,threeFormatsExported:true,pptOnlyOneFile:true,pageErrors:errors,liveModelCalls:0};await fs.writeFile(path.join(out,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){console.error(error);const page=(await client.windows())[0];if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});throw error;}
finally{await client.close().catch(()=>{});}
