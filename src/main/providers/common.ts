import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function redactError(error: unknown, secrets: string[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) message = message.split(secret).join('[redacted]');
  return message.replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[redacted]')
    .replace(/(access_token|refresh_token|id_token|api_key)(["':=\s]+)[^\s"',}]+/gi, '$1$2[redacted]')
    .replace(/data:image\/[\w.+-]+;base64,[a-zA-Z0-9+/=]+/g, '[image]')
    .slice(0, 1200);
}
export const MODEL_TIMEOUT_MS = 30 * 60_000;
export const MODEL_IDLE_TIMEOUT_MS = 10 * 60_000;
const duration = (ms: number) => ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1000)} 秒`;

export function timedSignal(signal?: AbortSignal, ms = 300_000, idleMs?: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? new Error('请求已取消'));
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error(`请求达到 ${duration(ms)} 上限，请调整任务范围或推理强度后重试`)), ms);
  timer.unref?.();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    if (idleMs === undefined || controller.signal.aborted) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(new Error(`模型连续 ${duration(idleMs)} 无响应，请检查连接后重试`)), idleMs);
    idleTimer.unref?.();
  };
  touch();
  return { signal: controller.signal, touch, dispose: () => { clearTimeout(timer); clearTimeout(idleTimer); signal?.removeEventListener('abort', abort); } };
}

// Display elapsed time without treating the UI timer as model activity.
export function modelProgress(model: string, onEvent?: (message: string) => void) {
  const started = Date.now();
  let phase = '等待模型响应', lastReported = -Infinity;
  const report = () => {
    const now = Date.now();
    if (now - lastReported < 1000) return;
    lastReported = now;
    const seconds = Math.floor((now - started) / 1000);
    try { onEvent?.(`${model} · ${phase} · ${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`); }
    catch { /* A closed UI must not interrupt the request or bypass timer cleanup. */ }
  };
  const timer = onEvent ? setInterval(report, 15_000) : undefined;
  timer?.unref?.();
  report();
  return { update: (message: string) => { phase = message; report(); }, dispose: () => clearInterval(timer) };
}
export function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('请求已取消');
}
export function decodeImage(dataUrl: string): { bytes: Buffer; mime: string; extension: string } {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([a-zA-Z0-9+/=\r\n]+)$/.exec(dataUrl);
  if (!match) throw new Error('图片必须是 PNG、JPEG、WebP 或 GIF 的 base64 数据');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > 32 * 1024 * 1024 || bytes.length < 12) throw new Error('图片文件为空或超过 32 MB');
  const mime = sniffImage(bytes);
  if (!mime || mime !== match[1]) throw new Error('图片内容与文件格式不一致');
  return { bytes, mime, extension: mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1] };
}
export function sniffImage(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
}
export async function saveImage(bytes: Buffer, outputDir: string, signal?: AbortSignal): Promise<string> {
  checkAbort(signal);
  const mime = sniffImage(bytes);
  if (!mime || bytes.length > 64 * 1024 * 1024) throw new Error('服务未返回有效的图片文件');
  await mkdir(outputDir, { recursive: true });
  checkAbort(signal);
  const path = join(outputDir, `generated-${randomUUID()}.${mime === 'image/jpeg' ? 'jpg' : mime.split('/')[1]}`);
  await writeFile(path, bytes, { flag: 'wx', signal });
  return path;
}
export function assertModel(model: string) {
  if (!model.trim() || model.length > 200 || /[\r\n\0]/.test(model)) throw new Error('请填写有效的模型 ID');
}
export async function readResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('服务返回内容超过大小限制');
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('服务返回内容超过大小限制'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
