import { APP_CLOCK, readAppClock } from '../data/db/app-clock';

export const POS_BUSINESS_DATE = APP_CLOCK.businessDate;
export const POS_NOW_TIME = APP_CLOCK.time;
export const POS_NOW = APP_CLOCK.local;
export const businessNow = (): string => readAppClock().local;
