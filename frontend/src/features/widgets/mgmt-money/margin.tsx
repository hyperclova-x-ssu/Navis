/** 마진·원가분석 (F-28, SCR-13/30/31): panel, detail with period/sort/menu breakdown and the price·cost calculator. */
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { QueryCondition, WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useWidgetView } from '../../../data/react';
import { resolveDataText, simulateMenuPrice, supportedConditions, type MarginMenuRow, type MarginModel } from '../../../data/widget-data';
import { ActionButton, ChipChoice, DataGrid, NumberField, StatusBadge, renderStatusChip, type DataGridHandle, type GridColumn, type GridFocus, type GridSort } from '../../../ui';
import {
  DetailViewState, Kpi, MiniSeries, MoneyPanel, MONEY_FIT, NoteLine, PERIOD_KEYS, ViewState, splitFormatted, splitMoney, useMoneyT, useSizeCtx,
  type ChartData, type PanelSpec, type RowData, type T,
} from './shared';
import { CustomSalesBreakdown } from '../i7-custom/accounting';
import { AccountingUnknownCosts, accountingForPeriod, useAccountingPresentation, type AccountingDetailProps } from './ledger';

const ID = 'margin' as const;

const rateText = (t: T, rate: number | null) => (rate === null ? t('widget.margin.unknown') : `${rate.toFixed(1)}%`);
function compareText(t: T, model: MarginModel): string | undefined {
  const c = model.comparison;
  if (!c) return undefined;
  return t(model.period.start === model.period.end ? 'widget.margin.vsWeek' : 'widget.margin.vsPrev', { delta: t.format.delta(c.delta.value, 'pp') });
}
const trendChart = (t: T, model: MarginModel): ChartData | undefined => {
  const points = model.trend.filter((p) => p.rate !== null);
  if (points.length === 0) return undefined;
  const week = points.length <= 7;
  return { values: points.map((p) => p.rate ?? 0), labels: points.map((p) => week ? t.format.weekday(p.date, 'short') : t.format.date(p.date, 'short')), kind: 'line', ariaLabel: t('widget.margin.trend'), format: (n) => t.format.percent(n, 1) };
};
const menuRow = (t: T, m: MarginMenuRow): RowData => ({
  id: m.menuId, name: resolveDataText(t, m.name), semanticValue: m.rate,
  ...(m.rate === null ? { badge: <StatusBadge kind="needsReview" label={t('widget.margin.missingCost')} /> } : { value: rateText(t, m.rate) }),
});

function buildSpec(t: T, model: MarginModel, notes: ReactNode, shape: string): PanelSpec {
  const known = model.rate !== null;
  const value = known ? { value: t.format.percent(model.rate as number, 1), unit: '' } : { value: model.costMissing ? t('data.state.margin.missing-cost') : t('widget.margin.unknown'), unit: '' };
  const money = (n: number | null) => (n === null ? t('widget.margin.unknown') : t.format.money(n, 'compact'));
  const totals: RowData[] = [
    { id: 'netSales', name: t('widget.margin.netSales'), value: t.format.money(model.netSales, 'full'), semanticValue: model.netSales },
    { id: 'cost', name: t('widget.margin.cost'), value: model.cost === null ? money(null) : t.format.money(model.cost, 'full'), semanticValue: model.cost },
    { id: 'grossProfit', name: t('widget.margin.grossProfit'), value: model.grossProfit === null ? money(null) : t.format.money(model.grossProfit, 'full'), semanticValue: model.grossProfit },
  ];
  const menus = model.menus.map((m) => menuRow(t, m));
  const rows = shape === 'L' ? [...totals, ...menus] : shape === 'S' ? totals : menus;
  return {
    slot: ID, label: t('widget.margin.rate'), value: value.value, semanticValue: model.rate, unit: value.unit, state: !known ? { message: value.value, tone: 'warning' } : undefined, sub: known ? compareText(t, model) : undefined,
    rows, rowsTitle: shape === 'T' || shape === 'L' ? t('widget.margin.menuBreakdown') : undefined,
    chart: trendChart(t, model), chartInW: true, fitOrder: shape === 'W' ? MONEY_FIT.filter(part => part.selector !== '.mm-chart') : undefined, limitRows: shape === 'T' || shape === 'L', tightL: true, status: known ? notes : undefined,
  };
}

