import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import { writeFile } from 'node:fs/promises';
import type { FigureElement, FigureScene, PathElement } from '../shared/types';
import { elementBounds } from './audit';
import { normalizedSegments, safeRasterDataUrl, validateScene } from './schema';
import { escapeXml, fontRuns } from './typography';

const EMU = 914400;
function rasterDimensions(data: string): { width: number; height: number } {
  const bytes = Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
  let width = 0; let height = 0;
  if (data.startsWith('data:image/png;') && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else if (data.startsWith('data:image/jpeg;') && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0xd9 || marker === 0xda) break;
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + length + 2 > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        height = bytes.readUInt16BE(offset + 5); width = bytes.readUInt16BE(offset + 7); break;
      }
      offset += length + 2;
    }
  } else if (data.startsWith('data:image/webp;')) throw new Error('PPTX 不直接嵌入 WebP，请先将该素材转为 PNG');
  if (!width || !height || width > 32768 || height > 32768 || width * height > 100000000) throw new Error('图片文件格式无效或像素尺寸过大');
  return { width, height };
}
function customGeometry(element: PathElement): string {
  const point = (x: number, y: number) => `<a:pt x="${Math.round(x * 1000)}" y="${Math.round(y * 1000)}"/>`;
  const commands = normalizedSegments(element).map((segment) => {
    const c = segment[0]; const values = segment.slice(1).map(Number);
    if (c === 'Z') return '<a:close/>';
    if (c === 'M') return `<a:moveTo>${point(values[0], values[1])}</a:moveTo>`;
    if (c === 'L') return `<a:lnTo>${point(values[0], values[1])}</a:lnTo>`;
    if (c === 'Q') return `<a:quadBezTo>${point(values[0], values[1])}${point(values[2], values[3])}</a:quadBezTo>`;
    if (c === 'C') return `<a:cubicBezTo>${point(values[0], values[1])}${point(values[2], values[3])}${point(values[4], values[5])}</a:cubicBezTo>`;
    throw new Error(`Unsupported normalized path command: ${c}`);
  }).join('');
  return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="w" b="h"/><a:pathLst><a:path w="${Math.max(1, Math.round(element.w * 1000))}" h="${Math.max(1, Math.round(element.h * 1000))}" fill="${!element.fill || element.fill === 'none' ? 'none' : 'norm'}" stroke="${element.stroke && element.stroke !== 'none' && element.strokeWidth !== 0 ? '1' : '0'}" extrusionOk="0">${commands}</a:path></a:pathLst></a:custGeom>`;
}

function roundedRectPath(e: FigureElement & { radius?: number }): string {
  const r = Math.min(e.radius ?? 0, e.w / 2, e.h / 2); const k = 0.5522847498;
  return `M ${r} 0 L ${e.w - r} 0 C ${e.w - r + r * k} 0 ${e.w} ${r - r * k} ${e.w} ${r} L ${e.w} ${e.h - r} C ${e.w} ${e.h - r + r * k} ${e.w - r + r * k} ${e.h} ${e.w - r} ${e.h} L ${r} ${e.h} C ${r - r * k} ${e.h} 0 ${e.h - r + r * k} 0 ${e.h - r} L 0 ${r} C 0 ${r - r * k} ${r - r * k} 0 ${r} 0 Z`;
}

function groupMarkup(id: string, group: FigureElement[], xml: string[], serial: number, scale: number): string {
  const boxes = group.map(elementBounds);
  const x = Math.min(...boxes.map((b) => b.x)); const y = Math.min(...boxes.map((b) => b.y));
  const w = Math.max(...boxes.map((b) => b.x + b.w)) - x; const h = Math.max(...boxes.map((b) => b.y + b.h)) - y;
  const emu = (value: number) => Math.round(value * scale * EMU);
  // Child coordinates remain absolute: matching parent/child coordinate systems avoid scaling drift.
  return `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${serial}" name="${escapeXml(id)}"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${Math.max(1, emu(w))}" cy="${Math.max(1, emu(h))}"/><a:chOff x="${emu(x)}" y="${emu(y)}"/><a:chExt cx="${Math.max(1, emu(w))}" cy="${Math.max(1, emu(h))}"/></a:xfrm></p:grpSpPr>${xml.join('')}</p:grpSp>`;
}

/** No installed PowerPoint is required. Every component becomes a real DrawingML object. */
export async function exportPptx(input: FigureScene, destination: string, options: { widthMm?: number; assets?: Record<string, string> } = {}): Promise<void> {
  const scene = validateScene(input); const widthMm = options.widthMm ?? 180;
  if (!Number.isFinite(widthMm) || widthMm < 30 || widthMm > 1000) throw new Error('导出宽度必须为 30 至 1000 mm');
  const scale = widthMm / 25.4 / scene.width;
  if (scene.height * scale > 56 || scene.width * scale > 56) throw new Error('画布超出 PowerPoint 的 56 英寸尺寸上限');
  const ppt = new PptxGenJS();
  ppt.defineLayout({ name: 'FIGURE', width: scene.width * scale, height: scene.height * scale }); ppt.layout = 'FIGURE';
  ppt.author = 'MK Figure Studio'; ppt.subject = 'Editable scientific figure'; ppt.title = scene.title;
  ppt.company = 'MK Figure Studio';
  ppt.theme = { headFontFace: 'Times New Roman', bodyFontFace: 'Times New Roman' };
  const slide = ppt.addSlide(); slide.background = { color: scene.background.slice(1) };
  slide.addNotes([...(scene.sourceNotes ?? []), 'All text and vector diagram components are native editable shapes. Formula components use serif text and vector lines; no Office Math objects.', ...(scene.warnings ?? [])].join('\n'));
  const geometry = new Map<string, PathElement>();
  for (const element of scene.elements) {
    const objectName = `mk:${element.id}`;
    const base = { x: element.x * scale, y: element.y * scale, w: element.w * scale, h: element.h * scale, rotate: element.rotation ?? 0, objectName };
    if (element.type === 'text') {
      slide.addText(fontRuns(element).map((run) => ({ text: run.text, options: { fontFace: run.font, italic: run.italic, bold: element.bold ?? false } })), {
        ...base, fontFace: 'Times New Roman', fontSize: element.fontSize * scale * 72,
        color: element.color.slice(1), bold: element.bold ?? false, align: element.align ?? 'left',
        // SVG text only breaks at explicit newlines. PowerPoint's default wrapping
        // splits tight labels and formula components (e.g. ODE becomes OD / E).
        valign: 'top', margin: 0, wrap: false, breakLine: false, paraSpaceAfter: 0, lineSpacingMultiple: 1.0, fit: 'none',
        isTextBox: true, charSpacing: 0, transparency: 0,
      });
    } else if (element.type === 'image') {
      const data = safeRasterDataUrl(options.assets?.[element.assetId], element.assetId);
      const size = rasterDimensions(data); const ratio = Math.min(base.w / size.width, base.h / size.height);
      const w = size.width * ratio; const h = size.height * ratio;
      slide.addImage({ ...base, x: base.x + (base.w - w) / 2, y: base.y + (base.h - h) / 2, w, h, data, altText: element.assetId });
    } else if (element.type === 'line') {
      const x = Math.min(element.x, element.x2); const y = Math.min(element.y, element.y2);
      const w = Math.max(0.001, Math.abs(element.x2 - element.x)); const h = Math.max(0.001, Math.abs(element.y2 - element.y));
      slide.addShape(ppt.ShapeType.rect, {
        ...base, x: x * scale, y: y * scale, w: w * scale, h: h * scale,
        fill: { color: 'FFFFFF', transparency: 100 },
        line: { color: element.stroke === 'none' ? 'FFFFFF' : element.stroke.slice(1), transparency: element.stroke === 'none' ? 100 : (1 - (element.opacity ?? 1)) * 100, width: element.strokeWidth * scale * 72, dashType: element.dash ? 'dash' : 'solid', beginArrowType: element.arrowStart ? 'triangle' : undefined, endArrowType: element.arrowEnd ? 'triangle' : undefined },
      });
      geometry.set(objectName, { ...element, type: 'path', x, y, w, h, d: `M ${element.x - x} ${element.y - y} L ${element.x2 - x} ${element.y2 - y}`, fill: 'none' });
    } else {
      const opacity = element.opacity ?? 1; const fill = element.fill ?? 'none'; const stroke = element.stroke ?? 'none';
      slide.addShape(element.type === 'ellipse' ? ppt.ShapeType.ellipse : ppt.ShapeType.rect, {
        ...base, fill: { color: fill === 'none' ? 'FFFFFF' : fill.slice(1), transparency: fill === 'none' ? 100 : (1 - opacity) * 100 },
        line: { color: stroke === 'none' ? 'FFFFFF' : stroke.slice(1), transparency: stroke === 'none' ? 100 : (1 - opacity) * 100, width: (element.strokeWidth ?? 0) * scale * 72, ...(element.type === 'path' ? { dashType: element.dash ? 'dash' as const : 'solid' as const } : {}) },
      });
      if (element.type === 'path') geometry.set(objectName, element);
      if (element.type === 'rect' && element.radius) geometry.set(objectName, { ...element, type: 'path', d: roundedRectPath(element) });
    }
  }
  const buffer = await ppt.write({ outputType: 'nodebuffer' }) as Buffer;
  const zip = await JSZip.loadAsync(buffer); const slideFile = 'ppt/slides/slide1.xml';
  const file = zip.file(slideFile); if (!file) throw new Error('PPTX 构建缺少 slide1.xml');
  let xml = await file.async('string');
  const objects = [...xml.matchAll(/<p:(?:sp|pic)>[\s\S]*?<\/p:(?:sp|pic)>/g)];
  if (objects.length !== scene.elements.length) throw new Error('PPTX 原生对象数量不一致，已停止导出');
  const objectXml = objects.map((match, index) => {
    const element = scene.elements[index];
    if (!match[0].includes(`name="${escapeXml(`mk:${element.id}`)}"`)) throw new Error(`PPTX 元素顺序异常: ${element.id}`);
    const path = geometry.get(`mk:${element.id}`);
    if (!path) return match[0];
    if (!/<a:prstGeom\b/.test(match[0])) throw new Error('PPTX 缺少可替换的形状几何');
    return match[0].replace(/<a:prstGeom\b[^>]*>[\s\S]*?<\/a:prstGeom>/, customGeometry(path));
  });
  const body: string[] = []; let i = 0; let groupSerial = scene.elements.length + 100;
  while (i < scene.elements.length) {
    const id = scene.elements[i].groupId;
    if (!id) { body.push(objectXml[i]); i++; continue; }
    let end = i + 1; while (end < scene.elements.length && scene.elements[end].groupId === id) end++;
    body.push(groupMarkup(id, scene.elements.slice(i, end), objectXml.slice(i, end), groupSerial++, scale)); i = end;
  }
  const first = objects[0].index!; const last = objects.at(-1)!; const after = last.index! + last[0].length;
  xml = xml.slice(0, first) + body.join('') + xml.slice(after);
  if (xml.includes('<m:oMath') || xml.includes('<m:oMathPara')) throw new Error('导出中意外包含 Office Math');
  zip.file(slideFile, xml);
  await writeFile(destination, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
