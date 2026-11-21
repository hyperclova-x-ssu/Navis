/**
 * 당일 소진 쿠폰 (expiry-coupon, F-49, SCR-37/38): panel (크루아상 6개 + PanelAction) and the make flow
 * (item -> one ordinary benefit: 정률 할인 % / 금액 할인 원 / 세트 가격 원, a segmented choice and one value field -> where to send -> confirm).
 * Text coupons go out as ‘보냈어요(예시)’; place news ends with copy text and the owner pressing ‘올렸어요’ (nothing counts before).
 */
import { useRef, useState } from 'react';
import { validateAgentPrefill } from '../../../../shared/navis-agent-schema.mjs';
import type { WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useDataDispatch, useWidgetView } from '../../../data/react';
import { benefitMax, benefitName, benefitPrice, benefitProblem, expiryDiscount, expirySmsBody } from '../../../data/widget-data';
import type { CouponBenefit, CouponBenefitKind, ExpiryCouponModel, ExpiryItem } from '../../../data/widget-data';
import { ActionButton, ChipChoice, ConfirmStep, CopyThenPosted, DiscountSummary, FormulaRow, Icon, NumberField, useKitT } from '../../../ui';
import { koreanLang } from '../mkt-local/fit';
import { MktPanel } from './panel';
import { DetailNotReady, FixedSmsPreview, NoteLine, PanelNotReady, reportResult, useActionFocus, useFormKey, useMkt, useSendPhase, SentStatus } from './shared';

const ID = 'expiry-coupon' as const;
type Route = 'sms' | 'place_news';
const KINDS: readonly CouponBenefitKind[] = ['percent', 'amount', 'setPrice'];

/** The starting value of each kind: the suggested percent, and the same price as a won amount / a set price (whole hundreds). */
function startValue(kind: CouponBenefitKind, item: ExpiryItem): number {
  const rate = item.recommendedRate ?? 0;
  if (kind === 'percent') return rate;
  const discounted = Math.round((item.price * (100 - rate)) / 100);
  return kind === 'amount' ? Math.round((item.price - discounted) / 100) * 100 : Math.round(discounted / 100) * 100;
}

export function ExpiryCouponPanel({ width, height, shape, editing, host }: WidgetPanelProps) {
  const { t, f } = useMkt();
  const view = useWidgetView(ID);
  const name = t('widget.expiry-coupon.title');
  if (view.status !== 'ready') return <PanelNotReady view={view} widgetName={name} host={host} shape={shape} width={width} />;
  const m = view.model;
  const item = m.target;
  if (!item) return null;
  const itemName = t(item.nameKey);
  const note = view.notes?.[0];
  const canMake = m.canCreate && !item.handled;
  const short = t('widget.expiry-coupon.panelQ', { item: itemName });
  const descs = item.handled ? [t('widget.expiry-coupon.alreadyMade')]
    : shape === 'Q' ? [note ? t(note.messageKey) : short]
      : item.recommendedRate === null || shape === 'T' ? [short] : [t('widget.expiry-coupon.panelW', { item: itemName, p: item.recommendedRate }), short];
  const rows = [
    ...(shape === 'T' ? [<li key="item" lang={koreanLang(itemName)} data-row-id={item.itemId}>{t('widget.expiry-coupon.itemLine', { item: itemName, qty: f.count(item.qty, 'pcs'), until: t('widget.coupon-status.untilToday') })}</li>] : []),
    ...(item.maxSliderRate !== null ? [<li key="limit">{t('widget.expiry-coupon.limit', { p: item.maxRatePercent ?? 0 })}</li>] : []),
  ];
  return <MktPanel id={ID} shape={shape} width={width} height={height} editing={editing}
    label={itemName} kpi={{ value: String(item.qty), unit: item.unit === 'pcs' ? t('widget.expiry-coupon.unitName') : '' }}
    descs={descs} aside={view.notes?.length ? <NoteLine notes={view.notes} compact={editing} /> : undefined} rows={rows}
    action={canMake ? { label: t('marketing.createCoupon'), widgetName: name, onPress: () => host.openDetail({ featureId: ID, focus: 'action' }) } : null} />;
}

