import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, ProgressEvent } from '../shared/types';
const call=(method:string,...args:unknown[])=>ipcRenderer.invoke(`mk:${method}`,...args);
const api: DesktopApi = {
  listLibrary:()=>call('listLibrary'),importLibraryFiles:(...a)=>call('importLibraryFiles',...a),updateLibraryItem:(...a)=>call('updateLibraryItem',...a),deleteLibraryItem:(...a)=>call('deleteLibraryItem',...a),getLibraryPreview:(...a)=>call('getLibraryPreview',...a),exportLibraryItem:(...a)=>call('exportLibraryItem',...a),selectLibraryReference:(...a)=>call('selectLibraryReference',...a),
  deleteProject:(...a)=>call('deleteProject',...a),
  bootstrap:()=>call('bootstrap'),createProject:(...a)=>call('createProject',...a),openProject:(...a)=>call('openProject',...a),saveProject:(...a)=>call('saveProject',...a),importFiles:(...a)=>call('importFiles',...a),saveSettings:(...a)=>call('saveSettings',...a),providerStatus:(...a)=>call('providerStatus',...a),loginCodex:()=>call('loginCodex'),listModels:(...a)=>call('listModels',...a),run:(...a)=>call('run',...a),cancelRun:(...a)=>call('cancelRun',...a),renderScene:(...a)=>call('renderScene',...a),exportProject:(...a)=>call('exportProject',...a),revealFile:(...a)=>call('revealFile',...a),
  onProgress(callback) { const handler=(_:unknown,event:ProgressEvent)=>callback(event);ipcRenderer.on('mk:progress',handler);return()=>ipcRenderer.removeListener('mk:progress',handler); },
};
contextBridge.exposeInMainWorld('mkFigure',api);
