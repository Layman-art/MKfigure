// Isolated UI dispatch test. The model call is stubbed; live quality is tested separately.
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const root=process.cwd(),version=JSON.parse(await fs.readFile('package.json','utf8')).version;
const out=path.join(root,'output','playwright',`image-revision-${version}${process.env.MK_PACKAGED_EXE?'-packaged':''}`);
const data=path.join(root,'.runtime','image-revision-ui',new Date().toISOString().replace(/[:.]/g,'-'));
await fs.mkdir(out,{recursive:true});
const env={...process.env,MK_FIGURE_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
const client=await electron.launch({executablePath:process.env.MK_PACKAGED_EXE||electronPath,args:process.env.MK_PACKAGED_EXE?[]:[root],env,timeout:60000});
const errors=[],views=[];
try {
 const page=await client.firstWindow();page.on('pageerror',e=>errors.push(e.message));
 await client.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.webContents.setBackgroundThrottling(false);w.setContentSize(1440,900);w.show();w.focus();});
 await page.getByRole('button',{name:/^新建科研图/}).waitFor();
 await client.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},path.join(root,'resources/references/voltage-control.png'));
 const project=await page.evaluate(async()=>{const p=await window.mkFigure.createProject('视觉稿修改验证','full');const next=await window.mkFigure.importFiles(p.id,'target');next.stage='visual';next.brief.topic='神经 ODE 方法图';next.styleId='algorithm-flow';return window.mkFigure.saveProject(next);});
 await client.evaluate(({ipcMain},project)=>{
  globalThis.__revisionTest={calls:[],fail:false};
  ipcMain.removeHandler('mk:run');
  ipcMain.handle('mk:run',async(_event,id,action,feedback)=>{
   globalThis.__revisionTest.calls.push({id,action,feedback});
   if(globalThis.__revisionTest.fail)throw new Error('测试修改失败');
   return {...project,stage:'visual'};
  });
 },project);
 await page.reload();await page.getByRole('button',{name:'打开 视觉稿修改验证',exact:true}).click();
 const shot=async(name)=>{await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(out,name+'.png')});const metrics=await page.evaluate(()=>({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,panels:[...document.querySelectorAll('.form-panel,.image-revision,.image-revision-inputs')].map(e=>({width:e.clientWidth,scroll:e.scrollWidth}))}));assert.ok(metrics.scrollWidth<=metrics.width+1);assert.ok(metrics.panels.every(p=>p.scroll<=p.width+1));views.push({name,...metrics});};
 assert.equal(await page.getByRole('radio',{name:'修改当前图',exact:true}).isChecked(),true);
 await page.getByRole('textbox',{name:'修改提示词',exact:true}).fill('把标题改成 Neural ODE，其余不变');
 await shot('01-direct-image-edit');
 await page.getByRole('button',{name:'修改当前图',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.image-revision textarea')?.value==='');
 assert.equal((await client.evaluate(()=>globalThis.__revisionTest.calls)).at(-1).action,'edit-image');
 await page.getByRole('radio',{name:'不带原图重新生成',exact:true}).check();
 await page.getByRole('textbox',{name:'修改提示词',exact:true}).fill('画一张白底蓝色五模块方法图');
 await shot('02-prompt-only');
 await page.getByRole('button',{name:'按提示词重画',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.image-revision textarea')?.value==='');
 assert.equal((await client.evaluate(()=>globalThis.__revisionTest.calls)).at(-1).action,'regenerate-image');
 await page.getByRole('button',{name:'按改进意见',exact:true}).click();
 await page.getByRole('textbox',{name:'改进意见',exact:true}).fill('模块之间太挤，让公式更清晰');
 await shot('03-feedback');
 await page.getByRole('button',{name:'按意见改图',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('.image-revision textarea')?.value==='');
 const calls=await client.evaluate(()=>globalThis.__revisionTest.calls);
 assert.deepEqual(calls.map(c=>c.action),['edit-image','regenerate-image','refine-image']);
 assert.deepEqual(calls.map(c=>c.feedback),['把标题改成 Neural ODE，其余不变','画一张白底蓝色五模块方法图','模块之间太挤，让公式更清晰']);
 await client.evaluate(()=>{globalThis.__revisionTest.fail=true;});
 await page.getByRole('textbox',{name:'改进意见',exact:true}).fill('失败后仍保留这段意见');
 await page.getByRole('button',{name:'按意见改图',exact:true}).click();
 await page.getByRole('alert').filter({hasText:'测试修改失败'}).waitFor();
 assert.equal(await page.getByRole('textbox',{name:'改进意见',exact:true}).inputValue(),'失败后仍保留这段意见');
 await page.getByRole('button',{name:'关闭错误提示'}).click();
 await client.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(960,640));await shot('04-compact');
 await page.getByRole('button',{name:'使用当前图片复刻',exact:true}).click();
 await page.getByRole('button',{name:'开始复刻',exact:true}).waitFor();
 const current=await page.evaluate(id=>window.mkFigure.openProject(id),project.id);assert.equal(current.target.id,project.target.id);assert.equal(current.styleId,'algorithm-flow');
 // Seed two historical versions, then delay saving to verify the UI invalidates
 // the old editable scene immediately rather than waiting for disk roundtrip.
 const newAsset={...current.target,id:'version-test-2'};
 const scene={version:1,width:640,height:360,background:'#ffffff',title:'Version test',elements:[{id:'title',type:'text',x:20,y:20,w:400,h:60,text:'Previous editable scene',fontFamily:'Times New Roman',fontSize:25,color:'#112233'}]};
 await page.evaluate(({id,scene})=>window.mkFigure.renderScene(id,scene),{id:project.id,scene});
 const projectFile=path.join(data,'projects',project.id,'project.json');
 const savedProject=JSON.parse(await fs.readFile(projectFile,'utf8'));savedProject.generated=[current.target,newAsset];savedProject.stage='visual';await fs.writeFile(projectFile,JSON.stringify(savedProject));
 await page.reload();await page.getByRole('button',{name:'打开 视觉稿修改验证',exact:true}).click();
 await page.getByRole('button',{name:'可编辑图',exact:true}).click();
 await page.getByRole('img',{name:'可编辑科研图预览'}).waitFor();
 await client.evaluate(({ipcMain})=>{ipcMain.removeHandler('mk:saveProject');ipcMain.handle('mk:saveProject',async()=>{await new Promise(resolve=>setTimeout(resolve,2000));throw new Error('测试保存延迟');});});
 await page.locator('.generated-history button').filter({hasText:'版本 2'}).click();
 assert.equal(await page.getByRole('button',{name:'可编辑图',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:/检查与精修/}).first().click();
 await page.getByText('尚无可编辑图形',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);
 const report={passed:true,modelStubbed:true,liveModelCalls:0,dispatchModes:calls.map(c=>c.action),rawInstructionsPreserved:true,failurePreservesDraft:true,existingReferenceUnchanged:true,oldSceneInvalidatedBeforeSave:true,views,pageErrors:errors};
 await fs.writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await client.close();}
