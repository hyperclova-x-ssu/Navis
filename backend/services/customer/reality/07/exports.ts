import { createHash } from 'node:crypto';
import type { ObjectStorage } from '../../../../packages/object-storage/index.ts';
import { listProjections } from './projection.ts';
import { listEvents, listShifts, loadEntities, readPreferences, type Scope } from './records.ts';
import { invalid, type CalendarEvent, type CalendarSource, type Category } from './wire.ts';

type Entry = { id: string; revision: number; source: CalendarSource; category: Category; title: string;
  date: string; endDate?: string; time?: string | null; endTime?: string | null; memo?: string | null; todo?: boolean };
const exportLimit = 2000;
export type CalendarExportStorage = Pick<ObjectStorage, 'get' | 'put'>;
const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const dayStamp = (day: string) => day.replaceAll('-', '');
const tomorrow = (day: string) => new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);

function escape(value: string) {
  // eslint-disable-next-line no-control-regex -- iCalendar export strips unsupported ASCII controls.
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replaceAll('\\', '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n').replaceAll(',', '\\,').replaceAll(';', '\\;');
}

function fold(line: string) {
  let result = '';
  let length = 0;
  for (const char of line) {
    const width = Buffer.byteLength(char);
    if (length + width > 75) {
      result += '\r\n ';
      length = 1;
    }
    result += char;
    length += width;
  }
  return result;
}

function timedStamp(day: string, time: string, timezone: string) {
  const nominal = Date.parse(`${day}T${time}:00.000Z`);
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' });
  const offsetAt = (at: number) => {
    const zone = formatter.formatToParts(at).find(part => part.type === 'timeZoneName')?.value;
    const offset = zone?.match(/^GMT([+-])(\d\d):(\d\d)(?::(\d\d))?$/);
    if (!offset) return 0;
    const seconds = Number(offset[2]) * 3600 + Number(offset[3]) * 60 + Number(offset[4] ?? 0);
    return seconds * (offset[1] === '-' ? -1000 : 1000);
  };
  // Use the first occurrence at a fall-back boundary and the pre-gap offset at a skipped wall time.
  const offsets = [...new Set([offsetAt(nominal - 86_400_000), offsetAt(nominal + 86_400_000)])];
  const candidates = offsets.map(offset => nominal - offset);
  const exact = candidates.filter(at => at + offsetAt(at) === nominal);
  return stamp(new Date(exact.length ? Math.min(...exact) : candidates[0]));
}

function entryLines(e: Entry, storeId: string, now: Date, timezone: string) {
  const kind = e.todo ? 'VTODO' : 'VEVENT';
  const lines = [`BEGIN:${kind}`, `UID:${e.id}.${storeId}@navis`, `DTSTAMP:${stamp(now)}`, `SEQUENCE:${e.revision - 1}`];
  if (e.todo) lines.push(`DUE;VALUE=DATE:${dayStamp(e.date)}`);
  else if (e.time && !e.endDate) {
    lines.push(`DTSTART:${timedStamp(e.date, e.time, timezone)}`);
    if (e.endTime) lines.push(`DTEND:${timedStamp(e.date, e.endTime, timezone)}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${dayStamp(e.date)}`);
    if (e.endDate) lines.push(`DTEND;VALUE=DATE:${dayStamp(tomorrow(e.endDate))}`);
  }
  lines.push(`SUMMARY:${escape(e.title)}`);
  if (e.memo) lines.push(`DESCRIPTION:${escape(e.memo)}`);
  return [...lines, `END:${kind}`];
}

export function buildNaverCalendarEvent(row: CalendarEvent, storeId: string, now: Date, timezone: string) {
  if (row.kind !== 'event') throw invalid('eventId', 'NAVER_DIRECT_EVENT_REQUIRED');
  const endDate = row.storeClosure?.endDate;
  if (endDate === '9999-12-31') throw invalid('endDate', 'INVALID_DATE_RANGE');
  const id = `event-${row.eventId}`;
  const lines = entryLines({ id, source: 'direct', category: row.categoryId, title: row.title, date: row.date,
    time: row.time, endDate, memo: row.memo, revision: row.revision }, storeId, now, timezone);
  return { icalUid: `${id}.${storeId}@navis`, ical: ['BEGIN:VCALENDAR', 'PRODID:-//Navis//Store Calendar//KO',
    'VERSION:2.0', 'CALSCALE:GREGORIAN', ...lines, 'END:VCALENDAR'].map(fold).join('\r\n') + '\r\n' };
}

