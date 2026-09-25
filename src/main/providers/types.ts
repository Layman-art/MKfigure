import type { ModelInfo, ProviderConfig, ProviderId, ProviderStatus, TokenUsage } from '../../shared/types';

export interface ProviderOptions {
  getConfig: (id: ProviderId) => ProviderConfig;
  getKey: (id: ProviderId) => string | undefined;
  codexExecutable?: string;
  cwd: string;
  onEvent?: (message: string) => void;
}
export interface CompleteRequest {
  provider: ProviderId;
  model: string;
  system: string;
  prompt: string;
  images?: Array<{ dataUrl: string; path?: string }>;
  json?: boolean;
  signal?: AbortSignal;
  reasoningEffort?: string;
  onEvent?: (message: string) => void;
  /** Cumulative snapshot for this request, never a token delta. */
  onUsage?: (usage: TokenUsage) => void;
}
export interface ImageRequest {
  provider: 'codex' | 'openai' | 'custom';
  model: string;
  prompt: string;
  mode?: 'create' | 'edit';
  references?: Array<{ dataUrl: string; path?: string }>;
  signal?: AbortSignal;
  outputDir: string;
  onEvent?: (message: string) => void;
  reasoningEffort?: string;
  onUsage?: (usage: TokenUsage) => void;
}
export interface ProviderHub {
  status(id: ProviderId): Promise<ProviderStatus>;
  loginCodex(): Promise<ProviderStatus>;
  listModels(id: ProviderId): Promise<ModelInfo[]>;
  complete(request: CompleteRequest): Promise<string>;
  generateImage(request: ImageRequest): Promise<{ path?: string; dataUrl?: string; model?: string }>;
  dispose(): void;
}
