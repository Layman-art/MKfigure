import svgpath from 'svgpath';
import type { FigureElement, FigureScene, PathElement } from '../shared/types';

const colorPattern = /^#[\da-fA-F]{6}$/;
const idPattern = /^[\p{L}\p{N}_.:-]{1,96}$/u;
const baseKeys = ['id', 'type', 'groupId', 'role', 'x', 'y', 'w', 'h', 'rotation'];
export type PathSegment = [string, ...number[]];
type ParsedSvgPath = ReturnType<typeof svgpath> & { err: string; segments: PathSegment[] };
const typeKeys: Record<string, string[]> = {
  text: ['text', 'fontFamily', 'fontSize', 'color', 'bold', 'italic', 'align'],
  rect: ['fill', 'stroke', 'strokeWidth', 'radius', 'opacity'],
  ellipse: ['fill', 'stroke', 'strokeWidth', 'radius', 'opacity'],
  line: ['x2', 'y2', 'stroke', 'strokeWidth', 'dash', 'arrowStart', 'arrowEnd', 'opacity'],
  path: ['d', 'fill', 'stroke', 'strokeWidth', 'opacity', 'dash'],
  image: ['assetId'],
};

function fail(at: string, message: string): never { throw new Error(`图形数据 ${at}: ${message}`); }
function object(input: unknown, at: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(at, '必须为对象');
  return input as Record<string, unknown>;
}
function keys(obj: Record<string, unknown>, allowed: string[], at: string) {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) fail(at, `不支持字段 ${key}`);
}
function number(value: unknown, at: string, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(at, `必须为 ${min} 至 ${max} 的有限数字`);
}
function string(value: unknown, at: string, max: number, nonempty = true): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim())) fail(at, `必须为${nonempty ? '非空' : ''}文字，最多 ${max} 字符`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(value)) fail(at, '含不可显示的控制字符');
}
function color(value: unknown, at: string, allowNone = false) {
  if (typeof value !== 'string' || (!colorPattern.test(value) && !(allowNone && value === 'none'))) fail(at, '颜色须为 #RRGGBB' + (allowNone ? ' 或 none' : ''));
}
function optionalBool(obj: Record<string, unknown>, key: string, at: string) {
  if (obj[key] !== undefined && typeof obj[key] !== 'boolean') fail(`${at}.${key}`, '必须为布尔值');
}

/** Path coordinates are LOCAL to the element box. Normalize curves once for both outputs. */
export function normalizePath(d: string): string {
  if (d.length > 50000 || !/^[\s\d.,+\-eEMmLlHhVvCcSsQqTtAaZz]+$/.test(d)) fail('path.d', '无效或过长的 SVG 路径');
  const path = svgpath(d) as ParsedSvgPath;
  if (path.err) fail('path.d', path.err);
  path.abs().unshort().unarc();
  if (path.segments.length > 5000 || path.segments.length === 0) fail('path.d', '路径段数须为 1 至 5000');
  path.iterate((segment, _index, x, y) => {
    for (const coordinate of segment.slice(1)) number(coordinate, 'path.coordinate', -100000, 100000);
    if (segment[0] === 'H') return [['L', Number(segment[1]), y]];
    if (segment[0] === 'V') return [['L', x, Number(segment[1])]];
    return undefined;
  });
  if (path.segments.some((segment) => !['M', 'L', 'C', 'Q', 'Z'].includes(segment[0]))) fail('path.d', '路径无法转换为原生曲线');
  return path.round(5).toString();
}

