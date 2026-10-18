import { useEffect, useRef, useState } from 'react';
import { Check, MessageSquare, Square, WandSparkles } from 'lucide-react';
import type { StyleMessage, StyleSuggestion, WorkspaceApi } from '../../shared/types';
import { Button, Field } from './Controls';
import ReferencePicker from './ReferencePicker';
import { errorText } from '../display';
import '../creation-workspace.css';

export interface StyleEditorProps {
  api: WorkspaceApi; value: string; onChange: (value: string) => void;
  history?: StyleMessage[]; onHistoryChange?: (history: StyleMessage[]) => void;
  referenceName?: string; onChooseReference?: () => void; onClearReference?: () => void;
  disabled?: boolean; onBusyChange?: (busy: boolean) => void;
}
export default function StyleEditor({ api, value, onChange, history = [], onHistoryChange, referenceName, onChooseReference, onClearReference, disabled = false, onBusyChange }: StyleEditorProps) {
  const [suggestion, setSuggestion] = useState<StyleSuggestion>();
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; if (lock.current) { void api.cancelStyle().catch(() => {}); onBusyChange?.(false); } }; }, [api]);
  const optimize = async (message?: string) => {
    if (lock.current || disabled || (!value.trim() && !message?.trim())) return;
    lock.current = true; setBusy(true); setError(''); onBusyChange?.(true);
    try {
      const result = await api.optimizeStyle(value, message, history);
      if (!alive.current) return;
      setSuggestion(result);
      onHistoryChange?.([...history, { role: 'user', text: message?.trim() || `优化这段风格描述：${value}` }, { role: 'assistant', text: result.text }]);
      setInstruction('');
    } catch (err) { if (alive.current) setError(errorText(err)); }
    finally { lock.current = false; if (alive.current) { setBusy(false); onBusyChange?.(false); } }
  };
  return <div className="style-editor">
    <Field label="风格描述" hint="选填"><textarea rows={3} aria-label="风格描述" value={value} disabled={disabled || busy} onChange={e => onChange(e.target.value)} placeholder="白底、蓝灰配色、细线条，适合英文论文…"/></Field>
    {onChooseReference && <ReferencePicker name={referenceName} onOpen={onChooseReference} onClear={onClearReference || (() => {})}/>}
    <div className="style-editor-actions">{busy ? <Button icon={Square} onClick={() => void api.cancelStyle().catch(err => setError(errorText(err)))}>停止优化</Button> : <Button icon={WandSparkles} disabled={disabled || !value.trim()} onClick={() => void optimize()}>AI 优化风格</Button>}<span>可直接使用原文</span></div>
    {error && <p className="style-error" role="alert">{error}</p>}
    {suggestion && <div className="style-suggestion"><strong>建议描述</strong><p>{suggestion.text}</p><div><small>{suggestion.model} · {(suggestion.durationMs / 1000).toFixed(1)} 秒{suggestion.usage?.totalTokens != null ? ` · ${suggestion.usage.totalTokens.toLocaleString()} tokens` : ''}</small><Button icon={Check} disabled={disabled || busy} onClick={() => { onChange(suggestion.text); setSuggestion(undefined); }}>应用建议</Button></div></div>}
    <details className="style-dialogue"><summary><MessageSquare size={14}/>风格助手</summary><div className="style-dialogue-history">{history.map((message, index) => <p className={message.role} key={index}><strong>{message.role === 'user' ? '你' : '助手'}</strong>{message.text}</p>)}</div><textarea aria-label="风格修改意见" rows={2} value={instruction} disabled={disabled || busy} onChange={e => setInstruction(e.target.value)} placeholder="例如：更克制一些，保留蓝色但减少装饰。"/><Button disabled={disabled || busy || !instruction.trim()} onClick={() => void optimize(instruction)}>发送意见</Button></details>
  </div>;
}