export async function calendarExport(scope: Scope, start: string, end: string, now: Date, timezone: string) {
  // DTEND is exclusive for all-day ranges, so leave room for the day after the selected window.
  if (end === '9999-12-31') throw invalid('endDate', 'INVALID_DATE_RANGE');
  const preferences = await readPreferences(scope);
  const options = { start, end, limit: exportLimit, cursor: null };
  const direct = preferences.sourceVisibility.direct ? await listEvents(scope, options) : [];
  const shifts = preferences.sourceVisibility.shift && preferences.categoryVisibility['store-operations'] ? await listShifts(scope, options, null) : [];
  const projections = await listProjections(scope, { ...options, cursor: [null, null] });
  if ([direct, shifts, projections].some(rows => rows.length > exportLimit)) throw invalid('endDate', 'EXPORT_TOO_LARGE');
  const staffIds = [...new Set(shifts.map(row => row.staffId))];
  const roster = new Map((await loadEntities(scope, 'staff', staffIds)).flatMap(entity => entity.type === 'staff'
    ? [[entity.row.staffId, entity.row.name] as const] : []));
  const entries: Entry[] = [
    ...direct.map(row => ({ id: `event-${row.eventId}`, source: 'direct' as const, category: row.categoryId,
      title: row.title, date: row.date, time: row.time, endDate: row.storeClosure?.endDate, memo: row.memo, revision: row.revision, todo: row.kind === 'todo' })),
    ...shifts.map(row => ({ id: `shift-${row.scheduleId}`, source: 'shift' as const, category: 'store-operations' as const,
      title: `${roster.get(row.staffId)} ${row.kind === 'off' ? '휴무' : '근무'}`, date: row.date, time: row.start, endTime: row.end, revision: row.revision })),
    ...projections.map(row => ({ id: `${row.source}-${row.sourceId}`, source: row.visibility, category: row.categoryId,
      title: row.title, date: row.date, time: row.time, endDate: row.date !== row.endDate ? row.endDate : undefined, revision: row.sourceRevision })),
  ].filter(row => preferences.categoryVisibility[row.category] && preferences.sourceVisibility[row.source]);
  if (entries.length > exportLimit) throw invalid('endDate', 'EXPORT_TOO_LARGE');
  if (entries.some(row => row.endDate === '9999-12-31')) throw invalid('endDate', 'INVALID_DATE_RANGE');
  entries.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? '') || a.id.localeCompare(b.id));
  const lines = ['BEGIN:VCALENDAR', 'PRODID:-//Navis//Store Calendar//KO', 'VERSION:2.0', 'CALSCALE:GREGORIAN',
    ...entries.flatMap(row => entryLines(row, scope.storeId, now, timezone)), 'END:VCALENDAR'];
  return lines.map(fold).join('\r\n') + '\r\n';
}

export async function archiveCalendarExport(storage: CalendarExportStorage, storeId: string, start: string, end: string, body: string) {
  const bytes = Buffer.from(body);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const key = `stores/${storeId}/documents/calendar/${start}_${end}/${digest}.ics`;
  const signal = AbortSignal.timeout(5_000);
  try {
    await storage.put(key, bytes, 'text/calendar', signal);
    const stored = await storage.get(key, signal);
    if (!stored) return;
    if (stored.contentLength !== null && stored.contentLength !== bytes.length) {
      stored.body.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of stored.body as AsyncIterable<Buffer>) {
      length += chunk.length;
      if (length > bytes.length) return;
      chunks.push(chunk);
    }
    const archived = Buffer.concat(chunks, length);
    return archived.equals(bytes) ? archived : undefined;
  } catch {
    return undefined;
  }
}
