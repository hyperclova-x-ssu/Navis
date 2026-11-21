import manifest from '../data/db/generated/manifest.json';

/** D-248: business timestamps never use the device clock or approval timers. */
export const POS_BUSINESS_DATE = manifest.cutoff.businessDate;
export const POS_NOW_TIME = manifest.cutoff.localTime.slice(0, 5);
export const POS_NOW = `${POS_BUSINESS_DATE}T${POS_NOW_TIME}`;
export const businessNow = (): string => POS_NOW;
