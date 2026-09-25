/** Canonicalize redundant dimensions without changing line endpoints/direction. */
export function normalizeSceneInput(input: unknown): unknown {
  if(!input || typeof input!=='object')return input;
  const root=structuredClone(input) as Record<string,any>;
  const scene=root.scene && !root.elements && typeof root.scene==='object'?root.scene:root;
  const numeric=(obj:Record<string,any>,keys:string[])=>{for(const key of keys)if(typeof obj[key]==='string'&&obj[key].trim()!==''&&Number.isFinite(Number(obj[key])))obj[key]=Number(obj[key]);};
  numeric(scene,['version','width','height']);
  if(Array.isArray(scene.elements))for(const e of scene.elements){
    if(!e||typeof e!=='object')continue;
    numeric(e,['x','y','w','h','x2','y2','fontSize','strokeWidth','radius','opacity','rotation']);
    if(e.type==='line'&&['x','y','x2','y2'].every(k=>typeof e[k]==='number'&&Number.isFinite(e[k]))){e.w=Math.abs(e.x2-e.x);e.h=Math.abs(e.y2-e.y);}
  }
  return scene;
}
