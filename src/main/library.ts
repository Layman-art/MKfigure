import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { nativeImage } from 'electron';
import type { LibraryCategory, LibraryImportResult, LibraryItem } from '../shared/types';
import { renderSvgPng } from './render';
import { rasterDimensions, validateLibrarySvg } from './library-svg';
import { webpToPng } from './library-raster';

type Metadata = Omit<LibraryItem, 'source' | 'thumbnailUrl'>;
type CatalogItem = Metadata & { file: string; thumbnail: string };
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };
const MAX_FILE = 30 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const dataUrl = (buffer: Buffer) => `data:image/png;base64,${buffer.toString('base64')}`;
const samePath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function category(value: unknown): LibraryCategory {
  if (value !== 'reference' && value !== 'icon') throw new Error('无效的素材分类');
  return value;
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160 || /[\x00-\x1f]/.test(value)) throw new Error('素材名称须为 1–160 个字符');
  return value.trim();
}
function dimensions(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 16384 || height > 16384 || width * height > 60_000_000) throw new Error('图片尺寸超限：最长边 16384 像素，总像素不超过 6000 万');
}
function metadata(raw: Metadata, id: string): Metadata {
  if (!raw || raw.id !== id || !Object.hasOwn(MIME, raw.extension) || raw.mime !== MIME[raw.extension]) throw new Error('素材记录无效');
  dimensions(raw.width, raw.height);
  return { id, name: name(raw.name), category: category(raw.category), extension: raw.extension, mime: raw.mime, width: raw.width, height: raw.height, createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : undefined };
}

