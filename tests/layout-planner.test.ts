import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { FigureLayoutPlan, WorkspaceApi } from '../src/shared/types';
import LayoutPlanner, { LayoutSketch } from '../src/renderer/components/LayoutPlanner';

describe('layout editor', () => {
  it('draws a split and a merge for a four-panel parallel plan', () => {
    const html = renderToStaticMarkup(React.createElement(LayoutSketch, { arrangement: 'parallel', panels: ['输入','路径 A','路径 B','结果'] }));
    expect(html.match(/<line /g)).toHaveLength(4);
    expect(html.match(/<rect /g)).toHaveLength(4);
    expect(html).toContain('并行分支版式示意');
  });
  it('restores saved panel names, local images and direct citations', () => {
    const plan: FigureLayoutPlan = { arrangement: 'grid', panels: ['基线','本文方法'], referenceIds: ['paper1'], notes: '对比共同坐标',
      citations: [{ id: 'paper1', authors:['A. Author'], title:'Prior paper', venue:'iclr', year: 2024, paper:'https://example.org' }] };
    const html = renderToStaticMarkup(React.createElement(LayoutPlanner, { api: {} as WorkspaceApi, initialQuery: '对比', value: plan, onChange: () => {} }));
    expect(html).toContain('mk-gallery://thumbnail/paper1');
    expect(html).toContain('Prior paper'); expect(html).toContain('对比共同坐标');
    expect(html).toContain('读参考图细化版式'); expect(html).toContain('清空版式');
  });
});
