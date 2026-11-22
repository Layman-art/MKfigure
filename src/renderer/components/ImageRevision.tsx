import { useEffect, useState } from 'react';
import ImageRegionPicker, { type RegionTarget } from './ImageRegionPicker';
import { WandSparkles } from 'lucide-react';
import type { LocalEditRegion, RunAction } from '../../shared/types';
import { Button, Field } from './Controls';

export type ImageRevisionMode = 'direct' | 'feedback';
export default function ImageRevision({ target, mode, useOriginal, instruction, onMode, onOriginal, onInstruction, onRun }: {
  target?: RegionTarget;
  mode: ImageRevisionMode;
  useOriginal: boolean;
  instruction: string;
  onMode: (mode: ImageRevisionMode) => void;
  onOriginal: (value: boolean) => void;
  onInstruction: (value: string) => void;
  onRun: (action: RunAction, instruction: string, region?: LocalEditRegion) => void;
}) {
  const [region, setRegion] = useState<LocalEditRegion>();
  const [editing, setEditing] = useState<string>();
  useEffect(() => {
    setRegion(undefined);
    setEditing(undefined);
  }, [target?.id]);
  const activeRegion = region && region.targetId === target?.id ? region : undefined;
  const canPick = !!target?.previewUrl && !!target.width && !!target.height && (mode === 'feedback' || useOriginal);
  const action = mode === 'feedback' ? 'refine-image' : useOriginal ? 'edit-image' : 'regenerate-image';
  const label = mode === 'feedback' ? '按意见改图' : useOriginal ? '修改当前图' : '按提示词重画';
  return <section className="image-revision" aria-label="修改视觉稿">
    <div className="field-title">继续改图</div>
    <div className="image-revision-modes" role="group" aria-label="改图方式">
      <button type="button" aria-pressed={mode === 'direct'} onClick={() => onMode('direct')}>直接提示词</button>
      <button type="button" aria-pressed={mode === 'feedback'} onClick={() => onMode('feedback')}>按改进意见</button>
    </div>
    {mode === 'direct' && <div className="image-revision-inputs" role="group" aria-label="是否使用当前图片">
      <label><input type="radio" name="image-revision-source" checked={useOriginal} onChange={() => onOriginal(true)}/>修改当前图</label>
      <label><input type="radio" name="image-revision-source" checked={!useOriginal} onChange={() => onOriginal(false)}/>不带原图重新生成</label>
    </div>}
    {canPick && <div className="mk-region-tools" role="group" aria-label="修改范围">
      <span>{activeRegion ? '选区 '+activeRegion.width+' × '+activeRegion.height+' 像素' : '当前范围：整张图'}</span>
      <button type="button" className="text-button" onClick={() => setEditing(target!.id)}>{activeRegion ? '重新框选' : '框选局部修改'}</button>
      {activeRegion && <button type="button" className="text-button" onClick={() => setRegion(undefined)}>改为整图</button>}
    </div>}
    {canPick && editing === target?.id && target && <ImageRegionPicker key={target.id} target={target} previous={activeRegion} onClose={() => setEditing(undefined)} onApply={value => {setRegion(value); setEditing(undefined);}}/>}
    <Field label={mode === 'direct' ? '修改提示词' : '改进意见'}>
      <textarea aria-label={mode === 'direct' ? '修改提示词' : '改进意见'} rows={4} maxLength={20000}
        placeholder={mode === 'feedback' ? '例如：信息太挤，希望突出主流程，公式再清楚一些。' : useOriginal ? '例如：标题改为 Neural ODE，增大公式，其余布局保持不变。' : '描述新的图：内容、文字、布局和配色。'}
        value={instruction} onChange={event => onInstruction(event.target.value)}/>
    </Field>
    <p className="image-revision-hint">{activeRegion && canPick
      ? mode === 'feedback' ? 'AI 只查看选区裁片和改进意见，整理指令后修改选区。' : '只发送选区裁片和你的提示词，修改后贴回原图。'
      : mode === 'feedback' ? 'AI 先整理意见，再修改当前图。' : useOriginal ? '当前图＋你的提示词，直接改图。' : '仅使用新提示词，不发送当前图。'}不附加旧风格参考。</p>
    <Button variant="accent" icon={WandSparkles} disabled={!instruction.trim()} onClick={() => onRun(action, instruction.trim(), canPick ? activeRegion : undefined)}>{label}</Button>
  </section>;
}
