import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRunStore } from '../../state';
import { getRegistry } from '../../catalog';
import { screenPresets } from '../../layout/presets';
import { UiProvider, timePolicy } from '../../ui';
import { OnboardingScreen } from './index';

afterEach(cleanup);
describe('단계형 시작 설정', () => {
  it('꺼진 단계를 건너뛰고 추천 템플릿 선택을 주입된 세션에 전달한다', () => {
    const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, theme: 'light', reducedMotion: true, clock: () => 0 });
    const completeOnboarding = vi.fn(() => true);
    render(<UiProvider screenPreset={screenPresets.A} reducedMotion><OnboardingScreen run={run} sessionActions={{ completeOnboarding }} /></UiProvider>);
    fireEvent.click(screen.getByRole('button', { name: '미용·뷰티' }));
    expect(screen.getByRole('heading', { name: '손님이 언제 계산하나요?' })).toHaveFocus();
    expect(screen.getByRole('list', { name: '시작 설정 단계' })).toHaveTextContent('꺼짐');
    fireEvent.click(screen.getByRole('radio', { name: /후불형/ }));
    expect(screen.getByRole('heading', { name: '어떤 화면으로 시작할까요?' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: '이 화면으로 시작하기' }));
    expect(completeOnboarding).toHaveBeenCalledWith('C');
  });
  it('테이블 초안의 키보드 이동과 좌석 수를 다음 단계에 보존한다', async () => {
    const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, theme: 'light', reducedMotion: true, clock: () => 0 });
    render(<UiProvider screenPreset={screenPresets.A} textScale={125} reducedMotion><OnboardingScreen run={run} sessionActions={{ completeOnboarding: () => true }} /></UiProvider>);
    fireEvent.click(screen.getByRole('button', { name: '카페' }));
    fireEvent.click(screen.getByRole('radio', { name: /후불형/ }));
    const tile = screen.getByRole('button', { name: /T1, 2석/ });
    fireEvent.keyDown(tile, { key: 'ArrowLeft' });
    fireEvent.keyDown(tile, { key: '+' });
    fireEvent.click(screen.getByRole('button', { name: '확인' }));
    expect(run.getState().onboarding.draft.tableLayout?.tables[0]).toMatchObject({ column: 0, seats: 3 });
    fireEvent.click(screen.getByRole('button', { name: '이전 단계, 테이블 배치' }));
    await waitFor(()=>expect(screen.getByRole('button', { name: /T1, 3석/ })).toBeVisible());
  });
});

describe('시작 설정 경계',()=>{
  it.each(['cafe','restaurant','pub','beauty','retail','academy','fitness','other',null] as const)('%s 업종의 선불형은 테이블 단계를 건너뛴다',business=>{
    const run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:timePolicy,theme:'light',clock:()=>0});
    render(<UiProvider screenPreset={screenPresets.A}><OnboardingScreen run={run} sessionActions={{completeOnboarding:()=>true}}/></UiProvider>);
    const labels={cafe:'카페',restaurant:'음식점',pub:'주점',beauty:'미용·뷰티',retail:'소매',academy:'학원',fitness:'운동',other:'기타'};
    fireEvent.click(screen.getByRole('button',{name:business?labels[business]:'나중에 고를게요'}));
    fireEvent.click(screen.getByRole('radio',{name:/선불형/}));
    expect(run.getState().onboarding.step).toBe('start');
    fireEvent.click(screen.getByRole('button',{name:'이전 단계, 결제 방식'}));
    expect(screen.getByRole('radio',{name:/선불형/})).toHaveAttribute('aria-checked','true');
  });
  it('결제 방식 방향키는 선택 없이 포커스만 움직인다',()=>{
    const run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:timePolicy,theme:'light',clock:()=>0});
    render(<UiProvider screenPreset={screenPresets.A}><OnboardingScreen run={run}/></UiProvider>);
    fireEvent.click(screen.getByRole('button',{name:'카페'}));
    const first=screen.getByRole('radio',{name:/선불형/}); first.focus();fireEvent.keyDown(first,{key:'ArrowRight'});
    expect(screen.getByRole('radio',{name:/후불형/})).toHaveFocus();
    expect(run.getState().onboarding.step).toBe('payment');
  });
});

it('테이블 수와 전체 및 개별 좌석을 바꾸면 11/30 → 13/34 → 13/52 → 13/50을 유지한다',()=>{
 const run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:timePolicy,theme:'light',reducedMotion:true,clock:()=>0});
 render(<UiProvider screenPreset={screenPresets.A} reducedMotion><OnboardingScreen run={run}/></UiProvider>);
 fireEvent.click(screen.getByRole('button',{name:'카페'}));fireEvent.click(screen.getByRole('radio',{name:/후불형/}));
 expect(screen.getAllByText('테이블 11개 · 30석').length).toBeGreaterThan(0);
 fireEvent.click(screen.getByRole('button',{name:'테이블 수 늘리기'}));fireEvent.click(screen.getByRole('button',{name:'테이블 수 늘리기'}));
 expect(screen.getAllByText('테이블 13개 · 34석').length).toBeGreaterThan(0);
 fireEvent.click(screen.getByRole('button',{name:'모든 테이블 같게 늘리기'}));fireEvent.click(screen.getByRole('button',{name:'모든 테이블 같게 늘리기'}));
 expect(screen.getAllByText('테이블 13개 · 52석').length).toBeGreaterThan(0);
 fireEvent.click(screen.getByRole('button',{name:'T1 줄이기'}));fireEvent.click(screen.getByRole('button',{name:'T1 줄이기'}));
 expect(screen.getAllByText('테이블 13개 · 50석').length).toBeGreaterThan(0);
});

it.each(['cafe','restaurant','pub','beauty','retail','academy','fitness','other',null] as const)('%s 업종의 후불형은 음식 업종만 테이블을 켠다',business=>{
 const run=createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:timePolicy,theme:'light',clock:()=>0});
 render(<UiProvider screenPreset={screenPresets.A}><OnboardingScreen run={run}/></UiProvider>);
 const labels={cafe:'카페',restaurant:'음식점',pub:'주점',beauty:'미용·뷰티',retail:'소매',academy:'학원',fitness:'운동',other:'기타'};
 fireEvent.click(screen.getByRole('button',{name:business?labels[business]:'나중에 고를게요'}));fireEvent.click(screen.getByRole('radio',{name:/후불형/}));
 expect(run.getState().onboarding.step).toBe(business && ['cafe','restaurant','pub'].includes(business)?'tables':'start');
});
