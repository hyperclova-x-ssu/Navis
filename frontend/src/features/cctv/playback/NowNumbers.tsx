import type {CctvView} from '../../../data/cctv';
import {formatClock} from '../../../data/cctv';
import {useBundle} from '../../../i18n';
import {cctvBundle} from '../messages';
import type {CctvMessageKey} from '../messages';
import {tableStateText} from './tableStateText';

/** Numbers come straight from the `CctvView`; never recomputed from persons/cups. */
export function NowNumbers({view, time, duration}: {readonly view: CctvView; readonly time: number; readonly duration: number}) {
  const {t} = useBundle(cctvBundle);
  const inUse = view.tables.filter(x => x.state === 'occupied').length;
  const clear = view.tables.filter(x => x.state === 'clear').length;
  const c = view.change5m;
  const change = c === null ? t('cctv.change.none') : c === 0 ? t('cctv.change.flat') : t(c > 0 ? 'cctv.change.up' : 'cctv.change.down', {n: Math.abs(c)});
  return <section className="cctv-now" aria-label={t('cctv.nowNumbers.mock')}>
    <h3>{t('cctv.nowNumbers.mock')}</h3>
    <p className="cctv-now__main"><strong data-testid="now-instore">{view.inStore === null ? '—' : t('cctv.guests', {n: view.inStore})}</strong></p>
    <p className="cctv-now__row" data-testid="now-change">{change}</p>
    <p className="cctv-now__row" data-testid="now-seats">{t('cctv.tables.inUse', {a: inUse, b: view.tables.length})}</p>
    <p className="cctv-now__row" data-testid="now-clear">{t('cctv.tables.toClear', {n: clear})}</p>
    <p className="cctv-now__time">{formatClock(time)} / {formatClock(duration)}</p>
    <details className="cctv-now__states"><summary>{t('cctv.tables.showStates')}</summary>
      <ul>{view.tables.map(x => <li key={x.id}>{t('cctv.table.row', {name: t(x.label.key as CctvMessageKey, x.label.params), state: tableStateText(x, t)})}</li>)}</ul>
    </details>
  </section>;
}
