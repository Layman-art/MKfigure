export const sourceBrowserScript = String.raw`
const pdfBase = location.origin+'/assets/';
function canvasFor(w,h,maxScale=4) {
  if (!(w>0 && h>0) || Math.max(w,h)>90000) throw Error('页面或图片尺寸超出可预览范围。');
  const scale=Math.min(maxScale,1900/Math.max(w,h));
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
      const out=canvasFor(x1-x0,y1-y0);canvas=out.canvas;
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
      const w=Math.max(...images.map(im=>im.naturalWidth));
      const fontSize=Math.max(14,Math.ceil(w/43));
      const heights=images.map((im,i)=>im.naturalHeight+(job.panels[i].label?Math.ceil(fontSize*1.65):0));
      const gap=Math.max(6,Math.ceil(w/65));
      const out=canvasFor(w,heights.reduce((a,b)=>a+b,0)+gap*(images.length-1));
      canvas=out.canvas;
      const ctx=canvas.getContext('2d');
      ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.scale(out.scale,out.scale);
      ctx.font=fontSize+'px Georgia,serif';ctx.textAlign='center';ctx.fillStyle='#222';
      let y=0;
      for(let i=0;i<images.length;i++){
        const im=images[i];
        ctx.drawImage(im,(w-im.naturalWidth)/2,y);
        if(job.panels[i].label)ctx.fillText(job.panels[i].label,w/2,y+im.naturalHeight+fontSize,w-4);
        y+=heights[i]+gap;
      }
    } finally {for(const url of urls)URL.revokeObjectURL(url);}
  } else {
    const image=new Image();
    const objectUrl=URL.createObjectURL(new Blob([await response.arrayBuffer()],{type:job.mime}));
    try {
      image.src=objectUrl; await image.decode();
      if(image.naturalWidth*image.naturalHeight>36e6) throw Error('原图像素数超过预览限制。');
      const out=canvasFor(image.naturalWidth,image.naturalHeight,job.mime==='image/svg+xml'?4:1);canvas=out.canvas;
      const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(image,0,0,canvas.width,canvas.height);
    } finally {URL.revokeObjectURL(objectUrl);}
  }
  const jpeg=canvas.toDataURL('image/jpeg',0.94);
  const png=canvas.toDataURL('image/png');
  // Line art and text often fit in a smaller, lossless PNG.
  return (png.length<=jpeg.length*1.1?png:jpeg).split(',')[1];
};
`;
