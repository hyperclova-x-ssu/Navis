import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { createRunStore } from '../../state';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout/presets';
import { ActionButton, UiProvider, timePolicy } from '../../ui';
import { createWidgetDataStore } from '../../data/widget-data';
import { createSessionActions } from '../../app/session-actions';
import { SettingsOverlay } from './index';

afterEach(cleanup);
const backButton=()=>within(screen.getByRole('dialog').querySelector<HTMLElement>('.ui-overlay-header')!).getByRole('button',{name:'설정으로'});
function setup(template: 'A' | null = null) {
  let now=0;
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, theme: 'light', reducedMotion: true, clock: () => now });
  const data = createWidgetDataStore(undefined, { runId: run.getState().runId });
  const actions = createSessionActions(run, data);
  run.actions.chooseBusiness('cafe');
  run.actions.setOnboardingAnswer({ paymentStyle: 'prepaid' });
  actions.completeOnboarding(template);
  if (template) run.actions.templateAssembled({ runId: run.getState().runId, applyToken: run.getState().onboarding.applyToken! });
  if (template) { now=400; run.actions.tick(); }
  if (template) run.actions.closeTemplateTour();
  const updateSettings = vi.fn(actions.updateSettings);
  function Host() {
    const state = useSyncExternalStore(run.subscribe, run.getState);
    return <UiProvider screenPreset={state.screenPreset} theme={state.theme} textScale={state.textScale} reducedMotion>
      <main><h1>우리 가게</h1><ActionButton data-focus-key="settings" onClick={run.actions.openSettings}>설정 열기</ActionButton></main>
      <SettingsOverlay run={run} sessionActions={{ updateSettings }} />
    </UiProvider>;
  }
  render(<Host />);
  fireEvent.click(screen.getByRole('button', { name: '설정 열기' }));
  return { run, data, updateSettings };
}
async function enableTables() {
  fireEvent.click(await screen.findByRole('button', { name: /결제 방식/ }));
  fireEvent.click(await screen.findByRole('radio', { name: /후불형/ }));
  fireEvent.click(backButton());
  fireEvent.click(await screen.findByRole('button', { name: /테이블 배치(?:하기| 고치기)/ }));
  await screen.findByRole('spinbutton', { name: '테이블 수' });
}

it('결제 방식과 테이블 저장은 두 store에 함께 반영하고 성공한 값을 한 번 낭독한다', async () => {
  const { run, data } = setup('A');
  const before = run.getState().boards;
  await enableTables();
  expect(screen.getAllByRole('status').some(node=>node.textContent==='후불형으로 바꿨어요')).toBe(true);
  const count = screen.getByRole('spinbutton', { name: '테이블 수' });
  fireEvent.change(count, { target: { value: '8' } });
  fireEvent.keyDown(count, { key: 'Enter' });
  expect(data.getSnapshot().tables.shopSettings.tableLayout).toBeNull();
  expect(run.getState().shopSettings.tableLayout).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
  await waitFor(()=>expect(screen.getByRole('button', { name: /테이블 배치(?:하기| 고치기)/ })).toBeVisible());
  expect(run.getState().shopSettings.tableLayout?.tables).toHaveLength(8);
  expect(data.getSnapshot().tables.shopSettings.tableLayout?.tables).toHaveLength(8);
  expect(run.getState().boards).toEqual(before);
  expect(screen.getAllByRole('status').filter(node=>node.textContent==='테이블 8개 · 16석으로 바꿨어요')).toHaveLength(1);
});

it.each(['back', 'close', 'escape'] as const)('저장 전 %s는 테이블 초안을 버리고 재진입하면 저장한 값으로 시작한다', async route => {
  const { run, data, updateSettings } = setup();
  await enableTables();
  updateSettings.mockClear();
  fireEvent.click(screen.getByRole('button', { name: '테이블 수 늘리기' }));
  if (route === 'back') fireEvent.click(backButton());
  else {
    if (route === 'close') fireEvent.click(screen.getByRole('button', { name: '닫기' }));
    else await userEvent.setup().keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('button', { name: '설정 열기' })).toHaveFocus();
    act(() => run.actions.finishOverlayExit(run.getState().exitPendingToken!));
    fireEvent.click(screen.getByRole('button', { name: '설정 열기' }));
  }
  fireEvent.click(await screen.findByRole('button', { name: /테이블 배치(?:하기| 고치기)/ }));
  expect(await screen.findByRole('spinbutton', { name: '테이블 수' })).toHaveValue(11);
  expect(run.getState().shopSettings.tableLayout).toBeNull();
  expect(data.getSnapshot().tables.shopSettings.tableLayout).toBeNull();
  expect(updateSettings).not.toHaveBeenCalled();
});

