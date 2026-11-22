import { APP_CLOCK, CLOCK_MODE } from '../../db/app-clock';
import type { StaffTables } from './types';

const seoul = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

export function staffCalendarClock(tables: Pick<StaffTables, 'staffCalendarAsOf'>): { readonly date: string; readonly time: string } {
  if (CLOCK_MODE === 'real' || !tables.staffCalendarAsOf) return { date: APP_CLOCK.businessDate, time: APP_CLOCK.time };
  return staffLocalTimestamp(tables.staffCalendarAsOf);
}

export function staffLocalTimestamp(value: string): { readonly date: string; readonly time: string } {
  const [date, time] = seoul.format(new Date(value)).split(' ');
  return { date: date!, time: time! };
}
