import { useEffect, useId, useRef, useState } from 'react';
import type { FigureLayoutPlan, LayoutRecommendation, PaperCitation, WorkspaceApi } from '../../shared/types';
import { errorText } from '../display';
import { figureImage, patternNames } from '../paper-gallery';
import '../layout-planner.css';

type Arrangement = FigureLayoutPlan['arrangement'];
const names: Record<Arrangement, string> = { horizontal: '横向流程', vertical: '纵向流程', parallel: '并行分支', grid: '网格对照' };

function newPlan(query: string): FigureLayoutPlan {
  const parallel = /分支|双流|并行|branch|two.stream|parallel/i.test(query);
  const compare = /对比|对照|比较|compar|versus/i.test(query);
  return { arrangement: parallel ? 'parallel' : compare ? 'grid' : 'horizontal',
    panels: parallel ? ['输入', '分支 A', '分支 B', '融合输出'] : compare ? ['对照 A', '对照 B'] : ['输入', '处理过程', '输出'],
    notes: '', referenceIds: [] };
}

function citation({ id, title, authors, venue, year, paper, pdf_source }: PaperCitation): PaperCitation {
  return { id, title, authors, venue, year, paper, pdf_source };
}

export function LayoutSketch({ arrangement, panels }: Pick<FigureLayoutPlan, 'arrangement' | 'panels'>) {
  const n = panels.length, end = n - 1;
  const arrow = useId().replace(/[^a-zA-Z0-9-]/g, '');
  let cols = n, rows = 1;
  const points: [number, number][] = [], links: [number, number][] = [];
  if (arrangement === 'grid') {
    cols = Math.min(n, n > 4 ? 3 : 2); rows = Math.ceil(n / cols);
    panels.forEach((_, i) => points.push([i % cols, Math.floor(i / cols)]));
  } else if (arrangement === 'parallel' && n >= 3) {
    cols = n === 3 ? 2 : 3; rows = n === 3 ? 2 : n - 2;
    const middle = (rows - 1) / 2;
    points.push([0, middle]);
    for (let i = 1; i <= rows; i++) { points.push([1, i - 1]); links.push([0, i]); }
    if (n > 3) { points.push([2, middle]); for (let i = 1; i < end; i++) links.push([i, end]); }
  } else {
    const stack = arrangement === 'vertical' || arrangement === 'parallel';
    if (stack) { cols = 1; rows = n; }
    panels.forEach((_, i) => { points.push(stack ? [0, i] : [i, 0]); if (i && arrangement !== 'parallel') links.push([i - 1, i]); });
  }
  const x = (i: number) => 6 + points[i][0] * 112, y = (i: number) => 6 + points[i][1] * 43;
  return <svg className="mk-layout-sketch" viewBox={'0 0 ' + Math.max(90, cols * 112 - 16) + ' ' + Math.max(34, rows * 43 - 9)}
    role="img" aria-label={names[arrangement] + '版式示意，' + panels.join('、')}>
    <defs><marker id={arrow} viewBox="0 0 7 7" refX="6" refY="3.5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 L7 3.5 L0 7 Z" fill="currentColor"/></marker></defs>
    {links.map(([a,b]) => {
      const vertical = arrangement === 'vertical';
      return <line key={a + '-' + b} x1={x(a) + (vertical ? 41 : 82)} y1={y(a) + (vertical ? 22 : 11)}
        x2={x(b) + (vertical ? 41 : -2)} y2={y(b) + (vertical ? -2 : 11)} stroke="currentColor" strokeWidth="1.4" markerEnd={'url(#' + arrow + ')'}/>;
    })}
    {panels.map((label, i) => <g key={i}><title>{label}</title><rect x={x(i)} y={y(i)} width="82" height="22" rx="4"/>
      <text x={x(i) + 41} y={y(i) + 14} textAnchor="middle">{Array.from(label).length > 8 ? Array.from(label).slice(0, 7).join('') + '…' : label}</text></g>)}
  </svg>;
}

