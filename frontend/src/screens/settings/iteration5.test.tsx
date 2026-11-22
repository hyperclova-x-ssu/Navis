import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createRunStore } from '../../state';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout/presets';
import { UiProvider, timePolicy } from '../../ui';
import { SettingsOverlay } from './index';

afterEach(() => { cleanup(); window.history.replaceState(null, '', '/'); });
it('매장 설정을 세션 액션으로 저장하고 테이블 초안은 뒤로 가면 버린다',async()=>{
 const run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:timePolicy,theme:'light',reducedMotion:true,clock:()=>0});
 run.actions.chooseBusiness('cafe');run.actions.setOnboardingAnswer({paymentStyle:'postpaid'});run.actions.saveOnboardingTables(run.getState().onboarding.draft.tableLayout!);run.actions.startEmpty();run.actions.openSettings();
 const updateSettings=vi.fn(()=>({ok:true}));
 render(<UiProvider screenPreset={screenPresets.A} reducedMotion><SettingsOverlay run={run} sessionActions={{updateSettings}} /></UiProvider>);
 await waitFor(()=>expect(screen.getByRole('group',{name:'매장 설정'})).toBeVisible());
 fireEvent.click(screen.getByRole('button',{name:/테이블 배치 고치기/}));
 fireEvent.keyDown(screen.getByRole('button',{name:/T1, 2석/}),{key:'+'});
 fireEvent.click(screen.getByRole('button',{name:/돌아가기|설정으로/}));
 expect(updateSettings).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:/테이블 배치 고치기/}));
 await waitFor(()=>expect(screen.getByRole('button',{name:/T1, 2석/})).toBeVisible());
 fireEvent.click(screen.getByRole('button',{name:'저장하기'}));
 expect(updateSettings).toHaveBeenCalledOnce();
});

it('마감 정산 예시 선택은 위젯별 선택과 독립적으로 바뀐다',async()=>{
 window.history.replaceState(null, '', '/?qa=preview-states');
 const run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:timePolicy,theme:'light',reducedMotion:true,clock:()=>0});
 run.actions.chooseBusiness('cafe');run.actions.setOnboardingAnswer({paymentStyle:'prepaid'});run.actions.startEmpty();run.actions.openSettings();
 render(<UiProvider screenPreset={screenPresets.A} reducedMotion><SettingsOverlay run={run}/></UiProvider>);
 await waitFor(()=>expect(screen.getByRole('dialog',{name:'예시 상태 보기'})).toBeVisible());
 fireEvent.click(screen.getByRole('button',{name:/패널별로 고르기/}));
 fireEvent.click(screen.getByRole('button',{name:/마감 정산 결제 내역/}));
 fireEvent.click(screen.getByRole('radio',{name:'불러오기 실패'}));
 expect(run.getState().preview.closing).toBe('error');expect(run.getState().preview.overrides).toEqual({});
});
