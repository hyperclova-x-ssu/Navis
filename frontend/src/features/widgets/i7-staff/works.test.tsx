import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WidgetDetailProps } from '../../../contracts';
import { createWidgetDataStore } from '../../../data/db/store';
import { createRealPort } from '../../../data/reality/00';
import { fakeBackend, reply } from '../../../data/reality/00/testing';
import { staffCalendarAdapter } from '../../../data/reality/07/adapter';
import { renderWithKit } from '../../../ui/test-utils';
import { StaffDetail } from './widget';

afterEach(cleanup);
vi.setConfig({ testTimeout: 30_000 });

const day = '2026-11-17';
const asOf = `${day}T00:00:00Z`;
const staffId = '3f1c2b4a-5d6e-4f70-8a91-b2c3d4e5f601';
const scheduleId = '7a1d3c55-2a8e-4c43-9f0e-3c1b2d4e5f60';
const approvalId = 'd2a7a3f8-0c4b-4b8e-8f62-1f0c2e3d4b5a';
const page = <T,>(items: readonly T[], sourceRevision = 1) => ({ items, asOf, nextCursor: null, sourceRevision });
const shift = { scheduleId, staffId, date: day, kind: 'work', start: '09:00', end: '15:00', breakMinutes: 30, revision: 4 };
const sentItem = (end = '15:00') => ({
  scheduleId, eventId: 'f'.repeat(64), summary: '김하나 근무', sentAt: '2026-11-17T01:30:00.000Z', revision: 4,
  start: { dateTime: `${day}T09:00:00`, timeZone: 'Asia/Seoul' }, end: { dateTime: `${day}T${end}:00`, timeZone: 'Asia/Seoul' },
});
const receipt = (operation: 'create' | 'update' | 'delete') => ({
  resourceId: scheduleId, receiptId: approvalId, revision: 4, sentAt: '2026-11-17T01:30:00.000Z', scheduleId, eventId: 'f'.repeat(64),
  operation, affectedSources: ['staff-schedule'],
});
const props = {
  featureId: 'staff-schedule', condition: { kind: 'default' }, detailRef: { featureId: 'staff-schedule' },
  host: { layer: 'management', resetPreview: vi.fn(), openClosing: vi.fn(), openLinked: vi.fn(), openDetail: vi.fn(), notify: vi.fn(), acknowledgeBriefing: vi.fn() },
} satisfies WidgetDetailProps;

function setup(list: () => unknown = () => ({ items: [] })) {
  const backend = fakeBackend();
  backend.on('GET', '/staff', () => page([{ staffId, name: '김하나', archivedAt: null, revision: 2 }]));
  backend.on('GET', '/shifts', () => page([shift], 9));
  backend.on('GET', '/shifts/history', () => page([]));
  backend.on('GET', '/calendar/events', () => page([]));
  backend.on('GET', '/calendar/projections', () => page([]));
  backend.on('GET', '/calendar/preferences', () => ({
    sourceVisibility: { reservation: false, pickup: true, shift: true, delivery: true, deadline: true, direct: true },
    categoryVisibility: { 'store-operations': true, purchasing: true, 'tax-admin': true }, revision: 0,
  }));
  backend.on('GET', '/shifts/naver-works', list);
  const store = createWidgetDataStore();
  const port = createRealPort({ store, fetch: backend.fetch, source: () => 'http', adapters: [staffCalendarAdapter] });
  store.bindReal(port);
  const view = renderWithKit(<StaffDetail {...props} />, { store });
  return { backend, view };
}

async function openShift(container: HTMLElement) {
  await waitFor(() => expect(container.querySelector(`button[data-schedule-id="${scheduleId}"]`)).not.toBeNull());
  fireEvent.click(container.querySelector<HTMLButtonElement>(`button[data-schedule-id="${scheduleId}"]`)!);
  return within(await screen.findByRole('region', { name: 'WORKS 팀 일정' }));
}

