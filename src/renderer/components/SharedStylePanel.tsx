import { useState } from 'react';
import { Palette, X } from 'lucide-react';
import type { SharedStyle } from '../../shared/types';
import { errorText } from '../display';
import LibraryPage from './LibraryPage';
import StyleEditor from './StyleEditor';

export default function SharedStylePanel({ style, onClose, onSaved, onBusyChange }: { style: SharedStyle; onClose: () => void; onSaved: () => void; onBusyChange: (busy: boolean) => void }) {
  const [draft, setDraft] = useState<SharedStyle>(style);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyChanged = (value: boolean) => { setBusy(value); onBusyChange(value); };
  const save = async () => {
    busyChanged(true); setError('');
    try { await window.mkFigure.saveSharedStyle(draft); onSaved(); onClose(); }
    catch (err) { setError(errorText(err)); }
    finally { busyChanged(false); }
  };
  const reference = async (id?: string) => {
    setError(''); busyChanged(true);
    // The backend stores the actual library snapshot. Keep unsaved text edits intact.
    try { const updated = await window.mkFigure.setSharedReference(id); setDraft(previous => ({ ...previous, reference: updated.reference })); onSaved(); setPicker(false); }
    catch (err) { setError(errorText(err)); }
    finally { busyChanged(false); }
  };
  return <div className="studio-overlay style-overlay" role="dialog" aria-modal="true" aria-label="统一风格">
    {picker ? <LibraryPage selecting onSelect={reference} onBack={() => setPicker(false)} onBusyChange={onBusyChange}/> : <section className="shared-style-panel">
      <header><div><Palette size={18}/><h2>统一风格</h2></div><button className="icon-button" aria-label="关闭统一风格" disabled={busy} onClick={onClose}><X size={18}/></button></header>
      <p className="style-scope-note">应用于本文件夹中的作品。单张图可以覆盖，正在运行的任务保持原设置。</p>
      {error && <p className="global-message error-message" role="alert">{error}</p>}
      <div className="shared-style-body"><StyleEditor api={window.mkFigure} value={draft.prompt} onChange={prompt => setDraft(previous => ({ ...previous, prompt }))} history={draft.history} onHistoryChange={history => setDraft(previous => ({ ...previous, history }))} referenceName={draft.reference?.name} onChooseReference={() => setPicker(true)} onClearReference={() => void reference()} onBusyChange={busyChanged}/>
      <div className="shared-style-fields"><label>配色<input placeholder="例如：海军蓝、浅灰，橙色强调" value={draft.palette} onChange={event => setDraft({ ...draft, palette: event.target.value })}/></label><label>背景<input placeholder="例如：纯白背景" value={draft.background} onChange={event => setDraft({ ...draft, background: event.target.value })}/></label><label>线条与图标<input placeholder="例如：细线、圆角、扁平图标" value={draft.lines} onChange={event => setDraft({ ...draft, lines: event.target.value })}/></label></div><p className="shared-font-note">中文：微软雅黑 · 英文：Times New Roman · 公式：衬线数学字体</p></div>
      <footer><span>保存后用于下一次生成</span><button className="button accent" disabled={busy} onClick={() => void save()}>保存风格</button></footer>
    </section>}
  </div>;
}
