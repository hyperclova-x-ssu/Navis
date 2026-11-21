import type { GridSpec, Panel } from '../../contracts';
/** Independent cell-array reference; no production masks, pruning, cache or solver. */
export function referenceResolve(before:readonly Panel[],requested:Panel,grid:GridSpec){
  const originals=before.filter(p=>p.featureId!==requested.featureId).sort((a,b)=>a.row-b.row||a.column-b.column||(a.featureId<b.featureId?-1:1));
  const cells=(p:Panel):number[]=>Array.from({length:p.height},(_,y)=>Array.from({length:p.width},(_,x)=>(p.row+y)*grid.columns+p.column+x)).flat();
  const overlaps=(a:Panel,b:Panel)=>cells(a).some(cell=>cells(b).includes(cell));
  const stats={branches:0,backtracks:0,chainSteps:0};
  function search(pending:readonly Panel[],stationary:readonly Panel[],fixed:readonly Panel[]):readonly Panel[]|null {
    if(!pending.length)return [...fixed,...stationary];
    const [p,...rest]=[...pending].sort((a,b)=>a.row-b.row||a.column-b.column||(a.featureId<b.featureId?-1:1));
    const candidates:Panel[]=[];
    for(let row=0;row<=grid.rows-p.height;row++)for(let column=0;column<=grid.columns-p.width;column++){
      const q={...p,column,row};if(!fixed.some(f=>overlaps(f,q)))candidates.push(q);
    }
    candidates.sort((a,b)=>Math.abs(a.column-p.column)+Math.abs(a.row-p.row)-Math.abs(b.column-p.column)-Math.abs(b.row-p.row)||a.row-b.row||a.column-b.column);
    const empty=candidates.filter(q=>!stationary.some(f=>overlaps(f,q))),occupied=candidates.filter(q=>stationary.some(f=>overlaps(f,q)));
    for(const q of [...empty,...occupied]){
      stats.branches++;
      const pushed=stationary.filter(f=>overlaps(f,q));if(pushed.length)stats.chainSteps++;
      const result=search([...rest,...pushed],stationary.filter(f=>!pushed.includes(f)),[...fixed,q]);
      if(result)return result;stats.backtracks++;
    }
    return null;
  }
  if(requested.column<0||requested.row<0||requested.column+requested.width>grid.columns||requested.row+requested.height>grid.rows)return {panels:null,stats};
  if([...originals,requested].reduce((n,p)=>n+p.width*p.height,0)>grid.columns*grid.rows)return {panels:null,stats};
  const result=search(originals.filter(p=>overlaps(p,requested)),originals.filter(p=>!overlaps(p,requested)),[requested]);
  const order=[...before.map(p=>p.featureId),...(!before.some(p=>p.featureId===requested.featureId)?[requested.featureId]:[])];
  return {panels:result?order.map(id=>result.find(p=>p.featureId===id)!):null,stats};
}
