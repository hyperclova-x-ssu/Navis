import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { useSyncExternalStore } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunStore } from '../../state';
import type { BusinessType, RunStore } from '../../contracts';
import { UiProvider, timePolicy } from '../../ui';
import { screenPresets } from '../../layout/presets';
import { getRegistry } from '../../catalog';
import { OnboardingScreen } from './index';
import { createWidgetDataStore } from '../../data/widget-data';
import { createSessionActions } from '../../app/session-actions';

afterEach(cleanup);
function renderQuestion(presetId: 'A' | 'B') {
  const run = createRunStore({ screenPreset: screenPresets[presetId], catalog: getRegistry(presetId), time: timePolicy, theme: 'light', clock: () => 0 });
  const sessionActions=createSessionActions(run,createWidgetDataStore(undefined,{runId:run.getState().runId}));
  function Harness({ run }: { readonly run: RunStore }) {
    const state = useSyncExternalStore(run.subscribe, run.getState);
    return <UiProvider screenPreset={state.screenPreset} theme={state.theme} textScale={state.textScale} reducedMotion={state.reducedMotion}>{state.screen === 'business-question' ? <OnboardingScreen run={run} sessionActions={sessionActions} /> : <h1>우리 가게</h1>}</UiProvider>;
  }
  render(<Harness run={run} />);
  return run;
}
const cases: readonly [BusinessType, string][] = [['cafe', '카페'], ['restaurant', '음식점'], ['pub', '주점'], ['beauty', '미용·뷰티'], ['retail', '소매'], ['academy', '학원'], ['fitness', '운동'], ['other', '기타']];

describe.each(['A', 'B'] as const)('%s business question', presetId => {
  const setup = () => renderQuestion(presetId);
  it('asks one optional question with eight named cards and no follow-up fields or fake loading', () => {
    setup(); expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('Navis')).toBeVisible();
    const heading=screen.getByRole('heading', { name: '어떤 가게를 하세요?' });
    expect(heading).toBeVisible();expect(heading).toHaveFocus();expect(heading).toHaveAttribute('data-pointer-heading-focus');
    expect(screen.getByText('가게에 맞는 기능을 먼저 보여 드려요')).toBeVisible();
    for (const [, label] of cases) expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '나중에 고를게요' })).toBeVisible();
    expect(screen.queryByText('가짜 데이터로 만든 화면이에요')).not.toBeInTheDocument(); // D-323
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText('화면을 준비하고 있어요')).toBeNull();
  });
  it.each(cases)('chooses %s and completes the staged empty start', async (type, label) => {
    const run = setup(); await userEvent.setup().click(screen.getByRole('button', { name: label }));
    expect(run.getState().onboarding.draft.businessType).toBe(type);
    await userEvent.setup().click(screen.getByRole('radio',{name:/선불형/}));
    await userEvent.setup().click(screen.getByRole('button',{name:/빈 화면으로 시작하기/}));
    expect(run.getState().businessType).toBe(type);
    expect(run.getState().screen).toBe('dashboard');
    expect(run.getState().panels).toEqual([]);
    expect(screen.getByRole('heading', { name: '우리 가게' })).toBeVisible();
    expect(screen.queryByText('어떤 가게를 하세요?')).toBeNull();
  });
  it('allows skip without selecting a business', async () => {
    const run = setup(); await userEvent.setup().click(screen.getByRole('button', { name: '나중에 고를게요' }));
    expect(run.getState().businessType).toBeNull(); expect(run.getState().onboarding.step).toBe('payment');
    await userEvent.setup().click(screen.getByRole('radio',{name:/선불형/}));
    await userEvent.setup().click(screen.getByRole('button',{name:/빈 화면으로 시작하기/}));
    expect(run.getState().screen).toBe('dashboard');
  });
  it('keeps display mode in settings and does not commit a business', () => {
    const run = setup(); expect(screen.queryByRole('button', { name: '다크로 보기' })).toBeNull();
    expect(run.getState().theme).toBe('light'); expect(run.getState().businessType).toBeNull();
  });
  it('shows immediate press feedback and cancels without selecting', () => {
    const run = setup(); const card = screen.getByRole('button', { name: '카페' });
    fireEvent.pointerDown(card, { pointerId: 1, button: 0 }); expect(card).toHaveAttribute('data-pressed', 'true');
    fireEvent.pointerCancel(card, { pointerId: 1 }); expect(card).not.toHaveAttribute('data-pressed', 'true');
    expect(run.getState().screen).toBe('business-question');
  });
  it('starts a fresh question on a new run and retains no business or panels', async () => {
    const run = setup(); await userEvent.setup().click(screen.getByRole('button', { name: '카페' }));
    await userEvent.setup().click(screen.getByRole('radio',{name:/선불형/}));
    await userEvent.setup().click(screen.getByRole('button',{name:/빈 화면으로 시작하기/}));
    act(() => { run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'margin' }); });
    expect(run.getState().panels).toHaveLength(1);
    act(() => run.actions.resetRun({ screenPreset: screenPresets[presetId], catalog: getRegistry(presetId), theme: 'dark' }));
    const heading=screen.getByRole('heading', { name: '어떤 가게를 하세요?' });
    expect(heading).toBeVisible();expect(heading).toHaveFocus();expect(heading).toHaveAttribute('data-pointer-heading-focus');
    expect(run.getState().businessType).toBeNull(); expect(run.getState().panels).toEqual([]);
  });
});

describe('business cards are the kit BusinessCard in every language (T-055: the translated copy is gone)', () => {
  it.each(['ko', 'en', 'zh-Hans', 'zh-Hant'] as const)('%s: each card is the kit card with the kit business name, and settings names the chosen business the same way', async locale => {
    const { I18nProvider } = await import('../../i18n');
    const { createKitTranslator } = await import('../../ui/messages');
    const { SettingsOverlay } = await import('../settings');
    const kit = createKitTranslator(locale);
    const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, theme: 'light', clock: () => 0 });
    const types: readonly BusinessType[] = ['cafe', 'restaurant', 'pub', 'beauty', 'retail', 'academy', 'fitness', 'other'];
    const view = render(<I18nProvider locale={locale}><UiProvider screenPreset={screenPresets.A}><OnboardingScreen run={run} /></UiProvider></I18nProvider>);
    const cards = Array.from(document.querySelectorAll<HTMLButtonElement>('.ui-business-card'));
    expect(cards.map(card => card.querySelector('.ui-business-card__label')?.textContent)).toEqual(types.map(type => kit.t(`ui.business.${type}`)));
    view.unmount();
    act(() => { run.actions.chooseBusiness('beauty'); run.actions.setOnboardingAnswer({paymentStyle:'prepaid'}); run.actions.startEmpty(); run.actions.openSettings(); });
    render(<I18nProvider locale={locale}><UiProvider screenPreset={screenPresets.A}><SettingsOverlay run={run} /></UiProvider></I18nProvider>);
    expect(document.querySelector('.settings-business-select .ui-list-select-row__value')?.textContent).toBe(kit.t('ui.business.beauty'));
    run.dispose();
  });
});
