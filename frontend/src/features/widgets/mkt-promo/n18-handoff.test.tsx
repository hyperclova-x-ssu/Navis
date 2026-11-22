import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { customerGroups } from '../mkt-coupon/customer-groups';
import { PromoVideoDetail } from './promo-video';
import { makeHost } from './test-helpers';

afterEach(() => { cleanup(); vi.useRealTimers(); });

/** N18 handoffs: a Navis entry names the tab and the group; the owner can still change them afterwards. (The 마케팅 성과 window is gone, D-365.) */
describe('N18 widget handoffs', () => {
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
