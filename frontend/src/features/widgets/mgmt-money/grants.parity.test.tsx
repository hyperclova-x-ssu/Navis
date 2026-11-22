/** FIX-RV3 (RV-REALVERIFY-3): the grants window keeps its original list column in HTTP mode; the Financial Center rows and the notice fetch sit inside it. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import type { WidgetHost } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/db/store';
import { GrantsDetail, GrantsPanel } from './grants';
import { grant, insightSession, updatedAt } from '../../../data/reality/11/testing';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
const detail = <GrantsDetail featureId="grants" condition={{ kind: 'default' }} detailRef={{ featureId: 'grants' }} host={host} />;

it('lists official notices and Financial Center recommendations in one list column with a named recommendation group', async () => {
  const { backend, collections, newStore } = insightSession();
  collections.set('grant-notices', [grant]);
  const path = '/insight/financial-center/recommendations';
  const row = { ref: 'policy-2026', title: '소상공인 정책자금', source: 'naver-financial-center', officialNoticeUrl: 'https://www.semas.or.kr/', endDate: '2026-12-31' };
  backend.on('GET', path, () => ({ state: 'ready', items: [row], source: row.source, sourceUrl: 'https://help.admin.pay.naver.com/faq/content.help?faqId=13148', asOf: updatedAt, nextCursor: null, sourceRevision: 'test' }));
  renderWithKit(detail, { store: newStore() });
  const recommendation = await screen.findByRole('button', { name: /소상공인 정책자금/u });
  // One list column under the original heading, with a separate source label.
  expect(screen.getAllByRole('heading', { name: '마감 가까운 순' })).toHaveLength(1);
  expect(screen.queryByRole('radio', { name: '전체' })).toBeNull();
  expect(screen.queryByRole('radiogroup')).toBeNull();
  expect(screen.queryByRole('heading', { name: '지역·업종이 맞는 공고' })).toBeNull();
  expect(screen.getByRole('heading', { name: '네이버 금융센터 추천' })).toBeVisible();
  const column = recommendation.closest('.ui-master-detail__list') as HTMLElement;
  expect(column).toBeInTheDocument();
  // The official notice and the recommendation are both rows of that column, and the fetch action sits at its end.
  expect(within(column).getByRole('button', { name: /매장 설비 개선 지원/u })).toBeInTheDocument();
  expect(within(column).getByText('네이버 금융센터')).toBeInTheDocument();
  expect(within(column).getByRole('button', { name: '공고 불러오기' })).toBeInTheDocument();
  expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});
it('shares the numeric grants panel, notice actions, draft actions and applications columns in both modes', async () => {
  const { newStore, backend, collections } = insightSession();
  backend.on('GET', '/insight/financial-center/recommendations', () => ({ state: 'ready', items: [], asOf: updatedAt }));
  collections.set('grant-notices', [grant]);
  const structures = [];
  for (const mode of ['http', 'fixture'] as const) {
    const store = mode === 'http' ? newStore() : createWidgetDataStore();
    const { container } = renderWithKit(<><GrantsPanel featureId="grants" condition={{ kind: 'default' }} host={host} width={1} height={1} shape="Q" editing={false} presetId="A" />{detail}</>, { store });
    await screen.findByRole('heading', { name: '마감 가까운 순' });
    const tabs = screen.getAllByRole('tab');
    const notice = {
      sync: Boolean(screen.queryByRole('button', { name: '공고 불러오기' })),
      detailActions: Array.from(container.querySelectorAll('[data-slot="grants.item"] .mm-actions > *'), node => node.textContent?.replace(/공식 공고 (보기|열기)/u, '공식 공고')),
    };
    fireEvent.click(tabs[1]!);
    const draft = Array.from(container.querySelectorAll('.mm-grant-draft .mm-actions button, .mm-grant-draft__actions button'), node => node.textContent);
    fireEvent.click(tabs[2]!);
    structures.push({
      metric: container.querySelector('[data-slot="grants.metric.value"]')?.textContent,
      tabs: tabs.map(tab => tab.textContent), notice, draft,
      columns: screen.getAllByRole('columnheader').map(node => node.textContent),
    });
    cleanup();
  }
  expect(structures[0]?.metric).toMatch(/0\s*건/);
  expect(structures[0]?.notice).toEqual(structures[1]?.notice);
  expect(structures[0]?.draft).toEqual(structures[1]?.draft);
  expect(structures[0]?.tabs).toEqual(structures[1]?.tabs);
  expect(structures[0]?.columns).toEqual(structures[1]?.columns);
  expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});
