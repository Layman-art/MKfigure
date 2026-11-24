import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaperFigure } from '../src/shared/types';
import { GalleryImageCache } from '../src/main/gallery-cache';

const scratch: string[]=[];
const revision='a'.repeat(40);
async function fixture(count=6) {
  const root=await mkdtemp(join(tmpdir(),'mk-gallery-cache-test-'));
  scratch.push(root);
  const cacheDir=join(root,'cache'), imageDir=join(root,'images','demo','final');
  await Promise.all([mkdir(join(root,'data')),mkdir(cacheDir),mkdir(imageDir,{recursive:true})]);
  const rows: PaperFigure[]=Array.from({length:count},(_,i)=>({
    id:'demo-'+i,year:2026,title:'Figure '+i,venue:'demo',authors:[],paper:'',pattern:'diagram',image:'images/demo/final/demo-'+i+'.jpg',
  }));
  const bytes=(id:string)=>Buffer.from('Synthetic image '+id);
  const hash=(id:string)=>createHash('sha256').update(bytes(id)).digest('hex');
  await Promise.all([
    writeFile(join(root,'upstream.json'),JSON.stringify({revision})),
    writeFile(join(root,'data/image-hashes.json'),JSON.stringify(Object.fromEntries(rows.map(r=>[r.id,hash(r.id)])))),
  ]);
  const idOf=(url:URL | RequestInfo)=>String(url).split('/').at(-1)!.replace(/\.jpg$/,'');
  const response=(url:URL | RequestInfo)=>new Response(new Uint8Array(bytes(idOf(url))));
  return {root,cacheDir,rows,bytes,hash,response,idOf};
}
afterEach(async()=>{await Promise.all(scratch.splice(0).map(p=>rm(p,{recursive:true,force:true})));});