function PanelName({ label, index, disabled, save }: { label: string; index: number; disabled: boolean; save: (text: string) => void }) {
  const [draft, setDraft] = useState(label);
  const focused = useRef(false);
  useEffect(() => { if (!focused.current) setDraft(label); }, [label]);
  return <input aria-label={'面板 ' + (index + 1)} value={draft} maxLength={100} disabled={disabled}
    onFocus={() => { focused.current = true; }} onBlur={() => { focused.current = false; setDraft(draft.trim() || label); }}
    onChange={e => { const text=e.target.value; setDraft(text); if (text.trim()) save(text.trim()); }}/>;
}

interface Props {
  api: WorkspaceApi; initialQuery: string; value?: FigureLayoutPlan;
  onChange: (plan: FigureLayoutPlan | undefined) => void; disabled?: boolean;
}

export default function LayoutPlanner({ api, initialQuery, value, onChange, disabled = false }: Props) {
  const [customQuery, setCustomQuery] = useState<string>();
  const query = (customQuery ?? initialQuery).slice(0, 4000);
  const [results, setResults] = useState<LayoutRecommendation[]>([]);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState<'search' | 'analyze'>();
  const [error, setError] = useState('');
  const [lookup, setLookup] = useState<PaperCitation[]>([]);
  const sequence = useRef(0);
  const selected = value?.referenceIds || [];
  const selectedKey = selected.join('|');
  const [expanded, setExpanded] = useState(!!value);
  const known = new Map([...lookup, ...results.map(result => result.figure), ...(value?.citations || [])].map(c => [c.id, c]));
  const locked = disabled || !!busy;
  useEffect(() => () => { ++sequence.current; }, [api]);
  useEffect(() => {
    if (!selected.some(id => !known.has(id))) return;
    let active = true;
    api.listPaperFigures().then(rows => { if (active) setLookup(rows.filter(row => selected.includes(row.id))); })
      .catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; };
  }, [api, selectedKey]);

  async function search() {
    if (locked || !query.trim()) return;
    const token = ++sequence.current;
    setBusy('search'); setError(''); setSearched(false); setResults([]);
    try { const list = await api.recommendPaperLayouts(query); if (token === sequence.current) { setResults(list); setSearched(true); } }
    catch (e) { if (token === sequence.current) setError(errorText(e)); }
    finally { if (token === sequence.current) setBusy(undefined); }
  }
  function toggle(row: PaperCitation) {
    const prev = value || newPlan(query);
    const referenceIds = selected.includes(row.id) ? selected.filter(id => id !== row.id) : [...selected, row.id];
    if (referenceIds.length > 3) return;
    known.set(row.id, row);
    onChange({ ...prev, referenceIds, citations: referenceIds.flatMap(id => known.has(id) ? [citation(known.get(id)!)] : []) });
  }
  async function analyze() {
    if (locked || !value || !selected.length) return;
    const token = ++sequence.current;
    setBusy('analyze'); setError('');
    try { const plan = await api.analyzePaperLayout(value, query); if (token === sequence.current) onChange(plan); }
    catch (e) { if (token === sequence.current) setError(errorText(e)); }
    finally { if (token === sequence.current) setBusy(undefined); }
  }
  const openSource = (id: string) => { void api.openPaperFigureLink(id, 'paper').catch(e => setError(errorText(e))); };
  return <details className="mk-layout-planner" open={expanded} onToggle={e => setExpanded(e.currentTarget.open)}>
    <summary>参考图与版式 <small>{value ? value.panels.length + ' 个面板 · ' + selected.length + ' 张参考' : '可选'}</small></summary>
    <div className="mk-layout-body">
      <label>检索任务<textarea rows={2} value={query} maxLength={4000} disabled={locked} placeholder="例如，机器人扩散策略，或双分支特征融合" onChange={e => { setCustomQuery(e.target.value); setResults([]); setSearched(false); }}/></label>
      <div className="mk-layout-actions"><button type="button" disabled={locked || !query.trim()} onClick={() => void search()}>{busy === 'search' ? '正在检索…' : '按任务推荐'}</button>
        {!value && <button type="button" disabled={locked} onClick={() => onChange(newPlan(query))}>手动建版式</button>}</div>
      {searched && !results.length && <p role="status">图库没有词语或图型匹配。可换用主题的英文术语，或手动建版式。</p>}
      {results.length > 0 && <><small>选择 1–3 张作为版式参考</small><div className="mk-layout-results">{results.map(({ figure, reason }) => <article key={figure.id}>
        <button type="button" className="mk-layout-choice" disabled={locked || (!selected.includes(figure.id) && selected.length >= 3)} aria-pressed={selected.includes(figure.id)} onClick={() => toggle(figure)}>
          <img src={figureImage(figure.id)} alt="" loading="lazy"/><span>{selected.includes(figure.id) ? '已选' : '选用'}</span></button>
        <strong>{figure.title}</strong><small title={figure.authors.join(', ')}>{figure.authors[0]} · {figure.venue.toUpperCase()} {figure.year} · {patternNames[figure.pattern]?.[0] || figure.pattern}</small><p>{reason}</p>
        <button type="button" className="mk-layout-link" onClick={() => openSource(figure.id)}>论文出处 ↗</button>
      </article>)}</div></>}
      {value && <>
        <div className="mk-layout-planhead"><strong>版式草图</strong><button type="button" className="mk-layout-link" disabled={locked} onClick={() => { onChange(undefined); setError(''); }}>清空版式</button></div>
        {selected.length > 0 && <ul className="mk-layout-picked">{selected.map(id => <li key={id}><img src={figureImage(id)} alt=""/><button type="button" className="mk-layout-link" onClick={() => openSource(id)}>{known.get(id)?.title || id} ↗</button>
          <button type="button" aria-label={'移除参考图 ' + (known.get(id)?.title || id)} disabled={locked} onClick={() => onChange({ ...value, referenceIds: selected.filter(key => key !== id), citations: value.citations?.filter(c => c.id !== id) })}>移除</button></li>)}</ul>}
        <label>面板排列<select value={value.arrangement} disabled={locked} onChange={e => onChange({ ...value, arrangement: e.target.value as Arrangement })}>{Object.entries(names).map(([id,name]) => <option key={id} value={id}>{name}</option>)}</select></label>
        <LayoutSketch arrangement={value.arrangement} panels={value.panels}/>
        <div className="mk-layout-panels">{value.panels.map((p, i) => <div key={i}><span>{i + 1}</span><PanelName label={p} index={i} disabled={locked} save={text => onChange({ ...value, panels: value.panels.map((v, j) => j === i ? text : v) })}/>
          <button type="button" disabled={locked || value.panels.length <= 1} aria-label={'移除面板 ' + (i + 1)} onClick={() => onChange({ ...value, panels: value.panels.filter((_, j) => j !== i) })}>移除</button></div>)}</div>
        <div className="mk-layout-actions"><button type="button" disabled={locked || value.panels.length >= 6} onClick={() => onChange({ ...value, panels: [...value.panels, '新面板'] })}>添加面板</button></div>
        <label>版式说明<textarea rows={2} disabled={locked} value={value.notes} maxLength={2000} placeholder="记录阅读顺序、连接关系或需要保留的细节" onChange={e => onChange({ ...value, notes: e.target.value })}/></label>
        {selected.length > 0 && <div className="mk-layout-actions"><button type="button" disabled={locked} onClick={() => void analyze()}>{busy === 'analyze' ? '正在读图…' : '读参考图细化版式'}</button><small>将所选参考图交给视觉模型</small></div>}
      </>}
      {error && <p className="mk-layout-error" role="alert">{error}</p>}
    </div>
  </details>;
}
