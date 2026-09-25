import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { exportPptx, sceneToSvg } from '../src/core';
import type { FigureScene } from '../src/shared/types';

// These tight boxes reproduce PowerPoint splitting ODE into OD/E, ODESolve
// into ODESolv/e, and moving a formula's equals sign onto a second line.
const scene: FigureScene = {
  version: 1, width: 1536, height: 1024, title: 'Text layout regression', background: '#FFFFFF',
  elements: [
    { id: 'title', type: 'text', x: 646, y: 0, w: 117, h: 65, text: 'ODE', fontSize: 56, color: '#062B68', bold: true },
    { id: 'solver', type: 'text', x: 527, y: 633, w: 94, h: 29, text: 'ODESolve', fontSize: 22, color: '#000000', bold: true, align: 'center' },
    { id: 'formula', type: 'text', x: 913, y: 714, w: 26, h: 31, text: ') =', fontSize: 25, color: '#000000', role: 'formula' },
    { id: 'explicit-lines', type: 'text', x: 20, y: 100, w: 80, h: 100, text: '中文 ODE\nsecond line', fontSize: 24, color: '#000000', align: 'right' },
  ],
};
let folder = '';
beforeAll(async () => { folder = await mkdtemp(path.join(tmpdir(), 'mkfigure-text-layout-')); });
afterAll(async () => {
  if (folder && path.dirname(folder) === path.resolve(tmpdir()) && path.basename(folder).startsWith('mkfigure-text-layout-')) await rm(folder, { recursive: true, force: true });
});

it('matches SVG explicit-line layout instead of wrapping native PowerPoint text to box width', async () => {
  const destination = path.join(folder, 'text-layout.pptx');
  await exportPptx(scene, destination);
  const zip = await JSZip.loadAsync(await readFile(destination));
  const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
  const shapes = [...xml.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].map((match) => match[0]);
  expect(shapes).toHaveLength(scene.elements.length);
  for (const shape of shapes) {
    expect(shape).toMatch(/<a:bodyPr\b[^>]*wrap="none"/);
    expect(shape).not.toContain('<a:normAutofit');
    expect(shape).not.toContain('<a:spAutoFit');
  }
  expect(shapes[0]).toContain('<a:t>ODE</a:t>');
  expect(shapes[1]).toContain('algn="ctr"');
  expect(shapes[1]).toContain('<a:t>ODESolve</a:t>');
  expect(shapes[2]).toContain('<a:t>) =</a:t>');
  expect(shapes[3].match(/<a:p>/g)).toHaveLength(2);
  expect(shapes[3]).toContain('algn="r"');
  expect(shapes[3]).toContain('Microsoft YaHei');
  expect(shapes[3]).toContain('Times New Roman');
  expect(xml).not.toContain('<m:oMath');
  expect(xml).not.toContain('<p:pic>');
  expect(sceneToSvg(scene)).toContain('second line');
});
