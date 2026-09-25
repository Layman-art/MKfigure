import { expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviders } from '../src/main/providers';
import type { TokenUsage } from '../src/shared/types';

// Explicit opt-in only: ordinary CI does not spend user quota or read a live account.
it.skipIf(process.env.MK_CODEX_LIVE !== '1')('live Codex account/catalog and bounded JSON completion', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'mk-codex-live-'));
  const hub = createProviders({ cwd, codexExecutable: process.env.MK_CODEX_PATH,
    getKey: () => undefined, getConfig: id => ({ id, enabled: true, baseUrl: '', model: '', vision: true }),
  });
  try {
    const status = await hub.status('codex');
    expect(status.available, status.detail).toBe(true);
    expect(status.authenticated, status.detail).toBe(true);
    const models = await hub.listModels('codex');
    expect(models.length).toBeGreaterThan(0);
    const model = process.env.MK_CODEX_MODEL || models.find(m => m.isDefault)?.id || models[0].id;
    let usage: TokenUsage | undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('live probe deadline 120s')), 120_000);
    try {
      const answer = await hub.complete({ provider: 'codex', model, system: 'Return exactly the requested JSON. Do not invoke tools.',
        prompt: 'Return exactly {"ok":true,"client":"mk-figure"}.', json: true, reasoningEffort: 'low', signal: controller.signal, onUsage: snapshot => { usage = snapshot; } });
      expect(JSON.parse(answer)).toEqual({ ok: true, client: 'mk-figure' });
      const result = { probe: 'codex-live', authenticated: true, modelCount: models.length, model, jsonCompleted: true, usage, tokenUsageReported: usage?.totalTokens != null };
      console.info(JSON.stringify(result));
      if (process.env.MK_CODEX_PROBE_REPORT) await writeFile(process.env.MK_CODEX_PROBE_REPORT, JSON.stringify(result, null, 2));
    } finally { clearTimeout(timer); }
  } finally { hub.dispose(); }
}, 160_000);

it.skipIf(process.env.MK_CODEX_IMAGE_LIVE !== '1')('live native Codex image generation returns image bytes', async () => {
  const cwd = process.env.MK_CODEX_IMAGE_DIR || await mkdtemp(join(tmpdir(), 'mk-codex-image-'));
  await mkdir(cwd, { recursive: true });
  const hub = createProviders({ cwd, codexExecutable: process.env.MK_CODEX_PATH,
    getKey: () => undefined, getConfig: id => ({ id, enabled: true, baseUrl: '', model: '', vision: true }),
    onEvent: message => console.info(message),
  });
  try {
    const model = process.env.MK_CODEX_MODEL || 'gpt-5.5';
    const result = await hub.generateImage({ provider: 'codex', model, outputDir: cwd,
      prompt: 'Generate a clean white academic illustration showing three blue circles connected by two arrows, titled Neural ODE. Use the native image generation tool. Minimal schematic for an integration test; no other tools.' });
    expect(result.path).toBeTruthy();
    console.info(JSON.stringify({ probe: 'codex-native-image', model, path: result.path, generated: true }));
  } finally { hub.dispose(); }
}, 630_000);
