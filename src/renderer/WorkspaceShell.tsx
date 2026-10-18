import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, FileImage, FolderOpen, Grid2X2, Home, Images, LoaderCircle, Palette, PanelLeftClose, PanelLeftOpen, Settings2, Trash2, X } from 'lucide-react';
import { PANE_COUNT, type AppSettings, type FolderState } from '../shared/types';
import App, { type PaneActions, type PaneState } from './App';
import BrandMark from './BrandMark';
import LibraryPage from './components/LibraryPage';
import SharedStylePanel from './components/SharedStylePanel';
import SettingsDialog from './components/SettingsDialog';
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
  const [settings, setSettings] = useState<AppSettings>();
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
  useEffect(() => { document.title = `MK Figure · ${folderState?.selected ? folderState.folder.name : '创作空间'}`; }, [folderState]);
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
  const selected = !!folderState?.selected;
  const acceptFolder = (result: FolderState) => {
    if (result.selected !== folderState?.selected || result.folder.id !== folderState?.folder.id || result.folder.path !== folderState?.folder.path) {
      actions.current = []; setStates(initialStates()); setGeneration(value => value + 1); setStyleOpen(false); home();
    }
    setFolderState(result);
  };
  const changeFolder = async (path?: string, local = false) => {
    if (blocked || switchingRef.current) return;
    switchingRef.current = true; setSwitching(true); setError('');
    try {
      await Promise.all(actions.current.map(action => action?.flush()));
      const result = await (local ? window.mkFigure.closeFolder() : window.mkFigure.openFolder(path));
      acceptFolder(result);
    } catch (err) { setError(errorText(err)); }
    finally { switchingRef.current = false; setSwitching(false); }
  };
  const removeFolder = async (path: string) => {
    if (blocked || switchingRef.current) return;
    switchingRef.current = true; setSwitching(true); setError('');
    try {
      if (path === folderState?.folder.path) await Promise.all(actions.current.map(action => action?.flush()));
      acceptFolder(await window.mkFigure.removeFolder(path));
    } catch (err) { setError(errorText(err)); }
    finally { switchingRef.current = false; setSwitching(false); }
  };
  const showSettings = async () => {
    try { setSettings((await window.mkFigure.bootstrap()).settings); }
    catch (err) { setError(errorText(err)); }
  };
  const single = async () => {
    if (!selected || switchingRef.current || (mode === 'single' && expanded !== null)) return;
    const index = states.findIndex(state => !state.projectId);
    const paneIndex = index < 0 ? 0 : index;
    setMode('single'); setExpanded(paneIndex);
    if (index >= 0) await actions.current[paneIndex]?.create('full');
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
  const projectList = <div className="folder-projects">{folder?.projects.map(project => <div className="folder-project-row" key={project.id}><button title={project.name} className={expanded !== null && states[expanded]?.projectId === project.id ? 'active' : ''} onClick={() => void openProject(project.id)} disabled={switching}><FileImage size={14}/><span>{project.name}</span>{states.some(state => state.projectId === project.id && state.running) && <LoaderCircle size={12} className="spin"/>}</button><button className="folder-project-delete" aria-label={`删除 ${project.name}`} title="移入回收站" disabled={switching || states.some(state => state.projectId === project.id && state.running)} onClick={() => void removeProject(project.id)}><Trash2 size={12}/></button></div>)}{folder && !folder.projects.length && <p>作品将自动保存在这里</p>}</div>;
  return <div className={`studio-shell${sidebar ? '' : ' sidebar-collapsed'}`}>
    <aside className="studio-sidebar" hidden={!sidebar}>
      <button className="studio-brand" onClick={home}><BrandMark className="brand-mark"/><strong>MK Figure</strong></button>
      <nav className="studio-navigation" aria-label="工作区导航">
        <button className={mode === 'home' ? 'active' : ''} onClick={home}><Home size={17}/>首页</button>
        <button className={mode === 'single' ? 'active' : ''} onClick={() => void single().catch(err => setError(errorText(err)))} disabled={switching || !selected} title={!selected ? '请先打开文件夹' : undefined}><FileImage size={17}/>单图创作</button>
        <button className={mode === 'parallel' ? 'active' : ''} disabled={switching || !selected} title={!selected ? '请先打开文件夹' : undefined} onClick={() => { setMode('parallel'); setExpanded(null); }}><Grid2X2 size={17}/>并行创作</button>
        <button onClick={showLibrary}><Images size={17}/>图片素材库</button>
      </nav>
      <div className="folder-heading"><span>创作文件夹</span><button aria-label="打开文件夹" title={running ? '任务完成后可切换文件夹' : '打开文件夹'} disabled={blocked} onClick={() => void changeFolder()}><FolderOpen size={16}/></button></div>
      <div className="workspace-folder-list" aria-label="创作文件夹列表">
        {folderState?.recentFolders.map(item => {
          const active = selected && folder?.path === item.path;
          return <section className={`workspace-folder${active ? ' is-active' : ''}`} key={item.path}>
            <div className="workspace-folder-heading">
              <button className={active ? 'active-folder' : ''} aria-label={`打开文件夹 ${item.name}`} aria-current={active ? 'true' : undefined} title={item.path} disabled={blocked} onClick={() => void changeFolder(item.path)}><FolderOpen size={15}/><strong>{item.name}</strong></button>
              <button className="workspace-folder-remove" aria-label={`从侧栏移除 ${item.name}`} title={`从侧栏移除：${item.path}\n文件仍保留在本地`} disabled={blocked} onClick={() => void removeFolder(item.path)}><X size={14}/></button>
            </div>
            {active && projectList}
          </section>;
        })}
        {folderState && !folderState.recentFolders.length && <p className="workspace-folder-hint">打开文件夹，开始保存创作</p>}
        {!!folderState?.localProjectCount && <section className="legacy-workspace"><button className="return-local" disabled={blocked} onClick={() => void changeFolder(undefined, true)}><FolderOpen size={13}/>旧版本地作品</button>{selected && !folder?.path && projectList}</section>}
      </div>
      <footer className="studio-sidebar-footer"><button onClick={editStyle} disabled={!selected || switching}><Palette size={16}/>统一风格</button><button onClick={() => void showSettings()} disabled={switching}><Settings2 size={16}/>模型与连接</button><span title={selected ? folder?.path || '旧版应用本地数据目录' : '选择一个本地目录保存作品'}><Check size={12}/>{selected ? folder?.path ? '保存到所选文件夹' : '旧作品保存在本机' : '尚未打开文件夹'}</span></footer>
    </aside>
    <main className={`studio-main multi-workspace${overview ? ' workspace-overview' : ''}`}>
      <header className="studio-header"><div><button className="icon-button" aria-label={sidebar ? '收起侧边栏' : '展开侧边栏'} onClick={() => setSidebar(value => !value)}>{sidebar ? <PanelLeftClose size={17}/> : <PanelLeftOpen size={17}/>}</button>{mode === 'parallel' && expanded !== null ? <button className="studio-back" onClick={() => setExpanded(null)}><ArrowLeft size={14}/>六窗总览</button> : <span>{mode === 'home' ? '创作空间' : mode === 'single' ? '单图创作' : '并行创作'}</span>}</div><div><span className="workspace-running"><i className={running ? 'active' : ''}/>{running ? `${running} / ${PANE_COUNT} 运行中` : selected ? '已自动保存' : '选择创作文件夹'}</span><button className="shared-style-button" disabled={!selected || switching} onClick={editStyle}><Palette size={14}/>统一风格</button></div></header>
      {error && <div className="global-message error-message" role="alert"><span>{error}</span><button onClick={() => setError('')} aria-label="关闭工作区提示">×</button></div>}
      {!selected && <section className="workspace-empty"><FolderOpen size={42} strokeWidth={1.2}/><h1>从一个文件夹开始</h1><p>选择创作目录，作品与修改记录会保存在这里。</p><button disabled={blocked || !folderState} onClick={() => void changeFolder()}><FolderOpen size={17}/>打开创作文件夹</button><small>以后可以从侧栏移除入口，文件仍保留在本地。</small></section>}
      {selected && mode === 'home' && <section className="studio-home"><div className="home-intro"><span>IDEAS INTO FIGURES</span><h1>让想法，清晰呈现。</h1><p>从一张图开始，或让多个想法同时生长。</p></div><div className="studio-routes"><button className="studio-route" onClick={() => void single().catch(err => setError(errorText(err)))} disabled={switching}><div className="route-drawing single-drawing"><i/><i/><i/><span/></div><span className="route-label">专注一张图</span><h2>单图创作</h2><p>生成、修改、复刻与检查。</p><ArrowRight size={20}/></button><button className="studio-route" onClick={() => { setMode('parallel'); setExpanded(null); }}><div className="route-drawing parallel-drawing">{Array.from({ length: 6 }, (_, i) => <i key={i}/>)}</div><span className="route-label">让灵感并行</span><h2>并行创作</h2><p>六个子窗口，统一风格，各自创作。</p><ArrowRight size={20}/></button></div><button className="home-folder-link" disabled={blocked} onClick={() => void changeFolder()}><FolderOpen size={16}/>打开文件夹，继续你的创作<ArrowRight size={14}/></button>{running > 0 && <p className="home-running"><LoaderCircle size={13} className="spin"/>{running} 张图正在后台创作</p>}</section>}
      {mode === 'parallel' && <nav className="workspace-taskbar" aria-label="并行创作任务">{states.map((state, index) => <button key={index} className={`workspace-task${expanded === index ? ' active' : ''}`} onClick={() => setExpanded(index)}><span className="workspace-task-index">{state.running ? <LoaderCircle className="spin" size={13}/> : state.thumbnail ? <Check size={13}/> : index + 1}</span><span><strong>{state.label}</strong><small>{state.message}</small></span></button>)}</nav>}
      <div className={overview ? 'creation-grid' : 'creation-expanded'} hidden={!selected || mode === 'home'}>{states.map((_, index) => <section key={`${generation}-${index}`} className="pane-host" data-pane-id={`pane-${index + 1}`} hidden={!selected || mode === 'home' || !overview && expanded !== index} aria-label={`创作子窗口 ${index + 1}`}><App api={window.mkFigure.panes[index]} compact={expanded !== index || mode === 'home'} paneIndex={index} sharedStyle={folder?.style} onHome={home} onEditSharedStyle={editStyle} {...callbacks.current[index]}/></section>)}</div>
    </main>
    {library && <div className="studio-overlay" role="dialog" aria-label="图片素材库"><LibraryPage selecting={false} onSelect={async () => {}} onBack={() => { if (!libraryBusy) setLibrary(false); }} onBusyChange={setLibraryBusy}/></div>}
    {styleOpen && selected && folder && <SharedStylePanel style={folder.style} onClose={() => setStyleOpen(false)} onSaved={() => void refresh()} onBusyChange={setStyleBusy}/>}
    {settings && <SettingsDialog settings={settings} onClose={() => setSettings(undefined)} onSaved={setSettings}/>}
    {switching && <div className="studio-switching" role="status"><LoaderCircle className="spin" size={19}/>正在更新工作区…</div>}
  </div>;
}
