import '../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { getRegistry } from '../catalog';
import { getManagementTemplates } from '../catalog/management-templates';
import { createPortTransport } from '../data/reality/00/transport';
import { fakeBackend } from '../data/reality/00/testing';
import manifest from '../data/db/generated/manifest.json';
import { screenPresets } from '../layout';
import { createRunStore } from '../state';
import { timePolicy } from '../ui';
import { AccountProvider } from './account-context';
import { buildAccountHost } from './account-host';
import { App } from './App';
import { beginDashboard } from './test-session';

afterEach(cleanup);
const makeRun = () => createRunStore({
  screenPreset: screenPresets.A, catalog: getRegistry('A'), time: timePolicy,
  clock: () => 0, theme: 'light', reducedMotion: true,
});

it.each(['fixture', 'http'] as const)('restarts through the same screens in %s mode and preserves the café records', async mode => {
  const backend = fakeBackend(manifest.store.storeId);
  const run = makeRun();
  beginDashboard(run, 'cafe');
  run.actions.applyLayoutIntent({ type: 'add-tap', featureId: 'tax' });
  const original = run.getState();
  let profile = {
    storeId: backend.storeId, name: '안숭잘부 카페', businessType: 'cafe', paymentStyle: 'prepaid',
    tableLayout: null, onboardingDone: true, revision: 2,
  };
  const prefs = { theme: 'light', textScale: 100, locale: 'ko', revision: 0 };
  let board = { boardId: 'management', pages: original.boards.management.pages, currentPage: 0, revision: 1 };
  const receipt = (resourceId: string, revision: number) => ({ resourceId, revision, receiptId: resourceId, affectedSources: ['account'] });
  backend.on('GET', '/profile', () => profile);
  backend.on('GET', '/preferences', () => prefs);
  backend.on('GET', '/boards', () => ({ items: [board] }));
  backend.on('GET', '/api/v1/stores', () => ({ items: [{ storeId: backend.storeId, name: profile.name, role: 'owner', current: true }] }));
  backend.on('PATCH', '/profile', call => {
    const { onboardingDone, expectedRevision } = call.body as { onboardingDone: boolean; expectedRevision: number };
    expect(expectedRevision).toBe(profile.revision);
    profile = { ...profile, onboardingDone, revision: profile.revision + 1 };
    return receipt('profile', profile.revision);
  });
  backend.on('PUT', '/boards/management', call => {
    const { pages, currentPage, expectedRevision } = call.body as Pick<typeof board, 'pages' | 'currentPage'> & { expectedRevision: number };
    expect(expectedRevision).toBe(board.revision);
    board = { ...board, pages, currentPage, revision: board.revision + 1 };
    return receipt('management', board.revision);
  });

  const transport = createPortTransport(backend.fetch);
  const account = mode === 'http' ? buildAccountHost(run, { restart() {}, retry() {} }, transport) : null;
  if (account) { await account.load(); account.attach(); }
  const before = run.getState();
  const user = userEvent.setup();
  const writes = () => backend.calls.filter(call => !['GET', 'HEAD'].includes(call.method));
  render(<AccountProvider host={account}><App run={run} manageLifecycle={false} /></AccountProvider>);
  try {
    await user.click(screen.getByRole('button', { name: '설정' }));
    const settings = await screen.findByRole('dialog', { name: '설정' });
    const restart = within(settings).getByRole('button', { name: /^처음부터 다시 보기/ });
    expect(within(settings).getAllByRole('button').at(-1)).toBe(restart);
    await user.click(restart);
    const confirm = await screen.findByRole('alertdialog');
    await user.keyboard('{Escape}');
    expect(confirm).not.toBeInTheDocument();
    expect(writes()).toEqual([]);
    expect(run.getState().screen).toBe('dashboard');
    await user.click(restart);
    const proceed = within(await screen.findByRole('alertdialog')).getByRole('button', { name: '처음부터 다시 보기' });
    act(() => { fireEvent.click(proceed); fireEvent.click(proceed); });

    expect(await screen.findByRole('heading', { name: '어떤 가게를 하세요?' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '어떤 화면으로 시작할까요?' })).not.toBeInTheDocument();
    if (account) {
      expect(writes().map(({ path, body }) => [path, body])).toEqual([
        ['/profile', { onboardingDone: false, expectedRevision: 2 }],
      ]);
      const interrupted = makeRun();
      const interruptedHost = buildAccountHost(interrupted, { restart() {}, retry() {} }, transport);
      try {
        await interruptedHost.load();
        expect(interrupted.getState()).toMatchObject({ businessType: 'cafe', screen: 'business-question', onboarding: { step: 'business' } });
        interrupted.actions.chooseBusiness('beauty');
        expect(interrupted.getState().onboarding.step).toBe('start');
      } finally { interruptedHost.dispose(); interrupted.dispose(); }
    }
    await user.click(screen.getByRole('button', { name: '미용·뷰티' }));
    expect(await screen.findByRole('heading', { name: '어떤 화면으로 시작할까요?' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: '손님이 언제 계산하나요?' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /^B 재고·발주 중심/ }));
    const start = screen.getByRole('button', { name: '이 화면으로 시작하기' });
    act(() => { fireEvent.click(start); fireEvent.click(start); });
    expect(await screen.findByText('안숭잘부 카페 데이터를 불러오고 있어요')).toBeVisible();
    expect(screen.queryByRole('heading', { name: '안숭잘부 카페', level: 1 })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: '안숭잘부 카페', level: 1 })).toBeVisible(), { timeout: 5000 });
    const expected = getManagementTemplates({ businessType: 'beauty', paymentStyle: 'prepaid', presetId: 'A' })
      .find(template => template.id === 'B')!.panels;
    const after = run.getState();
    expect(after.panels.map(panel => panel.featureId)).toEqual(expected.map(panel => panel.featureId));
    expect(after.shopSettings).toBe(before.shopSettings);
    expect(after.pos).toBe(before.pos);
    expect(after.runId).toBe(before.runId);
    if (account) {
      expect(writes().map(({ path }) => path)).toEqual(['/profile', '/boards/management', '/profile']);
      expect(writes().at(-1)?.body).toEqual({ onboardingDone: true, expectedRevision: 3 });
      const reloaded = makeRun();
      const reloadedHost = buildAccountHost(reloaded, { restart() {}, retry() {} }, transport);
      try {
        await reloadedHost.load();
        expect(reloaded.getState()).toMatchObject({ screen: 'dashboard', businessType: 'cafe', panels: after.panels });
      } finally { reloadedHost.dispose(); reloaded.dispose(); }
    } else expect(writes()).toEqual([]);
  } finally {
    cleanup();
    account?.dispose();
    run.dispose();
  }
});
