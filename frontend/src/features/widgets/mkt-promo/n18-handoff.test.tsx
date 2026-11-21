import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DetailRef } from '../../../contracts';
import { MONTH_START } from '../../../data/widget-data';
import { renderWithKit } from '../../../ui/test-utils';
import { customerGroups } from '../mkt-coupon/customer-groups';
import { MarketingPerformanceDetail, previousMonthRange } from './marketing-performance';
import { PromoVideoDetail } from './promo-video';
import { makeHost } from './test-helpers';

afterEach(() => { cleanup(); vi.useRealTimers(); });

/** N18 handoffs: a Navis entry names the tab, the group and the period; the owner can still change them afterwards. */
describe('N18 widget handoffs', () => {
  const performance = (detailRef: DetailRef) => renderWithKit(
    <MarketingPerformanceDetail featureId="marketing-performance" condition={{ kind: 'default' }} detailRef={detailRef} host={makeHost()} />);

  it('opens 마케팅 성과 on the 영상별 tab and on last month from the entry', () => {
    performance({ featureId: 'marketing-performance', view: 'video' });
    expect(screen.getByRole('tab', { name: '영상별' })).toHaveAttribute('aria-selected', 'true');
    cleanup();
    performance({ featureId: 'marketing-performance', view: 'coupon', condition: { kind: 'dateRange', ...previousMonthRange(MONTH_START) } });
    expect(screen.getByRole('tab', { name: '쿠폰별' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('radio', { name: '지난달' })).toBeChecked();
  });

  it('keeps the route tab and this month for an entry without them', () => {
    performance({ featureId: 'marketing-performance', view: 'route', focus: 'action' });
    expect(screen.getByRole('tab', { name: '경로별' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('radio', { name: '이번 달' })).toBeChecked();
  });

  it('opens 손님 그룹 on the group named by the entry, and reach-out on the churn-risk tab', () => {
    const Detail = customerGroups.Detail!;
    const open = (view: string) => renderWithKit(<Detail featureId="customer-groups" condition={{ kind: 'default' }} detailRef={{ featureId: 'customer-groups', view }} host={makeHost()} />);
    open('first-visit');
    expect(screen.getByRole('tab', { name: /^첫 방문/u })).toHaveAttribute('aria-selected', 'true');
    cleanup();
    open('regular');
    expect(screen.getByRole('tab', { name: /^단골/u })).toHaveAttribute('aria-selected', 'true');
    cleanup();
    open('reach-out');
    expect(screen.getByRole('tab', { name: /^떠날 수 있는 손님/u })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens the promo window on the step named by the entry and moves the focus to that step', () => {
    renderWithKit(<PromoVideoDetail featureId="promo-video" condition={{ kind: 'default' }} host={makeHost()}
      detailRef={{ featureId: 'promo-video', view: 'create', focus: 'action', prefill: { kind: 'widget-draft', command: 'ui.openDetail', fields: { tab: 2 } } }} />);
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('디자인');
    expect(screen.getByRole('tab', { selected: true })).toHaveFocus();
  });
});
