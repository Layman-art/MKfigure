import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import JSZip from 'jszip';
import type { FigureScene, ProgressEvent, TokenUsage } from '../src/shared/types';
import type { ProviderHub } from '../src/main/providers/types';

const state = vi.hoisted(() => ({
  render: vi.fn(),
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XkAAAAASUVORK5CYII=',
}));
vi.mock('electron', () => {
  const image = () => ({
    isEmpty: () => false,
    getSize: () => ({ width: 640, height: 360 }),
    toPNG: () => Buffer.from(state.png, 'base64'),
    toDataURL: () => `data:image/png;base64,${state.png}`,
    resize: () => image(),
  });
  return { safeStorage: {}, nativeImage: { createFromPath: image, createFromBuffer: image } };
});
vi.mock('../src/main/render', () => ({ renderSvgPng: state.render, fontAvailability: () => null }));
// PDF extraction is unrelated; its CommonJS debug entry reads a bundled sample
// when imported under Vitest. Keep real image ingestion and Store behaviour.
vi.mock('pdf-parse', () => ({ default: vi.fn() }));

import { Store } from '../src/main/storage';
import { Workflow } from '../src/main/workflow';

const scene: FigureScene = {
  version: 1, width: 640, height: 360, background: '#FFFFFF', title: 'Neural ODE',
  elements: [
    { id: 'title', type: 'text', x: 40, y: 40, w: 420, h: 40, text: 'Neural ODE', fontSize: 24, color: '#223344' },
    { id: 'flow', type: 'line', x: 40, y: 140, w: 420, h: 0, x2: 460, y2: 140, stroke: '#223344', strokeWidth: 2, arrowEnd: true },
  ],
};
const directories: string[] = [];
const startTime = Date.UTC(2026, 8, 16, 12, 0, 0);

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mk-workflow-product-'));
  directories.push(directory);
  const store = new Store(directory, directory);
  await store.init();
  const settings = store.publicSettings();
  settings.providers.find(provider => provider.id === 'codex')!.model = 'chosen-model';
  settings.reasoningEffort = 'xhigh';
  await store.saveSettings(settings);
  const project = await store.create('Product regression', 'full');
  const sourcePath = join(store.projectDir(project.id), 'assets', 'source.png');
  await writeFile(sourcePath, Buffer.from(state.png, 'base64'));
  await store.mutate(project.id, current => {
    current.target = { id: 'source-image', name: 'source.png', kind: 'image', mime: 'image/png', path: 'source.png', width: 640, height: 360 };
  });
  const complete = vi.fn<ProviderHub['complete']>();
  const generateImage = vi.fn<ProviderHub['generateImage']>();
  const hub: ProviderHub = {
    complete, generateImage,
    status: vi.fn().mockResolvedValue({ available: true, authenticated: true, label: 'Codex' }),
    loginCodex: vi.fn().mockResolvedValue({ available: true, authenticated: true, label: 'Codex' }),
    listModels: vi.fn().mockResolvedValue([{ id: 'default-model', name: 'Default', isDefault: true }]),
    dispose: vi.fn(),
  };
  const events: ProgressEvent[] = [];
  const workflow = new Workflow(store, () => hub, event => events.push(event));
  const reopen = async () => {
    const reopenedStore = new Store(directory, directory);
    await reopenedStore.init();
    return reopenedStore.load(project.id);
  };
  return { directory, store, project, sourcePath, complete, generateImage, hub, workflow, events, reopen };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(startTime);
  state.render.mockReset().mockResolvedValue(Buffer.from(state.png, 'base64'));
});
afterEach(async () => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    expect(basename(directory)).toMatch(/^mk-workflow-product-/);
    await rm(directory, { recursive: true, force: true });
  }
});

