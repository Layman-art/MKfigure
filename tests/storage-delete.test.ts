import { afterEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { ProviderHub } from '../src/main/providers/types';

vi.mock('electron', () => ({ safeStorage: {}, nativeImage: {} }));
vi.mock('../src/main/assets', () => ({ addGeneratedImage: vi.fn() }));
vi.mock('../src/main/render', () => ({ renderSvgPng: vi.fn(), fontAvailability: () => null }));
import { Store } from '../src/main/storage';
import { Workflow } from '../src/main/workflow';

const roots: string[] = [];
const links: string[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'mk-storage-delete-'));
  roots.push(root);
  const store = new Store(join(root, 'app-data'), join(root, 'resources'));
  await store.init();
  const project = await store.create('Delete this', 'full');
  const mockTrash = join(root, 'mockTrash');
  await mkdir(mockTrash);
  const trash = vi.fn(async (absolutePath: string) => {
    expect(isAbsolute(absolutePath)).toBe(true);
    expect(await realpath(dirname(absolutePath))).toBe(await realpath(join(store.directory, 'projects')));
    await rename(absolutePath, join(mockTrash, basename(absolutePath)));
  });
  return { root, store, project, mockTrash, trash };
}

afterEach(async () => {
  // Remove only links created by these tests before cleaning their owned roots.
  for (const link of links.splice(0)) {
    if ((await lstat(link).catch(() => null))?.isSymbolicLink()) await unlink(link);
  }
  for (const root of roots.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
    expect(basename(root)).toMatch(/^mk-storage-delete-/);
    expect(dirname(await realpath(root))).toBe(await realpath(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});

describe('Workflow deletion and running-task exclusion', () => {
  function fakeHub(complete: ProviderHub['complete']): ProviderHub {
    return {
      complete, generateImage: vi.fn(), status: vi.fn(), loginCodex: vi.fn(), dispose: vi.fn(),
      listModels: vi.fn().mockResolvedValue([{ id: 'local-test-model', name: 'Local test', isDefault: true }]),
    };
  }

  it('refuses deletion during a running request, then allows it once the task has finished', async () => {
    const { store, project, trash } = await fixture();
    await store.mutate(project.id, current => { current.brief.topic = 'Local deletion guard test'; });
    const entered = deferred();
    const release = deferred();
    const complete = vi.fn(async () => { entered.resolve(); await release.promise; return 'Scientific content notes'; });
    const workflow = new Workflow(store, () => fakeHub(complete), () => undefined);
    const running = workflow.run(project.id, 'analyze');
    await entered.promise;
    try {
      await expect(workflow.deleteProject(project.id, trash)).rejects.toThrow(/正在处理/);
      expect(trash).not.toHaveBeenCalled();
      expect((await store.load(project.id)).id).toBe(project.id);
    } finally { release.resolve(); }
    await running;
    await workflow.deleteProject(project.id, trash);
    expect(trash).toHaveBeenCalledTimes(1);
    await expect(store.load(project.id)).rejects.toThrow();
  });

  it('does not start another model request while the project is being moved to trash', async () => {
    const { store, project, trash } = await fixture();
    const entered = deferred();
    const release = deferred();
    const complete = vi.fn<ProviderHub['complete']>();
    const workflow = new Workflow(store, () => fakeHub(complete), () => undefined);
    const deleting = workflow.deleteProject(project.id, async directory => {
      entered.resolve();
      await release.promise;
      await trash(directory);
    });
    await entered.promise;
    try {
      await expect(workflow.run(project.id, 'analyze')).rejects.toThrow(/正在处理/);
      expect(complete).not.toHaveBeenCalled();
    } finally { release.resolve(); }
    await deleting;
    expect(trash).toHaveBeenCalledTimes(1);
    await expect(store.load(project.id)).rejects.toThrow();
  });
});

describe('Store project trash boundaries', () => {
  it('moves only the selected project, leaving other projects and external originals/exports unchanged', async () => {
    const { root, store, project, mockTrash, trash } = await fixture();
    const other = await store.create('Keep this', 'full');
    const original = join(root, 'original-paper.txt');
    const exported = join(root, 'exported-figure.pptx');
    await writeFile(original, 'external source material');
    await writeFile(exported, 'external exported figure');
    await writeFile(join(store.projectDir(project.id), 'assets', 'imported.txt'), 'owned imported copy');
    await writeFile(join(store.projectDir(project.id), 'preview.svg'), '<svg/>');
    await store.mutate(project.id, current => {
      // Even a legacy absolute source path must never be followed by deletion.
      current.sources.push({ id: 'legacy-source', name: 'paper.txt', kind: 'text', mime: 'text/plain', path: original });
      current.history.push({ at: new Date().toISOString(), action: 'export', message: exported });
    });
    const otherBefore = await readFile(join(store.projectDir(other.id), 'project.json'));
    const targetDirectory = await realpath(store.projectDir(project.id));

    await store.trashProject(project.id, trash);

    expect(trash).toHaveBeenCalledExactlyOnceWith(targetDirectory);
    await expect(lstat(store.projectDir(project.id))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(mockTrash, project.id, 'assets', 'imported.txt'), 'utf8')).toBe('owned imported copy');
    expect(await readFile(join(mockTrash, project.id, 'preview.svg'), 'utf8')).toBe('<svg/>');
    expect(await readFile(original, 'utf8')).toBe('external source material');
    expect(await readFile(exported, 'utf8')).toBe('external exported figure');
    expect(await readFile(join(store.projectDir(other.id), 'project.json'))).toEqual(otherBefore);
    expect((await store.list()).map(value => value.id)).toEqual([other.id]);
  });

  it('keeps the project readable and writable when the operating system rejects trashing', async () => {
    const { store, project } = await fixture();
    const trash = vi.fn().mockRejectedValue(new Error('Trash is unavailable'));
    await expect(store.trashProject(project.id, trash)).rejects.toThrow('Trash is unavailable');
    expect(trash).toHaveBeenCalledTimes(1);
    expect((await store.load(project.id)).name).toBe('Delete this');
    await store.mutate(project.id, current => { current.name = 'Still editable'; });
    expect((await store.load(project.id)).name).toBe('Still editable');
  });

  it.each(['', '..', '../outside', '..\\outside', 'safe/../../outside', 'C:\\outside', '/outside', 'id%2f..'])('rejects invalid ID %j before invoking trash', async id => {
    const { store, project, trash } = await fixture();
    await expect(store.trashProject(id, trash)).rejects.toThrow();
    expect(trash).not.toHaveBeenCalled();
    expect((await store.load(project.id)).name).toBe('Delete this');
  });

  it('rejects a project directory junction/symlink without touching its target', async () => {
    const { root, store, project, trash } = await fixture();
    // The simulated outside target remains inside this test-owned temp root.
    const outside = join(root, 'outside-projects');
    await mkdir(outside);
    const outsideProject = { ...project, id: 'linked-project', name: 'Outside target' };
    await writeFile(join(outside, 'project.json'), JSON.stringify(outsideProject));
    await writeFile(join(outside, 'keep.txt'), 'Do not touch linked target');
    const link = store.projectDir(outsideProject.id);
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    links.push(link);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);

    await expect(store.trashProject(outsideProject.id, trash)).rejects.toThrow();

    expect(trash).not.toHaveBeenCalled();
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('Do not touch linked target');
    expect(JSON.parse(await readFile(join(outside, 'project.json'), 'utf8'))).toEqual(outsideProject);
    expect((await store.load(project.id)).id).toBe(project.id);
  });

  it('waits for queued saves before trashing and prevents later saves from recreating the project', async () => {
    const { store, project, mockTrash, trash } = await fixture();
    const entered = deferred();
    const release = deferred();
    const first = store.mutate(project.id, async current => {
      entered.resolve();
      await release.promise;
      current.name = 'First queued save';
    });
    await entered.promise;
    const second = store.mutate(project.id, current => {
      expect(current.name).toBe('First queued save');
      current.name = 'Second queued save';
    });
    const deleting = store.trashProject(project.id, trash);
    // Attach a rejection handler immediately, including implementations that
    // reject as soon as deletion is pending instead of enqueueing this mutation.
    const lateSave = store.mutate(project.id, current => { current.name = 'Must not reappear'; })
      .then(() => ({ succeeded: true }), error => ({ succeeded: false, error }));
    try {
      await Promise.resolve();
      expect(trash).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    await Promise.all([first, second]);
    await deleting;
    expect(await lateSave).toMatchObject({ succeeded: false });
    expect(trash).toHaveBeenCalledTimes(1);
    const deleted = JSON.parse(await readFile(join(mockTrash, project.id, 'project.json'), 'utf8'));
    expect(deleted.name).toBe('Second queued save');
    await expect(store.load(project.id)).rejects.toThrow();
    await expect(store.mutate(project.id, current => { current.name = 'Still must not reappear'; })).rejects.toThrow();
    await expect(lstat(store.projectDir(project.id))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await store.list()).toEqual([]);
  });
});