describe('verified public gallery cache',()=>{
  it('keeps grid previews offline and caches a selected source rendering under its own digest',async()=>{
    const f=await fixture(1), row=f.rows[0];
    row.image='journals/images/'+row.id+'.webp';
    row.supplement={category:'algorithm',collection:'journal',description:'Reviewed algorithm',sha256:f.hash(row.id),imageSource:'https://arxiv.org/html/1234.56789v1/fig1.png'};
    const png=Buffer.from('89504e470d0a1a0a0000000000000000','hex');
    const source=vi.fn(async()=>png), request=vi.fn<typeof fetch>();
    const cache=new GalleryImageCache(f.root,f.cacheDir,request,source);
    expect(await cache.thumbnail(row)).toBeUndefined();
    expect(source).not.toHaveBeenCalled();
    await cache.status([row],'start');
    expect(source).not.toHaveBeenCalled();
    expect(await Promise.all([cache.read(row),cache.read(row)])).toEqual([png,png]);
    expect(source).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    const fresh=new GalleryImageCache(f.root,f.cacheDir,request);
    expect(await fresh.status([row])).toMatchObject({available:1,downloadable:0});
    expect(await fresh.thumbnail(row)).toEqual(png);
    expect(await fresh.read(row)).toEqual(png);
    await writeFile(join(f.cacheDir,row.supplement.sha256+'.rendered'),'corrupt');
    await expect(fresh.read(row)).rejects.toThrow('增补图库');
  });
  it('verifies exactly the requested range or installs the same open figure from its matching archive',async()=>{
    const f=await fixture(1),row=f.rows[0],bytes=f.bytes(row.id);
    const prefix=Buffer.from('ZIP local header');
    row.image='journals/images/'+row.id+'.webp';
    row.supplement={category:'result',collection:'journal',description:'Verified open image',sha256:f.hash(row.id),archive:{offset:prefix.length,length:bytes.length}};
    const end=prefix.length+bytes.length-1;
    const request=vi.fn<typeof fetch>().mockImplementation(async()=>new Response(new Uint8Array(bytes),{status:206,headers:{'content-range':`bytes ${prefix.length}-${end}/200`}}));
    const cache=new GalleryImageCache(f.root,f.cacheDir,request);
    expect(await cache.read(row)).toEqual(bytes);
    expect(request.mock.calls[0][1]?.headers).toEqual({Range:`bytes=${prefix.length}-${end}`});
    expect(await readFile(join(f.cacheDir,f.hash(row.id)+'.webp'))).toEqual(bytes);
    const pack=join(f.root,'open-pack.zip');
    await writeFile(pack,Buffer.concat([prefix,Buffer.alloc(bytes.length)]));
    await expect(cache.installArchive([row],pack)).rejects.toThrow('校验');
    await writeFile(pack,Buffer.concat([prefix,bytes]));
    expect(await cache.installArchive([row],pack)).toBe(1);
  });
  it('uses the bundled verified crop offline and reports a missing crop without requesting it from upstream',async()=>{
    const f=await fixture(1), row=f.rows[0];
    row.image='supplement/images/'+row.id+'.jpg';
    row.supplement={category:'algorithm',description:'A sequence of updates',sha256:f.hash(row.id)};
    await mkdir(join(f.root,'supplement','images'),{recursive:true});
    await writeFile(join(f.root,row.image),f.bytes(row.id));
    const request=vi.fn<typeof fetch>(),cache=new GalleryImageCache(f.root,f.cacheDir,request);
    expect(await cache.status([row])).toMatchObject({available:1,total:1});
    expect(await cache.read(row)).toEqual(f.bytes(row.id));
    await writeFile(join(f.root,row.image),'invalid');
    await expect(cache.read(row)).rejects.toThrow('增补图库');
    expect(await cache.status([row])).toMatchObject({available:0,total:1});
    expect(request).not.toHaveBeenCalled();
  });
  it('deduplicates simultaneous views, rejects wrong pinned bytes, and reopens entirely offline',async()=>{
    const f=await fixture(1),row=f.rows[0];
    const request=vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('wrong bytes')).mockImplementation(async url=>f.response(url));
    const cache=new GalleryImageCache(f.root,f.cacheDir,request);
    expect(await cache.status(f.rows)).toMatchObject({available:0,total:1});
    const images=await Promise.all([cache.read(row),cache.read(row)]);
    expect(images).toEqual([f.bytes(row.id),f.bytes(row.id)]);
    expect(request.mock.calls.map(c=>String(c[0]))).toEqual([
      'https://raw.githubusercontent.com/qwdwqfwq/topconf-paper-figure-gallery/'+revision+'/'+row.image,
      'https://qwdwqfwq.github.io/topconf-paper-figure-gallery/'+row.image,
    ]);
    expect(request.mock.calls[0][1]?.credentials).toBe('omit');
    expect(await readdir(f.cacheDir)).toEqual([f.hash(row.id)+'.jpg']);
    const offline=vi.fn<typeof fetch>().mockRejectedValue(Error('offline'));
    const reopened=new GalleryImageCache(f.root,f.cacheDir,offline);
    expect(await reopened.status(f.rows)).toMatchObject({available:1,total:1,running:false});
    expect(await reopened.read(row)).toEqual(f.bytes(row.id));
    expect(offline).not.toHaveBeenCalled();
  });

  it('excludes corrupt packaged/cache entries, preserves verified files on failure and resumes after repair',async()=>{
    const f=await fixture(2),[good,bad]=f.rows;
    await writeFile(join(f.cacheDir,f.hash(good.id)+'.jpg'),f.bytes(good.id));
    await writeFile(join(f.root,bad.image),'bad packaged bytes');
    const suspect=join(f.cacheDir,f.hash(bad.id)+'.jpg');
    await writeFile(suspect,'bad cache contents');
    const request=vi.fn<typeof fetch>().mockImplementation(async()=>new Response('mismatch'));
    const cache=new GalleryImageCache(f.root,f.cacheDir,request);
    expect(await cache.status(f.rows)).toMatchObject({available:1,total:2});
    await cache.status(f.rows,'start');
    await vi.waitFor(async()=>expect(await cache.status(f.rows)).toMatchObject({available:1,running:false,error:expect.stringContaining('校验')}));
    expect(await readFile(suspect,'utf8')).toBe('bad cache contents');
    expect(await readFile(join(f.cacheDir,f.hash(good.id)+'.jpg'))).toEqual(f.bytes(good.id));
    request.mockImplementation(async url=>f.response(url));
    await cache.status(f.rows,'start');
    await vi.waitFor(async()=>expect(await cache.status(f.rows)).toMatchObject({available:2,running:false,error:undefined}));
    expect(await readFile(suspect)).toEqual(f.bytes(bad.id));
    expect(request.mock.calls.every(([url])=>f.idOf(url)===bad.id)).toBe(true);
  });

  it('immediately pauses four workers, lets an open view finish, and retries only missing images',async()=>{
    const f=await fixture(6);
    const inflight=new Map<string,{signal:AbortSignal;resolve:()=>void}>();
    const request=vi.fn<typeof fetch>().mockImplementation((url,options)=>new Promise((resolve,reject)=>{
      const signal=options!.signal!;
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
      inflight.set(f.idOf(url),{signal,resolve:()=>resolve(f.response(url))});
    }));
    const cache=new GalleryImageCache(f.root,f.cacheDir,request);
    await cache.status(f.rows,'start');
    await vi.waitFor(()=>expect(inflight.size).toBe(4));
    const shared=f.rows[0], display=cache.read(shared);
    expect((await cache.status(f.rows,'stop')).running).toBe(false);
    await vi.waitFor(()=>expect([...inflight.values()].filter(i=>i.signal.aborted)).toHaveLength(3));
    expect(inflight.get(shared.id)!.signal.aborted).toBe(false);
    inflight.get(shared.id)!.resolve();
    expect(await display).toEqual(f.bytes(shared.id));
    expect(await cache.status(f.rows)).toMatchObject({available:1,running:false,error:undefined});
    request.mockClear().mockImplementation(async url=>f.response(url));
    await cache.status(f.rows,'start');
    await vi.waitFor(async()=>expect(await cache.status(f.rows)).toMatchObject({available:6,total:6,running:false,error:undefined}));
    expect(request.mock.calls.map(c=>f.idOf(c[0])).sort()).toEqual(f.rows.slice(1).map(r=>r.id).sort());
  });

  it('aborts a closed image view without fallback and immediately accepts a new request for it',async()=>{
    const f=await fixture(1),row=f.rows[0];
    let signal:AbortSignal | undefined;
    const request=vi.fn<typeof fetch>().mockImplementationOnce((_url,options)=>new Promise((_resolve,reject)=>{
      signal=options!.signal!;
      signal.addEventListener('abort',()=>reject(signal!.reason),{once:true});
    })).mockImplementation(async url=>f.response(url));
    const cache=new GalleryImageCache(f.root,f.cacheDir,request);
    const view=new AbortController();
    const read=cache.read(row,view.signal);
    await vi.waitFor(()=>expect(signal).toBeDefined());
    view.abort();
    await expect(read).rejects.toMatchObject({name:'AbortError'});
    expect(signal!.aborted).toBe(true);
    expect(await cache.read(row)).toEqual(f.bytes(row.id));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(([url])=>String(url).includes(revision))).toBe(true);
  });
});
