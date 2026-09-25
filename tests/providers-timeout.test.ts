import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import type { CompleteRequest, ProviderOptions } from '../src/main/providers/types';

const state = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: state.spawn }));
import { CodexProvider } from '../src/main/providers/codex';

const MINUTE = 60_000;
const providers: CodexProvider[] = [];
const options: ProviderOptions = {
  cwd: tmpdir(), codexExecutable: process.execPath, getKey: () => undefined,
  getConfig: id => ({ id, enabled: true, baseUrl: '', model: 'chosen-model', vision: true }),
};

type Outcome = { status: 'fulfilled'; value: string } | { status: 'rejected'; error: Error };

// Simulate only the local stdio protocol; no executable, account or model is used.
async function startTurn(extra: Partial<CompleteRequest> & { onEvent?: (message: string) => void } = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, kill: vi.fn(),
  });
  const sent: Array<{ id?: number; method?: string; params?: any }> = [];
  const emit = (method: string, params: any) => child.stdout.write(JSON.stringify({ method, params }) + '\n');
  child.stdin.on('data', data => {
    for (const line of data.toString().trim().split('\n')) {
      const message = JSON.parse(line);
      sent.push(message);
      const result = message.method === 'thread/start' ? { thread: { id: 'test-thread' } }
        : message.method === 'turn/start' ? { turn: { id: 'test-turn' } } : {};
      if (message.id !== undefined) queueMicrotask(() => {
        if (!child.stdout.writableEnded) child.stdout.write(JSON.stringify({ id: message.id, result }) + '\n');
      });
    }
  });
  state.spawn.mockReturnValue(child);
  const provider = new CodexProvider(options);
  providers.push(provider);
  const request: CompleteRequest & { onEvent?: (message: string) => void } = {
    provider: 'codex', model: 'chosen-model', system: 'Return JSON only.', prompt: 'Reconstruct the figure.', json: true, ...extra,
  };
  let outcome: Outcome | undefined;
  const promise = provider.complete(request);
  void promise.then(value => { outcome = { status: 'fulfilled', value }; }, error => { outcome = { status: 'rejected', error }; });
  await vi.advanceTimersByTimeAsync(0);
  expect(sent.some(message => message.method === 'turn/start')).toBe(true);
  return {
    child, sent, emit, promise, outcome: () => outcome,
    activity: (threadId = 'test-thread') => emit('item/reasoning/summaryTextDelta', {
      threadId, turnId: 'test-turn', itemId: 'reasoning', delta: 'PRIVATE_REASONING_DO_NOT_SHOW',
    }),
    finish: () => {
      emit('item/completed', { threadId: 'test-thread', turnId: 'test-turn', item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '{"ok":true}' } });
      emit('turn/completed', { threadId: 'test-thread', turn: { id: 'test-turn', status: 'completed' } });
    },
  };
}

