import { seedTestScene } from './test-scene.mjs';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

const tag=process.argv[2]||'after';
const root=process.cwd(),out=path.join(root,'output','design-refresh',tag);
await fs.mkdir(out,{recursive:true});
const env={...process.env,MK_FIGURE_DATA_DIR:path.join(root,'.runtime',`design-${tag}`)};delete env.ELECTRON_RUN_AS_NODE;
const scale=process.env.MK_TEST_SCALE;
const args=[...(scale?[`--force-device-scale-factor=${scale}`]:[]),...(process.env.MK_PACKAGED_EXE?[]:[root])];
const client=await electron.launch({executablePath:process.env.MK_PACKAGED_EXE||electronPath,args,env,timeout:60000});
const records=[];
try{
 const page=await client.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await client.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];win.webContents.setBackgroundThrottling(false);win.restore();win.show();win.focus();});
 await page.getByRole('button',{name:/^新建科研图/}).waitFor({timeout:60000});
 const size=async(w,h)=>{await client.evaluate(({BrowserWindow},s)=>BrowserWindow.getAllWindows().find(w=>w.isVisible()).setContentSize(s.w,s.h),{w,h});await page.evaluate(()=>document.fonts.ready);};
 const shot=async(name)=>{await page.screenshot({path:path.join(out,name+'.png')});records.push({name,...await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,devicePixelRatio,bodyFont:getComputedStyle(document.body).fontSize,bodyFamily:getComputedStyle(document.body).fontFamily,panels:[...document.querySelectorAll('.sidebar,.work-columns,.form-panel,.preview-panel,.dialog')].map(e=>({class:e.className,width:e.clientWidth,scrollWidth:e.scrollWidth})),image:(()=>{const i=document.querySelector('.preview-canvas > img'),c=document.querySelector('.preview-canvas');if(!i||!c)return null;const b=i.getBoundingClientRect(),a=c.getBoundingClientRect();return {loaded:i.complete&&i.naturalWidth>0,contained:b.left>=a.left&&b.right<=a.right&&b.top>=a.top&&b.bottom<=a.bottom,fit:getComputedStyle(i).objectFit};})()}))});};
 await size(1440,900);await shot('01-welcome');
 await seedTestScene(page);
 await page.getByRole('img',{name:'可编辑科研图预览'}).waitFor({timeout:60000});await page.evaluate(()=>document.fonts.ready);await shot('04-review');
 await page.getByRole('button',{name:/描述想法/}).first().click();await page.getByText('主题与重点',{exact:true}).waitFor();await shot('02-brief');
 await page.getByRole('button',{name:/可编辑复刻/}).first().click();await shot('03-reconstruct');
 await page.getByRole('button',{name:/导出作品/}).first().click();await shot('05-export');
 await page.getByRole('button',{name:/模型与连接/}).first().click();await page.getByText('文本 / 视觉模型',{exact:true}).waitFor();await page.getByRole('button',{name:'保存设置',exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('.dialog-footer button:last-child')?.disabled);await shot('06-settings');
 if(tag!=='before'){
  await size(1040,720);await shot('07-settings-compact');
  await page.locator('.settings-dialog').evaluate(e=>e.scrollTop=e.scrollHeight);await shot('10-settings-bottom');
  await page.getByRole('button',{name:'保存设置',exact:true}).click({trial:true});
  await page.locator('.settings-dialog').evaluate(e=>e.scrollTop=0);
  await page.getByText('高级设置',{exact:true}).click();await shot('11-advanced-settings');
  await page.getByRole('button',{name:'关闭',exact:true}).last().click();
  await page.getByRole('button',{name:/描述想法/}).first().click();await shot('08-workspace-compact');
  await size(960,640);await shot('12-workspace-minimum');
  await size(1280,800);await page.getByRole('button',{name:/检查与精修/}).first().click();await shot('09-review-laptop');
  await page.getByRole('button',{name:'编辑图中文字',exact:true}).click();await shot('13-text-editor');await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('button',{name:'放大预览',exact:true}).click();await shot('14-expanded-preview');
 }
 const project=await page.evaluate(async()=>{const b=await window.mkFigure.bootstrap();return window.mkFigure.openProject(b.projects[0].id);});
 const png=Buffer.from(project.previewPng.split(',')[1],'base64');
 const preview={width:png.readUInt32BE(16),height:png.readUInt32BE(20),sceneWidth:project.scene.width,sceneHeight:project.scene.height};
 await fs.writeFile(path.join(out,'metrics.json'),JSON.stringify({records,preview,pageErrors:errors},null,2));
 assert.equal(preview.width,preview.sceneWidth);assert.equal(preview.height,preview.sceneHeight);assert.deepEqual(errors,[]);
 if(tag!=='before'){
  assert.ok(records.every(r=>r.scrollWidth<=r.width+1),'Horizontal page overflow');
  assert.ok(records.every(r=>r.panels.every(p=>p.scrollWidth<=p.width+1)),'Panel horizontal overflow');
  assert.ok(records.every(r=>!r.image||(r.image.loaded&&r.image.contained&&r.image.fit==='contain')),'Preview clipped or unloaded');
 }
 console.log(JSON.stringify({tag,views:records.length,pageErrors:errors,overflow:records.filter(r=>r.scrollWidth>r.width+1)}));
}finally{await client.close();}
