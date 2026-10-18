import type { ModelCatalogState, ModelInfo } from '../shared/types';
import { redactError } from './providers/common';

export const MODEL_CATALOG_TTL_MS = 6 * 60 * 60_000;
const RETRY_DELAY_MS = 60_000;

/** Shared read-only directory. Refreshing never disposes running model connections. */
export class ModelCatalog {
  private state: ModelCatalogState = { models: [], stale: true };
  private inFlight?: Promise<ModelCatalogState>;
  private retryAt = 0;
  private generation = 0;
  constructor(private load: () => Promise<ModelInfo[]>, private now = Date.now) {}

  invalidate() {
    this.generation++;
    this.state = { models: [], stale: true };
    this.retryAt = 0;
    this.inFlight = undefined;
  }

  async read(force = false): Promise<ModelCatalogState> {
    if (this.inFlight) return structuredClone(await this.inFlight);
    const fresh = this.state.updatedAt && this.now() - Date.parse(this.state.updatedAt) < MODEL_CATALOG_TTL_MS;
    if (!force && ((fresh && !this.state.error) || this.now() < this.retryAt)) return structuredClone({ ...this.state, stale: !fresh || !!this.state.error });
    const generation = this.generation;
    const request = (async () => {
      try {
        const models = await this.load();
        if (generation === this.generation) {
          this.state = { models: structuredClone(models), updatedAt: new Date(this.now()).toISOString(), stale: false };
          this.retryAt = 0;
        }
      } catch (error) {
        if (generation === this.generation) {
          this.state = { ...this.state, error: redactError(error), stale: true };
          this.retryAt = this.now() + RETRY_DELAY_MS;
        }
      }
      return structuredClone(this.state);
    })();
    this.inFlight = request;
    try { return structuredClone(await request); }
    finally { if (this.inFlight === request) this.inFlight = undefined; }
  }
}
