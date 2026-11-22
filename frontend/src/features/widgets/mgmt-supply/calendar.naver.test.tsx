import '../../../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWidgetDataStore } from '../../../data/db/store';
import { createRealPort } from '../../../data/reality/00';
import { fakeBackend, reply } from '../../../data/reality/00/testing';
import { staffCalendarAdapter } from '../../../data/reality/07/adapter';
import { renderWithKit } from '../../../ui/test-utils';
import { calendarWidget } from './calendar';
import { createTestHost } from './testing';

afterEach(cleanup);
vi.setConfig({ testTimeout: 30_000 });

const day = '2026-11-17';
const asOf = `${day}T00:00:00Z`;
const eventId = '0b8f8c1c-5d5e-4a4f-9c39-6e8b1f3d2a10';
const todoId = '5c0c9c7e-0f53-4c8a-9a51-0e0b3c3f2a11';
const approvalId = 'd2a7a3f8-0c4b-4b8e-8f62-1f0c2e3d4b5a';
const secondApproval = 'e3b0c442-98fc-4c14-9afb-f4c8996fb924';
const page = <T,>(items: readonly T[], sourceRevision = 1) => ({ items, asOf, nextCursor: null, sourceRevision });
const event = { eventId, kind: 'event', title: '세무사 상담', date: day, time: '14:00', memo: '서류 챙기기', categoryId: 'store-operations', storeClosure: null, revision: 3 };
const todo = { eventId: todoId, kind: 'todo', title: '컵 주문 확인', date: day, time: null, memo: null, categoryId: 'store-operations', storeClosure: null, revision: 1 };
const receipt = (receiptId: string, processType: 'create' | 'modify' = 'create') => ({
  resourceId: eventId, receiptId, revision: 3, sentAt: '2026-11-17T05:07:00.000Z', eventId, processType, affectedSources: ['calendar'],
});
const naverPath = `/calendar/events/${eventId}/naver`;

function setup() {
  const backend = fakeBackend();
  backend.on('GET', '/staff', () => page([]));
  backend.on('GET', '/shifts', () => page([], 1));
  backend.on('GET', '/shifts/history', () => page([]));
  backend.on('GET', '/calendar/events', () => page([event, todo]));
  backend.on('GET', '/calendar/projections', () => page([]));
  backend.on('GET', '/calendar/preferences', () => ({
    sourceVisibility: { reservation: false, pickup: true, shift: true, delivery: true, deadline: true, direct: true },
    categoryVisibility: { 'store-operations': true, purchasing: true, 'tax-admin': true }, revision: 0,
  }));
  backend.on('GET', naverPath, () => ({ receipt: null }));
  backend.on('GET', `/calendar/events/${todoId}/naver`, () => ({ receipt: null }));
  const store = createWidgetDataStore();
  const port = createRealPort({ store, fetch: backend.fetch, source: () => 'http', adapters: [staffCalendarAdapter] });
  store.bindReal(port);
  const Detail = calendarWidget.Detail!;
  renderWithKit(<Detail featureId="calendar" condition={{ kind: 'default' }} detailRef={{ featureId: 'calendar' }} host={createTestHost('calendar')} />, { store });
  return backend;
}

const toolbarButton = () => screen.getAllByRole('button', { name: '네이버에 일정 추가하기' })[0]!;
const review = () => within(screen.getByRole('region', { name: '네이버에 일정 추가하기' }));
async function openReview() {
  fireEvent.click(await screen.findByRole('button', { name: /세무사 상담/ }));
  await waitFor(() => expect(toolbarButton()).toBeEnabled());
  fireEvent.click(toolbarButton());
  return review();
}

