import { PANE_COUNT } from '../shared/types';
/** Independent workspaces hosted by the same native window. */
export class WorkspaceRegistry {
  readonly max = PANE_COUNT;
  private projects = new Map<number, string | undefined>(Array.from({length:PANE_COUNT},(_,index)=>[index+1,undefined]));
  has(id:number) { return Number.isInteger(id)&&this.projects.has(id); }
  ids() { return [...this.projects.keys()]; }
  info(id:number) { this.validate(id);return {id,max:this.max}; }
  project(id:number) { this.validate(id);return this.projects.get(id); }
  owner(projectId:string) { return this.ids().find(id=>this.projects.get(id)===projectId); }
  claim(id:number,projectId:string) { this.validate(id);const owner=this.owner(projectId);if(owner!==undefined&&owner!==id)throw new Error('该作品已在另一个子窗口打开，请在原子窗口继续编辑');this.projects.set(id,projectId); }
  release(id:number) { this.validate(id);this.projects.set(id,undefined); }
  request(value:unknown):{paneId:number;args:unknown[]} {
    if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('无效的子窗口请求');
    const request=value as Record<string,unknown>;
    if(typeof request.paneId!=='number'||!this.has(request.paneId)||!Array.isArray(request.args))throw new Error('无效的子窗口请求');
    return {paneId:request.paneId,args:request.args};
  }
  private validate(id:number) { if(!this.has(id))throw new Error(`子窗口编号必须为 1 至 ${PANE_COUNT}`); }
}
