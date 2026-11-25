import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';

const blocked = new BlockList();
for (const [ip, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(ip, bits, 'ipv4');
const v6 = new BlockList();
v6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, bits] of [['2001::', 23], ['2001:db8::', 32], ['2002::',16], ['3fff::', 20]] as const) blocked.addSubnet(ip, bits, 'ipv6');

export function publicAddress(address: string) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && v6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
const imageHosts = new Set(['pmc-oa-opendata.s3.amazonaws.com', 'cdn.ncbi.nlm.nih.gov', 'arxiv.org', 'ar5iv.labs.arxiv.org', 'ars.els-cdn.com', 'pubs.rsc.org', 'media.springernature.com']);
export const sourceByteLimit = (kind: 'pdf'|'image') => (kind === 'pdf' ? 48 : 32) * 1024 * 1024;
export function validatePublicSource(raw: string, kind: 'pdf'|'image') {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !url.hostname.includes('.') || isIP(url.hostname) ||
    !/^[a-z\d.-]+$/.test(url.hostname) || /(?:\.|^)(?:localhost|local|internal|test|invalid|onion)$/.test(url.hostname) ||
    (kind === 'image' && !imageHosts.has(url.hostname))) throw new Error('仅支持目录内的公开 HTTPS 学术图源。');
  if(kind==='image' && url.hostname==='media.springernature.com' && !url.pathname.startsWith('/full/springer-static/image/')) throw new Error('仅支持出版社正式图像路径。');
  url.hash = '';
  return url;
}
export function waitWithSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once:true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}
export async function downloadSource(raw: string, kind: 'pdf'|'image', signal: AbortSignal) {
  let url = validatePublicSource(raw,kind);
  const limit = sourceByteLimit(kind);
  for (let hop=0; hop<=4; hop++) {
    const addresses = await waitWithSignal(lookup(url.hostname,{all:true}),signal);
    if (!addresses.length || addresses.some(a=>!publicAddress(a.address))) throw new Error('图源域名未解析为公开 IP 地址。');
    const chosen = addresses.find(a=>a.family===4) || addresses[0];
    const result = await new Promise<Buffer|URL>((resolve,reject)=>{
      const req = request(url,{method:'GET',agent:false,family:chosen.family,signal,
        lookup:(_host,_opts,cb)=>cb(null,chosen.address,chosen.family),
        headers:{accept:kind==='pdf'?'application/pdf':'image/*','accept-encoding':'identity','user-agent':'MKFigure/2.1 (public scholarly figure viewer)'}},res=>{
        const status = res.statusCode || 0;
        res.on('error',reject);
        if ([301,302,303,307,308].includes(status) && res.headers.location) {
          try { resolve(validatePublicSource(new URL(res.headers.location,url).href,kind)); } catch(err){ reject(err); }
          res.destroy(); return;
        }
        if (status!==200 || Number(res.headers['content-length'])>limit) {
          reject(new Error('图源返回 HTTP '+status+' 或文件超过大小限制。')); res.destroy(); return;
        }
        const chunks:Buffer[]=[]; let size=0;
        res.on('data',(chunk:Buffer)=>{
          size+=chunk.length;
          if(size>limit) { reject(new Error('图源文件超过大小限制。'));res.destroy();return; }
          chunks.push(chunk);
        });
        res.on('end',()=>resolve(Buffer.concat(chunks,size)));
      });req.on('error',reject);req.end();
    });
    if (Buffer.isBuffer(result)) return result;
    url=result;
  }
  throw new Error('图源重定向次数过多。');
}
