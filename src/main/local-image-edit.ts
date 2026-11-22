import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { nativeImage } from 'electron';
import { PNG } from 'pngjs';
import type { LocalEditRegion } from '../shared/types';

type ImageResult = { path?: string; dataUrl?: string };
type Pixels = { width: number; height: number; depth: 8 | 16; data: Buffer | Uint16Array; colorChunks: Buffer[] };
const signature = Buffer.from('89504e470d0a1a0a', 'hex');
const limit = 30 * 1024 * 1024;
const maxPixels = 40000000;

function checkSize(w: number, h: number) {
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w < 1 || h < 1 || w * h > maxPixels)
    throw new Error('图片像素超出支持范围，请使用 4000 万像素以内的图像。');
}
async function bytes(result: ImageResult) {
  if (result.dataUrl) {
    if (result.dataUrl.length > Math.ceil(limit / 3) * 4 + 64) throw new Error('图片超过 30 MB，请重试。');
    const m = /^data:image\/(?:png|jpeg|webp);base64,([a-z0-9+/=]+)$/i.exec(result.dataUrl);
    if (!m) throw new Error('图片数据无效，请返回 PNG、JPEG 或 WebP 图片后重试。');
    const resultBytes = Buffer.from(m[1], 'base64');
    if (resultBytes.length > limit) throw new Error('图片超过 30 MB，请重试。');
    return resultBytes;
  }
  if (!result.path) throw new Error('没有收到图片，请重新生成。');
  const stat = await fs.stat(result.path);
  if (!stat.isFile() || stat.size > limit) throw new Error('图片不可读或超过 30 MB。');
  return fs.readFile(result.path);
}
function pngPixels(input: Buffer): Pixels {
  if (input.length < 33 || input.toString('ascii',12,16) !== 'IHDR') throw new Error('PNG 文件头不完整。');
  checkSize(input.readUInt32BE(16), input.readUInt32BE(20));
  const colorChunks: Buffer[] = [];
  let transparency: Buffer | undefined;
  for (let pos = 8; pos + 12 <= input.length;) {
    const len = input.readUInt32BE(pos), type = input.toString('ascii', pos+4, pos+8), end = pos + 12 + len;
    if (end > input.length) throw new Error('PNG 数据不完整。');
    if (type === 'acTL') throw new Error('请先将动态图导出为单帧 PNG 后再编辑。');
    if (['iCCP','cHRM','gAMA','sRGB','cICP','mDCV','cLLI','pHYs'].includes(type)) colorChunks.push(input.subarray(pos,end));
    if (type === 'tRNS') transparency = input.subarray(pos+8,end-4);
    pos = end;
    if (type === 'IEND') break;
  }
  const decoded = PNG.sync.read(input, {skipRescale: input[24] === 16});
  const depth = decoded.depth === 16 ? 16 : 8;
  const data: Buffer | Uint16Array = decoded.data;
  // pngjs clears RGB on keyed transparent RGB/grayscale pixels. Restore the color
  // key itself (palette and RGBA formats already preserve unassociated samples).
  if (transparency && (decoded.colorType === 0 || decoded.colorType === 2)) {
    const key = Array.from({length:3}, (_, c) => {
      const v = transparency!.readUInt16BE(decoded.colorType === 0 ? 0 : c*2);
      return depth === 16 ? v : Math.round(v*255/(2**decoded.depth-1));
    });
    for (let i = 0; i < data.length; i += 4) if (!data[i+3]) for (let c=0;c<3;c++) data[i+c] = key[c];
  }
  return {width:decoded.width,height:decoded.height,depth,data,colorChunks};
}

let webpReady: Promise<typeof import('@jsquash/webp/decode.js')> | undefined;
async function readWebp(input: Buffer): Promise<Pixels> {
  let imageWidth = 0, imageHeight = 0;
  for (let pos = 12; pos + 8 <= input.length;) {
    const name = input.toString('ascii',pos,pos+4), n = input.readUInt32LE(pos+4), start = pos+8;
    if (start+n > input.length) throw new Error('WebP 数据不完整。');
    if (name === 'ANIM' || name === 'ANMF') throw new Error('请先将动态 WebP 导出为单帧 PNG 后再编辑。');
    if (name === 'VP8X' && n >= 10) {imageWidth=input.readUIntLE(start+4,3)+1; imageHeight=input.readUIntLE(start+7,3)+1;}
    if (name === 'VP8L' && n >= 5) {const size=input.readUInt32LE(start+1);imageWidth=(size&16383)+1;imageHeight=((size>>>14)&16383)+1;}
    if (name === 'VP8 ' && n >= 10) {imageWidth=input.readUInt16LE(start+6)&16383;imageHeight=input.readUInt16LE(start+8)&16383;}
    if (imageWidth && imageHeight) checkSize(imageWidth,imageHeight);
    pos = start+n+(n%2);
  }
  checkSize(imageWidth,imageHeight);
  if (!webpReady) webpReady = (async () => {
    const decoder = await import('@jsquash/webp/decode.js');
    const resolve = createRequire(path.join(typeof __dirname === 'string' ? __dirname : process.cwd(), 'image-codec.cjs')).resolve;
    const wasm = await fs.readFile(resolve('@jsquash/webp/codec/dec/webp_dec.wasm'));
    await decoder.init({wasmBinary:Uint8Array.from(wasm).buffer});
    return decoder;
  })().catch(error => {webpReady=undefined;throw error;});
  const result = await (await webpReady).default(Uint8Array.from(input).buffer);
  checkSize(result.width,result.height);
  return {width:result.width,height:result.height,depth:8,data:Buffer.from(result.data.buffer,result.data.byteOffset,result.data.byteLength),colorChunks:[]};
}

