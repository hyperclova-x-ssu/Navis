import { describe, expect, it } from 'vitest';
import { createPortTransport, PortError } from '../00';
import { fakeBackend, reply } from '../00/testing';
import {
  exportApprovalExpired, exportOutcome, issueExportApproval, listWorksExports, readCalendarExport, submitExport, worksExportChanged,
  worksWindow, type ExportCard,
} from './naver';

const eventId = '0b8f8c1c-5d5e-4a4f-9c39-6e8b1f3d2a10';
const scheduleId = '7a1d3c55-2a8e-4c43-9f0e-3c1b2d4e5f60';
const approvalId = 'd2a7a3f8-0c4b-4b8e-8f62-1f0c2e3d4b5a';
const sentAt = '2026-11-22T01:05:00.000Z';
const calendarReceipt = { resourceId: eventId, receiptId: approvalId, revision: 3, sentAt, eventId, processType: 'create', affectedSources: ['calendar'] };
const worksReceipt = (operation: 'create' | 'update' | 'delete') => ({
  resourceId: scheduleId, receiptId: approvalId, revision: 4, sentAt, scheduleId, eventId: 'f'.repeat(64), operation, affectedSources: ['staff-schedule'],
});
const card = (overrides: Partial<ExportCard> = {}): ExportCard => ({
  operation: 'calendar.add', resourceId: eventId, expectedRevision: 3, attemptKey: 'attempt-1', ...overrides,
});

function setup() {
  const backend = fakeBackend();
  const urls: string[] = [];
  const transport = createPortTransport((input, init) => { urls.push(String(input)); return backend.fetch(input, init); });
  return { backend, transport, urls, signal: new AbortController().signal };
}

