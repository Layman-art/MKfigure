import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeImage } from 'electron';
import JSZip from 'jszip';
import { XMLParser } from 'fast-xml-parser';
import pdf from 'pdf-parse';
import type { Asset } from '../shared/types';
import type { Store } from './storage';

const MAX_BYTES = 30 * 1024 * 1024;
const mimeMap: Record<string,string> = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.pdf':'application/pdf','.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation','.txt':'text/plain','.md':'text/markdown' };
function collectText(value: unknown, output: string[]) {
  if (!value || typeof value !== 'object') return;
  for (const [key,v] of Object.entries(value)) {
    if ((key === 'a:t' || key === 't') && (typeof v === 'string' || typeof v === 'number')) output.push(String(v));
    else if ((key === 'a:t' || key === 't') && v && typeof v === 'object' && '#text' in v) output.push(String((v as Record<string,unknown>)['#text']));
    else if (Array.isArray(v)) v.forEach(item => collectText(item, output)); else collectText(v, output);
  }
}
export async function importAsset(store: Store, projectId: string, file: string): Promise<Asset> {
  const stat = await fs.stat(file); if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('请选择不超过 30 MB 的文件');
  const ext = path.extname(file).toLowerCase(); const mime = mimeMap[ext]; if (!mime) throw new Error('支持 PNG、JPEG、WebP、PDF、PPTX、TXT 和 Markdown');
  const id = randomUUID(); const target = path.join(store.projectDir(projectId), 'assets', id + ext); const buffer = await fs.readFile(file);
  const asset: Asset = { id, name:path.basename(file), mime, path: id + ext, kind: mime.startsWith('image/') ? 'image' : ext === '.pdf' ? 'pdf' : ext === '.pptx' ? 'pptx' : 'text' };
  if (asset.kind === 'image') {
    const img = nativeImage.createFromBuffer(buffer); if (img.isEmpty()) throw new Error('无法读取该图片，请转成 PNG 或 JPEG 后重试');
    const size = img.getSize(); if (size.width > 10000 || size.height > 10000 || size.width * size.height > 40000000) throw new Error('图片过大，请缩小到 4000 万像素以内'); Object.assign(asset, size);
  } else if (asset.kind === 'pdf') {
    try {
      const result = await pdf(buffer, { pagerender: async (page: any) => { const c = await page.getTextContent(); return `\n[Page ${page.pageNumber}]\n${c.items.map((x: any) => x.str || '').join(' ')}`; } });
      asset.text = result.text.slice(0, 150000); asset.warnings = [];
      if (!asset.text.trim()) asset.warnings.push('未提取到文字，可能是扫描版；请另提供图片或文字说明');
      if (result.text.length > 150000) asset.warnings.push('文字较长，已保留前 150,000 个字符；请核对需要表达的章节');
      asset.warnings.push('PDF 图表与公式需在生成前核对，文字提取不代表完整视觉阅读');
    } catch { asset.warnings = ['PDF 文字提取失败；原文件已保存，请补充方法摘要或页面图片']; asset.text = ''; }
  } else if (asset.kind === 'pptx') {
    const zip = await JSZip.loadAsync(buffer); const parser = new XMLParser({ ignoreAttributes:false, parseTagValue:false, trimValues:false }); const lines: string[] = [];
    const slides = Object.keys(zip.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a,b) => Number(a.match(/slide(\d+)/)![1])-Number(b.match(/slide(\d+)/)![1]));
    if (slides.length > 300) throw new Error('PPT 页数过多，请提取相关页面后导入');
    for (const [i,name] of slides.entries()) { const xml = await zip.file(name)!.async('string'); if (xml.length > 10000000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('PPT 内容超出支持范围'); const items: string[]=[]; collectText(parser.parse(xml),items); lines.push(`[Slide ${i+1}]\n${items.join('\n')}`); }
    asset.text = lines.join('\n\n').slice(0,150000); asset.warnings = ['已提取 PPT 文字；作为视觉风格参考时，请另上传页面 PNG/JPEG'];
  } else { asset.text = buffer.toString('utf8').slice(0,150000); }
  await fs.copyFile(file,target); return asset;
}
export async function addGeneratedImage(store: Store, projectId: string, result: {path?:string;dataUrl?:string}): Promise<Asset> {
  let buffer: Buffer;
  if (result.dataUrl) { const m = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(result.dataUrl); if (!m) throw new Error('图像服务没有返回支持的图片数据'); buffer = Buffer.from(m[1], 'base64'); }
  else if (result.path) { const stat = await fs.stat(result.path); if (stat.size > MAX_BYTES) throw new Error('生成图片超过大小限制'); buffer = await fs.readFile(result.path); }
  else throw new Error('图像服务没有返回图片');
  if (buffer.length > MAX_BYTES) throw new Error('生成图片超过大小限制'); const img = nativeImage.createFromBuffer(buffer); if (img.isEmpty()) throw new Error('返回的内容不是有效图片');
  const size = img.getSize(); if (size.width*size.height > 40000000) throw new Error('生成图片像素过大');
  const id = randomUUID(); const name = `${id}.png`; await fs.writeFile(path.join(store.projectDir(projectId),'assets',name),img.toPNG());
  return { id, name: `视觉稿 ${new Date().toLocaleTimeString('zh-CN')}.png`, kind:'image', mime:'image/png', path:name, ...size };
}
