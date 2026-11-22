import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { WidgetHost } from '../../../contracts';
import { createRealPort } from '../../../data/reality/00';
import { autoloadedAdapters } from '../../../data/reality/00/autoload';
import { fakeBackend } from '../../../data/reality/00/testing';
import { createWidgetDataStore, TODAY } from '../../../data/widget-data';
import { renderWithKit } from '../../../ui/test-utils';
import { DetailDialog } from '../../../ui';
import { moneyDomain, projectMoneyFacts } from '../../assistant/domains/money';
import { TaxDetail } from './tax';

afterEach(cleanup);
const asOf = `${TODAY}T06:45:00Z`;
const page = { asOf, sourceRevision: 19, nextCursor: null };
const payment = {
  taxPaymentId: 'payment-1', type: '교육세', amount: 18300, status: 'unpaid', dueOn: TODAY, paidOn: null,
  evidence: 'none', evidenceFiles: [], overdue: false, revision: 2, createdAt: asOf, updatedAt: asOf, paidRecordedAt: null,
};
const review = {
  refId: 'expense-1', expenseId: 'expense-1', refType: 'expense', date: TODAY, amount: 9000,
  memo: '봉투', category: 'supplies', reason: 'missing-evidence', status: 'needs-check', expenseRevision: 4,
  reviewRevision: null, checkedAt: null,
};
const host = (): WidgetHost => ({ layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(() => true),
  openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() });

function session() {
  const store = createWidgetDataStore();
  const backend = fakeBackend();
  const port = createRealPort({ store, fetch: backend.fetch, adapters: autoloadedAdapters(),
    source: domain => domain === 'tax' ? 'http' : 'fixture' });
  store.bindReal(port);
  backend.on('GET', '/pos/tax-payments', () => ({ ...page, today: TODAY, items: [payment] }));
  backend.on('GET', '/pos/tax-reviews', call => ({ ...page, ...call.query, reviewCount: call.query.to === TODAY ? 1 : 0,
    items: call.query.to === TODAY ? [review] : [] }));
  backend.on('GET', '/pos/tax-exports/preview', call => ({
    ...page, ...call.query, connections: [], officialLinks: { hometax: 'https://www.hometax.go.kr/' }, estimate: null,
    preview: { sales: { total: 12000 }, deposits: { total: 16000 }, expenses: { total: 9000, count: 1, evidenceRecorded: 0, missingEvidence: 1 },
      reviews: { needsCheck: 1, checked: 0 }, taxPayments: { count: 1, paidTotal: 0, unpaidTotal: 18300, withEvidenceFile: 0 },
      cashReceipts: null, rowCount: 2 },
    verification: { status: 'verified', checks: [] },
  }));
  return { store, backend, port };
}

it('shows the POS preview, uses its revision for export and sends the review expense revision', async () => {
  const { store, backend } = session();
  const ui = host();
  const receipt = { revision: 1, receiptId: 'receipt-1', affectedSources: ['pos.tax'], undoUntil: '2999-01-01T00:00:00Z' };
  backend.on('POST', '/pos/tax-reviews/expense-1/check', () => {
    backend.on('GET', '/pos/tax-reviews', call => ({ ...page, ...call.query, reviewCount: 0,
      items: call.query.to === TODAY ? [{ ...review, status: 'checked' }] : [] }));
    return { ...receipt, resourceId: 'expense-1' };
  });
  renderWithKit(<TaxDetail featureId="tax" condition={{ kind: 'default' }} detailRef={{ featureId: 'tax' }} host={ui} />, { store });
  expect(await screen.findByRole('link', { name: '홈택스 열기' })).toHaveAttribute('href', 'https://www.hometax.go.kr/');
  const preview = within(document.querySelector('[data-slot="tax.export"]')! as HTMLElement);
  expect(preview.getByRole('row', { name: '매출 합계 12,000원' })).toBeVisible();
  expect(preview.getByRole('row', { name: '실제 입금 16,000원' })).toBeVisible();
  expect(preview.getByRole('row', { name: '현금영수증 발행 앱에서는 볼 수 없어요' })).toBeVisible();
  expect(preview.getByRole('row', { name: '증빙 종류를 적은 지출 0건' })).toBeVisible();
  expect(preview.getByRole('row', { name: '증빙 파일을 붙인 납부 기록 0건' })).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: '확인 완료로 표시하기' }));
  await waitFor(() => expect(backend.callsTo('POST', '/pos/tax-reviews/expense-1/check')[0]?.body).toEqual({ expenseRevision: 4 }));
  await waitFor(() => expect(ui.notify).toHaveBeenCalledWith(expect.objectContaining({ undoToken: 'real-undo:receipt-1', undoUntil: receipt.undoUntil })));
  const file = { filename: 'tax.csv', contentType: 'text/csv', size: 1, sha256: '0'.repeat(64) };
  backend.on('POST', '/pos/tax-exports', () => ({ ...receipt, resourceId: 'export-1', exportId: 'export-1', sourceRevision: 19, files: { csv: file } }));
  backend.on('GET', '/pos/tax-exports/export-1/file', () => ({
    ...file, exportId: 'export-1', format: 'csv', contentBase64: 'WA==',
  }));
  await userEvent.click(preview.getByRole('button', { name: '세무사 자료 받기' }));
  await waitFor(() => expect(preview.getByRole('alert')).toHaveTextContent('파일을 받지 못했어요'));
  expect(backend.callsTo('POST', '/pos/tax-exports')[0]?.body).toEqual({
    from: `${TODAY.slice(0, 8)}01`, to: TODAY, expectedSourceRevision: 19,
  });
  expect(backend.callsTo('GET', '/pos/tax-exports/export-1/file')[0]?.query).toEqual({ format: 'csv' });
});

