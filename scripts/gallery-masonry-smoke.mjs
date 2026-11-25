import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const output=path.resolve(process.env.MK_GALLERY_QA_OUT || path.join(root,'.runtime','gallery-masonry'));
await fs.mkdir(output,{recursive:true});
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'mk-masonry-'));
await fs.writeFile(path.join(profile,'settings.json'),JSON.stringify({settings:{providers:['codex','openai','deepseek','custom'].map(id=>({id,enabled:false}))},keys:{}}));
const env={...process.env,MK_FIGURE_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;delete env.MK_DEV_URL;
const app=await electron.launch({executablePath:process.env.MK_PACKAGED_EXE||electronPath,args:process.env.MK_PACKAGED_EXE?[]:[root],cwd:root,env});
try{
 const page=await app.firstWindow({timeout:30000});await page.locator('.workspace-folder-list').waitFor();
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,900));
 await page.getByRole('navigation',{name:'工作区导航'}).getByRole('button',{name:'论文图库',exact:true}).click();
 const gallery=page.locator('.paper-gallery:visible');
 await gallery.getByRole('button',{name:'期刊算例与方法图',exact:true}).click();
 await gallery.getByRole('group',{name:'期刊',exact:true}).getByRole('button',{name:'TPWRS',exact:true}).click();
 const cards=gallery.locator('.pg-card');
 if(await cards.count()<60)await cards.nth(59).waitFor();
 async function metrics(){
  return gallery.evaluate(el=>{
   const grid=el.querySelector('.pg-grid').getBoundingClientRect(),cols=new Map();
   const boxes=[...el.querySelectorAll('.pg-card')].map((card,index)=>{
    const b=card.getBoundingClientRect();const v={id:card.dataset.paperId,index,x:Math.round(b.left-grid.left),y:Math.round(b.top-grid.top),w:Math.round(b.width),h:Math.round(b.height)};
    if(!cols.has(v.x))cols.set(v.x,[]);cols.get(v.x).push(v);return v;
   });
   const gaps=[],tails=[];
   for(const [x,col]of cols){col.sort((a,b)=>a.y-b.y);for(let i=1;i<col.length;i++)gaps.push({gap:col[i].y-col[i-1].y-col[i-1].h,at:col[i].id,prev:col[i-1].id});tails.push(col.at(-1).y+col.at(-1).h);}
   gaps.sort((a,b)=>b.gap-a.gap);
   return {boxes,cols:cols.size,worst:gaps.slice(0,8),tailSpread:Math.max(...tails)-Math.min(...tails),native:CSS.supports('display','grid-lanes')};
  });
 }
 const initial=await metrics();
 for(let step=0;step<3;step++){const seen=await cards.count();const more=gallery.getByRole('button',{name:/^加载更多/});if(!await more.count())break;
  await cards.nth(seen-1).scrollIntoViewIfNeeded();
  if(await cards.count()===seen)await more.evaluate(b=>b.click());
  await cards.nth(seen).waitFor();}
 const deep=await metrics();
 // Seed just this filtered, loaded set. A byte copy keeps all writes inside the temporary profile.
 const seeded=new Map();
 if(process.env.MK_GALLERY_QA_CACHE){
   const source=await fs.realpath(process.env.MK_GALLERY_QA_CACHE);
   const dest=path.join(profile,'gallery-images');await fs.mkdir(dest,{recursive:true});
   const ids=new Set(deep.boxes.map(box=>box.id));
   const index=await page.evaluate(()=>window.mkFigure.listPaperFigures());
   for(const row of index){
     if(!ids.has(row.id)||row.venue!=='tpwrs')continue;
     const hash=row.supplement?.sha256,ext=path.extname(row.image);
     if(!/^[a-f0-9]{64}$/.test(hash)||!/^\.(?:jpg|jpeg|png|webp)$/i.test(ext))continue;
     const name=hash+ext,src=path.join(source,name);
     try{
       const stat=await fs.lstat(src);
       if(!stat.isFile()||stat.isSymbolicLink()||stat.size>32*1024*1024)continue;
       const bytes=await fs.readFile(src);
       if(createHash('sha256').update(bytes).digest('hex')!==hash)continue;
       try{await fs.writeFile(path.join(dest,name),bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;}
       seeded.set(row.id,hash);
     }catch(e){if(e.code!=='ENOENT')throw e;}
   }
   assert.ok(seeded.size,'supplied cache has no originals matching the displayed TPWRS batch');
 }
 const wanted=process.env.MK_GALLERY_QA_ANCHOR || 'mk-j-tpwrs-50cb645e0181b5-f1';
 const screenshotId=deep.boxes.some(r=>r.id===wanted)?wanted:deep.worst[0].at;
 const screenshotCard=gallery.locator('[data-paper-id="'+screenshotId+'"]');
 await screenshotCard.scrollIntoViewIfNeeded();
 await gallery.evaluate(async el=>{
   const visible=[...el.querySelectorAll('.pg-preview img')].filter(img=>{const r=img.getBoundingClientRect();return r.bottom>0 && r.top<innerHeight;});
   await Promise.all(visible.map(img=>img.decode().catch(()=>{})));
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 });
 await page.screenshot({path:path.join(output,'deep.png')});
 const refIndex=seeded.size&&!seeded.has(deep.boxes[82].id)?deep.boxes.findIndex(box=>seeded.has(box.id)):82;
 const anchor=cards.nth(refIndex),id=await anchor.getAttribute('data-paper-id');
 if(seeded.has(id)){
   const received=await app.evaluate(async({net},target)=>{
     const response=await net.fetch('mk-gallery://figure/'+encodeURIComponent(target));
     if(!response.ok)throw Error('Cached protocol image failed: '+response.status);
     const digest=await crypto.subtle.digest('SHA-256',await response.arrayBuffer());
     return Buffer.from(digest).toString('hex');
   },id);
   assert.equal(received,seeded.get(id),'protocol original differs from the verified isolated cache object');
 }
 await anchor.locator('.pg-title').click();
 const detail=gallery.locator('dialog[open]');
 const native=await detail.locator('.pg-stage img').evaluate(async img=>{await img.decode();const b=img.getBoundingClientRect();return {w:img.naturalWidth,h:img.naturalHeight,displayW:b.width,displayH:b.height};});
 if(process.env.MK_GALLERY_BASELINE!=='1'){
   assert.ok(native.displayW<=native.w+1 && native.displayH<=native.h+1);
   await detail.locator('.pg-stage button').click();
   const zoom=await detail.locator('.pg-stage img').boundingBox();
   assert.ok(Math.abs(zoom.width-native.w)<=1 && Math.abs(zoom.height-native.h)<=1,'zoom must use intrinsic pixels');
   await page.keyboard.press('Escape');
 }

 await detail.waitFor();await page.keyboard.press('Escape');await detail.waitFor({state:'hidden'});
 assert.equal(await cards.nth(refIndex).getAttribute('data-paper-id'),id);
 assert.equal(await gallery.getByRole('group',{name:'期刊',exact:true}).getByRole('button',{name:'TPWRS',exact:true}).getAttribute('aria-pressed'),'true');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(960,900));
 await page.waitForFunction(()=>innerWidth===960);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
 const narrow=await metrics();
 const moved=initial.boxes.filter((b,i)=>deep.boxes[i]?.id!==b.id||Math.abs(deep.boxes[i].y-b.y)>2);
 const report={screenshotId,detailId:id,cacheSeeded:seeded.size,native,initial:initial.boxes.length,deep:deep.boxes.length,moved:moved.length,wide:{columns:deep.cols,gaps:deep.worst,tailSpread:deep.tailSpread},narrow:{columns:narrow.cols,gaps:narrow.worst,tailSpread:narrow.tailSpread},nativeGridLanes:deep.native};
 await fs.writeFile(path.join(output,'measurements.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 if(process.env.MK_GALLERY_BASELINE!=='1'){
  assert.ok(deep.worst[0].gap<=16 && narrow.worst[0].gap<=16,'interior gap exceeded gutter');
  assert.equal(moved.length,0,'append moved previously visible cards');assert.ok(deep.cols>narrow.cols);
  for(let i=1;i<deep.boxes.length;i++)assert.ok(deep.boxes[i].y+1>=deep.boxes[i-1].y,'visual ordering diverged from catalogue');
 }
}finally{
 await app.close();
 if(path.dirname(profile)===os.tmpdir()&&path.basename(profile).startsWith('mk-masonry-')){
   await fs.rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:300});
 }
}
