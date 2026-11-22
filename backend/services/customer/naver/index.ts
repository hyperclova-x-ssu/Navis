import {
  approval, boolean, checked, choice, commandHeaders, integer, invalidWire, json, list, NaverError, object,
  ownerRequest, query, selector, text, type NaverTransport, type OwnerApproval, type OwnerContext,
} from '../../account/naver/wire.ts';

import type { BookingCancel } from '../../../packages/naver/contracts/pn02/wire.ts';

const partner = '/partner-assumed/v1';

const statuses = ['requested', 'confirmed', 'cancelled', 'completed', 'no-show'] as const;

function bookingView(value: unknown) {
  const row = object(value);
  const status = choice(row.status, statuses);
  const active = status === 'requested' || status === 'confirmed';
  const npayLinked = boolean(row.npayLinked);
  const paymentAmount = npayLinked && row.paymentAmount !== undefined ? integer(row.paymentAmount) : undefined;
  if (paymentAmount !== undefined && paymentAmount < 0) return invalidWire();
  return {
    bookingNumber: text(row.bookingNumber), product: text(row.product), usageAt: text(row.usageAt),
    status, npayLinked,
    ...(paymentAmount !== undefined && { paymentAmount }),
    ...(active && typeof row.maskedName === 'string' && row.maskedName.includes('*') && { maskedName: row.maskedName }),
    ...(active && typeof row.maskedPhone === 'string' && /^\d{2,4}-\*{2,4}-\d{2,4}$/.test(row.maskedPhone) && { maskedPhone: row.maskedPhone }),
  };
}

function bookingProduct(value: unknown) {
  const row = object(value);
  return { name: text(row.name) };
}

