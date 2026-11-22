import { readAppClock } from '../../../data/db/app-clock';
import { addDays } from '../../../data/db/time';
import { isNightHour } from '../../../data/marketing/calc';

export const nightSmsCopy = {
  confirmLabel: '내일 아침 8시에 보내기',
  reason: '밤 9시~아침 8시에는 광고 문자를 바로 보낼 수 없어서 내일 아침 8시로 예약해요',
};

export function nextNightSmsAt(sameDayBeforeOpening = false) {
  const { local } = readAppClock();
  const hour = Number(local.slice(11, 13));
  return isNightHour(hour) ? `${addDays(local.slice(0, 10), sameDayBeforeOpening && hour < 8 ? 0 : 1)}T08:00` : undefined;
}
