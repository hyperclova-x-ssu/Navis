import type { NoticeReplyOptions, Owner } from './ports.ts';
import { date, NoticeError, uuid } from './wire.ts';

/** The caller supplies the authenticated B07 service request, scoped to the current owner and store. */
export function createClosureReader(readEvent: (scope: Owner, eventId: string) => Promise<Response>):
  NonNullable<NoticeReplyOptions['readClosure']> {
  return async (scope, eventId) => {
    const response = await readEvent(scope, eventId);
    if (response.status === 404) return null;
    if (!response.ok) throw new NoticeError(503, 'CLOSURE_UNAVAILABLE');
    try {
      const row = await response.json() as { eventId?: unknown; revision?: unknown; date?: unknown;
        storeClosure?: { kind?: unknown; endDate?: unknown } | null };
      if (uuid(row.eventId) !== eventId || typeof row.revision !== 'number' ||
        !Number.isInteger(row.revision) || row.revision < 1) throw new Error('Invalid closure source');
      if (!row.storeClosure) return null;
      const start = date(row.date);
      const endDate = date(row.storeClosure.endDate);
      if ((row.storeClosure.kind !== 'regular' && row.storeClosure.kind !== 'temporary') || endDate < start) {
        throw new Error('Invalid closure range');
      }
      return { eventId, revision: row.revision, date: start, endDate };
    } catch {
      throw new NoticeError(503, 'CLOSURE_UNAVAILABLE');
    }
  };
}
