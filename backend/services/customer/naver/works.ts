import { approval, checked, choice, json, list, object, ownerRequest, query, selector, text,
  type NaverTransport, type OwnerApproval, type OwnerContext } from '../../account/naver/wire.ts';

type Time = { date: string } | { dateTime: string; timeZone: 'Asia/Seoul' };
type Event = { eventId: string; summary: string; description?: string; start: Time; end?: Time };

function timeView(value: unknown): Time {
  const row = object(value);
  return row.date !== undefined ? { date: text(row.date) } : { dateTime: text(row.dateTime), timeZone: choice(row.timeZone, ['Asia/Seoul']) };
}

function eventView(value: unknown) {
  return { eventComponents: list(object(value).eventComponents, value => {
    const row = object(value);
    return {
      eventId: text(row.eventId), summary: text(row.summary), start: timeView(row.start),
      ...(row.end !== undefined && { end: timeView(row.end) }),
      ...(row.description !== undefined && { description: text(row.description) }),
    };
  }) };
}

// https://developers.worksmobile.com/kr/docs/calendar
export function createWorksCalendar(transport: NaverTransport, target: (ctx: OwnerContext) => { userId: string; calendarId: string }) {
  function base(ctx: OwnerContext) {
    const { userId, calendarId } = target(ctx);
    return '/v1.0/users/' + selector(userId) + '/calendars/' + selector(calendarId) + '/events';
  }
  async function write(ctx: OwnerContext, card: OwnerApproval, op: 'create' | 'update', event: Event) {
    approval(card);
    const { eventId, summary, description, start, end } = event;
    const id = selector(eventId);
    const component = { eventId: id, summary, description, start: timeView(start), end: end && timeView(end) };
    return eventView(await json(ownerRequest(transport, ctx)('pn11.works.' + op, base(ctx) + (op === 'update' ? '/' + id : ''), {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventComponents: [component], sendNotification: false }),
      approvalScope: { actorId: ctx.actorId, eventId: id },
    })));
  }
  return {
    async list(ctx: OwnerContext, fromDateTime: string, untilDateTime: string) {
      const row = object(await json(ownerRequest(transport, ctx)('pn11.works.list', base(ctx) + query({ fromDateTime, untilDateTime }))));
      return list(row.events, eventView);
    },
    async read(ctx: OwnerContext, id: string) {
      return eventView(await json(ownerRequest(transport, ctx)('pn11.works.read', base(ctx) + '/' + selector(id))));
    },
    create: (ctx: OwnerContext, card: OwnerApproval, event: Event) => write(ctx, card, 'create', event),
    update: (ctx: OwnerContext, card: OwnerApproval, event: Event) => write(ctx, card, 'update', event),
    async remove(ctx: OwnerContext, card: OwnerApproval, id: string) {
      approval(card, true);
      const response = await checked(await ownerRequest(transport, ctx)('pn11.works.delete', base(ctx) + '/' + selector(id), {
        approvalScope: { actorId: ctx.actorId, eventId: id },
      }));
      await response.body?.cancel();
    },
  };
}
