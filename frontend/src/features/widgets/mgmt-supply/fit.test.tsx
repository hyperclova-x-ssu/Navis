import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act,cleanup,fireEvent,render,screen,within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { afterEach,expect,it,vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { DetailStack, SupplyPanel } from './testing';
import { useFit } from './shared';
import { shortage, supplyWeek, withRetail } from './testing-cafe';
import { createWidgetDataStore, readModel, TODAY } from '../../../data/widget-data';
import { longDate } from './testing-cafe';

const supplyCss=readFileSync('src/features/widgets/mgmt-supply/mgmt-supply.css','utf8');

afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});
// The cafe seed has nothing to restock and no open order. The 3-item key value of these panels is the screens' own shortage (milk out, beans and
// cups low) and a week of orders (milk today, beans tomorrow, cups in two days, one overdue), built with the screens' commands.
vi.setConfig({testTimeout:60_000});
const storeFor=(id:'inventory-booking'|'suppliers')=>id==='inventory-booking'?shortage(withRetail().store).store:supplyWeek().store;
const sizes=[1,2,3,4] as const;
it.each(['calendar','inventory-booking','suppliers'] as const)('%s: 마지막으로 보이는 목록 행에는 구분선이 없다',id=>{
  const {container}=renderWithKit(<><style>{supplyCss}</style><SupplyPanel id={id} width={1} height={2}/></>,{store:id==='calendar'?createWidgetDataStore():storeFor(id)});
  const rows=[...container.querySelectorAll<HTMLElement>('.ms-rows > .ms-row')];
  const entries=rows.filter(row=>row.hasAttribute('data-row-id'));
  const more=rows.find(row=>row.hasAttribute('data-more'))!;
  expect(entries.length).toBeGreaterThanOrEqual(2);
  expect(more.hidden).toBe(true);
  expect(getComputedStyle(entries.at(-1)!).borderBottomWidth).toBe('0px');
  entries.at(-1)!.hidden=true;
  expect(getComputedStyle(entries.at(-2)!).borderBottomWidth).toBe('0px');
  more.hidden=false;
  expect(getComputedStyle(entries.at(-2)!).borderBottomWidth).not.toBe('0px');
  expect(getComputedStyle(more).borderBottomWidth).toBe('0px');
});
it.each(['inventory-booking','suppliers'] as const)('%s의 16크기는 핵심값을 유지하고 넓은 표·좁은 목록을 복원한다',id=>{
  const store=storeFor(id);
  for(const height of sizes)for(const width of sizes){
    const {unmount}=renderWithKit(<SupplyPanel id={id} width={width} height={height}/>,{textScale:125,reducedMotion:true,store});
    expect(document.querySelector('.ui-metric-fit__value')).toHaveTextContent('3');
    expect(document.querySelector('.ui-metric-fit__unit')).toHaveTextContent(id==='suppliers'?'건':'개 품목');
    // D-333: a card 3 rows high and up lists more than the 5 rows of the short cards (what the data has, up to 12); the short ones keep 5
    if(width>=3&&height>=2){const rows=screen.getByRole('table',{name:id==='suppliers'?'발주 내역':'원자재'}).querySelectorAll('tbody tr');if(height>=3){expect(rows.length).toBeGreaterThan(5);expect(rows.length).toBeLessThanOrEqual(12);}else expect(rows).toHaveLength(5);}
    else expect(screen.queryByRole('table')).toBeNull();
    if(id==='inventory-booking'&&width===2&&height>=3)expect(document.querySelectorAll('.ms-rows [data-row-id]')).toHaveLength(6);
    unmount();
  }
});
it.each(['inventory-booking','suppliers'] as const)('%s: 공간이 돌아오면 같은 MiniTable의 숨긴 행·열이 모두 복원된다',id=>{
  let measure:()=>void=()=>{};
  vi.stubGlobal('ResizeObserver',class{constructor(cb:()=>void){measure=cb;}observe(){}disconnect(){}});
  const {container}=renderWithKit(<SupplyPanel id={id} width={4} height={3}/>,{store:storeFor(id)});
  const root=container.querySelector<HTMLElement>('.ms-panel')!;
  const table=screen.getByRole('table',{name:id==='suppliers'?'발주 내역':'원자재'});
  let width=360,height=240;
  Object.defineProperties(root,{
    clientWidth:{get:()=>width},clientHeight:{get:()=>height},
    scrollWidth:{get:()=>[...table.querySelectorAll('thead th')].filter(c=>!(c as HTMLElement).hidden).length*120},
    scrollHeight:{get:()=>100+[...table.querySelectorAll('tbody tr')].filter(r=>!(r as HTMLElement).hidden).length*64},
  });
  act(()=>measure());
  // the 4×3 card has the extra supplier column (D-333); it is dropped first, then the same two columns as before
  expect([...table.querySelectorAll('th[hidden]')].map(c=>c.textContent)).toEqual(id==='suppliers'?['발주 일자','발주사','주문 수량']:['안전 재고','오늘 사용량']);
  expect(table.querySelectorAll('tbody tr[hidden]').length).toBeGreaterThan(0);
  width=1200;height=900;act(()=>measure());
  expect(table.querySelectorAll('[hidden]')).toHaveLength(0);
  expect(table.querySelectorAll('tbody tr').length).toBeGreaterThan(5);
});

