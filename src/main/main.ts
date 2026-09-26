import { app, BrowserWindow, dialog, ipcMain, shell, session, screen } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, cleanBrief, safeId, safeName } from './storage';
import { addGeneratedImage, importAsset } from './assets';
import { ImageLibrary } from './library';
import { Workflow } from './workflow';
import { createProviders } from './providers';
import type { ProviderHub } from './providers';
import type { AppSettings, Asset, LibraryCategory, Project, ProviderId, Stage } from '../shared/types';

if(process.env.MK_FIGURE_DATA_DIR)app.setPath('userData',path.resolve(process.env.MK_FIGURE_DATA_DIR));
let mainWindow:BrowserWindow|null=null;let hub:ProviderHub;let workflow:Workflow;let store:Store;
let library:ImageLibrary;
const allowedReveal=new Set<string>();
const providerId=(id:ProviderId)=>{if(id!=='codex')throw new Error('当前版本仅支持 Codex');return id;};
const resources=()=>app.isPackaged?process.resourcesPath:path.resolve('resources');
async function bundledCodex() {
  const root=app.isPackaged?path.join(resources(),'codex'):path.join(resources(),'codex',`${process.platform==='win32'?'win':process.platform==='darwin'?'mac':process.platform}-${process.arch}`);
  try {const manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));const executable=path.resolve(root,manifest.executable);if(executable.startsWith(root+path.sep))return executable;}catch{ /* fallback to installed Codex */ }
  return undefined;
}
async function resetHub(){hub?.dispose();hub=createProviders({getConfig:id=>store.settings.providers.find(p=>p.id===id)!,getKey:id=>store.key(id),codexExecutable:await bundledCodex(),cwd:path.join(store.directory,'codex-work')});}
function handler(name:string,fn:(...args:any[])=>unknown){ipcMain.handle('mk:'+name,async(event,...args)=>{if(event.sender!==mainWindow?.webContents||event.senderFrame!==mainWindow.webContents.mainFrame)throw new Error('不允许的请求来源');try{return await fn(...args);}catch(e){const message=e instanceof Error?e.message:'操作失败';throw new Error(message.replace(/(Bearer\s+|sk-)[A-Za-z0-9_\-.]+/gi,'[redacted]'));}});}
async function createWindow(){
  const dev=!!process.env.MK_DEV_URL;
  const area=screen.getPrimaryDisplay().workAreaSize;
  const minWidth=Math.min(960,area.width),minHeight=Math.min(640,area.height);
  mainWindow=new BrowserWindow({width:Math.max(minWidth,Math.min(1400,area.width-48)),height:Math.max(minHeight,Math.min(920,area.height-48)),minWidth,minHeight,title:'MK Figure',backgroundColor:'#faf9f5',icon:path.join(resources(),'icon.png'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  const entryUrl=pathToFileURL(path.join(__dirname,'../renderer/index.html')).href;
  mainWindow.webContents.on('will-navigate',(event,url)=>{const allowed=dev?url.startsWith('http://127.0.0.1:5173/'):url.split(/[?#]/)[0]===entryUrl;if(!allowed)event.preventDefault();});
  session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
  session.defaultSession.webRequest.onHeadersReceived((details,callback)=>callback({responseHeaders:{...details.responseHeaders,'Content-Security-Policy':[`default-src 'self'; script-src 'self'${dev?" 'unsafe-inline'":''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'${dev?' ws://127.0.0.1:5173':''}; object-src 'none'; base-uri 'none'`]}}));
  if(dev)await mainWindow.loadURL(process.env.MK_DEV_URL!);else await mainWindow.loadFile(path.join(__dirname,'../renderer/index.html'));
  mainWindow.on('closed',()=>{mainWindow=null;});
}
app.whenReady().then(async()=>{
  store=new Store(app.getPath('userData'),resources());await store.init();await fs.mkdir(path.join(store.directory,'codex-work'),{recursive:true});await resetHub();
  library=new ImageLibrary(path.join(store.directory,'library'),resources());await library.init();
  workflow=new Workflow(store,()=>hub,event=>mainWindow?.webContents.send('mk:progress',event));
  handler('bootstrap',async()=>({settings:store.publicSettings(),projects:await store.list(),references:await store.references(),version:app.getVersion(),platform:process.platform}));
  handler('createProject',async(name:string,route:'full'|'reconstruct')=>{if(!['full','reconstruct'].includes(route))throw new Error('未知项目入口');return store.hydrate(await store.create(name,route));});
  handler('openProject',async(id:string)=>store.hydrate(await store.load(safeId(id))));
  handler('listLibrary',()=>library.list());
  handler('importLibraryFiles',async(category:LibraryCategory)=>{
    if(!['reference','icon'].includes(category))throw new Error('未知素材分类');
    const chosen=await dialog.showOpenDialog(mainWindow!,{title:category==='icon'?'导入图标':'导入参考图',properties:['openFile','multiSelections'],filters:[{name:'图片与矢量图',extensions:['png','jpg','jpeg','webp','svg']}]});
    if(chosen.canceled)return {items:await library.list(),importedIds:[],errors:[]};
    return library.importFiles(chosen.filePaths,category);
  });
  handler('updateLibraryItem',(id:string,patch:{name?:string;category?:LibraryCategory})=>library.update(id,patch));
  handler('getLibraryPreview',(id:string)=>library.preview(id));
  handler('deleteLibraryItem',async(id:string)=>{
    const item=(await library.list()).find(item=>item.id===id);
    if(!item)throw new Error('素材不存在');
    if(item.source==='builtin')throw new Error('内置素材不能删除');
    const answer=await dialog.showMessageBox(mainWindow!,{type:'warning',title:'删除素材',message:`删除“${item.name}”？`,detail:'素材将移入回收站，已有作品中的参考图副本会保留。',buttons:['取消','移入回收站'],defaultId:0,cancelId:0,noLink:true});
    if(answer.response!==1)return {deleted:false,items:await library.list()};
    await library.trash(id,directory=>shell.trashItem(directory));
    return {deleted:true,items:await library.list()};
  });
  handler('exportLibraryItem',async(id:string)=>{
    const original=await library.original(id);
    const filename=safeName(original.name);
    const chosen=await dialog.showSaveDialog(mainWindow!,{title:'导出原图',defaultPath:`${filename}.${original.extension}`,filters:[{name:original.extension.toUpperCase(),extensions:[original.extension]}]});
    if(chosen.canceled||!chosen.filePath)return {};
    if(path.extname(chosen.filePath).toLowerCase()!==`.${original.extension}`)throw new Error(`请使用 .${original.extension} 扩展名保存原图`);
    // Resolve again after the dialog: the library item may have been removed meanwhile.
    const current=await library.original(id);
    const target=path.join(await fs.realpath(path.dirname(chosen.filePath)),path.basename(chosen.filePath));
    const destination=await fs.lstat(target).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;return undefined;});
    if(destination&&(destination.isSymbolicLink()||!destination.isFile()||destination.nlink>1))throw new Error('请选择普通文件作为导出目标');
    const ownRoots=await Promise.all([store.directory,resources()].map(root=>fs.realpath(root)));
    if(ownRoots.some(root=>{const relative=path.relative(root,target);return !relative||(!relative.startsWith('..')&&!path.isAbsolute(relative));}))throw new Error('请选择软件数据目录以外的位置');
    await fs.copyFile(current.path,target);allowedReveal.add(target);return {path:target};
  });
  handler('selectLibraryReference',async(projectId:string,libraryId:string)=>{
    safeId(projectId);
    if(workflow.isRunning(projectId))throw new Error('作品正在处理，请先停止任务再更换参考图');
    const reference=await library.referenceImage(libraryId);
    const project=await store.mutate(projectId,async p=>{
      if(workflow.isRunning(projectId))throw new Error('作品正在处理，请先停止任务再更换参考图');
      const asset=await addGeneratedImage(store,projectId,{dataUrl:reference.dataUrl});
      asset.name=reference.name;
      p.customReference=asset;p.styleId=undefined;p.libraryReferenceId=libraryId;
    });return store.hydrate(project);
  });
  handler('deleteProject',async(id:string)=>{
    safeId(id);
    if(workflow.isRunning(id))throw new Error('作品正在处理，请先停止任务再删除');
    const project=await store.load(id);
    const answer=await dialog.showMessageBox(mainWindow!,{type:'warning',title:'删除作品',message:`删除“${project.name}”？`,detail:'作品及其内部素材将移入回收站，可从系统回收站恢复。',buttons:['取消','移入回收站'],defaultId:0,cancelId:0,noLink:true});
    if(answer.response!==1)return {deleted:false,projects:await store.list()};
    await workflow.deleteProject(id,directory=>shell.trashItem(directory));
    return {deleted:true,projects:await store.list()};
  });
  handler('saveProject',async(input:Project)=>{
    const refs=await store.references();
    const p=await store.mutate(safeId(input.id),p=>{
      p.name=String(input.name||'未命名科研图').slice(0,160);p.brief=cleanBrief(input.brief);
      if(Array.isArray(input.sources)){const kept=new Set(input.sources.map(s=>s.id));p.sources=p.sources.filter(s=>kept.has(s.id));}
      if(['brief','visual','reconstruct','review','export'].includes(input.stage))p.stage=input.stage as Stage;
      p.styleId=refs.some(r=>r.id===input.styleId)?input.styleId:undefined;
      if(input.target?.id && input.target.id!==p.target?.id){const found=p.generated.find(a=>a.id===input.target!.id);if(found){p.target=found;p.scene=undefined;p.qa=undefined;}}
      if(!input.customReference){p.customReference=undefined;p.libraryReferenceId=undefined;}
    });return store.hydrate(p);
  });
  handler('importFiles',async(id:string,kind:'sources'|'reference'|'target')=>{
    if(!['sources','reference','target'].includes(kind))throw new Error('未知导入类型');await store.load(safeId(id));
    const result=await dialog.showOpenDialog(mainWindow!,{title:kind==='sources'?'选择参考资料':'选择参考图片',properties:kind==='sources'?['openFile','multiSelections']:['openFile'],filters:[{name:kind==='sources'?'资料与图片':'图片',extensions:kind==='sources'?['pdf','pptx','txt','md','png','jpg','jpeg','webp']:['png','jpg','jpeg','webp']}]});
    if(result.canceled)return store.hydrate(await store.load(id));if(result.filePaths.length>20)throw new Error('一次最多选择 20 份资料');
    const assets:Asset[]=[];for(const file of result.filePaths)assets.push(await importAsset(store,id,file));
    const p=await store.mutate(id,p=>{if(kind==='sources'){if(p.sources.length+assets.length>40)throw new Error('单项目最多 40 份资料');p.sources.push(...assets);}else if(kind==='reference'){p.customReference=assets[0];p.styleId=undefined;p.libraryReferenceId=undefined;}else{p.target=assets[0];p.scene=undefined;p.qa=undefined;p.stage='reconstruct';}});return store.hydrate(p);
  });
  handler('saveSettings',async(settings:AppSettings,keys?:Partial<Record<ProviderId,string>>)=>{workflow.cancelAll();const value=await store.saveSettings(settings,keys);await resetHub();return value;});
  handler('providerStatus',(id:ProviderId)=>hub.status(providerId(id)));
  handler('loginCodex',async()=>{const result=await hub.loginCodex();if(result.loginUrl){const url=new URL(result.loginUrl);if(url.protocol!=='https:'||!['auth.openai.com','chatgpt.com','openai.com'].includes(url.hostname))throw new Error('登录服务返回了非预期地址');await shell.openExternal(result.loginUrl);}return result;});
  handler('listModels',(id:ProviderId)=>hub.listModels(providerId(id)));
  handler('run',(id:string,action:any,feedback?:string)=>workflow.run(safeId(id),action,String(feedback||'').slice(0,20000)));
  handler('cancelRun',(id:string)=>workflow.cancel(safeId(id)));
  handler('renderScene',(id:string,scene:any)=>workflow.preview(safeId(id),scene));
  handler('exportProject',async(id:string,formats:Array<'pptx'|'svg'|'png'>)=>{
    if(!Array.isArray(formats)||!formats.length||formats.some(f=>!['pptx','svg','png'].includes(f)))throw new Error('请选择有效的导出格式');
    const chosen=await dialog.showOpenDialog(mainWindow!,{title:'选择导出文件夹',properties:['openDirectory','createDirectory']});if(chosen.canceled)return {directory:'',files:[]};
    const result=await workflow.export(safeId(id),chosen.filePaths[0],formats);for(const file of [result.directory,...result.files])allowedReveal.add(path.resolve(file));return result;
  });
  handler('revealFile',async(file:string)=>{const target=path.resolve(file);if(!allowedReveal.has(target))throw new Error('只能打开本次导出的文件或文件夹');const stat=await fs.stat(target);if(stat.isDirectory())await shell.openPath(target);else shell.showItemInFolder(target);});
  await createWindow();
}).catch(error=>{dialog.showErrorBox('MK Figure 启动失败',error instanceof Error?error.message:'无法启动');app.quit();});
app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)void createWindow();});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
app.on('before-quit',()=>{workflow?.cancelAll();hub?.dispose();});
