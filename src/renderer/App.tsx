import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRight, Check, CheckCircle2, ChevronDown, ChevronRight, Circle, ClipboardCheck, FileImage, FileText, FolderOpen, ImagePlus, Images, Layers3, LoaderCircle, Maximize2, Plus, RefreshCw, Settings2, Sparkles, WandSparkles, X, AlertCircle, Cable, ExternalLink, PencilLine, ShieldCheck, Square, Trash2, Type, Upload, Workflow } from 'lucide-react';
import type { Asset, Bootstrap, Brief, FigureScene, ProgressEvent, Project, RunAction, RunMetrics, Stage } from '../shared/types';
import BrandMark from './BrandMark';
import { Button, Field } from './components/Controls';
import ReferencePicker from './components/ReferencePicker';
import LibraryPage from './components/LibraryPage';
import ImageRevision, { type ImageRevisionMode } from './components/ImageRevision';
import SettingsDialog from './components/SettingsDialog';
import TextEditor from './components/TextEditor';
import RunSummary, { LiveRunSummary } from './components/RunSummary';
import { errorText, reasoningLabel } from './display';

const STAGES: Array<{ id: Stage; label: string; detail: string; icon: typeof FileText }> = [
  { id: 'brief', label: '描述想法', detail: '内容与参考资料', icon: FileText },
  { id: 'visual', label: '生成视觉稿', detail: '构图与风格探索', icon: Sparkles },
  { id: 'reconstruct', label: '可编辑复刻', detail: '图形、文字与公式', icon: Layers3 },
  { id: 'review', label: '检查与精修', detail: '内容、排版与可编辑性', icon: ClipboardCheck },
  { id: 'export', label: '导出作品', detail: 'PowerPoint / SVG / PNG', icon: ArrowDownToLine },
];
const ACTIONS: Record<RunAction, string> = { analyze: '整理资料', prompt: '完善提示词', generate: '生成视觉稿', 'edit-image': '修改当前图片', 'regenerate-image': '按提示词重画', 'refine-image': '按改进意见改图', reconstruct: '重建可编辑图形', review: '检查图形', refine: '根据意见精修' };
type Busy = { action: string; message: string; fraction?: number; metrics?: RunMetrics } | null;
type Format = 'pptx' | 'svg' | 'png';
type LibraryView = { mode: 'browse' } | { mode: 'select'; projectId: string; referenceKey: string };

