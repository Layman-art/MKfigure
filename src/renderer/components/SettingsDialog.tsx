import { useEffect, useState } from 'react';
import { AlertCircle, Check, CheckCircle2, ExternalLink, LoaderCircle, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { AppSettings, ModelInfo, ProviderStatus } from '../../shared/types';
import { errorText, reasoningLabel } from '../display';
import { Button, Field } from './Controls';

export default function SettingsDialog({ settings, onClose, onSaved }: { settings: AppSettings; onClose: () => void; onSaved: (settings: AppSettings) => void }) {
  const [draft, setDraft] = useState<AppSettings>(() => ({ ...structuredClone(settings), activeProvider: 'codex', imageProvider: 'codex' }));
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [status, setStatus] = useState<ProviderStatus>();
  const [busy, setBusy] = useState('读取模型');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const config = draft.providers.find(p => p.id === 'codex')!;
  const connected = status?.available && status?.authenticated;
  const selectedModel = models.find(model => model.id === config.model) || (!config.model ? models.find(model => model.isDefault) || models[0] : undefined);
  const efforts = selectedModel?.reasoningEfforts || [];
  const updateConfig = (patch: Partial<typeof config>) => setDraft(prev => ({ ...prev, providers: prev.providers.map(p => p.id === 'codex' ? { ...p, ...patch, enabled: true } : p) }));
  const selectModel = (id: string) => {
    const model = models.find(item => item.id === id);
    const supported = model?.reasoningEfforts || [];
    setDraft(prev => ({ ...prev, providers: prev.providers.map(p => p.id === 'codex' ? { ...p, model: id, enabled: true, vision: model?.supportsVision ?? p.vision } : p), reasoningEffort: supported.length && !supported.includes(prev.reasoningEffort) ? supported.includes('medium') ? 'medium' : supported[0] : prev.reasoningEffort }));
  };
  const save = async () => {
    const next = await window.mkFigure.saveSettings({ ...draft, providers: draft.providers.map(p => p.id === 'codex' ? { ...p, enabled: true } : p) });
    setDraft(next); onSaved(next); return next;
  };
  const action = async (label: string, fn: () => Promise<void>) => { setBusy(label); setError(''); setMessage(''); try { await fn(); } catch (err) { setError(errorText(err)); } finally { setBusy(''); } };
  const readConnection = async () => {
    const nextStatus = await window.mkFigure.providerStatus('codex');
    setStatus(nextStatus);
    if (nextStatus.available && nextStatus.authenticated) {
      const found = await window.mkFigure.listModels('codex');
      setModels(found);
      setMessage(`已连接 · ${found.length} 个可用模型`);
    }
  };
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const nextStatus = await window.mkFigure.providerStatus('codex');
        if (!active) return;
        setStatus(nextStatus);
        if (nextStatus.available && nextStatus.authenticated) {
          const found = await window.mkFigure.listModels('codex');
          if (active) setModels(found);
        }
      } catch (err) { if (active) setError(errorText(err)); }
      finally { if (active) setBusy(''); }
    })();
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!efforts.length || efforts.includes(draft.reasoningEffort)) return;
    setDraft(prev => ({ ...prev, reasoningEffort: efforts.includes('medium') ? 'medium' : efforts[0] }));
  }, [selectedModel, draft.reasoningEffort]);
  const test = () => void action('检测连接', async () => { await save(); await readConnection(); });
  const login = () => void action('等待 Codex 登录', async () => {
    await save(); const nextStatus = await window.mkFigure.loginCodex(); setStatus(nextStatus);
    if (nextStatus.authenticated) { setModels(await window.mkFigure.listModels('codex')); setMessage('已登录'); }
  });

  return <div className="modal-backdrop"><section className="dialog settings-dialog codex-settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <div className="dialog-header"><h2 id="settings-title">模型与连接</h2><button className="icon-button" aria-label="关闭设置" disabled={!!busy} onClick={onClose}><X size={20}/></button></div>
    <p className="dialog-intro">Codex 账户 · 生成、复刻与精修共用以下设置。</p>
    <fieldset className="provider-content codex-content" disabled={!!busy}>
      <div className="connection-actions"><Button icon={ExternalLink} onClick={login}>登录 Codex 账户</Button><Button icon={RefreshCw} onClick={test}>检测连接与模型</Button></div>
      {status && <div className={`connection-status ${connected ? 'connected' : ''}`}>{connected ? <CheckCircle2 size={17}/> : <AlertCircle size={17}/>}<span><strong>{status.label}</strong>{!connected && <small>{status.detail}</small>}</span></div>}
      <div className="field-row model-settings-row"><Field label="文本 / 视觉模型"><select value={config.model} onChange={e => selectModel(e.target.value)}><option value="">账户默认模型</option>{config.model && !models.some(model => model.id === config.model) && <option value={config.model}>{config.model}</option>}{models.map(model => <option key={model.id} value={model.id}>{model.name || model.id}{model.isDefault ? '（默认）' : ''}</option>)}</select></Field><Field label="推理强度"><select value={draft.reasoningEffort} disabled={!efforts.length} onChange={e => setDraft({ ...draft, reasoningEffort: e.target.value })}>{efforts.length ? efforts.map(effort => <option key={effort} value={effort}>{reasoningLabel(effort)} · {effort}</option>) : <option value={draft.reasoningEffort}>{reasoningLabel(draft.reasoningEffort)} · 待检测</option>}</select></Field></div>
      {!efforts.length && <p className="field-help">检测连接后可读取此模型支持的推理强度。</p>}
      <details className="advanced-settings"><summary>高级设置</summary><Field label="自定义模型 ID"><input placeholder="留空使用账户默认模型" value={config.model} onChange={e => selectModel(e.target.value)} spellCheck={false}/></Field><Field label="Codex 程序位置" hint="选填"><input placeholder="自动检测" value={config.codexPath || ''} onChange={e => updateConfig({ codexPath: e.target.value })}/></Field></details>
    </fieldset>
    {error && <div className="dialog-message error-message"><AlertCircle size={16}/><span>{error}</span></div>}{message && <div className="dialog-message notice-message"><CheckCircle2 size={16}/><span>{message}</span></div>}{busy && <div className="dialog-busy"><LoaderCircle size={16} className="spin"/>{busy}…</div>}
    <div className="dialog-footer"><span><ShieldCheck size={14}/>使用 Codex 账户额度</span><Button onClick={onClose} disabled={!!busy}>关闭</Button><Button variant="primary" icon={Check} disabled={!!busy} onClick={() => void action('保存设置', async () => { await save(); onClose(); })}>保存设置</Button></div>
  </section></div>;
}