export function validateScene(input: unknown): FigureScene {
  const scene = object(input, 'scene');
  keys(scene, ['version', 'width', 'height', 'background', 'title', 'elements', 'sourceNotes', 'warnings'], 'scene');
  if (scene.version !== 1) fail('version', '仅支持 version 1');
  number(scene.width, 'width', 64, 8192); number(scene.height, 'height', 64, 8192);
  color(scene.background, 'background'); string(scene.title, 'title', 512, false);
  if (!Array.isArray(scene.elements) || scene.elements.length < 1 || scene.elements.length > 1500) fail('elements', '元素数须为 1 至 1500');
  for (const field of ['sourceNotes', 'warnings']) {
    if (scene[field] !== undefined) {
      if (!Array.isArray(scene[field]) || scene[field].length > 100) fail(field, '必须是最多 100 项的文字数组');
      (scene[field] as unknown[]).forEach((item, i) => string(item, `${field}[${i}]`, 2000, false));
    }
  }
  const ids = new Set<string>(); let totalText = 0; let totalPath = 0;
  const groupSequence: string[] = [];
  const elements = scene.elements.map((inputElement: unknown, index: number) => {
    const at = `elements[${index}]`; const element = object(inputElement, at);
    if (typeof element.type !== 'string' || !typeKeys[element.type]) fail(`${at}.type`, '未知元素类型');
    keys(element, [...baseKeys, ...typeKeys[element.type]], at);
    string(element.id, `${at}.id`, 96);
    if (!idPattern.test(element.id) || ids.has(element.id)) fail(`${at}.id`, 'ID须唯一且只包含字母、数字、下划线、点、冒号或连字符');
    ids.add(element.id);
    if (element.groupId !== undefined && (typeof element.groupId !== 'string' || !idPattern.test(element.groupId))) fail(`${at}.groupId`, '无效组合 ID');
    const group = typeof element.groupId === 'string' ? element.groupId : `\0${index}`;
    if (group !== groupSequence.at(-1)) {
      if (groupSequence.includes(group)) fail(`${at}.groupId`, '同一组合的元素必须连续排列，以保持图层顺序');
      groupSequence.push(group);
    }
    if (element.role !== undefined && !['label', 'formula', 'decoration'].includes(String(element.role))) fail(`${at}.role`, '无效角色');
    number(element.x, `${at}.x`, -16384, 16384); number(element.y, `${at}.y`, -16384, 16384);
    number(element.w, `${at}.w`, 0, 16384); number(element.h, `${at}.h`, 0, 16384);
    if (element.type !== 'line' && (element.w === 0 || element.h === 0)) fail(at, '非线段元素的宽高必须大于 0');
    if (element.rotation !== undefined) number(element.rotation, `${at}.rotation`, -360, 360);
    if (element.type === 'text') {
      string(element.text, `${at}.text`, 4096); totalText += element.text.length;
      number(element.fontSize, `${at}.fontSize`, 1, 1024); color(element.color, `${at}.color`);
      optionalBool(element, 'bold', at); optionalBool(element, 'italic', at);
      if (element.fontFamily !== undefined && !['Times New Roman', 'Microsoft YaHei', '微软雅黑'].includes(String(element.fontFamily))) fail(`${at}.fontFamily`, '仅支持 Times New Roman 和 Microsoft YaHei');
      if (element.align !== undefined && !['left', 'center', 'right'].includes(String(element.align))) fail(`${at}.align`, '无效对齐方式');
    } else if (element.type === 'image') {
      string(element.assetId, `${at}.assetId`, 96);
      if (!idPattern.test(element.assetId)) fail(`${at}.assetId`, '无效素材 ID');
    } else {
      if (element.type === 'rect' || element.type === 'ellipse') color(element.fill, `${at}.fill`, true);
      if (element.fill !== undefined) color(element.fill, `${at}.fill`, true);
      if (element.stroke !== undefined || element.type === 'line') color(element.stroke, `${at}.stroke`, true);
      if (element.strokeWidth !== undefined || element.type === 'line') number(element.strokeWidth, `${at}.strokeWidth`, 0, 256);
      if (element.opacity !== undefined) number(element.opacity, `${at}.opacity`, 0, 1);
      if (element.radius !== undefined) number(element.radius, `${at}.radius`, 0, 8192);
      if (element.type === 'line') {
        number(element.x2, `${at}.x2`, -16384, 16384); number(element.y2, `${at}.y2`, -16384, 16384);
        ['dash', 'arrowStart', 'arrowEnd'].forEach((key) => optionalBool(element, key, at));
      }
      if (element.type === 'path') {
        optionalBool(element, 'dash', at);
        string(element.d, `${at}.d`, 50000); totalPath += element.d.length;
        if (totalPath > 1000000) fail('elements', '路径数据总量超过 1000000 字符');
        normalizePath(element.d);
      }
    }
    return { ...element } as unknown as FigureElement;
  });
  if (totalText > 100000) fail('elements', '全文超过 100000 字符');
  return { ...scene, elements } as unknown as FigureScene;
}

export function normalizedSegments(element: PathElement): PathSegment[] { return (svgpath(normalizePath(element.d)) as ParsedSvgPath).segments; }

export function safeRasterDataUrl(value: unknown, assetId: string): string {
  if (typeof value !== 'string' || value.length > 40 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`素材 ${assetId} 必须是本地 PNG/JPEG/WebP 的 base64 数据，不能使用远程链接、SVG 或外部文件引用`);
  }
  return value;
}
