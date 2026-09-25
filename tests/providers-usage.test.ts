import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TokenUsage } from '../src/shared/types';
import type { ProviderOptions } from '../src/main/providers/types';

const state = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: state.spawn }));
import { CodexProvider } from '../src/main/providers/codex';
import { createProviders } from '../src/main/providers';

type Emit = (message: any) => void;
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XkAAAAASUVORK5CYII=';
const options: ProviderOptions = {
  cwd: tmpdir(), codexExecutable: process.execPath, getKey: () => undefined,
  getConfig: id => ({ id, enabled: true, baseUrl: '', model: 'chosen-model', vision: true }),
};
const providers: Array<{ dispose(): void }> = [];
const request = { provider: 'codex' as const, model: 'chosen-model', system: '', prompt: 'Make a figure.', json: true };
const usageEvent = (total: unknown, last: unknown = total, threadId = 'thread', turnId = 'turn') => ({
  method: 'thread/tokenUsage/updated', params: { threadId, turnId, tokenUsage: { total, last, modelContextWindow: null } },
});
function finish(emit: Emit) {
  emit({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '{"ok":true}' } } });
  emit({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
}
function transport(onTurn: (message: any, emit: Emit) => void, models: any[] = []) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill: vi.fn(),
  });
  const emit: Emit = message => child.stdout.write(JSON.stringify(message) + '\n');
  child.stdin.on('data', data => {
    for (const line of data.toString().trim().split('\n')) {
      const message = JSON.parse(line);
      queueMicrotask(() => {
        if (message.method === 'turn/start') { onTurn(message, emit); return; }
        const result = message.method === 'thread/start' ? { thread: { id: 'thread' } }
          : message.method === 'model/list' ? { data: models, nextCursor: null } : {};
        if (message.id !== undefined) emit({ id: message.id, result });
      });
    }
  });
  state.spawn.mockReturnValue(child);
  const provider = new CodexProvider(options);
  providers.push(provider);
  return { child, emit, provider };
}

