import {HOURLY_DWELL, splitSeconds} from '../../../data/cctv';
import type {CctvView} from '../../../data/cctv';
import {useBundle} from '../../../i18n';
import {cctvBundle} from '../messages';
import type {CctvMessageKey} from '../messages';

const SEAT_WINDOW_SEC = 300; // the file's table stay is over the last 5 minutes (DATA_MODEL 12.7)

/** Mock averages (SCR-346): hourly average stay bars with today's average, and stay time per table. Values come from the file data, never recomputed here. */
export function StayCharts({view}: {readonly view: CctvView}) {
  const {t} = useBundle(cctvBundle);
  const maxMin = Math.max(1, ...HOURLY_DWELL.map(r => r.minutes));
  const today = view.avgDwell.kind === 'mock-minutes' ? view.avgDwell.minutes : null;
  return <div className="cctv-charts">
    <section className="cctv-chart" aria-labelledby="cctv-avg-title">
      <h3 id="cctv-avg-title">{t('cctv.avg.mock')}</h3>
      {today === null ? null : <p className="cctv-caption">{t('cctv.avg.mockToday', {n: today})}</p>}
      <ul className="cctv-bars cctv-bars--col">
        {HOURLY_DWELL.map(r => <li key={r.hour} data-testid="stay-hour" aria-label={t('cctv.avg.hourBar', {h: r.hour, n: r.minutes})}>
          <span className="cctv-bar__value" aria-hidden="true">{t('cctv.avg.minutes', {n: r.minutes})}</span>
          <span className="cctv-bar__track"><span className="cctv-bar__fill" style={{height: `${Math.round((r.minutes / maxMin) * 100)}%`}}/></span>
          <span className="cctv-bar__name" aria-hidden="true">{t('cctv.avg.hourLabel', {h: r.hour})}</span>
        </li>)}
      </ul>
    </section>
    <section className="cctv-chart" aria-labelledby="cctv-seat-title">
      <h3 id="cctv-seat-title">{t('cctv.seats.title')}</h3>
      <p className="cctv-caption">{t('cctv.occupied.caption')}</p>
      <ul className="cctv-bars cctv-bars--row">
        {view.tables.map(x => {
          const sec = x.occupiedSeconds ?? 0, s = splitSeconds(sec);
          const name = t(x.label.key as CctvMessageKey, x.label.params);
          const time = t('cctv.avg.minutesSeconds', {m: s.minutes, s: s.seconds});
          return <li key={x.id} data-testid="stay-seat" aria-label={t('cctv.seats.row', {name, time})}>
            <span className="cctv-bar__name" aria-hidden="true">{name}</span>
            <span className="cctv-bar__track"><span className="cctv-bar__fill" style={{width: `${Math.min(100, Math.round((sec / SEAT_WINDOW_SEC) * 100))}%`}}/></span>
            <span className="cctv-bar__value" aria-hidden="true">{time}</span>
          </li>;
        })}
      </ul>
    </section>
  </div>;
}
