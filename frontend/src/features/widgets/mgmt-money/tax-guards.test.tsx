/** GD-1: the 세무관리 panel and detail read one "next due" selector, and a repeated payment is surfaced before it is added. */
import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithKit } from '../../../ui/test-utils';
import { addDays } from '../../../data/db/time';
import { createWidgetDataStore, TODAY } from '../../../data/widget-data';
import { plainText } from '../../../data/commands/management-guards';
import type { WidgetHost } from '../../../contracts';
import { TaxDetail, TaxPanel } from './tax';

afterEach(cleanup);
const host: WidgetHost = { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() };
/** The short date format ("10/24(토)"): month/day with the weekday in brackets. */
const shortDate = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}(`;
/** The calendar's day button name: "12월 10일 목요일". */
const longDate = (iso: string) => `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일 ${'일월화수목금토'[new Date(`${iso}T00:00:00Z`).getUTCDay()]}요일`;
/** Picks a day with the due-date field's calendar (the field never takes typed ISO text), paging forward from today's month. */
async function pickDue(iso: string) {
  await userEvent.click(within(document.querySelector('tr.ui-grid-new-row') as HTMLElement).getByRole('button', { name: /^납부 기한/ }));
  const calendar = within(screen.getByRole('dialog'));
  for (let page = 0; page < 14 && !calendar.queryByRole('button', { name: longDate(iso) }); page++) await userEvent.click(calendar.getByRole('button', { name: '다음 달' }));
  await userEvent.click(calendar.getByRole('button', { name: longDate(iso) }));
}

describe('next due is the earliest unpaid date, in the panel and in the detail', () => {
  const withEarlierRow = () => {
    const store = createWidgetDataStore(), earlier = addDays(TODAY, -2);
    const type = store.getSnapshot().tables.taxPayment.find((p) => p.status === 'unpaid')!;
    const result = store.dispatch({ type: 'tax.createPayment', taxType: '지방세 추가분', amount: 77_000, dueOn: earlier, idempotencyKey: 'gd1-tax-earlier' });
    expect(result.ok).toBe(true);
    expect(type).toBeTruthy();
    return { store, earlier };
  };
  it('the detail shows 다음 납부는 …까지예요 for the earliest unpaid row, not the first row of the table', async () => {
    const { store, earlier } = withEarlierRow();
    renderWithKit(<TaxDetail featureId="tax" condition={{ kind: 'default' }} detailRef={{ featureId: 'tax' }} host={host} />, { store, reducedMotion: true });
    await userEvent.click(screen.getByRole('tab', { name: '세금 납부 이력' }));
    expect(document.querySelector('[data-slot="tax.nextDue"]')).toHaveTextContent(`다음 납부는 ${shortDate(earlier)}`);
  });
  it('the panel line (다음 납부 …) names the same date', () => {
    const { store, earlier } = withEarlierRow();
    renderWithKit(<TaxPanel featureId="tax" condition={{ kind: 'default' }} width={2} height={1} shape="W" presetId="A" editing={false} host={host} />, { store, reducedMotion: true });
    expect(screen.getAllByText((content) => content.includes(`다음 납부 ${shortDate(earlier)}`)).length).toBeGreaterThan(0);
  });
});

describe('a repeated payment is surfaced before it is added', () => {
  it('shows the message as an alert, the existing record, and adds it only after 그래도 추가하기', async () => {
    const store = createWidgetDataStore(), row = store.getSnapshot().tables.taxPayment.find((p) => p.status === 'unpaid')!;
    renderWithKit(<TaxDetail featureId="tax" condition={{ kind: 'default' }} detailRef={{ featureId: 'tax' }} host={host} />, { store, reducedMotion: true });
    await userEvent.click(screen.getByRole('tab', { name: '세금 납부 이력' }));
    await userEvent.click(screen.getByRole('button', { name: '납부 기록 추가하기' }));
    await userEvent.type(screen.getByRole('textbox', { name: '세금 종류' }), plainText(row.type));
    await userEvent.type(screen.getByRole('spinbutton', { name: /납부 금액/ }), String(row.amount));
    await pickDue(row.dueOn);
    const before = store.getSnapshot().tables.taxPayment.length;
    await userEvent.click(screen.getByRole('button', { name: '저장하기' }));
    expect(store.getSnapshot().tables.taxPayment.length).toBe(before);
    // T-17: a refusal reads "실행하지 못했어요 · {이유}" (the form already shows its next step, so no second one is added).
    expect(screen.getByText('실행하지 못했어요 · 같은 세금 납부 일정이 있어요. 기존 일정을 확인해 주세요')).toBeInTheDocument();
    expect(document.querySelector('[data-slot="tax.existing"]')).toHaveTextContent(shortDate(row.dueOn));
    expect(host.notify).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'error', messageKey: 'data.management.error.TAX_PAYMENT_EXISTS' }));
    await userEvent.click(screen.getByRole('button', { name: '그래도 추가하기' }));
    expect(store.getSnapshot().tables.taxPayment.length).toBe(before + 1);
    expect(within(document.body).queryByText(/같은 세금 납부 일정이 있어요/)).toBeNull();
  });
});