async function read(result: ImageResult): Promise<Pixels> {
  const input = await bytes(result);
  if (input.subarray(0,8).equals(signature)) return pngPixels(input);
  if (input.toString('ascii',0,4) === 'RIFF' && input.toString('ascii',8,12) === 'WEBP') return readWebp(input);
  if (input[0] === 255 && input[1] === 216) {
    const image = nativeImage.createFromBuffer(input);
    if (!image.isEmpty()) {const {width,height}=image.getSize();checkSize(width,height);return pngPixels(image.toPNG());}
  }
  throw new Error('无法解码图片，请使用静态 PNG、JPEG 或 WebP 后重试。');
}

function pngBytes(image: Pixels) {
  const png = new PNG();
  Object.assign(png,{width:image.width,height:image.height,data:Buffer.from(image.data.buffer,image.data.byteOffset,image.data.byteLength)});
  const encoded = PNG.sync.write(png,{bitDepth:image.depth});
  const out = image.colorChunks.length ? Buffer.concat([encoded.subarray(0,33),...image.colorChunks,encoded.subarray(33)]) : encoded;
  if (out.length > limit) throw new Error('输出 PNG 超过 30 MB，请缩小原图后重试。');
  return out;
}
const encode = (image: Pixels) => 'data:image/png;base64,' + pngBytes(image).toString('base64');
export async function webpToPng(input: Buffer) { return pngBytes(await readWebp(input)); }
const copySamples = (data: Buffer | Uint16Array) => Buffer.isBuffer(data) ? Buffer.from(data) : data.slice();
const scale = (depth: 8|16) => depth === 16 ? 1 : 257;
export async function sameImagePixels(sourcePath: string, result: ImageResult) {
  const [a,b] = await Promise.all([read({path:sourcePath}),read(result)]);
  if (a.width !== b.width || a.height !== b.height) return false;
  const sa=scale(a.depth), sb=scale(b.depth);
  for (let i=0;i<a.data.length;i+=4) {
    if (a.data[i+3]*sa !== b.data[i+3]*sb) return false;
    if (!a.data[i+3]) continue;
    for (let c=0;c<3;c++) if (a.data[i+c]*sa !== b.data[i+c]*sb) return false;
  }
  return true;
}
export async function prepareLocalEdit(sourcePath: string, region: LocalEditRegion) {
  const source = await read({path:sourcePath});
  const {x,y,width,height} = region;
  if (![x,y,width,height].every(Number.isSafeInteger) || x<0 || y<0 || width<1 || height<1 ||
      width>source.width-x || height>source.height-y) throw new Error('选区已无效或超过原图边界，请重新框选。');
  // Compare proportional distance so landscape and portrait have symmetric thresholds.
  const formats = [[1,1],[3,2],[2,3]];
  const distance = ([w,h]:number[]) => Math.abs(Math.log(width*h/(height*w)));
  const [rw,rh] = formats.reduce((best,next) => distance(next) < distance(best) ? next : best);
  const factor = Math.ceil(Math.max(width/rw,height/rh));
  const canvasWidth = factor*rw, canvasHeight = factor*rh;
  checkSize(canvasWidth,canvasHeight);
  const left = Math.floor((canvasWidth-width)/2), top = Math.floor((canvasHeight-height)/2);
  const canvas = {width:canvasWidth,height:canvasHeight,contentX:left,contentY:top,contentWidth:width,contentHeight:height};
  const cropped = source.depth === 16 ? new Uint16Array(canvasWidth*canvasHeight*4) : Buffer.alloc(canvasWidth*canvasHeight*4);
  for (let row=0;row<height;row++) {
    const p=((y+row)*source.width+x)*4;
    cropped.set(source.data.subarray(p,p+width*4), ((row+top)*canvasWidth+left)*4);
  }
  const image = {dataUrl:encode({...source,width:canvasWidth,height:canvasHeight,data:cropped})};
  return {image,canvas,finish:async (result: ImageResult) => {
    const patch = await read(result);
    const direct = patch.width*height === patch.height*width;
    if (!direct && patch.width*canvasHeight !== patch.height*canvasWidth)
      throw new Error('模型返回的图片宽高比与选区和送出的画幅均不一致。请保持画幅和选区位置后重试；原图已保留。');
    const sx = patch.width/(direct ? width : canvasWidth), sy = patch.height/(direct ? height : canvasHeight);
    const offsetX = direct ? 0 : left, offsetY = direct ? 0 : top;
    const dest = copySamples(source.data);
    const convert = scale(patch.depth)/scale(source.depth);
    let changedPixels=0;
    for (let row=0;row<height;row++) {
      // Center sampling maintains sharp labels and never interpolates neighboring source pixels.
      const py=Math.min(patch.height-1,Math.floor((row+offsetY+.5)*sy));
      for (let col=0;col<width;col++) {
        const px=Math.min(patch.width-1,Math.floor((col+offsetX+.5)*sx));
        const i=((row+y)*source.width+x+col)*4, j=(py*patch.width+px)*4;
        const alpha=Math.round(patch.data[j+3]*convert);
        if (!alpha && !source.data[i+3]) continue;
        let changed=false;
        for (let c=0;c<4;c++) {
          const v=Math.round(patch.data[j+c]*convert);
          if (v!==dest[i+c]) { dest[i+c]=v;changed=true; }
        }
        if (changed) changedPixels++;
      }
    }
    if (!changedPixels) throw new Error('选区内未检测到可见像素变化。请具体描述需要修改的内容后重试；原图已保留。');
    return {dataUrl:encode({...source,data:dest}),changedPixels};
  }};
}
