import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunStore } from '../../state';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout/presets';
import { createTableLayout, setTableSeats } from '../../layout/table-layout';
import { UiProvider, timePolicy } from '../../ui';
import { OnboardingScreen } from './index';
import { TableEditor } from './TableEditor';
import { I18nProvider } from '../../i18n';
import { getManagementTemplates } from '../../catalog/management-templates';
import { createWidgetDataStore } from '../../data/widget-data';
import { createSessionActions } from '../../app/session-actions';

afterEach(()=>{cleanup();vi.restoreAllMocks();});
const makeRun = () => createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, theme: 'light', clock: () => 0 });
function openTables(run = makeRun(), reducedMotion = true) {
  const view = render(<UiProvider screenPreset={screenPresets.A} reducedMotion={reducedMotion}><OnboardingScreen run={run} /></UiProvider>);
  fireEvent.click(screen.getByRole('button', { name: '카페' }));
  fireEvent.click(screen.getByRole('radio', { name: /후불형/ }));
  return { run, view };
}
function enterCount(n: number) {
  const field = screen.getByRole('spinbutton', { name: '테이블 수' });
  fireEvent.change(field, { target: { value: String(n) } });
  fireEvent.keyDown(field, { key: 'Enter' });
}

describe('온보딩 초안 포트 연결', () => {
  it('다음을 누르기 전부터 입력과 이동을 RunStore에 반영하고 외부 초안도 읽는다', async () => {
    const { run } = openTables();
    const token = run.getState().transitionToken;
    enterCount(8);
    expect(run.getState().onboarding.step).toBe('tables');
    expect(run.getState().transitionToken).toBe(token);
    expect(run.getState().onboarding.draft.tableLayout?.tables).toHaveLength(8);
    const tile = screen.getByRole('button', { name: /T1, 2석/ });
    fireEvent.keyDown(tile, { key: 'ArrowLeft' });
    fireEvent.keyDown(tile, { key: '+' });
    expect(run.getState().onboarding.draft.tableLayout?.tables[0]).toMatchObject({ column: 0, seats: 3 });
    act(() => {
      const state = run.getState();
      run.actions.updateOnboardingTableDraft(setTableSeats(state.onboarding.draft.tableLayout!, 'T1', 7)!, state);
    });
    await waitFor(()=>expect(screen.getByRole('button', { name: /T1, 7석/ })).toBeVisible());
  });

  it('이전으로 가서 단계를 끄고 다시 켜거나 화면을 다시 mount해도 같은 초안을 쓴다', () => {
    const { run, view } = openTables();
    enterCount(8);
    fireEvent.click(screen.getByRole('button', { name: '이전 단계, 결제 방식' }));
    fireEvent.click(screen.getByRole('radio', { name: /선불형/ }));
    expect(run.getState().onboarding.draft.tableLayout?.tables).toHaveLength(8);
    expect(screen.getByRole('list', { name: '시작 설정 단계' })).toHaveTextContent('꺼짐');
    fireEvent.click(screen.getByRole('button', { name: '이전 단계, 결제 방식' }));
    fireEvent.click(screen.getByRole('radio', { name: /후불형/ }));
    expect(screen.getByRole('spinbutton', { name: '테이블 수' })).toHaveValue(8);
    view.unmount();
    render(<UiProvider screenPreset={screenPresets.A} reducedMotion><OnboardingScreen run={run} /></UiProvider>);
    expect(screen.getByRole('spinbutton', { name: '테이블 수' })).toHaveValue(8);
  });

  it('다음에는 미설정으로 진행하고 새 실행은 기본 배치와 미선택 템플릿으로 돌아온다', () => {
    const { run } = openTables();
    enterCount(8);
    fireEvent.click(screen.getByRole('button', { name: '다음에' }));
    expect(run.getState().onboarding.draft.tableLayout).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('테이블 배치는 설정에서 나중에 할 수 있어요');
    act(() => run.actions.resetRun({ screenPreset: screenPresets.A, catalog: getRegistry('A'), theme: 'light' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('어떤 가게를 하세요?');
    expect(run.getState().onboarding).toMatchObject({ step: 'business', selectedTemplateId: null, draft: { businessType: null, paymentStyle: null, tableLayout: null } });
    fireEvent.click(screen.getByRole('button', { name: '카페' }));
    fireEvent.click(screen.getByRole('radio', { name: /후불형/ }));
    expect(screen.getByRole('spinbutton', { name: '테이블 수' })).toHaveValue(6);
  });

  it.each([0, 21])('잘못된 테이블 수 %i는 초안과 합계를 바꾸지 않는다', async n => {
    const { run } = openTables();
    const before = run.getState().onboarding.draft.tableLayout;
    enterCount(n);
    expect(run.getState().onboarding.draft.tableLayout).toBe(before);
    expect(screen.getByRole('spinbutton', { name: '테이블 수' })).toHaveValue(6);
    await waitFor(()=>expect(screen.getByText('테이블은 1개부터 20개까지 놓을 수 있어요')).toBeVisible());
  });

  it('겹침·격자 밖 drop은 원복하고 유효한 drop만 초안에 즉시 반영한다', () => {
    const {run}=openTables();
    const tile=screen.getByRole('button',{name:/T1, 2석/});
    const grid=document.querySelector<HTMLElement>('.ui-table-grid')!;
    vi.spyOn(grid,'getBoundingClientRect').mockReturnValue({x:0,y:0,left:0,top:0,right:936,bottom:624,width:936,height:624,toJSON:()=>({})});
    const pointer=(type:string,x:number,y:number)=>fireEvent(tile,Object.assign(new Event(type,{bubbles:true}),{pointerId:7,button:0,clientX:x,clientY:y}));
    const before=run.getState().onboarding.draft.tableLayout;
    for(const [x,y] of [[468,156],[-20,156]]){
      pointer('pointerdown',156,156);pointer('pointermove',x,y);pointer('pointerup',x,y);
      expect(run.getState().onboarding.draft.tableLayout).toBe(before);
      expect(screen.getByText('여기에는 놓을 수 없어요')).toHaveAttribute('role','status');
    }
    pointer('pointerdown',156,156);pointer('pointermove',260,260);pointer('pointerup',260,260);
    expect(run.getState().onboarding.draft.tableLayout?.tables[0]).toMatchObject({column:2,row:2});
    expect(screen.getByText('T1, 가로 3번째 세로 3번째 칸')).toHaveAttribute('role','status');
    expect(run.getState().onboarding.draft.tableLayout?.tables.slice(1)).toEqual(before?.tables.slice(1));
  });

  it('1~20개와 1~12석 경계를 지키며 혼합 값·큰 번호 삭제·합계 낭독을 연결한다', () => {
    const {run}=openTables();
    enterCount(20);
    expect(run.getState().onboarding.draft.tableLayout?.tables).toHaveLength(20);
    const seats=screen.getByRole('spinbutton',{name:'모든 테이블 같게'});
    expect(seats).toHaveValue(null);
    for(const value of ['0','13']){
      const before=run.getState().onboarding.draft.tableLayout;
      fireEvent.change(seats,{target:{value}});fireEvent.blur(seats);
      expect(run.getState().onboarding.draft.tableLayout).toBe(before);
    }
    fireEvent.change(seats,{target:{value:'12'}});fireEvent.keyDown(seats,{key:'Enter'});
    expect(run.getState().onboarding.draft.tableLayout?.tables.every(table=>table.seats===12)).toBe(true);
    expect(screen.getAllByText('테이블 20개 · 240석').filter(node=>node.hasAttribute('aria-live'))).toHaveLength(1);
    enterCount(1);
    expect(run.getState().onboarding.draft.tableLayout?.tables.map(table=>table.tableId)).toEqual(['T1']);
    fireEvent.change(seats,{target:{value:'1'}});fireEvent.blur(seats);
    expect(run.getState().onboarding.draft.tableLayout?.tables[0].seats).toBe(1);
  });
});

it.each(['en','zh-Hans','zh-Hant'] as const)('%s에서도 결제·테이블·시작 문구는 한국어 fallback으로 읽힌다', locale=>{
  const run=makeRun();
  render(<I18nProvider locale={locale}><UiProvider screenPreset={screenPresets.A} reducedMotion><OnboardingScreen run={run}/></UiProvider></I18nProvider>);
  act(()=>run.actions.chooseBusiness('cafe'));
  expect(screen.getByRole('heading',{level:1})).toHaveTextContent('손님이 언제 계산하나요?');
  fireEvent.click(screen.getByRole('radio',{name:/후불형/}));
  expect(screen.getByRole('spinbutton',{name:'테이블 수'})).toHaveValue(6);
  fireEvent.click(screen.getByRole('button',{name:'다음'}));
  expect(screen.getByRole('heading',{level:1})).toHaveTextContent('어떤 화면으로 시작할까요?');
  expect(screen.getByRole('radio',{name:/하루 운영 중심/})).toHaveAttribute('aria-checked','true');
  expect(document.body.textContent).not.toMatch(/onboarding\.template|payment\.postpaid|tables\.total/);
});

const startCases = (['A', 'B'] as const).flatMap(preset =>
  (['cafe', 'restaurant', 'pub', 'beauty', 'retail', 'academy', 'fitness', 'other'] as const).flatMap(business =>
    (['prepaid', 'postpaid'] as const).flatMap(payment =>
      (['A', 'B', 'C'] as const).map(template => [preset, business, payment, template] as const))));
it.each(startCases)('%s/%s/%s/%s 카드 미리보기와 세션의 실제 시작 배치가 같다',(preset,business,payment,templateId)=>{
  const run=createRunStore({screenPreset:screenPresets[preset],catalog:getRegistry(preset),time:timePolicy,theme:'light',reducedMotion:true,clock:()=>0});
  const data=createWidgetDataStore(undefined,{runId:run.getState().runId});
  const actions=createSessionActions(run,data);
  render(<UiProvider screenPreset={screenPresets[preset]} reducedMotion><OnboardingScreen run={run} sessionActions={actions}/></UiProvider>);
  act(()=>run.actions.chooseBusiness(business));
  fireEvent.click(screen.getByRole('radio',{name:payment==='prepaid'?/선불형/:/후불형/}));
  if(run.getState().onboarding.step==='tables')fireEvent.click(screen.getByRole('button',{name:'확인'}));
  const template=getManagementTemplates({businessType:business,paymentStyle:payment,presetId:preset}).find(item=>item.id===templateId)!;
  const card=screen.getAllByRole('radio')[templateId.charCodeAt(0)-'A'.charCodeAt(0)];
  fireEvent.click(card);
  const blocks=card.querySelectorAll<HTMLElement>('.ui-template-preview>span');
  expect(blocks).toHaveLength(template.panels.length);
  template.panels.forEach((panel,index)=>{
    expect(blocks[index]).toHaveStyle({gridColumn:`${panel.column+1} / span ${panel.width}`,gridRow:`${panel.row+1} / span ${panel.height}`});
  });
  fireEvent.click(screen.getByRole('button',{name:'이 화면으로 시작하기'}));
  expect(run.getState().onboarding.step).toBe('applying');
  expect(run.getState().panels).toEqual(template.panels.map(panel=>({...panel,condition:panel.condition??{kind:'default'}})));
  expect(run.getState().boards.marketing.pages.every(page=>page.panels.length===0)).toBe(true);
  expect(data.getSnapshot().tables.shopSettings).toMatchObject({businessType:business,paymentStyle:payment});
  // API-212/250/275, DATA_MODEL §19.1: compare every shared setting, including initial empty links.
  // layoutActivated remains the data-only reservation activation marker.
  const {layoutActivated,...settings}=data.getSnapshot().tables.shopSettings;
  expect(settings.cctvPosLinks).toEqual([]);
  expect(run.getState().shopSettings).toEqual(settings);
  expect(layoutActivated).toBe(settings.tableLayout!==null);
});

it('시작 적용 실패는 선택과 초안을 보존하고 재시도할 수 있다',()=>{
  const run=makeRun(),completeOnboarding=vi.fn().mockReturnValueOnce({ok:false}).mockReturnValueOnce({ok:true});
  render(<UiProvider screenPreset={screenPresets.A} reducedMotion><OnboardingScreen run={run} sessionActions={{completeOnboarding}}/></UiProvider>);
  act(()=>run.actions.chooseBusiness('cafe'));
  fireEvent.click(screen.getByRole('radio',{name:/선불형/}));
  fireEvent.click(screen.getAllByRole('radio')[1]);
  const before=run.getState();
  fireEvent.click(screen.getByRole('button',{name:'이 화면으로 시작하기'}));
  expect(screen.getByRole('alert')).toHaveTextContent('변경을 적용하지 못했어요. 다시 시도해 주세요');
  expect(run.getState()).toBe(before);
  fireEvent.click(screen.getByRole('button',{name:'이 화면으로 시작하기'}));
  expect(completeOnboarding.mock.calls).toEqual([['B'],['B']]);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('동시에 있는 편집기마다 타일과 목록 행의 ID를 짝지어 포커스를 보낸다', () => {
  render(<UiProvider screenPreset={screenPresets.A} reducedMotion><section aria-label="첫 배치"><TableEditor value={createTableLayout()} onChange={() => undefined} /></section><section aria-label="둘째 배치"><TableEditor value={createTableLayout()} onChange={() => undefined} /></section></UiProvider>);
  const second = screen.getByRole('region', { name: '둘째 배치' });
  fireEvent.click(within(second).getByRole('button', { name: /T1, 2석/ }));
  expect(within(second).getByRole('group', { name: 'T1' })).toHaveFocus();
  const ids = [...document.querySelectorAll('[id]')].map(element => element.id);
  expect(new Set(ids).size).toBe(ids.length);
});

it('앞으로·이전 전환은 키트 모션을 쓰고 꺼진 단계는 한 번에 건너뛴다', async () => {
  const run = makeRun();
  const view = render(<UiProvider screenPreset={screenPresets.A}><OnboardingScreen run={run} /></UiProvider>);
  fireEvent.click(screen.getByRole('button', { name: '미용·뷰티' }));
  const payment = screen.getByRole('radiogroup', { name: '손님이 언제 계산하나요?' });
  expect(payment.closest('.ui-onboarding-step')).not.toBeNull();
  expect(payment.closest('.ui-onboarding-step')).toHaveStyle({ transform: 'translateX(24px)' });
  fireEvent.click(screen.getByRole('radio', { name: /후불형/ }));
  expect(screen.getByRole('list', { name: '시작 설정 단계' })).toHaveTextContent('꺼짐');
  expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
  await waitFor(()=>expect(view.container.querySelectorAll('.ui-onboarding-step')).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: '이전 단계, 결제 방식' }));
  expect(screen.getByRole('radiogroup', { name: '손님이 언제 계산하나요?' }).closest('.ui-onboarding-step')).toHaveStyle({ transform: 'translateX(-24px)' });
  expect(view.container.querySelector('.ui-onboarding-step[aria-hidden="true"]')).toHaveAttribute('inert');
});

it('줄인 움직임에서는 단계가 이동 transform 없이 교체되고 이전으로 초점이 복귀한다', () => {
  const { view } = openTables();
  const layer = screen.getByRole('button', { name: /T1, 2석/ }).closest('.ui-onboarding-step');
  expect(layer).not.toBeNull();
  expect(layer).not.toHaveAttribute('style', expect.stringContaining('translateX'));
  fireEvent.click(screen.getByRole('button', { name: '이전 단계, 결제 방식' }));
  expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
  expect(view.container.querySelectorAll('.ui-step-indicator')).toHaveLength(1);
});
