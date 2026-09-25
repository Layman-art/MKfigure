import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ImageLibrary } from '../src/main/library';
import { rasterDimensions, validateLibrarySvg } from '../src/main/library-svg';
import { renderSvgPng } from '../src/main/render';
import { webpToPng } from '../src/main/library-raster';

const fixtures = vi.hoisted(() => ({ png: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jTioAAAAASUVORK5CYII=', 'base64') }));
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: (buffer: Buffer) => ({ isEmpty: () => !buffer.equals(fixtures.png), getSize: () => ({ width: 1, height: 1 }), toPNG: () => fixtures.png, resize: () => ({ toPNG: () => fixtures.png }) }) } }));
vi.mock('../src/main/render', () => ({ renderSvgPng: vi.fn(async () => fixtures.png) }));
vi.mock('../src/main/library-raster', () => ({ webpToPng: vi.fn(async () => fixtures.png) }));
const roots: string[] = [], links: string[] = [];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="256" viewBox="0 0 512 256"><defs><linearGradient id="paint"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#123"/></linearGradient></defs><path d="M0 0L512 256" fill="url(#paint)" style="stroke:#b46843;stroke-width:4"/></svg>';

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mk-library-test-'));
  roots.push(root);
  const directory = path.join(root, 'library'), resources = path.join(root, 'resources');
  await fs.mkdir(path.join(resources, 'library'), { recursive: true });
  await fs.writeFile(path.join(resources, 'library', 'builtin.svg'), svg);
  await fs.writeFile(path.join(resources, 'library', 'thumb.png'), fixtures.png);
  const catalog = [{ id: 'builtin-vector', name: 'Built in', category: 'icon', extension: 'svg', mime: 'image/svg+xml', width: 512, height: 256, file: 'library/builtin.svg', thumbnail: 'library/thumb.png' }];
  await fs.writeFile(path.join(resources, 'library', 'catalog.json'), JSON.stringify(catalog));
  const library = new ImageLibrary(directory, resources);
  await library.init();
  const source = path.join(root, 'Original icon.svg');
  await fs.writeFile(source, svg);
  const mockTrash = path.join(root, 'mockTrash');
  await fs.mkdir(mockTrash);
  const trash = vi.fn(async (target: string) => {
    expect(path.dirname(target)).toBe(await fs.realpath(directory));
    await fs.rename(target, path.join(mockTrash, path.basename(target)));
  });
  return { root, library, directory, resources, source, mockTrash, trash, catalog };
}