describe('direct content and style generation', () => {
  it('sends one image request with user content and custom reference without an AI prompt-writing request', async () => {
    const { workflow, store, project, sourcePath, complete, generateImage, reopen } = await fixture();
    const content = '输入一段科研说明。神经 ODE 使用连续时间动力学，通过数值积分获得状态预测，再计算损失并更新参数。';
    const style = '使用深蓝与低饱和绿色，横向分区，保持充足留白。';
    await store.mutate(project.id, current => {
      current.brief.topic = content;
      current.brief.prompt = '';
      current.brief.stylePrompt = style;
      current.customReference = { ...current.target!, id: 'custom-style' };
    });
    generateImage.mockImplementation(async request => {
      expect(request.provider).toBe('codex');
      expect(request.model).toBe('chosen-model');
      expect(request.reasoningEffort).toBe('xhigh');
      expect(request.prompt).toContain(content);
      expect(request.prompt).toContain(style);
      expect(request.references).toEqual([{ path: sourcePath, dataUrl: `data:image/png;base64,${state.png}` }]);
      vi.setSystemTime(startTime + 4200);
      return { dataUrl: `data:image/png;base64,${state.png}` };
    });

    const result = await workflow.run(project.id, 'generate');
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(result.stage).toBe('visual');
    expect(result.generated).toHaveLength(1);
    expect(result.target?.id).toBe(result.generated[0].id);
    const saved = await reopen();
    expect(saved.brief.prompt).toBe('');
    expect(await readFile(store.resolveAsset(project.id, saved.generated[0]))).toEqual(Buffer.from(state.png, 'base64'));
    expect(saved.runs).toHaveLength(1);
    expect(saved.runs![0]).toMatchObject({ action: 'generate', status: 'completed', model: 'chosen-model', reasoningEffort: 'xhigh', durationMs: 4200, usageComplete: false });
    // An image service that did not report tokens has unknown usage, not zero.
    expect(saved.runs![0].usage).toBeUndefined();
  });
});

