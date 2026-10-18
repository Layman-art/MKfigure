import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/main/storage';

vi.mock('electron', () => ({ safeStorage: {}, nativeImage: {} }));
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mk-storage-links-')); roots.push(root);
  const store = new Store(path.join(root, 'local'), root); await store.init();
  const project = await store.create('ordinary project', 'full');
  const directory = store.projectDir(project.id);
  const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  return { root, store, project, directory, outside };
}

describe('project filesystem boundaries', () => {
  it('rejects a linked project for reading, writing, and asset destination resolution', async () => {
    const { store, project, directory, outside } = await setup();
    await fs.rename(directory, path.join(outside, 'project'));
    await fs.symlink(path.join(outside, 'project'), directory, process.platform === 'win32' ? 'junction' : 'dir');
    const before = await fs.readFile(path.join(outside, 'project', 'project.json'));
    await expect(store.load(project.id)).rejects.toThrow('链接');
    await expect(store.write({ ...project, name: 'wrong' })).rejects.toThrow('链接');
    expect(() => store.projectDir(project.id)).toThrow('链接');
    expect(await fs.readFile(path.join(outside, 'project', 'project.json'))).toEqual(before);
    expect(await store.list()).toEqual([]);
  });

  it('rejects an assets junction before callers can copy or generate files outside the project', async () => {
    const { store, project, directory, outside } = await setup();
    await fs.rmdir(path.join(directory, 'assets'));
    await fs.symlink(outside, path.join(directory, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => store.projectDir(project.id)).toThrow('链接');
    expect(() => store.resolveAsset(project.id, { id: 'a', name: 'a', path: 'a.png', mime: 'image/png', kind: 'image' })).toThrow('链接');
    await expect(store.load(project.id)).rejects.toThrow('链接');
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('refuses hard-linked project metadata and asset files without changing their source', async () => {
    const { store, project, directory, outside } = await setup();
    const original = path.join(outside, 'metadata.json');
    await fs.rename(path.join(directory, 'project.json'), original);
    await fs.link(original, path.join(directory, 'project.json'));
    await expect(store.load(project.id)).rejects.toThrow('链接');
    await expect(store.write({ ...project, name: 'wrong' })).rejects.toThrow('链接');
    expect(JSON.parse(await fs.readFile(original, 'utf8')).name).toBe('ordinary project');
    await fs.unlink(path.join(directory, 'project.json'));
    await fs.copyFile(original, path.join(directory, 'project.json'));
    const source = path.join(outside, 'asset.png'); await fs.writeFile(source, 'private');
    await fs.link(source, path.join(directory, 'assets', 'asset.png'));
    const asset = { id: 'a', name: 'a', path: 'asset.png', mime: 'image/png', kind: 'image' as const };
    await expect(store.imageData(project.id, asset)).rejects.toThrow('链接');
    expect(await fs.readFile(source, 'utf8')).toBe('private');
  });

  it('rejects linked render destinations and mismatched metadata IDs', async () => {
    const { store, project, directory, outside } = await setup();
    const source = path.join(outside, 'preview.svg'); await fs.writeFile(source, 'external');
    await fs.link(source, path.join(directory, 'preview.svg'));
    expect(() => store.projectDir(project.id)).toThrow('链接');
    await fs.unlink(path.join(directory, 'preview.svg'));
    await fs.writeFile(path.join(directory, 'project.json'), JSON.stringify({ ...project, id: 'another-project' }));
    await expect(store.load(project.id)).rejects.toThrow('不一致');
    expect(await fs.readFile(source, 'utf8')).toBe('external');
  });

  it('retains normal legacy project and basename-only asset compatibility', async () => {
    const { store, project, directory } = await setup();
    const file = path.join(directory, 'assets', 'legacy.png'); await fs.writeFile(file, 'image');
    expect(store.resolveAsset(project.id, { id: 'legacy', name: 'legacy', path: path.join(tmpdir(), 'legacy.png'), kind: 'image', mime: 'image/png' })).toBe(file);
    expect(await store.load(project.id)).toEqual(project);
    await store.write({ ...project, name: 'edited' });
    expect((await store.load(project.id)).name).toBe('edited');
  });
});
