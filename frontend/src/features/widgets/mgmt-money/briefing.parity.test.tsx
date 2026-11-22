/** PAR-1 (D-384, D-355): the 브리핑 window shows the same tabs, sections, source card and buttons over HTTP as with the example data. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { briefingSession } from '../../../data/reality/12/testing';
import { selectAccountingPresentation } from '../../../data/pos/projection';
import { createWidgetDataStore } from '../../../data/widget-data';
import { renderWithKit } from '../../../ui/test-utils';
import { BriefingDetail } from './briefing';
import { AccountingPresentationProvider } from './ledger';
import { structureDifference, windowStructure } from './parity-structure';

afterEach(cleanup);
const host = (): WidgetHost => ({ layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(),
  briefingAcknowledged: { subscribe: () => () => undefined, getSnapshot: () => false } });
/** Headings of lists that only exist when the day has such rows (planned entries, later entries) are data, not structure. */
const DATA_HEADINGS = new Set(['예정된 일정', '다가오는 일정']);

it('shows the same 출근 and 퇴근 sections and the same 출처와 기준 card over HTTP and with the example data', async () => {
  const seen: ReturnType<typeof windowStructure>[][] = [];
  for (const mode of ['http', 'example'] as const) {
    let store;
    if (mode === 'http') {
      const session = briefingSession();
      // Every source connected, as the example day has them.
      session.state.sources = Object.fromEntries(Object.entries(session.state.sources).map(([key, source]) => [key, { ...source, state: 'ready' as const, data: source.data ?? [] }]));
      store = session.store;
    } else store = createWidgetDataStore();
    const { container } = renderWithKit(<AccountingPresentationProvider value={selectAccountingPresentation(store.getSnapshot())}>
      <BriefingDetail featureId="briefing" condition={{ kind: 'default' }} detailRef={{ featureId: 'briefing' }} host={host()} /></AccountingPresentationProvider>, { store, reducedMotion: true });
    await screen.findByRole('region', { name: '출처와 기준' });
    const tabs = [windowStructure(container)];
    fireEvent.click(screen.getByRole('tab', { name: '퇴근' }));
    await waitFor(() => expect(screen.getByRole('tab', { name: '퇴근' })).toHaveAttribute('aria-selected', 'true'));
    tabs.push(windowStructure(container));
    seen.push(tabs.map(tab => ({ ...tab, headings: tab.headings.filter(heading => !DATA_HEADINGS.has(heading)) })));
    cleanup();
  }
  const [http, example] = seen;
  expect(example![0]!.headings).toContain('출처와 기준');
  expect(example![1]!.headings).toEqual(['오늘 결과 요약']);
  http!.forEach((structure, index) => expect(structureDifference(structure, example![index]!), `tab ${index}`).toEqual({}));
}, 60_000);

it('lists the missing value rows (D-386) with a value or a state on each row, the same rows in both modes', async () => {
  const labels: string[][] = [];
  for (const mode of ['http', 'example'] as const) {
    const store = mode === 'http' ? briefingSession().store : createWidgetDataStore();
    renderWithKit(<AccountingPresentationProvider value={selectAccountingPresentation(store.getSnapshot())}>
      <BriefingDetail featureId="briefing" condition={{ kind: 'default' }} detailRef={{ featureId: 'briefing' }} host={host()} /></AccountingPresentationProvider>, { store, reducedMotion: true });
    const card = (await screen.findByRole('heading', { name: '운영 현황' })).closest('section') as HTMLElement;
    const rows = Array.from(card.querySelectorAll('.mm-briefing-row'));
    // G-13: no row without its value or state at the end.
    for (const row of rows) expect(row.querySelector('.mm-briefing-link__value, [class*="status-badge"], .ui-status-badge')).not.toBeNull();
    labels.push(rows.map(row => row.querySelector('.mm-briefing-link__text')?.textContent ?? ''));
    if (mode === 'example') {
      expect(card).toHaveTextContent('스마트콜 통화');
      expect(card).toHaveTextContent('리뷰 통계');
      expect(card).not.toHaveTextContent('채널 성과');
      expect(card).toHaveTextContent(/긍정 \d+ · 부정 \d+/);
    }
    cleanup();
  }
  expect(labels[0]).toEqual(labels[1]);
  expect(labels[1]).toEqual(['재고 부족', '매장 환경', 'CCTV 현황', '확인할 지원사업', '스마트콜 통화', '리뷰 통계 · 이틀 전까지의 자료예요']);
}, 60_000);
