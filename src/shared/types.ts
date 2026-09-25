export type Stage = 'brief' | 'visual' | 'reconstruct' | 'review' | 'export';
export type ProviderId = 'codex' | 'openai' | 'deepseek' | 'custom';
export type ModelInfo = { id: string; name: string; description?: string; supportsVision?: boolean; supportsImages?: boolean; reasoningEfforts?: string[]; isDefault?: boolean };
export interface ProviderConfig { id: ProviderId; enabled: boolean; baseUrl: string; model: string; vision: boolean; hasKey?: boolean; codexPath?: string; }
export interface AppSettings { activeProvider: ProviderId; providers: ProviderConfig[]; imageProvider: 'codex' | 'openai' | 'custom'; imageModel: string; reasoningEffort: string; }
export interface Brief { topic: string; focus: string; language: 'zh' | 'en' | 'bilingual' | 'original'; purpose: 'paper' | 'slides'; aspectRatio: 'auto' | '2:1' | '16:9' | '3:2' | '4:3' | '1:1'; widthMm: number; prompt: string; stylePrompt?: string; notes: string; fullVector: boolean; }
export interface Asset { id: string; name: string; kind: 'image' | 'pdf' | 'pptx' | 'text'; mime: string; path: string; previewUrl?: string; width?: number; height?: number; text?: string; warnings?: string[]; }
export interface StyleReference { id: string; name: string; description: string; previewUrl: string; path: string; }
export type LibraryCategory = 'reference' | 'icon';
export interface LibraryItem { id: string; name: string; category: LibraryCategory; source: 'builtin' | 'user'; mime: string; extension: string; width: number; height: number; thumbnailUrl: string; createdAt?: string; }
export interface LibraryImportResult { items: LibraryItem[]; importedIds: string[]; errors: string[]; }
export interface ElementBase { id: string; type: 'text' | 'rect' | 'ellipse' | 'line' | 'path' | 'image'; groupId?: string; role?: 'label' | 'formula' | 'decoration'; x: number; y: number; w: number; h: number; rotation?: number; }
export interface TextElement extends ElementBase { type: 'text'; text: string; fontFamily?: string; fontSize: number; color: string; bold?: boolean; italic?: boolean; align?: 'left' | 'center' | 'right'; }
export interface ShapeElement extends ElementBase { type: 'rect' | 'ellipse'; fill: string; stroke?: string; strokeWidth?: number; radius?: number; opacity?: number; }
export interface LineElement extends ElementBase { type: 'line'; x2: number; y2: number; stroke: string; strokeWidth: number; dash?: boolean; arrowStart?: boolean; arrowEnd?: boolean; opacity?: number; }
export interface PathElement extends ElementBase { type: 'path'; d: string; fill?: string; stroke?: string; strokeWidth?: number; opacity?: number; dash?: boolean; }
export interface ImageElement extends ElementBase { type: 'image'; assetId: string; }
export type FigureElement = TextElement | ShapeElement | LineElement | PathElement | ImageElement;
export interface FigureScene { version: 1; width: number; height: number; background: string; title: string; elements: FigureElement[]; sourceNotes?: string[]; warnings?: string[]; }
export interface QaIssue { severity: 'error' | 'warning' | 'info'; code: string; message: string; elementId?: string; }
export interface QaReport { structuralPassed: boolean; visualReview: 'pending' | 'reviewed' | 'failed'; issues: QaIssue[]; textCount: number; shapeCount: number; rasterCount: number; checkedAt: string; visualNotes?: string; }
export interface HistoryEntry { at: string; action: string; message: string; }
export interface TokenUsage { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; reasoningOutputTokens?: number; totalTokens?: number; }
export interface RunMetrics { id: string; action: RunAction; startedAt: string; finishedAt?: string; durationMs: number; status: 'running' | 'completed' | 'failed' | 'cancelled'; model?: string; reasoningEffort?: string; usage?: TokenUsage; usageComplete?: boolean; }
export interface Project { id: string; name: string; createdAt: string; updatedAt: string; stage: Stage; brief: Brief; sources: Asset[]; styleId?: string; customReference?: Asset; libraryReferenceId?: string; target?: Asset; generated: Asset[]; scene?: FigureScene; previewSvg?: string; previewPng?: string; qa?: QaReport; history: HistoryEntry[]; runs?: RunMetrics[]; }
export interface ProjectSummary { id: string; name: string; updatedAt: string; stage: Stage; }
export interface ProviderStatus { available: boolean; authenticated: boolean; label: string; detail?: string; loginUrl?: string; }
export interface ProgressEvent { projectId: string; action: string; message: string; fraction?: number; metrics?: RunMetrics; }
export interface Bootstrap { settings: AppSettings; projects: ProjectSummary[]; references: StyleReference[]; version: string; platform: string; }
export type RunAction = 'analyze' | 'prompt' | 'generate' | 'edit-image' | 'regenerate-image' | 'refine-image' | 'reconstruct' | 'review' | 'refine';
export interface DesktopApi {
  bootstrap(): Promise<Bootstrap>;
  createProject(name: string, route: 'full' | 'reconstruct'): Promise<Project>;
  deleteProject(projectId: string): Promise<{ deleted: boolean; projects: ProjectSummary[] }>;
  listLibrary(): Promise<LibraryItem[]>;
  importLibraryFiles(category: LibraryCategory): Promise<LibraryImportResult>;
  updateLibraryItem(id: string, patch: { name?: string; category?: LibraryCategory }): Promise<LibraryItem>;
  deleteLibraryItem(id: string): Promise<{ deleted: boolean; items: LibraryItem[] }>;
  getLibraryPreview(id: string): Promise<string>;
  exportLibraryItem(id: string): Promise<{ path?: string }>;
  selectLibraryReference(projectId: string, libraryId: string): Promise<Project>;
  openProject(id: string): Promise<Project>;
  saveProject(project: Project): Promise<Project>;
  importFiles(projectId: string, kind: 'sources' | 'reference' | 'target'): Promise<Project>;
  saveSettings(settings: AppSettings, keys?: Partial<Record<ProviderId, string>>): Promise<AppSettings>;
  providerStatus(id: ProviderId): Promise<ProviderStatus>;
  loginCodex(): Promise<ProviderStatus>;
  listModels(id: ProviderId): Promise<ModelInfo[]>;
  run(projectId: string, action: RunAction, feedback?: string): Promise<Project>;
  cancelRun(projectId: string): Promise<void>;
  renderScene(projectId: string, scene: FigureScene): Promise<Project>;
  exportProject(projectId: string, formats: Array<'pptx' | 'svg' | 'png'>): Promise<{ directory: string; files: string[] }>;
  revealFile(path: string): Promise<void>;
  onProgress(callback: (event: ProgressEvent) => void): () => void;
}
declare global { interface Window { mkFigure: DesktopApi; } }
