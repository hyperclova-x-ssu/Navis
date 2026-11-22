/**
 * 당일 소진 쿠폰 (expiry-coupon, F-49, SCR-37/38): panel (item count + PanelAction) and the make flow
 * (item -> one ordinary benefit: 정률 할인 % / 금액 할인 원 / 세트 가격 원, a segmented choice and one value field -> where to send -> confirm).
 * Text coupons are queued; Place News codes activate after the owner's publication attestation.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { validateAgentPrefill } from '../../../../shared/navis-agent-schema.mjs';
import type { WidgetDetailProps, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { createCommandAttemptKeys } from '../../../data/commands/attempt-keys';
import { useWidgetView } from '../../../data/react';
import { expirySmsCopy, smsSenderConfigured } from '../../../data/reality/14/sms';
import { benefitMax, benefitName, benefitPrice, benefitProblem, expiryDiscount, expirySmsBody } from '../../../data/widget-data';
import type { CouponBenefit, CouponBenefitKind, ExpiryCouponModel, ExpiryItem } from '../../../data/widget-data';
import { ActionButton, ChipChoice, ConfirmStep, CopyThenPosted, DetailFooterContent, DiscountSummary, FormulaRow, Icon, NumberField, Spinner, useKitT } from '../../../ui';
import { isLargeCard, koreanLang } from '../mkt-local/fit';
import { CouponSourceNote, MktPanel } from './panel';
import { useCouponAction } from './panel.actions';
import { DetailNotReady, FixedSmsPreview, NoteLine, PanelNotReady, useActionFocus, useMkt, useSendPhase, SentStatus, SmsSetupHelp } from './shared';

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
  const { t, f, dt, money, locale } = useMkt();
  const kit = useKitT();
  const view = useWidgetView(ID);
  const name = t('widget.expiry-coupon.title');
  if (view.status !== 'ready') return <PanelNotReady view={view} widgetName={name} host={host} shape={shape} width={width} />;
  const m = view.model;
  const item = m.target;
  const itemCount = m.items.filter(row => row.qty > 0).length;
  const itemKpi = { value: f.number(itemCount), unit: t('widget.expiry-coupon.unitName', { n: itemCount }) };
  const itemLabel = t('widget.expiry-coupon.sellTodayCount');
  if (!item) return <MktPanel id={ID} shape={shape} width={width} height={height} editing={editing}
    label={m.pendingPosts.length ? t('widget.expiry-coupon.postTitle') : itemLabel} labelFirst={m.pendingPosts.length === 0}
    kpi={m.pendingPosts.length ? { value: f.number(m.pendingPosts.length), unit: t('widget.coupon-status.unitName') } : itemKpi}
    action={m.pendingPosts.length ? { label: t('widget.expiry-coupon.postTitle'), widgetName: name, onPress: () => host.openDetail({ featureId: ID }) } : null} />;
  const note = view.notes?.[0];
  const canMake = m.canCreate && !item.handled;
  const short = t('widget.expiry-coupon.sellToday');
  const descs = item.handled ? [t('widget.expiry-coupon.alreadyMade')]
    : shape === 'Q' ? [note ? t(note.messageKey) : short]
      : [short];
  const itemQuantity = (it: ExpiryItem) => ({ item: it.name ? dt(it.name) : t(it.nameKey), qty: f.count(it.qty, 'pcs') });
  const itemLine = (it: ExpiryItem) => t('widget.expiry-coupon.itemLine', { ...itemQuantity(it), until: t('widget.coupon-status.untilToday') });
  // D-333: the 4-high card adds what the suggested discount means in money (the same numbers the make window shows) and the other items still to sell today.
  // Nothing is written when the cost is unknown (no suggested discount) or the coupon for this item was already made.
  const large = isLargeCard(shape, height) || width === 1 && height === 4;
  const calc = large && !item.handled ? item.atRecommended : null;
  const otherItems = large ? m.items.filter((it) => it.itemId !== item.itemId) : [];
  const rows = [
    <li key={item.itemId} lang={koreanLang(t(item.nameKey))}>{t('widget.expiry-coupon.itemQuantity', itemQuantity(item))}</li>,
    ...(item.maxSliderRate !== null ? [<li key="limit">{t('widget.expiry-coupon.limit', { p: item.maxSliderRate })}</li>] : []),
    ...(calc ? [
      <li key="money" data-mkt-extra="">{locale === 'ko'
        ? t(item.qty === 1 ? 'widget.expiry-coupon.moneySummary.single' : 'widget.expiry-coupon.moneySummary', { price: money(calc.discountedPrice), profit: money(calc.marginEach), total: money(calc.ifAllSold) })
        : kit.t('ui.discount.summary', { price: money(calc.discountedPrice), profit: money(calc.marginEach), total: money(calc.ifAllSold) })}</li>,
      <li key="loss" data-mkt-extra="">{kit.t('ui.discount.loss', { amount: money(calc.lossIfDiscarded) })}</li>,
    ] : []),
    ...otherItems.map((it) => <li key={it.itemId} lang={koreanLang(t(it.nameKey))} data-row-id={it.itemId} data-mkt-extra="">{itemLine(it)}</li>),
  ];
  return <MktPanel id={ID} shape={shape} width={width} height={height} editing={editing}
    label={itemLabel} labelFirst kpi={itemKpi}
    descs={descs} aside={view.notes?.length ? <NoteLine notes={view.notes} compact={editing} /> : undefined} rows={rows}
    action={canMake ? { label: t('marketing.createCoupon'), widgetName: name, onPress: () => host.openDetail({ featureId: ID, focus: 'action' }) } : null} />;
}

export function useExpiryCouponSummary(): string {
  const { t, f } = useMkt();
  const view = useWidgetView(ID);
  if (view.status !== 'ready' || !view.model.target) return view.status === 'ready' ? t('widget.expiry-coupon.title') : t(view.messageKey);
  const count = view.model.items.filter(item => item.qty > 0).length;
  return t('widget.expiry-coupon.summary', { qty: f.number(count), unit: t('widget.expiry-coupon.unitName', { n: count }) });
}

export function ExpiryCouponDetail({ detailRef, host }: WidgetDetailProps) {
  const view = useWidgetView(ID);
  const [picked, setPicked] = useState<string>();
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (picked) root.current?.querySelector<HTMLElement>('[data-slot="expiry-coupon.items"] [aria-checked="true"]')?.focus({ preventScroll: true });
  }, [picked]);
  useActionFocus(root, detailRef);
  const draft = detailRef.prefill?.kind === 'widget-draft' ? detailRef.prefill : undefined;
  const { route: requestedRoute, ...prefill } = draft?.fields ?? {};
  const fields = validateAgentPrefill(ID, prefill) ? prefill : undefined;
  const route = draft?.command === 'coupon.createExpiry' && requestedRoute === 'place_news' ? 'place_news' : undefined;
  const requested = detailRef.itemId ?? fields?.itemId;
  const item = view.status === 'ready'
    ? view.model.items.find(row => picked ? (row.lotId ?? row.itemId) === picked : !!requested && (row.itemId === requested || row.lotId === requested)) ?? view.model.target : null;
  const rate = item && typeof fields?.rate === 'number' && item.maxSliderRate !== null && fields.rate <= item.maxSliderRate
    ? fields.rate : undefined;
  return <div ref={root} className="mkt-detail" data-widget={ID}>
    <CouponSourceNote id={ID} />
    {view.status !== 'ready' ? <DetailNotReady view={view} host={host} /> : item ? <ExpiryFlow key={item.lotId ?? item.itemId}
      model={view.model} item={item} onPick={setPicked} notes={view.notes} host={host} rate={picked ? undefined : rate} initialRoute={route} /> : null}
    {!item && view.status === 'ready' && view.model.pendingPosts.length > 0 ? (
      <div className="mkt-columns"><div className="mkt-col-side"><PendingExpiryPosts posts={view.model.pendingPosts} host={host} /></div></div>
    ) : null}
  </div>;
}

function PendingExpiryPosts({ posts, host }: { readonly posts: ExpiryCouponModel['pendingPosts']; readonly host: WidgetDetailProps['host'] }) {
  const { t, dt } = useMkt();
  const { http, pending, run } = useCouponAction(host);
  const [confirming, setConfirming] = useState<string>();
  const [reset, setReset] = useState(0);
  const [status, setStatus] = useState<{ readonly text: string; readonly error: boolean }>();
  const cancel = () => { setConfirming(undefined); setReset(value => value + 1); };
  const markPosted = (codeId: string) => run({ type: 'coupon.markPosted', codeId, idempotencyKey: `post-${codeId}` },
    'data.marketing.notice.counting', failure => {
      setStatus({ error: !!failure, text: failure ?? t('widget.expiry-coupon.postedDone') });
      cancel();
    });
  return <>
    {posts.filter(post => !confirming || confirming === post.codeId).map(post => <section key={post.codeId} className="mkt-post" aria-labelledby={`post-${post.codeId}`}>
      <h3 id={`post-${post.codeId}`}>{t('widget.expiry-coupon.postTitle')}</h3>
      {confirming === post.codeId ? <div className="mkt-confirm" aria-busy={pending}>
        <p>{t('common.navis.agent.extraConfirm')}</p>
        <p>{dt(post.post)}</p>
        <div className="mkt-actions">
          <ActionButton disabled={pending} onClick={() => markPosted(post.codeId)}>
            {pending ? <Spinner /> : null}{t('common.navis.agent.confirmAgain')}
          </ActionButton>
          <ActionButton disabled={pending} variant="secondary" onClick={cancel}>{t('widget.expiry-coupon.notNow')}</ActionButton>
        </div>
      </div> : <CopyThenPosted key={reset} text={dt(post.post)} onPosted={() => {
        if (http) { setStatus(undefined); setConfirming(post.codeId); }
        else markPosted(post.codeId);
      }} />}
    </section>)}
    {status ? <DetailFooterContent><p className="mkt-reason" role={status.error ? 'alert' : 'status'}><Icon name={status.error ? 'error' : 'check'} aria-hidden />{status.text}</p></DetailFooterContent> : null}
  </>;
}

function ExpiryFlow({ model, item, onPick, notes, host, rate, initialRoute }: { readonly rate?: number; readonly initialRoute?: Route; readonly model: ExpiryCouponModel; readonly item: ExpiryItem; readonly onPick: (id: string) => void; readonly notes: Parameters<typeof NoteLine>[0]['notes']; readonly host: WidgetDetailProps['host'] }) {
  const { t, f, dt, money, locale } = useMkt();
  const kit = useKitT();
  const { http, pending, run } = useCouponAction(host);
  const smsConfigured = smsSenderConfigured || (http && host.hasSmsSettings?.());
  const { phase, setPhase, startSending } = useSendPhase();
  // T-07: one key per submitted values (PKG-F helper): equal submits keep it, changed values or a reopened form get their own.
  const [keyFor] = useState(() => createCommandAttemptKeys('expiry'));
  const [kind, setKind] = useState<CouponBenefitKind>('percent');
  const [value, setValue] = useState<number | null>(rate ?? item.recommendedRate ?? 0);
  const [route, setRoute] = useState<Route>(initialRoute ?? 'sms');
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ readonly route: Route; readonly count: number; readonly benefit: string } | null>(null);

  const itemName = item.menuName ?? (item.name ? dt(item.name) : t(item.nameKey));
  const known = item.unitCost !== null && item.maxSliderRate !== null;
  const cost = item.unitCost ?? 0;
  const benefit: CouponBenefit | null = value === null ? null : { kind, value };
  const problem = benefit ? benefitProblem(benefit, item.price, item.unitCost) : kind === 'percent' ? 'percentRange' : kind === 'amount' ? 'amountRange' : 'setPriceRange';
  const shown = problem ? null : benefit;
  const calc = known ? expiryDiscount(item.price, cost, 0, item.qty) : null;
  const paid = shown ? benefitPrice(item.price, shown) : 0;
  const profit = paid - cost;
  const recipients = model.routes.sms.recipients;
  const made = item.handled;
  const disabled = pending || !model.canCreate || made;
  const routeBlocked = route === 'sms' && (!smsConfigured || recipients === 0);
  const smsBody = !shown ? null : locale === 'ko' ? expirySmsCopy(itemName, shown) : dt(expirySmsBody(item.nameKey, shown));
  const routeName = route === 'sms' ? t('data.marketing.route.sms') : t('data.marketing.route.placeNews');
  const benefitText = shown ? dt(benefitName(shown)) : '';
  const unit = kind === 'percent' ? '%' : t('widget.expiry-coupon.unitWon');
  const pickKind = (next: string) => { const k = next as CouponBenefitKind; setKind(k); setValue(startValue(k, item)); setError(null); };
  const itemLine = (row: ExpiryItem) => t('widget.expiry-coupon.itemLine', { item: row.menuName ?? (row.name ? dt(row.name) : t(row.nameKey)), qty: f.count(row.qty, 'pcs'), until: t('widget.coupon-status.untilToday') });
  const limitText = !known ? '' : kind === 'percent' ? t('widget.expiry-coupon.limit', { p: item.maxSliderRate ?? 0 })
    : kind === 'amount' ? t('widget.expiry-coupon.limitAmount', { amount: money(benefitMax('amount', item.price, cost)) }) : t('widget.expiry-coupon.limitSetPrice', { price: money(cost) });
  const problemText = problem === 'overLimit' && kind === 'percent' && known
    ? t('widget.expiry-coupon.overLimit', { p: item.maxSliderRate ?? 0 })
    : problem ? t(problem === 'kind' ? 'data.marketing.error.benefitInvalid' : `data.marketing.error.${problem}`) : undefined;

  const create = () => {
    if (disabled || routeBlocked) return;
    if (!shown) { setError(problemText ?? null); setPhase('form'); return; }
    setSubmitted({ route, count: recipients, benefit: benefitText });
    if (http) setPhase('sending');
    run({ type: 'coupon.createExpiry', itemId: item.lotId ?? item.itemId, benefit: shown, route, idempotencyKey: keyFor(JSON.stringify([item.lotId ?? item.itemId, shown.kind, shown.value, route])) }, 'data.marketing.notice.couponCreated',
      (failure, receipt) => {
        if (failure) { setError(failure); setSubmitted(null); setPhase('form'); return; }
        setError(null);
        if (receipt || route === 'place_news') setPhase('sent'); else startSending();
      });
  };

  return <div className="mkt-columns" data-slot="expiry-coupon.detail">
    <div className="mkt-col-main">
      <NoteLine notes={notes} />
      <section aria-labelledby="exp-step1" data-slot="expiry-coupon.items">
        <h2 id="exp-step1">{t('widget.expiry-coupon.step1')}</h2>
        {model.items.length > 1 ? <ChipChoice label={t('widget.expiry-coupon.summaryItem')} value={item.lotId ?? item.itemId}
          onChange={onPick}
          options={model.items.map(row => ({ value: row.lotId ?? row.itemId, label: itemLine(row), disabled: pending || phase === 'confirm' || phase === 'sending' }))} />
          : <p>{itemLine(item)}</p>}
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
            error={problemText} />
          {shown && (locale === 'ko' || item.qty === 1 ? <div className="ui-discount-summary"><p>{t(item.qty === 1 ? 'widget.expiry-coupon.moneySummary.single' : 'widget.expiry-coupon.moneySummary', { price: money(paid), profit: money(profit), total: money(profit * item.qty) })}</p><p className="ui-discount-summary__loss">{kit.t('ui.discount.loss', { amount: money(calc.lossIfDiscarded) })}</p></div> : <DiscountSummary price={money(paid)} profit={money(profit)} total={money(profit * item.qty)} lossCost={money(calc.lossIfDiscarded)} />)}
          <p className="mkt-limit">{limitText}</p>
          {kind === 'percent' ? <FormulaRow><p className="mkt-formula">{t('widget.expiry-coupon.formula', { max: item.maxRatePercent ?? 0, cost: money(cost), price: money(item.price) })}</p></FormulaRow> : null}
        </div> : <p role="status">{t('data.state.expiry-coupon.partial')}</p>}
      </section>
      <section aria-labelledby="exp-step3">
        <h2 id="exp-step3">{t('widget.expiry-coupon.step3')}</h2>
        <ChipChoice label={t('marketing.sendTo')} value={route} onChange={(v) => setRoute(v as Route)}
          options={[{ value: 'sms', label: t('widget.expiry-coupon.routeSms', { n: recipients }) }, { value: 'place_news', label: t('widget.expiry-coupon.routePlace') }]} />
        {phase === 'form' ? <DetailFooterContent><div className="mkt-expiry-action">
          <ActionButton disabled={disabled || !known || routeBlocked || problem !== null} onClick={() => { setError(null); setPhase('confirm'); }} data-slot="expiry-coupon.create">{t('marketing.createCoupon')}</ActionButton>
          {route === 'sms' && recipients === 0 ? <p className="mkt-reason" role="status">{t('marketing.noRecipients')}</p> : null}
          {route === 'sms' && !smsConfigured && <SmsSetupHelp openSettings={host.openSettings} />}
          {error ? <p className="mkt-reason" role="alert"><Icon name="error" aria-hidden />{error}</p> : null}
        </div></DetailFooterContent> : null}
      </section>
    </div>
    <div className="mkt-col-side">
      {phase === 'form' ? (route === 'place_news' ? !made : smsBody !== null) && <>
        {/* T-29: once this lot's coupon exists its generated post (below) is the 게시 문구; the generic hint would repeat the title. */}
        <section aria-labelledby="exp-preview">
          <h2 id="exp-preview">{route === 'sms' ? t('marketing.messagePreview') : t('widget.expiry-coupon.postTitle')}</h2>
          {route === 'sms' ? smsBody && <FixedSmsPreview body={smsBody} recipientCount={recipients} customerOnly /> : <p className="mkt-hint">{t('widget.expiry-coupon.placeHint')}</p>}
        </section>
      </> : (submitted?.route ?? route) === 'sms' ? (
        phase === 'sent' ? <DetailFooterContent><SentStatus /></DetailFooterContent> : <ConfirmStep footerActions count={submitted?.count ?? recipients} phase={phase === 'confirm' ? 'ask' : phase} onCancel={() => { setSubmitted(null); setPhase('form'); }} onSend={create}
          summary={[
            { label: t('widget.expiry-coupon.summaryItem'), value: itemName },
            { label: t('widget.expiry-coupon.summaryRoute'), value: routeName },
            { label: t('widget.expiry-coupon.summaryPrice'), value: submitted?.benefit ?? benefitText },
          ]} />
      ) : (
        <section className="mkt-confirm" aria-labelledby={phase === 'sent' ? undefined : 'exp-confirm'}>
          {phase !== 'sent' ? <h3 id="exp-confirm" tabIndex={-1} ref={(node) => node?.focus()}>{t('widget.expiry-coupon.confirmCreate')}</h3> : null}
          <dl><div><dt>{t('widget.expiry-coupon.summaryItem')}</dt><dd>{itemName}</dd></div><div><dt>{t('widget.expiry-coupon.summaryRoute')}</dt><dd>{routeName}</dd></div><div><dt>{t('widget.expiry-coupon.summaryPrice')}</dt><dd>{submitted?.benefit ?? benefitText}</dd></div></dl>
          <DetailFooterContent>{phase === 'sent' ? <p role="status"><Icon name="check" aria-hidden />{t('marketing.couponCreated')}</p> : <div className="detail-footer-actions mkt-actions">
            <ActionButton disabled={pending} onClick={create}>{pending ? <Spinner /> : null}{t('widget.expiry-coupon.create')}</ActionButton>
            <ActionButton disabled={pending} variant="secondary" onClick={() => { setSubmitted(null); setPhase('form'); }}>{t('widget.expiry-coupon.notNow')}</ActionButton>
          </div>}</DetailFooterContent>
        </section>
      )}
      <PendingExpiryPosts posts={model.pendingPosts} host={host} />
      {model.created.length > 0 ? <section className="mkt-sent" aria-labelledby="exp-created">
        <h3 id="exp-created">{t('widget.expiry-coupon.createdTitle')}</h3>
        <ul>{model.created.map((row) => <li key={row.couponId}>{t('widget.slot-coupon.sentLine', { name: dt(row.name), used: row.used ?? 0, issued: row.issued, left: t('widget.coupon-status.untilToday') })}</li>)}</ul>
      </section> : null}
    </div>
  </div>;
}

export const expiryCoupon: WidgetModule = { id: ID, Panel: ExpiryCouponPanel, Detail: ExpiryCouponDetail, useSummary: useExpiryCouponSummary };
