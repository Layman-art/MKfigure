import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { GalleryCacheStatus, PaperFigure } from '../shared/types';
import { sniffImage } from './providers/common';

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const releaseApi = 'https://api.github.com/repos/Layman-art/MKfigure/releases';
const cacheName = (row: PaperFigure, hash: string) => hash + path.extname(row.image);
type SourceResolver = (row: PaperFigure, signal: AbortSignal) => Promise<Buffer>;

async function optionalFile(file: string) {
  try { return await fs.readFile(file); } catch (error) { if (!missing(error)) throw error; }
}

// A locally rendered PDF crop has its own digest and never receives the archived crop's checksum.
async function renderedFile(file: string) {
  const data = await optionalFile(file);
  if (!data || data.length <= 65 || data[64] !== 10) return;
  const bytes = data.subarray(65);
  if (digest(bytes) === data.toString('ascii',0,64)) return bytes;
}

async function atomicWrite(file: string, contents: Buffer, signal?: AbortSignal) {
  await fs.mkdir(path.dirname(file),{recursive:true});
  const temp=file+'.'+randomUUID()+'.tmp';
  try {
    await fs.writeFile(temp,contents);
    signal?.throwIfAborted();
    await fs.rename(temp,file);
  } finally { await fs.rm(temp,{force:true}).catch(()=>{}); }
}

async function verifiedFile(file: string, hash: string) {
  try {
    const bytes = await fs.readFile(file);
    if (digest(bytes) === hash) return bytes;
  } catch (error) { if (!missing(error)) throw error; }
}

interface PendingRead {
  task: Promise<Buffer>;
  controller: AbortController;
  readers: number;
}

export class GalleryImageCache {
  private index?: Promise<{revision:string; hashes:Record<string,string>}>;
  private coverage?: Promise<{archiveVersion?:string;cardPreviewProfile?:number}>;
  private archiveAsset?: Promise<string>;
  private preferAssetApi = false;
  private pending = new Map<string, PendingRead>();
  private available = new Set<string>();
  private inventoried?: Promise<void>;
  private batch?: AbortController;
  private error?: string;
  constructor(private readonly root: string, private readonly directory: string,
    private readonly request: typeof fetch = fetch, private readonly resolveSource?: SourceResolver) {}

  private metadata() {
    return this.index ??= Promise.all(['upstream.json', 'data/image-hashes.json'].map(file =>
      fs.readFile(path.join(this.root, file), 'utf8').then(text => JSON.parse(text)))).then(([manifest, hashes]) => {
      if (!/^[a-f0-9]{40}$/.test(manifest.revision)) throw Error('图库版本无效');
      return {revision:manifest.revision as string, hashes:hashes as Record<string,string>};
    }).catch(error => { this.index=undefined; throw error; });
  }

  private inventory(rows: PaperFigure[]) {
    return this.inventoried ??= (async () => {
      const {hashes} = await this.metadata();
      const namesIn = async (directory: string) => new Set(await fs.readdir(directory).catch(error => {
        if (missing(error)) return []; throw error;
      }));
      const cached = await namesIn(this.directory);
      const directories = new Map<string, Set<string>>();
      for (const directory of new Set(rows.map(row => path.dirname(row.image)))) {
        directories.set(directory, await namesIn(path.join(this.root,directory)));
      }
      let cursor=0;
      const inspect = async () => {
        while (cursor<rows.length) {
          const row=rows[cursor++], hash=row.supplement?.sha256 ?? hashes[row.id];
          if (!/^[a-f0-9]{64}$/.test(hash || '')) continue;
          const bundled = directories.get(path.dirname(row.image))!.has(path.basename(row.image));
          if ((bundled && await verifiedFile(path.join(this.root,row.image),hash)) ||
            (cached.has(cacheName(row,hash)) && await verifiedFile(path.join(this.directory,cacheName(row,hash)),hash)) ||
            (row.supplement && cached.has(hash+'.rendered') && await renderedFile(path.join(this.directory,hash+'.rendered')))) {
            this.available.add(row.id);
          }
        }
      };
      await Promise.all(Array.from({length:4},inspect));
    })().catch(error => { this.inventoried=undefined; throw error; });
  }