export function MarginPanel(props: WidgetPanelProps) {
  const t = useMoneyT();
  const ctx = useSizeCtx(props);
  const view = useWidgetView(ID, props.condition);
  if (view.status !== 'ready') return <ViewState view={view} ctx={ctx} host={props.host} featureId={ID} t={t} />;
  return <MoneyPanel spec={buildSpec(t, view.model, <NoteLine notes={view.notes} t={t} />, ctx.shape)} ctx={ctx} />;
}

export function useMarginSummary({ condition }: { featureId: unknown; condition: QueryCondition }): string {
  const t = useMoneyT();
  const view = useWidgetView(ID, condition);
  if (view.status !== 'ready') return t(view.messageKey);
  const label = t('widget.margin.rate'), rate = rateText(t, view.model.rate), compare = compareText(t, view.model);
  return view.model.rate !== null && compare ? t('widget.margin.summary', { label, rate, compare }) : t('widget.margin.summaryPlain', { label, rate: view.model.rate === null ? t('data.state.margin.missing-cost') : rate });
}

/* ---------- detail ---------- */
type PeriodKey = 'today' | 'last7' | 'last30';
const PERIODS: readonly PeriodKey[] = ['today', 'last7', 'last30'];
const conditions = supportedConditions(ID);
const conditionFor = (p: PeriodKey): QueryCondition => conditions[PERIODS.indexOf(p)] ?? conditions[0]!;
function periodOf(condition: QueryCondition): PeriodKey {
  const index = conditions.findIndex((c) => c.kind === condition.kind && (c.kind !== 'dateRange' || (condition.kind === 'dateRange' && c.start === condition.start && c.end === condition.end)));
  return PERIODS[Math.max(0, index)] ?? 'today';
}
/** Rows without a registered cost come first, then the lowest margin; a header sort replaces this order. */
const lowestMarginFirst = (a: MarginMenuRow, b: MarginMenuRow) => Number(b.costMissing) - Number(a.costMissing) || (a.rate ?? Infinity) - (b.rate ?? Infinity) || a.menuId.localeCompare(b.menuId);

