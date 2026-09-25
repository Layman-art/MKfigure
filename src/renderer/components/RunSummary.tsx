import { useEffect, useState } from 'react';
import { Clock3 } from 'lucide-react';
import type { RunMetrics, TokenUsage } from '../../shared/types';
import { reasoningLabel } from '../display';

const RUN_LABELS = { analyze: '整理资料', prompt: '优化提示词', generate: '生成图片', 'edit-image': '修改图片', 'regenerate-image': '按提示词重画', 'refine-image': '按意见改图', reconstruct: '可编辑复刻', review: '检查', refine: '精修' };
const STATUS_LABELS = { running: '进行中', completed: '完成', failed: '失败', cancelled: '已停止' };
const number = (value: number) => value.toLocaleString('zh-CN');

function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
function total(usage?: TokenUsage) {
  if (!usage) return undefined;
  if (usage.totalTokens != null) return usage.totalTokens;
  if (usage.inputTokens != null && usage.outputTokens != null) return usage.inputTokens + usage.outputTokens;
  return undefined;
}
function usageDetail(usage?: TokenUsage) {
  if (!usage) return 'Codex 尚未回传用量';
  return [
    usage.inputTokens != null && `输入 ${number(usage.inputTokens)}`,
    usage.cachedInputTokens != null && `其中缓存 ${number(usage.cachedInputTokens)}`,
    usage.outputTokens != null && `输出 ${number(usage.outputTokens)}`,
    usage.reasoningOutputTokens != null && `其中推理 ${number(usage.reasoningOutputTokens)}`,
  ].filter(Boolean).join(' · ') || 'Codex 未提供用量明细';
}
function Usage({ run }: { run: RunMetrics }) {
  const count = total(run.usage);
  return <span title={usageDetail(run.usage)}>{count == null ? 'Token 未回传' : `${number(count)} tokens${run.usageComplete === false ? '（部分）' : ''}`}</span>;
}

export function LiveRunSummary({ run }: { run: RunMetrics }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (run.status !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run.id, run.status]);
  const elapsed = run.status === 'running' ? Math.max(run.durationMs, now - Date.parse(run.startedAt)) : run.durationMs;
  return <span className="live-run-summary"><Clock3 size={12}/>已用 {duration(elapsed)}<i>·</i><Usage run={run}/>{run.model && <><i>·</i>{run.model} / 推理{reasoningLabel(run.reasoningEffort)}</>}</span>;
}

export default function RunSummary({ runs }: { runs?: RunMetrics[] }) {
  const completed = runs?.filter(run => run.status !== 'running').slice().reverse() || [];
  const records = completed.slice(0, 8);
  if (!records.length) return null;
  const latestFigures = [completed.find(run => ['generate', 'edit-image', 'regenerate-image', 'refine-image'].includes(run.action)), completed.find(run => run.action === 'reconstruct')].filter((run): run is RunMetrics => !!run);
  return <details className="run-history"><summary><Clock3 size={15}/><span>用量与时间</span><small>{latestFigures.length ? latestFigures.map(run => <span className="recent-run" key={run.id}>{RUN_LABELS[run.action]} · {duration(run.durationMs)} · <Usage run={run}/></span>) : `${records.length} 次操作`}</small></summary><div className="run-history-list">{records.map(run => <div className="run-history-row" key={run.id}><div><strong>{RUN_LABELS[run.action]}</strong><span className={`run-state ${run.status}`}>{STATUS_LABELS[run.status]}</span><time>{duration(run.durationMs)}</time></div><div><Usage run={run}/><small>{run.model || '模型未记录'}{run.reasoningEffort && ` · 推理${reasoningLabel(run.reasoningEffort)}`}</small></div></div>)}</div><p>缓存计入输入，推理计入输出；未回传的用量不作估算。</p></details>;
}
