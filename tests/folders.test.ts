import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { FolderWorkspace, EMPTY_STYLE } from '../src/main/folders';
import { Store } from '../src/main/storage';

vi.mock('electron', () => ({ safeStorage: {}, nativeImage: {} }));
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mk-folders-')); roots.push(root);
  const store = new Store(path.join(root, 'local'), root); await store.init();
  const workspace = new FolderWorkspace(store); await workspace.init();
  const folder = path.join(root, 'paper'); await fs.mkdir(folder);
  return { root, store, workspace, folder };
}

describe('folder creation workspace', () => {
  it('preserves existing local creations and keeps external workspace projects separate', async () => {
    const { store, workspace, folder } = await setup();
    const legacy = await store.create('已有作品', 'full');
    const before = await fs.readFile(path.join(store.projectDir(legacy.id), 'project.json'), 'utf8');
    await fs.writeFile(path.join(folder, 'paper.md'), 'source material');
    await workspace.open(folder);
    expect((await workspace.state()).folder.projects).toEqual([]);
    const external = await store.create('文件夹作品', 'reconstruct');
    expect(store.projectDir(external.id)).toContain(path.join('.mkfigure', 'projects'));
    await workspace.open();
    expect((await workspace.state()).folder.projects.map(p => p.id)).toEqual([legacy.id]);
    expect(await fs.readFile(path.join(store.projectDir(legacy.id), 'project.json'), 'utf8')).toBe(before);
    await workspace.open(folder);
    expect((await workspace.state()).folder.projects.map(p => p.id)).toEqual([external.id]);
    expect(await fs.readFile(path.join(folder, 'paper.md'), 'utf8')).toBe('source material');
    expect((await workspace.state()).recentFolders).toHaveLength(1);
  });

  it('reopens saved styles and projects with a fresh application instance', async () => {
    const { store, workspace, folder, root } = await setup();
    const opened = await workspace.open(folder);
    await workspace.saveStyle({ ...EMPTY_STYLE, prompt: '科研细线图', palette: '蓝绿', history: [{ role: 'user', text: '更简洁' }] });
    const project = await store.create('持久作品', 'full');
    const nextStore = new Store(store.directory, root); await nextStore.init();
    const next = new FolderWorkspace(nextStore); await next.init();
    expect(next.isRecent(await fs.realpath(folder))).toBe(true);
    const reopened = await next.open(folder);
    expect(reopened.folder.id).toBe(opened.folder.id);
    expect(reopened.folder.style).toMatchObject({ prompt: '科研细线图', palette: '蓝绿' });
    expect(reopened.folder.projects.map(p => p.id)).toEqual([project.id]);
  });

  it('applies shared styles, leaves custom styles intact, and removes styles only for none', async () => {
    const { store, workspace } = await setup();
    await workspace.saveStyle({ ...EMPTY_STYLE, prompt: '公共', palette: '蓝', background: '白', lines: '细线' });
    const original = await store.create('风格测试', 'full');
    original.brief.stylePrompt = '我的风格'; original.styleId = 'local-ref'; original.libraryReferenceId = 'library';
    original.customReference = { id: 'asset', name: 'reference', path: 'ref.png', kind: 'image', mime: 'image/png' };
    const custom = await workspace.effectiveProject({ ...original, styleMode: 'custom' });
    expect(custom).toEqual({ ...original, styleMode: 'custom' });
    const none = await workspace.effectiveProject({ ...original, styleMode: 'none' });
    expect(none.brief.stylePrompt).toBe(''); expect(none.styleId).toBeUndefined(); expect(none.customReference).toBeUndefined(); expect(none.libraryReferenceId).toBeUndefined();
    const shared = await workspace.effectiveProject({ ...original, styleMode: 'shared' });
    expect(shared.brief.stylePrompt).toBe('公共\n配色：蓝\n背景：白\n线条与图标：细线');
    expect(shared.styleId).toBeUndefined(); expect(shared.customReference).toBeUndefined();
    expect(original.brief.stylePrompt).toBe('我的风格');
  });

  it('copies a reference snapshot per request and remains portable after moving the folder', async () => {
    const { store, workspace, folder, root } = await setup();
    await workspace.open(folder);
    await workspace.saveStyle({ ...EMPTY_STYLE, prompt: '第一版' });
    const first = Buffer.from('first-reference');
    await workspace.setReference({ name: '参考图', data: first });
    const project = await store.create('可移动作品', 'full'); project.styleMode = 'shared';
    const snapshot = await workspace.effectiveProject(project);
    await store.write(snapshot);
    await workspace.saveStyle({ ...EMPTY_STYLE, prompt: '第二版' });
    await workspace.setReference({ name: '新版', data: Buffer.from('second-reference') });
    expect(snapshot.brief.stylePrompt).toBe('第一版');
    expect(await fs.readFile(store.resolveAsset(project.id, snapshot.customReference!))).toEqual(first);
    await workspace.open();
    const moved = path.join(root, 'paper-renamed'); await fs.rename(folder, moved);
    await workspace.open(moved);
    const reopened = await store.load(project.id);
    expect(await fs.readFile(store.resolveAsset(project.id, reopened.customReference!))).toEqual(first);
    const next = await workspace.effectiveProject(reopened);
    expect(next.brief.stylePrompt).toBe('第二版');
    expect(await fs.readFile(store.resolveAsset(project.id, next.customReference!))).toEqual(Buffer.from('second-reference'));
    expect(path.isAbsolute(next.customReference!.path)).toBe(false);
  });

  it('rejects unknown metadata without overwriting it or changing the active folder', async () => {
    const { workspace, folder } = await setup();
    const initial = await workspace.state();
    const meta = path.join(folder, '.mkfigure'); await fs.mkdir(meta);
    const sentinel = '{"format":"another-app","value":"keep"}';
    await fs.writeFile(path.join(meta, 'workspace.json'), sentinel);
    await expect(workspace.open(folder)).rejects.toThrow('无法识别');
    expect(await fs.readFile(path.join(meta, 'workspace.json'), 'utf8')).toBe(sentinel);
    expect((await workspace.state()).folder.id).toBe(initial.folder.id);
  });

  it('does not adopt a nonempty foreign metadata folder', async () => {
    const { workspace, folder } = await setup();
    const meta = path.join(folder, '.mkfigure'); await fs.mkdir(meta); await fs.writeFile(path.join(meta, 'keep.txt'), 'keep');
    await expect(workspace.open(folder)).rejects.toThrow('未做修改');
    expect(await fs.readdir(meta)).toEqual(['keep.txt']);
  });

  it('rejects linked metadata or linked project roots and leaves their targets intact', async () => {
    const { workspace, folder, root } = await setup();
    const outside = path.join(root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
    const meta = path.join(folder, '.mkfigure'); await fs.symlink(outside, meta, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(workspace.open(folder)).rejects.toThrow('链接目录');
    await fs.unlink(meta); await fs.mkdir(meta);
    await fs.writeFile(path.join(meta, 'workspace.json'), JSON.stringify({ format: 'mk-figure-workspace', version: 1, id: 'test', style: {} }));
    await fs.symlink(outside, path.join(meta, 'projects'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(workspace.open(folder)).rejects.toThrow('链接目录');
    expect(await fs.readdir(outside)).toEqual(['keep.txt']);
  });

  it('rejects hard-linked metadata and strips escaping reference filenames', async () => {
    const { workspace, folder, root, store } = await setup();
    const meta = path.join(folder, '.mkfigure'); await fs.mkdir(meta);
    const original = JSON.stringify({ format: 'mk-figure-workspace', version: 1, id: 'test', style: { reference: { name: 'escape', file: '../../secret.png' } } });
    const outside = path.join(root, 'outside.json'); await fs.writeFile(outside, original);
    await fs.link(outside, path.join(meta, 'workspace.json'));
    await expect(workspace.open(folder)).rejects.toThrow('普通文件');
    expect(await fs.readFile(outside, 'utf8')).toBe(original);
    await fs.unlink(path.join(meta, 'workspace.json')); await fs.writeFile(path.join(meta, 'workspace.json'), original);
    await workspace.open(folder);
    expect((await workspace.state()).folder.style.reference).toBeUndefined();
    const project = await store.create('safe', 'full'); project.styleMode = 'shared';
    expect((await workspace.effectiveProject(project)).customReference).toBeUndefined();
  });

  it('serializes simultaneous style and reference edits without dropping either update', async () => {
    const { workspace, store } = await setup();
    await Promise.all([
      workspace.saveStyle({ ...EMPTY_STYLE, prompt: '第一次' }),
      workspace.setReference({ name: 'new reference', data: Buffer.from('reference') }),
      workspace.saveStyle({ ...EMPTY_STYLE, prompt: '最后一次', palette: '紫色' }),
    ]);
    const state = await workspace.state();
    expect(state.folder.style).toMatchObject({ prompt: '最后一次', palette: '紫色', reference: { name: 'new reference' } });
    const persisted = JSON.parse(await fs.readFile(path.join(store.directory, 'workspace.json'), 'utf8'));
    expect(persisted.style).toEqual(state.folder.style);
  });

  it('can switch to another folder after a failed style write', async () => {
    const { workspace, store, folder } = await setup();
    const file = path.join(store.directory, 'workspace.json');
    await fs.rename(file, file + '.backup');
    await fs.mkdir(file);
    await expect(workspace.saveStyle({ ...EMPTY_STYLE, prompt: 'fails' })).rejects.toThrow();
    await expect(workspace.open(folder)).resolves.toMatchObject({ folder: { path: await fs.realpath(folder) } });
  });

  it('rejects a reference snapshot that was replaced with a hard link', async () => {
    const { workspace, store, root } = await setup();
    const style = await workspace.setReference({ name: 'safe', data: Buffer.from('initial') });
    const reference = path.join(store.directory, style.reference!.file);
    const outside = path.join(root, 'private.png'); await fs.writeFile(outside, 'private');
    await fs.unlink(reference); await fs.link(outside, reference);
    const project = await store.create('ref check', 'full'); project.styleMode = 'shared';
    await expect(workspace.effectiveProject(project)).rejects.toThrow('普通文件');
    expect(await fs.readdir(path.join(store.projectDir(project.id), 'assets'))).toEqual([]);
    expect(await fs.readFile(outside, 'utf8')).toBe('private');
  });
});
