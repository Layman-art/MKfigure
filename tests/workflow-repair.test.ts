import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { FigureScene, ProgressEvent } from '../src/shared/types';
import type { ProviderHub } from '../src/main/providers/types';

const state = vi.hoisted(() => ({
  spawn: vi.fn(),
  render: vi.fn(),
  png: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XkAAAAASUVORK5CYII=',
}));
vi.mock('node:child_process', () => ({ spawn: state.spawn }));
vi.mock('electron', () => ({
  safeStorage: {},
  nativeImage: {
    createFromPath: () => ({
      getSize: () => ({ width: 640, height: 360 }),
      resize: () => ({ toDataURL: () => `data:image/png;base64,${state.png}` }),
    }),
  },
}));
vi.mock('../src/main/render', () => ({ renderSvgPng: state.render, fontAvailability: () => null }));
vi.mock('../src/main/assets', () => ({ addGeneratedImage: vi.fn() }));

import { createProviders } from '../src/main/providers';
import { Store } from '../src/main/storage';
import { Workflow } from '../src/main/workflow';

type Json = Record<string, any>;
const repairedScene: FigureScene = {
  version: 1, width: 640, height: 360, background: '#FFFFFF', title: 'Neural ODE',
  elements: [
    { id: 'title', type: 'text', x: 40, y: 40, w: 420, h: 40, text: 'Neural ODE', fontFamily: 'Times New Roman', fontSize: 24, color: '#223344' },
    { id: 'flow', type: 'line', x: 40, y: 140, w: 420, h: 0, x2: 460, y2: 140, stroke: '#223344', strokeWidth: 2, arrowEnd: true },
  ],
};
const validResponse = JSON.stringify(repairedScene);
const malformedResponse = validResponse.replace(/}$/, ',}');
const directories: string[] = [];
const hubs: ProviderHub[] = [];

function fakeChild(handler: (message: Json, emit: (message: Json) => void) => void | Promise<void>) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill: vi.fn(),
  });
  child.stdin.on('data', data => {
    for (const line of data.toString().trim().split('\n')) {
      const message = JSON.parse(line);
      const emit = (event: Json) => child.stdout.write(JSON.stringify(event) + '\n');
      queueMicrotask(() => {
        void Promise.resolve(handler(message, emit)).catch(error => emit({ id: message.id, error: { message: String(error) } }));
      });
    }
  });
  return child;
}

async function fixture(repairResponse: string) {
  const directory = await mkdtemp(join(tmpdir(), 'mk-workflow-repair-'));
  directories.push(directory);
  const store = new Store(directory, directory);
  await store.init();
  store.settings.providers.find(provider => provider.id === 'codex')!.model = 'selected-model';
  const project = await store.create('Repair regression', 'reconstruct');
  const targetPath = join(store.projectDir(project.id), 'assets', 'target.png');
  await writeFile(targetPath, Buffer.from(state.png, 'base64'));
  await store.mutate(project.id, value => {
    value.target = { id: 'source-image', name: 'target.png', kind: 'image', mime: 'image/png', path: targetPath, width: 640, height: 360 };
  });
  const turns: Json[] = [];
  const observations = { rawBeforeRepair: '' };
  state.spawn.mockImplementation(() => {
    const threadId = `thread-${turns.length + 1}`;
    return fakeChild(async (message, emit) => {
      if (message.method === 'initialize') emit({ id: message.id, result: {} });
      if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: threadId } } });
      if (message.method !== 'turn/start') return;
      turns.push(message.params);
      if (turns.length === 2) observations.rawBeforeRepair = await readFile(join(store.projectDir(project.id), 'last-reconstruction-response.txt'), 'utf8');
      const response = turns.length === 1 ? malformedResponse : repairResponse;
      emit({ id: message.id, result: { turn: { id: 'turn' } } });
      emit({ method: 'item/completed', params: { threadId, item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: response } } });
      emit({ method: 'turn/completed', params: { threadId, turn: { id: 'turn', status: 'completed' } } });
    });
  });
  const hub = createProviders({
    cwd: directory, codexExecutable: process.execPath, getKey: () => undefined,
    getConfig: id => store.settings.providers.find(provider => provider.id === id)!,
  });
  hubs.push(hub);
  const events: ProgressEvent[] = [];
  return { store, project, turns, observations, events, workflow: new Workflow(store, () => hub, event => events.push(event)) };
}

beforeEach(() => {
  state.spawn.mockReset();
  state.render.mockReset().mockResolvedValue(Buffer.from(state.png, 'base64'));
});
afterEach(async () => {
  for (const hub of hubs.splice(0)) hub.dispose();
  for (const directory of directories.splice(0)) {
    expect(dirname(resolve(directory))).toBe(resolve(tmpdir()));
    expect(directory.split(/[\\/]/).at(-1)).toMatch(/^mk-workflow-repair-/);
    await rm(directory, { recursive: true, force: true });
  }
});

describe('Workflow repair through the actual Codex provider', () => {
  it('saves malformed model JSON before one repair request and persists the repaired editable scene', async () => {
    const { workflow, store, project, turns, observations, events } = await fixture(validResponse);
    const result = await workflow.run(project.id, 'reconstruct');
    const projectDirectory = store.projectDir(project.id);
    expect(turns).toHaveLength(2);
    expect(observations.rawBeforeRepair).toBe(malformedResponse);
    expect(turns[1].input[0].text).toContain('Fix only the schema/JSON errors');
    expect(turns[1].input[0].text).toContain(malformedResponse);
    expect(await readFile(join(projectDirectory, 'last-reconstruction-response.txt'), 'utf8')).toBe(malformedResponse);
    expect(await readFile(join(projectDirectory, 'last-reconstruction-repair.txt'), 'utf8')).toBe(validResponse);
    const saved = await store.load(project.id);
    expect(saved.scene).toEqual(repairedScene);
    expect(saved.stage).toBe('review');
    expect(saved.target?.id).toBe('source-image');
    expect(saved.history.at(-1)).toMatchObject({ action: 'reconstruct', message: '操作完成' });
    expect(result.previewSvg).toContain('Neural ODE');
    expect(await readFile(join(projectDirectory, 'preview.png'))).toEqual(Buffer.from(state.png, 'base64'));
    expect(state.render).toHaveBeenCalledTimes(1);
    expect(events.some(event => event.message.includes('模型结构需要修正'))).toBe(true);
  });

  it('keeps both responses and the source when the single repair is still invalid', async () => {
    const invalidRepair = '{"version":1,"elements":';
    const { workflow, store, project, turns } = await fixture(invalidRepair);
    await expect(workflow.run(project.id, 'reconstruct')).rejects.toThrow();
    const projectDirectory = store.projectDir(project.id);
    expect(turns).toHaveLength(2);
    expect(await readFile(join(projectDirectory, 'last-reconstruction-response.txt'), 'utf8')).toBe(malformedResponse);
    expect(await readFile(join(projectDirectory, 'last-reconstruction-repair.txt'), 'utf8')).toBe(invalidRepair);
    const saved = await store.load(project.id);
    expect(saved.scene).toBeUndefined();
    expect(saved.target?.id).toBe('source-image');
    expect(saved.history.at(-1)?.message).toContain('操作失败');
    expect(state.render).not.toHaveBeenCalled();
  });
});
