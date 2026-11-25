export const sourceBrowserScript = String.raw`
const pdfBase = location.origin+'/assets/';
function canvasFor(w,h,maxScale=1) {
  if (!(w>0 && h>0) || Math.max(w,h)>90000) throw Error('页面或图片尺寸超出可预览范围。');
  const scale=Math.min(maxScale,2800/Math.max(w,h));
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(w*scale));canvas.height=Math.max(1,Math.round(h*scale));
  return {canvas,scale};
}
globalThis.renderGallerySource=async function(job) {
  const response=await fetch('/payload/'+job.token);
  if (!response.ok) throw Error('图源数据不可用。');
  let canvas;
  if (job.kind==='pdf'){
    const lib=await import('/assets/build/pdf.min.mjs');
    lib.GlobalWorkerOptions.workerSrc=pdfBase+'build/pdf.worker.min.mjs';
    const task=lib.getDocument({data:new Uint8Array(await response.arrayBuffer()),cMapUrl:pdfBase+'cmaps/',cMapPacked:true,
      standardFontDataUrl:pdfBase+'standard_fonts/',wasmUrl:pdfBase+'wasm/',iccUrl:pdfBase+'iccs/',
      maxImageSize:36e6,isEvalSupported:false,enableXfa:false,disableRange:true,disableStream:true,disableAutoFetch:true,
      useSystemFonts:true,useWasm:true});
    task.onPassword=()=>task.destroy().catch(()=>{});
    try{
      const doc=await task.promise;
      if(job.page>doc.numPages) throw Error('图源版本的页码不匹配。');
      const page=await doc.getPage(job.page), size=page.getViewport({scale:1});
      const [x0,y0,x1,y1]=job.crop;
      if(x1>size.width+0.5 || y1>size.height+0.5) throw Error('图源裁框超出页面，请核对原版页码。');
      const out=canvasFor(x1-x0,y1-y0,9);canvas=out.canvas;
      await page.render({canvas,viewport:page.getViewport({scale:out.scale}),transform:[1,0,0,1,-x0*out.scale,-y0*out.scale],annotationMode:0,background:'#ffffff'}).promise;
    }finally{await task.destroy();}
  } else if (job.kind==='panels') {
    const bytes=await response.arrayBuffer();
    const images=[], urls=[];
    let offset=0, pixelCount=0;
    try {
      for (const panel of job.panels) {
        const objectUrl=URL.createObjectURL(new Blob([bytes.slice(offset,offset+panel.length)],{type:panel.mime}));
        urls.push(objectUrl);
        offset+=panel.length;
        const image=new Image();
        image.src=objectUrl;
        await image.decode();
        pixelCount+=image.naturalWidth*image.naturalHeight;
        if(pixelCount>36e6) throw Error('原图面板像素数超过预览限制。');
        images.push(image);
      }
      const panels=images.map((image,i)=>{
        const panel=job.panels[i];
        const w=panel.width || image.naturalWidth;
        // Keep the source aspect ratio inside the author's declared layout box.
        const h=panel.height || image.naturalHeight;
        const fit=Math.min(w/image.naturalWidth,h/image.naturalHeight);
        return {image,w,h,drawW:image.naturalWidth*fit,drawH:image.naturalHeight*fit,label:panel.label,svg:panel.mime==='image/svg+xml'};
      });
      const rows=[];
      let cursor=0;
      for(const count of job.rows){rows.push(panels.slice(cursor,cursor+count));cursor+=count;}
      const rowWidth=row=>row.reduce((sum,p)=>sum+p.w,0);
      const bodyWidth=Math.max(...rows.map(rowWidth));
      const gap=Math.max(4,bodyWidth/78),font=Math.max(9,bodyWidth/52);
      const width=Math.max(...rows.map(row=>rowWidth(row)+(row.length-1)*gap));
      const labelContext=document.createElement('canvas').getContext('2d');
      labelContext.font=font+'px Georgia,serif';
      for(const p of panels){
        const lines=[];
        if(p.label)for(const word of p.label.split(/\s+/)){
          if(lines.length && labelContext.measureText(lines.at(-1)+' '+word).width<p.w-4) lines[lines.length-1]+=' '+word;
          else lines.push(word);
        }
        p.lines=lines;
      }
      const heights=rows.map(row=>Math.max(...row.map(p=>p.h))+Math.max(...row.map(p=>p.lines.length))*font*1.25);
      const height=heights.reduce((sum,n)=>sum+n,0)+(rows.length-1)*gap;
      const nativeScale=Math.min(9,...panels.filter(p=>!p.svg).map(p=>p.image.naturalWidth/p.drawW));
      const out=canvasFor(width,height,nativeScale);canvas=out.canvas;
      const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.scale(out.scale,out.scale);ctx.font=font+'px Georgia,serif';ctx.textAlign='center';ctx.fillStyle='#222';
      let y=0;
      for(let i=0;i<rows.length;i++){
        const row=rows[i],imageHeight=Math.max(...row.map(p=>p.h));
        let x=(width-rowWidth(row)-(row.length-1)*gap)/2;
        for(const p of row){
          ctx.drawImage(p.image,x+(p.w-p.drawW)/2,y+(imageHeight-p.drawH)/2,p.drawW,p.drawH);
          p.lines.forEach((line,j)=>ctx.fillText(line,x+p.w/2,y+imageHeight+(j+1)*font*1.25,p.w-2));
          x+=p.w+gap;
        }
        y+=heights[i]+gap;
      }
    } finally {for(const url of urls)URL.revokeObjectURL(url);}
  } else {
    const blob=new Blob([await response.arrayBuffer()],{type:job.mime});
    let bitmap, objectUrl;
    try {
      let image;
      if(job.mime==='image/png'){
        const header=new DataView(await blob.slice(16,24).arrayBuffer());
        const w=header.getUint32(0),h=header.getUint32(4);
        if(!w || !h || w*h>160e6 || Math.max(w,h)>90000) throw Error('原图像素数超过预览限制。');
        if(w*h>36e6){
          canvas=canvasFor(w,h).canvas;
          bitmap=await createImageBitmap(blob,{resizeWidth:canvas.width,resizeHeight:canvas.height,resizeQuality:'high'});
          image=bitmap;
        }
      }
      if(!image){
        objectUrl=URL.createObjectURL(blob);
        image=new Image();image.src=objectUrl;await image.decode();
        if(image.naturalWidth*image.naturalHeight>36e6) throw Error('原图像素数超过预览限制。');
        canvas=canvasFor(image.naturalWidth,image.naturalHeight,job.mime==='image/svg+xml'?4:1).canvas;
      }
      const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(image,0,0,canvas.width,canvas.height);
    } finally {bitmap?.close();if(objectUrl)URL.revokeObjectURL(objectUrl);}
  }
  const jpeg=canvas.toDataURL('image/jpeg',0.94);
  const png=canvas.toDataURL('image/png');
  // Line art and text often fit in a smaller, lossless PNG.
  return (png.length<=jpeg.length*1.1?png:jpeg).split(',')[1];
};
`;
