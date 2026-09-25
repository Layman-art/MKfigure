import type { FigureElement, FigureScene, QaIssue, QaReport } from '../shared/types';
import { validateScene } from './schema';
import { pathBounds } from './path-bounds';

export function elementBounds(element: FigureElement) {
  if (element.type === 'line') return { x: Math.min(element.x, element.x2), y: Math.min(element.y, element.y2), w: Math.abs(element.x2 - element.x), h: Math.abs(element.y2 - element.y) };
  if (!element.rotation) return { x: element.x, y: element.y, w: element.w, h: element.h };
  const r = element.rotation * Math.PI / 180;
  const w = Math.abs(element.w * Math.cos(r)) + Math.abs(element.h * Math.sin(r));
  const h = Math.abs(element.w * Math.sin(r)) + Math.abs(element.h * Math.cos(r));
  return { x: element.x + (element.w - w) / 2, y: element.y + (element.h - h) / 2, w, h };
}

export function auditScene(input: FigureScene): QaReport {
  const issues: QaIssue[] = []; let scene: FigureScene;
  try { scene = validateScene(input); }
  catch (error) { return { structuralPassed: false, visualReview: 'pending', issues: [{ severity: 'error', code: 'INVALID_SCENE', message: (error as Error).message }], textCount: 0, shapeCount: 0, rasterCount: 0, checkedAt: new Date().toISOString() }; }
  const text = scene.elements.filter((e) => e.type === 'text');
  const images = scene.elements.filter((e) => e.type === 'image');
  for (const e of scene.elements) {
    const b = elementBounds(e);
    if (b.x < -0.01 || b.y < -0.01 || b.x + b.w > scene.width + 0.01 || b.y + b.h > scene.height + 0.01) issues.push({ severity: 'warning', code: 'OUT_OF_BOUNDS', message: '元素超出画布，可能在导出时被裁切。', elementId: e.id });
    if (e.type === 'text') {
      if (e.h < e.fontSize * 0.8) issues.push({ severity: 'warning', code: 'TEXT_HEIGHT', message: '文字框高度小于字号，需要检查截断。', elementId: e.id });
      if (e.text.includes('\n') && e.text.split('\n').length * e.fontSize * 1.1 > e.h + e.fontSize * 0.25) issues.push({ severity: 'warning', code: 'MULTILINE_HEIGHT', message: '多行文字可能超出文字框，请检查预览。', elementId: e.id });
      if (e.fontSize < scene.width / 110) issues.push({ severity: 'warning', code: 'SMALL_TEXT', message: '相对画幅字号偏小，请在最终插入尺寸下检查可读性。', elementId: e.id });
    }
    if (e.type === 'path') {
      const p = pathBounds(e);
      if (p.minX < -0.1 || p.minY < -0.1 || p.maxX > e.w + 0.1 || p.maxY > e.h + 0.1) issues.push({ severity: 'warning', code: 'PATH_LOCAL_BOUNDS', message: '曲线超出其局部坐标框，请确认未误用全局坐标。', elementId: e.id });
      if (!e.rotation && (e.x + p.minX < -0.01 || e.y + p.minY < -0.01 || e.x + p.maxX > scene.width + 0.01 || e.y + p.maxY > scene.height + 0.01)) issues.push({ severity: 'warning', code: 'PATH_OUT_OF_BOUNDS', message: '曲线实际轮廓超出画布，可能被裁切。', elementId: e.id });
    }
    if (e.type === 'image' && b.w * b.h > scene.width * scene.height * 0.7) issues.push({ severity: 'error', code: 'PAGE_RASTER', message: '大幅位图覆盖大部分画布，不能作为高质量可编辑复刻验收。', elementId: e.id });
  }
  if (images.length && !text.length) issues.push({ severity: 'error', code: 'IMAGE_ONLY', message: '图中没有可编辑文字，不能把位图包装当作可编辑成果。' });
  if (images.length) issues.push({ severity: 'warning', code: 'RASTER_ASSETS', message: `${images.length} 个独立图片元素内部不可编辑，须检查是否含应重建的文字。` });
  for (let i = 0; i < text.length; i++) for (let j = i + 1; j < text.length; j++) {
    const a = text[i]; const b = text[j];
    if ((a.groupId && a.groupId === b.groupId) || a.rotation || b.rotation) continue;
    const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    // Large, nearly coincident text boxes are actionable; small intentional overlaps are not called errors.
    if (ix > 0 && iy > 0 && ix * iy > Math.min(a.w * a.h, b.w * b.h) * 0.85) issues.push({ severity: 'warning', code: 'TEXT_OVERLAP', message: `文字框与 ${b.id} 大面积重叠，请核查遮挡。`, elementId: a.id });
  }
  for (const warning of scene.warnings ?? []) issues.push({ severity: 'warning', code: 'SOURCE_WARNING', message: warning });
  issues.push({ severity: 'info', code: 'VISUAL_REVIEW_REQUIRED', message: '结构检查不代表还原度或科学内容通过。请对照原图检查预览、公式和箭头，并在目标软件中试改后保存重开。' });
  return { structuralPassed: !issues.some((issue) => issue.severity === 'error'), visualReview: 'pending', issues, textCount: text.length, shapeCount: scene.elements.length - text.length - images.length, rasterCount: images.length, checkedAt: new Date().toISOString() };
}
