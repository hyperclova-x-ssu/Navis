import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FeaturePanel } from '../../../ui';
import { renderWithKit } from '../../../ui/test-utils';
import type { CellSpan, FeatureId, WidgetModule } from '../../../contracts';
import { widgets as promo } from './index';
import { widgets as coupon } from '../mkt-coupon';
import { widgets as local } from '../mkt-local';
import { cafeModel, makeHost } from './test-helpers';

afterEach(cleanup);
const modules: readonly WidgetModule[] = [...promo, ...coupon, ...local];
function statePanel(id: FeatureId, variant: string, width: CellSpan) {
  const Panel = modules.find(m => m.id === id)!.Panel;
  const host = makeHost();
  const result = renderWithKit(<FeaturePanel featureId={id} label="Widget" groupId="customers" width={width} height={1} onOpen={() => {}}><Panel featureId={id} condition={{ kind: 'default' }} width={width} height={1} shape={width === 1 ? 'Q' : 'W'} presetId="A" editing={false} host={host} /></FeaturePanel>, { locale: 'en', preview: { family: 'normal', overrides: { [id]: variant } }, modules });
  return { ...result, host };
}

describe('D-229 compact states', () => {
  it.each(['marketing-today', 'promo-video', 'slot-coupon', 'expiry-coupon', 'coupon-status', 'customer-groups', 'local-changes', 'ai-response'] as const)('%s preserves the full error description and retry', id => {
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
});
