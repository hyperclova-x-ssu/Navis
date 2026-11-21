import { selectCustomAccounting } from '../../../data/iteration7/custom-orders';
import { TODAY } from '../../../data/db/time';
import { StatusChip } from '../../../ui';
import { customAccountingCopy as copy } from '../mgmt-money/iteration7-accounting-messages';
import { money } from './copy';
import { useCustomOrderSource } from './use-custom';

/** Display domain recognition rows; shared data composition supplies all enclosing totals. */
export function CustomSalesBreakdown({ period }: { readonly period: { readonly start: string; readonly end: string } }) {
  const { read, state } = useCustomOrderSource();
  if (!read || state !== 'ready') return null;
  const date = read.businessDate ?? TODAY;
  if (date < period.start || date > period.end) return null;
  const accounting = selectCustomAccounting(read, { date });
  if (!accounting.rows.length) return null;
  return <section className="mm-card custom-sales" lang="ko" aria-label={copy.title}>
    <h3 className="mm-card__title">{copy.title}</h3>
    <table className="mm-table"><thead><tr><th scope="col">{copy.product}</th><th scope="col">{copy.sales}</th><th scope="col">{copy.cost}</th></tr></thead><tbody>{accounting.rows.map(row => <tr key={row.recognitionId}><th scope="row">{row.productLabel}</th><td>{money(row.amount)}</td><td><StatusChip tone="warning">{copy.unknownCost}</StatusChip></td></tr>)}</tbody></table>
  </section>;
}
