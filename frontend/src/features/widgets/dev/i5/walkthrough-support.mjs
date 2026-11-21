import assert from 'node:assert/strict';

/** Runs in the page, against the scroller containing the grid being measured. */
export function sortScrollerMetrics(){
 const grid=document.querySelector('[role="grid"]'),scroller=grid?.closest('.ui-data-grid__scroll');
 if(!scroller)throw new Error('grid scroller 없음');
 const style=getComputedStyle(scroller),borders=(parseFloat(style.borderLeftWidth)||0)+(parseFloat(style.borderRightWidth)||0);
 return {scrollHeight:scroller.scrollHeight,clientHeight:scroller.clientHeight,scrollbarWidth:Math.max(0,scroller.offsetWidth-scroller.clientWidth-borders)};
}
export function assertSortScroller(metrics){
 assert.ok(metrics.scrollHeight>metrics.clientHeight,`grid scroller가 스크롤되지 않음: ${metrics.scrollHeight}/${metrics.clientHeight}`);
 assert.ok(metrics.scrollbarWidth>0,`classic scrollbar 폭이 없음: ${metrics.scrollbarWidth}`);
}
export function perfVerdict(cases,startLoad,endLoad){
 const valid=startLoad[0]<=2&&endLoad[0]<=2;
 return {valid,passed:valid&&cases.length>0&&cases.every(r=>r.status==='passed')};
}
export const emptyStart=(page,click=locator=>locator.click())=>click(page.getByRole('button',{name:/^빈 화면으로 시작하기/}));
export const restockCommands=rows=>rows.filter(r=>r.needsRestock||r.outOfStock).map(r=>({type:'inventory.updateItem',itemId:r.itemId,stock:(r.restockThreshold??0)+10}));
export async function recoverDashboard(page){
 await page.evaluate(()=>window.__i5StopCapture?.());
 // Escape first respects in-dialog editors and SidePanels. The root action closes remaining overlays.
 for(let i=0;i<8;i++){
  if(!await page.evaluate(()=>window.__rootI5.run.getState().templateTour?.status==='active')){
   await page.keyboard.press('Escape');await page.waitForTimeout(260);
  }
  if(await page.evaluate(()=>window.__rootI5.run.getState().overlay.type==='none'))break;
  await page.evaluate(()=>window.__rootI5.run.actions.closeOverlay());await page.waitForTimeout(260);
 }
 assert.equal(await page.evaluate(()=>window.__rootI5.run.getState().overlay.type),'none','복귀 overlay 닫기 실패');
 await page.evaluate(()=>window.__rootI5.run.actions.switchLayer('management'));
 assert.equal(await page.evaluate(()=>window.__rootI5.run.getState().layer),'management','대시보드 복귀 실패');
 assert.equal(await page.evaluate(()=>window.__rootI5.run.getState().screen),'dashboard','대시보드 화면 복귀 실패');
}
export async function openSortDetail(page,feature){
 const opened=await page.evaluate(feature=>feature==='closing'?window.__rootI5.run.actions.openClosing('app-closing'):window.__rootI5.run.actions.openDetailRef({featureId:'members',view:'list'},'app-closing'),feature);
 assert.equal(opened,true,`${feature} 상세 열기 실패`);await page.getByRole('dialog').waitFor();
}
export async function checkReceiptCandidate(page){
 await page.getByRole('tab',{name:'지출',exact:true}).click();
 const text=await page.evaluate(()=>{
  const heading=[...document.querySelectorAll('[role="dialog"] h3,[role="dialog"] h4,section h3,section h4')].find(e=>e.textContent.trim()==='확인할 지출 후보');
  return heading?.closest('section')?.innerText??heading?.closest('section')?.textContent??null;
 });
 assert.ok(text,'확인할 지출 후보 영역 없음');assert.match(text,/28,000|2\.8만/);return text;
}
export function assertSortChanged(before,after,feature){
 assert.notEqual(after.sort,before.sort,`${feature} 정렬 상태가 바뀌지 않음`);
 assert.ok(['ascending','descending'].includes(after.sort),`${feature} 정렬 방향 누락`);
 assert.notDeepEqual(after.ids,before.ids,`${feature} 행 순서가 바뀌지 않음`);
}
export function sortState(selector){
 const button=document.querySelector(selector);if(!button)throw new Error('정렬 버튼 없음');
 const grid=button.closest('[role="grid"]');return {sort:button.closest('[role="columnheader"]').getAttribute('aria-sort'),ids:[...grid.querySelectorAll('[data-grid-row]')].map(e=>e.getAttribute('data-grid-row'))};
}
export async function measureSortSamples(page,selector,scroller){
 assertSortScroller(scroller);
 const samples=[],changes=[];
 for(let i=0;i<30;i++){
  const before=await page.evaluate(sortState,selector);
  samples.push(await page.evaluate(selector=>new Promise(resolve=>{const start=performance.now();document.querySelector(selector).click();requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)));}),selector));
  const after=await page.evaluate(sortState,selector);changes.push({before,after});
 }
 return {samples,changes};
}
