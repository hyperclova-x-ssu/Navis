import type { Displacement, ErrorCode, FeatureDefinition, GridSpec, LayoutIntent, LayoutResult, Panel } from '../contracts';
export { screenPresets, selectScreenPreset } from './presets';

const copy=(panels:readonly Panel[]):readonly Panel[]=>Object.freeze(panels.map(p=>Object.freeze({...p})));
export const comparePosition=(a:Panel,b:Panel):number=>a.row-b.row||a.column-b.column||(a.featureId<b.featureId?-1:a.featureId>b.featureId?1:0);
export const readingOrder=(panels:readonly Panel[]):readonly Panel[]=>[...panels].sort(comparePosition);
export const isCellSpan=(value:number):boolean=>Number.isInteger(value)&&value>=1&&value<=4;
export function cellMask(p:Pick<Panel,'column'|'row'|'width'|'height'>,grid:GridSpec):bigint {
  let mask=0n;const rowBits=(1n<<BigInt(p.width))-1n;
  for(let y=0;y<p.height;y++)mask|=rowBits<<BigInt((p.row+y)*grid.columns+p.column);
  return mask;
}
export function layoutResult(panels:readonly Panel[],grid:GridSpec,code?:ErrorCode,status:LayoutResult['status']=code?'rejected':'accepted',displacements:readonly Displacement[]=[]):LayoutResult {
  const usedCells=panels.reduce((sum,p)=>sum+p.width*p.height,0);
  return Object.freeze({status,valid:!code||code==='DUPLICATE'&&status==='unchanged',panels:copy(panels),displacements:Object.freeze(displacements.map(d=>Object.freeze({...d,from:Object.freeze({...d.from}),to:Object.freeze({...d.to})}))),usedCells,remainingCells:grid.columns*grid.rows-usedCells,...(code?{code}:{})});
}
/** Validate the supplied coordinates; validation NEVER packs or repairs a snapshot. */
export function evaluate(panels:readonly Panel[],grid:GridSpec,catalog:readonly FeatureDefinition[]):LayoutResult {
  if(!Number.isSafeInteger(grid.columns)||!Number.isSafeInteger(grid.rows)||grid.columns<=0||grid.rows<=0||grid.columns*grid.rows>40)throw new RangeError('Grid must have 1..40 cells');
  const seen=new Set<string>();let occupied=0n;
  for(const p of panels){
    if(!catalog.some(f=>f.id===p.featureId))return layoutResult(panels,grid,'UNKNOWN_FEATURE');
    if(seen.has(p.featureId))return layoutResult(panels,grid,'DUPLICATE');seen.add(p.featureId);
    if(!isCellSpan(p.width)||!isCellSpan(p.height))return layoutResult(panels,grid,'INVALID_SIZE');
    if(!Number.isInteger(p.column)||!Number.isInteger(p.row)||p.column<0||p.row<0)return layoutResult(panels,grid,'INVALID_POSITION');
    if(p.column+p.width>grid.columns||p.row+p.height>grid.rows)return layoutResult(panels,grid,'OUTSIDE_GRID');
    const mask=cellMask(p,grid);if(mask&occupied)return layoutResult(panels,grid,'INVALID_POSITION');occupied|=mask;
  }
  return layoutResult(panels,grid);
}
interface Collision { readonly before:readonly Panel[]; readonly requested:Panel; readonly others:readonly Panel[]; readonly grid:GridSpec }
function prepare(before:readonly Panel[],intent:LayoutIntent,grid:GridSpec,catalog:readonly FeatureDefinition[]):LayoutResult|Collision {
  const current=evaluate(before,grid,catalog);
  const reject=(code:ErrorCode)=>layoutResult(before,grid,code);
  if(!current.valid)return reject('INTERNAL_LAYOUT_ERROR');
  if(intent.type==='restore'){
    const restored=evaluate(intent.panels,grid,catalog);
    return restored.valid?layoutResult(intent.panels,grid,undefined,samePanels(before,intent.panels)?'unchanged':'accepted'):reject(restored.code!);
  }
  if(intent.type==='starter'){
    if(before.length)return {...current,status:'unchanged'};
    if(intent.featureIds.length!==3||new Set(intent.featureIds).size!==3)return reject('INVALID_POSITION');
    const panels=intent.featureIds.map((featureId,column)=>({featureId,column,row:0,width:1,height:1}));
    const checked=evaluate(panels,grid,catalog);return checked.valid?checked:reject(checked.code!);
  }
  if(!catalog.some(f=>f.id===intent.featureId))return reject('UNKNOWN_FEATURE');
  const old=before.find(p=>p.featureId===intent.featureId);
  const adding=intent.type==='add-tap'||intent.type==='add-drop'||intent.type==='add-ai'||intent.type==='add-candidate-tap';
  if(adding&&old)return {...current,status:'unchanged',code:'DUPLICATE',existingFeatureId:old.featureId};
  if(!adding&&!old)return {...current,status:'unchanged'};
  if(intent.type==='remove')return layoutResult(before.filter(p=>p.featureId!==intent.featureId),grid);
  const others=before.filter(p=>p.featureId!==intent.featureId);
  let requested:Panel;
  if(intent.type==='add-tap'){
    const occupied=others.reduce((mask,p)=>mask|cellMask(p,grid),0n);
    let index=0;while(index<grid.columns*grid.rows&&(occupied&(1n<<BigInt(index))))index++;
    if(index===grid.columns*grid.rows)return reject('NO_CAPACITY');
    requested={featureId:intent.featureId,column:index%grid.columns,row:Math.floor(index/grid.columns),width:1,height:1};
  }else if(intent.type==='add-candidate-tap'){
    const valid=isCellSpan(intent.width)&&isCellSpan(intent.height),width=valid?intent.width:1,height=valid?intent.height:1;
    const occupied=others.reduce((mask,p)=>mask|cellMask(p,grid),0n);let position:{column:number;row:number}|undefined;
    for(let row=0;row<=grid.rows-height&&!position;row++)for(let column=0;column<=grid.columns-width;column++)if(!(cellMask({column,row,width,height},grid)&occupied)){position={column,row};break;}
    if(!position)return reject('NO_CAPACITY');requested={featureId:intent.featureId,...position,width,height,condition:intent.condition};
  }else if(intent.type==='add-ai')requested={featureId:intent.featureId,column:intent.column,row:intent.row,width:intent.width,height:intent.height,condition:intent.condition};
  else if(intent.type==='add-drop')requested={featureId:intent.featureId,column:intent.column,row:intent.row,width:1,height:1};
  else if(intent.type==='move')requested={...old!,column:intent.column,row:intent.row};
  else requested={...old!,width:intent.width,height:intent.height};
  const checked=evaluate([requested],grid,catalog);if(!checked.valid)return reject(checked.code!);
  if(old&&samePanel(old,requested))return {...current,status:'unchanged'};
  const candidate=old?before.map(p=>p.featureId===old.featureId?requested:p):[...before,requested];
  if(candidate.reduce((sum,p)=>sum+p.width*p.height,0)>grid.columns*grid.rows)return reject('NO_CAPACITY');
  const mask=cellMask(requested,grid);
  if(!others.some(p=>(cellMask(p,grid)&mask)!==0n))return layoutResult(candidate,grid);
  return {before,requested,others,grid};
}
const samePanel=(a:Panel,b:Panel)=>a.featureId===b.featureId&&a.column===b.column&&a.row===b.row&&a.width===b.width&&a.height===b.height&&JSON.stringify(a.condition??{kind:'default'})===JSON.stringify(b.condition??{kind:'default'});
export function samePanels(a:readonly Panel[],b:readonly Panel[]):boolean {return a.length===b.length&&a.every(p=>b.some(q=>samePanel(p,q)));}
/** Cheap synchronous paths only. null means a Worker must resolve the collision. */
export function fastPreview(before:readonly Panel[],intent:LayoutIntent,grid:GridSpec,catalog:readonly FeatureDefinition[]):LayoutResult|null {
  const prepared=prepare(before,intent,grid,catalog);return 'status' in prepared?prepared:null;
}
interface Anchor { readonly column:number; readonly row:number; readonly mask:bigint }
const anchorCache=new Map<string,readonly Anchor[]>();
function anchors(width:number,height:number,grid:GridSpec):readonly Anchor[]{
  const key=`${grid.columns}:${grid.rows}:${width}:${height}`;const cached=anchorCache.get(key);if(cached)return cached;
  const out:Anchor[]=[];
  for(let row=0;row<=grid.rows-height;row++)for(let column=0;column<=grid.columns-width;column++)out.push({column,row,mask:cellMask({column,row,width,height},grid)});
  // At most the 16 shapes of the two real grids plus diagnostic grids.
  if(anchorCache.size>=128)anchorCache.delete(anchorCache.keys().next().value!);
  anchorCache.set(key,out);return out;
}
/** v4 page send (ARCHITECTURE 11.4-9): the completely empty width×height rectangle closest to (column,row) by Manhattan distance, ties by row then column; null if none. Pure, page-agnostic. */
export function nearestEmptyRect(panels:readonly Panel[],grid:GridSpec,width:number,height:number,column:number,row:number):{readonly column:number;readonly row:number}|null {
  if(!isCellSpan(width)||!isCellSpan(height)||width>grid.columns||height>grid.rows)return null;
  const occupied=panels.reduce((mask,p)=>mask|cellMask(p,grid),0n);
  let best:Anchor|null=null,bestDistance=Infinity;
  for(const a of anchors(width,height,grid)){
    if((a.mask&occupied)!==0n)continue;
    const distance=Math.abs(a.column-column)+Math.abs(a.row-row);
    if(distance<bestDistance)[best,bestDistance]=[a,distance]; // anchors are already in row, column order
  }
  return best?{column:best.column,row:best.row}:null;
}
/** A resumable exact search. Yield boundaries have no influence on candidate order. */
export function* resolve(before:readonly Panel[],intent:LayoutIntent,grid:GridSpec,catalog:readonly FeatureDefinition[]):Generator<void,LayoutResult,void>{
  const prepared=prepare(before,intent,grid,catalog);if('status' in prepared)return prepared;
  const {requested,others}=prepared;
  const originals=[...others].sort(comparePosition);
  const originalMasks=originals.map(p=>cellMask(p,grid));
  const requestedMask=cellMask(requested,grid);
  const failed=new Set<string>();const packingFailed=new Set<string>();
  const requestedKey=`${requested.featureId}:${requested.column},${requested.row},${requested.width},${requested.height}`;
  // Exact packing is a NECESSARY feasibility test for unfixed panels. Stationary
  // positions are relaxed only here; the ordered policy search below retains them.
  function* canPack(panels:readonly Panel[],fixed:bigint):Generator<void,boolean,void>{
    const groups=new Map<string,{width:number;height:number;count:number;options:readonly Anchor[]}>();
    for(const p of panels){const key=`${p.width}x${p.height}`;const g=groups.get(key);if(g)g.count++;else groups.set(key,{width:p.width,height:p.height,count:1,options:anchors(p.width,p.height,grid)});}
    const shapes=[...groups.values()].sort((a,b)=>b.width*b.height-a.width*a.height||b.height-a.height||b.width-a.width);
    // All rectangles taller than half the board must occupy disjoint columns.
    if(panels.filter(p=>p.height>grid.rows/2).reduce((n,p)=>n+p.width,0)>grid.columns||panels.filter(p=>p.width>grid.columns/2).reduce((n,p)=>n+p.height,0)>grid.rows)return false;
    const signature=shapes.map(s=>`${s.width}x${s.height}:${s.count}`).join(',');
    function* pack(index:number,count:number,start:number,taken:bigint):Generator<void,boolean,void>{
      yield;
      if(index===shapes.length)return true;
      if(!count)return yield* pack(index+1,shapes[index+1]?.count??0,0,taken);
      if(shapes[index].width===1&&shapes[index].height===1)return true; // area invariant holds throughout
      const key=`${signature}/${index}/${count}/${start}/${taken}`;
      if(packingFailed.has(key))return false;
      // A remaining rectangle with no possible anchor is an impossibility proof.
      for(let i=index;i<shapes.length;i++)if(!shapes[i].options.some(a=>(a.mask&taken)===0n)){packingFailed.add(key);return false;}
      const options=shapes[index].options;
      for(let i=start;i<options.length;i++)if((options[i].mask&taken)===0n&& (yield* pack(index,count-1,i+1,taken|options[i].mask)))return true;
      packingFailed.add(key);return false;
    }
    return yield* pack(0,shapes[0]?.count??0,0,fixed);
  }
  const pending:number[]=[],stationary:number[]=[];
  originals.forEach((_,i)=>((originalMasks[i]&requestedMask)!==0n?pending:stationary).push(i));
  interface Solution { panels:readonly Panel[]; displacements:readonly Displacement[] }
  function* search(todo:readonly number[],still:readonly number[],fixed:readonly Panel[],fixedMask:bigint,causes:ReadonlyMap<number,Panel['featureId']>,displacements:readonly Displacement[]):Generator<void,Solution|null,void>{
    yield;
    if(!todo.length)return {panels:[requested,...fixed,...still.map(i=>originals[i])],displacements};
    const key=`${requestedKey}|${fixed.map(p=>`${p.featureId}:${p.column},${p.row}`).sort().join(';')}|s:${still.map(i=>`${originals[i].featureId}:${originals[i].column},${originals[i].row}`).join(';')}|u:${todo.map(i=>`${originals[i].featureId}:${originals[i].width}x${originals[i].height}`).join(';')}`;
    if(failed.has(key))return null;
    if(!(yield* canPack([...todo,...still].map(i=>originals[i]),fixedMask))){failed.add(key);return null;}
    const [id,...rest]=todo;const p=originals[id];
    const options=anchors(p.width,p.height,grid).filter(a=>(a.mask&fixedMask)===0n).sort((a,b)=>(Math.abs(a.column-p.column)+Math.abs(a.row-p.row))-(Math.abs(b.column-p.column)+Math.abs(b.row-p.row))||a.row-b.row||a.column-b.column);
    const occupied=still.reduce((mask,i)=>mask|originalMasks[i],0n);
    const empty=options.filter(a=>(a.mask&occupied)===0n),blocked=options.filter(a=>(a.mask&occupied)!==0n);
    for(const a of [...empty,...blocked]){
      yield;
      const pushed=still.filter(i=>(originalMasks[i]&a.mask)!==0n);
      const nextStill=still.filter(i=>!pushed.includes(i));
      const nextTodo=[...rest,...pushed].sort((a,b)=>a-b); // originals already use row,column,id order
      const nextCauses=new Map(causes);for(const i of pushed)nextCauses.set(i,p.featureId);
      const moved={...p,column:a.column,row:a.row};
      const displacement:Displacement={featureId:p.featureId,from:{column:p.column,row:p.row},to:{column:a.column,row:a.row},causeFeatureId:causes.get(id)!};
      const answer=yield* search(nextTodo,nextStill,[...fixed,moved],fixedMask|a.mask,nextCauses,[...displacements,displacement]);
      if(answer)return answer;
    }
    failed.add(key);return null;
  }
  const solution=yield* search(pending,stationary,[],requestedMask,new Map(pending.map(i=>[i,requested.featureId])),[]);
  if(!solution)return layoutResult(before,grid,'NO_CAPACITY');
  const byId=new Map(solution.panels.map(p=>[p.featureId,p]));
  const panels=before.map(p=>byId.get(p.featureId)!);if(!before.some(p=>p.featureId===requested.featureId))panels.push(requested);
  return layoutResult(panels,grid,undefined,'accepted',solution.displacements.filter(d=>d.from.column!==d.to.column||d.from.row!==d.to.row));
}
/** Synchronous reference/dev API. Product collisions use the resumable Worker. */
export function preview(before:readonly Panel[],intent:LayoutIntent,grid:GridSpec,catalog:readonly FeatureDefinition[]):LayoutResult {
  const iterator=resolve(before,intent,grid,catalog);let step=iterator.next();while(!step.done)step=iterator.next();return step.value;
}
export function commit(candidate:LayoutResult,baseRevision:number,currentRevision:number):LayoutResult {
  return baseRevision===currentRevision?candidate:{...candidate,status:'rejected',valid:false,code:'STALE_REVISION'};
}
