// Isolated Electron render benchmark. No AI calls or production changes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import electronPath from 'electron';

const root=process.cwd(),software=process.argv.includes('--software'),out=path.join(root,'output/performance-2026-09-22/render',software?'software':'hardware-default');
await fs.mkdir(out,{recursive:true});
const complex=await fs.readFile(path.join(root,'output/pptx-fidelity/reference.svg'),'utf8');
const small='<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="white"/><rect x="40" y="100" width="180" height="100" rx="16" fill="#dbe8f4"/><path d="M220 150H400" stroke="#274c77" stroke-width="4"/><rect x="400" y="100" width="180" height="100" rx="16" fill="#f5dfce"/><text x="100" y="160" font-family="Times New Roman" font-size="24">Input</text><text x="445" y="160" font-family="Times New Roman" font-size="24">Output</text></svg>';
async function runElectron(config){
 const {app,BrowserWindow}=require('electron');
 const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
 const {performance}=require('node:perf_hooks');
 app.setPath('userData',path.join(config.out,'runtime'));
 if(config.software)app.disableHardwareAcceleration();
 let gpuUpdated=false;app.on('gpu-info-update',()=>gpuUpdated=true);
 app.on('window-all-closed',()=>{});
 await app.whenReady();
 const rows=[],outputs={},metrics=[],hash=b=>crypto.createHash('sha256').update(b).digest('hex');
 app.getAppMetrics();
 const make=(w,h)=>new BrowserWindow({show:false,width:Math.max(32,w),height:Math.max(32,h),useContentSize:true,frame:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
 const initialise=async(win,w,h)=>win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(`<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"></head><body style="margin:0;overflow:hidden;background:white"><img id="figure" style="width:${w}px;height:${h}px;display:block"></body></html>`));
 let fontsChecked=false;
 for(const item of config.cases){
  let warm;
  for(let iteration=0;iteration<5;iteration++){
   for(const mode of (iteration%2?['warm','fresh']:['fresh','warm'])){
    const begin=performance.now(),timing={},w=item.width,h=item.height;
    let mark=begin,win;
    const tick=name=>{const now=performance.now();timing[name]=now-mark;mark=now;};
    if(mode==='warm'&&warm)win=warm;else win=make(w,h);
    tick('createWindowMs');
    if(mode==='fresh'||!warm)await initialise(win,w,h);
    if(mode==='warm')warm=win;
    tick('navigateMs');
    const variant=item.alternating?iteration%2:0;
    const svg=variant?item.svg.replace('</svg>','<rect x="5" y="5" width="10" height="10" fill="#a56342"/></svg>'):item.svg;
    const uri='data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64');
    await win.webContents.executeJavaScript(`(()=>{const figure=document.getElementById('figure');figure.src=${JSON.stringify(uri)};return Promise.all([document.fonts.ready,figure.decode()]).then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));})()`);
    tick('decodeAndTwoFramesMs');
    if(!fontsChecked){await win.webContents.executeJavaScript(`(()=>{const c=document.createElement('canvas').getContext('2d');c.font='80px Times New Roman';return c.measureText('mmmmmmWWWiii0123456789').width;})()`);fontsChecked=true;}
    tick('fontProbeMs');
    const captured=await win.webContents.capturePage({x:0,y:0,width:w,height:h});tick('captureMs');
    const capturedSize=captured.getSize(),resized=captured.resize({width:w,height:h,quality:'best'});tick('resizeMs');
    const png=resized.toPNG();tick('encodeMs');
    if(mode==='fresh')win.destroy();tick('destroyMs');
    const elapsed=performance.now()-begin;
    // Compare potential conditional-resize optimisation outside measured section.
    const directSize=capturedSize.width===w&&capturedSize.height===h;
    const directMatches=directSize?hash(captured.toBitmap())===hash(resized.toBitmap()):null;
    const bitmapHash=hash(resized.toBitmap()),key=item.name+'-'+variant;
    if(!outputs[key]){outputs[key]=bitmapHash;await fs.writeFile(path.join(config.out,key+'.png'),png);}
    rows.push({name:item.name,variant,mode,iteration,elapsedMs:elapsed,timing,capturedSize,outputSize:resized.getSize(),samePixelsAsFirst:outputs[key]===bitmapHash,directMatches,bitmapHash,bytes:png.length});
   }
  }
  metrics.push({name:item.name,processes:app.getAppMetrics()});warm.destroy();
 }
 const gpuInfo=await app.getGPUInfo('complete');
 const report={createdAt:new Date().toISOString(),electron:process.versions.electron,gpuUpdated,hardwareAccelerationEnabled:app.isHardwareAccelerationEnabled(),featureStatus:app.getGPUFeatureStatus(),gpuInfo,metrics,rows};
 await fs.writeFile(path.join(config.out,'results.json'),JSON.stringify(report,null,2));
 app.quit();
}
const config={out,software,cases:[{name:'small',svg:small,width:640,height:400},{name:'complex-preview',svg:complex,width:1536,height:1024},{name:'complex-export',svg:complex,width:3072,height:2048},...(!software?[{name:'complex-alternating',svg:complex,width:1536,height:1024,alternating:true}]:[])]};
const entry=path.join(out,'runner.cjs');
await fs.writeFile(entry,`(${runElectron.toString()})(${JSON.stringify(config)}).catch(e=>{console.error(e);require('electron').app.exit(1)});`);
if(process.argv.includes('--prepare-only')){console.log('Prepared '+entry);process.exit(0);}
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(electronPath,[entry],{env,windowsHide:true,stdio:'inherit'});
child.on('exit',code=>process.exitCode=code??1);
