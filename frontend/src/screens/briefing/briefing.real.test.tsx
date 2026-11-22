// REAL-PLAN F12: the arrival card over HTTP withholds what the service cannot vouch for, and the explicit acknowledgement made outside the
// detail (the Navis card sets the run flag) reaches the service once; closing the arrival card never does.
import { beginDashboard } from '../../app/test-session';
import '../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { getRegistry } from '../../catalog';
import { WidgetDataProvider } from '../../data/react';
import { reply } from '../../data/reality/00/testing';
import { briefingDay, briefingSession } from '../../data/reality/12/testing';
import { I18nProvider } from '../../i18n';
import { screenPresets } from '../../layout/presets';
import { createRunStore, selectCommonNotice } from '../../state';
import { UiProvider, timePolicy } from '../../ui';
import { BriefingOverlay } from './index';

afterEach(cleanup);

/** A run past its coaching, as the arrival card needs it, mounted with a data store of the test's choosing. */
function setup(session = briefingSession(), shown = true) {
  let now = 0;
  const run = createRunStore({ screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy, clock: () => now, theme: 'light', reducedMotion: true });
  const advance = (ms: number) => act(() => { now += ms; run.actions.tick(); });
  act(() => { beginDashboard(run, 'cafe'); run.actions.visualSettled(); }); advance(400);
  act(() => { run.actions.dismissCoach(); run.actions.startWithThree(); run.actions.visualSettled(); }); advance(200);
  for (let i = 0; i < 12 && (run.getState().guidance.active || run.getState().guidance.activeWidget || run.getState().guidance.queue.length || run.getState().guidance.widgetQueue.length); i += 1) { act(() => run.actions.dismissCoach()); advance(300); }
  act(() => { run.actions.clearNotice(); run.actions.finishEditing(); });
  if (shown) advance(1300);
  render(<I18nProvider locale="ko"><WidgetDataProvider store={session.store}><UiProvider screenPreset={screenPresets.A} theme="light" reducedMotion><BriefingOverlay run={run} /></UiProvider></WidgetDataProvider></I18nProvider>);
  return { run, advance, ...session };
}

describe('arrival briefing over the service projection', () => {
  it('says what is not connected instead of showing rows the seed holds, and drops the alerts of a source that is not connected', async () => {
    const { run } = setup();
    expect(run.getState().overlay.type).toBe('briefing');
    const card = await screen.findByRole('dialog', { name: '오늘 가게 소식이에요' });
    await waitFor(() => expect(within(card).getAllByRole('note').some(note => /예약\s·\s아직 연결 전이에요/.test(note.textContent ?? ''))).toBe(true));
    expect(card).not.toHaveTextContent('오늘 4건 · 10명');
    expect(card).not.toHaveTextContent('세금 납부');
    expect(within(card).getAllByRole('note').some(note => /세금\s·\s아직 연결 전이에요/.test(note.textContent ?? ''))).toBe(true);
  });

  it('sends one acknowledgement when the run flag is set by an explicit press outside the detail, and none when the service already holds it', async () => {
    const first = setup(briefingSession(), false);
    act(() => first.run.actions.acknowledgeBriefing());
    await waitFor(() => expect(first.state.acknowledgements).toBe(1));
    expect(first.backend.callsTo('POST', `/insight/briefings/${briefingDay}/ack`)).toHaveLength(1);
    cleanup();
    const held = briefingSession();
    held.state.acknowledgement = { acknowledgedAt: `${briefingDay}T08:00:00Z`, receiptId: 'ack-receipt-0' };
    const second = setup(held, false);
    act(() => second.run.actions.acknowledgeBriefing());
    await waitFor(() => expect(second.backend.callsTo('GET', '/insight/briefings').length).toBeGreaterThan(0));
    expect(second.backend.callsTo('POST', /\/ack$/)).toHaveLength(0);
  });

  it('never acknowledges by closing the arrival card', async () => {
    const { run, backend, advance } = setup();
    await screen.findByRole('dialog', { name: '오늘 가게 소식이에요' });
    act(() => { run.actions.closeOverlay('button'); });
    advance(1000);
    expect(run.getState().briefing).toBe('dismissed');
    expect(backend.callsTo('POST', /\/ack$/)).toHaveLength(0);
  });

  it('tells the owner when the confirmation could not be recorded', async () => {
    const session = briefingSession();
    session.backend.on('POST', /\/ack$/, () => reply(409, { code: 'BRIEFING_DAY_CHANGED', reason: 'BRIEFING_DAY_CHANGED' }));
    const { run } = setup(session, false);
    act(() => run.actions.acknowledgeBriefing());
    await waitFor(() => expect(selectCommonNotice(run.getState())).toMatchObject({ kind: 'error', messageKey: 'briefing.error.dayChanged' }));
  });

  it('does nothing over HTTP in a fixture build', async () => {
    const session = briefingSession({ source: 'fixture' });
    const { run } = setup(session, false);
    act(() => run.actions.acknowledgeBriefing());
    await act(async () => { await Promise.resolve(); });
    expect(session.backend.calls.filter(call => call.path.startsWith('/insight'))).toHaveLength(0);
  });
});
