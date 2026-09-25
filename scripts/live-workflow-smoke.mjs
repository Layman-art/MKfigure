// Explicit opt-in: exercises the user's authenticated Codex quota.
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
if(process.env.MK_LIVE_E2E!=='1')throw new Error('Set MK_LIVE_E2E=1 to authorize the live model test');
const root=process.cwd(),out=path.join(root,'output','live-workflow');await fs.mkdir(out,{recursive:true});
const env={...process.env,MK_FIGURE_DATA_DIR:path.join(root,'.runtime','live-workflow')};delete env.ELECTRON_RUN_AS_NODE;
const client=await electron.launch({executablePath:electronPath,args:[root],env,timeout:60000});
try{
 const page=await client.firstWindow();await page.getByRole('button',{name:/^新建科研图/}).waitFor({timeout:60000});
 await page.evaluate(()=>window.mkFigure.onProgress(e=>console.log('MKPROGRESS '+e.message)));
 page.on('console',msg=>{if(msg.text().startsWith('MKPROGRESS'))console.log(msg.text());});
 const status=await page.evaluate(()=>window.mkFigure.providerStatus('codex'));assert.ok(status.authenticated);
 const models=await page.evaluate(()=>window.mkFigure.listModels('codex'));assert.ok(models.length);
 const selected=models.find(m=>m.id==='gpt-5.5')?.id||models[0].id;
 await page.evaluate(async model=>{const b=await window.mkFigure.bootstrap();b.settings.providers.find(p=>p.id==='codex').model=model;b.settings.reasoningEffort='low';await window.mkFigure.saveSettings(b.settings);},selected);
 let project;
 if(process.env.MK_RESUME==='1')project=await page.evaluate(async()=>{const b=await window.mkFigure.bootstrap();const p=b.projects.find(p=>p.name==='Live Neural ODE test');if(!p)throw new Error('No project to resume');return window.mkFigure.openProject(p.id);});
 else project=await page.evaluate(async()=>{let p=await window.mkFigure.createProject('Live Neural ODE test','full');p.brief.topic='Neural ODE: initial state, numerical ODE solver, final state';p.brief.focus='A compact schematic with exactly three labelled modules connected left-to-right. Use English labels: Initial state, ODE solver, Final state. Under the solver include a small neural network labelled Learned derivative. No performance numbers.';p.brief.language='en';p.brief.aspectRatio='2:1';p.styleId='pastel-method';return window.mkFigure.saveProject(p);});
 console.log('Live model: '+selected);
 if(process.env.MK_RESUME!=='1'){
  project=await page.evaluate(id=>window.mkFigure.run(id,'prompt'),project.id);assert.ok(project.brief.prompt.length>50);console.log('Prompt stage passed');
  project=await page.evaluate(id=>window.mkFigure.run(id,'generate'),project.id);assert.ok(project.target?.previewUrl);console.log('Image stage passed');
 }
 project=await page.evaluate(id=>window.mkFigure.run(id,'reconstruct'),project.id);assert.ok(project.scene?.elements.length>10);console.log('Reconstruction stage passed');
 project=await page.evaluate(id=>window.mkFigure.run(id,'review'),project.id);assert.ok(project.qa);console.log('Review stage passed');
 await client.evaluate(({dialog},dir)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[dir]});},out);
 const exported=await page.evaluate(id=>window.mkFigure.exportProject(id,['pptx','svg','png']),project.id);assert.ok(exported.files.length>=3);
 // Reopen through the visible project selector to verify the real renderer.
 await page.reload();await page.getByRole('button',{name:/^新建科研图/}).waitFor();
 const names=await page.locator('button').allTextContents();const projectButton=page.getByRole('button',{name:/Live Neural ODE test/}).first();
 if(await projectButton.count())await projectButton.click();
 await page.screenshot({path:path.join(out,'app-result.png')});
 const result={passed:true,model:selected,projectId:project.id,resumedAfterGeometryFix:process.env.MK_RESUME==='1',stages:['prompt','generate','reconstruct','review','export'],elements:project.scene.elements.length,qa:project.qa,files:exported.files,imageModelVerified:false};
 await fs.writeFile(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){console.error(error);const pages=await client.windows();if(pages[0])await pages[0].screenshot({path:path.join(out,'failure.png')}).catch(()=>{});process.exitCode=1;}
finally{await client.close();}
