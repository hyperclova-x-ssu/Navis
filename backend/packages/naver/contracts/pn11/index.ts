export const loginSource = 'https://developers.naver.com/docs/login/api/api.md';
export const profileSource = 'https://developers.naver.com/docs/login/profile/profile.md';
export const calendarSource = 'https://developers.naver.com/docs/login/calendar-api/calendar-api.md';
export const worksCalendarSource = 'https://developers.worksmobile.com/kr/docs/calendar';

export type NaverToken = {
  access_token: string;
  refresh_token?: string;
  token_type: 'bearer';
  expires_in: number;
};
export type NaverProfile = { resultcode: '00'; message: 'success'; response: { id: string } };
export type CalendarAdd = { calendarId: string; scheduleIcalString: string };
export type CalendarCreated = {
  result: 'success';
  returnValue: { processType: 'create' | 'modify'; calendarId: string; icalUid: string };
};
export type WorksTime = { date: string } | { dateTime: string; timeZone: 'Asia/Seoul' };
export type WorksEventInput = { eventId?: string; summary: string; description?: string; start: WorksTime; end?: WorksTime };
export type WorksEvent = Omit<WorksEventInput, 'eventId'> & {
  eventId: string;
  createdTime: { dateTime: string; timeZone: 'Asia/Seoul' };
  updatedTime: { dateTime: string; timeZone: 'Asia/Seoul' };
};
export type WorksEventEnvelope = { eventComponents: WorksEvent[]; organizerCalendarId: string };
export type WorksListResult = { events: WorksEventEnvelope[] };
