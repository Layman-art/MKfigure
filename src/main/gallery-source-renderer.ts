import { app, BrowserWindow, session, type Session } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sourceBrowserScript } from './gallery-source-browser';
import { downloadGallerySource } from './gallery-source-proxy';
import { validatePublicSource, waitWithSignal } from './gallery-source-download';

export interface PublicFigureSource { pdfUrl:string; page:number; cropPdfPoints:readonly number[]; pdfSha256?:string }
const origin='https://mkfigure-gallery-source.invalid';
const payloads=new Map<string,Buffer>();
let privateSession:Session|undefined;
let cached:{url:string;bytes:Buffer;sha:string;expires:number}|undefined;
let expiry:ReturnType<typeof setTimeout>|undefined;
function combinedSignal(signal?:AbortSignal) {
  const timeout=AbortSignal.timeout(75_000);
  return signal ? AbortSignal.any([timeout,signal]) : timeout;
}
export function validateFigureCrop(source:PublicFigureSource) {
  validatePublicSource(source.pdfUrl,'pdf');
  const r=source.cropPdfPoints;
  if(!Number.isInteger(source.page)||source.page<1||source.page>5000||!Array.isArray(r)||r.length!==4||
     !r.every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=90000)||r[2]<=r[0]||r[3]<=r[1]||
     (source.pdfSha256!==undefined&&!/^[a-f\d]{64}$/i.test(source.pdfSha256))) throw new Error('无效的论文页码、裁框或 PDF 校验值。');
}
export function publicImageMime(bytes:Buffer) {
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  const head=bytes.subarray(0,1024).toString('utf8');
  if(/^GIF8[79]a/.test(head))return 'image/gif';
  if(head.startsWith('RIFF')&&head.slice(8,12)==='WEBP')return 'image/webp';
  if(/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(head))return 'image/svg+xml';
  throw new Error('图源未返回可识别的图像。');
}
const headers={'content-security-policy':"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; img-src blob: data: 'self'; font-src blob: data: 'self'; style-src 'unsafe-inline'; frame-src 'none'; base-uri 'none'",'x-content-type-options':'nosniff','cache-control':'no-store'};
function getSession() {
  if(privateSession)return privateSession;
  const ses=session.fromPartition('mkfigure-gallery-source',{cache:false});
  const assets=dirname(require.resolve('pdfjs-dist/package.json'));
  ses.setPermissionRequestHandler((_wc,_perm,cb)=>cb(false));
  ses.setPermissionCheckHandler(()=>false);
  ses.webRequest.onBeforeRequest((details,cb)=>{
    const u=new URL(details.url);cb({cancel:u.origin!==origin && u.protocol!=='data:'});
  });
  ses.protocol.handle('https',async req=>{
    const u=new URL(req.url);if(u.origin!==origin||req.method!=='GET') return new Response(null,{status:403});
    let content:string|Uint8Array|undefined,mime:string;
    if(u.pathname==='/'){content='<!DOCTYPE html><meta charset="UTF-8"><script type="module" src="/render.mjs"></script>';mime='text/html';}
    else if(u.pathname==='/render.mjs'){content=sourceBrowserScript;mime='text/javascript';}
    else if(/^\/payload\/[a-f\d-]{36}$/.test(u.pathname)) {
      const bytes=payloads.get(u.pathname.slice(9));if(bytes)content=new Uint8Array(bytes);mime='application/octet-stream';
    } else if(/^\/assets\/(?:build\/pdf(?:\.worker|\.renderer)?\.min\.mjs|(?:cmaps|standard_fonts|wasm|iccs)\/[\w.-]+)$/.test(u.pathname)){
      const file=u.pathname.slice(8);
      try{content=new Uint8Array(await readFile(join(assets,file)));}catch{return new Response(null,{status:404});}
      mime=/\.(?:mjs|js)$/.test(file)?'text/javascript':file.endsWith('.wasm')?'application/wasm':'application/octet-stream';
    } else return new Response(null,{status:404});
    return content===undefined?new Response(null,{status:404}):new Response(content as BodyInit,{headers:{...headers,'content-type':mime}});
  });
  privateSession=ses;return ses;
}
type Job={kind:'pdf';page:number;crop:readonly number[]}|{kind:'image';mime:string}
  |{kind:'panels';panels:{length:number;mime:string;label:string}[]};