it('업종으로 배치를 껐다 켜거나 화면 모드와 큰 글자를 바꿔도 저장 배치와 패널을 보존한다', async () => {
  const { run, data } = setup('A');
  await enableTables();
  fireEvent.click(screen.getByRole('button', { name: '테이블 수 늘리기' }));
  fireEvent.click(screen.getByRole('button', { name: '저장하기' }));
  await screen.findByRole('button', { name: '업종 바꾸기' });
  const saved = data.getSnapshot().tables.shopSettings.tableLayout;
  const boards = run.getState().boards;
  fireEvent.click(screen.getByRole('tab', { name: '다크' }));
  fireEvent.click(screen.getByRole('tab', { name: '라이트' }));
  fireEvent.click(screen.getByRole('switch',{name:'큰 글자'}));
  expect(run.getState().textScale).toBe(125);
  expect(run.getState().boards).toBe(boards);
  fireEvent.click(screen.getByRole('button', { name: '업종 바꾸기' }));
  fireEvent.click(await screen.findByRole('button', { name: '소매' }));
  await waitFor(() => expect(screen.getByRole('dialog',{name:'설정'})).toBeVisible());
  await waitFor(() => expect(screen.getByText('테이블 배치는 후불형 카페·음식점·주점에서 설정해요')).toBeVisible());
  expect(screen.getByRole('button', { name: /테이블 배치(?:하기| 고치기)/ })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '업종 바꾸기' }));
  fireEvent.click(await screen.findByRole('button', { name: '카페' }));
  expect(data.getSnapshot().tables.shopSettings.tableLayout).toEqual(saved);
  expect(run.getState().boards).toEqual(boards);
});

it('저장 실패는 두 store를 보존하고 같은 로컬 초안으로 재시도한다',async()=>{
  const {run,data,updateSettings}=setup();
  await enableTables();
  fireEvent.click(screen.getByRole('button',{name:'테이블 수 늘리기'}));
  const beforeData=data.getSnapshot(),beforeRun=run.getState().shopSettings;
  updateSettings.mockImplementationOnce(()=>({ok:false,code:'CONFLICT',reason:'STALE_REVISION',messageKey:'run.session.conflict'}));
  fireEvent.click(screen.getByRole('button',{name:'저장하기'}));
  expect(screen.getByRole('alert')).toHaveTextContent('변경을 적용하지 못했어요. 다시 시도해 주세요');
  expect(data.getSnapshot()).toBe(beforeData);
  expect(run.getState().shopSettings).toBe(beforeRun);
  expect(screen.getByRole('spinbutton',{name:'테이블 수'})).toHaveValue(12);
  fireEvent.click(screen.getByRole('button',{name:'저장하기'}));
  await waitFor(()=>expect(screen.getByRole('button',{name:'테이블 배치 고치기'})).toBeVisible());
  expect(data.getSnapshot().tables.shopSettings.tableLayout?.tables).toHaveLength(12);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('테이블 편집기를 닫는 동안 큰 프레임과 마지막 초안을 유지하며 입력을 막는다',async()=>{
  const {data}=setup();
  await enableTables();
  fireEvent.click(screen.getByRole('button',{name:'테이블 수 늘리기'}));
  fireEvent.click(screen.getByRole('button',{name:'닫기'}));
  const exit=document.querySelector<HTMLElement>('[data-testid="ui-overlay-exit"]');
  expect(exit).toHaveAttribute('inert');
  expect(exit).toHaveStyle({width:'calc(var(--canvas-width) - var(--detail-inset) * 2)',height:'calc(var(--canvas-height) - var(--detail-inset) * 2)'});
  expect(exit?.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe('12');
  expect(data.getSnapshot().tables.shopSettings.tableLayout).toBeNull();
});