function svgUrl(svg: string) { return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`; }
function referenceKey(project: Project) { return JSON.stringify([project.libraryReferenceId, project.styleId, project.customReference?.id]); }
function assetSize(asset: Asset) { return asset.width && asset.height ? `${asset.width} × ${asset.height}` : asset.kind.toUpperCase(); }
function EmptyPreview() {
  return <div className="empty-preview"><div className="diagram-ghost" aria-hidden="true"><div className="ghost-input"><i /><i /><i /></div><span>→</span><div className="ghost-core"><Layers3 size={35} strokeWidth={1.1} /></div><span>→</span><div className="ghost-output"><svg width="60" height="48" viewBox="0 0 60 48"><path d="M4 36C14 35 12 10 25 17S40 34 56 8" fill="none" stroke="currentColor" strokeWidth="2"/><path d="M4 4V42H58" fill="none" stroke="currentColor" strokeWidth="1" opacity=".35"/></svg></div></div><h3>暂无图形</h3><p>生成或上传图片后预览。</p></div>;
}

export default function App() {
  const [boot, setBoot] = useState<Bootstrap>();
  const [project, setProject] = useState<Project>();
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saved, setSaved] = useState<'saved' | 'saving' | 'error'>('saved');
  const [previewMode, setPreviewMode] = useState<'visual' | 'editable'>('visual');
  const [previewLarge, setPreviewLarge] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [imageInstruction, setImageInstruction] = useState('');
  const [imageRevisionMode, setImageRevisionMode] = useState<ImageRevisionMode>('direct');
  const [useOriginalImage, setUseOriginalImage] = useState(true);
  const [formats, setFormats] = useState<Format[]>(['pptx', 'svg', 'png']);
  const [exported, setExported] = useState<{ directory: string; files: string[] }>();
  const [sceneDraft, setSceneDraft] = useState<FigureScene>();
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [library, setLibrary] = useState<LibraryView>();
  const [libraryBusy, setLibraryBusy] = useState(false);
  const libraryLock = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const projectRef = useRef<Project | undefined>(undefined);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const revision = useRef(0);
  const operationLock = useRef(false);
  const app = window.mkFigure;

  const updateSummary = useCallback((next: Project) => {
    setBoot(prev => prev ? { ...prev, projects: [{ id: next.id, name: next.name, updatedAt: next.updatedAt, stage: next.stage }, ...prev.projects.filter(p => p.id !== next.id)] } : prev);
  }, []);
  const receiveProject = useCallback((next: Project) => {
    projectRef.current = next;
    revision.current++;
    setProject(next);
    updateSummary(next);
    setSaved('saved');
  }, [updateSummary]);
  const persist = useCallback((next: Project, rev: number) => {
    const task = saveChain.current.catch(() => {}).then(async () => {
      const result = await app.saveProject(next);
      updateSummary(result);
      if (rev === revision.current) { projectRef.current = result; setProject(result); setSaved('saved'); }
    });
    saveChain.current = task;
    task.catch(err => { setError(`保存失败：${errorText(err)}`); setSaved('error'); });
    return task;
  }, [app, updateSummary]);
  const changeProject = useCallback((patch: Partial<Project>) => {
    if (!projectRef.current) return;
    const next = { ...projectRef.current, ...patch };
    projectRef.current = next; setProject(next); setSaved('saving'); setExported(undefined);
    const rev = ++revision.current;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void persist(next, rev); }, 650);
  }, [persist]);
  const changeBrief = (patch: Partial<Brief>) => { if (projectRef.current) changeProject({ brief: { ...projectRef.current.brief, ...patch } }); };
  const flushSave = async () => {
    clearTimeout(saveTimer.current);
    if (projectRef.current) await persist(projectRef.current, revision.current);
    else await saveChain.current;
  };
  const libraryBusyChanged = useCallback((value: boolean) => { libraryLock.current = value; setLibraryBusy(value); }, []);
  const rename = async () => {
    if (!renaming) return;
    const name = nameDraft.trim();
    if (!name) { setError('作品名称不能为空。'); return; }
    changeProject({ name });
    try { await flushSave(); setRenaming(false); } catch { /* persist displays the save error. */ }
  };
  useEffect(() => { if (renaming) { nameInput.current?.focus(); nameInput.current?.select(); } }, [renaming]);
  useEffect(() => { setRenaming(false); }, [project?.id]);
  useEffect(() => { setImageInstruction(''); setImageRevisionMode('direct'); setUseOriginalImage(true); }, [project?.id]);

  useEffect(() => {
    if (!app) { setError('桌面连接未启动。请从已安装的 MK Figure Studio 打开此工作区。'); return; }
    let cancelled = false;
    app.bootstrap().then(result => { if (!cancelled) setBoot(result); }).catch(err => { if (!cancelled) setError(errorText(err)); });
    const unsubscribe = app.onProgress((event: ProgressEvent) => {
      if (event.projectId !== projectRef.current?.id) return;
      const prefix = event.metrics?.model ? `${event.metrics.model} · ` : '';
      const message = prefix && event.message.startsWith(prefix) ? event.message.slice(prefix.length).replace(/ · \d+分\d+秒$/, '') : event.message;
      setBusy(previous => ({ action: event.action, message, fraction: event.fraction, metrics: event.metrics || previous?.metrics }));
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [app]);

  const perform = async (label: string, callback: () => Promise<void>) => {
    if (operationLock.current || libraryLock.current) return;
    operationLock.current = true;
    setBusy({ action: label, message: label }); setError(''); setNotice('');
    try { await callback(); } catch (err) { setError(errorText(err)); } finally { operationLock.current = false; setBusy(null); }
  };
  const openLibrary = (mode: 'browse' | 'select') => void perform('打开素材库', async () => {
    await flushSave();
    const current = projectRef.current;
    if (mode === 'select' && !current) return;
    setError(''); setNotice('');
    setLibrary(mode === 'select' && current ? { mode, projectId: current.id, referenceKey: referenceKey(current) } : { mode: 'browse' });
  });
  const selectReference = async (libraryId: string) => {
    if (library?.mode !== 'select') return;
    const matches = () => projectRef.current?.id === library.projectId && referenceKey(projectRef.current) === library.referenceKey;
    if (!matches()) throw new Error('作品已发生变化，请返回后重新选择参考图。');
    await flushSave();
    if (!matches()) throw new Error('作品已发生变化，请返回后重新选择参考图。');
    const next = await app.selectLibraryReference(library.projectId, libraryId);
    if (!matches()) throw new Error('作品已切换，请重新打开原作品查看参考图。');
    receiveProject(next); setExported(undefined); setLibrary(undefined);
  };
  const goHome = () => void perform('返回首页', async () => {
    await flushSave(); projectRef.current = undefined; setProject(undefined); setLibrary(undefined);
  });
  const create = (route: 'full' | 'reconstruct') => void perform('创建项目', async () => {
    await flushSave();
    let next = await app.createProject(route === 'reconstruct' ? '图片复刻' : '未命名科研图', route);
    receiveProject(next); setExported(undefined); setFeedback(''); setPreviewMode('visual');
    if (route === 'reconstruct') { next = await app.importFiles(next.id, 'target'); receiveProject(next); }
  });
  const open = (id: string) => void perform('打开项目', async () => { await flushSave(); receiveProject(await app.openProject(id)); setExported(undefined); setFeedback(''); setPreviewMode('editable'); });
  const remove = (id: string) => void perform('删除作品', async () => {
    await flushSave();
    const result = await app.deleteProject(id);
    if (!result.deleted) return;
    setBoot(previous => previous ? { ...previous, projects: result.projects } : previous);
    if (projectRef.current?.id === id) {
      projectRef.current = undefined; revision.current++;
      setProject(undefined); setExported(undefined); setSceneDraft(undefined);
      setPreviewLarge(false); setFeedback(''); setSaved('saved');
    }
    setNotice('已移入回收站');
  });
  const importAssets = (kind: 'sources' | 'reference' | 'target') => void perform('选择文件', async () => {
    await flushSave(); if (!projectRef.current) return;
    const next = await app.importFiles(projectRef.current.id, kind); receiveProject(next);
    if (kind === 'target') setPreviewMode('visual');
  });
  const chooseVisualVersion = (asset: Asset) => {
    if (projectRef.current?.target?.id === asset.id) return;
    changeProject({ target: asset, scene: undefined, qa: undefined, previewSvg: undefined, previewPng: undefined });
    setSceneDraft(undefined); setPreviewMode('visual');
  };
  const run = (action: RunAction, instruction?: string) => void perform(ACTIONS[action], async () => {
    await flushSave(); if (!projectRef.current) return;
    const id = projectRef.current.id;
    let next: Project;
    try { next = await app.run(id, action, instruction ?? (action === 'refine' ? feedback.trim() : undefined)); }
    catch (err) {
      try { receiveProject(await app.openProject(id)); } catch { /* Keep the original run error. */ }
      throw err;
    }
    receiveProject(next); setExported(undefined);
    if (['generate', 'edit-image', 'regenerate-image', 'refine-image'].includes(action)) setPreviewMode('visual');
    if (['edit-image', 'regenerate-image', 'refine-image'].includes(action)) setImageInstruction('');
    if (action === 'reconstruct' || action === 'refine') setPreviewMode('editable');
    if (action === 'analyze') setNotice('资料已整理，请核对内容与提示词。');
    if (action === 'prompt') setNotice('提示词已更新。');
    if (action === 'refine') setFeedback('');
  });
  const cancel = async () => {
    if (!project) return;
    try { await app.cancelRun(project.id); setNotice('正在停止…'); } catch (err) { setError(errorText(err)); }
  };
  const doExport = () => void perform('导出作品', async () => {
    await flushSave(); if (!projectRef.current) return;
    const result = await app.exportProject(projectRef.current.id, formats);
    if (!result.files.length) return;
    setExported(result); setNotice(`已导出 ${result.files.length} 个文件。`);
  });
  const safeReveal = async (path: string) => { try { await app.revealFile(path); } catch (err) { setError(errorText(err)); } };
  const saveTextEdits = () => void perform('更新图中文字', async () => {
    await flushSave(); if (!projectRef.current || !sceneDraft) return;
    receiveProject(await app.renderScene(projectRef.current.id, sceneDraft)); setSceneDraft(undefined); setPreviewMode('editable'); setExported(undefined);
  });
  const currentProvider = boot?.settings.providers.find(p => p.id === 'codex');
  const modelLabel = `${currentProvider?.model || '账户默认模型'} · 推理${reasoningLabel(boot?.settings.reasoningEffort)}`;
  const canGenerate = !!(project?.brief.topic.trim() || project?.brief.focus.trim() || project?.brief.prompt.trim() || project?.sources.length);
  const target = project?.target || project?.generated.at(-1);
  const activeReference = project?.customReference || boot?.references.find(r => r.id === project?.styleId);
  const editableUrl = project?.previewSvg ? svgUrl(project.previewSvg) : project?.previewPng;
  const rawUrl = target?.previewUrl;
  const previewUrl = previewMode === 'editable' ? editableUrl || rawUrl : rawUrl || editableUrl;
  const showingEditable = Boolean(editableUrl && (previewMode === 'editable' || !rawUrl));
  const stage = project?.stage || 'brief';
  const stageIndex = STAGES.findIndex(item => item.id === stage);
  const stageInfo = STAGES[stageIndex] ?? STAGES[0];
  const isSample = project?.history.some(h => /example|示例/i.test(h.action + ' ' + h.message)) || /离线示例/.test(project?.name || '');
  const changeStage = (next: Stage) => { if (!busy) { changeProject({ stage: next }); setNotice(''); if (next === 'review' || next === 'export') setPreviewMode('editable'); } };

  const referencePicker = project && <ReferencePicker name={activeReference?.name} onOpen={() => openLibrary('select')} onClear={() => changeProject({ styleId: undefined, customReference: undefined, libraryReferenceId: undefined })}/>;

  return <div className="app-shell">
    <header className="topbar"><button className="brand" onClick={goHome} disabled={!!busy || libraryBusy} aria-label="返回首页"><BrandMark className="brand-mark"/><span>MK <strong>Figure</strong></span></button><div className="topbar-right"><span className="local-badge"><span/>本地工作区</span><button className="connection-button" title="修改模型与推理强度" onClick={() => setSettingsOpen(true)} disabled={!!busy || libraryBusy}><Cable size={15}/><span>{`Codex · ${modelLabel}`}</span><Settings2 size={15}/></button></div></header>
    {error && <div role="alert" className="global-message error-message"><AlertCircle size={17}/><span>{error}</span><button aria-label="关闭错误提示" onClick={() => setError('')}><X size={16}/></button></div>}
    {notice && <div role="status" className="global-message notice-message"><CheckCircle2 size={17}/><span>{notice}</span><button aria-label="关闭提示" onClick={() => setNotice('')}><X size={16}/></button></div>}
    {!boot ? <div className="loading-screen">{error ? <div className="loading-error"><h2>工作区暂时无法连接</h2><p>请检查桌面应用是否完整启动。</p></div> : <p role="status">正在载入…</p>}</div> : library ? <LibraryPage selecting={library.mode === 'select'} selectedId={project?.libraryReferenceId || (!project?.customReference ? project?.styleId : undefined)} onBusyChange={libraryBusyChanged} onSelect={selectReference} onBack={() => { if (!libraryLock.current) setLibrary(undefined); }}/> : !project ? <main className="welcome">
      <div className="welcome-heading"><h1>绘制科研图</h1><p>从想法或图片开始，导出可编辑 PPT 与 SVG。</p>
        <svg className="welcome-ornament" width="310" height="120" viewBox="0 0 310 120" aria-hidden="true" focusable="false">
          <g fill="none" stroke="currentColor" strokeLinecap="round"><path d="M12 98C79 48 112 123 182 79S253 47 300 22" opacity=".3"/><path d="M40 108C103 75 133 130 198 93S267 67 299 51" opacity=".18"/><path d="M176 78V32L221 21V66" strokeWidth="1.8" opacity=".68"/></g>
          <path d="M176 32L221 21V31L176 42Z" fill="currentColor" opacity=".38"/>
          <g fill="currentColor"><ellipse cx="170" cy="79" rx="8" ry="5" transform="rotate(-20 170 79)" opacity=".68"/><ellipse cx="215" cy="67" rx="8" ry="5" transform="rotate(-20 215 67)" opacity=".68"/><circle cx="63" cy="64" r="2" opacity=".35"/><circle cx="256" cy="32" r="2.5" opacity=".28"/><circle cx="281" cy="91" r="1.5" opacity=".35"/></g>
        </svg>
      </div>
      <div className="start-routes"><button className="route-card featured" onClick={() => create('full')} disabled={!!busy}><svg className="card-ornament note-ornament" width="136" height="130" viewBox="0 0 136 130" aria-hidden="true" focusable="false"><circle cx="94" cy="42" r="40" fill="currentColor" opacity=".06"/><g fill="none" stroke="currentColor" strokeLinecap="round"><path d="M33 110C75 103 115 78 129 39" opacity=".18"/><path d="M78 70V31C90 37 98 36 99 47" strokeWidth="1.7" opacity=".46"/></g><ellipse cx="72" cy="72" rx="8" ry="5" transform="rotate(-20 72 72)" fill="currentColor" opacity=".46"/><circle cx="45" cy="41" r="2" fill="currentColor" opacity=".22"/></svg><span className="route-icon"><WandSparkles size={22} strokeWidth={1.7}/></span><strong>新建科研图</strong><p>从主题或论文生成科研图。</p><span className="route-link" aria-hidden="true"><ArrowRight size={16}/></span></button><button className="route-card" onClick={() => create('reconstruct')} disabled={!!busy}><svg className="card-ornament arc-ornament" width="145" height="130" viewBox="0 0 145 130" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" strokeLinecap="round"><path d="M19 106C31 57 65 88 85 47S128 12 140 23" opacity=".3"/><path d="M36 117C54 81 91 101 109 65S142 41 151 45" opacity=".16"/><circle cx="85" cy="47" r="5" opacity=".4"/></g><circle cx="24" cy="73" r="2" fill="currentColor" opacity=".28"/><circle cx="118" cy="27" r="3" fill="currentColor" opacity=".25"/></svg><span className="route-icon warm"><ImagePlus size={22} strokeWidth={1.7}/></span><strong>图片复刻</strong><p>将已有图片转为可编辑图形。</p><span className="route-link" aria-hidden="true"><ArrowRight size={16}/></span></button><button className="route-card" onClick={() => openLibrary('browse')} disabled={!!busy}><svg className="card-ornament library-ornament" width="140" height="130" viewBox="0 0 140 130" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" strokeLinecap="round"><rect x="55" y="20" width="65" height="78" rx="8" transform="rotate(12 88 59)" opacity=".22"/><rect x="43" y="29" width="65" height="78" rx="8" transform="rotate(-5 75 68)" opacity=".36"/><path d="M57 88L73 72L85 82L95 71" opacity=".4"/><circle cx="63" cy="54" r="5" opacity=".35"/></g></svg><span className="route-icon olive"><Images size={22} strokeWidth={1.7}/></span><strong>图片素材库</strong><p>收藏参考图与小图标。</p><span className="route-link" aria-hidden="true"><ArrowRight size={16}/></span></button></div>
      <section className="recent-projects"><div className="section-heading"><h2>最近的作品</h2><span>{boot.projects.length} 个项目</span></div>{boot.projects.length ? <div className="recent-list">{boot.projects.map(p => <div className="recent-item" data-project-id={p.id} key={p.id}><button className="recent-open" aria-label={`打开 ${p.name}`} title={p.name} onClick={() => open(p.id)} disabled={!!busy}><span className="recent-icon"><FileImage size={19}/></span><span><strong>{p.name}</strong><small>{STAGES.find(s => s.id === p.stage)?.label} · {new Date(p.updatedAt).toLocaleDateString('zh-CN')}</small></span><ChevronRight size={17}/></button><button className="recent-delete" aria-label={`删除 ${p.name}`} title="移入回收站" onClick={() => remove(p.id)} disabled={!!busy}><Trash2 size={15}/><span>删除</span></button></div>)}</div> : <p className="empty-recent">暂无项目</p>}</section>
      <footer className="welcome-footer"><span><ShieldCheck size={15}/>本地保存 · 运行时发送所需资料</span></footer>
    </main> : <div className="workspace">
      <aside className="sidebar"><div className="project-area"><span className="sidebar-eyebrow">当前项目</span><div className="project-picker"><select aria-label="切换项目" value={project.id} disabled={!!busy} onChange={e => open(e.target.value)}>{boot.projects.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select><ChevronDown size={14}/></div><button className="new-project" disabled={!!busy} onClick={() => create('full')}><Plus size={14}/>新建作品</button></div><nav aria-label="创作阶段" className="step-nav">{STAGES.map((s, index) => { const Icon = s.icon; const done = (s.id === 'brief' && !!project.brief.topic) || (s.id === 'visual' && !!project.generated.length) || (s.id === 'reconstruct' && !!project.scene) || (s.id === 'review' && !!project.qa) || (s.id === 'export' && !!exported); return <button key={s.id} className={`step-button ${stage === s.id ? 'active' : ''}`} disabled={!!busy} onClick={() => changeStage(s.id)}><span className="step-marker">{done && stage !== s.id ? <Check size={16}/> : <Icon size={19} strokeWidth={1.6}/>}</span><span><strong>{s.label}</strong><small>{s.detail}</small></span><span className="step-index">0{index + 1}</span></button>; })}</nav><div className="sidebar-bottom"><button className="sidebar-settings" disabled={!!busy} onClick={() => setSettingsOpen(true)}><Settings2 size={16}/>模型与连接<span><ChevronRight size={15}/></span></button><div className="version">MK Figure <span>v{boot.version}</span></div></div></aside>
      <main className="work-main"><div className="project-header"><div><input ref={nameInput} className={`project-name${renaming ? ' editing' : ''}`} aria-label="项目名称" readOnly={!renaming} value={renaming ? nameDraft : project.name} onChange={e => setNameDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void rename(); if (e.key === 'Escape') setRenaming(false); }} disabled={!!busy}/>{renaming ? <><button className="name-action" onClick={() => void rename()} disabled={!!busy}><Check size={14}/>保存</button><button className="icon-button" aria-label="取消重命名" onClick={() => setRenaming(false)}><X size={14}/></button></> : <button className="name-action" disabled={!!busy} onClick={() => { setNameDraft(project.name); setRenaming(true); }}><PencilLine size={14}/>重命名</button>}<span className={`save-status ${saved === 'error' ? 'bad' : ''}`}>{saved === 'saving' ? <><LoaderCircle size={12} className="spin"/>正在保存</> : saved === 'error' ? <><AlertCircle size={12}/>未保存</> : <><Check size={12}/>已自动保存</>}</span></div>{isSample && <span className="sample-badge">历史示例 · 非 AI 生成</span>}<span className="stage-counter">STEP 0{stageIndex + 1} <span>/ 05</span></span></div>
        {busy && <div className="progress-banner" role="status"><LoaderCircle className="spin" size={19}/><div><strong>{ACTIONS[busy.action as RunAction] || busy.action}</strong><span>{busy.message}</span>{busy.metrics && <LiveRunSummary run={busy.metrics}/>}</div><button onClick={() => void cancel()} disabled={!project}><Square size={12} fill="currentColor"/>停止</button><div className={`progress-track ${busy.fraction == null ? 'indeterminate' : ''}`}><i style={busy.fraction != null ? { width: `${Math.max(0, Math.min(100, busy.fraction * 100))}%` } : undefined}/></div></div>}
        <div className="work-columns"><section className="form-panel"><fieldset disabled={!!busy} className="stage-fields">
          <div className="stage-heading"><h1>{stageInfo.label}</h1></div>
          {stage === 'brief' && <>
            <div className="starter-prompts"><span>快速起步</span><button onClick={() => { changeBrief({ topic: '神经 ODE 训练流程图', focus: '展示输入、模型、积分求解、损失计算和参数更新之间的关系。' }); }}>神经 ODE 示例</button><button onClick={() => importAssets('sources')}>从论文开始</button><button onClick={() => { changeStage('reconstruct'); importAssets('target'); }}>已有图片</button></div>
            <Field label="主题与重点"><textarea rows={4} placeholder="粘贴一段内容，或描述想画的图。例如：展示神经 ODE 的输入、积分求解、损失计算与参数更新。" value={project.brief.topic} onChange={e => changeBrief({ topic: e.target.value })}/></Field>
            <details className="brief-details"><summary>补充重点与资料 <span>选填</span></summary><Field label="核心内容"><textarea rows={3} placeholder="关键模块、关系与结论" value={project.brief.focus} onChange={e => changeBrief({ focus: e.target.value })}/></Field>
            <div className="field"><div className="field-title">论文与方法资料<span>选填</span></div><button className="upload-zone compact" onClick={() => importAssets('sources')}><Upload size={20}/><span><strong>选择参考资料</strong><small>PDF、PPTX、文本或图片</small></span><Plus size={17}/></button>{project.sources.length > 0 && <div className="asset-list">{project.sources.map(a => <div key={a.id} className="asset-row"><FileText size={16}/><span><strong>{a.name}</strong><small>{a.warnings?.join(' · ') || assetSize(a)}</small></span><button aria-label={`移除 ${a.name}`} onClick={() => changeProject({ sources: project.sources.filter(s => s.id !== a.id) })}><X size={14}/></button></div>)}</div>}</div>
            </details><div className="field-row"><Field label="图中文字" hint="选填"><select value={project.brief.language} onChange={e => changeBrief({ language: e.target.value as Brief['language'] })}><option value="zh">中文</option><option value="en">English</option><option value="bilingual">中英双语</option><option value="original">沿用原图语言</option></select></Field><Field label="使用场景" hint="选填"><select value={project.brief.purpose} onChange={e => changeBrief({ purpose: e.target.value as Brief['purpose'] })}><option value="paper">论文插图</option><option value="slides">汇报 PPT</option></select></Field></div>
            {referencePicker}
            <Field label="风格要求" hint="选填 · 可手写"><textarea rows={2} placeholder="例如：简洁学术风格，蓝绿色配色，横向布局" value={project.brief.stylePrompt || ''} onChange={e => changeBrief({ stylePrompt: e.target.value })}/></Field>
            <div className="stage-actions"><Button icon={PencilLine} onClick={() => changeStage('visual')}>编辑绘图提示词</Button><Button variant="primary" icon={Sparkles} onClick={() => run('generate')} disabled={!canGenerate}>生成视觉稿</Button></div>
            <button className="text-button optional-ai" onClick={() => run(project.sources.length ? 'analyze' : 'prompt')} disabled={!canGenerate}><WandSparkles size={14}/>AI 整理内容（可选）</button>
          </>}
          {stage === 'visual' && <>
            <div className="summary-strip"><FileText size={16}/><span>{project.brief.topic || '从提示词开始绘制'}<small>{project.brief.language === 'en' ? '英文' : project.brief.language === 'bilingual' ? '中英双语' : project.brief.language === 'original' ? '原图语言' : '中文'} · {project.brief.purpose === 'paper' ? '论文插图' : '汇报 PPT'} · {project.sources.length} 份内容资料</small></span><button title="修改内容" onClick={() => changeStage('brief')}><PencilLine size={15}/></button></div>
            {target && <><ImageRevision mode={imageRevisionMode} useOriginal={useOriginalImage} instruction={imageInstruction} onMode={setImageRevisionMode} onOriginal={setUseOriginalImage} onInstruction={setImageInstruction} onRun={run}/><Button variant="wide subtle" icon={ArrowRight} onClick={() => changeStage('reconstruct')}>使用当前图片复刻</Button></>}
            <details className="visual-generation-settings" key={target ? 'with-image' : 'empty'} open={!target}><summary>{target ? '重新设置内容与风格' : '生成设置'}</summary>
            {referencePicker}
            <Field label="风格要求" hint="选填 · 可手写"><textarea rows={2} placeholder="补充配色、构图或字体偏好" value={project.brief.stylePrompt || ''} onChange={e => changeBrief({ stylePrompt: e.target.value })}/></Field>
            <Field label="绘图提示词" hint="选填 · 可手写"><textarea className="prompt-area" rows={9} placeholder="留空也能生成：使用前面的内容、所选风格与风格要求。也可直接填写完整绘图提示词。" value={project.brief.prompt} onChange={e => changeBrief({ prompt: e.target.value })}/></Field><div className="under-field"><button className="text-button" onClick={() => run('prompt')} disabled={!canGenerate}><WandSparkles size={14}/>AI 优化提示词（可选）</button><span>{project.brief.prompt.length} 字</span></div>
            <div className="field-row"><Field label="画面比例"><select value={project.brief.aspectRatio} onChange={e => changeBrief({ aspectRatio: e.target.value as Brief['aspectRatio'] })}><option value="auto">根据内容自动安排</option><option value="2:1">2:1 · 论文横版</option><option value="16:9">16:9 · 汇报横版</option><option value="3:2">3:2</option><option value="4:3">4:3</option><option value="1:1">1:1 · 方形</option></select></Field><Field label="导出宽度" hint="mm"><input type="number" min={30} max={600} step={1} value={project.brief.widthMm} onChange={e => changeBrief({ widthMm: Number(e.target.value) || 180 })}/></Field></div>
            <div className="model-strip"><Sparkles size={17}/><span>生图模型<strong>{modelLabel}</strong></span><button onClick={() => setSettingsOpen(true)}>更改</button></div>
            <div className="stage-actions"><Button icon={Upload} onClick={() => importAssets('target')}>使用已有图片</Button><Button variant="primary" icon={Sparkles} onClick={() => run('generate')} disabled={!canGenerate}>生成视觉稿</Button></div>
            </details>
            {project.generated.length > 0 && <div className="generated-history"><div className="field-title">已生成的视觉稿<span>{project.generated.length} 张</span></div><div>{project.generated.map((a, i) => <button key={a.id} className={target?.id === a.id ? 'selected' : ''} onClick={() => chooseVisualVersion(a)}><img src={a.previewUrl} alt={`视觉稿 ${i + 1}`}/><span>版本 {i + 1}</span></button>)}</div></div>}
          </>}
          {stage === 'reconstruct' && <>
            <button className={`upload-zone target-upload ${target ? 'has-target' : ''}`} onClick={() => importAssets('target')}>{target?.previewUrl ? <img src={target.previewUrl} alt="待复刻图片"/> : <ImagePlus size={30}/>}<span><strong>{target ? target.name : '上传要复刻的图片'}</strong><small>{target ? `${assetSize(target)} · 点击更换` : 'PNG、JPG、WebP 等图片格式'}</small></span>{target && <RefreshCw size={17}/>}</button>

            <Field label="复刻要求" hint="选填"><textarea rows={5} placeholder="例如：保留布局与配色，完整还原公式" value={project.brief.notes} onChange={e => changeBrief({ notes: e.target.value })}/></Field>
            <label className="check-card"><input type="checkbox" checked={project.brief.fullVector} onChange={e => changeBrief({ fullVector: e.target.checked })}/><span><strong>全矢量复刻</strong><small>复杂插画可能需要额外精修。</small></span></label>
            <div className="model-strip"><Layers3 size={17}/><span>识图与重建模型<strong>{modelLabel}</strong></span><button onClick={() => setSettingsOpen(true)}>更改</button></div>
            <div className="stage-actions"><Button icon={ArrowLeft} onClick={() => changeStage('visual')}>返回视觉稿</Button><Button variant="primary" icon={Layers3} onClick={() => run('reconstruct')} disabled={!target}>{project.scene ? '重新复刻' : '开始复刻'}</Button></div>
            {project.scene && <Button variant="wide subtle" icon={ArrowRight} onClick={() => changeStage('review')}>继续检查</Button>}
          </>}
          {stage === 'review' && <>
            {!project.scene ? <div className="empty-stage"><Layers3 size={29}/><h3>尚无可编辑图形</h3><p>请先上传图片并完成复刻。</p><Button variant="primary" onClick={() => changeStage('reconstruct')}>进入复刻</Button></div> : <>
              <div className="stats-grid"><div><strong>{project.qa?.textCount ?? project.scene.elements.filter(e => e.type === 'text').length}</strong><span>文字组件</span></div><div><strong>{project.qa?.shapeCount ?? project.scene.elements.filter(e => e.type !== 'text' && e.type !== 'image').length}</strong><span>矢量图形</span></div><div><strong>{project.qa?.rasterCount ?? project.scene.elements.filter(e => e.type === 'image').length}</strong><span>位图对象</span></div></div>
              <div className="review-card"><div className="review-card-heading"><h3>检查结果</h3><button className="text-button" onClick={() => run('review')}><RefreshCw size={14}/>{project.qa ? '重新检查' : '开始检查'}</button></div><div className={`check-line ${project.qa?.structuralPassed ? 'passed' : ''}`}>{project.qa?.structuralPassed ? <CheckCircle2 size={17}/> : <Circle size={17}/>}<span>结构与可编辑性</span><small>{project.qa ? project.qa.structuralPassed ? '通过' : '需要处理' : '待检查'}</small></div><div className={`check-line ${project.qa?.visualReview === 'reviewed' ? 'passed' : ''}`}>{project.qa?.visualReview === 'reviewed' ? <CheckCircle2 size={17}/> : <Circle size={17}/>}<span>视觉与内容核对</span><small>{project.qa?.visualReview === 'reviewed' ? '已检查' : project.qa?.visualReview === 'failed' ? '需要处理' : '待检查'}</small></div>{project.qa?.issues.map((issue, i) => <div className={`qa-issue ${issue.severity}`} key={`${issue.code}-${i}`}><AlertCircle size={14}/><p>{issue.code === 'VISUAL_REVIEW_REQUIRED' ? '结构检查不含内容核对，请确认公式与布局。' : issue.message}</p></div>)}{project.qa?.visualNotes && <p className="visual-notes">{project.qa.visualNotes}</p>}{project.qa?.issues.length === 0 && <p className="no-issues">未发现结构问题。</p>}</div>
              <Field label="精修意见"><textarea rows={4} placeholder="例如：增大公式，对齐箭头，减少标签拥挤" value={feedback} onChange={e => setFeedback(e.target.value)}/></Field>
              <div className="stage-actions"><Button icon={Type} onClick={() => { setSceneDraft(structuredClone(project.scene!)); }}>编辑图中文字</Button><Button icon={WandSparkles} onClick={() => run('refine')} disabled={!feedback.trim()}>按意见精修</Button></div>
              <Button variant="primary wide" icon={ArrowRight} onClick={() => changeStage('export')}>继续导出</Button>
            </>}
          </>}
          {stage === 'export' && <>
            {!project.scene ? <div className="empty-stage"><FileImage size={29}/><h3>尚无可导出图形</h3><p>请先完成图片复刻。</p><Button variant="primary" onClick={() => changeStage('reconstruct')}>进入复刻</Button></div> : <>
              <div className="export-ready"><span><CheckCircle2 size={24}/></span><div><strong>作品已就绪</strong><p>{project.scene.elements.length} 个元素 · {project.brief.widthMm} mm 宽</p></div></div>
              <div className="format-list">{([{ id: 'pptx', ext: 'PPTX', name: '可编辑 PowerPoint', desc: '文字、图形与公式可编辑。', icon: Layers3 }, { id: 'svg', ext: 'SVG', name: '可编辑矢量图', desc: '用于排版与矢量编辑。', icon: Workflow }, { id: 'png', ext: 'PNG', name: '高清预览图', desc: '用于预览、文档与分享。', icon: FileImage }] as const).map(f => <label key={f.id} className={`format-card ${formats.includes(f.id) ? 'selected' : ''}`}><input type="checkbox" checked={formats.includes(f.id)} onChange={e => setFormats(e.target.checked ? [...formats, f.id] : formats.filter(v => v !== f.id))}/><span className={`format-icon ${f.id}`}><f.icon size={23}/><small>{f.ext}</small></span><span><strong>{f.name}</strong><small>{f.desc}</small></span><span className="selection-check">{formats.includes(f.id) && <Check size={13}/>}</span></label>)}</div>
              {(!project.qa || !project.qa.structuralPassed || project.qa.visualReview !== 'reviewed') && <div className="inline-warning"><AlertCircle size={17}/><p>检查未完成，可导出草稿或<button onClick={() => changeStage('review')}>返回检查</button>。</p></div>}
              <Button variant="primary wide export-button" icon={ArrowDownToLine} onClick={doExport} disabled={!formats.length}>选择文件夹并导出 {formats.length ? `${formats.length} 种格式` : ''}</Button>
              {exported && <div className="export-result"><div><CheckCircle2 size={18}/><strong>文件已导出</strong></div>{exported.files.map(file => <button key={file} onClick={() => void safeReveal(file)}><FileText size={14}/><span>{file.split(/[\\/]/).pop()}</span><ExternalLink size={13}/></button>)}<Button icon={FolderOpen} onClick={() => void safeReveal(exported.directory)}>打开导出文件夹</Button></div>}
              <div className="font-note"><Type size={16}/><p>跨电脑编辑需安装微软雅黑和 Times New Roman；应用不附带这两种字体。</p></div>
            </>}
          </>}
        </fieldset></section>
        <section className="preview-panel"><div className="preview-toolbar"><span><span className="live-dot"/>画布预览</span><div className="preview-toggle"><button disabled={!rawUrl} onClick={() => setPreviewMode('visual')} className={!showingEditable ? 'active' : ''}>视觉稿</button><button disabled={!editableUrl} onClick={() => setPreviewMode('editable')} className={showingEditable ? 'active' : ''}>可编辑图</button></div><button className="icon-button" title="放大预览" aria-label="放大预览" disabled={!previewUrl} onClick={() => setPreviewLarge(true)}><Maximize2 size={17}/></button></div><div className={`preview-canvas ${previewUrl ? 'has-image' : ''}`}>{previewUrl ? <img src={previewUrl} alt={showingEditable ? '可编辑科研图预览' : '当前视觉稿预览'} onError={() => setError('预览图片无法加载，请重新打开项目或检查源文件。')}/> : <EmptyPreview/>}</div><div className="preview-footer"><span>{previewUrl ? showingEditable ? `${project.scene?.width ?? ''} × ${project.scene?.height ?? ''} · 可编辑结构预览` : `${target ? assetSize(target) : ''} · 视觉参考稿` : '等待图片'}</span>{previewUrl && <span>{showingEditable ? <><Layers3 size={13}/>EDITABLE</> : <><FileImage size={13}/>IMAGE</>}</span>}</div>
          <RunSummary runs={project.runs}/>
        </section></div>
      </main>
    </div>}
    {settingsOpen && boot && <SettingsDialog settings={boot.settings} onClose={() => setSettingsOpen(false)} onSaved={settings => setBoot(prev => prev ? { ...prev, settings } : prev)}/>}
    {previewLarge && previewUrl && <div className="modal-backdrop preview-modal" onClick={() => setPreviewLarge(false)}><div className="preview-modal-top"><span>{project?.name} · {showingEditable ? '可编辑图' : '视觉稿'}</span><button className="icon-button" aria-label="关闭大图" onClick={() => setPreviewLarge(false)}><X size={22}/></button></div><img src={previewUrl} alt="科研图放大预览" onClick={e => e.stopPropagation()}/></div>}
    {sceneDraft && <TextEditor scene={sceneDraft} busy={!!busy} onChange={setSceneDraft} onClose={() => setSceneDraft(undefined)} onSave={saveTextEdits}/>}
  </div>;
}
