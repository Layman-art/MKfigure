import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { FolderState, Project, RecentFolder, SharedStyle, StyleMessage } from '../shared/types';
import { Store, atomicJson } from './storage';

export const EMPTY_STYLE: SharedStyle = { prompt: '', palette: '', background: '', lines: '' };
const text = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : '';
export function cleanStyleHistory(input: unknown): StyleMessage[] {
  return Array.isArray(input) ? input.slice(-20).filter(item => item && ['user','assistant'].includes(item.role) && typeof item.text === 'string').map(item => ({role:item.role, text:item.text.slice(0,6000)})) : [];
}
export function cleanStyle(input: unknown): SharedStyle {
  const value = input as Partial<SharedStyle> | undefined;
  return { prompt:text(value?.prompt,6000), palette:text(value?.palette,1000), background:text(value?.background,1000), lines:text(value?.lines,1000), history:cleanStyleHistory(value?.history) };
}
export function styleText(style: SharedStyle) {
  return [style.prompt, style.palette && `配色：${style.palette}`, style.background && `背景：${style.background}`, style.lines && `线条与图标：${style.lines}`].filter(Boolean).join('\n');
}
interface FolderDocument { format:'mk-figure-workspace'; version:1; id:string; style:SharedStyle; }
async function normalDirectory(directory:string) {
  const info=await fs.lstat(directory);
  if(!info.isDirectory()||info.isSymbolicLink())throw new Error('工作区目录必须是普通文件夹，不能使用链接目录');
}
async function normalFile(file:string) {
  const info=await fs.lstat(file);
  if(!info.isFile()||info.isSymbolicLink()||info.nlink>1)throw new Error('工作区文件不是独立的普通文件');
}

/** Credentials and the library stay in userData; only creations live in the selected folder. */
export class FolderWorkspace {
  private currentPath?:string;
  private document!:FolderDocument;
  private metaRoot:string;
  private recent:RecentFolder[]=[];
  private writes:Promise<unknown>=Promise.resolve();
  constructor(private readonly store:Store) { this.metaRoot=store.directory; }
  async init() {
    try { const saved=JSON.parse(await fs.readFile(path.join(this.store.directory,'recent-folders.json'),'utf8')); this.recent=Array.isArray(saved)?saved.filter(item=>item&&typeof item.path==='string'&&path.isAbsolute(item.path)).slice(0,12).map(item=>({path:item.path,name:text(item.name,160)||path.basename(item.path)})):[]; } catch { /* first launch */ }
    this.document=await this.readDocument(this.store.directory,true);
  }
  private async readDocument(root:string,create:boolean):Promise<FolderDocument> {
    const file=path.join(root,'workspace.json');
    try {
      await normalFile(file);
      const value=JSON.parse(await fs.readFile(file,'utf8'));
      if(value.format!=='mk-figure-workspace'||value.version!==1||typeof value.id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(value.id))throw new Error('无法识别此 MK Figure 工作区版本');
      const style=cleanStyle(value.style);
      const ref=value.style?.reference;
      if(ref&&typeof ref.file==='string'&&/^style-[a-zA-Z0-9-]+\.png$/.test(ref.file))style.reference={name:text(ref.name,160),file:ref.file};
      style.updatedAt=text(value.style?.updatedAt,40)||undefined;
      return {...value,style};
    } catch(error) {
      if(!create||(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      const value:FolderDocument={format:'mk-figure-workspace',version:1,id:randomUUID(),style:{...EMPTY_STYLE}};
      await atomicJson(file,value);return value;
    }
  }
  async state():Promise<FolderState> {
    return {folder:{id:this.document.id,name:this.currentPath?path.basename(this.currentPath):'本地作品',path:this.currentPath,style:structuredClone(this.document.style),projects:await this.store.list()},recentFolders:structuredClone(this.recent)};
  }
  isRecent(directory:string) { return this.recent.some(item=>item.path===directory); }
  get directory() { return this.currentPath; }
  async open(directory?:string) {
    // A failed save must not prevent moving to a healthy workspace.
    await this.writes.catch(()=>undefined);
    const real=directory?await fs.realpath(directory):undefined;
    if(real)await normalDirectory(real);
    const metaRoot=real?path.join(real,'.mkfigure'):this.store.directory;
    if(real) {
      const existing=await fs.lstat(metaRoot).catch((error:NodeJS.ErrnoException)=>{if(error.code!=='ENOENT')throw error;return undefined;});
      if(existing) { await normalDirectory(metaRoot);if(!(await fs.readdir(metaRoot)).includes('workspace.json')&&(await fs.readdir(metaRoot)).length)throw new Error('此文件夹已有其他 .mkfigure 数据，未做修改'); }
      else await fs.mkdir(metaRoot);
    }
    const document=await this.readDocument(metaRoot,true);
    const projects=path.join(metaRoot,'projects');await fs.mkdir(projects,{recursive:true});await normalDirectory(projects);
    if(real) {
      const next=[{path:real,name:path.basename(real)},...this.recent.filter(item=>item.path!==real)].slice(0,12);
      await atomicJson(path.join(this.store.directory,'recent-folders.json'),next);this.recent=next;
    }
    this.currentPath=real;this.metaRoot=metaRoot;this.document=document;this.store.setProjectsDirectory(projects);
    return this.state();
  }
  async saveStyle(input:SharedStyle) {
    const task=this.writes.catch(()=>undefined).then(async()=>{
      const style={...cleanStyle(input),reference:this.document.style.reference,updatedAt:new Date().toISOString()};
      const next={...this.document,style};await atomicJson(path.join(this.metaRoot,'workspace.json'),next);this.document=next;return structuredClone(style);
    });this.writes=task;return task;
  }
  async setReference(reference?:{name:string;data:Buffer}) {
    const task=this.writes.catch(()=>undefined).then(async()=>{
      let ref:SharedStyle['reference'];
      if(reference){const file=`style-${randomUUID()}.png`;await fs.writeFile(path.join(this.metaRoot,file),reference.data,{flag:'wx'});ref={name:text(reference.name,160),file};}
      const style={...this.document.style,reference:ref,updatedAt:new Date().toISOString()};
      const next={...this.document,style};await atomicJson(path.join(this.metaRoot,'workspace.json'),next);this.document=next;return structuredClone(style);
    });this.writes=task;return task;
  }
  async effectiveProject(input:Project):Promise<Project> {
    const project=structuredClone(input);
    if(project.styleMode==='none'){project.brief.stylePrompt='';project.styleId=undefined;project.customReference=undefined;project.libraryReferenceId=undefined;}
    if(project.styleMode!=='shared')return project;
    // Capture before any await: later edits to the shared profile affect only subsequent requests.
    const style=structuredClone(this.document.style),root=this.metaRoot;
    project.brief.stylePrompt=styleText(style);project.styleId=undefined;project.customReference=undefined;project.libraryReferenceId=undefined;
    if(style.reference) {
      const file=path.join(root,style.reference.file);await normalFile(file);
      const id=randomUUID(),destination=path.join(this.store.projectDir(project.id),'assets',`${id}.png`);
      await fs.copyFile(file,destination);
      project.customReference={id,name:style.reference.name,kind:'image',mime:'image/png',path:path.basename(destination)};
    }
    return project;
  }
}