function hoursView(value: unknown) {
  const row = object(value);
  return {
    businessHours: list(row.businessHours, value => {
      const hour = object(value);
      return { day: choice(hour.day, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']), open: text(hour.open), close: text(hour.close) };
    }),
    holidayHours: list(row.holidayHours, value => {
      const hour = object(value);
      return hour.closed === true
        ? { date: text(hour.date), closed: true as const }
        : { date: text(hour.date), open: text(hour.open), close: text(hour.close) };
    }),
  };
}

function callsView(value: unknown) {
  const row = object(value);
  const period = object(row.period);
  return {
    period: { startDate: text(period.startDate), endDate: text(period.endDate) },
    channels: list(row.channels, text),
    daily: list(row.daily, value => {
      const day = object(value);
      return {
        date: text(day.date), totalCalls: integer(day.totalCalls), connectedCalls: integer(day.connectedCalls),
        arsCalls: integer(day.arsCalls), missedCalls: integer(day.missedCalls), busyCalls: integer(day.busyCalls),
        averageDurationSeconds: day.averageDurationSeconds === null ? null : integer(day.averageDurationSeconds),
        callsAtLeastTenSeconds: integer(day.callsAtLeastTenSeconds),
      };
    }),
  };
}

const bookingPath = (ref: string) => partner + '/bookings/' + selector(ref);
type BookingAction = { kind: 'confirm' } | ({ kind: 'cancel' } & BookingCancel) | { kind: 'change'; usageAt: string };
type BookingFilters = Partial<Record<'bookingNumber' | 'name' | 'phone' | 'date', string>> & { status?: typeof statuses[number] };
type HoursPatch = Partial<ReturnType<typeof hoursView>>;

export function createCustomerNaver(transport: NaverTransport) {
  async function booking(ctx: OwnerContext, ref: string) {
    return bookingView(await json(ownerRequest(transport, ctx)('pn02.bookings.read', bookingPath(ref))));
  }
  return {
    // https://help.naver.com/service/30026/contents/20628?lang=ko&osType=COMMONOS
    async bookings(ctx: OwnerContext, { bookingNumber, name, phone, date, status }: BookingFilters = {}) {
      const path = partner + '/bookings' + query({ bookingNumber, name, phone, date, status });
      return list(await json(ownerRequest(transport, ctx)('pn02.bookings.list', path)), bookingView);
    },
    booking,
    // https://new.smartplace.naver.com/notices/1098
    async bookingProducts(ctx: OwnerContext) {
      return list(await json(ownerRequest(transport, ctx)('pn02.booking-products.list', partner + '/booking-products')), bookingProduct);
    },
    // https://help.naver.com/service/11712/contents/7581?lang=ko
    // https://help.naver.com/service/30026/contents/20630?lang=ko&osType=COMMONOS
    // https://help.naver.com/service/11712/contents/18720?lang=ko&osType=COMMONOS
    // https://new.smartplace.naver.com/notices/1098
    async bookingCommand(ctx: OwnerContext, card: OwnerApproval, ref: string, action: BookingAction) {
      const { kind } = action;
      const headers = commandHeaders(card, kind === 'cancel');
      if (kind === 'change') {
        if ((await booking(ctx, ref)).npayLinked) throw new NaverError(409, 'NPAY_LINKED_BOOKING');
        if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+09:00$/.test(action.usageAt) || !Number.isFinite(Date.parse(action.usageAt))) {
          throw new NaverError(400, 'INVALID_BOOKING_TIME');
        }
      }
      const path = bookingPath(ref) + (kind === 'change' ? '' : '/' + kind);
      const response = await checked(await ownerRequest(transport, ctx)('pn02.bookings.' + kind, path, {
        headers, body: JSON.stringify(kind === 'change' ? { usageAt: action.usageAt } : kind === 'cancel' ? { cancelReason: action.cancelReason, refund: action.refund } : {}),
        approvalScope: { actorId: ctx.actorId, bookingNumber: ref },
      }));
      await response.body?.cancel();
      return booking(ctx, ref);
    },
    // https://help.naver.com/service/30026/contents/20380?osType=MOBILE
    async hours(ctx: OwnerContext) {
      return hoursView(await json(ownerRequest(transport, ctx)('pn01.hours.read', partner + '/place/hours')));
    },
    async updateHours(ctx: OwnerContext, card: OwnerApproval, patch: HoursPatch) {
      const { businessHours, holidayHours } = patch;
      const body = {
        businessHours: businessHours?.map(({ day, open, close }) => ({ day, open, close })),
        holidayHours: holidayHours?.map(item => 'closed' in item
          ? { date: item.date, closed: item.closed } : { date: item.date, open: item.open, close: item.close }),
      };
      return hoursView(await json(ownerRequest(transport, ctx)('pn01.hours.update', partner + '/place/hours', {
        headers: commandHeaders(card), body: JSON.stringify(body), approvalScope: { actorId: ctx.actorId },
      })));
    },
    // https://help.naver.com/service/30026/contents/20474?lang=ko&osType=COMMONOS
    async smartCallSettings(ctx: OwnerContext) {
      const value = object(await json(ownerRequest(transport, ctx)('pn08.smartcall.settings', partner + '/smartcall/settings')));
      return { number050: text(value.number050) };
    },
    async smartCallSummary(ctx: OwnerContext, startDate: string, endDate: string) {
      return callsView(await json(ownerRequest(transport, ctx)('pn08.smartcall.calls',
        partner + '/smartcall/calls' + query({ startDate, endDate }))));
    },
    // https://developers.naver.com/docs/login/calendar-api/calendar-api.md
    async addCalendarEvent(ctx: OwnerContext, card: OwnerApproval, calendarId: string, scheduleIcalString: string) {
      approval(card);
      const lines = scheduleIcalString.replace(/\r?\n[ \t]/g, '').split(/\r?\n/).filter(Boolean);
      if (lines[0] !== 'BEGIN:VCALENDAR' || lines.at(-1) !== 'END:VCALENDAR' || lines.filter(x => x === 'BEGIN:VEVENT').length !== 1 || lines.filter(x => x === 'END:VEVENT').length !== 1
        || lines.filter(x => /^UID:[^\s]+$/.test(x)).length !== 1
        || lines.some(x => /^(?:ATTENDEE|ORGANIZER)(?:;|:)/i.test(x)) || !calendarId || scheduleIcalString.length > 65_536) {
        throw new NaverError(400, 'INVALID_CALENDAR_EVENT');
      }
      const result = object(await json(ownerRequest(transport, ctx)('pn11.calendar.create', '/calendar/createSchedule.json', {
        body: new URLSearchParams({ calendarId, scheduleIcalString }), approvalScope: { actorId: ctx.actorId, calendarId },
      })));
      if (result.result !== 'success') return invalidWire();
      const row = object(result.returnValue);
      return { processType: choice(row.processType, ['create', 'modify']), calendarId: text(row.calendarId), icalUid: text(row.icalUid) };
    },
  };
}

export { createWorksCalendar } from './works.ts';
export { registerAiCallCallback } from './aicall.ts';
