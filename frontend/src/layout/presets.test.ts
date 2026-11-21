import { describe,expect,it } from 'vitest';
import { screenPresets,selectScreenPreset } from './presets';
import { getCatalog,getBusinessPreset } from '../catalog';
import { evaluate,preview,cellMask } from './index';
import type { Panel } from '../contracts';
describe('first positive CSS viewport selection',()=>{
  it.each([[1920,1080,'A'],[2400,1200,'B'],[2399,1440,'A'],[2560,1199,'A'],[2560,1260,'B'],[3840,2160,'B'],[800,600,'A']] as const)('%s by %s selects %s',(width,height,id)=>expect(selectScreenPreset({width,height})).toBe(screenPresets[id]));
  it.each([[0,1080],[1920,0],[-1,1200],[Infinity,1200],[NaN,1200]])('waits for a positive viewport %s %s',(width,height)=>expect(selectScreenPreset({width,height})).toBeNull());
  it('freezes both grid definitions without separate feature size policies',()=>{
    expect(screenPresets.A.grid).toEqual({columns:6,rows:4});expect(screenPresets.B.grid).toEqual({columns:8,rows:5});
    expect(Object.isFrozen(screenPresets.B.grid)).toBe(true);
  });
});
describe.each(['A','B'] as const)('%s actual public coordinates',id=>{
  const grid=screenPresets[id].grid,catalog=getCatalog(id);
  it.each(['cafe','restaurant','pub','beauty','retail','academy','fitness','other','general'] as const)('%s starts at row0 column0/1/2',business=>{
    const ids=getBusinessPreset(business).starterIds;
    expect(preview([],{type:'starter',featureIds:ids},grid,catalog).panels).toEqual(ids.map((featureId,column)=>({featureId,column,row:0,width:1,height:1})));
  });
  it('uses the last cell including bits32..39 and refuses to overlap another snapshot',()=>{
    const panels:readonly Panel[]=[{featureId:'ledger',column:0,row:0,width:4,height:4},{featureId:'calendar',column:4,row:0,width:grid.columns-4,height:4},...(id==='B'?[{featureId:'tax' as const,column:0,row:4,width:4,height:1},{featureId:'margin' as const,column:4,row:4,width:4,height:1}]:[])];
    expect(evaluate(panels,grid,catalog)).toMatchObject({valid:true,remainingCells:0,usedCells:id==='A'?24:40});
    expect(preview(panels,{type:'add-tap',featureId:'grants'},grid,catalog)).toMatchObject({code:'NO_CAPACITY',panels});
    const bit=cellMask({column:grid.columns-1,row:grid.rows-1,width:1,height:1},grid);
    expect(bit).toBe(1n<<BigInt(id==='A'?23:39));
    expect(evaluate([...panels,{featureId:'grants',column:0,row:0,width:1,height:1}],grid,catalog).code).toBe('INVALID_POSITION');
  });
});
