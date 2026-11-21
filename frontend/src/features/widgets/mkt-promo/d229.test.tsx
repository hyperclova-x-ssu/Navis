import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, renderHook, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FeaturePanel } from '../../../ui';
import { KitProviders, renderWithKit } from '../../../ui/test-utils';
import type { CellSpan, FeatureId, WidgetModule } from '../../../contracts';
import { runFit } from '../mgmt-money/fit';
import { widgets as promo } from './index';
import { widgets as coupon } from '../mkt-coupon';
import { widgets as local } from '../mkt-local';
import { PERFORMANCE_STRIP_FIT } from './fit';
import { useMarketingPerformanceSummary } from './marketing-performance';
import { cafeModel, makeHost, manText } from './test-helpers';

afterEach(cleanup);
const modules: readonly WidgetModule[] = [...promo, ...coupon, ...local];
function statePanel(id: FeatureId, variant: string, width: CellSpan) {
  const Panel = modules.find(m => m.id === id)!.Panel;
  const host = makeHost();
  const result = renderWithKit(<FeaturePanel featureId={id} label="Widget" groupId="customers" width={width} height={1} onOpen={() => {}}><Panel featureId={id} condition={{ kind: 'default' }} width={width} height={1} shape={width === 1 ? 'Q' : 'W'} presetId="A" editing={false} host={host} /></FeaturePanel>, { locale: 'en', preview: { family: 'normal', overrides: { [id]: variant } }, modules });
  return { ...result, host };
}

