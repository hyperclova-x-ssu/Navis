// Partner-assumed owner fields from https://help.naver.com/service/30026/contents/20366?lang=ko
// Menu and hours: https://new.smartplace.naver.com/introduction/solution-market/payNPos
// Hours: https://help.naver.com/service/30026/contents/20380?osType=MOBILE
export interface Venue {
  name: string;
  address: string;
  keywords: string[];
  phone: string;
  photos: string[];
}
export interface MenuItem { name: string; price: number }
export const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export interface BusinessHours {
  day: typeof weekdays[number];
  open: string;
  close: string;
}
export type HolidayHours = { date: string; closed: true } | { date: string; open: string; close: string };
export interface PlaceHours { businessHours: BusinessHours[]; holidayHours: HolidayHours[] }
export const placePath = '/partner-assumed/v1/place';

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function only(value: Record<string, unknown>, fields: string[], nonempty = true) {
  const keys = Object.keys(value);
  return (!nonempty || keys.length > 0) && keys.every(key => fields.includes(key));
}

function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit && value.trim().length > 0;
}

export function venuePatch(value: unknown): value is Partial<Venue> {
  if (!record(value) || !only(value, ['name', 'address', 'keywords', 'phone', 'photos'])) return false;
  return (!('name' in value) || text(value.name, 100))
    && (!('address' in value) || text(value.address, 300))
    && (!('phone' in value) || (typeof value.phone === 'string' && /^[0-9-]{8,20}$/.test(value.phone)))
    && (!('keywords' in value) || (Array.isArray(value.keywords) && value.keywords.length <= 5
      && value.keywords.every(keyword => text(keyword, 50))))
    && (!('photos' in value) || (Array.isArray(value.photos)
      && new Set(value.photos).size === value.photos.length
      && value.photos.every(ref => typeof ref === 'string' && /^[\w-]{1,128}$/.test(ref))));
}

export function menuPatch(value: unknown): value is Partial<MenuItem> {
  return record(value) && only(value, ['name', 'price'])
    && (!('name' in value) || text(value.name, 100))
    && (!('price' in value) || (typeof value.price === 'number' && Number.isInteger(value.price)
      && value.price >= 0 && value.price <= 2147483647));
}

export function calendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function time(value: unknown) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5][05]$/.test(value);
}

function interval(entry: Record<string, unknown>) {
  return time(entry.open) && time(entry.close) && entry.open !== entry.close;
}

export function validHours(value: unknown): value is Partial<PlaceHours> {
  if (!record(value) || !only(value, ['businessHours', 'holidayHours'])) return false;
  const week = value.businessHours;
  const holidays = value.holidayHours;
  return (!('businessHours' in value) || (Array.isArray(week) && week.length > 0 && week.length <= 7
    && week.every(row => record(row) && only(row, ['day', 'open', 'close']) && weekdays.some(day => day === row.day) && interval(row))
    && new Set(week.map(row => row.day)).size === week.length))
    && (!('holidayHours' in value) || (Array.isArray(holidays)
      && holidays.every(row => record(row) && calendarDate(row.date) && (row.closed === true
        ? only(row, ['date', 'closed'])
        : only(row, ['date', 'open', 'close']) && interval(row)))
      && new Set(holidays.map(row => row.date)).size === holidays.length));
}
