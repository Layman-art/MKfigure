import { Images, X } from 'lucide-react';

export default function ReferencePicker({ name, onOpen, onClear }: { name?: string; onOpen: () => void; onClear: () => void }) {
  return <div className="field reference-picker">
    <div className="field-title">风格参考<span>选填</span></div>
    <div className="reference-selection">
      <Images size={19}/>
      <span title={name}>{name || '未选择参考图'}</span>
      {name && <button type="button" className="icon-button" aria-label="清除风格参考" title="清除" onClick={onClear}><X size={14}/></button>}
      <button type="button" className="text-button" onClick={onOpen}>从素材库选择</button>
    </div>
  </div>;
}