export class ImageLibrary {
  private catalog = new Map<string, CatalogItem>();
  private queues = new Map<string, Promise<unknown>>();
  constructor(readonly directory: string, readonly resources: string) {
    if (!path.isAbsolute(directory) || !path.isAbsolute(resources)) throw new Error('素材库目录必须为绝对路径');
  }
  async init(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    await this.root(this.directory);
    const file = await this.contained(this.resources, 'library/catalog.json');
    const rows: CatalogItem[] = JSON.parse((await this.read(file, 256 * 1024)).toString('utf8'));
    if (!Array.isArray(rows) || rows.length > 1000) throw new Error('内置素材目录无效');
    const catalog = new Map<string, CatalogItem>();
    for (const row of rows) {
      if (!row || !/^[a-zA-Z0-9-]{1,100}$/.test(row.id) || UUID.test(row.id) || catalog.has(row.id)) throw new Error('内置素材标识无效');
      const value = metadata(row, row.id);
      await this.contained(this.resources, row.file);
      await this.contained(this.resources, row.thumbnail);
      catalog.set(row.id, { ...value, file: row.file, thumbnail: row.thumbnail });
    }
    this.catalog = catalog;
  }
  private async root(directory: string): Promise<string> {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('素材目录不能是符号链接');
    return fs.realpath(directory);
  }
  private async contained(root: string, relative: string): Promise<string> {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || /(^|[\\/])\.\.([\\/]|$)/.test(relative) || relative.includes(':')) throw new Error('素材路径超出允许范围');
    const realRoot = await this.root(root);
    const resolved = path.resolve(realRoot, relative);
    const difference = path.relative(realRoot, resolved);
    if (!difference || difference.startsWith('..') || path.isAbsolute(difference)) throw new Error('素材路径超出允许范围');
    let current = realRoot;
    for (const piece of difference.split(path.sep)) {
      current = path.join(current, piece);
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('素材文件和目录不能是符号链接');
    }
    const actual = await fs.realpath(resolved);
    if (!samePath(actual, resolved)) throw new Error('素材路径超出允许范围');
    return actual;
  }
  private async read(file: string, max = MAX_FILE): Promise<Buffer> {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > max || info.size === 0) throw new Error(`文件不可读取或超过 ${Math.round(max / 1024 / 1024)} MB`);
    const result = await fs.readFile(file);
    if (result.length > max) throw new Error('文件大小超限');
    return result;
  }
  private userId(id: string): string {
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('无效的素材标识');
    return id;
  }
  private async user(id: string): Promise<Metadata> {
    const file = await this.contained(this.directory, `${this.userId(id)}/metadata.json`);
    return metadata(JSON.parse((await this.read(file, 16 * 1024)).toString('utf8')), id);
  }
  private async item(value: Metadata, source: 'builtin' | 'user', thumbnail: string): Promise<LibraryItem> {
    return { ...value, source, thumbnailUrl: dataUrl(await this.read(thumbnail, 5 * 1024 * 1024)) };
  }
  private async userItem(id: string): Promise<LibraryItem> {
    return this.item(await this.user(id), 'user', await this.contained(this.directory, `${id}/thumbnail.png`));
  }
  async list(): Promise<LibraryItem[]> {
    await this.root(this.directory);
    const builtins: LibraryItem[] = [];
    for (const row of this.catalog.values()) {
      builtins.push(await this.item(metadata(row, row.id), 'builtin', await this.contained(this.resources, row.thumbnail)));
    }
    const users: LibraryItem[] = [];
    for (const entry of await fs.readdir(this.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      try { users.push(await this.userItem(entry.name)); } catch { /* Skip incomplete/corrupt entries; never follow links. */ }
    }
    users.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return [...users, ...builtins];
  }
  private async png(buffer: Buffer, extension: string, width: number, height: number): Promise<Buffer> {
    if (extension !== 'svg') {
      const image = nativeImage.createFromBuffer(extension === 'webp' ? await webpToPng(buffer) : buffer);
      if (image.isEmpty()) throw new Error('图片无法解码，文件可能已损坏');
      const size = image.getSize(), scale = Math.min(1, 2400 / Math.max(size.width, size.height));
      return scale === 1 ? image.toPNG() : image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'best' }).toPNG();
    }
    const scale = 1024 / Math.max(width, height);
    const previewWidth = Math.max(1, Math.round(width * scale)), previewHeight = Math.max(1, Math.round(height * scale));
    try {
      return await renderSvgPng(buffer.toString('utf8'), previewWidth, previewHeight);
    } catch { throw new Error('SVG 预览生成失败，请简化图形后重试'); }
  }
  async importFiles(files: string[], requestedCategory: LibraryCategory): Promise<LibraryImportResult> {
    const kind = category(requestedCategory);
    if (!Array.isArray(files) || files.length > 100) throw new Error('一次最多导入 100 张图片');
    const importedIds: string[] = [], errors: string[] = [];
    for (const file of files) {
      let directory: string | undefined;
      try {
        if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('请选择本地图片文件');
        const extension = path.extname(file).slice(1).toLowerCase();
        if (!Object.hasOwn(MIME, extension)) throw new Error('支持 PNG、JPG、WebP、SVG');
        const buffer = await this.read(file, extension === 'svg' ? 4 * 1024 * 1024 : MAX_FILE);
        const size = extension === 'svg' ? validateLibrarySvg(buffer.toString('utf8')) : rasterDimensions(buffer, extension);
        dimensions(size.width, size.height);
        if (!['svg','webp'].includes(extension) && nativeImage.createFromBuffer(buffer).isEmpty()) throw new Error('图片无法解码，文件可能已损坏');
        const png = await this.png(buffer, extension, size.width, size.height);
        const image = nativeImage.createFromBuffer(png);
        if (image.isEmpty()) throw new Error('图片无法解码');
        const previewSize = image.getSize();
        const thumbnail = image.resize({ width: Math.min(400, previewSize.width), quality: 'best' }).toPNG();
        const value: Metadata = { id: randomUUID(), name: name(path.basename(file, path.extname(file))), category: kind, extension, mime: MIME[extension], ...size, createdAt: new Date().toISOString() };
        directory = path.join(await this.root(this.directory), value.id);
        await fs.mkdir(directory);
        await fs.writeFile(path.join(directory, `original.${extension}`), buffer, { flag: 'wx' });
        await fs.writeFile(path.join(directory, 'preview.png'), png, { flag: 'wx' });
        await fs.writeFile(path.join(directory, 'thumbnail.png'), thumbnail, { flag: 'wx' });
        await fs.writeFile(path.join(directory, 'metadata.json'), JSON.stringify(value, null, 2), { flag: 'wx' });
        importedIds.push(value.id);
      } catch (error) {
        errors.push(`${typeof file === 'string' ? path.basename(file) : '文件'}：${error instanceof Error ? error.message : '导入失败'}`);
        // Only remove the newly allocated UUID directory, after verifying its boundary.
        if (directory) {
          const owned = await this.contained(this.directory, path.basename(directory)).catch(() => undefined);
          if (owned && samePath(path.dirname(owned), await this.root(this.directory))) await fs.rm(owned, { recursive: true, force: true });
        }
      }
    }
    return { items: await this.list(), importedIds, errors };
  }
  private async queued<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.catalog.has(id)) throw new Error('内置素材不可修改或删除');
    this.userId(id);
    const previous = this.queues.get(id) || Promise.resolve();
    const task = previous.catch(() => undefined).then(operation);
    this.queues.set(id, task);
    try { return await task; } finally { if (this.queues.get(id) === task) this.queues.delete(id); }
  }
  async update(id: string, patch: { name?: string; category?: LibraryCategory }): Promise<LibraryItem> {
    return this.queued(id, async () => {
      if (!patch || typeof patch !== 'object') throw new Error('无效的素材修改');
      const value = await this.user(id);
      if (patch.name !== undefined) value.name = name(patch.name);
      if (patch.category !== undefined) value.category = category(patch.category);
      const directory = await this.contained(this.directory, id);
      const temporary = path.join(directory, `${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, JSON.stringify(value, null, 2), { flag: 'wx' });
        await fs.rename(temporary, path.join(directory, 'metadata.json'));
      } finally { await fs.unlink(temporary).catch(() => undefined); }
      return this.userItem(id);
    });
  }
  async trash(id: string, trashFn: (directory: string) => Promise<void>): Promise<void> {
    return this.queued(id, async () => {
      await this.user(id);
      const directory = await this.contained(this.directory, id);
      if (!samePath(path.dirname(directory), await this.root(this.directory))) throw new Error('素材目录超出允许范围');
      await trashFn(directory);
    });
  }
  async original(id: string): Promise<{ path: string; name: string; extension: string }> {
    const builtin = this.catalog.get(id);
    const value = builtin || await this.user(id);
    const file = builtin ? await this.contained(this.resources, builtin.file) : await this.contained(this.directory, `${id}/original.${value.extension}`);
    return { path: file, name: value.name, extension: value.extension };
  }
  async preview(id: string): Promise<string> {
    const builtin = this.catalog.get(id);
    if (!builtin) {
      await this.user(id);
      return dataUrl(await this.read(await this.contained(this.directory, `${id}/preview.png`)));
    }
    const source = await this.original(id);
    const buffer = await this.read(source.path);
    if (source.extension === 'svg') validateLibrarySvg(buffer.toString('utf8'));
    return dataUrl(await this.png(buffer, source.extension, builtin.width, builtin.height));
  }
  async referenceImage(id: string): Promise<{ dataUrl: string; name: string }> {
    const source = await this.original(id);
    return { name: `${source.name}.png`, dataUrl: await this.preview(id) };
  }
}
