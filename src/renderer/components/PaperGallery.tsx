import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpRight, BookOpen, Bookmark, Check, ChevronLeft, ChevronRight, Copy, FileText, Languages, Link, Search, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { PaperFigure, WorkspaceApi } from '../../shared/types';
import { errorText } from '../display';
import GalleryOffline from './GalleryOffline';
import { figureImage, figureTier, galleryPageSize, galleryShareUrl, gallerySource, initialFilters, makeSearchIndex, patternNames, queryFigures, readGalleryLink, tierNames, venueNames } from '../paper-gallery';
import type { GalleryFilters, GalleryLocation } from '../paper-gallery';
import '../paper-gallery.css';

const favoritesKey = 'mkfigure.paper-gallery.favorites.v1';
const languageKey = 'mkfigure.paper-gallery.language.v1';
const startLocation: GalleryLocation = { filters: initialFilters, id: null, favoritesOnly: false };
function readFavorites() {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(favoritesKey) || '[]');
    return new Set<string>(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
  } catch { return new Set<string>(); }
}
const patternHelp: Record<string, [string, string]> = {
  teaser: ['用图文组合呈现论文最值得关注的视觉结果。', 'A visual introduction to the main result or idea.'],
  conceptual: ['用示意或比喻解释论文的核心概念。', 'A visual explanation of the central concept.'],
  framework: ['展示系统模块、角色与相互关系。', 'An overview of system modules and their relationships.'],
  pipeline: ['沿数据流展示输入、处理阶段和输出。', 'Inputs, processing stages and outputs in sequence.'],
  architecture: ['展开模型内部的层、组件及连接。', 'The internal layers, components and connections of a model.'],
  taxonomy: ['按类别整理任务、能力、数据集或基准。', 'An organized view of tasks, capabilities, data or benchmarks.'],
  results: ['突出实验测量、趋势或定性结果。', 'A figure focused on measurements, trends or qualitative results.'],
  comparison: ['并列展示方法、方案或样例的差异。', 'A side-by-side comparison of methods, settings or examples.'],
};