it('캘린더 16크기의 오늘·주간 핵심값과 날짜는 크기에 맞게 전환된다',()=>{
 const store=createWidgetDataStore(),model=readModel(store.getSnapshot(),'calendar');
 expect(longDate(TODAY)).toBe('11월 17일 화요일');
 for(const height of sizes)for(const width of sizes){
  const {unmount}=renderWithKit(<SupplyPanel id="calendar" width={width} height={height}/>,{textScale:125,reducedMotion:true,store});
  const week=width>=2&&height>=2&&!(width>=3&&height>=3);
  expect(document.querySelector('.ui-metric-fit__value')).toHaveTextContent(String(week?model.weekCount:model.todayCount));
  expect(document.querySelector('.ui-metric-fit__unit')).toHaveTextContent('개');
  if(width>=3&&height>=3)expect(screen.getByRole('table',{name:'2026년 11월 달력'})).toBeInTheDocument();
  unmount();
 }
});

it.each(['inventory-booking','suppliers'] as const)('%s: L 미니 표의 핵심 영역은 내용 너비로 수축하지 않는다',id=>{
  const {container}=renderWithKit(<><style>{supplyCss}</style><SupplyPanel id={id} width={3} height={2}/></>);
  const root=container.querySelector<HTMLElement>('.ms-panel[data-mini]')!;
  expect(getComputedStyle(root).display).toBe('flex');
  expect(getComputedStyle(root).alignItems).toBe('stretch');
});

function FitHarness({children}:{children:ReactNode}){
  const {ref,hiddenRows}=useFit<HTMLDivElement>([]);
  return <div ref={ref} data-testid="fit-root">{children}<output>{hiddenRows}</output></div>;
}

function captureResize(){
  const callbacks=new Map<Element,()=>void>();
  vi.stubGlobal('ResizeObserver',class{
    constructor(private readonly callback:()=>void){}
    observe(target:Element){callbacks.set(target,this.callback);}
    disconnect(){}
  });
  return (root:Element)=>act(()=>callbacks.get(root)?.());
}