export async function renderSourceBytes(bytes:Buffer,job:Job,signal:AbortSignal) {
  await waitWithSignal(app.whenReady(),signal);
  const token=randomUUID();
  const win=new BrowserWindow({show:false,width:96,height:96,webPreferences:{session:getSession(),sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,backgroundThrottling:false}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  win.webContents.on('will-navigate',e=>e.preventDefault());
  payloads.set(token,bytes);
  try {
    await waitWithSignal(win.loadURL(origin+'/'),signal);
    const result:unknown=await waitWithSignal(win.webContents.executeJavaScript('globalThis.renderGallerySource('+JSON.stringify({...job,token})+')'),signal);
    if(typeof result!=='string'||result.length>16e6)throw new Error('图源渲染返回的数据无效。');
    const output=Buffer.from(result,'base64');
    const mime=publicImageMime(output);
    const intact=mime==='image/jpeg' ? output.at(-2)===255 && output.at(-1)===217 :
      mime==='image/png' && output.subarray(-8,-4).toString('ascii')==='IEND';
    if(!intact)throw new Error('图源渲染未得到完整图像。');
    return output;
  } finally {payloads.delete(token);if(!win.isDestroyed())win.destroy();}
}
// Serial work bounds memory for simultaneous card previews. An aborted queued request never opens a window.
let previous=Promise.resolve();
function enqueue<T>(signal:AbortSignal,work:()=>Promise<T>){
  signal.throwIfAborted();
  const job=previous.then(()=>{signal.throwIfAborted();return work();});
  previous=job.then(()=>{},()=>{});
  return waitWithSignal(job,signal);
}
export async function renderPublicFigure(source:PublicFigureSource,signal?:AbortSignal):Promise<Buffer>{
  validateFigureCrop(source);
  const timeout=combinedSignal(signal),url=validatePublicSource(source.pdfUrl,'pdf').href;
  return enqueue(timeout,async()=>{
    if(!cached||cached.url!==url||cached.expires<=Date.now()){
      const bytes=await downloadGallerySource(url,'pdf',timeout);
      if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw new Error('图源没有返回 PDF，请打开原文查看。');
      const sha=createHash('sha256').update(bytes).digest('hex');
      cached={url,bytes,sha,expires:Date.now()+180000};
      clearTimeout(expiry);expiry=setTimeout(()=>{cached=undefined;},180000);expiry.unref();
    }
    if(source.pdfSha256&&source.pdfSha256.toLowerCase()!==cached.sha)throw new Error('公开 PDF 版本与索引校验值不符。');
    return renderSourceBytes(cached.bytes,{kind:'pdf',page:source.page,crop:source.cropPdfPoints},timeout);
  });
}
export async function readPublicImage(url:string,signal?:AbortSignal):Promise<Buffer>{
  validatePublicSource(url,'image');
  const timeout=combinedSignal(signal);
  return enqueue(timeout,async()=>{
    const bytes=await downloadGallerySource(url,'image',timeout);
    return renderSourceBytes(bytes,{kind:'image',mime:publicImageMime(bytes)},timeout);
  });
}

export async function readPublicPanels(panels: readonly {url:string;label:string}[], signal?:AbortSignal) {
  if (panels.length < 2 || panels.length > 6) throw Error('原图面板数量无效。');
  for (const panel of panels) {
    validatePublicSource(panel.url,'image');
    if (typeof panel.label !== 'string' || panel.label.length > 120) throw Error('原图面板标注无效。');
  }
  const timeout=combinedSignal(signal);
  return enqueue(timeout,async()=>{
    const chunks:Buffer[]=[];
    const parts:{length:number;mime:string;label:string}[]=[];
    let total=0;
    for (const panel of panels) {
      const bytes=await downloadGallerySource(panel.url,'image',timeout);
      total+=bytes.length;
      if (total>32*1024*1024) throw Error('原图面板超过大小限制。');
      parts.push({length:bytes.length,mime:publicImageMime(bytes),label:panel.label});
      chunks.push(bytes);
    }
    return renderSourceBytes(Buffer.concat(chunks,total),{kind:'panels',panels:parts},timeout);
  });
}
