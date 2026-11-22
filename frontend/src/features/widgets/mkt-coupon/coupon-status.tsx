/**
 * 진행 중인 쿠폰 (coupon-status, F-51, SCR-37/39): panel (3장 + PanelAction) and the coupon table with usage bars,
 * ending-soon reminder (sending has no undo), pause / resume / extend (with undo through the notice), ended coupons and
 * the 13 + 15 = 28 identity. Coupons come from the one store, so a coupon sent elsewhere shows up here in the same frame.
 */
import { Fragment, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type { DetailRef, WidgetDetailProps, WidgetHost, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useWidgetDataStore, useWidgetView } from '../../../data/react';
import { TODAY } from '../../../data/db/time';
import type { MarketingTables } from '../../../data/marketing/types';
import { codeUsed } from '../../../data/marketing/derive';
import type { CouponDto, CouponTermsDto } from '../../../data/reality/14/dto';
import { couponReminderSms, queuedCouponSmsTime, smsSenderConfigured } from '../../../data/reality/14/sms';
import type { CouponRow, CouponStatusModel } from '../../../data/widget-data';
import { ActionButton, ConfirmStep, Icon, NumberField, Spinner, StatusBadge, Table, UsageBar, useKitT } from '../../../ui';
import { isLargeCard, koreanLang } from '../mkt-local/fit';
import { CouponSourceNote, MktPanel } from './panel';
import { useCouponAction, useRealCoupons } from './panel.actions';
import { NaverLedger } from './coupon-status.naver';
import {
  DetailNotReady, extraRow, FixedSmsPreview, Live, LiveText, NoteLine, PanelNotReady, SentStatus, SmsSetupHelp, useActionFocus, useFormKey, useMkt, useSendPhase,
} from './shared';

const ID = 'coupon-status' as const;

const EMPTY_TARGET: DetailRef = { featureId: 'slot-coupon', view: 'send' };

function left(t: ReturnType<typeof useMkt>['t'], row: CouponRow): string {
  return row.daysLeft <= 0 ? t('widget.coupon-status.untilToday') : t('widget.coupon-status.daysLeft', { n: row.daysLeft });
}

export function CouponStatusPanel({ width, height, shape, editing, host }: WidgetPanelProps) {
  const { t, f, dt } = useMkt();
  const view = useWidgetView(ID);
  const name = t('widget.coupon-status.title');
  if (view.status !== 'ready') return <PanelNotReady view={view} widgetName={name} host={host} shape={shape} width={width} shortMessage={view.status === 'empty' && view.messageKey === 'data.state.coupon-status.none' ? t('widget.coupon-status.state.none.short') : undefined} onEmptyAction={() => host.openDetail(EMPTY_TARGET)} emptyActionLabel={view.status === 'empty' && view.actionKey === 'data.marketing.action.viewTodayPromotions' ? t('widget.coupon-status.emptyAction') : undefined} />;
  const m = view.model;
  const note = view.notes?.[0];
  const ending = m.rows.find((r) => r.endingSoon && r.canNotify);
  const endingLine = m.endingSoonCount > 0 ? t('widget.coupon-status.endingLine', { m: m.endingSoonCount }) : '';
  const monthLine = m.monthUsed !== null ? t('widget.coupon-status.monthLine', { n: m.monthUsed }) : '';
  // The big number is the running count; paused coupons are named on their own line (GD-3, U-03) instead of hiding inside it.
  const pausedLine = m.pausedCount > 0 ? t('widget.coupon-status.pausedLine', { p: m.pausedCount }) : '';
  const descs = [shape === 'Q' && note ? t(note.messageKey) : endingLine || pausedLine || (shape === 'W' ? monthLine : '')];
  // D-333: the 4-high card lists every running coupon the data has (up to 6), the coupons that ended this month, and how the month total adds up
  // (the same identity the window writes). The month line stays as it is when nothing ended or the parts do not add up.
  const large = isLargeCard(shape, height);
  const ended = large ? m.ended : [];
  const adds = large && m.monthUsed !== null && m.endedUsed !== null && m.monthUsed === m.runningUsed + m.endedUsed && m.ended.length > 0;
  const rows = [
    ...m.rows.slice(0, large ? 6 : 3).map((row, index) => <li key={row.couponId} lang={koreanLang(dt(row.name))} data-row-id={row.couponId} data-paused={row.status === 'paused' ? 'true' : undefined} {...extraRow(index)}>
      {dt(row.name)}{'\u00A0·\u00A0'}{row.used === null ? t('widget.coupon-status.noUsage') : t('widget.coupon-status.used', { used: row.used, issued: row.issued })}{'\u00A0·\u00A0'}{row.status === 'paused' ? t('widget.coupon-status.paused') : left(t, row)}
    </li>),
    ...((shape === 'S' || shape === 'L') && pausedLine && m.endingSoonCount > 0 ? [<li key="paused" data-slot="coupon-status.paused-line">{pausedLine}</li>] : []),
    ...ended.map((row) => <li key={`ended-${row.couponId}`} lang={koreanLang(dt(row.name))} data-row-id={row.couponId} data-ended="true" data-mkt-extra="">
      {dt(row.name)} · {row.used === null ? t('widget.coupon-status.noUsage') : t('widget.coupon-status.used', { used: row.used, issued: row.issued })} · {f.date(row.endsOn, 'short')} · {t('widget.coupon-status.endedBadge')}
    </li>),
    ...((shape === 'T' || shape === 'S' || shape === 'L') && monthLine ? [<li key="month" data-slot="coupon-status.month">{adds
      ? t(m.pausedCount > 0 ? 'widget.coupon-status.totalPaused' : 'widget.coupon-status.total', { n: m.monthUsed!, a: m.runningUsed, b: m.endedUsed! })
      : monthLine}</li>] : []),
  ];
  return <MktPanel id={ID} shape={shape} width={width} height={height} editing={editing}
    label={t('widget.coupon-status.codeTitle')} kpi={{ value: String(m.activeCount), unit: t('widget.coupon-status.unitName') }}
    descs={descs} aside={view.notes?.length ? <NoteLine notes={view.notes} compact={editing} /> : undefined} rows={rows}
    action={ending ? { label: shape === 'Q' || shape === 'T' ? t('marketing.sendReminder') : t('marketing.sendEndingReminder'), widgetName: name, onPress: () => host.openDetail({ featureId: ID, focus: 'action' }) } : null} />;
}

export function useCouponStatusSummary(): string {
  const { t } = useMkt();
  const view = useWidgetView(ID);
  if (view.status !== 'ready') return t(view.messageKey);
  return t('widget.coupon-status.summary', { n: view.model.activeCount, m: view.model.endingSoonCount });
}

export function CouponStatusDetail({ detailRef, host }: WidgetDetailProps) {
  const view = useWidgetView(ID);
  const real = useRealCoupons();
  const root = useRef<HTMLDivElement>(null);
  const isTargeted = detailRef.view === 'reminder' || detailRef.view === 'ended' || Boolean(detailRef.itemId);
  useActionFocus(root, isTargeted ? { ...detailRef, focus: undefined } : detailRef);
  useEffect(() => {
    if (!isTargeted) return;
    const target = root.current?.querySelector<HTMLElement>('[data-navis-coupon-target]');
    target?.focus();
  }, [isTargeted, detailRef.itemId, detailRef.view]);
  return <div ref={root} className="mkt-detail mkt-detail--single" data-widget={ID}>
    <CouponSourceNote id={ID} />
    {view.status !== 'ready' ? <DetailNotReady view={view} host={host} onEmptyAction={() => host.openLinked(EMPTY_TARGET)} />
      : <StatusBody model={view.model} notes={view.notes} host={host} detailRef={detailRef} />}
    {view.status === 'ready' || (view.status === 'empty' && view.messageKey === 'data.state.coupon-status.none')
      ? <NaverLedger ledger={real?.naver ?? null} today={real?.businessDate ?? TODAY} /> : null}
  </div>;
}

type CouponEdit = { readonly action: 'update' | 'end' } | { readonly action: 'unpublish'; readonly codeId: string };

type CouponDetails = Pick<CouponDto, 'couponId' | 'benefitType' | 'benefitValue' | 'targetRef' | 'startsOn' | 'endsOn' | 'validHours' | 'canEnd'> & {
  readonly codes: readonly Pick<CouponDto['codes'][number], 'codeId' | 'code' | 'route' | 'activated' | 'unpublishedAt' | 'issuedTerms' | 'used' | 'issueCount'>[];
};

function exampleTerms(marketing: MarketingTables, row: CouponRow, canEnd: boolean): CouponDetails | undefined {
  const coupon = marketing.coupon.find(item => item.couponId === row.couponId);
  if (!coupon) return undefined;
  return { ...coupon, targetRef: coupon.targetMenuId, canEnd,
    codes: marketing.couponCode.filter(code => code.couponId === row.couponId).map(code => ({
      ...code, activated: code.activatedAt !== null, unpublishedAt: code.unpublishedAt ?? null,
      issuedTerms: code.issuedTerms ? { ...code.issuedTerms, targetRef: code.issuedTerms.targetMenuId } : null,
      used: codeUsed(marketing, code.codeId),
    })) };
}

function CouponTerms({ coupon, host, expanded = false }: { readonly coupon: CouponDetails; readonly host: WidgetHost; readonly expanded?: boolean }) {
  const { t, f, money } = useMkt(), { pending, run } = useCouponAction(host);
  const [confirm, setConfirm] = useState<CouponEdit & { readonly idempotencyKey: string }>();
  const [benefit, setBenefit] = useState<number | null>(null);
  const [quantity, setQuantity] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const publicCode = coupon.codes.some(code => code.route !== 'sms');
  const benefitLabel = (terms: CouponTermsDto) => {
    const value = terms.benefitValue;
    if (terms.benefitType === 'free_item') return '품목 무료';
    if (terms.benefitType === 'percent') return `${f.percent(value)} 할인`;
    return terms.benefitType === 'amount' ? `${money(value)} 할인` : `세트 가격 ${money(value)}`;
  };
  const choose = (edit: CouponEdit) => {
    setError(null);
    setConfirm({ ...edit, idempotencyKey: globalThis.crypto.randomUUID() });
  };
  const finish = (failure: string | null) => {
    setError(failure);
    if (!failure) { setConfirm(undefined); setBenefit(null); setQuantity(null); }
  };
  const confirmChange = () => {
    if (!confirm) return;
    const { idempotencyKey } = confirm;
    if (confirm.action === 'unpublish') run({ type: 'coupon.unpublish', codeId: confirm.codeId, idempotencyKey }, 'data.marketing.notice.couponUnpublished', finish);
    else if (confirm.action === 'end') run({ type: 'coupon.endEarly', couponId: coupon.couponId, idempotencyKey }, 'data.marketing.notice.couponEnded', finish);
    else if (benefit !== null || quantity !== null) run({ type: 'coupon.update', couponId: coupon.couponId, idempotencyKey,
      ...(benefit === null ? {} : { benefitValue: benefit }), ...(quantity === null ? {} : { quantity }) }, 'data.management.notice.saved', finish);
  };
  const issuedEnds = [...new Set(coupon.codes.flatMap(code => code.issuedTerms ? [code.issuedTerms.endsOn] : []))];
  const contents = <>
    <p>{benefitLabel(coupon)} · {f.date(coupon.startsOn, 'short')} ~ {f.date(coupon.endsOn, 'short')}</p>
    {coupon.validHours?.length ? <ul>{coupon.validHours.map((range, index) => <li key={index}>
      {['월', '화', '수', '목', '금', '토', '일'][range.weekday - 1]} {range.startHour}시~{range.endHour}시
    </li>)}</ul> : null}
    <ul>{coupon.codes.map(code => <li key={code.codeId}>
      <code>{code.code}</code> · {code.used}/{code.activated ? code.issueCount : 0}
      {code.issuedTerms && (code.issuedTerms.benefitType !== coupon.benefitType || code.issuedTerms.benefitValue !== coupon.benefitValue)
        ? <span> · 발급 혜택 {benefitLabel(code.issuedTerms)}</span> : null}
      {code.issuedTerms && code.issuedTerms.endsOn !== coupon.endsOn ? <span> · 원래 종료일 {f.date(code.issuedTerms.endsOn, 'short')}</span> : null}
      {code.unpublishedAt ? <span> · 게시 취소</span> : null}
      {!confirm && code.route === 'place_news' && code.activated && !code.unpublishedAt ? <ActionButton variant="secondary"
        onClick={() => choose({ action: 'unpublish', codeId: code.codeId })}>게시 취소하기</ActionButton> : null}
    </li>)}</ul>
    {!confirm && coupon.canEnd ? <div className="mkt-actions">
      {publicCode || coupon.benefitType !== 'free_item' ? <ActionButton variant="secondary" onClick={() => choose({ action: 'update' })}>
        {publicCode ? '혜택·수량 바꾸기' : '혜택 바꾸기'}
      </ActionButton> : null}
      <ActionButton variant="secondary" onClick={() => choose({ action: 'end' })}>일찍 끝내기</ActionButton>
    </div> : null}
    {confirm ? <div className="mkt-confirm" aria-busy={pending}>
      {confirm.action === 'update' ? <>
        {coupon.benefitType !== 'free_item' ? <NumberField label={coupon.benefitType === 'percent' ? '새 할인율' : coupon.benefitType === 'set_price' ? '새 세트 가격' : '새 할인 금액'}
          name={`coupon-benefit-${coupon.couponId}`} value={benefit} min={1} step={1} disabled={pending} onValueChange={setBenefit} /> : null}
        {publicCode ? <NumberField label="새 발급 수량" name={`coupon-quantity-${coupon.couponId}`} value={quantity} min={1} max={100_000} step={1} disabled={pending} onValueChange={setQuantity} /> : null}
      </> : <p>{confirm.action === 'end' ? '오늘로 쿠폰을 끝낼까요?' : '쿠폰 게시를 취소할까요?'}</p>}
      {issuedEnds.length > 0 && <p>{issuedEnds.length === 1
        ? `이미 받은 쿠폰은 ${f.date(issuedEnds[0]!, 'short')}까지 주문/결제에서 쓸 수 있어요.`
        : '이미 받은 쿠폰은 각 발급 당시 종료일까지 주문/결제에서 쓸 수 있어요.'}</p>}
      <div className="mkt-actions">
        <ActionButton variant={confirm.action === 'update' ? 'default' : 'destructive'} disabled={pending || (confirm.action === 'update' && benefit === null && quantity === null)} onClick={confirmChange}>
          {pending ? <Spinner /> : null}{confirm.action === 'update' ? '바꾸기' : confirm.action === 'end' ? '오늘 끝내기' : '게시 취소하기'}
        </ActionButton>
        <ActionButton variant="secondary" disabled={pending} onClick={() => { setConfirm(undefined); setError(null); setBenefit(null); setQuantity(null); }}>{confirm.action === 'update' ? '취소' : '그대로 두기'}</ActionButton>
      </div>
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
  </>;
  return expanded ? <div className="mkt-coupon-terms" lang="ko">{contents}</div>
    : <details className="mkt-coupon-terms mkt-ended" lang="ko"><summary>{t('widget.coupon-status.codeTerms')}</summary>{contents}</details>;
}

function StatusBody({ model, notes, host, detailRef }: { readonly model: CouponStatusModel; readonly notes: Parameters<typeof NoteLine>[0]['notes']; readonly host: WidgetHost; readonly detailRef: DetailRef }) {
  const { t, f, dt } = useMkt();
  const kit = useKitT();
  const { http, pending, run } = useCouponAction(host);
  const real = useRealCoupons();
  const store = useWidgetDataStore();
  const marketing = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).tables.marketing;
  const termsFor = (row: CouponRow, canEnd: boolean) => http
    ? real?.coupons.find(coupon => coupon.couponId === row.couponId)
    : exampleTerms(marketing, row, canEnd);
  const reminderTarget = detailRef.view === 'reminder' ? detailRef.itemId : undefined;
  const ending = model.rows.find(r => r.endingSoon && r.canNotify && (!reminderTarget || reminderTarget === r.couponId));
  const [open, setOpen] = useState((detailRef.view === 'reminder' || detailRef.view === undefined && detailRef.focus === 'action') && ending !== undefined);
  const [shownTerms, setShownTerms] = useState<string>();
  const termsId = useId();
  const { phase, setPhase, startSending } = useSendPhase();
  const [key, renewKey] = useFormKey('remind');
  const [error, setError] = useState<string | null>(null);
  const [sentCount, setSentCount] = useState(0);
  // The count comes from the same selector the command uses (consenting text targets), never from the issued count of a public post.
  const recipients = ending ? ending.reminderRecipients : 0;
  const sendTime = (http && real ? queuedCouponSmsTime(real.localAt) : null) ?? kit.t('ui.send.now');

  const act = (type: 'coupon.pause' | 'coupon.resume' | 'coupon.extend', couponId: string) => {
    run({ type, couponId }, 'data.notice.sent', setError);
  };
  const sendReminder = () => {
    if (!smsSenderConfigured || !ending || pending) return;
    setSentCount(recipients);
    if (http) setPhase('sending');
    run({ type: 'coupon.notifyEnding', couponId: ending.couponId, idempotencyKey: key }, 'data.notice.sent', (failure, receipt) => {
      if (failure) { setError(failure); setPhase('form'); return; }
      setError(null);
      if (receipt) setPhase('sent'); else startSending();
    });
  };
  const close = () => { setOpen(false); setPhase('form'); renewKey(); };

  return <div data-slot="coupon-status.detail">
    <NoteLine notes={notes} />
    <h2>{t('widget.coupon-status.codeTitle')}</h2>
    <div className="mkt-status-head">
      <Live value={`${model.activeCount}|${model.pausedCount}`}><strong className="mkt-status-count" data-slot="coupon-status.active">{model.pausedCount > 0 ? t('widget.coupon-status.activeHeaderPaused', { n: model.activeCount, p: model.pausedCount }) : t('widget.coupon-status.activeHeader', { n: model.activeCount })}</strong></Live>
      {model.endingSoonCount > 0 ? <span className="mkt-status-ending"><StatusBadge kind="endingSoon" /> {t('widget.coupon-status.endingLine', { m: model.endingSoonCount })}</span> : null}
      <span className="mkt-status-spacer" />
      {ending ? <div data-first-control>
        <ActionButton disabled={open} onClick={() => setOpen(true)} data-slot="coupon-status.notify">{t('marketing.sendEndingReminder')}</ActionButton>
      </div> : null}
    </div>
    {/* T-15: "no coupon is ending" only when none is; an ending coupon with nobody to remind says that instead (canNotify needs reminder targets). */}
    {!ending ? <p id="cs-no-ending" className="mkt-reason mkt-no-ending">{model.endingSoonCount > 0 ? t('data.marketing.error.noReminderRecipients') : t('widget.coupon-status.noEnding')}</p> : null}
    {error && !open ? <p className="mkt-reason" role="alert"><Icon name="error" aria-hidden />{error}</p> : null}

    {open && ending ? <section className="mkt-notify" aria-labelledby="cs-notify-title">
      <h2 id="cs-notify-title" tabIndex={-1} data-navis-coupon-target={detailRef.view === 'reminder' || undefined}>{t('widget.coupon-status.notifyTitle')}</h2>
      <p className="mkt-notify__target">{t('widget.coupon-status.notifyFor')}: <strong>{dt(ending.name)}</strong>{'\u00A0·\u00A0'}{left(t, ending)}</p>
      {phase === 'form' ? <>
        <FixedSmsPreview body={http ? couponReminderSms : t('data.marketing.sms.reminder')} recipientCount={recipients} customerOnly />
        <div className="mkt-actions">
          <ActionButton disabled={!smsSenderConfigured || recipients === 0} aria-describedby={recipients === 0 ? 'cs-no-recipients' : undefined} onClick={() => setPhase('confirm')} data-slot="coupon-status.notify-send">{t('widget.coupon-status.notifySend', { n: recipients })}</ActionButton>
          <ActionButton variant="secondary" onClick={close}>{t('common.cancel')}</ActionButton>
        </div>
        {!smsSenderConfigured && <SmsSetupHelp openSettings={host.openSettings} settingsPath />}
        {recipients === 0 ? <p id="cs-no-recipients" className="mkt-reason" role="alert" data-slot="coupon-status.no-recipients"><Icon name="error" aria-hidden />{t('data.marketing.error.noReminderRecipients')}</p> : null}
      </> : phase === 'sent' ? <><SentStatus />
        <ActionButton variant="secondary" onClick={close}>{t('common.close')}</ActionButton></>
        : <ConfirmStep count={sentCount || recipients} phase={phase === 'confirm' ? 'ask' : phase} cancelLabel={t('widget.coupon-status.keep')} onCancel={() => setPhase('form')} onSend={sendReminder}
        summary={[
          { label: t('widget.coupon-status.notifyFor'), value: dt(ending.name) },
          { label: t('marketing.recipients'), value: f.count(sentCount || recipients, 'person') },
          { label: kit.t('ui.send.time'), value: sendTime },
        ]} />}
      {error ? <p className="mkt-reason" role="alert"><Icon name="error" aria-hidden />{error}</p> : null}
    </section> : null}

    <Table aria-label={t('widget.coupon-status.tableLabel')} className="mkt-table" aria-busy={pending}>
      <thead><tr>
        <th scope="col">{t('widget.coupon-status.colCoupon')}</th><th scope="col">{t('widget.coupon-status.colUsed')}</th>
        <th scope="col">{t('widget.coupon-status.colLeft')}</th><th scope="col">{t('widget.coupon-status.colActions')}</th>
      </tr></thead>
      <tbody>{model.rows.map((row) => {
        const name = dt(row.name);
        const coupon = termsFor(row, true);
        const expanded = coupon !== undefined && shownTerms === row.couponId;
        return <Fragment key={row.couponId}><tr data-row-id={row.couponId} data-paused={row.status === 'paused' ? 'true' : undefined}>
          <th scope="row" tabIndex={row.couponId === detailRef.itemId && detailRef.view === 'active' ? -1 : undefined}
            data-navis-coupon-target={row.couponId === detailRef.itemId && detailRef.view === 'active' || undefined}><span className="mkt-coupon-name">{name}</span>
            {row.status === 'paused' ? <StatusBadge kind="paused" label={t('widget.coupon-status.pausedBadge')} /> : row.endingSoon ? <StatusBadge kind="endingSoon" /> : null}</th>
          <td><LiveText value={`${row.used}/${row.issued}`}>{row.used === null
            ? <><StatusBadge kind="needsReview" /> <span>{t('widget.coupon-status.noUsage')}</span></>
            : <UsageBar used={row.used} total={row.issued} />}</LiveText></td>
          <td>{left(t, row)}</td>
          <td><div className="mkt-actions">
            {row.status === 'paused'
              ? <ActionButton variant="secondary" disabled={pending || !row.canResume} aria-label={t('widget.coupon-status.resumeName', { name })} onClick={() => act('coupon.resume', row.couponId)}>{t('widget.coupon-status.resume')}</ActionButton>
              : <ActionButton variant="secondary" disabled={pending || !row.canPause} aria-label={t('widget.coupon-status.pauseName', { name })} onClick={() => act('coupon.pause', row.couponId)}>{t('marketing.pause')}</ActionButton>}
            <ActionButton variant="secondary" disabled={pending || !row.canExtend} aria-label={t('widget.coupon-status.extendName', { name })} onClick={() => act('coupon.extend', row.couponId)}>{t('marketing.extend')}</ActionButton>
            {coupon && <ActionButton variant="secondary" className="mkt-terms-toggle" aria-expanded={expanded} aria-controls={expanded ? termsId : undefined}
              onClick={() => setShownTerms(expanded ? undefined : row.couponId)}><span aria-hidden="true">{expanded ? '▾' : '▸'}</span> {t('widget.coupon-status.codeTerms')}</ActionButton>}
          </div></td>
        </tr>{expanded && <tr className="mkt-expanded-row"><td id={termsId} colSpan={4}><CouponTerms coupon={coupon} host={host} expanded /></td></tr>}</Fragment>;
      })}</tbody>
    </Table>

    <details className="mkt-ended" open={detailRef.view === 'ended' || undefined}>
      <summary data-navis-coupon-target={detailRef.view === 'ended' && !detailRef.itemId || undefined}>{t('widget.coupon-status.endedTitle', { n: model.ended.length })}</summary>
      <ul>{model.ended.map((row) => { const coupon = termsFor(row, false); return <li key={row.couponId} tabIndex={row.couponId === detailRef.itemId ? -1 : undefined}
        data-navis-coupon-target={row.couponId === detailRef.itemId && detailRef.view === 'ended' || undefined}>{t('widget.coupon-status.endedLine', {
        name: dt(row.name), used: row.used === null ? '-' : row.used, issued: row.issued, date: f.date(row.endsOn, 'short'),
      })}{coupon ? <CouponTerms coupon={coupon} host={host} /> : null}</li>; })}</ul>
    </details>
    <p className="mkt-identity" data-slot="coupon-status.total">
      {model.monthUsed !== null && model.endedUsed !== null && model.monthUsed === model.runningUsed + model.endedUsed
        ? <LiveText value={`${model.monthUsed}|${model.runningUsed}`}>{t(model.pausedCount > 0 ? 'widget.coupon-status.totalPaused' : 'widget.coupon-status.total', { n: model.monthUsed, a: model.runningUsed, b: model.endedUsed })}</LiveText>
        // the sum is written only while it is true; a total that does not add up is shown as the month's count alone
        : <LiveText value={model.monthUsed ?? model.runningUsed}>{t('widget.coupon-status.monthLine', { n: model.monthUsed ?? model.runningUsed })}</LiveText>}
    </p>
  </div>;
}

export const couponStatus: WidgetModule = { id: ID, Panel: CouponStatusPanel, Detail: CouponStatusDetail, useSummary: useCouponStatusSummary };
