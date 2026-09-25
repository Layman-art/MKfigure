import type { FigureElement, FigureScene, TextElement } from '../shared/types';
import { normalizePath, safeRasterDataUrl, validateScene } from './schema';
import { escapeXml, fontRuns } from './typography';

const n = (value: number) => String(Math.round(value * 100000) / 100000);
function textMarkup(element: TextElement): string {
  const anchor = element.align === 'center' ? 'middle' : element.align === 'right' ? 'end' : 'start';
  const x = element.x + (anchor === 'middle' ? element.w / 2 : anchor === 'end' ? element.w : 0);
  const lines = element.text.split('\n');
  const lineHeight = element.fontSize * 1.15;
  return `<text x="${n(x)}" y="${n(element.y + element.fontSize * 0.9)}" fill="${element.color}" font-size="${n(element.fontSize)}" font-weight="${element.bold ? '700' : '400'}" text-anchor="${anchor}" xml:space="preserve">${lines.map((line, i) => `<tspan x="${n(x)}" dy="${i ? n(lineHeight) : '0'}">${fontRuns({ ...element, text: line }).map((run) => `<tspan font-family="${run.font}" font-style="${run.italic ? 'italic' : 'normal'}">${escapeXml(run.text)}</tspan>`).join('')}</tspan>`).join('')}</text>`;
}

function elementMarkup(e: FigureElement, assets: Record<string, string>): string {
  const rotation = e.rotation ? ` transform="rotate(${n(e.rotation)} ${n(e.x + e.w / 2)} ${n(e.y + e.h / 2)})"` : '';
  let content: string;
  if (e.type === 'text') content = textMarkup(e);
  else if (e.type === 'line') {
    const marker = (start: boolean) => `mk-arrow-${escapeXml(e.id)}-${start ? 's' : 'e'}`;
    const def = (start: boolean) => `<marker id="${marker(start)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 Z" fill="${e.stroke}" /></marker>`;
    content = `${e.arrowStart || e.arrowEnd ? `<defs>${e.arrowStart ? def(true) : ''}${e.arrowEnd ? def(false) : ''}</defs>` : ''}<line x1="${n(e.x)}" y1="${n(e.y)}" x2="${n(e.x2)}" y2="${n(e.y2)}" stroke="${e.stroke}" stroke-width="${n(e.strokeWidth)}"${e.dash ? ` stroke-dasharray="${n(e.strokeWidth * 4)} ${n(e.strokeWidth * 3)}"` : ''}${e.arrowStart ? ` marker-start="url(#${marker(true)})"` : ''}${e.arrowEnd ? ` marker-end="url(#${marker(false)})"` : ''} />`;
  } else if (e.type === 'image') {
    content = `<image x="${n(e.x)}" y="${n(e.y)}" width="${n(e.w)}" height="${n(e.h)}" preserveAspectRatio="xMidYMid meet" href="${safeRasterDataUrl(assets[e.assetId], e.assetId)}" />`;
  } else if (e.type === 'path') {
    content = `<path d="${escapeXml(normalizePath(e.d))}" transform="translate(${n(e.x)} ${n(e.y)})" fill="${e.fill ?? 'none'}" stroke="${e.stroke ?? 'none'}" stroke-width="${n(e.strokeWidth ?? 0)}"${e.dash ? ` stroke-dasharray="${n((e.strokeWidth ?? 0) * 4)} ${n((e.strokeWidth ?? 0) * 3)}"` : ''} opacity="${n(e.opacity ?? 1)}" stroke-linejoin="round" />`;
  } else {
    const common = `fill="${e.fill}" stroke="${e.stroke ?? 'none'}" stroke-width="${n(e.strokeWidth ?? 0)}" opacity="${n(e.opacity ?? 1)}"`;
    content = e.type === 'rect'
      ? `<rect x="${n(e.x)}" y="${n(e.y)}" width="${n(e.w)}" height="${n(e.h)}" rx="${n(Math.min(e.radius ?? 0, e.w / 2, e.h / 2))}" ${common} />`
      : `<ellipse cx="${n(e.x + e.w / 2)}" cy="${n(e.y + e.h / 2)}" rx="${n(e.w / 2)}" ry="${n(e.h / 2)}" ${common} />`;
  }
  // Composite a line together with its markers so arrowheads share its opacity.
  const opacity = e.type === 'line' && e.opacity !== undefined ? ` opacity="${n(e.opacity)}"` : '';
  return `<g id="element-${escapeXml(e.id)}" data-element-id="${escapeXml(e.id)}"${rotation}${opacity}>${content}</g>`;
}

export function sceneToSvg(input: FigureScene, options: { assets?: Record<string, string> } = {}): string {
  const scene = validateScene(input); const assets = options.assets ?? {};
  const content: string[] = []; let openGroup: string | undefined;
  for (const element of scene.elements) {
    if (element.groupId !== openGroup) {
      if (openGroup) content.push('</g>');
      if (element.groupId) content.push(`<g id="group-${escapeXml(element.groupId)}" data-group="${escapeXml(element.groupId)}">`);
      openGroup = element.groupId;
    }
    content.push(elementMarkup(element, assets));
  }
  if (openGroup) content.push('</g>');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}" role="img" aria-labelledby="mk-title"><title id="mk-title">${escapeXml(scene.title)}</title><rect width="${scene.width}" height="${scene.height}" fill="${scene.background}" />${content.join('')}</svg>`;
}
