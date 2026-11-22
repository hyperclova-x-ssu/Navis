export type CalendarPushRequest = { approvalId: string; expectedRevision: number };
export type WorksPushRequest = CalendarPushRequest & { expectedStaffRevision: number };
type ExportReceipt = { resourceId: string; receiptId: string; revision: number; sentAt: string };
export type CalendarPushReceipt = ExportReceipt & {
  eventId: string; processType: 'create' | 'modify'; affectedSources: ['calendar'];
};
export type WorksTime = { date: string } | { dateTime: string; timeZone: 'Asia/Seoul' };
export type WorksEvent = { eventId: string; summary: string; start: WorksTime; end?: WorksTime };
export type WorksPushReceipt = ExportReceipt & {
  scheduleId: string; eventId: string; operation: 'create' | 'update' | 'delete'; affectedSources: ['staff-schedule'];
};
export type WorksList = { items: (WorksEvent & { scheduleId: string; revision: number; sentAt: string })[] };