export function useExpiryCouponSummary(): string {
  const { t, f } = useMkt();
  const view = useWidgetView(ID);
  if (view.status !== 'ready' || !view.model.target) return view.status === 'ready' ? t('widget.expiry-coupon.title') : t(view.messageKey);
  return t('widget.expiry-coupon.summary', { item: t(view.model.target.nameKey), qty: f.count(view.model.target.qty, 'pcs') });
}

export function ExpiryCouponDetail({ detailRef, host }: WidgetDetailProps) {
  const view = useWidgetView(ID);
  const root = useRef<HTMLDivElement>(null);
  useActionFocus(root, detailRef);
  const draft = detailRef.prefill?.kind === 'widget-draft' ? detailRef.prefill : undefined;
  const { route: requestedRoute, ...prefill } = draft?.fields ?? {};
  const fields = validateAgentPrefill(ID, prefill) ? prefill : undefined;
  const route = draft?.command === 'coupon.createExpiry' && requestedRoute === 'place_news' ? 'place_news' : undefined;
  const item = view.status === 'ready'
    ? view.model.items.find(row => row.itemId === (detailRef.itemId ?? fields?.itemId)) ?? view.model.target : null;
  const rate = item && typeof fields?.rate === 'number' && item.maxSliderRate !== null && fields.rate <= item.maxSliderRate
    ? fields.rate : undefined;
  return <div ref={root} className="mkt-detail" data-widget={ID}>
    {view.status !== 'ready' ? <DetailNotReady view={view} host={host} /> : item ? <ExpiryFlow key={item.itemId}
      model={view.model} item={item} notes={view.notes} host={host} rate={rate} initialRoute={route} /> : null}
  </div>;
}

