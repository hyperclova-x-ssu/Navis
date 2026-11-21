/** Undo uses the injected monotonic scheduler, never businessNow. */
export const ORDER_UNDO_MS = 6000;

/** Supports legacy HH:mm inputs and the POS local business timestamp, without the device timezone. */
export function toMinutes(value: string): number {
  const [date, time] = value.includes('T') ? value.split('T') : [null, value];
  const [hour, minute] = time.split(':').map(Number);
  if (!date) return hour * 60 + minute;
  const [year, month, day] = date.split('-').map(Number);
  return Date.UTC(year, month - 1, day, hour, minute) / 60000;
}
