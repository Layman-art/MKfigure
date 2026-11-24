import { useEffect, useState } from 'react';
import type { GalleryCacheStatus, WorkspaceApi } from '../../shared/types';
import { errorText } from '../display';

export default function GalleryOffline({api,english}:{api:WorkspaceApi;english:boolean}){
  const [status,setStatus]=useState<GalleryCacheStatus>();
  const [error,setError]=useState('');
  const [installed,setInstalled]=useState(0);
  const [busy,setBusy]=useState(false);
  const complete=!!status&&status.available===status.total;
  useEffect(()=>{
    let live=true;
    const refresh=()=>api.galleryCache().then(value=>{if(live)setStatus(value);}).catch(reason=>{if(live)setError(errorText(reason));});
    void refresh();
    const timer=complete?undefined:setInterval(refresh,3000);
    return ()=>{live=false;clearInterval(timer);};
  },[api,complete]);
  const update=async(action:'start'|'stop')=>{
    setBusy(true);setError('');
    try{setStatus(await api.galleryCache(action));}catch(reason){setError(errorText(reason));}
    finally{setBusy(false);}
  };
  if(!status&&!error)return null;
  const message=english?'Available offline':'本机离线可用';
  return <div className="pg-offline">{status&&<><span>{message} · {status.available.toLocaleString()} / {status.total.toLocaleString()}</span>
    {!!status.downloadable&&<button className="pg-button" disabled={busy} onClick={()=>void update(status.running?'stop':'start')}>
      {status.running?(english?'Pause download':'暂停下载'):(english?'Cache conference originals':'缓存顶会主图')} · {status.downloadable.toLocaleString()}</button>}
    {status.available<status.total&&<button className="pg-button" disabled={busy} onClick={async()=>{
      setBusy(true);setError('');
      try {const n=await api.installGalleryArchive();if(n!==null){setInstalled(n);setStatus(await api.galleryCache());}}
      catch(reason){setError(errorText(reason));}finally{setBusy(false);}
    }}>{english?'Install open figure pack':'安装开放图包'}</button>}
    {installed>0&&<span role="status">{english?'Verified and installed':'已校验并安装'} · {installed.toLocaleString()}</span>}</>}
    {(error||status?.error)&&<span role="status">{error||status?.error}</span>}</div>;
}