export function MarginDetail({ condition, detailRef, host, accounting: explicitAccounting }: AccountingDetailProps) {
  const t = useMoneyT();
  const [period, setPeriod] = useState<PeriodKey>(() => periodOf(detailRef.condition ?? condition));
  const [selectedId, setSelectedId] = useState<string | null>(detailRef.itemId ?? null);
  const [gridSort, setGridSort] = useState<GridSort>({ columnId: 'rate', direction: 'asc' });
  const [focus, setFocus] = useState<GridFocus>(null);
  const gridRef = useRef<DataGridHandle>(null);
  const simulatorPrice = useRef<HTMLInputElement>(null);
  const view = useWidgetView(ID, conditionFor(period));
  const ledgerView = useWidgetView('ledger', conditionFor(period));
  const presentation = useAccountingPresentation();
  const entryId = detailRef.itemId;
  const simulatorEntry = detailRef.view === 'simulator';
  const hasEntry = view.status === 'ready' && view.model.menus.some(row => row.menuId === entryId);
  useLayoutEffect(() => {
    if (!entryId || !hasEntry) return;
    const frame = requestAnimationFrame(() => {
      if (simulatorEntry && simulatorPrice.current) simulatorPrice.current.focus();
      else if (gridRef.current?.focusCell(entryId, 'name')) {
        document.activeElement?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [entryId, hasEntry, simulatorEntry]);
  const fields = simulatorEntry && detailRef.prefill?.kind === 'widget-draft' ? detailRef.prefill.fields : undefined;
  const price = fields?.price;
  const cost = fields?.cost;
  const prefill = {
    price: typeof price === 'number' && Number.isSafeInteger(price) && price > 0 ? price : undefined,
    cost: typeof cost === 'number' && Number.isSafeInteger(cost) && cost >= 0 ? cost : undefined,
  };
  const periodChips = <ChipChoice label={t('widget.margin.periodLabel')} value={period} onChange={setPeriod} options={PERIODS.map((p) => ({ value: p, label: t(PERIOD_KEYS[p]) }))} />;
  const widerPeriod = PERIODS[PERIODS.indexOf(period) + 1];
  if (view.status !== 'ready') return <div className="mm-detail" data-widget={ID}>{periodChips}<DetailViewState view={view} host={host} t={t} nextAction={widerPeriod ? { label: t('widget.ledger.seePeriod', { period: t(PERIOD_KEYS[widerPeriod]) }), onPress: () => setPeriod(widerPeriod) } : undefined} /></div>;
  const m = view.model;
  const accounting = accountingForPeriod(presentation, m.period, explicitAccounting);
  const menus = [...m.menus].sort(gridSort && !(gridSort.columnId === 'rate' && gridSort.direction === 'asc') ? (a, b) => {
    const field = gridSort.columnId as 'price' | 'unitCost' | 'unitMargin' | 'rate' | 'qty';
    const av = a[field] ?? -Infinity, bv = b[field] ?? -Infinity;
    return (av - bv) * (gridSort.direction === 'asc' ? 1 : -1) || a.menuId.localeCompare(b.menuId);
  } : lowestMarginFirst);
  const selected = menus.find((x) => x.menuId === selectedId) ?? null;
  const money = (n: number | null) => (n === null ? t('widget.margin.unknown') : t.format.money(n, 'compact'));
  /** Table columns hold exact won, so one column never mixes 1.2만 원 with 5,500원 (DS 6.1). */
  const exact = (n: number | null) => (n === null ? t('widget.margin.unknown') : t.format.money(n, 'full'));
  const split = (n: number | null) => (n === null ? { value: t('widget.margin.unknown'), unit: '' } : splitMoney(t, n));
  const rate = m.rate === null ? { value: m.costMissing ? t('data.state.margin.missing-cost') : t('widget.margin.unknown'), unit: '' } : splitFormatted(t.format.percent(m.rate, 1));
  const chart = trendChart(t, m);
  const compare = compareText(t, m);
  return (
    <div className="mm-detail mm-detail--grid" data-widget={ID}>
      <section className="mm-detail__overview" tabIndex={0} aria-label={t('widget.margin.title')}>
        <div className="mm-detail__tools">{periodChips}</div>
        <div className="mm-kpis" data-slot="margin.kpis">
          <Kpi slot="margin.kpi.rate" label={t('widget.margin.rate')} value={rate.value} unit={rate.unit} semanticValue={m.rate} tone={m.rate === null ? 'warning' : undefined} />
          <Kpi slot="margin.kpi.netSales" label={t('widget.margin.netSales')} value={split(m.netSales).value} unit={split(m.netSales).unit} semanticValue={m.netSales} />
          <Kpi slot="margin.kpi.cost" label={t('widget.margin.cost')} value={split(m.cost).value} unit={split(m.cost).unit} semanticValue={m.cost} />
          <Kpi slot="margin.kpi.grossProfit" label={t('widget.margin.grossProfit')} value={split(m.grossProfit).value} unit={split(m.grossProfit).unit} semanticValue={m.grossProfit} />
        </div>
        {compare ? <p className="mm-detail__note">{compare}</p> : null}
        {m.costMissing ? <p className="mm-detail__note"><StatusBadge kind="needsReview" label={t('data.state.margin.missing-cost')} /></p> : null}
        {accounting ? accounting.status === 'ready' ? <AccountingUnknownCosts rows={accounting.unknownCostSales ?? []} /> : null : <CustomSalesBreakdown period={m.period} />}
        {chart ? (
          <section className="mm-card" aria-label={t('widget.margin.trend')}>
            <h3 className="mm-card__title">{t('widget.margin.trend')}</h3>
            <MiniSeries data={{ ...chart, allLabels: chart.values.length <= 7, valueLabels: chart.values.length <= 7 }} className="mm-chart--detail" />
            <p className="mm-muted">{t('widget.margin.axisNote')}</p>
          </section>
        ) : null}
        <section className="mm-card" aria-label={t('widget.margin.contribution')}><h3 lang="ko">{t('widget.margin.contribution')}</h3><ul className="mm-contributions">{[...m.menus].sort((a, b) => (b.contribution ?? 0) - (a.contribution ?? 0)).map(row => <li key={row.menuId}><span>{resolveDataText(t, row.name)}</span><meter aria-label={resolveDataText(t, row.name)} min={0} max={Math.max(1, ...m.menus.map(item => item.contribution ?? 0))} value={Math.max(0, row.contribution ?? 0)} /><strong>{money(row.contribution)}</strong></li>)}</ul>{ledgerView.status === 'ready' && m.grossProfit !== null ? <p lang="ko">{t('widget.margin.contributionEquation', { sales: money(m.netSales), cost: money(m.cost), discount: money(ledgerView.model.sales.discount), refund: money(ledgerView.model.sales.refund), profit: money(m.grossProfit) })}</p> : null}{m.menus.length ? <p lang="ko">{t('widget.margin.highest', { name: resolveDataText(t, [...m.menus].sort((a, b) => (b.contribution ?? 0) - (a.contribution ?? 0))[0]!.name) })}</p> : null}</section>
        {!selected ? <p className="mm-muted">{t('widget.margin.selectMenu')}</p> : null}
      </section>
      <section className="mm-card mm-margin-items" aria-label={t('widget.margin.menuBreakdown')}>
        <h3 className="mm-card__title">{t('widget.margin.menuBreakdown')}</h3>
        <p lang="ko">{t('widget.margin.saleCostNote')}</p>
        <DataGrid ref={gridRef} id="margin-items" label={t('widget.margin.itemGrid')} rows={menus} getRowId={row => row.menuId} getRowLabel={row => resolveDataText(t, row.name)} columns={[
          { id: 'name', header: t('widget.margin.col.menu'), kind: 'text', minWidth: 180, value: row => resolveDataText(t, row.name) },
          { id: 'price', header: t('widget.margin.salePrice'), kind: 'number', sortable: true, minWidth: 120, value: row => exact(row.price) },
          { id: 'unitCost', header: t('widget.margin.currentCost'), kind: 'number', sortable: true, minWidth: 120, value: row => exact(row.unitCost), render: row => row.unitCost === null ? renderStatusChip(t('widget.margin.missingCost'), 'warning') : exact(row.unitCost), accessibleValue: row => row.unitCost === null ? t('widget.margin.missingCost') : exact(row.unitCost) },
          { id: 'unitMargin', header: t('widget.margin.currentProfit'), kind: 'number', sortable: true, minWidth: 120, value: row => exact(row.unitMargin) },
          { id: 'rate', header: t('widget.margin.col.rate'), kind: 'number', sortable: true, minWidth: 120, value: row => row.rate === null ? t('widget.margin.missingCost') : rateText(t, row.rate), render: row => row.rate === null ? renderStatusChip(t('widget.margin.missingCost'), 'warning') : rateText(t, row.rate), accessibleValue: row => row.rate === null ? t('widget.margin.missingCost') : rateText(t, row.rate) },
          { id: 'qty', header: t('widget.margin.col.qty'), kind: 'number', sortable: true, minWidth: 100, value: row => row.qty },
        ] satisfies GridColumn<MarginMenuRow>[]} sort={gridSort} onSortChange={setGridSort} focus={focus} onFocusChange={setFocus} selectedRowId={selected?.menuId ?? null} onSelectionChange={setSelectedId} expandedRowIds={new Set(selected ? [selected.menuId] : [])} renderExpanded={row => <MenuBreakdown key={`${row.menuId}:${row.price}:${row.unitCost}`} t={t} menu={row} host={host} prefill={row.menuId === entryId ? prefill : undefined} priceRef={simulatorEntry && row.menuId === entryId ? simulatorPrice : undefined} />} emptyContent={t('data.state.margin.no-sales')} />
      </section>
    </div>
  );
}

function MenuBreakdown({ t, menu, host, prefill, priceRef }: {
  readonly t: T; readonly menu: MarginMenuRow; readonly host: WidgetDetailProps['host'];
  readonly prefill?: { readonly price?: number; readonly cost?: number };
  readonly priceRef?: RefObject<HTMLInputElement | null>;
}) {
  const [price, setPrice] = useState<number | null>(prefill?.price ?? menu.price);
  const [cost, setCost] = useState<number | null>(prefill?.cost ?? menu.unitCost);
  const full = (n: number) => t.format.money(n, 'full');
  const base = menu.unitCost === null ? undefined : { price: menu.price, unitCost: menu.unitCost };
  const result = price !== null && cost !== null ? simulateMenuPrice({ price, unitCost: cost }, base) : null;
  const signed = (n: number) => `${n < 0 ? '−' : n > 0 ? '+' : ''}${full(Math.abs(n))}`;
  const minus = (text: string) => text.replace(/^-/, '−');
  return (
    <section className="mm-card mm-menu" aria-label={resolveDataText(t, menu.name)} data-slot="margin.menu-detail" data-menu-id={menu.menuId}>
      <h3 className="mm-card__title">{resolveDataText(t, menu.name)}</h3>
      <div className="mm-menu__grid">
        <div>
          <dl className="mm-dl">
            <div><dt>{t('widget.margin.price')}</dt><dd>{full(menu.price)}</dd></div>
            <div><dt>{t('widget.margin.unitCost')}</dt><dd>{menu.unitCost === null ? <StatusBadge kind="needsReview" label={t('widget.margin.missingCost')} /> : full(menu.unitCost)}</dd></div>
          </dl>
          <h4 className="mm-card__subtitle mm-spaced">{t('widget.margin.recipe')}</h4>
          <ul className="mm-plain-list" data-slot="margin.recipe">
            {menu.recipe.map((part, i) => <li key={`${part.nameKey}-${i}`}><span>{t(part.nameKey)}{'\u00A0'}· {t.format.quantity(part.qty.value, part.qty.unit)}</span><strong>{full(part.cost)}</strong></li>)}
          </ul>
          <p className="mm-muted">{t('widget.margin.effectiveFrom', { date: t.format.date(menu.costEffectiveFrom, 'long') })}</p><ActionButton variant="outline" onClick={() => host.openLinked({ featureId: 'menu', itemId: menu.menuId })}>{t('widget.margin.openMenu')}</ActionButton><ActionButton variant="outline" onClick={() => host.openLinked({ featureId: 'suppliers' })}>{t('widget.margin.openSuppliers')}</ActionButton>
        </div>
        <div className="mm-sim" data-slot="margin.simulator">
          <h4 className="mm-card__subtitle">{t('widget.margin.simulate')}</h4>
          <NumberField inputRef={priceRef} label={t('widget.margin.simPrice')} value={price} onValueChange={setPrice} min={0} unit={t('widget.ledger.currency')} />
          <NumberField label={t('widget.margin.simCost')} value={cost} onValueChange={setCost} min={0} unit={t('widget.ledger.currency')} />
          <div className="mm-sim__result" role="status" aria-live="polite">
            <p className="mm-sim__tag"><StatusBadge kind="suggested" label={t('widget.margin.notActual')} /></p>
            {result ? (
              <><p className="mm-muted">{t('widget.margin.perUnit')}</p>
              <dl className="mm-dl" data-slot="margin.sim-result">
                <div><dt>{t('widget.margin.simProfit')}</dt><dd data-slot="margin.sim-profit">{minus(full(result.profit))}</dd></div>
                <div><dt>{t('widget.margin.simRate')}</dt><dd data-slot="margin.sim-rate">{minus(t.format.percent(result.rate, 1))}</dd></div>
                {result.profitDelta !== undefined && result.rateDelta !== undefined ? <div><dt>{t('widget.margin.simDiff')}</dt><dd data-slot="margin.sim-diff">{signed(result.profitDelta)}{'\u00A0'}· {t.format.delta(result.rateDelta, 'pp')}</dd></div> : null}
              </dl></>
            ) : <p className="mm-muted" data-slot="margin.sim-invalid">{t('widget.margin.simInvalid')}</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

export const marginModule: WidgetModule = { id: ID, Panel: MarginPanel, Detail: MarginDetail, useSummary: useMarginSummary };
