import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerAiCallCallback } from '../../customer/naver/aicall.ts';
import { createInventoryNaver } from '../../inventory/naver/index.ts';
import { createCustomerNaver } from '../../customer/naver/index.ts';
import { createPosNaver } from '../../pos/naver/index.ts';

const context = { storeId: 'fixture-store', actorId: 'fixture-owner' };
const response = (value: unknown) => Response.json(value);

describe('operating NAVER adapters', () => {
  it('strips booking contact at completion and refuses to change Npay booking', async () => {
    const request = vi.fn(async () => response({
      bookingNumber: '17', product: '테이블', usageAt: '2026-11-17T15:45:00+09:00',
      status: 'completed', maskedContact: '010-****-1234', npayLinked: true, paymentAmount: 4500, phone: 'private',
    }));
    const customer = createCustomerNaver({ request });
    expect(await customer.booking(context, 'slot')).toEqual({
      bookingNumber: '17', product: '테이블', usageAt: '2026-11-17T15:45:00+09:00',
      status: 'completed', npayLinked: true, paymentAmount: 4500,
    });
    await expect(customer.bookingCommand(context, { key: 'receipt-1' }, 'slot', {
      kind: 'change', usageAt: '2026-11-17T16:45:00+09:00',
    })).rejects.toThrow();
    expect(request.mock.calls).toHaveLength(2);
  });

  it('sends the cancellation reason and refund condition only after extra confirmation', async () => {
    const cancel = { kind: 'cancel', cancelReason: '매장 사정', refund: { type: 'amount', value: 3000 } } as const;
    const request = vi.fn<(...args: unknown[]) => Promise<Response>>(async () => response({
      bookingNumber: '17', product: '테이블', usageAt: '2026-11-17T15:45:00+09:00',
      status: 'cancelled', npayLinked: true, paymentAmount: 4500,
    }));
    const customer = createCustomerNaver({ request });
    await expect(customer.bookingCommand(context, { key: 'receipt-1' }, 'slot', cancel)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    await customer.bookingCommand(context, { key: 'receipt-1', extraConfirmed: true }, 'slot', cancel);
    const command = request.mock.calls[0]!;
    expect(command.slice(0, 3)).toEqual(['pn02.bookings.cancel', 'fixture-store',
      '/partner-assumed/v1/bookings/slot/cancel']);
    expect(JSON.parse((command[3] as { body: string }).body)).toEqual({
      cancelReason: cancel.cancelReason, refund: cancel.refund,
    });
  });

  it('uses the official Calendar form and projects the official success fields', async () => {
    const request = vi.fn<(...args: unknown[]) => Promise<Response>>(async () => response({
      result: 'success', returnValue: { processType: 'create', calendarId: '12', icalUid: 'event-1' },
    }));
    const customer = createCustomerNaver({ request });
    const schedule = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:event-1\r\nEND:VEVENT\r\nEND:VCALENDAR';
    expect(await customer.addCalendarEvent(context, { key: 'receipt-1' }, 'defaultCalendarId', schedule))
      .toEqual({ processType: 'create', calendarId: '12', icalUid: 'event-1' });
    expect(request.mock.calls[0]?.slice(1, 4)).toEqual(['fixture-store', '/calendar/createSchedule.json', expect.any(Object)]);
    expect(((request.mock.calls[0]?.[3] as { body: URLSearchParams }).body).get('scheduleIcalString')).toBe(schedule);
  });

  it('requires a distinct confirmation before cancellation', async () => {
    const request = vi.fn();
    const pos = createPosNaver({ request });
    await expect(pos.cancelPayment(context, { key: 'receipt-1' }, {
      paymentId: 'payment-1', cancelAmount: 3000, cancelReason: '주문 취소', cancelRequester: '2',
      taxScopeAmount: 3000, taxExScopeAmount: 0,
    })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});

it('scopes AiCall intake server-side and retries with only a minimum candidate', async () => {
  const app = Fastify();
  const upsertCandidate = vi.fn(async () => {});
  registerAiCallCallback(app, {
    authenticate: async req => req.headers.authorization === 'Bearer synthetic-fixture' ? { storeId: context.storeId } : undefined,
    upsertCandidate,
  });
  try {
    const payload = { userId: 'fixture', userKey: 'cafe', userVariables: {
      예약날짜_completed: { typ: 'JSON', value: '{"year":2026,"month":11,"day":18}' },
      예약시간_completed: { typ: 'JSON', value: '{"hour":13,"minute":30}' },
      예약인원_completed: { typ: 'NUMBER', value: '2' },
      전화번호_completed: { typ: 'TEXT', value: '01000004200' },
    } };
    const request = { method: 'POST' as const, url: '/internal/naver-virtual/aicall/custom-condition/v2', payload };
    expect((await app.inject(request)).statusCode).toBe(403);
    expect(upsertCandidate).not.toHaveBeenCalled();
    for (let retry = 0; retry < 2; retry++) {
      const response = await app.inject({ ...request, headers: { authorization: 'Bearer synthetic-fixture' } });
      expect(response.json()).toEqual({ valid: 'reservationFailed' });
    }
    expect(upsertCandidate.mock.calls[0]).toEqual(upsertCandidate.mock.calls[1]);
    expect(upsertCandidate).toHaveBeenCalledWith({
      storeId: context.storeId, usageAt: '2026-11-18T13:30:00+09:00', partySize: 2, dedupeKey: expect.any(String),
    });
  } finally { await app.close(); }
});

it('filters private data and keeps settlement out of the merchant approval receipt', async () => {
  const request = vi.fn(async () => response({
    code: 'Success', body: { paymentId: 'p1', detail: {
      paymentId: 'p1', payHistId: 'h1', admissionState: 'SUCCESS', admissionYmdt: '20261117154500',
      totalPayAmount: 3000, settleExpectAmount: 0, cardNo: 'private', userIdentifier: 'private',
    } },
  }));
  const pos = createPosNaver({ request });
  expect(await pos.approvePayment(context, { key: 'receipt-1' }, 'p1')).toEqual({
    paymentId: 'p1', payHistId: 'h1', admissionState: 'SUCCESS', admissionYmdt: '20261117154500', totalPayAmount: 3000,
  });
});

it('sends an exact menu publish and never exports recipe or cost', async () => {
  const request = vi.fn<(...args: unknown[]) => Promise<Response>>(async () => response([{ name: '라테', price: 3000, recipe: 'private' }]));
  const inventory = createInventoryNaver({ request });
  const patch = { name: '라테', price: 3000, recipe: 'private', cost: 900 };
  expect(await inventory.publishMenu(context, { key: 'receipt-1' }, patch)).toEqual([{ name: '라테', price: 3000 }]);
  expect(request).toHaveBeenCalledWith('pn01.menu.update', context.storeId, '/partner-assumed/v1/place/menu', expect.objectContaining({
    headers: { 'Idempotency-Key': 'receipt-1', 'content-type': 'application/json' },
    body: '{"name":"라테","price":3000}',
  }));
});