afterEach(async () => {
  for (const link of links.splice(0)) if ((await fs.lstat(link).catch(() => null))?.isSymbolicLink()) await fs.unlink(link);
  for (const root of roots.splice(0)) {
    expect(path.dirname(path.resolve(root))).toBe(path.resolve(tmpdir()));
    expect(path.basename(root)).toMatch(/^mk-library-test-/);
    expect(path.dirname(await fs.realpath(root))).toBe(await fs.realpath(tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

describe('Image library storage', () => {
  it('preserves original SVG bytes and persists name/category across reopen while serving cached PNGs', async () => {
    const { library, source, directory, resources } = await fixture();
    const result = await library.importFiles([source], 'icon');
    expect(result.errors).toEqual([]);
    expect(result.importedIds).toHaveLength(1);
    const id = result.importedIds[0];
    expect(result.items.find(item => item.id === id)).toMatchObject({ name: 'Original icon', category: 'icon', source: 'user', extension: 'svg', width: 512, height: 256 });
    const original = await library.original(id);
    expect(await fs.readFile(original.path)).toEqual(await fs.readFile(source));
    expect(original.path).not.toBe(source);
    expect(renderSvgPng).toHaveBeenCalledWith(svg, 1024, 512);
    expect(await library.preview(id)).toBe(`data:image/png;base64,${fixtures.png.toString('base64')}`);
    expect(await library.referenceImage(id)).toEqual({ name: 'Original icon.png', dataUrl: await library.preview(id) });
    await library.update(id, { name: 'Paper style', category: 'reference' });
    const reopened = new ImageLibrary(directory, resources);
    await reopened.init();
    expect((await reopened.list()).find(item => item.id === id)).toMatchObject({ name: 'Paper style', category: 'reference', mime: 'image/svg+xml' });
    expect(await fs.readFile((await reopened.original(id)).path)).toEqual(await fs.readFile(source));
  });

  it('imports valid files in a batch and reports invalid files individually', async () => {
    const { library, root, source } = await fixture();
    const raster = path.join(root, 'Photo.png'), bad = path.join(root, 'wrong.png'), unsupported = path.join(root, 'notes.txt');
    await fs.writeFile(raster, fixtures.png);
    await fs.writeFile(bad, 'not a PNG');
    await fs.writeFile(unsupported, 'not an image');
    const result = await library.importFiles([source, raster, bad, unsupported], 'reference');
    expect(result.importedIds).toHaveLength(2);
    expect(result.errors).toHaveLength(2);
    expect(result.items.filter(item => item.source === 'user')).toHaveLength(2);
    expect(result.items.find(item => item.name === 'Photo')).toMatchObject({ width: 1, height: 1, mime: 'image/png' });
    await expect(library.importFiles([source], 'invalid' as never)).rejects.toThrow(/分类/);
    await expect(library.importFiles(Array(101).fill(source), 'icon')).rejects.toThrow(/100/);
  });

  it('rejects excessive SVG dimensions and byte sizes before rendering', async () => {
    const { library, root } = await fixture();
    const large = path.join(root, 'large.svg'), oversized = path.join(root, 'oversized.svg');
    await fs.writeFile(large, '<svg xmlns="http://www.w3.org/2000/svg" width="16000" height="16000"/>');
    await fs.writeFile(oversized, ' '.repeat(4 * 1024 * 1024 + 1));
    const result = await library.importFiles([large, oversized], 'icon');
    expect(result.importedIds).toEqual([]);
    expect(result.errors).toHaveLength(2);
    expect(renderSvgPng).not.toHaveBeenCalled();
  });

  it('rejects a corrupt raster with a plausible size header instead of importing a blank preview', async () => {
    const { library, root } = await fixture();
    const damaged = path.join(root, 'damaged.png');
    await fs.writeFile(damaged, fixtures.png.subarray(0, 24));
    const result = await library.importFiles([damaged], 'reference');
    expect(result.importedIds).toEqual([]);
    expect(result.errors[0]).toMatch(/无法解码/);
    expect(renderSvgPng).not.toHaveBeenCalled();
  });

  it('processes PNG directly without placing its bytes in an SVG navigation URL', async () => {
    const { library, root } = await fixture();
    const source = path.join(root, 'Raster.png');
    await fs.writeFile(source, fixtures.png);
    const result = await library.importFiles([source], 'reference');
    expect(result.errors).toEqual([]);
    expect(await library.preview(result.importedIds[0])).toBe(`data:image/png;base64,${fixtures.png.toString('base64')}`);
    expect(renderSvgPng).not.toHaveBeenCalled();
    expect(webpToPng).not.toHaveBeenCalled();
  });

  it('routes WebP through the Chromium decoder and keeps original WebP bytes', async () => {
    const { library, root } = await fixture();
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0); webp.write('WEBP', 8); webp.write('VP8X', 12);
    webp.writeUIntLE(79, 24, 3); webp.writeUIntLE(59, 27, 3);
    const source = path.join(root, 'Raster.webp');
    await fs.writeFile(source, webp);
    const result = await library.importFiles([source], 'reference');
    expect(result.errors).toEqual([]);
    expect(webpToPng).toHaveBeenCalledExactlyOnceWith(webp);
    expect(renderSvgPng).not.toHaveBeenCalled();
    expect(await fs.readFile((await library.original(result.importedIds[0])).path)).toEqual(webp);
    vi.mocked(webpToPng).mockRejectedValueOnce(new Error('WebP 图片无法解码'));
    const failed = await library.importFiles([source], 'reference');
    expect(failed.importedIds).toEqual([]);
    expect(failed.errors[0]).toMatch(/无法解码/);
  });

  it('preserves narrow SVG proportions and returns a short rendering error', async () => {
    const { library, root } = await fixture();
    const source = path.join(root, 'Narrow.svg');
    const narrow = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 1024"><rect width="4" height="1024" fill="red"/></svg>';
    await fs.writeFile(source, narrow);
    expect((await library.importFiles([source], 'icon')).errors).toEqual([]);
    expect(renderSvgPng).toHaveBeenCalledWith(narrow, 4, 1024);
    vi.mocked(renderSvgPng).mockRejectedValueOnce(new Error(`ERR_INVALID_URL data:${'x'.repeat(5000)}`));
    const failure = await library.importFiles([source], 'icon');
    expect(failure.errors[0]).toMatch(/SVG 预览生成失败/);
    expect(failure.errors[0].length).toBeLessThan(100);
  });

  it('does not allow modification/deletion of built-ins, but can preview/export their original SVG', async () => {
    const { library, trash } = await fixture();
    await expect(library.update('builtin-vector', { name: 'new' })).rejects.toThrow(/内置/);
    await expect(library.trash('builtin-vector', trash)).rejects.toThrow(/内置/);
    expect(trash).not.toHaveBeenCalled();
    expect((await library.list())[0].source).toBe('builtin');
    expect(await fs.readFile((await library.original('builtin-vector')).path, 'utf8')).toBe(svg);
    expect(await library.preview('builtin-vector')).toMatch(/^data:image\/png;base64,/);
  });

  it('trashes only the selected owned copy, preserving the external source and other assets', async () => {
    const { library, source, trash, mockTrash } = await fixture();
    const { importedIds: [id, other] } = await library.importFiles([source, source], 'icon');
    await library.trash(id, trash);
    expect(trash).toHaveBeenCalledTimes(1);
    await expect(library.original(id)).rejects.toThrow();
    expect(await fs.readFile(path.join(mockTrash, id, 'original.svg'), 'utf8')).toBe(svg);
    expect(await fs.readFile(source, 'utf8')).toBe(svg);
    expect(await fs.readFile((await library.original(other)).path, 'utf8')).toBe(svg);
  });

  it('retains the item and remains writable if trash fails', async () => {
    const { library, source } = await fixture();
    const { importedIds: [id] } = await library.importFiles([source], 'icon');
    await expect(library.trash(id, async () => { throw new Error('Trash unavailable'); })).rejects.toThrow('Trash unavailable');
    expect(await library.update(id, { name: 'Still here' })).toMatchObject({ name: 'Still here' });
    expect(await fs.readFile(source, 'utf8')).toBe(svg);
  });

  it.each(['../outside', '..\\outside', '', '/outside', 'C:\\outside', 'not-a-uuid'])('rejects invalid ID %j before filesystem mutation', async id => {
    const { library, trash } = await fixture();
    await expect(library.trash(id, trash)).rejects.toThrow();
    await expect(library.original(id)).rejects.toThrow();
    expect(trash).not.toHaveBeenCalled();
  });

  it('rejects directory junctions and ignores arbitrary paths in tampered metadata', async () => {
    const { library, directory, source, root, trash } = await fixture();
    const { importedIds: [id] } = await library.importFiles([source], 'icon');
    const file = path.join(directory, id, 'metadata.json');
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...value, file: source, path: source }));
    expect((await library.original(id)).path).toBe(path.join(await fs.realpath(directory), id, 'original.svg'));
    await fs.writeFile(file, JSON.stringify({ ...value, extension: '../../outside' }));
    await expect(library.original(id)).rejects.toThrow(/记录/);
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside);
    const linkedId = randomUUID(), link = path.join(directory, linkedId);
    await fs.writeFile(path.join(outside, 'metadata.json'), JSON.stringify({ ...value, id: linkedId }));
    await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    links.push(link);
    await expect(library.trash(linkedId, trash)).rejects.toThrow(/符号链接/);
    await expect(library.preview(linkedId)).rejects.toThrow(/符号链接/);
    expect(trash).not.toHaveBeenCalled();
  });

  it('rejects a catalog resource path that escapes its resources directory', async () => {
    const { library, resources, catalog } = await fixture();
    catalog[0].file = '../outside.svg';
    await fs.writeFile(path.join(resources, 'library', 'catalog.json'), JSON.stringify(catalog));
    await expect(library.init()).rejects.toThrow(/范围/);
  });

  it('serializes queued edits and deletion without recreating a deleted item', async () => {
    const { library, source, mockTrash, trash } = await fixture();
    const { importedIds: [id] } = await library.importFiles([source], 'icon');
    const update = library.update(id, { name: 'Before deletion' });
    const deleting = library.trash(id, trash);
    const lateEdit = library.update(id, { name: 'Too late' }).then(() => true, () => false);
    await update; await deleting;
    expect(await lateEdit).toBe(false);
    expect(JSON.parse(await fs.readFile(path.join(mockTrash, id, 'metadata.json'), 'utf8')).name).toBe('Before deletion');
    expect((await library.list()).every(item => item.id !== id)).toBe(true);
  });
});

