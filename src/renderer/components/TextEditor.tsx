import { Save, X } from 'lucide-react';
import type { FigureScene } from '../../shared/types';
import { Button } from './Controls';

type Props = {
  scene: FigureScene;
  busy: boolean;
  onChange: (scene: FigureScene) => void;
  onClose: () => void;
  onSave: () => void;
};

export default function TextEditor({ scene, busy, onChange, onClose, onSave }: Props) {
  const updateText = (id: string, text: string) => onChange({
    ...scene,
    elements: scene.elements.map(item => item.id === id && item.type === 'text' ? { ...item, text } : item),
  });

  return <div className="modal-backdrop">
    <section className="dialog text-dialog" role="dialog" aria-modal="true" aria-labelledby="text-editor-title">
      <div className="dialog-header">
        <div><h2 id="text-editor-title">编辑图中文字</h2></div>
        <button className="icon-button" aria-label="关闭文字编辑" disabled={busy} onClick={onClose}><X size={20}/></button>
      </div>
      <p className="dialog-intro">保留位置与字体；改字后请检查排版。</p>
      <div className="text-edit-list">
        {scene.elements.filter(element => element.type === 'text').map(element => <label key={element.id}>
          <span>{element.role === 'formula' ? '公式' : '文字'} · {element.id}</span>
          <input value={element.text} onChange={event => updateText(element.id, event.target.value)}/>
        </label>)}
      </div>
      <div className="dialog-footer">
        <Button onClick={onClose} disabled={busy}>取消</Button>
        <Button variant="primary" icon={Save} onClick={onSave} disabled={busy}>保存并更新预览</Button>
      </div>
    </section>
  </div>;
}
