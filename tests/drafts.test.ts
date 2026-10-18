import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/main/storage';
vi.mock('electron', () => ({ safeStorage: {}, nativeImage: {} }));
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'mk-drafts-')); roots.push(root);
  const store = new Store(root, root); await store.init(); return store;
}
describe('new creation drafts', () => {
  it('hides drafts and restores the same saved content after restart', async () => {
    const store = await setup();
    const [first, same] = await Promise.all([store.createDraft(1, 'full'), store.createDraft(1, 'full')]);
    expect(first.id).toBe(same.id); expect(first.name).toBe('新创作');
    await store.mutate(first.id, p => { p.brief.topic = 'Neural ODE'; p.styleMode = 'none'; });
    expect(await store.list()).toEqual([]);
    const next = new Store(store.directory, store.resources); await next.init();
    expect(await next.createDraft(1, 'full')).toMatchObject({ id: first.id, draftSlot: 1, brief: { topic: 'Neural ODE' }, styleMode: 'none' });
    expect((await next.createDraft(2, 'reconstruct')).id).not.toBe(first.id);
  });
  it('keeps empty and invalid requests as drafts, including missing reconstruction images', async () => {
    const store = await setup(), p = await store.createDraft(1, 'full');
    for (const action of ['analyze', 'prompt', 'generate', 'reconstruct', 'review', 'edit-image'] as const) {
      await expect(store.beginRun(p.id, action)).rejects.toThrow();
      expect((await store.load(p.id)).draftSlot).toBe(1);
    }
    expect(await store.list()).toEqual([]);
  });
  it('promotes once, derives a concise title and retains identity on retries', async () => {
    const store = await setup(), p = await store.createDraft(1, 'full');
    await store.mutate(p.id, p => { p.brief.topic = '  Neural ODE  training  '; });
    const first = await store.beginRun(p.id, 'generate');
    expect(first.name).toBe('Neural ODE training'); expect(first.draftSlot).toBeUndefined();
    expect((await store.beginRun(p.id, 'generate')).id).toBe(first.id);
    expect(await store.list()).toHaveLength(1);
    expect((await store.createDraft(1, 'full')).id).not.toBe(first.id);
    expect(await store.list()).toHaveLength(1);
  });
  it('preserves custom names and derives a reconstruction name from its image', async () => {
    const store = await setup(), p = await store.createDraft(1, 'reconstruct');
    await store.mutate(p.id, p => { p.target = { id: 'image', name: 'network.diagram.png', kind: 'image', mime: 'image/png', path: 'image.png' }; });
    expect((await store.beginRun(p.id, 'reconstruct')).name).toBe('network.diagram');
    const second = await store.createDraft(2, 'full');
    await store.mutate(second.id, p => { p.name = 'My title'; p.brief.topic = 'Other topic'; });
    expect((await store.beginRun(second.id, 'analyze')).name).toBe('My title');
  });
  it('isolates the same draft slot across folder directories', async () => {
    const store = await setup(), first = await store.createDraft(1, 'full');
    const secondRoot = path.join(store.directory, 'other-projects'); await fs.mkdir(secondRoot);
    store.setProjectsDirectory(secondRoot);
    const second = await store.createDraft(1, 'full'); expect(second.id).not.toBe(first.id);
    store.setProjectsDirectory(path.join(store.directory, 'projects'));
    expect((await store.createDraft(1, 'full')).id).toBe(first.id);
  });
});
