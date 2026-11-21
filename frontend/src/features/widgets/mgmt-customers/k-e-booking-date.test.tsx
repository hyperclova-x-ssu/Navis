import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { TODAY } from '../../../data/widget-data';
import { addIsoDays } from '../../../ui';
import { VoiceBookingDetail } from './voice-booking';

/** K-E 12: '내일 예약' from the briefing opens the booking detail on tomorrow (detailRef.date), not today. */
const host = { layer: 'management' as const, resetPreview: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn(), openClosing: vi.fn(() => true) };
afterEach(cleanup);
const open = (date?: string) => renderWithKit(<VoiceBookingDetail featureId="voice-booking" condition={{ kind: 'default' }} detailRef={{ featureId: 'voice-booking', ...(date ? { date } : {}) }} host={host} />);

it('opens on the day the reference names', () => {
  const tomorrow = addIsoDays(TODAY, 1);
  const { container } = open(tomorrow);
  const stepper = container.querySelector('.ui-date-stepper') ?? container;
  expect(stepper.textContent).toMatch(/\d+월 \d+일/);
  // the date stepper shows tomorrow's long date, not today's
  const todayText = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${TODAY}T00:00:00Z`));
  const tomorrowText = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${tomorrow}T00:00:00Z`));
  expect(container.textContent).toContain(tomorrowText);
  expect(screen.queryByText(new RegExp(`${todayText}\\s*[월화수목금토일]요일`))).not.toBeInTheDocument();
});

it('opens on today without a date, and ignores a malformed one', () => {
  const todayText = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${TODAY}T00:00:00Z`));
  const plain = open();
  expect(plain.container.textContent).toContain(todayText);
  cleanup();
  const bad = open('not-a-date');
  expect(bad.container.textContent).toContain(todayText);
});
