import { app, net, session } from 'electron';
import { downloadSource, validatePublicSource, waitWithSignal } from './gallery-source-download';

// Explicit repository hosts from the public gallery's reviewed PDF sources.
// The direct downloader still pins DNS for public repositories outside this set.
const repositories = new Set(`
www.osti.gov osti.gov arxiv.org export.arxiv.org research.tue.nl trepo.tuni.fi
backend.orbit.dtu.dk zenodo.org ora.ox.ac.uk vbn.aau.dk repositum.tuwien.at
research.chalmers.se idus.us.es discovery.ucl.ac.uk riuma.uma.es edepot.wur.nl
eartharxiv.org upcommons.upc.edu access.archive-ouverte.unige.ch hss-opus.ub.ruhr-uni-bochum.de
opus.hs-offenburg.de e-archivo.uc3m.es spiral.imperial.ac.uk www.researchsquare.com
publicatio.bibl.u-szeged.hu dr.ntu.edu.sg vtechworks.lib.vt.edu researchportal.murdoch.edu.au
findresearcher.sdu.dk opus.lib.uts.edu.au strathprints.strath.ac.uk biblio.ugent.be
openaccess.city.ac.uk cris.brighton.ac.uk pure-oai.bham.ac.uk avesis.ticaret.edu.tr
hal.science hal.archives-ouvertes.fr publikationen.bibliothek.kit.edu ut3-toulouseinp.hal.science
ris.utwente.nl rfos.fon.bg.ac.rs wrap.warwick.ac.uk eprints.lse.ac.uk publications.tno.nl
ira.lib.polyu.edu.hk opus4.kobv.de nantes-universite.hal.science myresearchspace.uws.ac.uk
uwspace.uwaterloo.ca ir.library.osaka-u.ac.jp pmc-oa-opendata.s3.amazonaws.com
pure.manchester.ac.uk openaccess.thecvf.com proceedings.iclr.cc aclanthology.org
purehost.bath.ac.uk repository.tudelft.nl orbi.umons.ac.be eprints.whiterose.ac.uk
pure.tue.nl centralesupelec.hal.science orbi.uliege.be cora.ucc.ie ktisis.cut.ac.cy
zaguan.unizar.es cf002.cdn.4science.cloud research.dial.uclouvain.be
`.trim().split(/\s+/));

export function checkProxySource(raw: string, kind: 'pdf'|'image') {
  const url = validatePublicSource(raw, kind);
  if (kind === 'pdf' && !repositories.has(url.hostname)) throw new Error('此公开稿机构未列入系统代理图源。');
  return url;
}
async function proxyRead(start: URL, kind: 'pdf'|'image', signal: AbortSignal, ses: Electron.Session) {
  const limit = (kind === 'pdf' ? 48 : 16) * 1024 * 1024;
  let url = start;
  for (let hop = 0; hop <= 4; hop++) {
    signal.throwIfAborted();
    const result = await new Promise<Buffer|URL>((resolve, reject) => {
      const req = net.request({session:ses, url:url.href, redirect:'manual', credentials:'omit',
        headers:{Accept:kind==='pdf'?'application/pdf':'image/*'}});
      const cancel = () => { reject(signal.reason); req.abort(); };
      signal.addEventListener('abort', cancel, {once:true});
      req.once('close', () => signal.removeEventListener('abort', cancel));
      req.once('error', reject);
      req.on('redirect', (_status, _method, next) => {
        try { resolve(checkProxySource(next, kind)); } catch(error) { reject(error); }
        req.abort();
      });
      req.once('response', res => {
        res.once('error', reject);
        if (res.statusCode !== 200 || Number(res.headers['content-length']) > limit) {
          reject(new Error('公开来源响应异常 (HTTP '+res.statusCode+') 或超过大小限制。'));
          req.abort();return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) { reject(new Error('图源文件超过大小限制。')); req.abort(); return; }
          chunks.push(chunk);
        });
        res.once('end', () => resolve(Buffer.concat(chunks,size)));
      });
      req.end();
    });
    if (Buffer.isBuffer(result)) return result;
    url = result;
  }
  throw new Error('图源重定向次数过多。');
}
export async function downloadGallerySource(raw:string,kind:'pdf'|'image',signal:AbortSignal) {
  const url=validatePublicSource(raw,kind);
  if (kind==='pdf' && !repositories.has(url.hostname)) return downloadSource(raw,kind,signal);
  await waitWithSignal(app.whenReady(),signal);
  const ses=session.fromPartition('mkfigure-public-source-network',{cache:false});
  const route=await waitWithSignal(ses.resolveProxy(url.href),signal);
  if (route.split(';')[0].trim() !== 'DIRECT') return proxyRead(url,kind,signal,ses);
  return downloadSource(raw,kind,signal);
}
