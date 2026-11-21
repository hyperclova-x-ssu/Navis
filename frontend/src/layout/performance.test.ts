import { describe,expect,it } from 'vitest';
import type { Panel } from '../contracts';
import { getCatalog } from '../catalog';
import { preview,evaluate } from './index';
import { referenceResolve } from './dev/reference';
import { backtrackingCorpus } from './dev/corpus';
import { screenPresets } from './presets';
const catalog=getCatalog('A');
describe('independent small-board exhaustive reference',()=>{
  it.each(backtrackingCorpus())('$presetId $name backtracks and finds the same first complete answer for either input order',fixture=>{
    const {grid}=screenPresets[fixture.presetId],before=fixture.beforePanels,intent=fixture.intent;
    if(intent.type!=='resize')throw new Error('Resize fixture required');
    const requested={...before.find(p=>p.featureId===intent.featureId)!,width:intent.width,height:intent.height};
    const reference=referenceResolve(before,requested,grid);
    expect(reference.stats.backtracks).toBeGreaterThan(0);expect(reference.stats.chainSteps).toBeGreaterThan(0);
    const actual=preview(before,intent,grid,getCatalog(fixture.presetId));
    expect(actual.panels).toEqual(reference.panels);expect(actual.status).toBe('accepted');
    const reordered=preview([...before].reverse(),intent,grid,getCatalog(fixture.presetId));
    expect([...reordered.panels].sort((a,b)=>a.featureId.localeCompare(b.featureId))).toEqual([...actual.panels].sort((a,b)=>a.featureId.localeCompare(b.featureId)));
    expect(reordered.displacements).toEqual(actual.displacements);
  });
  it('agrees on every legal two-panel source in a 3 by 2 board and every target cell',()=>{
    const grid={columns:3,rows:2};let checked=0;
    for(const [w1,h1] of [[1,1],[2,1],[1,2]])for(const [w2,h2] of [[1,1],[2,1],[1,2]])
      for(let a=0;a<6;a++)for(let b=0;b<6;b++){
        const before:readonly Panel[]=[{featureId:'ledger',column:a%3,row:Math.floor(a/3),width:w1,height:h1},{featureId:'calendar',column:b%3,row:Math.floor(b/3),width:w2,height:h2}];
        if(!evaluate(before,grid,catalog).valid)continue;
        for(let target=0;target<6;target++){
          const column=target%3,row=Math.floor(target/3);
          for(const type of ['add-drop','move'] as const){
            const featureId:Panel['featureId']=type==='move'?'ledger':'margin';
            const requested=type==='move'?{...before[0],column,row}:{featureId,column,row,width:1,height:1};
            const reference=referenceResolve(before,requested,grid),actual=preview(before,{type,featureId,column,row},grid,catalog);
            expect(actual.valid).toBe(reference.panels!==null);if(reference.panels)expect(actual.panels).toEqual(reference.panels);
            checked++;
          }
        }
      }
    expect(checked).toBe(1296);
  });
  it('agrees on seeded mixed 4 by 3 sources including resize backtracking and chained moves',()=>{
    let seed=8157,checked=0,backtracks=0,chains=0;
    const next=(max:number)=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return Math.floor(seed/4294967296*max);};
    const grid={columns:4,rows:3};
    for(let i=0;i<500;i++){
      const before:Panel[]=[];
      for(const f of catalog.slice(0,5)){
        const p={featureId:f.id,column:next(4),row:next(3),width:1+next(2),height:1+next(2)};
        if(evaluate([...before,p],grid,catalog).valid)before.push(p);
      }
      if(!before.length)continue;
      const requested={...before[0],width:1+next(3),height:1+next(3)};
      const reference=referenceResolve(before,requested,grid),actual=preview(before,{type:'resize',featureId:requested.featureId,width:requested.width,height:requested.height},grid,catalog);
      expect(actual.valid).toBe(reference.panels!==null);if(reference.panels)expect(actual.panels).toEqual(reference.panels);
      backtracks+=reference.stats.backtracks;chains+=reference.stats.chainSteps;checked++;
    }
    expect(checked).toBeGreaterThan(400);expect(backtracks).toBeGreaterThan(0);expect(chains).toBeGreaterThan(0);
  });
});
