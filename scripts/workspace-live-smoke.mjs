// Run only with explicit authorization to exercise the authenticated account.
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
if (process.env.MK_LIVE_E2E !== '1') throw new Error('Set MK_LIVE_E2E=1 for the real model test');
const root = process.cwd(), version = JSON.parse(await fs.readFile('package.json','utf8')).version;
const out = path.join(root,'output','workspace',version,'live');
const data = path.join(root,'.runtime','workspace-live',version);
const folder = path.join(out,'Neural ODE Research');
await fs.mkdir(folder,{recursive:true});
const env = {...process.env,MK_FIGURE_DATA_DIR:data}; delete env.ELECTRON_RUN_AS_NODE;
const client = await electron.launch({executablePath:electronPath,args:[root],cwd:root,env,timeout:60000});
const errors = [], result = {passed:false,model:'',reasoningEffort:'low',stages:[],timings:{}};
try {
  const page = await client.firstWindow(); page.setDefaultTimeout(30000);
  page.on('pageerror',e=>errors.push(e.message));
  await page.locator('.studio-home').waitFor();
  await client.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];win.setContentSize(1440,900);win.webContents.setBackgroundThrottling(false);});
  let lastMessage='';
  page.on('console',msg=>{const text=msg.text();if(text.startsWith('LIVE ')&&text!==lastMessage){lastMessage=text;console.log(text);}});
  await page.evaluate(()=>window.mkFigure.onProgress(e=>console.log('LIVE '+e.action+': '+e.message)));
  const catalog=await page.evaluate(()=>window.mkFigure.getModelCatalog(true));
  assert.ok(catalog.models.some(m=>m.id==='gpt-6.1-sol'));
  const status=await page.evaluate(()=>window.mkFigure.providerStatus('codex'));assert.ok(status.authenticated);
  result.model='gpt-6.1-sol';result.runtime=status.runtimeVersion;result.modelCount=catalog.models.length;
  await page.evaluate(async()=>{const b=await window.mkFigure.bootstrap();b.settings.providers.find(p=>p.id==='codex').model='gpt-6.1-sol';b.settings.reasoningEffort='low';await window.mkFigure.saveSettings(b.settings);});
  await client.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},folder);
  await page.getByRole('button',{name:'打开文件夹',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.active-folder strong')?.textContent==='Neural ODE Research');
  let project;
  if(process.env.MK_RESUME==='1') {
    project=await page.evaluate(async()=>{const {folder}=await window.mkFigure.getFolder();if(!folder.projects[0])throw new Error('No live project to resume');return window.mkFigure.openProject(folder.projects[0].id);});
  } else {
    const suggestion=await page.evaluate(()=>window.mkFigure.optimizeStyle('白底，低饱和蓝色、青绿色、橙色。简洁、二维学术示意图。','精简为可直接使用的风格描述，最多100字。'));
    assert.ok(suggestion.text.length>10);result.styleSuggestion={text:suggestion.text,durationMs:suggestion.durationMs,usage:suggestion.usage};
    await page.evaluate(async text=>{await window.mkFigure.saveSharedStyle({prompt:text,palette:'muted blue, teal and orange',background:'plain white',lines:'thin consistent outlines; flat vector illustrations'});},suggestion.text);
    project=await page.evaluate(async()=>{
      let p=await window.mkFigure.createProject('Neural ODE · Low reasoning validation','full');
      p.brief.topic='Neural ODE: a compact scientific method diagram with exactly three modules, Initial state, ODE solver, Final state, connected left to right.';
      p.brief.focus='Under ODE solver, show a small neural network icon labelled Learned derivative and the equation dz/dt = f_theta(z,t). English only. No title paragraph, performance data or fabricated experiments. Use 2:1 landscape composition with generous whitespace and readable labels.';
      p.brief.language='en';p.brief.aspectRatio='2:1';p.styleMode='shared';
      return window.mkFigure.saveProject(p);
    });
  }
  result.projectId=project.id;
  const stage=async action=>{const started=Date.now();project=await page.evaluate(({id,action})=>window.mkFigure.run(id,action),{id:project.id,action});result.stages.push(action);result.timings[action]=Date.now()-started;await fs.writeFile(path.join(out,'checkpoint.json'),JSON.stringify({...result,runs:project.runs},null,2));console.log('STAGE '+action+' '+result.timings[action]+'ms');};
  // A plain brief + chosen style generates directly, without an AI prompt-writing step.
  if(!project.target)await stage('generate');
  assert.ok(project.target?.previewUrl);
  if(!project.scene)await stage('reconstruct');
  assert.ok(project.scene.elements.length>10);
  await stage('review');assert.ok(project.qa);
  const exports=path.join(out,'exports');await fs.mkdir(exports,{recursive:true});
  await client.evaluate(({dialog},dir)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[dir]});},exports);
  const exported=await page.evaluate(id=>window.mkFigure.exportProject(id,['pptx','svg','png']),project.id);
  assert.deepEqual(exported.files.map(f=>path.extname(f)).sort(),['.png','.pptx','.svg']);
  const pptOnly=path.join(out,'ppt-only');await fs.mkdir(pptOnly,{recursive:true});
  await client.evaluate(({dialog},dir)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[dir]});},pptOnly);
  const ppt=await page.evaluate(id=>window.mkFigure.exportProject(id,['pptx']),project.id);
  assert.equal(ppt.files.length,1);assert.equal((await fs.readdir(pptOnly)).length,1);
  const zip=await JSZip.loadAsync(await fs.readFile(ppt.files[0]));
  const slide=await zip.file('ppt/slides/slide1.xml').async('string');
  assert.ok((slide.match(/<p:sp>/g)||[]).length>10);assert.ok(!slide.includes('m:oMath'));
  result.nativePptObjects=(slide.match(/<p:sp>/g)||[]).length;
  await page.reload();await page.locator('.studio-home').waitFor();
  await page.locator('.folder-project-row > button').filter({hasText:'Neural ODE · Low reasoning validation'}).first().click();
  await page.getByRole('textbox',{name:'项目名称',exact:true}).waitFor();
  await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(out,'08-live-result.png')});
  assert.deepEqual(errors,[]);
  const saved=JSON.parse(await fs.readFile(path.join(folder,'.mkfigure','projects',project.id,'project.json'),'utf8'));
  assert.equal(saved.styleMode,'shared');assert.ok(saved.runs.some(run=>run.styleSnapshot?.mode==='shared'));
  result.stages.push('export','reopen');Object.assign(result,{passed:true,qa:project.qa,files:exported.files,pptOnlyFiles:ppt.files,runs:saved.runs,pageErrors:errors,imageModelVerified:false});
  console.log(JSON.stringify({passed:true,model:result.model,timings:result.timings,objects:result.nativePptObjects,visualReview:project.qa.visualReview}));
} catch(error) {
  result.error=String(error);console.error(error);process.exitCode=1;
  const page=(await client.windows())[0];if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});
} finally {
  await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));await client.close().catch(()=>{});
}