beforeEach(() => { state.spawn.mockReset(); vi.useFakeTimers(); });
afterEach(async () => {
  for (const provider of providers.splice(0)) provider.dispose();
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('Codex long-running reconstruction deadlines', () => {
  it('does not let a failed progress observer leak timers or abort the model', async () => {
    const run = await startTurn({ onEvent: () => { throw new Error('window destroyed'); } });
    run.activity();
    await vi.advanceTimersByTimeAsync(15_000);
    run.finish();
    await expect(run.promise).resolves.toBe('{"ok":true}');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a pre-aborted request without spawning or allocating timers', async () => {
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    const progress = vi.fn();
    const provider = new CodexProvider(options);
    providers.push(provider);
    await expect(provider.complete({ provider: 'codex', model: 'chosen-model', system: '', prompt: '', signal: controller.signal, onEvent: progress })).rejects.toThrow('already cancelled');
    expect(state.spawn).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans deadline and progress timers when the child fails during initialization', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      exitCode: null, kill: vi.fn(),
    });
    state.spawn.mockImplementation(() => {
      queueMicrotask(() => child.emit('error', new Error('simulated launch failure')));
      return child;
    });
    const provider = new CodexProvider(options);
    providers.push(provider);
    await expect(provider.complete({ provider: 'codex', model: 'chosen-model', system: '', prompt: '', onEvent: vi.fn() })).rejects.toThrow('启动失败');
    expect(child.stdin.writableEnded).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps an active reconstruction running past 300 seconds and returns its final JSON', async () => {
    const run = await startTurn();
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    run.activity();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(run.outcome()).toBeUndefined();
    run.emit('item/agentMessage/delta', { threadId: 'test-thread', turnId: 'test-turn', itemId: 'answer', delta: '{"ok":' });
    run.finish();
    await expect(run.promise).resolves.toBe('{"ok":true}');
    expect(run.child.stdin.writableEnded).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops after ten minutes with no activity and explains the inactivity', async () => {
    const run = await startTurn();
    await vi.advanceTimersByTimeAsync(10 * MINUTE - 1);
    expect(run.outcome()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(run.outcome()?.status).toBe('rejected');
    await expect(run.promise).rejects.toThrow('无响应');
    expect(run.child.stdin.writableEnded).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not renew the deadline for notifications from another thread', async () => {
    const run = await startTurn();
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    run.activity('unrelated-thread');
    await vi.advanceTimersByTimeAsync(4 * MINUTE);
    run.activity('unrelated-thread');
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(run.outcome()?.status).toBe('rejected');
    await expect(run.promise).rejects.toThrow('无响应');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not renew the deadline for another turn in the same thread', async () => {
    const run = await startTurn();
    for (let step = 0; step < 2; step++) {
      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      run.emit('item/agentMessage/delta', { threadId: 'test-thread', turnId: 'previous-turn', itemId: 'old-answer', delta: 'late stale output' });
    }
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(run.outcome()?.status).toBe('rejected');
    await expect(run.promise).rejects.toThrow('无响应');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a late turn-completed notification for another turn', async () => {
    const run = await startTurn();
    run.emit('turn/completed', { threadId: 'test-thread', turn: { id: 'previous-turn', status: 'failed', error: { message: 'stale failure' } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(run.outcome()).toBeUndefined();
    run.finish();
    await expect(run.promise).resolves.toBe('{"ok":true}');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enforces a thirty-minute absolute limit even when reasoning continues', async () => {
    const run = await startTurn();
    for (let step = 0; step < 7; step++) {
      await vi.advanceTimersByTimeAsync(4 * MINUTE);
      expect(run.outcome()).toBeUndefined();
      run.activity();
    }
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(run.outcome()?.status).toBe('rejected');
    await expect(run.promise).rejects.toThrow('30 分钟');
    expect(run.child.stdin.writableEnded).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails immediately if stdout closes while the child process has not exited', async () => {
    const run = await startTurn();
    run.child.stdout.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.child.exitCode).toBeNull();
    expect(run.outcome()?.status).toBe('rejected');
    await expect(run.promise).rejects.toThrow('输出流已关闭');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves a completed answer when stdout closes immediately afterward', async () => {
    const run = await startTurn();
    run.finish();
    run.child.stdout.end();
    await expect(run.promise).resolves.toBe('{"ok":true}');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors user cancellation and removes every deadline timer', async () => {
    const controller = new AbortController();
    const run = await startTurn({ signal: controller.signal });
    await vi.advanceTimersByTimeAsync(MINUTE);
    run.activity();
    controller.abort(new Error('user cancelled'));
    await expect(run.promise).rejects.toThrow('user cancelled');
    expect(run.sent.some(message => message.method === 'turn/interrupt')).toBe(true);
    expect(run.child.stdin.writableEnded).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports request-scoped progress without exposing raw reasoning text', async () => {
    const progress = vi.fn();
    const run = await startTurn({ onEvent: progress });
    await vi.advanceTimersByTimeAsync(1000);
    run.emit('item/started', { threadId: 'test-thread', turnId: 'test-turn', item: { id: 'reasoning', type: 'reasoning' } });
    run.activity();
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).toHaveBeenCalled();
    expect(progress.mock.calls.flat().join(' ')).toContain('分析');
    expect(progress.mock.calls.flat().join(' ')).not.toContain('PRIVATE_REASONING_DO_NOT_SHOW');
    run.finish();
    await expect(run.promise).resolves.toBe('{"ok":true}');
    expect(vi.getTimerCount()).toBe(0);
  });
});