it('두 열이 함께 넘치면 정해진 순서로 계속 덜고, 필요 없던 숨김은 돌려준다',()=>{
  const resize=captureResize();
  const {container}=render(<FitHarness>
    <div><p data-drop="900">보조 줄</p><p data-drop="300">핵심 라벨</p></div>
    <div><p data-drop="501" data-row="">나중 행</p><p data-drop="500" data-row="">첫 행</p></div>
    <p data-drop="950">넘침과 무관한 안내</p><p data-more="" hidden>외 1개</p>
  </FitHarness>);
  const root=screen.getByTestId('fit-root');
  const sub=container.querySelector<HTMLElement>('[data-drop="900"]')!;
  const row=container.querySelector<HTMLElement>('[data-drop="501"]')!;
  let height=100;
  Object.defineProperties(root,{
    clientWidth:{value:500},clientHeight:{get:()=>height},scrollWidth:{value:500},
    scrollHeight:{get:()=>Math.max(sub.hidden?80:140,row.hidden?80:140)},
  });
  resize(root);
  expect(sub.hidden).toBe(true);
  expect(row.hidden).toBe(true);
  expect(container.querySelector('[data-drop="950"]')).not.toHaveAttribute('hidden');
  expect(container.querySelector('[data-drop="500"]')).not.toHaveAttribute('hidden');
  expect(container.querySelector('[data-drop="300"]')).not.toHaveAttribute('hidden');
  expect(container.querySelector('[data-more]')).not.toHaveAttribute('hidden');
  expect(container.querySelector('output')).toHaveTextContent('1');
  height=200;resize(root);
  expect(root.querySelectorAll('[data-drop][hidden]')).toHaveLength(0);
  expect(container.querySelector('[data-more]')).toHaveAttribute('hidden');
  expect(container.querySelector('output')).toHaveTextContent('0');
  height=100;resize(root);
  expect(root.querySelectorAll('[data-drop][hidden]')).toHaveLength(2);
});

it('MetricFit 단계만 바뀌어도 행을 다시 맞추고 원래 단계의 첫 배치를 복원한다',async()=>{
  const resize=captureResize();
  const {container,unmount}=render(<FitHarness>
    <span className="ui-metric-fit" data-stage="0">3개</span><p data-drop="500" data-row="">추가 행</p>
  </FitHarness>);
  const root=screen.getByTestId('fit-root');
  const metric=container.querySelector<HTMLElement>('.ui-metric-fit')!;
  const row=container.querySelector<HTMLElement>('[data-row]')!;
  Object.defineProperties(root,{
    clientWidth:{value:300},clientHeight:{value:100},scrollWidth:{value:300},
    scrollHeight:{configurable:true,get:()=>row.hidden?60:metric.dataset.stage==='2'?140:90},
  });
  resize(root);
  expect(row.hidden).toBe(false);
  for(let i=0;i<2;i++){
    await act(async()=>{metric.dataset.stage='2';});
    expect(row.hidden).toBe(true);
    expect(container.querySelector('output')).toHaveTextContent('1');
    await act(async()=>{metric.dataset.stage='0';});
    expect(row.hidden).toBe(false);
    expect(container.querySelector('output')).toHaveTextContent('0');
  }
  const measured=vi.fn(()=>90);
  Object.defineProperty(root,'scrollHeight',{configurable:true,get:measured});
  unmount();
  await act(async()=>{metric.dataset.stage='2';});
  expect(measured).not.toHaveBeenCalled();
});

it('partial-zero는 좁은 모양에서 짧은 상태 문구와 전체 접근 설명을 유지하고 크기 왕복 뒤 복원한다',()=>{
  const {container,rerender}=renderWithKit(<><style>{supplyCss}</style><SupplyPanel id="inventory-booking" width={1} height={1} editing/></>,{
    locale:'en',textScale:125,preview:{family:'normal',overrides:{'inventory-booking':'partial-zero'}},
  });
  const checkShort=()=>{
    const message=container.querySelector<HTMLElement>('.ui-panel-state__message')!;
    expect(message).toHaveTextContent(/^확인한 재고는 충분해요\.$/);
    expect(message).toHaveAttribute('lang','ko');
    expect(message).not.toHaveAttribute('data-drop');
    expect(container.querySelector('.ui-panel-state__description')).toHaveTextContent('No checked items need restocking');
    expect(container.querySelector('.ui-panel-hit')).toHaveAccessibleDescription(/No checked items need restocking/);
    expect(container.querySelector('.ui-panel-state .ui-status-chip')).toHaveTextContent('Needs review');
    expect(container.querySelector('[data-slot="inventory-booking.metric.label"]')).toBeNull();
    expect(container.querySelector('.ui-metric-fit')).toBeNull();
  };
  checkShort();
  rerender(<><style>{supplyCss}</style><SupplyPanel id="inventory-booking" width={2} height={1} editing/></>);
  checkShort();
  rerender(<><style>{supplyCss}</style><SupplyPanel id="inventory-booking" width={3} height={1} editing/></>);
  expect(container.querySelector('.ui-panel-state__message')).toHaveTextContent('No checked items need restocking');
  rerender(<><style>{supplyCss}</style><SupplyPanel id="inventory-booking" width={1} height={2} editing/></>);
  expect(container.querySelector('.ui-panel-state__message')).toHaveTextContent('No checked items need restocking');
  rerender(<><style>{supplyCss}</style><SupplyPanel id="inventory-booking" width={1} height={1} editing/></>);
  checkShort();
});