describe('D-229 compact states', () => {
  it.each(['marketing-performance', 'marketing-today', 'promo-video', 'slot-coupon', 'expiry-coupon', 'coupon-status', 'customer-groups', 'local-changes', 'ai-response'] as const)('%s preserves the full error description and retry', id => {
    for (const width of [1, 2, 3] as const) {
      const { container, host } = statePanel(id, 'error', width);
      const message = container.querySelector('.ui-panel-state__message')!;
      if (width <= 2) {
        expect(message).toHaveTextContent('불러오지 못했어요');
        expect(message).toHaveAttribute('lang', 'ko');
        const hit = container.querySelector('.ui-panel-hit')!;
        const description = container.querySelector('.ui-panel-state__description')!;
        expect(description).toHaveTextContent(/couldn.t load/i);
        expect(hit.getAttribute('aria-describedby')?.split(' ')).toContain(description.id);
      } else {
        expect(message).toHaveTextContent(/couldn.t load/i);
        expect(container.querySelector('.ui-panel-state__description')).toBeNull();
      }
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
      expect(host.resetPreview).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });
  it('keeps the disconnected full description and connect action', () => {
    for (const width of [1, 2, 3] as const) {
      const { container, host } = statePanel('ai-response', 'channel-disconnected', width);
      const message = container.querySelector('.ui-panel-state__message')!;
      if (width <= 2) {
        expect(message).toHaveTextContent('연결된 채널이 없어요');
        expect(message).toHaveAttribute('lang', 'ko');
        const description = container.querySelector('.ui-panel-state__description')!;
        expect(description).toHaveTextContent('Channel not connected');
        expect(container.querySelector('.ui-panel-hit')!.getAttribute('aria-describedby')?.split(' ')).toContain(description.id);
      } else expect(message).toHaveTextContent('Channel not connected');
      fireEvent.click(screen.getByRole('button', { name: /connect/i }));
      expect(host.resetPreview).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });
});

describe('D-229 fit and copy', () => {
  it('uses short English weekdays only in 1x1', () => {
    // The quiet window comes from the cafe seed (the next quiet hour of the demo day), not from a literal.
    const slot = cafeModel('marketing-today').cells.find(cell => cell.kind === 'quiet-hours')!.quietSlot;
    const day = (locale: string, style: 'short' | 'long') => new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(new Date(`${slot.date}T00:00:00Z`));
    for (const [locale, width, text] of [
      ['en', 1, `${day('en', 'short')} ${slot.startHour}–${slot.endHour} is quiet`],
      ['en', 2, `${day('en', 'long')} ${slot.startHour}–${slot.endHour} is quiet`],
      ['ko', 1, `${day('ko', 'long')} ${slot.startHour}~${slot.endHour}시가 한산해요`],
      ['zh-Hans', 1, `${day('zh-Hans', 'long')} ${slot.startHour}~${slot.endHour} 点比较清闲`],
    ] as const) {
      const Panel = promo.find(m => m.id === 'marketing-today')!.Panel;
      renderWithKit(<Panel featureId="marketing-today" condition={{kind:'default'}} width={width} height={1} shape={width === 1 ? 'Q' : 'W'} presetId="A" editing={false} host={makeHost()} />, { locale });
      expect(screen.getByText(text)).toBeInTheDocument();
      cleanup();
    }
  });
  it('hides and restores the entire strip change group as one fit step', () => {
    expect(PERFORMANCE_STRIP_FIT.slice(0, 3).map(part => part.selector)).toEqual(['.mp-block__sub', '.mp-block__note', '.mp-strip__deltas']);
    const Panel = promo.find(m => m.id === 'marketing-performance')!.Panel;
    const { container } = renderWithKit(<div data-testid="fit-content"><Panel featureId="marketing-performance" condition={{kind:'default'}} width={4} height={1} shape="W" presetId="A" editing={false} host={makeHost()} /></div>);
    const content = container.querySelector<HTMLElement>('[data-testid=fit-content]')!;
    const perf = cafeModel('marketing-performance');
    // One change line per metric that changed (a metric without a change has none): the cafe's rate and sales moved, the returning share did not.
    expect(content.querySelectorAll('.mp-block__delta')).toHaveLength([perf.rateDelta, perf.revenueDelta, perf.returnRateDelta].filter(delta => delta && delta.value !== 0).length);
    expect(content.querySelectorAll('.mp-block')).toHaveLength(4);
    let fits = false;
    Object.defineProperty(content, 'clientHeight', { value: 100 });
    Object.defineProperty(content, 'scrollHeight', { get: () => fits || content.querySelector('.mp-strip__deltas[data-fit-hidden]') ? 100 : 120 });
    runFit(content, PERFORMANCE_STRIP_FIT);
    expect(content.querySelector('.mp-strip__deltas')).toHaveAttribute('data-fit-hidden');
    expect(content.querySelector('.mp-block ~ .mp-block')).not.toHaveAttribute('data-fit-hidden');
    fits = true;
    runFit(content, PERFORMANCE_STRIP_FIT);
    expect(content.querySelector('.mp-strip__deltas')).not.toHaveAttribute('data-fit-hidden');
  });
  it('describes all four metric names, values and available changes', () => {
    const { result } = renderHook(() => useMarketingPerformanceSummary({ featureId: 'marketing-performance', condition: {kind:'default'} }), {wrapper: ({children}) => <KitProviders>{children}</KitProviders>});
    const perf = cafeModel('marketing-performance');
    const arrow = (value: number) => (value > 0 ? '▲' : '▼');
    expect(result.current).toContain(`쿠폰 사용률 ${perf.rate}% ${arrow(perf.rateDelta!.value)}${Math.abs(perf.rateDelta!.value)}%p`);
    expect(result.current).toContain(`홍보로 생긴 매출 ${manText(perf.revenue.total)} ${arrow(perf.revenueDelta!.value)}${manText(perf.revenueDelta!.value)}`);
    expect(result.current).toContain(`할인 후 실제 이익 ${manText(perf.profit)}`);
    // The summary exposes the missing return metric without an arrow.
    expect(result.current).toContain('다시 온 손님 알 수 없어요');
    expect(result.current).not.toMatch(/다시 온 손님 \d+% [▲▼]/);
  });
});
