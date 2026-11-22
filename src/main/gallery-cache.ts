import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { GalleryCacheStatus, PaperFigure } from '../shared/types';

const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

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
  private pending = new Map<string, PendingRead>();
  private available = new Set<string>();
  private inventoried?: Promise<void>;
  private batch?: AbortController;
  private error?: string;
  constructor(private readonly root: string, private readonly directory: string,
    private readonly request: typeof fetch = fetch) {}

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
          const row=rows[cursor++], hash=hashes[row.id];
          if (!/^[a-f0-9]{64}$/.test(hash || '')) continue;
          const bundled = directories.get(path.dirname(row.image))!.has(path.basename(row.image));
          if ((bundled && await verifiedFile(path.join(this.root,row.image),hash)) ||
            (cached.has(hash+'.jpg') && await verifiedFile(path.join(this.directory,hash+'.jpg'),hash))) {
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

  private async readOrFetch(row: PaperFigure, signal: AbortSignal): Promise<Buffer> {
    const {revision, hashes} = await this.metadata();
    const hash = hashes[row.id];
    if (!/^[a-f0-9]{64}$/.test(hash || '')) throw Error('该论文主图缺少校验信息');
    const target = path.join(this.directory, hash+'.jpg');
    const local = await verifiedFile(path.join(this.root,row.image),hash) || await verifiedFile(target,hash);
    if (local) return local;
    this.available.delete(row.id);
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
    await fs.mkdir(this.directory,{recursive:true});
    const temporary = target+'.'+randomUUID()+'.tmp';
    try {
      await fs.writeFile(temporary,verified);
      signal.throwIfAborted();
      await fs.rename(temporary,target);
    } finally { await fs.rm(temporary,{force:true}).catch(()=>{}); }
    return verified;
  }

  async status(rows: PaperFigure[], action?: 'start'|'stop'): Promise<GalleryCacheStatus> {
    await this.inventory(rows);
    if (action==='stop') { this.batch?.abort(); this.batch=undefined; }
    if (action==='start' && !this.batch && this.available.size<rows.length) {
      const controller = new AbortController();
      this.batch=controller; this.error=undefined;
      const todo=rows.filter(row=>!this.available.has(row.id));
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
    return {available:this.available.size,total:rows.length,running:!!this.batch,error:this.error};
  }
}