describe('PN11 one-way export port (GAP-CAL DTO)', () => {
  it('records the owner press at the issuer, then sends the event once with approvalId as the Idempotency-Key', async () => {
    const { backend, transport, signal } = setup();
    backend.on('POST', '/calendar/naver-approvals', () => ({ approvalId, expiresAt: '2026-11-22T01:06:00Z', requiresConfirmation: false }));
    backend.on('POST', `/calendar/events/${eventId}/naver`, () => calendarReceipt);
    const approval = await issueExportApproval(transport, card(), signal);
    expect(approval).toEqual({ approvalId, expiresAt: '2026-11-22T01:06:00Z', requiresConfirmation: false });
    const [press] = backend.callsTo('POST', '/calendar/naver-approvals');
    expect(press.body).toEqual({ stage: 'press', operation: 'calendar.add', resourceId: eventId, expectedRevision: 3 });
    expect(press.headers.get('idempotency-key')).toBe('attempt-1:press');
    expect(await submitExport(transport, card(approval), signal)).toEqual(calendarReceipt);
    const [write] = backend.callsTo('POST', `/calendar/events/${eventId}/naver`);
    expect(write.body).toEqual({ approvalId, expectedRevision: 3 });
    expect(write.headers.get('idempotency-key')).toBe(approvalId);
  });

  it('sends the staff revision only for WORKS create and update, and nothing but the approval for delete', async () => {
    const { backend, transport, signal } = setup();
    backend.on('POST', `/shifts/${scheduleId}/naver-works`, () => worksReceipt('create'));
    backend.on('PATCH', `/shifts/${scheduleId}/naver-works`, () => worksReceipt('update'));
    backend.on('DELETE', `/shifts/${scheduleId}/naver-works`, () => worksReceipt('delete'));
    const works = { resourceId: scheduleId, expectedRevision: 4, expectedStaffRevision: 2, approvalId };
    await submitExport(transport, card({ ...works, operation: 'works.create' }), signal);
    await submitExport(transport, card({ ...works, operation: 'works.update' }), signal);
    await submitExport(transport, card({ ...works, operation: 'works.delete', confirmed: true }), signal);
    expect(backend.callsTo('POST', /naver-works/)[0].body).toEqual({ approvalId, expectedRevision: 4, expectedStaffRevision: 2 });
    expect(backend.callsTo('PATCH', /naver-works/)[0].body).toEqual({ approvalId, expectedRevision: 4, expectedStaffRevision: 2 });
    const remove = backend.callsTo('DELETE', /naver-works/)[0];
    expect(remove.body).toEqual({ approvalId, expectedRevision: 4 });
    expect(remove.headers.get('idempotency-key')).toBe(approvalId);
  });

  it('holds a WORKS delete until the confirm stage was recorded with the same approval', async () => {
    const { backend, transport, signal } = setup();
    backend.on('POST', '/calendar/naver-approvals', call => ({ approvalId, requiresConfirmation: (call.body as { stage: string }).stage === 'press' }));
    const remove = card({ operation: 'works.delete', resourceId: scheduleId, expectedRevision: 4 });
    const pressed = { ...remove, ...await issueExportApproval(transport, remove, signal) };
    expect(pressed.requiresConfirmation).toBe(true);
    await expect(submitExport(transport, pressed, signal)).rejects.toMatchObject({ reason: 'EXTRA_CONFIRMATION_REQUIRED' });
    await issueExportApproval(transport, pressed, signal);
    expect(backend.callsTo('POST', '/calendar/naver-approvals').map(call => [call.body, call.headers.get('idempotency-key')])).toEqual([
      [{ stage: 'press', operation: 'works.delete', resourceId: scheduleId, expectedRevision: 4 }, 'attempt-1:press'],
      [{ stage: 'confirm', operation: 'works.delete', resourceId: scheduleId, expectedRevision: 4, approvalId }, 'attempt-1:confirm'],
    ]);
    expect(backend.callsTo('DELETE', /naver-works/)).toHaveLength(0);
  });

  it('rejects an issuer answer that changes the approval or a receipt for another record', async () => {
    const { backend, transport, signal } = setup();
    backend.on('POST', '/calendar/naver-approvals', () => ({ approvalId: 'e3b0c442-98fc-4c14-9afb-f4c8996fb924', requiresConfirmation: false }));
    await expect(issueExportApproval(transport, card({ approvalId }), signal)).rejects.toMatchObject({ reason: 'BAD_RESPONSE' });
    backend.on('POST', `/calendar/events/${eventId}/naver`, () => ({ ...calendarReceipt, resourceId: scheduleId }));
    await expect(submitExport(transport, card({ approvalId }), signal)).rejects.toMatchObject({ reason: 'BAD_RESPONSE', outcomeUnknown: true });
  });

  it('reads the latest calendar receipt and the WORKS list for a 31-day KST window with an encoded offset', async () => {
    const { backend, transport, urls, signal } = setup();
    backend.on('GET', `/calendar/events/${eventId}/naver`, () => ({ receipt: calendarReceipt }));
    backend.on('GET', '/shifts/naver-works', () => ({ items: [{ scheduleId, eventId: 'e', summary: '직원 근무', start: { date: '2026-11-22' }, end: { date: '2026-11-23' } }] }));
    expect(await readCalendarExport(transport, eventId, signal)).toEqual({ receipt: calendarReceipt });
    const [from, until] = worksWindow('2026-11-22');
    expect([from, until]).toEqual(['2026-11-22T00:00:00+09:00', '2026-12-23T00:00:00+09:00']);
    expect((await listWorksExports(transport, '2026-11-22', signal)).items).toHaveLength(1);
    expect(backend.callsTo('GET', '/shifts/naver-works')[0].query).toEqual({ fromDateTime: from, untilDateTime: until });
    expect(urls.find(url => url.includes('naver-works'))).toContain('fromDateTime=2026-11-22T00%3A00%3A00%2B09%3A00');
  });

  it('classifies failures: unknown outcome keeps the attempt, stale and expired restart, others keep the form with a reason', () => {
    expect(exportOutcome(new PortError(0, 'NETWORK', undefined, undefined, true), true)).toEqual({ kind: 'unknown' });
    expect(exportOutcome(new PortError(0, 'NETWORK', undefined, undefined, true), false)).toEqual({ kind: 'failed', reason: 'NETWORK' });
    expect(exportOutcome(new PortError(409, 'CONFLICT', 'STALE_REVISION'), true)).toEqual({ kind: 'stale' });
    // FIX-GAP-A: the provider has not confirmed an earlier attempt yet. After this card's own send it is this card's unknown result.
    expect(exportOutcome(new PortError(409, 'CONFLICT', 'NAVER_OUTCOME_PENDING'), true)).toEqual({ kind: 'unknown' });
    expect(exportOutcome(new PortError(409, 'CONFLICT', 'NAVER_OUTCOME_PENDING'), false)).toEqual({ kind: 'failed', reason: 'NAVER_OUTCOME_PENDING' });
    expect(exportOutcome(new PortError(403, 'STORE_FORBIDDEN', 'APPROVAL_EXPIRED'), false)).toEqual({ kind: 'failed', reason: 'APPROVAL_EXPIRED' });
    expect(exportOutcome(new PortError(403, 'STORE_FORBIDDEN', 'NAVER_GRANT_REQUIRED'), true)).toEqual({ kind: 'failed', reason: 'NAVER_GRANT_REQUIRED' });
    expect(exportOutcome(new PortError(403, 'STORE_FORBIDDEN'), true)).toEqual({ kind: 'failed', reason: 'SESSION_ENDED' });
    expect(exportOutcome(new Error('boom'), false)).toEqual({ kind: 'failed', reason: 'UNKNOWN' });
    expect(exportApprovalExpired(card({ expiresAt: '2026-11-22T01:00:00Z' }), Date.parse('2026-11-22T01:00:01Z'))).toBe(true);
    expect(exportApprovalExpired(card(), Date.parse('2026-11-22T01:00:01Z'))).toBe(false);
  });

  it('tells a WORKS export apart from the current shift by what the team calendar received', () => {
    const shift = { scheduleId, staffId: 's', date: '2026-11-22', kind: 'work' as const, start: '09:00', end: '15:00', breakMinutes: 30 };
    const sent = { scheduleId, eventId: 'e', summary: '김하나 근무', start: { dateTime: '2026-11-22T09:00:00', timeZone: 'Asia/Seoul' as const },
      end: { dateTime: '2026-11-22T15:00:00', timeZone: 'Asia/Seoul' as const } };
    expect(worksExportChanged(sent, shift, '김하나')).toBe(false);
    expect(worksExportChanged(sent, { ...shift, breakMinutes: 0 }, '김하나')).toBe(false);
    expect(worksExportChanged(sent, { ...shift, end: '16:00' }, '김하나')).toBe(true);
    expect(worksExportChanged(sent, shift, '김하나나')).toBe(true);
    const off = { scheduleId, eventId: 'e', summary: '김하나 휴무', start: { date: '2026-11-22' }, end: { date: '2026-11-23' } };
    expect(worksExportChanged(off, { ...shift, kind: 'off', start: null, end: null, breakMinutes: 0 }, '김하나')).toBe(false);
    expect(worksExportChanged(off, { ...shift, kind: 'off', date: '2026-11-23', start: null, end: null, breakMinutes: 0 }, '김하나')).toBe(true);
  });

  it('maps a gateway rejection of the write to a typed failure without leaking server text', async () => {
    const { backend, transport, signal } = setup();
    backend.on('POST', `/calendar/events/${eventId}/naver`, () => reply(403, { code: 'CARD_REQUIRED' }));
    const error = await submitExport(transport, card({ approvalId }), signal).catch(caught => caught);
    expect(exportOutcome(error, true)).toEqual({ kind: 'failed', reason: 'CARD_REQUIRED' });
  });
});
