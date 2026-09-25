import { XMLParser, XMLValidator } from 'fast-xml-parser';

const TAGS = new Set('svg g defs path rect circle ellipse line polyline polygon text tspan title desc linearGradient radialGradient stop clipPath mask pattern use symbol marker textPath'.split(' '));
const ATTRIBUTES = new Set(('id class xmlns xmlns:xlink xml:space x y x1 x2 y1 y2 cx cy r rx ry width height viewBox preserveAspectRatio d points transform opacity fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset clip-rule clip-path mask filter style href xlink:href color font-family font-size font-weight font-style font-variant text-anchor dominant-baseline alignment-baseline baseline-shift letter-spacing word-spacing textLength lengthAdjust dx dy rotate gradientUnits gradientTransform spreadMethod offset stop-color stop-opacity fx fy fr patternUnits patternContentUnits patternTransform clipPathUnits maskUnits maskContentUnits markerWidth markerHeight markerUnits orient refX refY marker-start marker-mid marker-end overflow vector-effect paint-order role aria-label version').split(' '));
const CSS = new Set('opacity fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset clip-rule clip-path mask color font-family font-size font-weight font-style font-variant text-anchor dominant-baseline alignment-baseline baseline-shift letter-spacing word-spacing stop-color stop-opacity marker-start marker-mid marker-end overflow vector-effect paint-order'.split(' '));

function staticValue(value: string) {
  if (/[\\@]|\/\*|(?:https?|file|javascript|data):|\/\/|expression\s*\(|-moz-binding|behavior\s*:/i.test(value)) throw new Error('SVG 不能包含外部资源或动态样式');
  for (const match of value.matchAll(/url\s*\(([^)]*)\)/gi)) {
    if (!/^['"]?#[\w.-]+['"]?$/.test(match[1].trim())) throw new Error('SVG 只允许文件内部的图形引用');
  }
  if (/url/i.test(value.replace(/url\s*\([^)]*\)/gi, ''))) throw new Error('SVG 资源引用格式无效');
}

/** Restrict imported SVGs to static vector markup before passing them to Chromium. */
export function validateLibrarySvg(svg: string): { width: number; height: number } {
  if (/<!DOCTYPE|<!ENTITY|<\?(?!xml\s)/i.test(svg)) throw new Error('SVG 不能包含文档实体或处理指令');
  if (XMLValidator.validate(svg) !== true) throw new Error('SVG 文件格式无效');
  const document = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', preserveOrder: true, processEntities: true }).parse(svg) as Array<Record<string, unknown>>;
  const roots = document.filter(row => !Object.keys(row).some(key => key.startsWith('?') || key === '#text'));
  if (roots.length !== 1 || !Array.isArray(roots[0].svg)) throw new Error('文件必须包含一个 SVG 根节点');
  let count = 0;
  function visit(rows: Array<Record<string, unknown>>, depth: number) {
    if (depth > 48) throw new Error('SVG 图层过深');
    for (const row of rows) {
      for (const [tag, children] of Object.entries(row)) {
        if (tag === ':@' || tag === '#text') continue;
        if (!TAGS.has(tag) || ++count > 20000) throw new Error('SVG 包含不支持的动态元素或图形过多');
        for (const [name, raw] of Object.entries((row[':@'] || {}) as Record<string, unknown>)) {
          const value = String(raw);
          if (!ATTRIBUTES.has(name) || /^on/i.test(name)) throw new Error(`SVG 不支持属性 ${name}`);
          if (name === 'xmlns' || name === 'xmlns:xlink') {
            if (value !== (name === 'xmlns' ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xlink')) throw new Error('SVG 命名空间无效');
          } else if (name === 'href' || name === 'xlink:href') {
            if (!/^#[\w.-]+$/.test(value)) throw new Error('SVG 只允许文件内部的图形引用');
          } else if (name === 'style') {
            staticValue(value);
            for (const rule of value.split(';').filter(part => part.trim())) {
              const colon = rule.indexOf(':');
              if (colon < 0 || !CSS.has(rule.slice(0, colon).trim().toLowerCase())) throw new Error('SVG 含有不支持的样式');
            }
          } else staticValue(value);
        }
        if (Array.isArray(children)) visit(children as Array<Record<string, unknown>>, depth + 1);
      }
    }
  }
  visit(roots, 0);
  const attrs = (roots[0][':@'] || {}) as Record<string, unknown>;
  const length = (value: unknown) => typeof value === 'string' && /^\d+(?:\.\d+)?(?:px)?$/.test(value) ? parseFloat(value) : undefined;
  let width = length(attrs.width), height = length(attrs.height);
  if (!width || !height) {
    const box = String(attrs.viewBox || '').trim().split(/[\s,]+/).map(Number);
    if (box.length !== 4 || !box.every(Number.isFinite)) throw new Error('SVG 需要有效的尺寸或 viewBox');
    width = box[2]; height = box[3];
  }
  return { width, height };
}

/** Inspect dimensions before asking an image decoder to allocate a pixel buffer. */
export function rasterDimensions(buffer: Buffer, extension: string): { width: number; height: number } {
  if (extension === 'png' && buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && buffer.toString('ascii', 12, 16) === 'IHDR') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (['jpg', 'jpeg'].includes(extension) && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= buffer.length) {
      if (buffer[at++] !== 0xff) break;
      while (buffer[at] === 0xff) at++;
      const marker = buffer[at++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (at + 2 > buffer.length) break;
      const size = buffer.readUInt16BE(at);
      if (size < 2 || at + size > buffer.length) break;
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && size >= 8) {
        return { height: buffer.readUInt16BE(at + 3), width: buffer.readUInt16BE(at + 5) };
      }
      at += size;
    }
  }
  if (extension === 'webp' && buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buffer.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      if (buffer[20] & 0x02) throw new Error('暂不支持动态 WebP，请导入静态图片');
      return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    }
    if (kind === 'VP8 ' && buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L' && buffer[20] === 0x2f) return { width: 1 + (((buffer[22] & 0x3f) << 8) | buffer[21]), height: 1 + (((buffer[24] & 0x0f) << 10) | (buffer[23] << 2) | (buffer[22] >> 6)) };
  }
  throw new Error('图片格式与扩展名不符，或文件已损坏');
}