describe('visual draft changes', () => {
  async function editFixture() {
    const f = await fixture();
    f.store.settings.reasoningEffort = 'low';
    await f.store.mutate(f.project.id, current => {
      current.generated = [current.target!];
      current.scene = structuredClone(scene);
      current.qa = { structuralPassed: true, visualReview: 'reviewed', issues: [], textCount: 1, shapeCount: 1, rasterCount: 0, checkedAt: new Date().toISOString() };
      current.brief.topic = 'OLD_TOPIC';
      current.brief.prompt = 'OLD_PROMPT';
      current.brief.stylePrompt = 'OLD_STYLE';
      // This file deliberately does not exist; new visual edits must not read it.
      current.customReference = { ...current.target!, id: 'style', path: 'missing-style.png' };
    });
    return f;
  }
  async function operationFor(store: Store, id: string) {
    const directory = join(store.projectDir(id), 'generation');
    const names = (await readdir(directory)).filter(name => name.startsWith('operation-'));
    expect(names).toHaveLength(1);
    return JSON.parse(await readFile(join(directory, names[0]), 'utf8'));
  }

  it('edits only the source with the exact user prompt, keeps low effort, and preserves the old draft', async () => {
    const { store, project, workflow, complete, generateImage, sourcePath } = await editFixture();
    const feedback = '  只放大标题，其他部分保持不变。\n保留变量。  ';
    generateImage.mockImplementation(async request => {
      expect(request).toMatchObject({ model: 'chosen-model', mode: 'edit', prompt: feedback, reasoningEffort: 'low' });
      expect(request.references).toEqual([{ path: sourcePath, dataUrl: `data:image/png;base64,${state.png}` }]);
      request.onUsage?.({ inputTokens: 20, outputTokens: 10, totalTokens: 30 });
      return { dataUrl: `data:image/png;base64,${state.png}` };
    });
    const result = await workflow.run(project.id, 'edit-image', feedback);
    expect(complete).not.toHaveBeenCalled();
    expect(result.generated).toHaveLength(2);
    expect(result.generated[0].id).toBe('source-image');
    expect(result.target?.id).toBe(result.generated[1].id);
    expect(result.stage).toBe('visual');
    expect(result.scene).toBeUndefined();
    expect(result.qa).toBeUndefined();
    expect(result.brief.prompt).toBe('OLD_PROMPT');
    expect(result.customReference?.id).toBe('style');
    expect(await readFile(sourcePath)).toEqual(Buffer.from(state.png, 'base64'));
    expect(result.runs?.at(-1)).toMatchObject({ action: 'edit-image', reasoningEffort: 'low', usageComplete: true, usage: { totalTokens: 30 } });
    const operation = await operationFor(store, project.id);
    expect(operation).toMatchObject({ action: 'edit-image', mode: 'edit', prompt: feedback, sourceTargetId: 'source-image', resultAssetId: result.target?.id, reasoningEffort: 'low' });
    expect(JSON.stringify(operation)).not.toContain('data:image');
    expect(JSON.stringify(operation)).not.toContain('OLD_');
  });

  it('regenerates with only the new prompt and no source or style image', async () => {
    const { store, project, workflow, complete, generateImage } = await editFixture();
    const feedback = '画一张新的神经 ODE 示意图，白底、黑色文字、蓝色箭头。';
    generateImage.mockResolvedValue({ dataUrl: `data:image/png;base64,${state.png}` });
    const result = await workflow.run(project.id, 'regenerate-image', feedback);
    expect(complete).not.toHaveBeenCalled();
    expect(generateImage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ prompt: feedback, mode: 'create', references: [], reasoningEffort: 'low' }));
    expect(result.generated).toHaveLength(2);
    expect(result.stage).toBe('visual');
    const operation = await operationFor(store, project.id);
    expect(operation).toMatchObject({ action: 'regenerate-image', mode: 'create', prompt: feedback, previousTargetId: 'source-image' });
    expect(operation.sourceTargetId).toBeUndefined();
  });

  it('retains an uploaded source in the draft history when it was not previously generated', async () => {
    const { store, project, workflow, generateImage } = await fixture();
    expect((await store.load(project.id)).generated).toHaveLength(0);
    generateImage.mockResolvedValue({ dataUrl: `data:image/png;base64,${state.png}` });
    const result = await workflow.run(project.id, 'edit-image', 'Enlarge only the title');
    expect(result.generated).toHaveLength(2);
    expect(result.generated[0].id).toBe('source-image');
    expect(result.target?.id).toBe(result.generated[1].id);
  });

  it('plans requested improvements from the current image then edits with the final prompt, aggregating usage', async () => {
    const { store, project, workflow, complete, generateImage, sourcePath } = await editFixture();
    const feedback = '标题太小，左侧留白不够。';
    const editedPrompt = 'Increase only the title size and left margin. Preserve everything else.';
    complete.mockImplementation(async request => {
      expect(request).toMatchObject({ model: 'chosen-model', reasoningEffort: 'low' });
      expect(request.images).toEqual([{ path: sourcePath, dataUrl: `data:image/png;base64,${state.png}` }]);
      expect(request.prompt).toContain(feedback);
      expect(request.prompt).not.toContain('OLD_');
      request.onUsage?.({ inputTokens: 5, outputTokens: 3, totalTokens: 8 });
      return editedPrompt;
    });
    generateImage.mockImplementation(async request => {
      expect(request).toMatchObject({ mode: 'edit', prompt: editedPrompt, model: 'chosen-model', reasoningEffort: 'low' });
      expect(request.references).toEqual([{ path: sourcePath, dataUrl: `data:image/png;base64,${state.png}` }]);
      request.onUsage?.({ inputTokens: 20, outputTokens: 10, totalTokens: 30 });
      return { dataUrl: `data:image/png;base64,${state.png}` };
    });
    const result = await workflow.run(project.id, 'refine-image', feedback);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(generateImage).toHaveBeenCalledTimes(1);
    expect(result.generated).toHaveLength(2);
    expect(result.runs?.at(-1)).toMatchObject({ action: 'refine-image', reasoningEffort: 'low', usageComplete: true, usage: { inputTokens: 25, outputTokens: 13, totalTokens: 38 } });
    expect(await operationFor(store, project.id)).toMatchObject({ prompt: editedPrompt, feedback, sourceTargetId: 'source-image' });
  });

  it.each(['edit-image', 'refine-image', 'regenerate-image'] as const)('rejects empty input before sending %s', async action => {
    const { project, workflow, complete, generateImage, store } = await editFixture();
    await expect(workflow.run(project.id, action, '  ')).rejects.toThrow('请填写修改意见');
    expect(complete).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
    expect((await store.load(project.id)).target?.id).toBe('source-image');
  });

  it.each(['edit-image', 'refine-image'] as const)('rejects missing original before sending %s', async action => {
    const { project, workflow, complete, generateImage, store } = await editFixture();
    await store.mutate(project.id, current => { current.target = undefined; });
    await expect(workflow.run(project.id, action, 'Improve the figure')).rejects.toThrow('请先生成一张视觉稿');
    expect(complete).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
  });

  it.each(['failed', 'cancelled'] as const)('keeps the source, editable scene and known usage when an edit is %s', async status => {
    const { project, workflow, generateImage, store } = await editFixture();
    generateImage.mockImplementation(async request => {
      request.onUsage?.({ totalTokens: 11 });
      if (status === 'cancelled') {
        workflow.cancel(project.id);
        request.onUsage?.({ totalTokens: 999 });
        // A late successful tool result must not replace the source image.
        return { dataUrl: `data:image/png;base64,${state.png}` };
      }
      throw new Error('Editing failed');
    });
    await expect(workflow.run(project.id, 'edit-image', 'Enlarge the title')).rejects.toThrow(status === 'cancelled' ? '已停止本次操作' : 'Editing failed');
    const saved = await store.load(project.id);
    expect(saved.target?.id).toBe('source-image');
    expect(saved.generated).toHaveLength(1);
    expect(saved.scene).toEqual(scene);
    expect(saved.qa).toBeDefined();
    expect(saved.runs?.at(-1)).toMatchObject({ status, usage: { totalTokens: 11 }, usageComplete: false });
  });

  it('does not call image generation when planning is cancelled', async () => {
    const { project, workflow, complete, generateImage, store } = await editFixture();
    complete.mockImplementation(async request => {
      request.onUsage?.({ totalTokens: 4 });
      workflow.cancel(project.id);
      return 'An otherwise valid edit prompt';
    });
    await expect(workflow.run(project.id, 'refine-image', 'Enlarge the title')).rejects.toThrow('已停止本次操作');
    expect(generateImage).not.toHaveBeenCalled();
    const saved = await store.load(project.id);
    expect(saved.target?.id).toBe('source-image');
    expect(saved.runs?.at(-1)).toMatchObject({ status: 'cancelled', usage: { totalTokens: 4 } });
  });

  it('does not call image generation when the planner returns no usable prompt', async () => {
    const { project, workflow, complete, generateImage, store } = await editFixture();
    complete.mockResolvedValue('   ');
    await expect(workflow.run(project.id, 'refine-image', 'Enlarge the title')).rejects.toThrow('有效的修改提示词');
    expect(generateImage).not.toHaveBeenCalled();
    expect((await store.load(project.id)).target?.id).toBe('source-image');
  });
});

