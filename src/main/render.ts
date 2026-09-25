import { BrowserWindow } from 'electron';
let availableFonts:Record<string,boolean>|undefined;
export const fontAvailability=()=>availableFonts;
export async function renderSvgPng(svg: string, width: number, height: number): Promise<Buffer> {
  width = Math.max(1, Math.min(4096, Math.round(width))); height = Math.max(1, Math.min(4096, Math.round(height)));
  const win = new BrowserWindow({ show:false, width:Math.max(32,width), height:Math.max(32,height), useContentSize:true, frame:false, webPreferences:{ sandbox:true, contextIsolation:true, nodeIntegration:false, offscreen:true, backgroundThrottling:false } });
  try {
    const uri = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
    const html = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"></head><body style="margin:0;overflow:hidden;background:white"><img id="figure" style="width:${width}px;height:${height}px;display:block"></body></html>`;
    await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
    // Pass the image after navigation so a detailed SVG cannot exceed Chromium's URL limit.
    await win.webContents.executeJavaScript(`(()=>{const figure=document.getElementById('figure');figure.src=${JSON.stringify(uri)};return Promise.all([document.fonts.ready,figure.decode()]).then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));})()`);
    if(!availableFonts)availableFonts=await win.webContents.executeJavaScript(`(()=>{const c=document.createElement('canvas').getContext('2d'),sample='mmmmmmWWWiii0123456789';const measure=f=>{c.font='80px '+f;return c.measureText(sample).width};return Object.fromEntries(['Times New Roman','Microsoft YaHei'].map(name=>[name,['monospace','serif','sans-serif'].some(fallback=>Math.abs(measure('"'+name+'",'+fallback)-measure(fallback))>.1)]));})()`);
    const captured=await win.webContents.capturePage({x:0,y:0,width,height});
    return captured.resize({width,height,quality:'best'}).toPNG();
  } finally { win.destroy(); }
}
