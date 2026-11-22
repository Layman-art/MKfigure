import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prepareLocalEdit, sameImagePixels } from '../src/main/local-image-edit';
import { draggedBounds, sourcePoint, validBounds } from '../src/renderer/components/ImageRegionPicker';

vi.mock('electron', () => ({ nativeImage: {} }));
let directory: string;
beforeAll(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(),'mkfigure-rect-test-')); });
afterAll(async () => { if(path.dirname(directory)===os.tmpdir() && path.basename(directory).startsWith('mkfigure-rect-test-')) await fs.rm(directory,{recursive:true,force:true}); });
const png = (width:number,height:number,data:Buffer|Uint16Array,depth:8|16=8) => {
  const img = new PNG();
  Object.assign(img,{width,height,data:Buffer.from(data.buffer,data.byteOffset,data.byteLength)});
  return PNG.sync.write(img,{bitDepth:depth});
};
const asData = (b:Buffer) => 'data:image/png;base64,'+b.toString('base64');
const raw = (url:string, depth:8|16=8) => PNG.sync.read(Buffer.from(url.split(',')[1],'base64'),{skipRescale:depth===16});
const region = {targetId:'demo',x:1,y:1,width:3,height:2};
async function source() {
  const data = Buffer.alloc(5*4*4);
  for(let p=0;p<20;p++)data.set([100+p,29+p,72+p,[0,30,129,255][p%4]],p*4);
  const file=path.join(directory,'source.png');await fs.writeFile(file,png(5,4,data));return {file,data};
}
describe('local edit lossless containment', () => {
  it('sends only the exact crop, including unassociated transparent RGB, and changes only selected pixels', async () => {
    const {file,data}=await source(), draft=await prepareLocalEdit(file,region), crop=raw(draft.image.dataUrl);
    expect([crop.width,crop.height]).toEqual([3,2]);
    const first=(region.y*5+region.x)*4;
    expect(crop.data).toEqual(Buffer.concat([data.subarray(first,first+12),data.subarray(first+20,first+32)]));
    await expect(draft.finish(draft.image)).rejects.toThrow(/未检测到/);
    const edited=Buffer.from(crop.data);edited.set([3,7,92,121],0);
    const patch=await draft.finish({dataUrl:asData(png(3,2,edited))});
    expect(patch.changedPixels).toBe(1);
    const expected=Buffer.from(data);expected.set([3,7,92,121],first);
    expect(raw(patch.dataUrl).data).toEqual(expected);
    expect(await sameImagePixels(file,{dataUrl:patch.dataUrl})).toBe(false);
    expect(await sameImagePixels(file,{dataUrl:asData(png(5,4,data))})).toBe(true);
    expect((await fs.readFile(file)).equals(png(5,4,data))).toBe(true);
  });
  it('rejects out-of-range/fractional boxes and mismatched ratios, allows proportional resizing at the edge', async () => {
    const {file,data}=await source();
    for (const bounds of [{x:-1},{y:4},{width:0},{height:99},{x:.5},{x:Infinity}])
      await expect(prepareLocalEdit(file,{...region,...bounds})).rejects.toThrow(/边界/);
    const edit=await prepareLocalEdit(file,{targetId:'demo',x:3,y:3,width:2,height:1});
    const invalid=png(2,2,Buffer.alloc(16,220));await expect(edit.finish({dataUrl:asData(invalid)})).rejects.toThrow(/宽高比/);
    const higher=png(4,2,Buffer.alloc(4*2*4,240)), patch=await edit.finish({dataUrl:asData(higher)});
    expect(patch.changedPixels).toBe(2);
    const expected=Buffer.from(data);expected.fill(240,18*4,20*4);
    expect(raw(patch.dataUrl).data).toEqual(expected);
  });
  it('invisible-only RGB differences do not count as a successful edit', async () => {
    const {file}=await source();const draft=await prepareLocalEdit(file,{targetId:'demo',x:0,y:0,width:1,height:1});
    await expect(draft.finish({dataUrl:asData(png(1,1,Buffer.from([5,8,4,0])))})).rejects.toThrow(/未检测到/);
  });
  it.each([[7,2,9,6],[2,7,6,9]])('isolates %i × %i content in a padded model canvas', async (w,h,cw,ch) => {
    const sw=w+4,sh=h+4,src=Buffer.alloc(sw*sh*4);
    for(let i=0;i<sw*sh;i++) src.set([57+i,34,111,i%3?120:0],4*i);
    const file=path.join(directory,'irregular-'+w+'.png');await fs.writeFile(file,png(sw,sh,src));
    const draft=await prepareLocalEdit(file,{targetId:'fixture',x:2,y:2,width:w,height:h});
    const x=Math.floor((cw-w)/2),y=Math.floor((ch-h)/2);
    expect(draft.canvas).toEqual({width:cw,height:ch,contentX:x,contentY:y,contentWidth:w,contentHeight:h});
    const original=raw(draft.image.dataUrl);
    const onlySelected=Buffer.alloc(cw*ch*4);
    for(let j=0;j<h;j++)src.copy(onlySelected,((j+y)*cw+x)*4,((j+2)*sw+2)*4,((j+2)*sw+2+w)*4);
    expect(original.data).toEqual(onlySelected);
    const scale=2,edited=Buffer.alloc(cw*ch*scale*scale*4);
    for(let j=0;j<ch*scale;j++)for(let i=0;i<cw*scale;i++){
      const a=Math.floor(i/scale),b=Math.floor(j/scale),k=4*(b*cw+a);
      edited.set(a<x||a>=x+w||b<y||b>=y+h?[255,0,0,255]:onlySelected.subarray(k,k+4),4*(j*cw*scale+i));
    }
    await expect(draft.finish({dataUrl:asData(png(cw*scale,ch*scale,edited))})).rejects.toThrow(/未检测到/);
    for(let j=0;j<scale;j++)for(let i=0;i<scale;i++)edited.set([18,37,11,255],4*((y*scale+j)*cw*scale+x*scale+i));
    const composed=await draft.finish({dataUrl:asData(png(cw*scale,ch*scale,edited))});
    expect(composed.changedPixels).toBe(1);
    const expected=Buffer.from(src);expected.set([18,37,11,255],4*(2*sw+2));expect(raw(composed.dataUrl).data).toEqual(expected);
    await expect(draft.finish({dataUrl:asData(png(4,4,Buffer.alloc(64,55)))})).rejects.toThrow(/宽高比/);
    const direct=Buffer.alloc(w*h*4,203);const unpadded=await draft.finish({dataUrl:asData(png(w,h,direct))});
    for(let j=0;j<h;j++)expected.fill(203,4*((j+2)*sw+2),4*((j+2)*sw+2+w));
    expect(raw(unpadded.dataUrl).data).toEqual(expected);
  });
  it('keeps 16-bit samples exact when patching with an 8-bit response', async () => {
    const a=new Uint16Array([1129,19,538,0, 31235,168,4331,1783, 16386,145,6332,65535]);
    const file=path.join(directory,'16bit.png');await fs.writeFile(file,png(3,1,a,16));
    const draft=await prepareLocalEdit(file,{targetId:'demo',x:1,y:0,width:1,height:1});
    expect(raw(draft.image.dataUrl,16).depth).toBe(16);
    const {dataUrl}=await draft.finish({dataUrl:asData(png(1,1,Buffer.from([13,5,105,190])))});
    const expected=a.slice();expected.set([13*257,5*257,105*257,190*257],4);
    expect([...raw(dataUrl,16).data]).toEqual([...expected]);
  });
  it('decodes lossless WebP without premultiplication or clearing transparent RGB', async () => {
    const file=path.join(directory,'straight.webp');
    await fs.writeFile(file,Buffer.from('UklGRjoAAABXRUJQVlA4TC0AAAAvA0AAEB8gFkxDDKPpS0hAxpLupYRIgDSXQbtZgQDRopRUKYHHWfAd3YjofwAA','base64'));
    const draft=await prepareLocalEdit(file,{targetId:'demo',x:1,y:0,width:1,height:1});
    expect([...raw(draft.image.dataUrl).data]).toEqual([124,89,65,32]);
    const {dataUrl}=await draft.finish({dataUrl:asData(png(1,1,Buffer.from([12,30,22,120])))});
    expect([...raw(dataUrl).data.subarray(0,8)]).toEqual([233,151,77,0,12,30,22,120]);
    expect([...raw(dataUrl).data.subarray(16,24)]).toEqual([233,151,77,0,124,89,65,32]);
  });
});
describe('source-pixel selection from the displayed image rectangle', () => {
  it('maps pointer values independently of offset, zoom, density, and scales to original pixels',()=>{
    const w=1600,h=400;
    const a=sourcePoint(412,128,{left:12,top:28,width:800,height:200},w,h);
    const b=sourcePoint(236,94,{left:36,top:44,width:400,height:100},w,h);
    expect(a).toEqual({x:800,y:200});expect(b).toEqual(a);
    const end=sourcePoint(1024,510,{left:12,top:28,width:800,height:200},w,h);
    expect(draggedBounds(end,a,w,h)).toEqual({x:800,y:200,width:800,height:200});
    expect(draggedBounds(end,end,w,h)).toEqual({x:1599,y:399,width:1,height:1});
    expect(validBounds({x:1,y:0,width:1600,height:1},w,h)).toBe(false);
  });
});
