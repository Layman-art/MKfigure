import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowDownToLine, ArrowLeft, Check, CheckCircle2, Images, LoaderCircle, Search, Trash2, Upload, X } from 'lucide-react';
import type { LibraryCategory, LibraryItem } from '../../shared/types';
import { errorText } from '../display';
import { Button, Field } from './Controls';

type Filter = 'all' | LibraryCategory;
type Preview = { item: LibraryItem; url: string };

export default function LibraryPage({ selecting, selectedId, onBack, onSelect, onBusyChange }: {
  selecting: boolean;
  selectedId?: string;
  onBack: () => void;
  onSelect: (id: string) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
}) {
  const app = window.mkFigure;
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [filter, setFilter] = useState<Filter>(selecting ? 'reference' : 'all');
  const [query, setQuery] = useState('');
  const [importCategory, setImportCategory] = useState<LibraryCategory>('reference');
  const [busy, setBusy] = useState('正在载入素材');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview>();
  const [nameDraft, setNameDraft] = useState('');
  const [categoryDraft, setCategoryDraft] = useState<LibraryCategory>('reference');
  const operation = useRef(true);
  const modalClose = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let mounted = true;
    onBusyChange(true);
    app.listLibrary().then(result => { if (mounted) setItems(result); })
      .catch(err => { if (mounted) setError(errorText(err)); })
      .finally(() => { if (mounted) { operation.current = false; setBusy(''); onBusyChange(false); } });
    return () => { mounted = false; onBusyChange(false); };
  }, [app, onBusyChange]);

  const perform = async (label: string, task: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true; setBusy(label); onBusyChange(true); setError(''); setNotice('');
    try { await task(); } catch (err) { setError(errorText(err)); }
    finally { operation.current = false; setBusy(''); onBusyChange(false); }
  };
  const closePreview = () => {
    if (operation.current) return;
    setPreview(undefined);
    returnFocus.current?.focus();
  };
  useEffect(() => { if (preview) modalClose.current?.focus(); }, [preview?.item.id]);
  const showPreview = (item: LibraryItem) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void perform('正在载入预览', async () => {
      const url = await app.getLibraryPreview(item.id);
      setNameDraft(item.name); setCategoryDraft(item.category); setPreview({ item, url });
    });
  };
  const importFiles = () => void perform('正在导入素材', async () => {
    setImportErrors([]);
    const result = await app.importLibraryFiles(importCategory);
    setItems(result.items); setImportErrors(result.errors);
    if (result.importedIds.length) {
      setQuery(''); setFilter(importCategory);
      setNotice(`已导入 ${result.importedIds.length} 张素材`);
    }
  });
  const update = () => void perform('正在保存素材', async () => {
    if (!preview) return;
    if (!nameDraft.trim()) throw new Error('素材名称不能为空。');
    const item = await app.updateLibraryItem(preview.item.id, { name: nameDraft.trim(), category: categoryDraft });
    setItems(previous => previous.map(old => old.id === item.id ? item : old));
    setPreview(previous => previous ? { ...previous, item } : previous);
    setNameDraft(item.name); setNotice('素材已更新');
  });
  const remove = () => void perform('正在删除素材', async () => {
    if (!preview) return;
    const result = await app.deleteLibraryItem(preview.item.id);
    if (!result.deleted) return;
    setItems(result.items); setPreview(undefined); setNotice('已移入回收站');
  });
  const exportOriginal = () => void perform('正在导出原文件', async () => {
    if (!preview) return;
    const result = await app.exportLibraryItem(preview.item.id);
    if (result.path) setNotice('原文件已导出');
  });
  const select = (id: string) => void perform('正在应用风格参考', () => onSelect(id));
  const visibleItems = items.filter(item => (filter === 'all' || item.category === filter) && item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const counts = { all: items.length, reference: items.filter(item => item.category === 'reference').length, icon: items.filter(item => item.category === 'icon').length };
  const changed = !!preview && (nameDraft.trim() !== preview.item.name || categoryDraft !== preview.item.category);

  return <main className="library-page">
    <div className="library-heading">
      <button className="library-back text-button" onClick={() => { if (!operation.current) onBack(); }} disabled={!!busy}><ArrowLeft size={16}/>{selecting ? '返回创作' : '返回首页'}</button>
      <div><div><h1>{selecting ? '选择风格参考' : '图片素材库'}</h1><p>{selecting ? '选一张图片，作为当前作品的风格参考。' : '收藏参考图与小图标，随时取用。'}</p></div><span className="library-count"><Images size={17}/>{items.length} 张素材</span></div>
    </div>
    <div className="library-toolbar">
      <div className="library-filters" aria-label="素材分类">{([{ id: 'all', label: '全部' }, { id: 'reference', label: '参考图' }, { id: 'icon', label: '图标' }] as const).map(tab => <button key={tab.id} aria-pressed={filter === tab.id} className={filter === tab.id ? 'active' : ''} onClick={() => setFilter(tab.id)}>{tab.label}<span>{counts[tab.id]}</span></button>)}</div>
      <label className="library-search"><Search size={16}/><input aria-label="搜索素材" placeholder="搜索素材名称" value={query} onChange={event => setQuery(event.target.value)}/>{query && <button aria-label="清除搜索" onClick={() => setQuery('')}><X size={14}/></button>}</label>
      <div className="library-import"><select aria-label="导入素材分类" value={importCategory} disabled={!!busy} onChange={event => setImportCategory(event.target.value as LibraryCategory)}><option value="reference">参考图</option><option value="icon">图标</option></select><Button icon={Upload} variant="primary" disabled={!!busy} onClick={importFiles}>导入图片</Button></div>
    </div>
    {error && <div className="library-message error-message" role="alert"><AlertCircle size={16}/><span>{error}</span><button aria-label="关闭素材库错误" onClick={() => setError('')}><X size={14}/></button></div>}
    {notice && <div className="library-message notice-message" role="status"><CheckCircle2 size={16}/><span>{notice}</span></div>}
    {importErrors.length > 0 && <details className="library-import-errors" open><summary>{importErrors.length} 个文件未导入</summary><ul>{importErrors.map((message, index) => <li key={index}>{message}</li>)}</ul></details>}
    <div className="library-status"><span>PNG · JPEG · WebP · SVG</span>{busy && <span role="status"><LoaderCircle size={14} className="spin"/>{busy}</span>}</div>
    <div className="library-grid" aria-label="素材列表" aria-busy={!!busy}>
      {visibleItems.map(item => <article key={item.id} className={`library-card ${selectedId === item.id ? 'selected' : ''}`} data-library-id={item.id}>
        <button className={`library-thumb ${item.category}`} disabled={!!busy} onClick={() => showPreview(item)} aria-label={`预览 ${item.name}`}><img src={item.thumbnailUrl} alt={item.name} loading="lazy"/>{selectedId === item.id && <span className="library-selected"><Check size={12}/>当前参考</span>}</button>
        <div className="library-card-info"><strong title={item.name}>{item.name}</strong><div><span className={`library-source ${item.source}`}>{item.source === 'builtin' ? '内置' : '我的素材'}</span><small>{item.extension.replace(/^\./, '').toUpperCase()} · {item.width} × {item.height}</small></div></div>
        <div className="library-card-actions"><span>{item.category === 'reference' ? '参考图' : '图标'}</span><button className="text-button" disabled={!!busy} onClick={() => selecting ? select(item.id) : showPreview(item)}>{selecting ? '用作风格' : '查看素材'}</button></div>
      </article>)}
    </div>
    {!visibleItems.length && !busy && <div className="library-empty"><Images size={35} strokeWidth={1.3}/><h2>{query ? '没有找到素材' : '这里还没有素材'}</h2><p>{query ? '试试其他名称，或切换分类。' : '选择分类后，导入你常用的图片。'}</p></div>}
    {preview && <div className="modal-backdrop library-modal" onClick={closePreview}>
      <section className="library-detail" role="dialog" aria-modal="true" aria-labelledby="library-detail-title" onClick={event => event.stopPropagation()} onKeyDown={event => {
        if (event.key === 'Escape') closePreview();
        if (event.key !== 'Tab') return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)'));
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
        <div className={`library-detail-image ${preview.item.category}`}><img src={preview.url} alt={preview.item.name}/></div>
        <div className="library-detail-panel"><div className="library-detail-heading"><h2 id="library-detail-title">素材详情</h2><button ref={modalClose} className="icon-button" aria-label="关闭素材预览" disabled={!!busy} onClick={closePreview}><X size={18}/></button></div>
          <span className={`library-source ${preview.item.source}`}>{preview.item.source === 'builtin' ? '内置素材' : '我的素材'}</span>
          {preview.item.source === 'user' ? <><Field label="名称"><input aria-label="素材名称" value={nameDraft} disabled={!!busy} onChange={event => setNameDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && changed && !busy) update(); }}/></Field><Field label="分类"><select aria-label="素材类别" value={categoryDraft} disabled={!!busy} onChange={event => setCategoryDraft(event.target.value as LibraryCategory)}><option value="reference">参考图</option><option value="icon">图标</option></select></Field><Button disabled={!!busy || !changed || !nameDraft.trim()} onClick={update}>保存更改</Button></> : <><h3 className="library-detail-name">{preview.item.name}</h3><p className="library-detail-meta">{preview.item.category === 'reference' ? '参考图' : '图标'} · 内置素材只读</p></>}
          <p className="library-detail-meta">{preview.item.extension.replace(/^\./, '').toUpperCase()} · {preview.item.width} × {preview.item.height}</p>
          {error && <p className="library-detail-error" role="alert">{error}</p>}
          {notice && <p className="library-detail-notice" role="status">{notice}</p>}
          <div className="library-detail-actions">{selecting && <Button variant="primary" icon={Check} disabled={!!busy || changed} onClick={() => select(preview.item.id)}>使用此风格</Button>}<Button icon={ArrowDownToLine} disabled={!!busy} onClick={exportOriginal}>导出原文件</Button>{preview.item.source === 'user' && <button className="library-delete text-button" disabled={!!busy} onClick={remove}><Trash2 size={15}/>删除素材</button>}</div>
        </div>
      </section>
    </div>}
  </main>;
}
