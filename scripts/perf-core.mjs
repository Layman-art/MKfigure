// Local-only benchmark. No model requests; production source is bundled unchanged.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const root=process.cwd(), out=path.join(root,'output/performance-2026-09-22/core');
await fs.mkdir(out,{recursive:true});
const coreFile=path.join(out,'core.cjs');
await build({stdin:{contents:`export {validateScene} from './src/core/schema';export {auditScene} from './src/core/audit';export {sceneToSvg} from './src/core/svg';export {exportPptx} from './src/core/pptx';export {normalizeSceneInput} from './src/main/normalize';`,resolveDir:root},bundle:true,platform:'node',format:'cjs',outfile:coreFile,packages:'external'});
const core=createRequire(import.meta.url)(coreFile);
const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function sample(fn){
  let maximumTimerDelayMs=0, last=performance.now();
  const timer=setInterval(()=>{const now=performance.now();maximumTimerDelayMs=Math.max(maximumTimerDelayMs,now-last-1);last=now;},1);
  await pause(10);
  maximumTimerDelayMs=0;last=performance.now();
  const cpu=process.cpuUsage(),start=performance.now();
  await fn();
  const wallMs=performance.now()-start, used=process.cpuUsage(cpu);
  await pause(5);clearInterval(timer);
  return {wallMs,cpuMs:(used.user+used.system)/1000,maximumTimerDelayMs};
}
async function measured(fn){await fn();const samples=[];for(let i=0;i<5;i++)samples.push(await sample(fn));return {medianWallMs:median(samples.map(s=>s.wallMs)),medianCpuMs:median(samples.map(s=>s.cpuMs)),maxTimerDelayMs:Math.max(...samples.map(s=>s.maximumTimerDelayMs)),samples};}
const inputs=[['real-low-78','output/low-reasoning-2026-09-19/05-scene.json'],['real-complex-468','output/pptx-fidelity/scene.json']];
const scenes=[];
for(const [name,file] of inputs){const raw=await fs.readFile(path.join(root,file),'utf8');scenes.push({name,source:file,bytes:Buffer.byteLength(raw),scene:JSON.parse(raw)});}
// Production schema caps a scene at 1500 elements: do not bypass it to advertise 5000-element support.
const base=scenes[1].scene;
const synthetic={...base,title:'SYNTHETIC: repeated real components, 1500 elements',elements:Array.from({length:1500},(_,i)=>{const e=structuredClone(base.elements[i%base.elements.length]);e.id=`stress-${i}`;delete e.groupId;return e;})};
scenes.push({name:'synthetic-1500',source:'468-element scene repeated; groups removed; intentional overlaps',bytes:Buffer.byteLength(JSON.stringify(synthetic)),scene:synthetic});
const report={date:new Date().toISOString(),environment:{node:process.version,os:os.release(),platform:process.platform,cpu:os.cpus()[0].model,logicalCpus:os.cpus().length,availableParallelism:os.availableParallelism(),totalMemoryGiB:os.totalmem()/2**30},method:'5 measured samples after one warm-up per stage. Node process CPU includes all its threads. Timer delay uses a 1 ms interval and includes event-loop scheduling noise; not renderer FPS. Stage timings include nested validation; do not add them as exclusive costs. PPT export includes local filesystem write. No remote calls.',scenes:[],workers:{}};
for(const input of scenes){
  const {name,scene,...meta}=input;core.validateScene(scene);
  const result={name,...meta,elements:scene.elements.length,text:scene.elements.filter(e=>e.type==='text').length,stages:{}};
  for(const method of ['normalizeSceneInput','validateScene','auditScene','sceneToSvg','exportPptx']){
    result.stages[method]=await measured(()=>core[method](scene,path.join(out,`${name}.pptx`)));
    console.log(name,method,JSON.stringify(result.stages[method]));
  }
  report.scenes.push(result);
}
const workerFile=path.join(out,'worker.cjs');
await fs.writeFile(workerFile,`const {parentPort}=require('node:worker_threads');const core=require('./core.cjs');parentPort.on('message',async({scene,destination})=>{try{await core.exportPptx(scene,destination);parentPort.postMessage({ok:true});}catch(e){parentPort.postMessage({error:String(e)});}});parentPort.postMessage({ready:true});`);
function once(worker){return new Promise((resolve,reject)=>{const error=e=>{worker.off('message',message);reject(e);};const message=msg=>{worker.off('error',error);msg.error?reject(new Error(msg.error)):resolve(msg);};worker.once('message',message);worker.once('error',error);});}
const start=performance.now();const workers=[new Worker(workerFile),new Worker(workerFile)];await Promise.all(workers.map(once));report.workers.startupWallMs=performance.now()-start;
const job=(worker,scene,destination)=>{const done=once(worker);worker.postMessage({scene,destination});return done;};
try{
  for(const input of scenes.slice(1)){
    const scene=input.scene;
    const sequential=await measured(async()=>{for(let i=0;i<4;i++)await core.exportPptx(scene,path.join(out,`${input.name}-seq-${i}.pptx`));});
    const pool=await measured(async()=>{await Promise.all(workers.map(async(worker,index)=>{for(let i=index;i<4;i+=2)await job(worker,scene,path.join(out,`${input.name}-pool-${i}.pptx`));}));});
    report.workers[input.name]={jobs:4,workerCount:2,sequential,pool,speedup:sequential.medianWallMs/pool.medianWallMs};
    console.log('workers',input.name,JSON.stringify(report.workers[input.name]));
  }
}finally{await Promise.all(workers.map(w=>w.terminate()));}
await fs.writeFile(path.join(out,'results.json'),JSON.stringify(report,null,2));