describe('Library SVG and image validation', () => {
  it('accepts static paths, gradients and viewBox-only SVGs', () => {
    expect(validateLibrarySvg(svg)).toEqual({ width: 512, height: 256 });
    expect(validateLibrarySvg('<svg viewBox="0 0 120 80"><rect width="20" height="20"/></svg>')).toEqual({ width: 120, height: 80 });
  });
  it.each([
    '<script>alert(1)</script>',
    '<foreignObject><div>HTML</div></foreignObject>',
    '<path d="M0 0" onload="alert(1)"/>',
    '<use href="https://example.test/icon.svg#shape"/>',
    '<image href="data:image/svg+xml;base64,PHN2Zy8+"/>',
    '<style>@import "https://example.test/a.css";</style>',
    '<path style="fill:url(https://example.test/a.svg)"/>',
    '<path style="fill:u&#114;l(&#104;ttps&#58;&#47;&#47;example.test/a.svg)"/>',
    '<path style="fill:u\\72l(#x)"/>',
    '<path style="behavior:expression(alert(1))"/>',
  ])('rejects unsafe SVG markup: %s', markup => {
    expect(() => validateLibrarySvg(`<svg width="100" height="100">${markup}</svg>`)).toThrow();
  });
  it('rejects entities, XML processing instructions and malformed documents', () => {
    expect(() => validateLibrarySvg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///a">]><svg width="1" height="1"/>')).toThrow();
    expect(() => validateLibrarySvg('<?xml-stylesheet href="https://example.test/a"?><svg width="1" height="1"/>')).toThrow();
    expect(() => validateLibrarySvg('<svg><g></svg>')).toThrow();
  });
  it('checks PNG/JPEG/WebP headers before decoding', () => {
    expect(rasterDimensions(fixtures.png, 'png')).toEqual({ width: 1, height: 1 });
    const jpeg = Buffer.from([0xff,0xd8,0xff,0xc0,0,8,8,0,60,0,80,1]);
    expect(rasterDimensions(jpeg, 'jpg')).toEqual({ width: 80, height: 60 });
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0); webp.write('WEBP', 8); webp.write('VP8X', 12);
    webp.writeUIntLE(79, 24, 3); webp.writeUIntLE(59, 27, 3);
    expect(rasterDimensions(webp, 'webp')).toEqual({ width: 80, height: 60 });
    expect(() => rasterDimensions(fixtures.png, 'jpg')).toThrow();
    webp[20] = 0x02;
    expect(() => rasterDimensions(webp, 'webp')).toThrow(/动态/);
  });
});
