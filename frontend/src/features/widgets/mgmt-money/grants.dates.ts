import { kstLocal } from '../../../data/reality/02/clock';
import type { T } from './shared';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** An official notice's date as the app writes every date (`9/30(금)`); text that is not an ISO day (a service note) stays as it came. */
export const noticeDay = (format: T['format'], value: string): string => (ISO_DAY.test(value) ? format.date(value, 'short') : value);

/** The instant a source was read, in store time as day and clock (`11/22(일) 15:00`), never the browser's own date string. */
export function noticeStamp(format: T['format'], iso: string): string {
  try {
    const local = kstLocal(iso);
    return `${format.date(local.slice(0, 10), 'short')} ${format.time(local.slice(11, 16))}`;
  } catch { return iso; }
}