describe('[네이버에 일정 추가하기] card (SCR-224, PN11, AC-1590/1611)', () => {
  it('is off until one direct event is chosen; to-dos and nothing selected keep it off with the hint', async () => {
    const backend = setup();
    await screen.findByRole('button', { name: /세무사 상담/ });
    expect(toolbarButton()).toBeDisabled();
    expect(screen.getByText('직접 추가한 일정 하나를 골라 주세요')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /컵 주문 확인/ }));
    expect(toolbarButton()).toBeDisabled();
    fireEvent.click(toolbarButton());
    expect(backend.callsTo('POST', /naver/)).toHaveLength(0);
  });

  it('shows the event, sends nothing until the card press, then records the press and sends once with the approval as the key', async () => {
    const backend = setup();
    backend.on('POST', '/calendar/naver-approvals', () => ({ approvalId, expiresAt: new Date(Date.now() + 60_000).toISOString(), requiresConfirmation: false }));
    backend.on('POST', naverPath, () => receipt(approvalId));
    const card = await openReview();
    expect(card.getByText('세무사 상담')).toBeInTheDocument();
    expect(card.getByText('서류 챙기기')).toBeInTheDocument();
    expect(card.getByText('네이버 캘린더 기본 캘린더에 넣어요')).toBeInTheDocument();
    expect(backend.callsTo('POST', /naver/)).toHaveLength(0);
    const send = card.getByRole('button', { name: '네이버에 일정 추가하기' });
    fireEvent.click(send);
    fireEvent.click(send);
    expect(await card.findByText('네이버에 추가했어요')).toBeInTheDocument();
    expect(backend.callsTo('POST', '/calendar/naver-approvals').map(call => call.body)).toEqual([
      { stage: 'press', operation: 'calendar.add', resourceId: eventId, expectedRevision: 3 },
    ]);
    const writes = backend.callsTo('POST', naverPath);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toEqual({ approvalId, expectedRevision: 3 });
    expect(writes[0]!.headers.get('idempotency-key')).toBe(approvalId);
    expect(screen.getByText(/네이버에 보냄 · .*14:07/)).toBeInTheDocument();
  });

  it('says the NAVER event was changed when the same event is sent again (one event kept)', async () => {
    const backend = setup();
    backend.on('GET', naverPath, () => ({ receipt: receipt(approvalId) }));
    backend.on('POST', '/calendar/naver-approvals', () => ({ approvalId: secondApproval, requiresConfirmation: false }));
    backend.on('POST', naverPath, () => receipt(secondApproval, 'modify'));
    const card = await openReview();
    expect(await screen.findByText(/네이버에 보냄 · .*14:07/)).toBeInTheDocument();
    fireEvent.click(card.getByRole('button', { name: '네이버에 일정 추가하기' }));
    expect(await card.findByText('네이버 일정을 고쳤어요')).toBeInTheDocument();
  });

  it('keeps the card open with the reason on a refusal, and the next press is a new approval', async () => {
    const backend = setup();
    let issued = 0;
    backend.on('POST', '/calendar/naver-approvals', () => ({ approvalId: issued++ ? secondApproval : approvalId, requiresConfirmation: false }));
    backend.on('POST', naverPath, () => reply(403, { code: 'NAVER_GRANT_REQUIRED' }));
    const card = await openReview();
    fireEvent.click(card.getByRole('button', { name: '네이버에 일정 추가하기' }));
    expect(await card.findByText('추가하지 못했어요 · 네이버 로그인이 필요해요')).toBeInTheDocument();
    expect(card.getByText('세무사 상담')).toBeInTheDocument();
    backend.on('POST', naverPath, () => receipt(secondApproval));
    fireEvent.click(card.getByRole('button', { name: '네이버에 일정 추가하기' }));
    expect(await card.findByText('네이버에 추가했어요')).toBeInTheDocument();
    expect(backend.callsTo('POST', naverPath).map(call => call.headers.get('idempotency-key'))).toEqual([approvalId, secondApproval]);
  });

  it('locks an unknown result to the same attempt: checking again resends the same key without a new approval', async () => {
    const backend = setup();
    backend.on('POST', '/calendar/naver-approvals', () => ({ approvalId, requiresConfirmation: false }));
    backend.on('POST', naverPath, () => reply(503, { code: 'SERVICE_UNAVAILABLE' }));
    const card = await openReview();
    fireEvent.click(card.getByRole('button', { name: '네이버에 일정 추가하기' }));
    expect(await card.findByText('보낸 결과를 확인해 주세요')).toBeInTheDocument();
    backend.on('POST', naverPath, () => receipt(approvalId));
    fireEvent.click(card.getByRole('button', { name: '결과 확인하기' }));
    expect(await card.findByText('네이버에 추가했어요')).toBeInTheDocument();
    expect(backend.callsTo('POST', '/calendar/naver-approvals')).toHaveLength(1);
    expect(backend.callsTo('POST', naverPath).map(call => call.headers.get('idempotency-key'))).toEqual([approvalId, approvalId]);
  });

  it('asks for a refreshed card when the event changed, and re-reads the calendar', async () => {
    const backend = setup();
    backend.on('POST', '/calendar/naver-approvals', () => ({ approvalId, requiresConfirmation: false }));
    backend.on('POST', naverPath, () => reply(409, { code: 'CONFLICT', reason: 'STALE_REVISION', details: { revision: 4 } }));
    const card = await openReview();
    const reads = backend.callsTo('GET', '/calendar/events').length;
    backend.on('GET', '/calendar/events', () => page([{ ...event, revision: 4 }, todo]));
    fireEvent.click(card.getByRole('button', { name: '네이버에 일정 추가하기' }));
    expect(await card.findByText('그사이 일정이 바뀌었어요. 새로 불러온 내용을 확인해 주세요')).toBeInTheDocument();
    await waitFor(() => expect(backend.callsTo('GET', '/calendar/events').length).toBeGreaterThan(reads));
    fireEvent.click(card.getByRole('button', { name: '다시 확인하기' }));
    backend.on('POST', naverPath, () => ({ ...receipt(approvalId), revision: 4 }));
    fireEvent.click(await review().findByRole('button', { name: '네이버에 일정 추가하기' }));
    await review().findByText('네이버에 추가했어요');
    expect(backend.callsTo('POST', naverPath).at(-1)!.body).toEqual({ approvalId, expectedRevision: 4 });
  });

  it('closes without any write when the owner leaves the card', async () => {
    const backend = setup();
    const card = await openReview();
    fireEvent.click(card.getByRole('button', { name: '닫기' }));
    expect(screen.queryByRole('region', { name: '네이버에 일정 추가하기' })).not.toBeInTheDocument();
    expect(backend.callsTo('POST', /naver/)).toHaveLength(0);
  });
});