beforeEach(() => { state.spawn.mockReset(); vi.useFakeTimers(); });
afterEach(async () => {
  for (const provider of providers.splice(0)) provider.dispose();
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('Codex request token snapshots', () => {
  it('uses cumulative total once, ignores stale/duplicate snapshots, and never adds last or reasoning again', async () => {
    const reports: TokenUsage[] = [];
    const { provider } = transport((message, emit) => {
      emit({ id: message.id, result: { turn: { id: 'turn' } } });
      queueMicrotask(() => {
        const first = { inputTokens: 100, cachedInputTokens: 20, outputTokens: 10, reasoningOutputTokens: 4, totalTokens: 110 };
        const next = { inputTokens: 150, cachedInputTokens: 40, outputTokens: 30, reasoningOutputTokens: 8, totalTokens: 180 };
        emit(usageEvent(first, { inputTokens: 1000, outputTokens: 1000, totalTokens: 2000 }));
        emit(usageEvent(next));
        emit(usageEvent(next));
        emit(usageEvent(first));
        finish(emit);
      });
    });
    await expect(provider.complete({ ...request, onUsage: snapshot => reports.push(snapshot) })).resolves.toBe('{"ok":true}');
    expect(reports).toHaveLength(2);
    expect(reports.at(-1)).toEqual({ inputTokens: 150, cachedInputTokens: 40, outputTokens: 30, reasoningOutputTokens: 8, totalTokens: 180 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('buffers usage arriving before the turn-start reply and only accepts the matching thread and turn', async () => {
    const reports: TokenUsage[] = [];
    const { provider } = transport((message, emit) => {
      emit(usageEvent({ totalTokens: 999 }, undefined, 'other-thread'));
      emit(usageEvent({ totalTokens: 800 }, undefined, 'thread', 'other-turn'));
      emit(usageEvent({ inputTokens: 40, outputTokens: 5, totalTokens: 45 }));
      emit({ id: message.id, result: { turn: { id: 'turn' } } });
      queueMicrotask(() => {
        emit(usageEvent({ totalTokens: 900 }, undefined, 'thread', 'other-turn'));
        emit(usageEvent({ inputTokens: 40, outputTokens: 15, totalTokens: 55 }));
        finish(emit);
      });
    });
    await provider.complete({ ...request, onUsage: snapshot => reports.push(snapshot) });
    expect(reports).toEqual([{ inputTokens: 40, outputTokens: 5, totalTokens: 45 }, { inputTokens: 40, outputTokens: 15, totalTokens: 55 }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('captures usage arriving after turn-completed in the same protocol batch', async () => {
    const reports: TokenUsage[] = [];
    const { provider, emit } = transport((message, send) => {
      send({ id: message.id, result: { turn: { id: 'turn' } } });
      queueMicrotask(() => { finish(send); send(usageEvent({ totalTokens: 123 })); });
    });
    await provider.complete({ ...request, onUsage: snapshot => reports.push(snapshot) });
    expect(reports).toEqual([{ totalTokens: 123 }]);
    emit(usageEvent({ totalTokens: 456 }));
    expect(reports).toEqual([{ totalTokens: 123 }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps missing or invalid usage unknown rather than manufacturing zero or using last', async () => {
    const onUsage = vi.fn();
    const { provider } = transport((message, emit) => {
      emit({ id: message.id, result: { turn: { id: 'turn' } } });
      emit(usageEvent(undefined, { inputTokens: 3, outputTokens: 4, totalTokens: 7 }));
      emit(usageEvent({ inputTokens: null, outputTokens: '20', totalTokens: -1, cachedInputTokens: 1.5, reasoningOutputTokens: Number.MAX_SAFE_INTEGER + 1 }));
      finish(emit);
    });
    await provider.complete({ ...request, onUsage });
    expect(onUsage).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves explicit zero and leaves absent breakdown fields undefined', async () => {
    const onUsage = vi.fn();
    const { provider } = transport((message, emit) => {
      emit({ id: message.id, result: { turn: { id: 'turn' } } });
      emit(usageEvent({ outputTokens: 0 }));
      finish(emit);
    });
    await provider.complete({ ...request, onUsage });
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ outputTokens: 0 });
  });

  it('reports known usage even when the model turn fails and releases its listeners', async () => {
    const onUsage = vi.fn();
    const { provider, emit } = transport((message, send) => {
      send({ id: message.id, result: { turn: { id: 'turn' } } });
      queueMicrotask(() => {
        send(usageEvent({ inputTokens: 7, totalTokens: 7 }));
        send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'failed', error: { message: 'model failed' } } } });
      });
    });
    await expect(provider.complete({ ...request, onUsage })).rejects.toThrow('model failed');
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 7, totalTokens: 7 });
    emit(usageEvent({ totalTokens: 90 }));
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('isolates usage callback errors and mutation from the request and later snapshots', async () => {
    const reports: TokenUsage[] = [];
    const { provider } = transport((message, emit) => {
      emit({ id: message.id, result: { turn: { id: 'turn' } } });
      queueMicrotask(() => {
        emit(usageEvent({ inputTokens: 10, totalTokens: 20 }));
        emit(usageEvent({ inputTokens: 20, totalTokens: 30 }));
        finish(emit);
      });
    });
    await expect(provider.complete({ ...request, onUsage: snapshot => {
      reports.push({ ...snapshot }); snapshot.inputTokens = 9999; throw new Error('observer failure');
    } })).resolves.toBe('{"ok":true}');
    expect(reports).toEqual([{ inputTokens: 10, totalTokens: 20 }, { inputTokens: 20, totalTokens: 30 }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles a rejected asynchronous usage observer without an unhandled rejection', async () => {
    const { provider } = transport((message, emit) => {
      emit({ id: message.id, result: { turn: { id: 'turn' } } });
      emit(usageEvent({ totalTokens: 10 }));
      finish(emit);
    });
    await expect(provider.complete({ ...request, onUsage: async () => { throw new Error('async observer failed'); } })).resolves.toBe('{"ok":true}');
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['low', 'xhigh'])('forwards image reasoning effort %s unchanged and reports native image turn usage', async effort => {
    const onUsage = vi.fn();
    const { provider } = transport((message, emit) => {
      expect(message.params.effort).toBe(effort);
      emit({ id: message.id, result: { turn: { id: 'turn' } } });
      emit(usageEvent({ inputTokens: 11, outputTokens: 22, totalTokens: 33 }));
      emit({ method: 'item/completed', params: { threadId: 'thread', turnId: 'turn', item: { type: 'imageGeneration', id: 'image', status: 'completed', result: png } } });
      finish(emit);
    });
    const outputDir = await mkdtemp(join(tmpdir(), 'mk-usage-image-'));
    const result = await provider.generateImage({ provider: 'codex', model: 'chosen-model', prompt: 'Scientific illustration', reasoningEffort: effort, onUsage, outputDir });
    expect(await readFile(result.path)).toEqual(Buffer.from(png, 'base64'));
    expect(onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 11, outputTokens: 22, totalTokens: 33 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the server default model and actual reasoning options', async () => {
    const { provider } = transport(() => {}, [
      { model: 'default-model', displayName: 'Default', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'ultra' }], inputModalities: ['text', 'image'] },
      { model: 'another-model', isDefault: false, supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], inputModalities: ['text'] },
    ]);
    expect(await provider.listModels()).toMatchObject([
      { id: 'default-model', isDefault: true, reasoningEfforts: ['low', 'ultra'], supportsVision: true },
      { id: 'another-model', isDefault: false, reasoningEfforts: ['medium'], supportsVision: false },
    ]);
  });
});

describe('Codex-only provider routing', () => {
  it('rejects legacy API routes without spawning Codex or connecting externally', async () => {
    const hub = createProviders(options);
    providers.push(hub);
    for (const provider of ['openai', 'deepseek', 'custom'] as const) {
      await expect(hub.status(provider)).rejects.toThrow('仅支持 Codex');
      await expect(hub.listModels(provider)).rejects.toThrow('仅支持 Codex');
      await expect(hub.complete({ ...request, provider })).rejects.toThrow('仅支持 Codex');
    }
    for (const provider of ['openai', 'custom'] as const) {
      await expect(hub.generateImage({ provider, model: 'unused', prompt: '', outputDir: tmpdir() })).rejects.toThrow('仅支持 Codex');
    }
    expect(state.spawn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