  async read(row: PaperFigure, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    let entry=this.pending.get(row.id);
    if (!entry || entry.controller.signal.aborted) {
      const controller=new AbortController();
      const task=this.readOrFetch(row,controller.signal).then(bytes => {
        this.available.add(row.id);
        return bytes;
      }).finally(() => {
        if (this.pending.get(row.id)?.controller===controller) this.pending.delete(row.id);
      });
      entry={task,controller,readers:0};
      this.pending.set(row.id,entry);
    }
    entry.readers++;
    let onAbort: (()=>void) | undefined;
    try {
      if (!signal) return await entry.task;
      const interrupted=new Promise<never>((_,reject) => {
        onAbort=()=>reject(signal.reason);
        signal.addEventListener('abort',onAbort,{once:true});
      });
      return await Promise.race([entry.task,interrupted]);
    } finally {
      if (onAbort) signal?.removeEventListener('abort',onAbort);
      if (--entry.readers===0) entry.controller.abort();
    }
  }

  async thumbnail(row: PaperFigure, signal?: AbortSignal): Promise<Buffer | undefined> {
    const info = row.supplement;
    if (!info) return this.read(row,signal);
    signal?.throwIfAborted();
    const hash = info.sha256;
    const privateCard=await optionalFile(path.join(this.directory,'cards-v2',hash+'.webp'));
    if (privateCard) return privateCard;
    const publicPath=path.join(this.root,'journals','previews',row.id+'.webp');
    if (info.archive && (await this.catalogCoverage()).cardPreviewProfile===2) {
      const currentCard=await optionalFile(publicPath);
      if (currentCard) return currentCard;
    }
    // Read local assets only. Older private caches may have a 172px-wide portrait preview.
    const original = await verifiedFile(path.join(this.directory,cacheName(row,hash)),hash) ||
      await verifiedFile(path.join(this.root,row.image),hash) ||
      await renderedFile(path.join(this.directory,hash+'.rendered'));
    if (original) return original;
    if (info.archive) {
      const bundled=await optionalFile(publicPath);
      if (bundled) return bundled;
    }
    return optionalFile(path.join(this.directory,'previews',hash+'.webp'));
  }

  private catalogCoverage() {
    return this.coverage ??= optionalFile(path.join(this.root,'journals','coverage.json')).then(bytes =>
      bytes ? JSON.parse(bytes.toString('utf8')) : {});
  }

  private assetUrl(version: string, name: string) {
    return this.archiveAsset ??= (async () => {
      const response = await this.request(releaseApi+'/tags/v'+version,{credentials:'omit',signal:AbortSignal.timeout(8000)});
      if (!response.ok) { await response.body?.cancel(); throw Error('未取得公开图包信息。'); }
      const release = await response.json();
      const asset = Array.isArray(release.assets) && release.assets.find((entry:{name?:string}) => entry?.name === name);
      if (!asset || !Number.isSafeInteger(asset.id) || asset.id <= 0) throw Error('未找到对应版本的公开图包。');
      return releaseApi+'/assets/'+asset.id;
    })().catch(error => { this.archiveAsset=undefined; throw error; });
  }

