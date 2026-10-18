import { describe, expect, it } from 'vitest';
import { WorkspaceRegistry } from '../src/main/workspace-manager';

describe('six workspaces in one native window',()=>{
  it('starts with six fixed workspace slots',()=>{
    const registry=new WorkspaceRegistry();
    expect(registry.ids()).toEqual([1,2,3,4,5,6]);
    expect(registry.info(3)).toEqual({id:3,max:6});
    for(const id of [0,7,-1,1.5,NaN])expect(()=>registry.claim(id,'a')).toThrow();
  });
  it('keeps project ownership isolated between panes',()=>{
    const registry=new WorkspaceRegistry();registry.claim(1,'a');registry.claim(2,'b');
    expect(()=>registry.claim(2,'a')).toThrow('另一个子窗口');
    expect(registry.project(2)).toBe('b');expect(registry.owner('a')).toBe(1);
    registry.claim(1,'c');expect(registry.owner('a')).toBeUndefined();
    registry.claim(2,'a');expect(registry.owner('a')).toBe(2);
  });
  it('releasing one pane preserves all other workspaces and fixed slots',()=>{
    const registry=new WorkspaceRegistry();for(const id of registry.ids())registry.claim(id,`p${id}`);
    registry.release(3);expect(registry.owner('p3')).toBeUndefined();
    expect(registry.project(2)).toBe('p2');expect(registry.project(4)).toBe('p4');
    expect(registry.ids()).toHaveLength(6);registry.claim(3,'new');expect(registry.project(3)).toBe('new');
  });
  it('requires a scoped envelope and validates pane IDs before dispatch',()=>{
    const registry=new WorkspaceRegistry();
    expect(registry.request({paneId:5,args:['project']})).toEqual({paneId:5,args:['project']});
    for(const input of [null,undefined,[],{},'project',{paneId:0,args:[]},{paneId:7,args:[]},{paneId:1.5,args:[]},{paneId:'1',args:[]},{paneId:1,args:{}}])expect(()=>registry.request(input)).toThrow('无效');
  });
});
