import { CodexProvider } from './codex';
import type { ProviderHub, ProviderOptions } from './types';
export type { ProviderHub, ProviderOptions, CompleteRequest, ImageRequest } from './types';

export function createProviders(options: ProviderOptions): ProviderHub {
  const codex = new CodexProvider(options);
  const unsupported = () => Promise.reject(new Error('当前版本仅支持 Codex，请在模型连接中选择 Codex'));
  return {
    status: id => id === 'codex' ? codex.status() : unsupported(),
    loginCodex: () => codex.login(),
    listModels: id => id === 'codex' ? codex.listModels() : unsupported(),
    complete: request => request.provider === 'codex' ? codex.complete(request) : unsupported(),
    generateImage: request => request.provider === 'codex' ? codex.generateImage(request) : unsupported(),
    dispose: () => codex.dispose(),
  };
}
