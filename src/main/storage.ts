import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeStorage, nativeImage } from 'electron';
import type { AppSettings, Asset, Brief, Project, ProjectSummary, ProviderId, StyleReference } from '../shared/types';

export const DEFAULT_BRIEF: Brief = { topic: '', focus: '', language: 'zh', purpose: 'paper', aspectRatio: 'auto', widthMm: 180, prompt: '', stylePrompt: '', notes: '', fullVector: true };
export const DEFAULT_SETTINGS: AppSettings = {
  activeProvider: 'codex', imageProvider: 'codex', imageModel: 'gpt-image-2.5-sunburst', reasoningEffort: 'medium',
  providers: [
    { id: 'codex', enabled: true, baseUrl: '', model: '', vision: true },
    { id: 'openai', enabled: true, baseUrl: 'https://api.openai.com/v1', model: '', vision: true },
    { id: 'deepseek', enabled: true, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', vision: true },
    { id: 'custom', enabled: true, baseUrl: '', model: '', vision: false },
  ],
};
const IDS: ProviderId[] = ['codex', 'openai', 'deepseek', 'custom'];
export const safeName = (name: string) => (`${/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(name) ? 'Figure-' : ''}${name}`.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').slice(0, 80) || 'Figure');
export function safeId(id: string): string { if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error('无效的项目标识'); return id; }
const cleanText = (v: unknown, max: number) => typeof v === 'string' ? v.slice(0, max) : '';
export function cleanBrief(value: unknown): Brief {
  const b = value as Partial<Brief>;
  return { topic: cleanText(b?.topic, 12000), focus: cleanText(b?.focus, 12000), prompt: cleanText(b?.prompt, 40000), stylePrompt: cleanText(b?.stylePrompt, 6000), notes: cleanText(b?.notes, 60000),
    language: ['zh','en','bilingual','original'].includes(b?.language || '') ? b.language! : 'zh',
    purpose: b?.purpose === 'slides' ? 'slides' : 'paper', aspectRatio: ['auto','2:1','16:9','3:2','4:3','1:1'].includes(b?.aspectRatio || '') ? b.aspectRatio! : 'auto',
    widthMm: typeof b?.widthMm === 'number' && Number.isFinite(b.widthMm) ? Math.min(1000, Math.max(50, b.widthMm)) : 180, fullVector: b?.fullVector !== false };
}
async function atomicJson(file: string, value: unknown) { const tmp = `${file}.${randomUUID()}.tmp`; await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8'); await fs.rename(tmp, file); }

export class Store {
  settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
  private encryptedKeys: Partial<Record<ProviderId, string>> = {};
  private queues = new Map<string, Promise<unknown>>();
  constructor(readonly directory: string, readonly resources: string) {}
  async init() {
    await fs.mkdir(path.join(this.directory, 'projects'), { recursive: true });
    try { const saved = JSON.parse(await fs.readFile(path.join(this.directory, 'settings.json'), 'utf8')); this.settings = this.cleanSettings(saved.settings); this.encryptedKeys = saved.keys || {}; } catch { /* first launch */ }
  }
  private cleanSettings(input: AppSettings): AppSettings {
    const merged = structuredClone(DEFAULT_SETTINGS);
    // Keep legacy connection data readable; the current product uses Codex only.
    merged.imageModel = cleanText(input?.imageModel, 160) || DEFAULT_SETTINGS.imageModel;
    merged.reasoningEffort = ['auto','none','minimal','low','medium','high','xhigh','max','ultra'].includes(input?.reasoningEffort) ? input.reasoningEffort : 'medium';
    for (const config of merged.providers) {
      const raw = input?.providers?.find(p => p.id === config.id); if (!raw) continue;
      const url = cleanText(raw.baseUrl, 2000).replace(/\/+$/, '');
      if (url && config.id !== 'codex') {
        const u = new URL(url); if (u.username || u.password || !['http:','https:'].includes(u.protocol)) throw new Error('API 地址必须是 HTTP(S)，且不能包含凭据');
        if (u.protocol === 'http:' && !['localhost','127.0.0.1','[::1]'].includes(u.hostname)) throw new Error('远程 API 请使用 HTTPS；HTTP 仅用于本机服务');
      }
      Object.assign(config, { enabled: raw.enabled !== false, baseUrl: url, model: cleanText(raw.model, 160), vision: raw.vision === true, codexPath: config.id === 'codex' ? cleanText(raw.codexPath, 3000) || undefined : undefined });
    }
    return merged;
  }
  publicSettings() { return { ...structuredClone(this.settings), providers: this.settings.providers.map(p => ({ ...p, hasKey: !!this.encryptedKeys[p.id] })) }; }
  key(id: ProviderId) { const encrypted = this.encryptedKeys[id]; if (!encrypted) return undefined; if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据存储不可用，请重新登录系统后重试'); return safeStorage.decryptString(Buffer.from(encrypted, 'base64')); }
  async saveSettings(input: AppSettings, keys: Partial<Record<ProviderId,string>> = {}) {
    const next = this.cleanSettings(input); const encrypted = { ...this.encryptedKeys };
    for (const id of IDS) if (Object.prototype.hasOwnProperty.call(keys, id)) {
      const key = cleanText(keys[id], 20000).trim();
      if (!key) delete encrypted[id]; else { if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，未保存 API Key'); encrypted[id] = safeStorage.encryptString(key).toString('base64'); }
    }
    await atomicJson(path.join(this.directory, 'settings.json'), { settings: next, keys: encrypted }); this.settings = next; this.encryptedKeys = encrypted; return this.publicSettings();
  }
  projectDir(id: string) { return path.join(this.directory, 'projects', safeId(id)); }
  async create(name: string, route: 'full'|'reconstruct') {
    const now = new Date().toISOString(); const project: Project = { id: randomUUID(), name: cleanText(name, 160) || '未命名科研图', createdAt: now, updatedAt: now, stage: route === 'reconstruct' ? 'reconstruct' : 'brief', brief: { ...DEFAULT_BRIEF, language: route === 'reconstruct' ? 'original' : 'zh' }, sources: [], generated: [], history: [] };
    await fs.mkdir(path.join(this.projectDir(project.id), 'assets'), { recursive: true }); await this.write(project); return project;
  }
  async load(id: string): Promise<Project> { return JSON.parse(await fs.readFile(path.join(this.projectDir(id), 'project.json'), 'utf8')); }
  async write(project: Project) {
    project.updatedAt = new Date().toISOString();
    const persisted = structuredClone(project); delete persisted.previewSvg; delete persisted.previewPng;
    for (const a of [...persisted.sources, ...persisted.generated, persisted.target, persisted.customReference]) if (a) delete a.previewUrl;
    await atomicJson(path.join(this.projectDir(project.id), 'project.json'), persisted); return project;
  }
  async mutate(id: string, fn: (project: Project) => void | Promise<void>): Promise<Project> {
    const previous = this.queues.get(id) || Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => { const p = await this.load(id); await fn(p); return this.write(p); });
    this.queues.set(id, task); try { return await task; } finally { if (this.queues.get(id) === task) this.queues.delete(id); }
  }
  async trashProject(id: string, trash: (directory: string) => Promise<void>): Promise<void> {
    const directory = this.projectDir(safeId(id));
    const previous = this.queues.get(id) || Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      const root = path.join(this.directory, 'projects');
      const [rootInfo, info] = await Promise.all([fs.lstat(root), fs.lstat(directory)]);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !info.isDirectory() || info.isSymbolicLink()) throw new Error('作品目录异常，无法移入回收站');
      const [realRoot, realDirectory] = await Promise.all([fs.realpath(root), fs.realpath(directory)]);
      const equalPath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
      if (!equalPath(path.dirname(realDirectory), realRoot) || !equalPath(path.basename(realDirectory), id)) throw new Error('作品目录超出允许范围');
      const project = await this.load(id);
      if (project.id !== id) throw new Error('作品标识与目录不一致');
      await trash(realDirectory);
    });
    this.queues.set(id, task);
    try { await task; } finally { if (this.queues.get(id) === task) this.queues.delete(id); }
  }
  async list(): Promise<ProjectSummary[]> {
    const entries = await fs.readdir(path.join(this.directory, 'projects'), { withFileTypes: true }); const result: ProjectSummary[] = [];
    for (const e of entries) if (e.isDirectory()) try { const p = await this.load(e.name); result.push({ id: p.id, name: p.name, updatedAt: p.updatedAt, stage: p.stage }); } catch { /* skip incomplete */ }
    return result.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  resolveAsset(projectId: string, asset: Asset): string {
    const base = path.join(this.projectDir(projectId), 'assets'); const resolved = path.resolve(base, path.basename(asset.path));
    if (!resolved.startsWith(base + path.sep)) throw new Error('无效素材路径'); return resolved;
  }
  async imageData(projectId: string, asset: Asset) { if (asset.kind !== 'image') throw new Error('该文件不是图片'); const buffer = await fs.readFile(this.resolveAsset(projectId, asset)); return `data:${asset.mime};base64,${buffer.toString('base64')}`; }
  async hydrate(project: Project): Promise<Project> {
    const result = structuredClone(project);
    for (const asset of [...result.sources, ...result.generated, result.target, result.customReference]) if (asset?.kind === 'image') {
      try { const img = nativeImage.createFromPath(this.resolveAsset(project.id, asset)); const size = img.getSize(); asset.previewUrl = img.resize({ width: Math.min(1200, size.width) }).toDataURL(); } catch { asset.warnings = [...(asset.warnings || []), '图片预览暂不可用']; }
    }
    if (result.scene) {
      try { result.previewSvg = await fs.readFile(path.join(this.projectDir(project.id), 'preview.svg'), 'utf8'); result.previewPng = `data:image/png;base64,${(await fs.readFile(path.join(this.projectDir(project.id), 'preview.png'))).toString('base64')}`; } catch { /* render on demand */ }
    }
    return result;
  }
  async references(): Promise<StyleReference[]> {
    const rows = JSON.parse(await fs.readFile(path.join(this.resources, 'references/catalog.json'), 'utf8')) as Array<{id:string;name:string;description:string;file:string}>;
    return Promise.all(rows.map(async r => ({ id: r.id, name:r.name, description:r.description, path: path.join(this.resources, 'references', path.basename(r.file)), previewUrl: `data:image/png;base64,${(await fs.readFile(path.join(this.resources, 'references', path.basename(r.file)))).toString('base64')}` })));
  }
}
