import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageRequest, ProviderHub } from '../src/main/providers/types';
import type { Project } from '../src/shared/types';

vi.mock('electron', async () => {
  const { readFileSync } = await import('node:fs');
  const image = (bytes: Buffer) => ({
    isEmpty: () => false, getSize: () => ({ width: 640, height: 360 }),
    toPNG: () => bytes, toDataURL: () => `data:image/png;base64,${bytes.toString('base64')}`,
    resize: () => image(bytes),
  });
  return { safeStorage: {}, nativeImage: { createFromPath: (file: string) => image(readFileSync(file)), createFromBuffer: image } };
});
vi.mock('../src/main/render', () => ({ renderSvgPng: vi.fn(), fontAvailability: () => null }));
vi.mock('pdf-parse', () => ({ default: vi.fn() }));
import { Store } from '../src/main/storage';
import { Workflow } from '../src/main/workflow';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XkAAAAASUVORK5CYII=', 'base64');
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('parallel project workflows', () => {
  it.each([false, true])('runs five independent styles concurrently (cancel one: %s)', async cancelOne => {
    const root = await mkdtemp(join(tmpdir(), 'mk-workflow-parallel-'));
    roots.push(root);
    const store = new Store(root, root);
    await store.init();
    const settings = store.publicSettings();
    settings.providers.find(p => p.id === 'codex')!.model = 'test-model';
    await store.saveSettings(settings);
    const projects: Project[] = [];
    for (let i = 0; i < 5; i++) {
      const project = await store.create(`Project ${i}`, 'full');
      const reference = Buffer.concat([png, Buffer.from(`style-${i}`)]);
      await writeFile(join(store.projectDir(project.id), 'assets', 'reference.png'), reference);
      await store.mutate(project.id, p => {
        p.brief.topic = `topic-${i}`;
        p.brief.stylePrompt = `style-${i}`;
        p.customReference = { id: `ref-${i}`, name: 'reference.png', path: 'reference.png', kind: 'image', mime: 'image/png', width: 640, height: 360 };
      });
      projects.push(project);
    }
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const requests = new Map<number, ImageRequest>();
    const generateImage = vi.fn<ProviderHub['generateImage']>(async request => {
      const i = Number(request.prompt.match(/topic-(\d)/)![1]);
      requests.set(i, request);
      request.onUsage?.({ inputTokens: 100 + i, outputTokens: 10 + i, totalTokens: 110 + 2 * i });
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error('cancelled'));
        request.signal!.addEventListener('abort', abort, { once: true });
        void gate.then(() => { request.signal!.removeEventListener('abort', abort); resolve(); });
      });
      const file = join(root, `result-${i}.png`);
      await writeFile(file, Buffer.concat([png, Buffer.from(`result-${i}`)]));
      return { path: file, model: 'test-model' };
    });
    const hub: ProviderHub = { generateImage, complete: vi.fn(), status: vi.fn(), loginCodex: vi.fn(), listModels: vi.fn(), dispose: vi.fn() };
    const workflow = new Workflow(store, () => hub, () => {});
    const runs = projects.map(p => workflow.run(p.id, 'generate'));
    const settled = Promise.allSettled(runs);
    try {
      // No request can finish before this gate: reaching five proves overlap.
      await vi.waitFor(() => expect(requests.size).toBe(5));
      for (let i = 0; i < 5; i++) {
        expect(workflow.isRunning(projects[i].id)).toBe(true);
        const request = requests.get(i)!;
        expect(request.prompt).toContain(`style-${i}`);
        expect(request.references).toHaveLength(1);
        expect(Buffer.from(request.references![0].dataUrl.split(',')[1], 'base64')).toEqual(Buffer.concat([png, Buffer.from(`style-${i}`)]));
      }
      expect(new Set([...requests.values()].map(r => r.outputDir)).size).toBe(5);
      await expect(workflow.run(projects[0].id, 'generate')).rejects.toThrow('正在处理');
      if (cancelOne) {
        workflow.cancel(projects[2].id);
        await vi.waitFor(() => expect(workflow.isRunning(projects[2].id)).toBe(false));
        expect([...requests.values()].filter(r => r.signal!.aborted)).toHaveLength(1);
        expect(workflow.isRunning(projects[0].id)).toBe(true);
      }
    } finally { release(); }
    const results = await settled;
    for (let i = 0; i < 5; i++) {
      const cancelled = cancelOne && i === 2;
      expect(results[i].status).toBe(cancelled ? 'rejected' : 'fulfilled');
      expect(workflow.isRunning(projects[i].id)).toBe(false);
      const project = await store.load(projects[i].id);
      expect(project.runs?.at(-1)).toMatchObject({ status: cancelled ? 'cancelled' : 'completed', usage: { totalTokens: 110 + 2 * i } });
      if (cancelled) expect(project.target).toBeUndefined();
      else expect(await readFile(store.resolveAsset(project.id, project.target!))).toEqual(Buffer.concat([png, Buffer.from(`result-${i}`)]));
    }
    // A cancelled/completed project can run again, proving no stale lock.
    await expect(workflow.run(projects[2].id, 'generate')).resolves.toHaveProperty('target');
  });
});
