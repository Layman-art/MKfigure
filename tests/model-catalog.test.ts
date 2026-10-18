import { describe, expect, it, vi } from 'vitest';
import { ModelCatalog, MODEL_CATALOG_TTL_MS } from '../src/main/model-catalog';

describe('shared model catalog', () => {
  it('deduplicates concurrent refreshes and refreshes after six hours', async () => {
    let now = 1000;
    const load = vi.fn(async () => [{ id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }]);
    const catalog = new ModelCatalog(load, () => now);
    const reads = await Promise.all(Array.from({ length: 6 }, () => catalog.read(true)));
    expect(load).toHaveBeenCalledTimes(1);
    reads[0].models.length = 0;
    expect((await catalog.read()).models).toHaveLength(1);
    expect(load).toHaveBeenCalledTimes(1);
    now += MODEL_CATALOG_TTL_MS;
    await catalog.read();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('retains successful results after failure, limits automatic retries, and allows manual retry', async () => {
    const load = vi.fn().mockResolvedValueOnce([{ id: 'old' }]).mockRejectedValueOnce(new Error('offline')).mockResolvedValue([{ id: 'new' }]);
    const catalog = new ModelCatalog(load, () => 1000);
    const initial = await catalog.read();
    const failed = await catalog.read(true);
    expect(failed).toMatchObject({ models: [{ id: 'old' }], updatedAt: initial.updatedAt, stale: true, error: 'offline' });
    await catalog.read();
    expect(load).toHaveBeenCalledTimes(2);
    expect(await catalog.read(true)).toMatchObject({ models: [{ id: 'new' }], stale: false });
  });

  it('does not let stale in-flight results restore a previous account catalog', async () => {
    let finish!: (value: Array<{ id: string }>) => void;
    const load = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue([{ id: 'new-account' }]);
    const catalog = new ModelCatalog(load);
    const first = catalog.read();
    catalog.invalidate();
    await catalog.read();
    finish([{ id: 'old-account' }]);
    await first;
    expect((await catalog.read()).models).toEqual([{ id: 'new-account' }]);
  });
});
