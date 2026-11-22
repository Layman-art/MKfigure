import type { Asset, FigureLayoutPlan } from '../../shared/types';
import { MAX_CONTENT_IMAGES, selectedContentImages } from '../../shared/figure-inputs';
import './figure-inputs.css';

interface Props {
  sources: Asset[];
  ids?: string[];
  layout?: FigureLayoutPlan;
  style?: {name:string; citation?:{id:string}};
  onChange: (ids:string[])=>void;
}

export default function GenerationInputs({sources,ids,layout,style,onChange}:Props) {
  const images=sources.filter(asset=>asset.kind==='image');
  const selected=selectedContentImages(sources,ids).map(asset=>asset.id);
  const layouts=layout?.referenceIds||[];
  const distinctStyle=style && !(style.citation && layouts.includes(style.citation.id));
  const count=selected.length + layouts.length + Number(Boolean(distinctStyle));
  if(!images.length && !layouts.length && !distinctStyle) return null;
  return <details className="generation-inputs"><summary>本次传给模型的图片 <span>{count} 张</span></summary>
    {images.length>0 && <fieldset><legend>内容依据 · {selected.length}/{MAX_CONTENT_IMAGES}</legend>
      <p>选中的图片提供设备、连接、标签和数值依据。</p>
      {images.map(asset=><label key={asset.id}><input type="checkbox" checked={selected.includes(asset.id)}
        disabled={!selected.includes(asset.id)&&selected.length>=MAX_CONTENT_IMAGES}
        onChange={e=>onChange(e.target.checked?[...selected,asset.id]:selected.filter(id=>id!==asset.id))}/>
        {asset.previewUrl&&<img alt="" src={asset.previewUrl}/>}<span>{asset.name}</span></label>)}
    </fieldset>}
    {!!layouts.length&&<div><strong>版式参考</strong><ul>{layouts.map(id=><li key={id}>{layout?.citations?.find(c=>c.id===id)?.title||id}</li>)}</ul></div>}
    {distinctStyle&&<div><strong>风格参考</strong><p>{style.name}</p></div>}
  </details>;
}
