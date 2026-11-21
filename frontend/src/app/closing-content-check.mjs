import assert from 'node:assert/strict';
import { runtime } from '../features/widgets/dev/i5/runtime.mjs';
import { emptyStart } from '../features/widgets/dev/i5/walkthrough-support.mjs';

let rt;
const report={passed:false,locales:[],sort:null};
try {
 rt=await runtime();
 const context=await rt.browser.newContext({viewport:{width:2560,height:1440},reducedMotion:'reduce'});
 const page=await context.newPage();
 await page.goto(`${rt.base}/src/app/closing-content-check.html`);
 await page.waitForSelector('.ui-root');
 await page.evaluate(async()=>{window.__rootI5=(await import('/src/app/dev/i5-root-probe.ts')).attachRootProbe();});
 await page.getByRole('button',{name:'카페',exact:true}).click();
 await page.getByRole('radio',{name:/선불형/}).click();
 await emptyStart(page);
 await page.evaluate(()=>{window.__rootI5.run.actions.skipWidgetCoaches();window.__rootI5.run.actions.acknowledgeBriefing();window.__rootI5.run.actions.setTextScale(125);});
 const grid=id=>page.locator(`[role="grid"][aria-labelledby="${id}-label"]`);
 const readCells=id=>grid(id).locator('[data-grid-column-id="content"][data-grid-row-id]').evaluateAll(cells=>Object.fromEntries(cells.map(cell=>[cell.dataset.gridRowId,cell.textContent])));
 for(const locale of ['ko','en']){
  await page.evaluate(locale=>{window.__rootI5.run.actions.setLocale(locale);window.__rootI5.run.actions.openDetailRef({featureId:'ledger'},'app-closing');},locale);
  await grid('ledger-payments').waitFor();
  const ledger=await readCells('ledger-payments');
  await page.evaluate(()=>window.__rootI5.run.actions.closeOverlay('button'));
  await page.waitForTimeout(300);
  await page.evaluate(()=>window.__rootI5.run.actions.openClosing('app-closing'));
  await grid('closing-payments').waitFor();
  const closing=await readCells('closing-payments');
  const koreanWithoutLang=await grid('closing-payments').locator('[data-grid-column-id="content"][data-grid-row-id]').evaluateAll(cells=>cells.filter(cell=>/[가-힣]/u.test(cell.textContent??'')&&!cell.querySelector('[lang="ko"]')).length);
  const differences=Object.keys(ledger).filter(id=>ledger[id]!==closing[id]);
  report.locales.push({locale,rows:Object.keys(closing).length,multiItem:closing['pay-002'],refund:closing['refund-001'],differences,koreanWithoutLang});
  assert.equal(Object.keys(closing).length,95);
  assert.equal(differences.length,0);
  assert.equal(koreanWithoutLang,0);
  if(locale==='ko'){
   assert.equal(closing['pay-002'],'카페라테 1, 크루아상 1');
   assert.equal(closing['refund-001'],'카페라테 2');
  }
  if(locale==='en'){
   const selector='[data-grid-target=\'["$header","amount"]\']';
   await page.locator(selector).focus();
   const samples=[],changes=[];
   const sortState=()=>grid('closing-payments').evaluate(table=>({sort:table.querySelector('[data-grid-target=\'["$header","amount"]\']')?.closest('th')?.getAttribute('aria-sort'),ids:[...table.querySelectorAll('[data-grid-row]')].map(row=>row.getAttribute('data-grid-row'))}));
   for(let i=0;i<30;i++){
    const before=await sortState();
    samples.push(await page.evaluate(selector=>new Promise(resolve=>{const start=performance.now();document.querySelector(selector).click();requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-start)));}),selector));
    const after=await sortState();
    changes.push({before:before.sort,after:after.sort,orderChanged:JSON.stringify(before.ids)!==JSON.stringify(after.ids)});
    assert.notEqual(after.sort,before.sort);
    assert.equal(changes.at(-1).orderChanged,true);
   }
   const sorted=[...samples].sort((a,b)=>a-b),p95=sorted[Math.ceil(samples.length*.95)-1];
   report.sort={samples,changes,p95,budgetMs:100};
   assert.ok(p95<=100,`sort p95 ${p95}ms`);
  }
  await page.evaluate(()=>window.__rootI5.run.actions.closeOverlay('button'));
  await page.waitForTimeout(300);
 }
 report.passed=true;
 await context.close();
} catch(error) {
 report.error=String(error);
 process.exitCode=1;
} finally {
 await rt?.close();
 console.log(JSON.stringify(report,null,2));
}
