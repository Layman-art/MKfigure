import { contextBridge, ipcRenderer } from 'electron';
import type { AppSettings, DesktopApi, ProgressEvent, WorkspaceApi } from '../shared/types';
import { PANE_COUNT } from '../shared/types';
const call=(paneId:number,method:string,...args:unknown[])=>ipcRenderer.invoke(`mk:${method}`,{paneId,args});
function workspace(paneId:number):WorkspaceApi {
  const invoke=(method:string,...args:unknown[])=>call(paneId,method,...args);
  return {
    bootstrap:()=>invoke('bootstrap'),releaseProject:(...a)=>invoke('releaseProject',...a),
    getFolder:()=>invoke('getFolder'),openFolder:(...a)=>invoke('openFolder',...a),closeFolder:()=>invoke('closeFolder'),saveSharedStyle:(...a)=>invoke('saveSharedStyle',...a),setSharedReference:(...a)=>invoke('setSharedReference',...a),optimizeStyle:(...a)=>invoke('optimizeStyle',...a),cancelStyle:()=>invoke('cancelStyle'),getModelCatalog:(...a)=>invoke('getModelCatalog',...a),
    onFolderChanged(callback) { const handler=()=>callback();ipcRenderer.on('mk:folder-changed',handler);return()=>ipcRenderer.removeListener('mk:folder-changed',handler); },
    createProject:(...a)=>invoke('createProject',...a),openProject:(...a)=>invoke('openProject',...a),saveProject:(...a)=>invoke('saveProject',...a),deleteProject:(...a)=>invoke('deleteProject',...a),
    listLibrary:()=>invoke('listLibrary'),importLibraryFiles:(...a)=>invoke('importLibraryFiles',...a),updateLibraryItem:(...a)=>invoke('updateLibraryItem',...a),deleteLibraryItem:(...a)=>invoke('deleteLibraryItem',...a),getLibraryPreview:(...a)=>invoke('getLibraryPreview',...a),exportLibraryItem:(...a)=>invoke('exportLibraryItem',...a),selectLibraryReference:(...a)=>invoke('selectLibraryReference',...a),
    importFiles:(...a)=>invoke('importFiles',...a),saveSettings:(...a)=>invoke('saveSettings',...a),providerStatus:(...a)=>invoke('providerStatus',...a),loginCodex:()=>invoke('loginCodex'),listModels:(...a)=>invoke('listModels',...a),run:(...a)=>invoke('run',...a),cancelRun:(...a)=>invoke('cancelRun',...a),renderScene:(...a)=>invoke('renderScene',...a),exportProject:(...a)=>invoke('exportProject',...a),revealFile:(...a)=>invoke('revealFile',...a),
    onProgress(callback) { const handler=(_:unknown,payload:{paneId:number;event:ProgressEvent})=>{if(payload.paneId===paneId)callback(payload.event);};ipcRenderer.on('mk:progress',handler);return()=>ipcRenderer.removeListener('mk:progress',handler); },
    onSettingsChanged(callback) { const handler=(_:unknown,settings:AppSettings)=>callback(settings);ipcRenderer.on('mk:settings-changed',handler);return()=>ipcRenderer.removeListener('mk:settings-changed',handler); },
  };
}
const panes=Array.from({length:PANE_COUNT},(_,index)=>workspace(index+1));
const api:DesktopApi={...panes[0],panes,
  finishWindowClose:()=>call(1,'finishWindowClose'),cancelWindowClose:()=>call(1,'cancelWindowClose'),
  onWindowCloseRequested(callback) { const handler=()=>callback();ipcRenderer.on('mk:window-close-requested',handler);return()=>ipcRenderer.removeListener('mk:window-close-requested',handler); },
};
contextBridge.exposeInMainWorld('mkFigure',api);