function ExpiryFlow({ model, item, notes, host, rate, initialRoute }: { readonly rate?: number; readonly initialRoute?: Route; readonly model: ExpiryCouponModel; readonly item: ExpiryItem; readonly notes: Parameters<typeof NoteLine>[0]['notes']; readonly host: WidgetDetailProps['host'] }) {
  const { t, f, dt, money, locale } = useMkt();
  const kit = useKitT();
  const dispatch = useDataDispatch();
  const { phase, setPhase, startSending } = useSendPhase();
  const [key] = useFormKey('expiry');
  const postKeys = useRef(new Map<string, string>());
  const [kind, setKind] = useState<CouponBenefitKind>('percent');
  const [value, setValue] = useState<number | null>(rate ?? item.recommendedRate ?? 0);
  const [route, setRoute] = useState<Route>(initialRoute ?? 'sms');
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState(false);
  const [submitted, setSubmitted] = useState<{ readonly route: Route; readonly count: number; readonly benefit: string } | null>(null);

  const itemName = t(item.nameKey);
  const known = item.unitCost !== null && item.maxSliderRate !== null;
  const cost = item.unitCost ?? 0;
  const benefit: CouponBenefit | null = value === null ? null : { kind, value };
  const problem = benefit ? benefitProblem(benefit, item.price, item.unitCost) : kind === 'percent' ? 'percentRange' : kind === 'amount' ? 'amountRange' : 'setPriceRange';
  // The text, the summary and the confirmation show the real benefit; while the field is wrong they show the starting one.
  const shown: CouponBenefit = benefit && !problem ? benefit : { kind, value: startValue(kind, item) };
  const calc = known ? expiryDiscount(item.price, cost, 0, item.qty) : null;
  const paid = benefitPrice(item.price, shown);
  const profit = paid - cost;
  const recipients = model.routes.sms.recipients;
  const made = item.handled;
  const disabled = !model.canCreate || made;
  const routeBlocked = route === 'sms' && recipients === 0;
  const smsBody = dt(expirySmsBody(item.nameKey, shown));
  const routeName = route === 'sms' ? t('data.marketing.route.sms') : t('data.marketing.route.placeNews');
  const benefitText = dt(benefitName(shown));
  const unit = kind === 'percent' ? '%' : t('widget.expiry-coupon.unitWon');
  const pickKind = (next: string) => { const k = next as CouponBenefitKind; setKind(k); setValue(startValue(k, item)); setError(null); };
  const limitText = !known ? '' : kind === 'percent' ? t('widget.expiry-coupon.limit', { p: item.maxRatePercent ?? 0 })
    : kind === 'amount' ? t('widget.expiry-coupon.limitAmount', { amount: money(benefitMax('amount', item.price, cost)) }) : t('widget.expiry-coupon.limitSetPrice', { price: money(cost) });

  const create = () => {
    if (problem) { setError(t(problem === 'kind' ? 'data.marketing.error.benefitInvalid' : `data.marketing.error.${problem}`)); setPhase('form'); return; }
    const result = dispatch({ type: 'coupon.createExpiry', itemId: item.itemId, benefit: shown, route, idempotencyKey: key });
    const failure = reportResult(result, host, t, 'data.marketing.notice.couponCreated');
    if (failure) { setError(failure); setPhase('form'); return; }
    setError(null);
    setSubmitted({ route, count: recipients, benefit: benefitText });
    if (route === 'sms') startSending(); else setPhase('sent');
  };
  const markPosted = (codeId: string) => {
    if (!postKeys.current.has(codeId)) postKeys.current.set(codeId, `post-${codeId}`);
    const result = dispatch({ type: 'coupon.markPosted', codeId, idempotencyKey: postKeys.current.get(codeId)! });
    const failure = reportResult(result, host, t, 'data.marketing.notice.counting');
    if (failure) setError(failure); else setPosted(true);
  };

  return <div className="mkt-columns" data-slot="expiry-coupon.detail">
    <div className="mkt-col-main">
      <NoteLine notes={notes} />
      <section aria-labelledby="exp-step1">
        <h2 id="exp-step1">{t('widget.expiry-coupon.step1')}</h2>
        <ul className="mkt-items">{model.items.map((it) => <li key={it.itemId} data-row-id={it.itemId}>
          {t('widget.expiry-coupon.itemLine', { item: t(it.nameKey), qty: f.count(it.qty, 'pcs'), until: t('widget.coupon-status.untilToday') })}
        </li>)}</ul>
        {made ? <p className="mkt-reason" role="status"><Icon name="check" aria-hidden />{t('widget.expiry-coupon.alreadyMade')}</p> : null}
      </section>
      <section aria-labelledby="exp-step2">
        <h2 id="exp-step2">{t('widget.expiry-coupon.step2')}</h2>
        {known && calc ? <div className="mkt-benefit">
          <div data-first-control>
            <ChipChoice label={t('widget.expiry-coupon.kindLabel')} value={kind} onChange={pickKind}
              options={KINDS.map((k) => ({ value: k, label: t(`widget.expiry-coupon.kind.${k}`) }))} />
          </div>
          <NumberField label={t(`widget.expiry-coupon.valueLabel.${kind}`)} name="expiry-benefit-value" value={value} onValueChange={(v) => { setValue(v); setError(null); }}
            min={1} max={kind === 'percent' ? 100 : item.price} step={1} unit={unit} disabled={disabled}
            error={problem ? t(problem === 'kind' ? 'data.marketing.error.benefitInvalid' : `data.marketing.error.${problem}`) : undefined} />
          {locale === 'ko' ? <div className="ui-discount-summary"><p>{t('widget.expiry-coupon.moneySummary', { price: money(paid), profit: money(profit), total: money(profit * item.qty) })}</p><p className="ui-discount-summary__loss">{kit.t('ui.discount.loss', { amount: money(calc.lossIfDiscarded) })}</p></div> : <DiscountSummary price={money(paid)} profit={money(profit)} total={money(profit * item.qty)} lossCost={money(calc.lossIfDiscarded)} />}
          <p className="mkt-limit"><Icon name="info" aria-hidden />{limitText}</p>
          {kind === 'percent' ? <FormulaRow><p className="mkt-formula">{t('widget.expiry-coupon.formula', { max: item.maxRatePercent ?? 0, cost: money(cost), price: money(item.price) })}</p></FormulaRow> : null}
        </div> : null}
        <p className="mkt-hint">{t('widget.expiry-coupon.second')}</p>
      </section>
      <section aria-labelledby="exp-step3">
        <h2 id="exp-step3">{t('widget.expiry-coupon.step3')}</h2>
        <ChipChoice label={t('marketing.sendTo')} value={route} onChange={(v) => setRoute(v as Route)}
          options={[{ value: 'sms', label: t('widget.expiry-coupon.routeSms', { n: recipients }) }, { value: 'place_news', label: t('widget.expiry-coupon.routePlace') }]} />
      </section>
    </div>
    <div className="mkt-col-side">
      {phase === 'form' ? <>
        <section aria-labelledby="exp-preview">
          <h2 id="exp-preview">{route === 'sms' ? t('marketing.messagePreview') : t('widget.expiry-coupon.postTitle')}</h2>
          {route === 'sms' ? <FixedSmsPreview body={smsBody} recipientCount={recipients} showInsertionNotes /> : <p className="mkt-hint">{t('widget.expiry-coupon.placeHint')}</p>}
        </section>
        <ActionButton disabled={disabled || !known || routeBlocked || problem !== null} onClick={() => { setError(null); setPhase('confirm'); }} data-slot="expiry-coupon.create">{t('marketing.createCoupon')}</ActionButton>
        {routeBlocked ? <p className="mkt-reason" role="status">{t('marketing.noRecipients')}</p> : null}
        {error ? <p className="mkt-reason" role="alert"><Icon name="error" aria-hidden />{error}</p> : null}
      </> : (submitted?.route ?? route) === 'sms' ? (
        phase === 'sent' ? <SentStatus /> : <ConfirmStep count={submitted?.count ?? recipients} phase={phase === 'confirm' ? 'ask' : phase} onCancel={() => setPhase('form')} onSend={create}
          summary={[
            { label: t('widget.expiry-coupon.summaryItem'), value: itemName },
            { label: t('widget.expiry-coupon.summaryRoute'), value: routeName },
            { label: t('widget.expiry-coupon.summaryPrice'), value: submitted?.benefit ?? benefitText },
          ]} />
      ) : (
        <section className="mkt-confirm" aria-labelledby={phase === 'sent' ? undefined : 'exp-confirm'}>
          {phase !== 'sent' ? <h3 id="exp-confirm" tabIndex={-1} ref={(node) => node?.focus()}>{t('widget.expiry-coupon.confirmCreate')}</h3> : null}
          <dl><div><dt>{t('widget.expiry-coupon.summaryItem')}</dt><dd>{itemName}</dd></div><div><dt>{t('widget.expiry-coupon.summaryRoute')}</dt><dd>{routeName}</dd></div><div><dt>{t('widget.expiry-coupon.summaryPrice')}</dt><dd>{submitted?.benefit ?? benefitText}</dd></div></dl>
          {phase === 'sent' ? <p role="status"><Icon name="check" aria-hidden />{t('marketing.couponCreated')}</p> : <div className="mkt-actions">
            <ActionButton onClick={create}>{t('widget.expiry-coupon.create')}</ActionButton>
            <ActionButton variant="secondary" onClick={() => setPhase('form')}>{t('widget.expiry-coupon.notNow')}</ActionButton>
          </div>}
        </section>
      )}
      {model.pendingPosts.map((post) => <section key={post.codeId} className="mkt-post" aria-labelledby={`post-${post.codeId}`}>
        <h3 id={`post-${post.codeId}`}>{t('widget.expiry-coupon.postTitle')}</h3>
        <CopyThenPosted text={dt(post.post)} onPosted={() => markPosted(post.codeId)} />
      </section>)}
      {posted ? <p className="mkt-reason" role="status"><Icon name="check" aria-hidden />{t('widget.expiry-coupon.postedDone')}</p> : null}
      {model.created.length > 0 ? <section className="mkt-sent" aria-labelledby="exp-created">
        <h3 id="exp-created">{t('widget.expiry-coupon.createdTitle')}</h3>
        <ul>{model.created.map((row) => <li key={row.couponId}>{t('widget.slot-coupon.sentLine', { name: dt(row.name), used: row.used ?? 0, issued: row.issued, left: t('widget.coupon-status.untilToday') })}</li>)}</ul>
      </section> : null}
    </div>
  </div>;
}

export const expiryCoupon: WidgetModule = { id: ID, Panel: ExpiryCouponPanel, Detail: ExpiryCouponDetail, useSummary: useExpiryCouponSummary };
