import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createRunStore } from '../../state';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout/presets';
import { UiProvider, timePolicy } from '../../ui';
import { SettingsOverlay } from './index';
afterEach(cleanup);
it('passes the controlled CCTV link picker to the settings table layout', async () => {
 const run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:timePolicy,theme:'light',reducedMotion:true,clock:()=>0});
 run.actions.chooseBusiness('cafe');run.actions.setOnboardingAnswer({paymentStyle:'postpaid'});run.actions.saveOnboardingTables(run.getState().onboarding.draft.tableLayout!);run.actions.startEmpty();run.actions.openSettings();
 const onChange=vi.fn();
 render(<UiProvider screenPreset={screenPresets.A} reducedMotion><SettingsOverlay run={run} tableLinkPicker={{valueFor:()=>null,optionsFor:()=>[{value:'z1',label:'t1'}],onChange}}/></UiProvider>);
 await waitFor(()=>expect(screen.getByRole('button',{name:/테이블 배치 고치기/})).toBeVisible());
 fireEvent.click(screen.getByRole('button',{name:/테이블 배치 고치기/}));
 fireEvent.change(screen.getByRole('combobox',{name:'T1 CCTV 구역 연결'}),{target:{value:'z1'}});
 expect(onChange).toHaveBeenCalledExactlyOnceWith('T1','z1');
});
it('explains that linking needs postpaid table orders when table layout is unavailable',async()=>{
 const run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:timePolicy,theme:'light',reducedMotion:true,clock:()=>0});
 run.actions.chooseBusiness('cafe');run.actions.setOnboardingAnswer({paymentStyle:'prepaid'});run.actions.startEmpty();run.actions.openSettings();
 render(<UiProvider screenPreset={screenPresets.A} reducedMotion><SettingsOverlay run={run} tableLinkPicker={{disabled:true,valueFor:()=>null,optionsFor:()=>[],onChange:()=>{}}}/></UiProvider>);
 expect(await screen.findByText('테이블별 주문이 있는 후불형에서 연결할 수 있어요')).toBeInTheDocument();
 expect(screen.queryByRole('combobox',{name:/CCTV 구역 연결/})).not.toBeInTheDocument();
});
it('keeps both picker orientations reciprocal and excludes occupied endpoints',async()=>{
 const { createLinkPickers }=await import('../../features/cctv/zones/linked-ui');
 const onSet=vi.fn();
 const pickers=createLinkPickers({enabled:true,zones:[{id:'z1',label:'t1'},{id:'z2',label:'t2'}],tables:[{id:'T1',label:'T1'},{id:'T2',label:'T2'}],links:[{zoneId:'z1',tableId:'T1'}],onSet});
 expect(pickers.zone.valueFor('z1')).toBe('T1');
 expect(pickers.table.valueFor('T1')).toBe('z1');
 expect(pickers.zone.optionsFor('z2')).toEqual([{value:'T2',label:'T2'}]);
 expect(pickers.table.optionsFor('T2')).toEqual([{value:'z2',label:'t2'}]);
 pickers.table.onChange('T1',null);expect(onSet).toHaveBeenCalledExactlyOnceWith('z1',null);
});
