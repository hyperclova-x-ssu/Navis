import type { LayoutIntent,Panel,ScreenPresetId } from '../../contracts';
import { getCatalog } from '../../catalog';
import { screenPresets } from '../presets';
export interface CorpusCase { readonly name:string; readonly presetId:ScreenPresetId; readonly beforePanels:readonly Panel[]; readonly intent:LayoutIntent }
export const corpusSeed=0x5eed1815;
/** Independent legal-source generator: simple occupied cell arrays, no solver calls. */
export function makeCorpus(presetId:ScreenPresetId,count=6000,seed=corpusSeed):readonly CorpusCase[]{
  const {grid}=screenPresets[presetId],catalog=getCatalog(presetId);let state=seed;
  const next=(max:number)=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return Math.floor(state/4294967296*max);};
  const cases:CorpusCase[]=[];
  for(let sample=0;sample<count;sample++){
    const shuffled=[...catalog];for(let i=shuffled.length-1;i>0;i--){const j=next(i+1);[shuffled[i],shuffled[j]]=[shuffled[j],shuffled[i]];}
    const panels:Panel[]=[],occupied=new Set<number>(),wanted=1+next(22);
    for(const f of shuffled.slice(0,wanted))for(let attempt=0;attempt<12;attempt++){
      const width=attempt>5?1:1+next(4),height=attempt>5?1:1+next(4),column=next(grid.columns-width+1),row=next(grid.rows-height+1);
      const cells=Array.from({length:height},(_,y)=>Array.from({length:width},(_,x)=>(row+y)*grid.columns+column+x)).flat();
      if(cells.some(c=>occupied.has(c)))continue;
      panels.push({featureId:f.id,column,row,width,height});cells.forEach(c=>occupied.add(c));break;
    }
    const selected=panels[next(panels.length)],free=shuffled.find(f=>!panels.some(p=>p.featureId===f.id));
    let intent:LayoutIntent;
    if(sample%3===0&&free)intent={type:'add-drop',featureId:free.id,column:next(grid.columns),row:next(grid.rows)};
    else if(sample%3===1)intent={type:'move',featureId:selected.featureId,column:next(grid.columns),row:next(grid.rows)};
    else intent={type:'resize',featureId:selected.featureId,width:1+next(4),height:1+next(4)};
    cases.push({name:`seed-${sample}`,presetId,beforePanels:panels,intent});
  }
  return cases;
}
const b:readonly Panel[]=[{featureId:'ledger',column:0,row:0,width:4,height:4},{featureId:'margin',column:4,row:0,width:1,height:1},{featureId:'calendar',column:5,row:0,width:1,height:4},{featureId:'members',column:6,row:0,width:1,height:4}];
export const geometricCounterexample:CorpusCase={name:'RV-FIX-1-legal-25-to-40',presetId:'B',beforePanels:b,intent:{type:'resize',featureId:'margin',width:4,height:4}};
export function adversarialCorpus():readonly CorpusCase[]{
  const variants:CorpusCase[]=[geometricCounterexample,...backtrackingCorpus()];
  const roles=['ledger','margin','calendar','members'] as const;
  for(let shift=1;shift<4;shift++)variants.push({...geometricCounterexample,name:`shape-failure-role-${shift}`,beforePanels:b.map((p,i)=>({...p,featureId:roles[(i+shift)%4]})),intent:{type:'resize',featureId:roles[(1+shift)%4],width:4,height:4}});
  for(const presetId of ['A','B'] as const){
    const {columns,rows}=screenPresets[presetId].grid;
    const full:Panel[]=[{featureId:'ledger',column:0,row:0,width:4,height:4},{featureId:'calendar',column:4,row:0,width:columns-4,height:4},...(rows===5?[{featureId:'tax' as const,column:0,row:4,width:4,height:1},{featureId:'margin' as const,column:4,row:4,width:4,height:1}]:[])];
    variants.push({name:'saturated-add',presetId,beforePanels:full,intent:{type:'add-drop',featureId:'grants',column:columns-1,row:rows-1}});
    variants.push({name:'saturated-swap',presetId,beforePanels:full,intent:{type:'move',featureId:'ledger',column:columns-4,row:0}});
    variants.push({name:'last-cell',presetId,beforePanels:[{featureId:'ledger',column:0,row:0,width:1,height:1}],intent:{type:'move',featureId:'ledger',column:columns-1,row:rows-1}});
  }
  return variants;
}
/** Legal A/B fixtures whose closest empty candidates fail before a complete answer. */
export function backtrackingCorpus():readonly CorpusCase[]{
  const variants:CorpusCase[]=[];
  const sources:readonly (readonly Panel[])[]=[
    [{featureId:'briefing',column:0,row:1,width:1,height:1},{featureId:'ledger',column:1,row:2,width:2,height:1},{featureId:'tax',column:3,row:0,width:1,height:1},{featureId:'grants',column:1,row:1,width:2,height:1}],
    [{featureId:'briefing',column:1,row:1,width:1,height:1},{featureId:'ledger',column:2,row:2,width:2,height:1},{featureId:'tax',column:2,row:0,width:1,height:2},{featureId:'grants',column:0,row:0,width:2,height:1}],
    [{featureId:'ledger',column:0,row:1,width:1,height:1},{featureId:'margin',column:1,row:0,width:2,height:1},{featureId:'tax',column:1,row:1,width:2,height:1},{featureId:'grants',column:3,row:1,width:1,height:2}],
  ];
  for(const presetId of ['A','B'] as const)for(let i=0;i<sources.length;i++){
    const right=presetId==='A'?2:4,bottom=presetId==='A'?1:2;
    const walls:readonly Panel[]=[{featureId:'manuals',column:4,row:0,width:right,height:3},{featureId:'voice-booking',column:0,row:3,width:4,height:bottom},{featureId:'members',column:4,row:3,width:right,height:bottom}];
    variants.push({name:`backtracking-chain-${i}`,presetId,beforePanels:[...sources[i],...walls],intent:{type:'resize',featureId:sources[i][0].featureId,width:i===1?2:3,height:2}});
  }
  return variants;
}
