import {beginDashboard} from './test-session';
import '../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {createRunStore} from '../state';
import {getRegistry} from '../catalog';
import {screenPresets} from '../layout';
import {timePolicy} from '../ui';
import {App} from './App';
afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('mounts development controls in their own portal host while preserving the dialog footer without React warnings',async()=>{
 const errors=vi.spyOn(console,'error').mockImplementation(()=>{});
 const run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:timePolicy,clock:()=>0,theme:'light'});beginDashboard(run,'cafe');
 render(<App run={run} verification={{scenario:'error-settings'}}/>);
 await userEvent.setup().click(screen.getByRole('button',{name:'설정'}));
 const dialog=await screen.findByRole('dialog',{name:'설정'});
 expect(within(dialog).getByRole('button',{name:'검증 오류 발생'})).toBeVisible();
 expect(dialog).not.toHaveTextContent('가짜 데이터로 만든 화면이에요'); // D-323: the settings window carries no demo notice
 expect(errors).not.toHaveBeenCalled();run.dispose();
});
it.each(['error-provider','error-canvas'] as const)('contains %s outside the provider and starts a fresh execution on retry',async scenario=>{
 vi.spyOn(console,'error').mockImplementation(()=>{});
 const run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:timePolicy,clock:()=>0,theme:'light'});beginDashboard(run,'cafe');run.actions.startWithThree();const id=run.getState().runId;
 render(<App run={run} verification={{scenario,initialFailure:true}}/>);
 expect(screen.getByRole('heading',{name:'화면을 보여 주지 못했어요'})).toBeInTheDocument();expect(screen.queryByRole('button',{name:'설정'})).toBeNull();
 await userEvent.setup().click(screen.getByRole('button',{name:'다시 시작하기'}));
 expect(run.getState().runId).not.toBe(id);expect(run.getState().panels).toEqual([]);expect(await screen.findByRole('heading',{name:'어떤 가게를 하세요?'})).toBeInTheDocument();run.dispose();
});
