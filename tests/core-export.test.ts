import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { FigureScene } from '../src/shared/types';
import { auditScene, exportPptx, sceneToSvg, validateScene } from '../src/core';
import { EXAMPLE_SCENE } from './fixtures/example-scene';
import { normalizePath } from '../src/core/schema';
import { fontRuns } from '../src/core/typography';

let folder = '';
beforeAll(async () => { folder = await mkdtemp(path.join(tmpdir(), 'mkfigure-core-')); });
afterAll(async () => {
  if (folder && path.resolve(folder).startsWith(path.resolve(tmpdir()) + path.sep) && path.basename(folder).startsWith('mkfigure-core-')) await rm(folder, { recursive: true, force: true });
});
function sample(): FigureScene {
  return { version: 1, width: 300, height: 200, title: 'Test', background: '#FFFFFF', elements: [
    { id: 'label', type: 'text', x: 20, y: 20, w: 240, h: 35, text: '中文 Neural ODE & <x>', fontSize: 24, color: '#123456' },
    { id: 'curve', type: 'path', groupId: 'formula', x: 20, y: 70, w: 100, h: 60, d: 'M 0 50 C 20 40 30 0 50 10 Q 80 0 100 50', fill: 'none', stroke: '#238B8E', strokeWidth: 2 },
    { id: 'math', type: 'text', groupId: 'formula', role: 'formula', x: 130, y: 75, w: 150, h: 35, text: 'x + 2 = sin(t)', fontSize: 22, color: '#18334B' },
    { id: 'arrow', type: 'line', x: 240, y: 165, x2: 50, y2: 145, w: 190, h: 20, stroke: '#C77D44', strokeWidth: 2, arrowStart: true, arrowEnd: true },
  ] };
}
async function exported(scene: FigureScene, name = 'sample') {
  const file = path.join(folder, `${name}.pptx`); await exportPptx(scene, file);
  const zip = await JSZip.loadAsync(await readFile(file));
  const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  return { file, zip, xml };
}

describe('strict scene validation', () => {
  it('accepts the bundled scientific example without structural errors', () => {
    expect(validateScene(EXAMPLE_SCENE).elements.length).toBeGreaterThan(60);
    expect(auditScene(EXAMPLE_SCENE).structuralPassed).toBe(true);
    expect(auditScene(EXAMPLE_SCENE).visualReview).toBe('pending');
  });
  it('rejects malformed numbers, duplicate IDs, URLs and executable fields', () => {
    expect(() => validateScene({ ...sample(), width: Infinity })).toThrow();
    expect(() => validateScene({ ...sample(), elements: [...sample().elements, sample().elements[0]] })).toThrow(/ID/);
    const s = sample();
    expect(() => validateScene({ ...s, elements: [{ ...s.elements[0], onload: 'evil()' }] })).toThrow(/字段/);
    expect(() => validateScene({ ...s, background: 'url(https://evil.test/x)' })).toThrow(/颜色/);
  });
  it('enforces bounded scene complexity and rejects invalid paths', () => {
    expect(() => validateScene({ ...sample(), elements: Array(1501).fill(sample().elements[0]) })).toThrow();
    expect(() => normalizePath('M 0 0 L NaN 10')).toThrow();
    expect(() => normalizePath('M 0 0 L 1e999 10')).toThrow();
    expect(() => normalizePath('M 0 0 <script>alert(1)</script>')).toThrow();
    expect(() => normalizePath('M 0 0 L 10')).toThrow();
  });
  it('rejects noncontiguous groups rather than silently changing z-order', () => {
    const s = sample(); s.elements[3].groupId = undefined;
    s.elements.push({ ...s.elements[2], id: 'detached-group' });
    expect(() => validateScene(s)).toThrow(/连续/);
  });
  it('normalizes relative, shorthand and arc paths to native commands', () => {
    const normalized = normalizePath('M 0 10 h 20 v 10 q 10 -10 20 0 t 20 0 a 10 10 0 0 1 20 0 z');
    expect(normalized).not.toMatch(/[hHvVaAsStTqz]/);
    expect(normalized).toContain('C'); expect(normalized).toContain('Q'); expect(normalized).toContain('Z');
  });
});

