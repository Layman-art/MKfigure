import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { FigureScene } from '../src/shared/types';
import { exportPptx, sceneToSvg, validateScene } from '../src/core';

// Minimal regression fixture from the real reconstruction response: preserve all three styles.
function sample(): FigureScene {
  return { version: 1, width: 1400, height: 900, title: 'Dashed signal routes', background: '#FFFFFF', elements: [
    { id: 'dash1', type: 'path', x: 653, y: 427, w: 82, h: 101, d: 'M 82 0 C 50 2 35 10 35 25 L 35 80 C 20 80 10 82 0 101', fill: 'none', stroke: '#6B7690', strokeWidth: 4, dash: true, opacity: 0.9 },
    { id: 'dash2', type: 'line', x: 871, y: 520, x2: 871, y2: 460, w: 0, h: 60, stroke: '#6B7690', strokeWidth: 4, arrowEnd: true, arrowStart: false, dash: true, opacity: 0.9 },
    { id: 'dash3', type: 'path', x: 1076, y: 397, w: 45, h: 129, d: 'M 0 0 L 0 120 C 17 120 35 120 45 129', fill: 'none', stroke: '#6B7690', strokeWidth: 4, dash: true, opacity: 0.9 },
  ] };
}
let folder = '';
beforeAll(async () => { folder = await mkdtemp(path.join(tmpdir(), 'mkfigure-line-style-')); });
afterAll(async () => {
  if (folder && path.resolve(folder).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(folder).startsWith('mkfigure-line-style-')) await rm(folder, { recursive: true, force: true });
});

describe('dashed paths and translucent line regression', () => {
  it('accepts the observed styles while rejecting invalid style values', () => {
    expect(validateScene(sample()).elements).toEqual(sample().elements);
    const s = sample();
    expect(() => validateScene({ ...s, elements: [{ ...s.elements[0], dash: 'true' }] })).toThrow(/布尔/);
    expect(() => validateScene({ ...s, elements: [{ ...s.elements[1], opacity: 1.01 }] })).toThrow(/0 至 1/);
    expect(() => validateScene({ ...s, elements: [{ ...s.elements[1], opacity: -0.01 }] })).toThrow(/0 至 1/);
    expect(() => validateScene({ ...s, elements: [{ ...s.elements[1], opacity: '0.9' }] })).toThrow(/有限数字/);
  });
  it('exports SVG dashes and composites line opacity with its arrow marker', () => {
    const svg = sceneToSvg(sample());
    expect(XMLValidator.validate(svg)).toBe(true);
    const groups = new XMLParser({ ignoreAttributes: false }).parse(svg).svg.g;
    for (const index of [0, 2]) {
      expect(groups[index].path['@_stroke-dasharray']).toBe('16 12');
      expect(groups[index].path['@_opacity']).toBe('0.9');
    }
    const arrow = groups[1];
    expect(arrow['@_opacity']).toBe('0.9');
    expect(arrow.line['@_stroke-dasharray']).toBe('16 12');
    expect(arrow.line['@_marker-end']).toBe('url(#mk-arrow-dash2-e)');
    expect(arrow.defs.marker.path['@_fill']).toBe('#6B7690');
    // Opacity belongs to their shared parent, not only to the line stroke.
    expect(arrow.line['@_opacity']).toBeUndefined();
    expect(arrow.line['@_stroke-opacity']).toBeUndefined();
  });
  it('preserves DrawingML dashed strokes, alpha and the reverse arrow in editable PPTX', async () => {
    const file = path.join(folder, 'dashed-paths.pptx');
    await exportPptx(sample(), file);
    const zip = await JSZip.loadAsync(await readFile(file));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    expect(XMLValidator.validate(xml)).toBe(true);
    const shapes = new XMLParser({ ignoreAttributes: false }).parse(xml)['p:sld']['p:cSld']['p:spTree']['p:sp'];
    expect(shapes).toHaveLength(3);
    for (const shape of shapes) {
      expect(shape['p:spPr']['a:custGeom']).toBeDefined();
      const line = shape['p:spPr']['a:ln'];
      expect(line['a:prstDash']['@_val']).toBe('dash');
      expect(Number(line['a:solidFill']['a:srgbClr']['a:alpha']['@_val'])).toBe(90000);
    }
    expect(shapes[1]['p:spPr']['a:ln']['a:tailEnd']['@_type']).toBe('triangle');
    const lineGeometry = shapes[1]['p:spPr']['a:custGeom']['a:pathLst']['a:path'];
    expect(Number(lineGeometry['a:moveTo']['a:pt']['@_y'])).toBe(60000);
    expect(Number(lineGeometry['a:lnTo']['a:pt']['@_y'])).toBe(0);
    expect(xml).not.toContain('<p:pic>');
    expect(xml).not.toContain('<m:oMath');
  });
});
