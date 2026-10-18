import fs from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeStorage, nativeImage } from 'electron';
import type { AppSettings, Asset, Brief, Project, ProjectSummary, ProviderId, RunAction, StyleReference } from '../shared/types';

import { PANE_COUNT } from '../shared/types';
import { generationPrompt } from './generation-prompt';

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
export async function atomicJson(file: string, value: unknown) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(tmp, file); return; }
      catch (error) {
        // Windows can briefly hold the destination while a preview/index read finishes.
        if (process.platform !== 'win32' || !['EPERM','EACCES','EBUSY'].includes((error as NodeJS.ErrnoException).code || '') || attempt >= 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
      }
    }
  } finally { await fs.unlink(tmp).catch(() => undefined); }
}

function ordinaryPath(file: string, directory: boolean, allowMissing = false) {
  try {
    const info = lstatSync(file);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink > 1)) throw new Error('作品文件或目录异常：不支持链接文件和目录');
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export class Store {
  settings: AppSettings = structuredClone(DEFAULT_SETTINGS);
  private encryptedKeys: Partial<Record<ProviderId, string>> = {};
  private queues = new Map<string, Promise<unknown>>();
  private projectsDirectory: string;
  constructor(readonly directory: string, readonly resources: string) { this.projectsDirectory = path.join(directory, 'projects'); }
  setProjectsDirectory(directory: string) { this.projectsDirectory = directory; }
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
  projectDir(id: string) {
    const directory = path.join(this.projectsDirectory, safeId(id));
    // These paths also feed asset import, image generation and rendering callers.
    ordinaryPath(this.projectsDirectory, true);
    ordinaryPath(directory, true, true);
    ordinaryPath(path.join(directory, 'assets'), true, true);
    ordinaryPath(path.join(directory, 'generation'), true, true);
    for (const name of ['project.json', 'preview.svg', 'preview.png']) ordinaryPath(path.join(directory, name), false, true);
    return directory;
  }
  async create(name: string, route: 'full'|'reconstruct', draftSlot?: number) {
    const now = new Date().toISOString(); const project: Project = { ...(draftSlot === undefined ? {} : { draftSlot, styleMode: 'shared' as const }), id: randomUUID(), name: cleanText(name, 160) || '未命名科研图', createdAt: now, updatedAt: now, stage: route === 'reconstruct' ? 'reconstruct' : 'brief', brief: { ...DEFAULT_BRIEF, language: route === 'reconstruct' ? 'original' : 'zh' }, sources: [], generated: [], history: [] };
    await fs.mkdir(path.join(this.projectDir(project.id), 'assets'), { recursive: true }); await this.write(project); return project;
  }
  async createDraft(slot: number, route: 'full'|'reconstruct'): Promise<Project> {
    if (!Number.isInteger(slot) || slot < 1 || slot > PANE_COUNT) throw new Error('无效的草稿位置');
    const key = `draft-${slot}`;
    const previous = this.queues.get(key) || Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      const entries = await fs.readdir(this.projectsDirectory, { withFileTypes: true });
      for (const entry of entries) if (entry.isDirectory()) {
        let project: Project;
        try { project = await this.load(entry.name); } catch { continue; }
        if (project.draftSlot === slot) return project;
      }
      return this.create('新创作', route, slot);
    });
    this.queues.set(key, task);
    try { return await task; } finally { if (this.queues.get(key) === task) this.queues.delete(key); }
  }
  async beginRun(id: string, action: RunAction, feedback = ''): Promise<Project> {
    return this.mutate(id, project => {
      validateRunInput(project, action, feedback);
      if (project.draftSlot === undefined) return;
      if (!project.name.trim() || ['未命名科研图', '新创作'].includes(project.name)) {
        const content = project.brief.topic.trim() || project.brief.focus.trim() || project.brief.prompt.trim();
        const asset = project.target?.name || project.sources[0]?.name;
        project.name = (content.replace(/\s+/g, ' ').slice(0, 40) || (asset && path.parse(asset).name) || '科研图').slice(0, 160);
      }
      delete project.draftSlot;
    });
  }
  async load(id: string): Promise<Project> {
    const project = JSON.parse(await fs.readFile(path.join(this.projectDir(id), 'project.json'), 'utf8')) as Project;
    if (project.id !== id) throw new Error('作品标识与目录不一致');
    return project;
  }
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
      const root = this.projectsDirectory;
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
    ordinaryPath(this.projectsDirectory, true);
    const entries = await fs.readdir(this.projectsDirectory, { withFileTypes: true }); const result: ProjectSummary[] = [];
    for (const e of entries) if (e.isDirectory()) try { const p = await this.load(e.name); if (p.draftSlot !== undefined) continue; result.push({ id: p.id, name: p.name, updatedAt: p.updatedAt, stage: p.stage }); } catch { /* skip incomplete */ }
    return result.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  resolveAsset(projectId: string, asset: Asset): string {
    const base = path.join(this.projectDir(projectId), 'assets'); const resolved = path.resolve(base, path.basename(asset.path));
    if (!resolved.startsWith(base + path.sep)) throw new Error('无效素材路径');
    ordinaryPath(resolved, false, true); return resolved;
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

/** Validate before a draft becomes a visible work; model failures keep the same work. */
export function validateRunInput(project: Project, action: RunAction, feedback = '') {
  if (!['analyze','prompt','generate','edit-image','refine-image','regenerate-image','reconstruct','review','refine'].includes(action)) throw new Error('不支持的操作');
  if (action === 'analyze' && !project.brief.topic.trim() && !project.sources.length) throw new Error('请提供绘图主题或至少一份资料');
  if (action === 'prompt' && !project.brief.topic.trim() && !project.brief.focus.trim() && !project.brief.notes.trim()) throw new Error('请先说明想画什么，其他资料均可选');
  if (action === 'generate') generationPrompt(project.brief, project.sources.map(source => source.text || source.name).join('\n'));
  if (['edit-image','refine-image','regenerate-image'].includes(action) && !feedback.trim()) throw new Error('请填写修改意见或新的绘图提示词');
  if (['edit-image','refine-image','reconstruct','refine'].includes(action) && !project.target) throw new Error('请先生成一张视觉稿，或上传需要复刻的图片');
  if (action === 'review' && !project.scene) throw new Error('请先完成可编辑复刻');
}
