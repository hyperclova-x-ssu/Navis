import {formatClock, type CctvTableView} from '../../../data/cctv';
import type {MessageParams} from '../../../i18n';
import type {CctvMessageKey} from '../messages';

export type TableStateTranslator = (key: CctvMessageKey, params?: MessageParams) => string;

export function tableStateText(table: CctvTableView, t: TableStateTranslator): string {
  const wait = table.drinkWait;
  if (!wait || wait.state === 'inactive') return t(`cctv.table.state.${table.state}`);
  if (wait.state === 'checking') return t('cctv.table.drinkWait.checking');
  if (wait.state === 'start-unknown') return t('cctv.table.drinkWait.unknown');
  if (wait.seconds === null) return t('cctv.table.drinkWait.notMeasured');

  const [m, s] = formatClock(wait.seconds).split(':').map(Number);
  const time = m ? t('cctv.avg.minutesSeconds', {m, s}) : t('cctv.avg.seconds', {s});
  return t(`cctv.table.drinkWait.${wait.state}`, {time});
}
