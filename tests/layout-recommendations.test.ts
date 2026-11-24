import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PaperFigure } from '../src/shared/types';
import { LayoutRecommender } from '../src/main/layout-recommendations';
import { PaperGallery } from '../src/main/paper-gallery';

const resources = path.resolve('resources');
const engine = new LayoutRecommender(path.join(resources, 'layout-index'));
let figures: PaperFigure[];
beforeAll(async () => { figures = JSON.parse(await fs.readFile(path.join(resources, 'paper-gallery/data/figures.json'), 'utf8')); });

describe('offline layout recommendations', () => {
  it('matches a Chinese robotics query to evidence in paper text', async () => {
    const list = await engine.recommend(figures, '机器人 扩散 策略');
    expect(list).toHaveLength(6);
    expect(list.some(({ figure }) => /robot/i.test(figure.title) && /policy/i.test(figure.title) && /diffusion/i.test(figure.title))).toBe(true);
    expect(list[0].reason).toMatch(/标题含/);
    expect(list[0].figure.paper).toMatch(/^https?:/);
  });
  it('finds concrete branch and fusion terms and distinguishes the catalog tag', async () => {
    const list = await engine.recommend(figures, '双分支 特征融合');
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].reason).toMatch(/(?:branch|stream)/);
    expect(list[0].reason).toMatch(/fusion|fusing|fused/);
    const ids = new Set(figures.map(f => f.id));
    expect(list.every(item => ids.has(item.figure.id))).toBe(true);
  });
  it('respects the available ID set and gives no guessed evidence', async () => {
    expect(await engine.recommend(figures, '这是一句无对应术语的测试')).toEqual([]);
    expect(await engine.recommend([], 'architecture')).toEqual([]);
    const subset = figures.slice(0, 30);
    const rows = await engine.recommend(subset, '流程图');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => subset.some(f => f.id === r.figure.id))).toBe(true);
    const fromPattern = await engine.recommend(figures.filter(f => f.pattern === 'results'), '结果图');
    expect(fromPattern.every(r => r.reason.includes('图库标注为结果图'))).toBe(true);
  });
  it('recommends individually numbered results from their visual form in Chinese', async () => {
    const rows = await new PaperGallery(path.join(resources, 'paper-gallery')).list();
    const list = await engine.recommend(rows, '三维点云算例结果图');
    expect(list.some(({figure}) => figure.supplement?.category === 'result' &&
      figure.supplement.dimensions?.includes('3d') && figure.supplement.forms?.includes('pointcloud'))).toBe(true);
  });
});