describe('persisted request usage and run timing', () => {
  it('replaces cumulative snapshots within a request and sums reconstruction plus repair only once', async () => {
    const { workflow, project, complete, events, reopen } = await fixture();
    const first: TokenUsage = { inputTokens: 20, cachedInputTokens: 10, outputTokens: 10, reasoningOutputTokens: 6, totalTokens: 30 };
    const second: TokenUsage = { inputTokens: 8, cachedInputTokens: 4, outputTokens: 5, reasoningOutputTokens: 3, totalTokens: 13 };
    complete.mockImplementationOnce(async request => {
      request.onUsage?.({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
      request.onUsage?.({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
      request.onUsage?.(first);
      request.onUsage?.(first);
      vi.setSystemTime(startTime + 17000);
      return JSON.stringify(scene).replace(/}$/, ',}');
    }).mockImplementationOnce(async request => {
      expect(request.prompt).toContain('Fix only the schema/JSON errors');
      request.onUsage?.({ inputTokens: 6, outputTokens: 3, totalTokens: 9 });
      request.onUsage?.(second);
      request.onUsage?.(second);
      vi.setSystemTime(startTime + 27000);
      return JSON.stringify(scene);
    });

    await workflow.run(project.id, 'reconstruct');
    expect(complete).toHaveBeenCalledTimes(2);
    for (const [request] of complete.mock.calls) expect(request).toMatchObject({ model: 'chosen-model', reasoningEffort: 'xhigh' });
    const saved = await reopen();
    expect(saved.runs).toHaveLength(1);
    expect(saved.scene).toEqual(scene);
    expect(saved.runs![0]).toMatchObject({
      action: 'reconstruct', model: 'chosen-model', reasoningEffort: 'xhigh', status: 'completed',
      startedAt: new Date(startTime).toISOString(), finishedAt: new Date(startTime + 27000).toISOString(), durationMs: 27000,
      usageComplete: true, usage: { inputTokens: 28, cachedInputTokens: 14, outputTokens: 15, reasoningOutputTokens: 9, totalTokens: 43 },
    });
    const reportedTotals = events.flatMap(event => event.metrics?.usage?.totalTokens === undefined ? [] : [event.metrics.usage.totalTokens]);
    expect(reportedTotals).toContain(10);
    expect(reportedTotals).toContain(30);
    expect(reportedTotals).toContain(39);
    expect(Math.max(...reportedTotals)).toBe(43);
    expect(events.at(-1)?.metrics).toMatchObject({ status: 'completed', durationMs: 27000, usage: { totalTokens: 43 } });
  });

  it.each([
    { status: 'failed', known: true }, { status: 'failed', known: false },
    { status: 'cancelled', known: true }, { status: 'cancelled', known: false },
  ] as const)('preserves $status usage when known=$known without fabricating missing totals', async ({ status, known }) => {
    const { workflow, project, complete, events, reopen } = await fixture();
    complete.mockImplementation(async request => {
      if (known) request.onUsage?.({ outputTokens: 8 });
      vi.setSystemTime(startTime + 3600);
      if (status === 'cancelled') {
        workflow.cancel(project.id);
        // Providers can deliver a late event after the user presses Stop.
        request.onUsage?.({ inputTokens: 999, totalTokens: 999 });
      }
      throw new Error('Service interrupted');
    });
    await expect(workflow.run(project.id, 'reconstruct')).rejects.toThrow(status === 'cancelled' ? '已停止本次操作' : 'Service interrupted');
    const saved = await reopen();
    expect(saved.runs).toHaveLength(1);
    const run = saved.runs![0];
    expect(run).toMatchObject({ action: 'reconstruct', status, model: 'chosen-model', reasoningEffort: 'xhigh', durationMs: 3600, usageComplete: false });
    expect(run.usage).toEqual(known ? { outputTokens: 8 } : undefined);
    expect(run.usage?.totalTokens).toBeUndefined();
    expect(run.usage?.inputTokens).toBeUndefined();
    expect(events.at(-1)?.metrics).toMatchObject({ status, durationMs: 3600 });
    expect(saved.scene).toBeUndefined();
    expect(saved.target?.id).toBe('source-image');
  });
});

describe('export only requested deliverable formats', () => {
  it.each(['pptx', 'svg', 'png'] as const)('writes only the selected %s file with no JSON sidecars', async format => {
    const { directory, workflow, store, project, complete, generateImage } = await fixture();
    await store.mutate(project.id, current => { current.scene = structuredClone(scene); });
    const destination = join(directory, 'exports');
    await mkdir(destination);
    // Duplicate selections must not create duplicate exports either.
    const result = await workflow.export(project.id, destination, [format, format]);
    const names = await readdir(destination);
    expect(names).toHaveLength(1);
    expect(extname(names[0])).toBe('.' + format);
    expect(result.files).toEqual([join(destination, names[0])]);
    expect(complete).not.toHaveBeenCalled();
    expect(generateImage).not.toHaveBeenCalled();
    const file = await readFile(result.files[0]);
    if (format === 'pptx') {
      // This uses the actual editable exporter, not an empty mocked PPTX file.
      const zip = await JSZip.loadAsync(file);
      const xml = await zip.file('ppt/slides/slide1.xml')!.async('string');
      expect(xml).toContain('Neural ODE');
      expect(xml.match(/<p:sp>/g)).toHaveLength(2);
      expect(xml).not.toContain('<p:pic>');
    } else if (format === 'svg') {
      expect(file.toString('utf8')).toContain('width="180mm"');
      expect(file.toString('utf8')).toContain('Neural ODE');
    } else expect(file).toEqual(Buffer.from(state.png, 'base64'));
    expect((await store.load(project.id)).stage).toBe('export');
  });
});
