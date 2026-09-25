import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderOptions } from '../src/main/providers/types';

const state = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: state.spawn }));
import { CodexProvider, CodexRpc } from '../src/main/providers/codex';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XkAAAAASUVORK5CYII=';
function fakeChild(handler: (message: any, emit: (message: any) => void) => void) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill: vi.fn() });
  const messages: any[] = [];
  child.stdin.on('data', data => {
    for (const line of data.toString().trim().split('\n')) {
      const message = JSON.parse(line); messages.push(message);
      queueMicrotask(() => handler(message, event => child.stdout.write(JSON.stringify(event) + '\n')));
    }
  });
  return { child, messages };
}
const options: ProviderOptions = { cwd: tmpdir(), codexExecutable: process.execPath, getKey: () => undefined, getConfig: id => ({ id, enabled: true, baseUrl: '', model: 'chosen-model', vision: true }) };
beforeEach(() => state.spawn.mockReset());

describe('Codex official app-server stdio protocol', () => {
  it('handshakes before requests; routes out-of-order replies and declines tools', async () => {
    let one: any;
    const mock = fakeChild((message, emit) => {
      if (message.method === 'initialize') emit({ id: message.id, result: { userAgent: 'test' } });
      if (message.method === 'one') one = message;
      if (message.method === 'two') { emit({ id: message.id, result: 2 }); emit({ id: one.id, result: 1 }); emit({ id: 'server-request', method: 'item/commandExecution/requestApproval', params: {} }); }
    });
    state.spawn.mockReturnValue(mock.child);
    const rpc = new CodexRpc(process.execPath, tmpdir());
    await rpc.start();
    expect(await Promise.all([rpc.request('one', {}), rpc.request('two', {})])).toEqual([1, 2]);
    expect(mock.messages[0].method).toBe('initialize');
    expect(mock.messages[1].method).toBe('initialized');
    expect(mock.messages.find(m => m.id === 'server-request')?.result).toEqual({ decision: 'decline' });
    rpc.dispose();
  });
  it('maps account/model discovery without exposing email or tokens', async () => {
    const mock = fakeChild((message, emit) => {
      const result = message.method === 'account/read' ? { account: { type: 'chatgpt', email: 'private@example.com' } } : message.method === 'model/list' ? { data: [{ id: 'entry', model: 'exact-model', displayName: 'Model', inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] } : {};
      if (message.id) emit({ id: message.id, result });
    });
    state.spawn.mockReturnValue(mock.child);
    const provider = new CodexProvider(options);
    expect(await provider.status()).toMatchObject({ authenticated: true, available: true });
    expect(JSON.stringify(await provider.status())).not.toContain('private@');
    expect(await provider.listModels()).toMatchObject([{ id: 'exact-model', supportsVision: true, reasoningEfforts: ['high'] }]);
    provider.dispose();
  });
  it('collects streamed final answer and keeps image generation disabled for JSON', async () => {
    const mock = fakeChild((message, emit) => {
      if (message.method === 'initialize') emit({ id: message.id, result: {} });
      if (message.method === 'thread/start') { expect(message.params.config['features.image_generation']).toBe(false); expect(message.params.sandbox).toBe('read-only'); expect(message.params.allowProviderModelFallback).toBe(false); emit({ id: message.id, result: { thread: { id: 't1' } } }); }
      if (message.method === 'turn/start') {
        emit({ id: message.id, result: { turn: { id: 'r1' } } });
        emit({ method: 'item/agentMessage/delta', params: { threadId: 'other', itemId: 'a', delta: 'ignore' } });
        emit({ method: 'item/agentMessage/delta', params: { threadId: 't1', itemId: 'a', delta: '{"ok":' } });
        emit({ method: 'item/completed', params: { threadId: 't1', item: { id: 'a', type: 'agentMessage', phase: 'final_answer', text: '{"ok":true}' } } });
        emit({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'r1', status: 'completed' } } });
      }
    });
    state.spawn.mockReturnValue(mock.child);
    const provider = new CodexProvider(options);
    expect(await provider.complete({ provider: 'codex', model: 'chosen-model', system: 'JSON only', prompt: 'Describe', json: true })).toBe('{"ok":true}');
    expect(mock.child.stdin.writableEnded).toBe(true);
    provider.dispose();
  });
  it('accepts imageGeneration event bytes, never an assistant claim', async () => {
    let withImage = true;
    state.spawn.mockImplementation(() => fakeChild((message, emit) => {
      if (message.method === 'initialize') emit({ id: message.id, result: {} });
      if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 't' } } });
      if (message.method === 'turn/start') {
        expect(message.params.input[1]).toMatchObject({ type: 'image', url: `data:image/png;base64,${png}` });
        emit({ id: message.id, result: { turn: { id: 'r' } } });
        if (withImage) emit({ method: 'item/completed', params: { threadId: 't', item: { type: 'imageGeneration', id: 'img', status: 'completed', result: png, failure: null } } });
        emit({ method: 'item/completed', params: { threadId: 't', item: { type: 'agentMessage', id: 'a', text: 'Successfully generated image', phase: 'final_answer' } } });
        emit({ method: 'turn/completed', params: { threadId: 't', turn: { status: 'completed' } } });
      }
    }).child);
    const provider = new CodexProvider(options);
    const request = { provider: 'codex' as const, model: 'chosen-model', prompt: 'Generate', references: [{ dataUrl: `data:image/png;base64,${png}` }], outputDir: await mkdtemp(join(tmpdir(), 'mk-codex-')) };
    const image = await provider.generateImage(request);
    expect(await readFile(image.path)).toEqual(Buffer.from(png, 'base64'));
    withImage = false;
    await expect(provider.generateImage(request)).rejects.toThrow('没有返回原生图片');
    provider.dispose();
  });
  it('sends an edit as one source image with the literal prompt and low effort', async () => {
    const prompt = 'Only enlarge the title; preserve all other content.';
    const mock = fakeChild((message, emit) => {
      if (message.method === 'initialize') emit({ id: message.id, result: {} });
      if (message.method === 'thread/start') {
        expect(message.params.developerInstructions).toContain('source image to modify, not a visual style reference');
        expect(message.params.developerInstructions).toContain('Supply that source image');
        expect(message.params.config['features.image_generation']).toBe(true);
        expect(message.params.allowProviderModelFallback).toBe(false);
        emit({ id: message.id, result: { thread: { id: 'edit-thread' } } });
      }
      if (message.method === 'turn/start') {
        expect(message.params.effort).toBe('low');
        expect(message.params.input).toEqual([
          { type: 'text', text: prompt, text_elements: [] },
          { type: 'image', url: `data:image/png;base64,${png}` },
        ]);
        emit({ id: message.id, result: { turn: { id: 'edit-turn' } } });
        emit({ method: 'item/completed', params: { threadId: 'edit-thread', item: { type: 'imageGeneration', id: 'img', status: 'completed', result: png } } });
        emit({ method: 'turn/completed', params: { threadId: 'edit-thread', turn: { id: 'edit-turn', status: 'completed' } } });
      }
    });
    state.spawn.mockReturnValue(mock.child);
    const provider = new CodexProvider(options);
    const result = await provider.generateImage({ provider: 'codex', model: 'chosen-model', mode: 'edit', prompt, references: [{ dataUrl: `data:image/png;base64,${png}` }], reasoningEffort: 'low', outputDir: await mkdtemp(join(tmpdir(), 'mk-codex-edit-')) });
    expect(await readFile(result.path)).toEqual(Buffer.from(png, 'base64'));
    provider.dispose();
  });
  it.each([0, 2])('rejects edit with %i source images before opening an agent turn', async count => {
    const provider = new CodexProvider(options);
    await expect(provider.generateImage({ provider: 'codex', model: 'chosen-model', mode: 'edit', prompt: 'Improve', references: Array.from({ length: count }, () => ({ dataUrl: `data:image/png;base64,${png}` })), outputDir: tmpdir() })).rejects.toThrow('且仅需要一张原图');
    expect(state.spawn).not.toHaveBeenCalled();
    provider.dispose();
  });
  it('rejects an unsuccessful native edit even if the assistant claims success', async () => {
    const mock = fakeChild((message, emit) => {
      if (message.method === 'initialize') emit({ id: message.id, result: {} });
      if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 'edit-thread' } } });
      if (message.method === 'turn/start') {
        emit({ id: message.id, result: { turn: { id: 'edit-turn' } } });
        emit({ method: 'item/completed', params: { threadId: 'edit-thread', item: { type: 'imageGeneration', id: 'img', status: 'failed', result: png, failure: { type: 'unknown' } } } });
        emit({ method: 'item/completed', params: { threadId: 'edit-thread', item: { type: 'agentMessage', id: 'claim', phase: 'final_answer', text: 'The image was edited successfully.' } } });
        emit({ method: 'turn/completed', params: { threadId: 'edit-thread', turn: { id: 'edit-turn', status: 'completed' } } });
      }
    });
    state.spawn.mockReturnValue(mock.child);
    const provider = new CodexProvider(options);
    await expect(provider.generateImage({ provider: 'codex', model: 'chosen-model', mode: 'edit', prompt: 'Improve', references: [{ dataUrl: `data:image/png;base64,${png}` }], outputDir: tmpdir() })).rejects.toThrow('没有返回原生图片生成结果');
    provider.dispose();
  });
  it('rejects all waiters and cleans up when cancelled mid-turn', async () => {
    const controller = new AbortController();
    const mock = fakeChild((message, emit) => {
      if (message.method === 'initialize') emit({ id: message.id, result: {} });
      if (message.method === 'thread/start') emit({ id: message.id, result: { thread: { id: 't' } } });
      if (message.method === 'turn/start') { emit({ id: message.id, result: { turn: { id: 'r' } } }); setTimeout(() => controller.abort(new Error('user cancelled')), 10); }
    });
    state.spawn.mockReturnValue(mock.child);
    const provider = new CodexProvider(options);
    await expect(provider.complete({ provider: 'codex', model: 'model', system: '', prompt: '', signal: controller.signal })).rejects.toThrow('user cancelled');
    expect(mock.child.stdin.writableEnded).toBe(true);
    expect(mock.messages.some(m => m.method === 'turn/interrupt')).toBe(true);
    provider.dispose();
  });
});