describe('WORKS team schedule card (SCR-271, PN11, AC-1611)', () => {
  it('sends a never-sent shift only from the card press, with both revisions and the approval as the key', async () => {
    let items: unknown[] = [];
    const { backend, view } = setup(() => ({ items }));
    backend.on('POST', '/calendar/naver-approvals', () => ({ approvalId, requiresConfirmation: false }));
    backend.on('POST', `/shifts/${scheduleId}/naver-works`, () => { items = [sentItem()]; return receipt('create'); });
    const works = await openShift(view.container);
    fireEvent.click(await works.findByRole('button', { name: 'WORKS로 보내기' }));
    const card = within(screen.getByRole('region', { name: 'WORKS로 보내기' }));
    expect(card.getByText('김하나')).toBeInTheDocument();
    expect(card.getByText('09:00~15:00')).toBeInTheDocument();
    expect(card.getByText('선택한 팀 캘린더')).toBeInTheDocument();
    expect(backend.callsTo('POST', /naver/)).toHaveLength(0);
    const send = card.getByRole('button', { name: 'WORKS로 보내기' });
    fireEvent.click(send);
    fireEvent.click(send);
    expect(await card.findByText('WORKS에 보냈어요')).toBeInTheDocument();
    expect(backend.callsTo('POST', '/calendar/naver-approvals').map(call => call.body)).toEqual([
      { stage: 'press', operation: 'works.create', resourceId: scheduleId, expectedRevision: 4, expectedStaffRevision: 2 },
    ]);
    const [write, ...more] = backend.callsTo('POST', `/shifts/${scheduleId}/naver-works`);
    expect(more).toHaveLength(0);
    expect(write!.body).toEqual({ approvalId, expectedRevision: 4, expectedStaffRevision: 2 });
    expect(write!.headers.get('idempotency-key')).toBe(approvalId);
    expect(await works.findByText(/WORKS에 보냄 · .*10:30/)).toBeInTheDocument();
    expect(backend.callsTo('GET', '/shifts/naver-works')[0]!.query).toEqual({ fromDateTime: `${day}T00:00:00+09:00`, untilDateTime: '2026-12-18T00:00:00+09:00' });
  });

  it('offers the update only when the team calendar holds an older copy of the shift', async () => {
    const same = setup(() => ({ items: [sentItem()] }));
    let works = await openShift(same.view.container);
    expect(await works.findByText(/WORKS에 보냄 · /)).toBeInTheDocument();
    expect(works.queryByRole('button', { name: 'WORKS 일정 고치기' })).not.toBeInTheDocument();
    expect(works.queryByRole('button', { name: 'WORKS로 보내기' })).not.toBeInTheDocument();
    cleanup();
    const changed = setup(() => ({ items: [sentItem('14:00')] }));
    changed.backend.on('POST', '/calendar/naver-approvals', () => ({ approvalId, requiresConfirmation: false }));
    changed.backend.on('PATCH', `/shifts/${scheduleId}/naver-works`, () => receipt('update'));
    works = await openShift(changed.view.container);
    fireEvent.click(await works.findByRole('button', { name: 'WORKS 일정 고치기' }));
    const card = within(screen.getByRole('region', { name: 'WORKS 일정 고치기' }));
    fireEvent.click(card.getByRole('button', { name: 'WORKS 일정 고치기' }));
    expect(await card.findByText('WORKS 일정을 고쳤어요')).toBeInTheDocument();
    expect(changed.backend.callsTo('PATCH', /naver-works/)[0]!.body).toEqual({ approvalId, expectedRevision: 4, expectedStaffRevision: 2 });
  });

  it('removes the WORKS copy only after the second press and keeps the Navis shift', async () => {
    const { backend, view } = setup(() => ({ items: [sentItem()] }));
    backend.on('POST', '/calendar/naver-approvals', call => ({ approvalId, requiresConfirmation: (call.body as { stage: string }).stage === 'press' }));
    backend.on('DELETE', `/shifts/${scheduleId}/naver-works`, () => receipt('delete'));
    const works = await openShift(view.container);
    fireEvent.click(await works.findByRole('button', { name: 'WORKS에서 지우기' }));
    const card = within(screen.getByRole('region', { name: 'WORKS에서 지우기' }));
    expect(card.getByText('WORKS 일정만 지우고 Navis 근무는 그대로예요')).toBeInTheDocument();
    fireEvent.click(card.getByRole('button', { name: 'WORKS에서 지우기' }));
    const confirm = await card.findByRole('button', { name: '지우기 확인하기' });
    expect(backend.callsTo('DELETE', /naver-works/)).toHaveLength(0);
    fireEvent.click(confirm);
    expect(await card.findByText('WORKS에서 지웠어요')).toBeInTheDocument();
    expect(backend.callsTo('POST', '/calendar/naver-approvals').map(call => (call.body as { stage: string }).stage)).toEqual(['press', 'confirm']);
    const remove = backend.callsTo('DELETE', /naver-works/);
    expect(remove).toHaveLength(1);
    expect(remove[0]!.body).toEqual({ approvalId, expectedRevision: 4 });
    expect(backend.callsTo('DELETE', `/shifts/${scheduleId}`)).toHaveLength(0);
  });

  it('shows why nothing can be sent when no team calendar is linked, without send buttons', async () => {
    const { view } = setup(() => reply(403, { code: 'WORKS_CALENDAR_REQUIRED' }));
    const works = await openShift(view.container);
    expect(await works.findByText('팀 캘린더가 연결되지 않았어요')).toBeInTheDocument();
    expect(works.queryByRole('button', { name: 'WORKS로 보내기' })).not.toBeInTheDocument();
  });

  it('keeps the card on a refusal with the reason, and an unknown result checks again with the same key', async () => {
    const { backend, view } = setup();
    backend.on('POST', '/calendar/naver-approvals', () => ({ approvalId, requiresConfirmation: false }));
    backend.on('POST', `/shifts/${scheduleId}/naver-works`, () => reply(502, { code: 'INVALID_NAVER_RESPONSE' }));
    const works = await openShift(view.container);
    fireEvent.click(await works.findByRole('button', { name: 'WORKS로 보내기' }));
    const card = within(screen.getByRole('region', { name: 'WORKS로 보내기' }));
    fireEvent.click(card.getByRole('button', { name: 'WORKS로 보내기' }));
    expect(await card.findByText('보낸 결과를 확인해 주세요')).toBeInTheDocument();
    backend.on('POST', `/shifts/${scheduleId}/naver-works`, () => reply(409, { code: 'CONFLICT', reason: 'WORKS_ALREADY_EXPORTED' }));
    fireEvent.click(card.getByRole('button', { name: '결과 확인하기' }));
    expect(await card.findByText('보내지 못했어요 · 이미 WORKS로 보냈거나 WORKS에서 지운 근무예요')).toBeInTheDocument();
    expect(backend.callsTo('POST', /naver-works/).map(call => call.headers.get('idempotency-key'))).toEqual([approvalId, approvalId]);
  });

  it('lists this account\'s sent team schedule in its own tab for a 31-day period', async () => {
    const { backend } = setup(() => ({ items: [sentItem()] }));
    fireEvent.click(await screen.findByRole('tab', { name: 'WORKS로 보낸 일정' }));
    const table = await screen.findByRole('table', { name: 'WORKS로 보낸 일정' });
    const cells = within(table).getAllByRole('cell').map(cell => cell.textContent);
    expect(cells[0]).toBe('김하나');
    expect(cells[2]).toBe('09:00~15:00');
    expect(cells[3]).toMatch(/10:30/);
    backend.on('GET', '/shifts/naver-works', () => ({ items: [] }));
    fireEvent.click(screen.getByRole('button', { name: /다음/ }));
    expect(await screen.findByText('아직 WORKS로 보낸 일정이 없어요')).toBeInTheDocument();
    expect(backend.callsTo('GET', '/shifts/naver-works').at(-1)!.query.fromDateTime).toBe('2026-12-18T00:00:00+09:00');
  });
});

it('fixture builds show neither the WORKS tab nor the WORKS area', () => {
  renderWithKit(<StaffDetail {...props} />, { store: createWidgetDataStore() });
  expect(screen.queryByRole('tab', { name: 'WORKS로 보낸 일정' })).not.toBeInTheDocument();
});