  private async archiveFigure(part: {offset:number;length:number}, hash: string, signal: AbortSignal) {
    const version=(await this.catalogCoverage()).archiveVersion ?? '2.0.0';
    if (typeof version!=='string' || !/^\d+\.\d+\.\d+$/.test(version)) throw Error('图包版本无效。');
    const name='MK-Figure-'+version+'-Open-Figures.zip';
    const end=part.offset+part.length-1;
    for (const api of (this.preferAssetApi ? [true,false] : [false,true])) {
      try {
        signal.throwIfAborted();
        const url=api ? await this.assetUrl(version,name) : 'https://github.com/Layman-art/MKfigure/releases/download/v'+version+'/'+name;
        const headers: Record<string,string>={Range:`bytes=${part.offset}-${end}`};
        if (api) headers.Accept='application/octet-stream';
        const response=await this.request(url,{headers,credentials:'omit',signal:AbortSignal.any([signal,AbortSignal.timeout(12000)])});
        if (response.status!==206 || !response.headers.get('content-range')?.startsWith(`bytes ${part.offset}-${end}/`)) {
          await response.body?.cancel(); continue;
        }
        const reader=response.body?.getReader();
        if (!reader) continue;
        const chunks:Uint8Array[]=[];
        let total=0;
        try {
          while (true) {
            const {done,value}=await reader.read();
            if (done) break;
            total+=value.byteLength;
            if (total>part.length) break;
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(()=>{}); }
        if (total===part.length) {
          const bytes=Buffer.concat(chunks);
          if (digest(bytes)===hash) { this.preferAssetApi=api; return bytes; }
        }
      } catch { signal.throwIfAborted(); }
    }
  }

  private async readOrFetch(row: PaperFigure, signal: AbortSignal): Promise<Buffer> {
    const {revision, hashes} = await this.metadata();
    const hash = row.supplement?.sha256 ?? hashes[row.id];
    if (!/^[a-f0-9]{64}$/.test(hash || '')) throw Error('该论文主图缺少校验信息');
    const target = path.join(this.directory, cacheName(row,hash));
    const local = await verifiedFile(path.join(this.root,row.image),hash) || await verifiedFile(target,hash);
    if (local) return local;
    this.available.delete(row.id);
    if (row.supplement) {
      const derived=path.join(this.directory,hash+'.rendered');
      const previous=await renderedFile(derived);
      if (previous) return previous;
      const part=row.supplement.archive;
      if (part && Number.isSafeInteger(part.offset) && Number.isSafeInteger(part.length) && part.offset >= 0 && part.length > 0 && part.length <= 32*1024*1024) {
        const original=await this.archiveFigure(part,hash,signal);
        if (original) { await atomicWrite(target,original,signal); return original; }
      }
      if (!this.resolveSource || !(row.supplement.imageSource || row.supplement.imagePanels?.length || row.pdf_source && row.supplement.cropPdfPoints && row.page))
        throw Error('增补图库原图暂不可用，可打开原文图位或安装离线图包。');
      const bytes=await this.resolveSource(row,signal);
      signal.throwIfAborted();
      if (!sniffImage(bytes)) throw Error('原文未返回有效图像。');
      await atomicWrite(derived,Buffer.concat([Buffer.from(digest(bytes)+'\n'),bytes]),signal);
      return bytes;
    }
    const relative = row.image.split('/').map(encodeURIComponent).join('/');
    const sources = [
      'https://raw.githubusercontent.com/qwdwqfwq/topconf-paper-figure-gallery/'+revision+'/'+relative,
      'https://qwdwqfwq.github.io/topconf-paper-figure-gallery/'+relative,
    ];
    let verified: Buffer | undefined;
    for (const url of sources) {
      signal.throwIfAborted();
      try {
        const response = await this.request(url, {credentials:'omit', signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])});
        if (!response.ok) { await response.body?.cancel(); continue; }
        const bytes = Buffer.from(await response.arrayBuffer());
        if (digest(bytes)===hash) { verified=bytes; break; }
      } catch { signal.throwIfAborted(); }
    }
    signal.throwIfAborted();
    if (!verified) throw Error('暂时无法取得通过校验的论文主图。请连接网络后重试。');
    await atomicWrite(target,verified,signal);
    return verified;
  }

  async installArchive(rows: PaperFigure[], file: string) {
    const records=rows.filter(row=>row.supplement?.archive);
    if (!records.length) throw Error('当前版本没有配套的开放图包。');
    const handle=await fs.open(file,'r');
    const size=(await handle.stat()).size;
    try {
      for (const row of records) {
        const info=row.supplement!, part=info.archive!;
        if (!Number.isSafeInteger(part.offset) || !Number.isSafeInteger(part.length) || part.length<1 ||
            part.length>32*1024*1024 || part.offset<0 || part.offset+part.length>size) throw Error('图包与当前版本不匹配。');
        const bytes=Buffer.alloc(part.length);
        let offset=0;
        while (offset<bytes.length) {
          const got=await handle.read(bytes,offset,bytes.length-offset,part.offset+offset);
          if (!got.bytesRead) throw Error('图包不完整。');
          offset+=got.bytesRead;
        }
        if (digest(bytes)!==info.sha256) throw Error('图包校验未通过。请使用此版本配套的开放图包。');
        await atomicWrite(path.join(this.directory,cacheName(row,info.sha256)),bytes);
        this.available.add(row.id);
      }
      return records.length;
    } finally { await handle.close(); }
  }

  async status(rows: PaperFigure[], action?: 'start'|'stop'): Promise<GalleryCacheStatus> {
    await this.inventory(rows);
    if (action==='stop') { this.batch?.abort(); this.batch=undefined; }
    if (action==='start' && !this.batch && this.available.size<rows.length) {
      const controller = new AbortController();
      this.batch=controller; this.error=undefined;
      const todo=rows.filter(row=>!row.supplement && !this.available.has(row.id));
      let cursor=0;
      const worker=async()=>{
        while(!controller.signal.aborted && cursor<todo.length) {
          const row=todo[cursor++];
          try { await this.read(row,controller.signal); }
          catch(error) { if(!controller.signal.aborted) this.error=error instanceof Error?error.message:'图库下载失败'; controller.abort(); }
        }
      };
      void Promise.allSettled(Array.from({length:4}, worker)).finally(()=>{ if(this.batch===controller) this.batch=undefined; });
    }
    return {available:this.available.size,total:rows.length,running:!!this.batch,error:this.error,
      downloadable:rows.filter(row=>!row.supplement && !this.available.has(row.id)).length};
  }
}
