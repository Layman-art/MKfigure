import {describe,it,expect} from 'vitest';
import {normalizeSceneInput} from '../src/main/normalize';
import {validateScene,sceneToSvg} from '../src/core';
const base={version:1,width:100,height:100,title:'Line',background:'#ffffff'};
describe('AI line geometry canonicalization',()=>{
 it('preserves an upward arrow while fixing signed redundant height',()=>{
  const original={...base,elements:[{id:'up',type:'line',x:50,y:80,x2:50,y2:20,w:0,h:-60,stroke:'#000000',strokeWidth:2,arrowEnd:true}]};
  const result=validateScene(normalizeSceneInput(original));expect(result.elements[0]).toMatchObject({x:50,y:80,x2:50,y2:20,w:0,h:60});expect(original.elements[0].h).toBe(-60);expect(sceneToSvg(result)).toContain('y2="20"');
 });
 it('accepts numeric strings but never converts null or NaN into zero',()=>{
  const good={...base,width:'100',elements:[{id:'r',type:'rect',x:'0',y:0,w:20,h:20,fill:'#ffffff'}]};expect(validateScene(normalizeSceneInput(good)).width).toBe(100);
  expect(()=>validateScene(normalizeSceneInput({...good,width:null}))).toThrow();expect(()=>validateScene(normalizeSceneInput({...good,width:'NaN'}))).toThrow();
 });
 it('does not hide invalid path geometry with an absolute-value patch',()=>{
  expect(()=>validateScene(normalizeSceneInput({...base,elements:[{id:'bad',type:'path',x:0,y:0,w:20,h:-20,d:'M0 0L20 20',fill:'none'}]}))).toThrow();
 });
});
