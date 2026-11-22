/** FIX-RV3 (RV-REALVERIFY-3): the grants window keeps its original list column in HTTP mode; the Financial Center rows and the notice fetch sit inside it. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import type { WidgetHost } from '../../../contracts';
import { GrantsDetail } from './grants';
import { grant, insightSession, updatedAt } from '../../../data/reality/11/testing';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
const detail = <GrantsDetail featureId="grants" condition={{ kind: 'default' }} detailRef={{ featureId: 'grants' }} host={host} />;

it('lists official notices and Financial Center recommendations under the one original heading, without a source filter', async () => {
  const { backend, collections, newStore } = insightSession();
  collections.set('grant-notices', [grant]);
  const path = '/insight/financial-center/recommendations';
  const row = { ref: 'policy-2026', title: '소상공인 정책자금', source: 'naver-financial-center', officialNoticeUrl: 'https://www.semas.or.kr/', endDate: '2026-12-31' };
  backend.on('GET', path, () => ({ state: 'ready', items: [row], source: row.source, sourceUrl: 'https://help.admin.pay.naver.com/faq/content.help?faqId=13148', asOf: updatedAt, nextCursor: null, sourceRevision: 'test' }));
  renderWithKit(detail, { store: newStore() });
  const recommendation = await screen.findByRole('button', { name: /소상공인 정책자금/u });
  // One list column under the original heading ("마감 가까운 순"): no filter chips, no second heading.
  expect(screen.getAllByRole('heading', { name: '마감 가까운 순' })).toHaveLength(1);
  expect(screen.queryByRole('radio', { name: '전체' })).toBeNull();
  expect(screen.queryByRole('radiogroup')).toBeNull();
  expect(screen.queryByRole('heading', { name: '지역·업종이 맞는 공고' })).toBeNull();
  expect(screen.queryByRole('heading', { name: '네이버 금융센터 추천' })).toBeNull();
  const column = recommendation.closest('.ui-master-detail__list') as HTMLElement;
  expect(column).toBeInTheDocument();
  // The official notice and the recommendation are both rows of that column, and the fetch action sits at its end.
  expect(within(column).getByRole('button', { name: /매장 설비 개선 지원/u })).toBeInTheDocument();
  expect(within(column).getByText('네이버 금융센터')).toBeInTheDocument();
  expect(within(column).getByRole('button', { name: '공고 불러오기' })).toBeInTheDocument();
  expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});