it('partial-zero의 확인 필요 칩은 공간이 돌아오면 복원된다',()=>{
  const resize=captureResize();
  const {container}=renderWithKit(<SupplyPanel id="inventory-booking" width={2} height={1}/>,{
    preview:{family:'normal',overrides:{'inventory-booking':'partial-zero'}},
  });
  const root=container.querySelector<HTMLElement>('.ms-panel')!;
  const chip=container.querySelector<HTMLElement>('.ui-status-chip')!.parentElement!;
  expect(container.querySelector('[data-row-id="products"]')).toBeNull();
  let height=100;
  Object.defineProperties(root,{
    clientWidth:{value:500},clientHeight:{get:()=>height},scrollWidth:{value:500},
    scrollHeight:{get:()=>60+(chip.hidden?0:50)},
  });
  resize(root);
  expect(chip.hidden).toBe(true);
  expect(container.querySelector('.ui-panel-state__message')).toBeVisible();
  height=120;resize(root);
  expect(chip.hidden).toBe(false);
});

it.each(['ko','en'] as const)('발주 예정 없음 %s: 편집 1×1의 확인 문구는 상태 모양에서 손잡이 공간을 남긴다',locale=>{
  const {container,rerender}=renderWithKit(<><style>{supplyCss}</style><SupplyPanel id="suppliers" width={1} height={1} editing/></>,{
    locale,textScale:125,preview:{family:'normal',overrides:{suppliers:'no-upcoming'}},store:supplyWeek().store,
  });
  const note=container.querySelector<HTMLElement>('.ms-sup-state-note')!;
  expect(note).toHaveTextContent(locale==='ko'?'입고 확인 필요 1건':'1 delivery to check');
  expect(note.closest('.ui-panel-state')).toBeInTheDocument();
  expect(getComputedStyle(note).maxWidth).toBe('calc(100% - var(--target-default))');
  expect(getComputedStyle(note).whiteSpace).toBe('normal');
  rerender(<><style>{supplyCss}</style><SupplyPanel id="suppliers" width={2} height={2} editing/></>);
  expect(container.querySelector('.ms-sup-state-note')).toHaveTextContent(locale==='ko'?'입고 확인 필요 1건':'1 delivery to check');
});

it.each(['재료','판매 상품'])('%s 상세는 위쪽 내용을 보존하고 표의 최소 높이를 본문 스크롤에 전달한다',tab=>{
  const {container}=renderWithKit(<><style>{supplyCss}</style><DetailStack root={{featureId:'inventory-booking'}} /></>);
  fireEvent.click(screen.getByRole('tab',{name:tab}));
  const root=container.querySelector<HTMLElement>('.ms-detail.ms-inv')!;
  const panel=screen.getByRole('tabpanel');
  if (tab === '판매 상품') {
    expect(within(panel).getByText('아직 등록한 판매 상품이 없어요')).toBeVisible();
    expect(within(panel).getByRole('button', { name: '판매 상품 등록하기' })).toBeVisible();
    expect(within(panel).queryByRole('grid')).not.toBeInTheDocument();
    return;
  }
  const grid=within(panel).getByRole('grid',{name:tab}).closest<HTMLElement>('.ui-data-grid')!;
  expect(panel).not.toHaveTextContent('고친 재고는 변동 기록에 남아요');
  expect(getComputedStyle(root).height).toBe('100%');
  expect(getComputedStyle(root).minHeight).toBe('0');
  expect(getComputedStyle(grid).flex).toBe('1 1 0px');
  expect(getComputedStyle(grid).minHeight).toBe('0');
});