describe('editable SVG and typography', () => {
  it('escapes untrusted text and preserves real grouped text and paths', () => {
    const s = sample(); s.title = '<script>alert("x")</script>';
    const svg = sceneToSvg(s);
    expect(XMLValidator.validate(svg)).toBe(true);
    expect(svg).toContain('&lt;script&gt;'); expect(svg).not.toContain('<script>');
    expect(svg).toContain('data-group="formula"'); expect(svg).toContain('<text'); expect(svg).toContain('<path');
    expect(svg).toContain('font-family="Microsoft YaHei"'); expect(svg).toContain('font-family="Times New Roman"');
    expect(svg).toContain('&amp;'); expect(svg).toContain('&lt;x&gt;');
  });
  it('sets variables italic but functions, numbers and operators upright', () => {
    const e = sample().elements[2]; if (e.type !== 'text') throw new Error('Test fixture');
    const runs = fontRuns(e);
    expect(runs.find((r) => r.text === 'x')?.italic).toBe(true);
    expect(runs.filter((r) => r.text.includes('2') || r.text.includes('sin')).every((r) => !r.italic)).toBe(true);
    expect(runs.map((r) => r.text).join('')).toBe(e.text);
  });
  it('rejects all external images and active SVG data URLs', () => {
    const s = sample(); s.elements.push({ id: 'photo', type: 'image', x: 10, y: 100, w: 50, h: 50, assetId: 'photo' });
    expect(() => sceneToSvg(s, { assets: { photo: 'https://evil.test/image.png' } })).toThrow(/远程/);
    expect(() => sceneToSvg(s, { assets: { photo: 'data:image/svg+xml;base64,PHN2Zz4=' } })).toThrow();
    expect(() => sceneToSvg(s)).toThrow();
  });
  it('flags an image-only wrap and a full-page raster as failures', () => {
    const s = sample(); s.elements = [{ id: 'screenshot', type: 'image', x: 0, y: 0, w: 300, h: 200, assetId: 'original' }];
    const qa = auditScene(s);
    expect(qa.structuralPassed).toBe(false);
    expect(qa.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['IMAGE_ONLY', 'PAGE_RASTER']));
  });
  it('reports out-of-bounds and large text overlaps without claiming visual approval', () => {
    const s = sample(); s.elements.push({ ...s.elements[0], id: 'overlap' }); s.elements[0].x = -10;
    const qa = auditScene(s);
    expect(qa.issues.some((i) => i.code === 'OUT_OF_BOUNDS')).toBe(true);
    expect(qa.issues.some((i) => i.code === 'TEXT_OVERLAP')).toBe(true);
    expect(qa.visualReview).toBe('pending');
  });
  it('checks actual Bézier extrema instead of trusting a path box or its control points', () => {
    const s = sample(); const curve = s.elements[1]; if (curve.type !== 'path') throw new Error('fixture');
    curve.d = 'M 0 20 Q 800 20 100 20';
    expect(auditScene(s).issues.map((i) => i.code)).toContain('PATH_OUT_OF_BOUNDS');
    curve.d = 'M 0 20 Q 150 20 100 20';
    // The actual maximum is 112.5, although the control point is at 150.
    curve.w = 120;
    expect(auditScene(s).issues.map((i) => i.code)).not.toContain('PATH_LOCAL_BOUNDS');
  });
});

describe('native PowerPoint export', () => {
  it('embeds only explicitly supplied raster assets and preserves their aspect ratio', async () => {
    const s = sample(); s.elements.push({ id: 'photo', type: 'image', x: 10, y: 120, w: 80, h: 40, assetId: 'photo' });
    const file = path.join(folder, 'independent-photo.pptx');
    const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=';
    await exportPptx(s, file, { assets: { photo } });
    const zip = await JSZip.loadAsync(await readFile(file));
    const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
    const image = xml.match(/<p:pic>[\s\S]*?<\/p:pic>/)?.[0];
    expect(image).toContain('name="mk:photo"');
    expect(image).toContain('<a:off x="648000" y="2592000"/>');
    expect(image).toContain('<a:ext cx="864000" cy="864000"/>');
    expect(Object.keys(zip.files).filter((p) => p.startsWith('ppt/media/') && !zip.files[p].dir)).toHaveLength(1);
    await expect(exportPptx(s, path.join(folder, 'no-assets.pptx'))).rejects.toThrow(/素材/);
  });
  it('creates native paths, editable mixed-font text and actual groups without OMML or pictures', async () => {
    const { xml, zip } = await exported(sample());
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).toContain('<p:grpSp>'); expect(xml).toContain('name="formula"');
    expect(xml).toContain('<a:custGeom>'); expect(xml).toContain('<a:cubicBezTo>'); expect(xml).toContain('<a:quadBezTo>');
    expect(xml).toContain('<a:t>'); expect(xml).toContain('Times New Roman'); expect(xml).toContain('Microsoft YaHei');
    expect(xml).toContain('type="triangle"');
    expect(xml).not.toContain('<m:oMath'); expect(xml).not.toContain('<p:pic>');
    expect(Object.keys(zip.files).filter((p) => p.startsWith('ppt/media/') && !zip.files[p].dir)).toHaveLength(0);
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml);
    expect(parsed['p:sld']['p:cSld']['p:spTree']['p:grpSp']['p:sp']).toHaveLength(2);
  });
  it('preserves group coordinates and reverse arrow geometry', async () => {
    const { xml } = await exported(sample(), 'geometry');
    const scale = 180 / 25.4 / 300;
    const expectedX = Math.round(20 * scale * 914400);
    expect(xml).toContain(`<a:chOff x="${expectedX}"`);
    // Reverse arrow local path is right/bottom to left/top, not mirrored incorrectly.
    expect(xml).toContain('<a:moveTo><a:pt x="190000" y="20000"/></a:moveTo><a:lnTo><a:pt x="0" y="0"/></a:lnTo>');
  });
  it('survives editing text, moving an object and changing formula components then re-exporting', async () => {
    const s = sample(); const label = s.elements[0]; const math = s.elements[2];
    if (label.type !== 'text' || math.type !== 'text') throw new Error('Test fixture');
    label.text = 'Edited title'; s.elements[1].x = 30; math.text = 'y + 3 = cos(t)';
    const { xml } = await exported(validateScene(s), 'edited');
    expect(xml).toContain('Edited title'); expect(xml).not.toContain('Neural ODE'); expect(xml).toContain('cos(');
    expect(XMLValidator.validate(xml)).toBe(true);
    const svg = sceneToSvg(s); expect(svg).toContain('translate(30 70)'); expect(svg).toContain('Edited title');
  });
  it('exports the entire offline scientific example as native editable objects', async () => {
    const { xml, zip } = await exported(EXAMPLE_SCENE, 'offline-example');
    expect(XMLValidator.validate(xml)).toBe(true);
    expect((xml.match(/<p:sp>/g) ?? []).length).toBe(EXAMPLE_SCENE.elements.length);
    expect((xml.match(/<p:grpSp>/g) ?? []).length).toBeGreaterThanOrEqual(3);
    for (const entry of Object.keys(zip.files).filter((p) => p.endsWith('.xml'))) {
      expect(XMLValidator.validate(await zip.file(entry)!.async('string')), entry).toBe(true);
    }
  });
});
