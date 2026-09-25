import { BrowserWindow } from 'electron';

/** Electron nativeImage omits WebP on Windows; decode it in the sandboxed Chromium image decoder. */
export async function webpToPng(buffer: Buffer): Promise<Buffer> {
  const window = new BrowserWindow({ show: false, width: 32, height: 32, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  try {
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:"><body></body>'));
    const source = `data:image/webp;base64,${buffer.toString('base64')}`;
    const result: string = await window.webContents.executeJavaScript(`(async()=>{
      const image=new Image();image.src=${JSON.stringify(source)};await image.decode();
      const width=image.naturalWidth,height=image.naturalHeight;
      if(!width||!height||width>16384||height>16384||width*height>60000000)throw new Error('Image dimensions exceed limit');
      const scale=Math.min(1,2400/Math.max(width,height)),canvas=document.createElement('canvas');
      canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
      canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
      return canvas.toDataURL('image/png');
    })()`);
    return Buffer.from(result.slice('data:image/png;base64,'.length), 'base64');
  } catch { throw new Error('WebP 图片无法解码，文件可能已损坏'); }
  finally { window.destroy(); }
}