function CardImage({ row, eager, english, onOpen }: { row: PaperFigure; eager: boolean; english: boolean; onOpen: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  const retry = () => { setFailed(false); setAttempt(n => n + 1); };
  const style = { aspectRatio: row.w && row.h ? row.w + ' / ' + row.h : '16 / 10' };
  return <div className="pg-image-slot" style={style}>{failed ?
    <button type="button" className="pg-retry" onClick={retry}>{english ? 'Reload image' : '重新加载图片'}</button> :
    <button className="pg-preview" type="button" onClick={onOpen} aria-label={(english ? 'View ' : '查看 ') + row.title}><img key={attempt} loading={eager ? 'eager' : 'lazy'} decoding="async" src={figureImage(row.id) + (attempt ? '?retry=' + attempt : '')}
      alt="" onError={() => { if (!eager && !attempt) retry(); else setFailed(true); }} /></button>}</div>;
}
type Props = { api: WorkspaceApi; selecting: boolean; selectedId?: string; onSelect: (referenceId: string) => Promise<void>; onBack: () => void; onBusyChange: (busy: boolean) => void };

export default function PaperGallery({ api, selecting, selectedId, onSelect, onBack, onBusyChange }: Props) {
  const [figures, setFigures] = useState<PaperFigure[]>([]);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [failedLoad, setFailedLoad] = useState(false);
  const [notice, setNotice] = useState('');
  const [favorites, setFavorites] = useState(readFavorites);
  const [en, setEn] = useState(() => { try { return localStorage.getItem(languageKey) === 'en'; } catch { return false; } });
  const [history, setHistory] = useState({ list: [startLocation], position: 0 });
  const [limit, setLimit] = useState(galleryPageSize);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState('');
  const [zoom, setZoom] = useState(false);
  const [imageError, setImageError] = useState('');
  const gallery = useRef<HTMLElement>(null);
  const lastFigure = useRef<string | null>(null);
  const more = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const linkField = useRef<HTMLInputElement>(null);
  const applyLock = useRef(false);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const local = history.list[history.position], { filters, favoritesOnly, id } = local;
  const tr = (zh: string, english: string) => en ? english : zh;
  const label = (pair?: [string, string], fallback = '') => pair?.[en ? 1 : 0] || fallback;
  const number = (n: number) => n.toLocaleString(en ? 'en-US' : 'zh-CN');

  useEffect(() => {
    let mounted = true;
    setLoading(true); setError(''); setFailedLoad(false); busyCallback.current(true);
    api.listPaperFigures().then(data => { if (mounted) setFigures(data); })
      .catch(reason => { if (mounted) { setError(errorText(reason)); setFailedLoad(true); } })
      .finally(() => { if (mounted) { setLoading(false); busyCallback.current(false); } });
    return () => { mounted = false; busyCallback.current(false); };
  }, [api, attempt]);

  const jump = useCallback((next: GalleryLocation, push = false) => {
    setHistory(old => {
      if (push) return { list: [...old.list.slice(0, old.position + 1), next], position: old.position + 1 };
      const list = old.list.slice(); list[old.position] = next;
      return { list, position: old.position };
    });
    setNotice(''); setImageError(''); setZoom(false);
  }, []);
  const travel = useCallback((delta: number) => {
    setHistory(old => ({ ...old, position: Math.min(old.list.length - 1, Math.max(0, old.position + delta)) }));
    setNotice(''); setImageError(''); setZoom(false);
  }, []);
  useEffect(() => {
    const visible = () => !!gallery.current?.getClientRects().length && !applyLock.current;
    const navigate = (delta: number) => {
      if (delta < 0 && history.position === 0) onBack();
      else travel(delta);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (!visible() || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const back = event.key === 'BrowserBack' || (event.altKey && event.key === 'ArrowLeft');
      const forward = event.key === 'BrowserForward' || (event.altKey && event.key === 'ArrowRight');
      if (!back && !forward) return;
      event.preventDefault(); event.stopPropagation(); navigate(back ? -1 : 1);
    };
    const sideButton = (event: MouseEvent) => {
      if (visible() && (event.button === 3 || event.button === 4)) {
        event.preventDefault(); navigate(event.button === 3 ? -1 : 1);
      }
    };
    window.addEventListener('keydown', keyboard, true);
    window.addEventListener('auxclick', sideButton);
    return () => { window.removeEventListener('keydown', keyboard, true); window.removeEventListener('auxclick', sideButton); };
  }, [history.position, onBack, travel]);
  const setFilter = <K extends keyof GalleryFilters>(key: K, value: GalleryFilters[K]) => jump({ ...local, id: null, filters: { ...filters, [key]: value } });
  const index = useMemo(() => makeSearchIndex(figures), [figures]);
  const rows = useMemo(() => queryFigures(figures, { filters, favoritesOnly, id: null }, favorites, index), [figures, filters, favoritesOnly, favorites, index]);
  const years = useMemo(() => [...new Set(figures.map(row => String(row.year)))].sort(), [figures]);
  const patterns = useMemo(() => { const available = new Set(figures.map(row => row.pattern)); return Object.keys(patternNames).filter(p => available.has(p)); }, [figures]);
  const counts = useMemo(() => {
    const venue: Record<string, number> = {}, tier: Record<string, number> = {};
    for (const item of figures) { venue[item.venue] = (venue[item.venue] || 0) + 1;
      const group = figureTier(item); if (group) tier[group] = (tier[group] || 0) + 1; }
    return { venue, tier };
  }, [figures]);
  const rowIndex = id ? rows.findIndex(row => row.id === id) : -1;
  const figure = rowIndex >= 0 ? rows[rowIndex] : undefined;
  const open = !!figure;
  const hasMore = limit < rows.length;
  useEffect(() => { setLimit(galleryPageSize); }, [filters, favoritesOnly]);
  useEffect(() => {
    if (!hasMore || open || !more.current || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setLimit(value => value + galleryPageSize);
    }, { rootMargin: '150px' });
    observer.observe(more.current);
    return () => observer.disconnect();
  }, [hasMore, open, limit, rows.length]);
  useEffect(() => {
    const element = dialog.current;
    if (open && element && !element.open) element.showModal();
    return () => { if (element?.open) element.close(); };
  }, [open]);
  useEffect(() => {
    if (id) { lastFigure.current = id; return; }
    if (!lastFigure.current || !gallery.current) return;
    const target = gallery.current.querySelector<HTMLElement>('[data-paper-id="' + CSS.escape(lastFigure.current) + '"] .pg-preview');
    const fallback = gallery.current.querySelector<HTMLInputElement>('.pg-search input');
    (target || fallback)?.focus({ preventScroll: true });
    lastFigure.current = null;
  }, [id]);
  useEffect(() => { if (linkOpen) linkField.current?.focus(); }, [linkOpen]);
  useEffect(() => {
    const refresh = (event: StorageEvent) => { if (event.key === favoritesKey) setFavorites(readFavorites()); };
    window.addEventListener('storage', refresh);
    return () => window.removeEventListener('storage', refresh);
  }, []);

  const openFigure = (row: PaperFigure) => { setError(''); jump({ ...local, id: row.id }, true); };
  const closeFigure = () => {
    if (applyLock.current) return;
    if (history.position && !history.list[history.position - 1].id) travel(-1);
    else jump({ ...local, id: null });
  };
  const moveFigure = (delta: number) => {
    const row = rows[rowIndex + delta];
    if (row && !applyLock.current) jump({ ...local, id: row.id });
  };
  const toggleFavorite = (row: PaperFigure) => {
    const next = new Set(readFavorites());
    if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
    try { localStorage.setItem(favoritesKey, JSON.stringify([...next])); setFavorites(next); }
    catch { setError(tr('无法保存收藏，请检查本机存储。', 'Favorites could not be saved to local storage.')); return; }
    if (favoritesOnly && id === row.id && !next.has(row.id)) closeFigure();
  };
  const toggleLanguage = () => {
    setEn(!en);
    try { localStorage.setItem(languageKey, en ? 'zh' : 'en'); } catch { /* Language still applies for this view. */ }
  };
  const restore = () => {
    const state = readGalleryLink(link, figures);
    if (!state) { setError(tr('无法打开此链接，请粘贴原始图库链接，并确认图号存在。', 'Paste an original gallery link with a figure available in this collection.')); return; }
    setHistory(old => { const list = [...old.list.slice(0, old.position + 1), { ...state, id: null }]; if (state.id) list.push(state); return { list, position: list.length - 1 }; });
    setZoom(false); setImageError(''); setError(''); setNotice(link.includes('#f=') && !state.id ? tr('此图不在当前图库，已恢复筛选条件。', 'This figure is unavailable. Its filters have been restored.') : ''); setLinkOpen(false); setLink('');
  };
  const copy = async () => {
    try { await api.copyPaperGalleryLink(galleryShareUrl(local)); setError(''); setNotice(tr('已复制原图库链接', 'Original gallery link copied')); }
    catch (reason) { setError(errorText(reason)); }
  };
  const select = async (row: PaperFigure) => {
    if (applyLock.current) return;
    applyLock.current = true; setApplying(true); setError(''); busyCallback.current(true);
    try { await onSelect('paper:' + row.id); }
    catch (reason) { setError(errorText(reason)); }
    finally { applyLock.current = false; setApplying(false); busyCallback.current(false); }
  };
  const openArticle = async (row: PaperFigure, kind: 'paper' | 'pdf') => {
    try { await api.openPaperFigureLink(row.id, kind); } catch (reason) { setError(errorText(reason)); }
  };
  const badge = (row: PaperFigure) => row.award === 'honorable' ? tr('荣誉提名', 'Honorable mention')
    : row.award ? tr('最佳论文', 'Best paper') : label(tierNames[figureTier(row)]);
  const favoriteButton = (row: PaperFigure, compact = false) => {
    const saved = favorites.has(row.id), title = saved ? tr('取消收藏', 'Remove favorite') : tr('收藏', 'Save favorite');
    return <button type="button" className={compact ? 'pg-fav-icon' : 'pg-button'} data-saved={saved} aria-pressed={saved} aria-label={title} title={title} onClick={() => toggleFavorite(row)}><Bookmark size={16} fill={saved ? 'currentColor' : 'none'} />{!compact && title}</button>;
  };
  const status = error ? <p role="alert" className="pg-error">{error}</p> : notice ? <p role="status" className="pg-notice">{notice}</p> : null;
  const filterRows: [keyof Pick<GalleryFilters, 'venue' | 'year' | 'tier' | 'pattern'>, string, [string, string][]][] = [
    ['venue', tr('会议', 'Venue'), Object.entries(venueNames)],
    ['year', tr('年份', 'Year'), years.map(year => [year, year])],
    ['tier', tr('等级', 'Tier'), Object.entries(tierNames).map(([key, names]) => [key, label(names)])],
    ['pattern', tr('图型', 'Pattern'), patterns.map(key => [key, label(patternNames[key], key)])],
  ];
  const selected = (row: PaperFigure) => selectedId === 'paper:' + row.id;
  const applyButton = (row: PaperFigure) => <button className="pg-button pg-use" disabled={applying} onClick={() => void select(row)}>{selected(row) ? <Check size={15} /> : <ArrowUpRight size={15} />}{selected(row) ? tr('已选为风格参考', 'Selected reference') : tr('用作风格参考', 'Use as style reference')}</button>;
  const activeFilters = filters.q || filterRows.some(([key]) => filters[key] !== 'all') || favoritesOnly;
  return <main ref={gallery} className="paper-gallery" lang={en ? 'en' : 'zh-CN'}>
    <nav className="pg-top"><button onClick={onBack} disabled={applying}><ArrowLeft size={16} />{tr('返回', 'Back')}</button><div>
      <button title={tr('后退', 'Go back')} aria-label={tr('后退', 'Go back')} disabled={!history.position || applying} onClick={() => travel(-1)}><ChevronLeft size={17}/></button>
      <button title={tr('前进', 'Go forward')} aria-label={tr('前进', 'Go forward')} disabled={history.position + 1 >= history.list.length || applying} onClick={() => travel(1)}><ChevronRight size={17}/></button>
      <button onClick={toggleLanguage} aria-label={tr('切换为英文', 'Switch to Chinese')}><Languages size={16}/>{en ? '中文' : 'EN'}</button></div>
    </nav>
    <header className="pg-heading"><div><h1>{tr('顶会主图库', 'Conference figure gallery')}</h1><p>{tr('按会议与图型查找论文主图，收藏或选作绘图参考。', 'Explore paper figures by venue and visual pattern. Save favorites or select a style reference.')}</p></div><button className={'pg-button' + (favoritesOnly ? ' pg-active' : '')} aria-pressed={favoritesOnly} onClick={() => jump({ ...local, id: null, favoritesOnly: !favoritesOnly }, true)}><Bookmark size={16}/>{tr('只看收藏', 'Favorites only')} · {favorites.size}</button></header>
    <div className="pg-source">{tr('图库由 Top-Conf Figure Gallery 整理，图片著作权归论文作者与出版方。', 'Curated by Top-Conf Figure Gallery. Images belong to the paper authors and publishers.')} <button onClick={() => void api.openPaperGallerySource('gallery').catch(reason => setError(errorText(reason)))}>{tr('原始图库', 'Original gallery')} ↗</button> · <button onClick={() => void api.openPaperGallerySource('rights').catch(reason => setError(errorText(reason)))}>{tr('图片使用政策', 'Image policy')} ↗</button></div>
    <GalleryOffline api={api} english={en}/>
    <div className="pg-controls">
      <div className="pg-tools"><label className="pg-search"><Search size={17}/><input type="search" value={filters.q} aria-label={tr('搜索论文或作者', 'Search titles and authors')} placeholder={tr('搜索论文标题、作者或关键词…', 'Search titles, authors or keywords…')} onChange={event => setFilter('q', event.target.value)} /></label>
        <button className="pg-button" onClick={() => setLinkOpen(!linkOpen)} aria-expanded={linkOpen}><Link size={15}/>{tr('打开链接', 'Open link')}</button><button className="pg-button" onClick={() => void copy()}><Copy size={15}/>{tr('分享', 'Share')}</button></div>
      {linkOpen && <form className="pg-link-form" onSubmit={event => { event.preventDefault(); restore(); }}><input ref={linkField} value={link} onChange={event => setLink(event.target.value)} aria-label={tr('原图库分享链接', 'Original gallery link')} placeholder={gallerySource + '?v=iclr#f=…'}/><button className="pg-button" disabled={loading || !link.trim()}>{tr('打开', 'Open')}</button></form>}
      {filterRows.map(([key, title, entries]) => <div className="pg-filters" role="group" aria-label={title} key={key}><strong>{title}</strong><div>{[['all', tr('全部', 'All')], ...entries].map(([value, name]) => <button key={value} aria-pressed={filters[key] === value} aria-label={name} onClick={() => setFilter(key, value)}>{name}{value !== 'all' && (key === 'venue' || key === 'tier') && <small aria-hidden="true">{number(counts[key][value] || 0)}</small>}</button>)}</div></div>)}
    </div>
    <details className="pg-guide"><summary>{tr('图型说明', 'Figure pattern guide')}</summary><dl>{Object.entries(patternHelp).map(([key, info]) => <div key={key}><dt>{label(patternNames[key], key)}</dt><dd>{label(info)}</dd></div>)}</dl></details>
    <div className="pg-results"><span aria-live="polite"><b>{number(rows.length)}</b> / {number(figures.length)} {tr('张主图', 'figures')}</span>
      {activeFilters ? <button className="pg-clear" onClick={() => jump({ ...local, id: null, favoritesOnly: false, filters: { ...initialFilters, sort: filters.sort } })}>{tr('清除筛选', 'Clear filters')}</button> : null}
      <label>{tr('排序', 'Sort')} <select aria-label={tr('排序', 'Sort')} value={filters.sort} onChange={event => setFilter('sort', event.target.value as GalleryFilters['sort'])}><option value="venue">{tr('会议顺序', 'Venue')}</option><option value="year">{tr('年份从早到晚', 'Year, oldest first')}</option><option value="title">{tr('论文标题 A–Z', 'Title A–Z')}</option></select></label></div>
    {!open && status}
    {loading ? <p className="pg-empty" role="status">{tr('正在读取本机图库…', 'Loading the local gallery…')}</p> : failedLoad ? <button className="pg-button" onClick={() => setAttempt(n => n + 1)}>{tr('重新载入', 'Retry')}</button> : !rows.length ? <p className="pg-empty">{favoritesOnly && !favorites.size ? tr('还没有收藏。点击图卡上的书签即可收藏。', 'No favorites yet. Use the bookmark on a figure to save it.') : tr('没有匹配的主图，请调整筛选或关键词。', 'No matching figures. Try different filters or keywords.')}</p> : null}
    <div className="pg-grid">{Array.from({ length: Math.ceil(Math.min(limit, rows.length) / galleryPageSize) }, (_, page) => <div className="pg-page" key={page}>{rows.slice(page * galleryPageSize, (page + 1) * galleryPageSize).map((row, slot) => <article key={row.id} data-paper-id={row.id} className="pg-card">
      <CardImage row={row} eager={page === 0 && slot < 24} english={en} onOpen={() => openFigure(row)}/>
      <div className="pg-card-body"><div className="pg-meta"><span>{venueNames[row.venue] || row.venue} · {row.year}</span>{badge(row) && <span className="pg-award">{badge(row)}</span>}</div>
        <button className="pg-title" onClick={() => openFigure(row)}>{row.title}</button>
        <p className="pg-byline">{row.authors.slice(0, 5).join(', ')}{row.authors.length > 5 ? ' et al.' : ''}</p><div className="pg-card-end"><span>{label(patternNames[row.pattern], row.pattern)}</span>{favoriteButton(row, true)}</div>
        {selecting && applyButton(row)}
      </div></article>)}</div>)}</div>
    {hasMore && <div className="pg-more" ref={more}><button className="pg-button" onClick={() => setLimit(value => value + galleryPageSize)}>{tr('加载更多', 'Load more')} · {Math.min(rows.length - limit, galleryPageSize)}</button></div>}
    {!hasMore && rows.length > galleryPageSize && <p className="pg-end" role="status">{tr('已加载全部', 'All figures loaded')} · {number(rows.length)}</p>}
    {figure && <dialog ref={dialog} className="pg-dialog" aria-label={figure.title} onCancel={event => { event.preventDefault(); if (zoom) setZoom(false); else closeFigure(); }} onClick={event => { if (event.target === event.currentTarget) closeFigure(); }} onKeyDown={event => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); moveFigure(event.key === 'ArrowLeft' ? -1 : 1); }
    }}><div className="pg-dialog-body">
      <div className="pg-modal-tools"><span>{rowIndex + 1} / {number(rows.length)}</span><button className="pg-icon" aria-label={tr('上一张', 'Previous figure')} disabled={rowIndex <= 0 || applying} onClick={() => moveFigure(-1)}><ChevronLeft size={19}/></button><button className="pg-icon" aria-label={tr('下一张', 'Next figure')} disabled={rowIndex + 1 >= rows.length || applying} onClick={() => moveFigure(1)}><ChevronRight size={19}/></button>
      <button className="pg-icon" aria-label={zoom ? tr('适应窗口', 'Fit to window') : tr('放大原图', 'Zoom original image')} aria-pressed={zoom} onClick={() => setZoom(!zoom)}>{zoom ? <ZoomOut size={18}/> : <ZoomIn size={18}/>}</button><button autoFocus className="pg-icon" disabled={applying} aria-label={tr('关闭', 'Close')} onClick={closeFigure}><X size={19}/></button></div>
      <div className={'pg-stage' + (zoom ? ' pg-zoomed' : '')}>{imageError === figure.id ? <p role="alert">{tr('无法读取本地图片。', 'The local image could not be loaded.')} <button className="pg-button" onClick={() => setImageError('')}>{tr('重试', 'Retry')}</button></p> : <button aria-label={zoom ? tr('缩小原图', 'Fit image') : tr('放大原图', 'Zoom image')} onClick={() => setZoom(!zoom)}><img src={figureImage(figure.id)} style={zoom ? { minWidth: 'max(120cqw, ' + (figure.w || 0) + 'px)' } : undefined} onError={() => setImageError(figure.id)} alt={figure.title}/></button>}</div>
      <div className="pg-detail"><div className="pg-meta"><span>{venueNames[figure.venue] || figure.venue} · {figure.year}</span><span>{label(patternNames[figure.pattern], figure.pattern)}</span>{badge(figure) && <span className="pg-award">{badge(figure)}</span>}{figure.award && figure.tier && <span className="pg-award">{label(tierNames[figure.tier], figure.tier)}</span>}</div>
      <h2>{figure.title}</h2><p className="pg-authors">{figure.authors.join(', ')}</p>
      <div className="pg-actions">{selecting && applyButton(figure)}{favoriteButton(figure)}<button className="pg-button" disabled={!figure.paper} onClick={() => void openArticle(figure, 'paper')}><BookOpen size={15}/>{tr('论文', 'Paper')} ↗</button>{figure.pdf_source && <button className="pg-button" onClick={() => void openArticle(figure, 'pdf')}><FileText size={15}/>PDF ↗</button>}<button className="pg-button" onClick={() => void copy()}><Copy size={15}/>{tr('复制图链', 'Copy figure link')}</button></div>{status}</div>
    </div></dialog>}
  </main>;
}
