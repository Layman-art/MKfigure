import type { ProviderId } from '../shared/types';

export const PROVIDERS: Record<ProviderId, string> = { codex: 'Codex', openai: 'OpenAI API', deepseek: 'DeepSeek', custom: '自定义 API' };
export const REASONING_LABELS: Record<string, string> = { none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最高', ultra: '极高' };
export function reasoningLabel(value?: string) { return value ? REASONING_LABELS[value] || value : '自动'; }
export function errorText(error: unknown) { return error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '') : String(error); }
