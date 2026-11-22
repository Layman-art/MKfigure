import { useEffect, useId, useRef, useState } from 'react';
import type { PointerEvent } from 'react';
import { X } from 'lucide-react';
import type { Asset, LocalEditRegion } from '../../shared/types';
import './ImageRegionPicker.css';

export type RegionTarget = Pick<Asset, 'id' | 'previewUrl' | 'width' | 'height'>;
type Bounds = Pick<LocalEditRegion, 'x' | 'y' | 'width' | 'height'>;
type Point = { x: number; y: number };
type Frame = { left: number; top: number; width: number; height: number };

export function sourcePoint(clientX: number, clientY: number, frame: Frame, width: number, height: number): Point {
  return {
    x: Math.max(0, Math.min(width, (clientX - frame.left) * width / frame.width)),
    y: Math.max(0, Math.min(height, (clientY - frame.top) * height / frame.height)),
  };
}
export function draggedBounds(start: Point, end: Point, width: number, height: number): Bounds {
  const x = Math.min(width - 1, Math.floor(Math.min(start.x, end.x)));
  const y = Math.min(height - 1, Math.floor(Math.min(start.y, end.y)));
  return { x, y, width: Math.max(1, Math.ceil(Math.max(start.x, end.x)) - x), height: Math.max(1, Math.ceil(Math.max(start.y, end.y)) - y) };
}
export function validBounds(b: Bounds, width: number, height: number) {
  return [b.x, b.y, b.width, b.height].every(Number.isSafeInteger) && b.x >= 0 && b.y >= 0 &&
    b.width > 0 && b.height > 0 && b.x + b.width <= width && b.y + b.height <= height;
}

export default function ImageRegionPicker({ target, previous, onApply, onClose }: {
  target: RegionTarget; previous?: LocalEditRegion; onApply: (value: LocalEditRegion) => void; onClose: () => void;
}) {
  const width = target.width!, height = target.height!;
  const [box, setBox] = useState<Bounds | undefined>(previous);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const drag = useRef<{ pointerId: number; start: Point; previous?: Bounds } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  const point = (e: PointerEvent<HTMLDivElement>) => sourcePoint(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect(), width, height);
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === e.pointerId) setBox(draggedBounds(drag.current.start, point(e), width, height));
  };
  const fields = [['x','左边距'], ['y','上边距'], ['width','宽度'], ['height','高度']] as const;
  const usable = !!box && validBounds(box, width, height);
  return <dialog ref={dialog} className="mk-region-dialog" aria-labelledby={titleId}
    onCancel={e => { e.preventDefault(); onClose(); }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="mk-region-body">
      <header><h2 id={titleId}>框选修改区域</h2><button type="button" className="icon-button" aria-label="关闭选区" onClick={onClose}><X size={18}/></button></header>
      <p>在原图上拖动选框，或输入像素坐标。原点在左上角，原图 {width} × {height} 像素。</p>
      <div className="mk-region-stage">
        <div className="mk-region-frame" data-testid="image-region-frame" style={{ width: 'min(100cqw, '+(100*width/height)+'cqh)', aspectRatio: width+' / '+height }}
          onPointerDown={e => {
            if (!loaded || !e.isPrimary || e.button !== 0) return;
            e.preventDefault(); const start = point(e); drag.current = { pointerId:e.pointerId, start, previous:box };
            e.currentTarget.setPointerCapture(e.pointerId); setBox(draggedBounds(start, start, width, height));
          }}
          onPointerMove={move} onPointerUp={e => { if (drag.current?.pointerId !== e.pointerId) return; move(e); drag.current = null; }}
          onPointerCancel={e => { if (drag.current?.pointerId === e.pointerId) { setBox(drag.current.previous); drag.current = null; } }}>
          <img src={target.previewUrl} alt="待框选的原图" draggable={false} onLoad={() => setLoaded(true)} onError={() => setFailed(true)}/>
          {usable && <span className="mk-region-box" style={{left:100*box.x/width+'%', top:100*box.y/height+'%', width:100*box.width/width+'%', height:100*box.height/height+'%'}}/>}
        </div>
      </div>
      {failed && <p role="alert">当前预览无法读取，请关闭后重新打开原图。</p>}
      <div className="mk-region-fields">{fields.map(([key, label]) => <label key={key}>{label}<input type="number" step={1} min={key === 'x' || key === 'y' ? 0 : 1} max={key === 'x' ? width-1 : key === 'y' ? height-1 : key === 'width' ? width : height}
        value={box && Number.isFinite(box[key]) ? box[key] : ''} onChange={e => setBox({x:0,y:0,width:1,height:1,...box,[key]:e.target.valueAsNumber})}/></label>)}</div>
      {box && !usable && <p role="alert">请输入完整整数坐标，所选区域须在原图以内。</p>}
      <footer><button type="button" className="button" onClick={onClose}>取消</button><button type="button" className="button accent" disabled={!loaded || !usable} onClick={() => { if (usable) onApply({...box,targetId:target.id}); }}>使用此选区</button></footer>
    </div>
  </dialog>;
}
