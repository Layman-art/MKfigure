import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, FileImage, FolderOpen, Grid2X2, Home, Images, LoaderCircle, Palette, PanelLeftClose, PanelLeftOpen, Settings2, Trash2 } from 'lucide-react';
import { PANE_COUNT, type FolderState } from '../shared/types';
import App, { type PaneActions, type PaneState } from './App';
import BrandMark from './BrandMark';
import LibraryPage from './components/LibraryPage';
import SharedStylePanel from './components/SharedStylePanel';
import { errorText } from './display';
import './workspace-shell.css';

const initialStates = (): PaneState[] => Array.from({ length: PANE_COUNT }, (_, index) => ({ label: `创作 ${index + 1}`, running: false, ready: false, message: '未开始' }));
type Mode = 'home' | 'single' | 'parallel';

export default function WorkspaceShell() {
  const [mode, setMode] = useState<Mode>('home');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [states, setStates] = useState(initialStates);
  const [folderState, setFolderState] = useState<FolderState>();
  const [generation, setGeneration] = useState(0);
  const [sidebar, setSidebar] = useState(true);
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  const [library, setLibrary] = useState(false);
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [styleOpen, setStyleOpen] = useState(false);
  const [styleBusy, setStyleBusy] = useState(false);
  const actions = useRef<Array<PaneActions | undefined>>([]);
  const closing = useRef(false);
  const switchingRef = useRef(false);
  const refresh = useCallback(() => window.mkFigure.getFolder().then(setFolderState).catch(err => setError(errorText(err))), []);
  const report = useCallback((index: number, state: PaneState) => {
    setStates(previous => previous.map((item, i) => i === index ? state : item));
  }, []);
  const callbacks = useRef(initialStates().map((_, index) => ({
    onState: (state: PaneState) => report(index, state),
    onRegister: (value: PaneActions) => { actions.current[index] = value; },
    onExpand: () => setExpanded(index),
  })));
  const home = useCallback(() => { setMode('home'); setExpanded(null); }, []);
  const editStyle = useCallback(() => setStyleOpen(true), []);
  useEffect(() => { void refresh(); return window.mkFigure.onFolderChanged(() => { void refresh(); }); }, [refresh]);
  useEffect(() => { document.title = `MK Figure · ${folderState?.folder.name || '创作空间'}`; }, [folderState?.folder.name]);
  useLayoutEffect(() => window.mkFigure.onWindowCloseRequested(() => {
    if (closing.current) return;
    closing.current = true;
    void (async () => {
      try {
        await Promise.all(actions.current.map(action => action?.flush()));
        await window.mkFigure.finishWindowClose();
      } catch (err) {
        setError(`关闭前保存失败：${errorText(err)}`);
        await window.mkFigure.cancelWindowClose().catch(() => {});
      } finally { closing.current = false; }
    })();
  }), []);
  const running = states.filter(state => state.running).length;
  const blocked = !!running || switching || libraryBusy || styleBusy;
  const changeFolder = async (path?: string, local = false) => {
    if (blocked || switchingRef.current) return;
    switchingRef.current = true; setSwitching(true); setError('');
    try {
      await Promise.all(actions.current.map(action => action?.flush()));
      const result = await (local ? window.mkFigure.closeFolder() : window.mkFigure.openFolder(path));
      if (result.folder.id !== folderState?.folder.id || result.folder.path !== folderState?.folder.path) {
        actions.current = []; setStates(initialStates()); setGeneration(value => value + 1); home();
      }
      setFolderState(result);
    } catch (err) { setError(errorText(err)); }
    finally { switchingRef.current = false; setSwitching(false); }
  };
  const single = async () => {
    if (switchingRef.current || (mode === 'single' && expanded !== null)) return;
    const index = states.findIndex(state => !state.projectId);
    const selected = index < 0 ? 0 : index;
    setMode('single'); setExpanded(selected);
    if (index >= 0) await actions.current[selected]?.create('full');
  };
  const openProject = async (id: string) => {
    let index = states.findIndex(state => state.projectId === id);
    if (index < 0) index = states.findIndex(state => !state.projectId);
    if (index < 0) index = states.findIndex(state => !state.running);
    if (index < 0) { setError('六张图都在运行，请等待其中一张完成后打开作品。'); return; }
    try { await actions.current[index]?.open(id); setMode(mode === 'parallel' ? 'parallel' : 'single'); setExpanded(index); }
    catch (err) { setError(errorText(err)); }
  };
  const folder = folderState?.folder;
  const removeProject = async (id: string) => {
    const owner = states.findIndex(state => state.projectId === id);
    const index = owner >= 0 ? owner : states.findIndex(state => !state.running);
    if (index < 0 || states[index].running) return;
    try { await actions.current[index]?.remove(id); await refresh(); }
    catch (err) { setError(errorText(err)); }
  };
  const overview = mode === 'parallel' && expanded === null;
  const showLibrary = useCallback(() => setLibrary(true), []);
  return <div className={`studio-shell${sidebar ? '' : ' sidebar-collapsed'}`}>
    <aside className="studio-sidebar" hidden={!sidebar}>
      <button className="studio-brand" onClick={home}><BrandMark className="brand-mark"/><strong>MK Figure</strong></button>
      <nav className="studio-navigation" aria-label="工作区导航">
        <button className={mode === 'home' ? 'active' : ''} onClick={home}><Home size={17}/>首页</button>
        <button className={mode === 'single' ? 'active' : ''} onClick={() => void single().catch(err => setError(errorText(err)))} disabled={switching}><FileImage size={17}/>单图创作</button>
        <button className={mode === 'parallel' ? 'active' : ''} onClick={() => { setMode('parallel'); setExpanded(null); }}><Grid2X2 size={17}/>并行创作</button>
        <button onClick={showLibrary}><Images size={17}/>图片素材库</button>
      </nav>
      <div className="folder-heading"><span>创作文件夹</span><button aria-label="打开文件夹" title={running ? '任务完成后可切换文件夹' : '打开文件夹'} disabled={blocked} onClick={() => void changeFolder()}><FolderOpen size={16}/></button></div>
      <div className="active-folder" title={folder?.path || '应用本地作品'}><FolderOpen size={16}/><strong>{folder?.name || '正在载入'}</strong></div>
      <div className="folder-projects">{folder?.projects.map(project => <div className="folder-project-row" key={project.id}><button title={project.name} className={expanded !== null && states[expanded]?.projectId === project.id ? 'active' : ''} onClick={() => void openProject(project.id)} disabled={switching}><FileImage size={14}/><span>{project.name}</span>{states.some(state => state.projectId === project.id && state.running) && <LoaderCircle size={12} className="spin"/>}</button><button className="folder-project-delete" aria-label={`删除 ${project.name}`} title="移入回收站" disabled={switching || states.some(state => state.projectId === project.id && state.running)} onClick={() => void removeProject(project.id)}><Trash2 size={12}/></button></div>)}{folder && !folder.projects.length && <p>作品将自动保存在这里</p>}</div>
      {!!folderState?.recentFolders.length && <details className="recent-folders"><summary>最近的文件夹</summary>{folderState.recentFolders.map(item => <button key={item.path} title={item.path} disabled={blocked} onClick={() => void changeFolder(item.path)}><FolderOpen size={13}/>{item.name}</button>)}</details>}
      {folder?.path && <button className="return-local" disabled={blocked} onClick={() => void changeFolder(undefined, true)}><ArrowLeft size={13}/>返回本地作品</button>}
      <footer className="studio-sidebar-footer"><button onClick={editStyle}><Palette size={16}/>统一风格</button><button onClick={() => { const index = expanded ?? 0; setMode('single'); setExpanded(index); actions.current[index]?.showSettings(); }}><Settings2 size={16}/>模型与连接</button><span title={folder?.path || '应用本地数据目录'}><Check size={12}/>{folder?.path ? '保存到所选文件夹' : '保存在本机'}</span></footer>
    </aside>
    <main className={`studio-main multi-workspace${overview ? ' workspace-overview' : ''}`}>
      <header className="studio-header"><div><button className="icon-button" aria-label={sidebar ? '收起侧边栏' : '展开侧边栏'} onClick={() => setSidebar(value => !value)}>{sidebar ? <PanelLeftClose size={17}/> : <PanelLeftOpen size={17}/>}</button>{mode === 'parallel' && expanded !== null ? <button className="studio-back" onClick={() => setExpanded(null)}><ArrowLeft size={14}/>六窗总览</button> : <span>{mode === 'home' ? '创作空间' : mode === 'single' ? '单图创作' : '并行创作'}</span>}</div><div><span className="workspace-running"><i className={running ? 'active' : ''}/>{running ? `${running} / ${PANE_COUNT} 运行中` : '已自动保存'}</span><button className="shared-style-button" onClick={editStyle}><Palette size={14}/>统一风格</button></div></header>
      {error && <div className="global-message error-message" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="关闭工作区提示">×</button></div>}
      {mode === 'home' && <section className="studio-home"><div className="home-intro"><span>IDEAS INTO FIGURES</span><h1>让想法，清晰呈现。</h1><p>从一张图开始，或让多个想法同时生长。</p></div><div className="studio-routes"><button className="studio-route" onClick={() => void single().catch(err => setError(errorText(err)))} disabled={switching}><div className="route-drawing single-drawing"><i/><i/><i/><span/></div><span className="route-label">专注一张图</span><h2>单图创作</h2><p>生成、修改、复刻与检查。</p><ArrowRight size={20}/></button><button className="studio-route" onClick={() => { setMode('parallel'); setExpanded(null); }}><div className="route-drawing parallel-drawing">{Array.from({ length: 6 }, (_, i) => <i key={i}/>)}</div><span className="route-label">让灵感并行</span><h2>并行创作</h2><p>六个子窗口，统一风格，各自创作。</p><ArrowRight size={20}/></button></div><button className="home-folder-link" disabled={blocked} onClick={() => void changeFolder()}><FolderOpen size={16}/>打开文件夹，继续你的创作<ArrowRight size={14}/></button>{running > 0 && <p className="home-running"><LoaderCircle size={13} className="spin"/>{running} 张图正在后台创作</p>}</section>}
      {mode === 'parallel' && <nav className="workspace-taskbar" aria-label="并行创作任务">{states.map((state, index) => <button key={index} className={`workspace-task${expanded === index ? ' active' : ''}`} onClick={() => setExpanded(index)}><span className="workspace-task-index">{state.running ? <LoaderCircle className="spin" size={13}/> : state.thumbnail ? <Check size={13}/> : index + 1}</span><span><strong>{state.label}</strong><small>{state.message}</small></span></button>)}</nav>}
      <div className={overview ? 'creation-grid' : 'creation-expanded'} hidden={mode === 'home'}>{states.map((_, index) => <section key={`${generation}-${index}`} className="pane-host" data-pane-id={`pane-${index + 1}`} hidden={mode === 'home' || !overview && expanded !== index} aria-label={`创作子窗口 ${index + 1}`}><App api={window.mkFigure.panes[index]} compact={expanded !== index || mode === 'home'} paneIndex={index} sharedStyle={folder?.style} onHome={home} onEditSharedStyle={editStyle} {...callbacks.current[index]}/></section>)}</div>
    </main>
    {library && <div className="studio-overlay" role="dialog" aria-label="图片素材库"><LibraryPage selecting={false} onSelect={async () => {}} onBack={() => { if (!libraryBusy) setLibrary(false); }} onBusyChange={setLibraryBusy}/></div>}
    {styleOpen && folder && <SharedStylePanel style={folder.style} onClose={() => setStyleOpen(false)} onSaved={() => void refresh()} onBusyChange={setStyleBusy}/>}
    {switching && <div className="studio-switching" role="status"><LoaderCircle className="spin" size={19}/>正在打开文件夹…</div>}
  </div>;
}