it('waits for an explicit evidence submit and records only the verified Account file', async () => {
  const { store, backend } = session();
  const matching = { fileId: 'file-1', contentType: 'application/pdf', size: 8, sha256: 'a'.repeat(64), attachedAt: asOf };
  const receipt = { resourceId: payment.taxPaymentId, revision: 3, receiptId: 'evidence-1', affectedSources: ['pos.tax'] };
  backend.on('POST', '/files', () => matching);
  backend.on('PUT', '/files/file-1/content', () => ({ status: 204, body: null }));
  backend.on('POST', '/files/file-1/complete', () => matching);
  backend.on('POST', '/pos/tax-payments/payment-1/evidence', () => {
    backend.on('GET', '/pos/tax-payments', () => ({ ...page, today: TODAY, items: [{ ...payment, revision: 3, evidence: 'attached', evidenceFiles: [matching] }] }));
    return receipt;
  });
  renderWithKit(<TaxDetail featureId="tax" condition={{ kind: 'default' }} detailRef={{ featureId: 'tax', view: 'payments' }} host={host()} />, { store });
  await userEvent.click(await screen.findByRole('button', { name: '교육세 더 보기' }));
  await userEvent.click(screen.getByRole('button', { name: '증빙 추가하기' }));
  const form = within(screen.getByRole('dialog', { name: '증빙 추가하기' }));
  fireEvent.change(form.getByLabelText('증빙 파일'), { target: { files: [new File(['%PDF-1.4'], 'receipt.pdf', { type: 'application/pdf' })] } });
  expect(backend.callsTo('POST', '/files')).toHaveLength(0);
  await userEvent.click(form.getByRole('button', { name: '첨부하기' }));
  expect(await screen.findByText('증빙 있음')).toBeVisible();
  expect(backend.callsTo('POST', '/files')[0]?.body).toMatchObject({ purpose: 'tax-evidence' });
  expect(backend.callsTo('POST', '/pos/tax-payments/payment-1/evidence')[0]?.body)
    .toEqual({ fileId: 'file-1', expectedRevision: 2 });
});

it('places a linked payment evidence dialog above the tax shell and closes it first on Escape', async () => {
  const { store, port, backend } = session();
  const closeTax = vi.fn();
  await port.load('tax');
  renderWithKit(<DetailDialog open title="세무관리" onClose={closeTax}>
    <TaxDetail featureId="tax" condition={{ kind: 'default' }}
      detailRef={{ featureId: 'tax', view: 'evidence', itemId: payment.taxPaymentId, focus: 'action' }} host={host()} />
  </DetailDialog>, { store });
  const evidence = await screen.findByRole('dialog', { name: '증빙 추가하기' });
  expect(document.querySelectorAll('.ui-modal-viewport [role="dialog"]')).toHaveLength(2);
  expect([...document.querySelectorAll('.ui-modal-viewport [role="dialog"]')].at(-1)).toBe(evidence);
  expect(evidence).toHaveAccessibleDescription('교육세');
  expect(within(evidence).getByLabelText('증빙 파일')).toBeEnabled();
  const user = userEvent.setup();
  await user.tab();
  expect(evidence).toContainElement(document.activeElement as HTMLElement);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(evidence).not.toBeInTheDocument());
  expect(closeTax).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: '세무관리' })).toBeVisible();
  expect(backend.callsTo('POST', '/files')).toHaveLength(0);
});

it('uses POS review facts for Navis confirmation and opens evidence through the widget', async () => {
  const { store, port, backend } = session();
  backend.on('GET', '/pos/tax-payments', () => ({ ...page, today: TODAY, items: [{ ...payment, type: '원천세' }] }));
  expect((await port.load('tax')).status).toBe('ready');
  const snapshot = store.getSnapshot();
  const adapter = moneyDomain.commands?.find(command => command.command === 'tax.markChecked');
  expect(adapter?.preflight({ command: { type: 'tax.markChecked', refId: 'expense-1' }, locale: 'ko' }, {
    snapshot, proposalId: 'review-card', idempotencyKey: 'review-card',
  })).toMatchObject({ kind: 'ready', command: { type: 'tax.markChecked', refId: 'expense-1' }, preview: { title: '봉투' } });
  expect(projectMoneyFacts(snapshot, 'tax', { kind: 'default' }, 'ko')?.facts).toContainEqual(expect.objectContaining({
    key: 'tax.cashReceipts', value: 'unavailable',
  }));
  expect(moneyDomain.route?.('원천세 증빙 추가해줘', snapshot, 'ko')).toMatchObject({
    kind: 'refusal', reason: 'widget_only', alternative: { command: 'tax.setEvidence', draft: { taxPaymentId: 'payment-1', evidence: 'example' } },
  });
  expect(moneyDomain.handoff?.('tax.setEvidence', { taxPaymentId: 'payment-1', evidence: 'example' }))
    .toEqual({ featureId: 'tax', view: 'evidence', itemId: 'payment-1', focus: 'action' });
  expect(await store.execute({ type: 'tax.setEvidence', taxPaymentId: 'payment-1', evidence: 'example' })).toMatchObject({ ok: false });
  expect(backend.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  port.reset();
  expect(store.getSnapshot().tables).toMatchObject({ taxPayment: [], taxReview: [], realTax: undefined });
});
