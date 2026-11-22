import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { addDays } from '../../../data/db/time';
import { useRealPort, useWidgetDataStore } from '../../../data/react';
import { PortError } from '../../../data/reality/00';
import { naverCouponHelp, type NaverLedgerDto } from '../../../data/reality/14/dto';
import { issueNaverCouponApproval, naverCouponApprovalExpired, naverIssues, requiresExtraConfirmation, submitNaverCoupon,
  type NaverCouponCard, type NaverCouponIntent, type NaverIssue } from '../../../data/reality/14/naver';
import { ActionButton, DateField, DetailFooterContent, Spinner, Table } from '../../../ui';
import { hasBatchim } from '../../../i18n';
import { NaverPlaceForm, NaverPromotionForm } from './coupon-status.naver-forms';
import { audienceNames, couponTypeNames } from './coupon-status.naver-labels';
import { useMkt } from './shared';

/** T-28 (P4/R3): what the owner's press did to the coupon list, never "반영했어요" (nothing is said about what NAVER shows outside the app). */
const done: Record<NaverCouponIntent['operation'], string> = {
  'place.create': '쿠폰을 만들었어요', 'place.delete': '쿠폰을 지웠어요', 'issue.usage': '사용 처리했어요',
  'promotion.create': '주문 프로모션을 만들었어요', 'promotion.extend': '기간을 늘렸어요', 'promotion.end': '프로모션을 일찍 끝냈어요',
};
const titles: Record<NaverCouponIntent['operation'], string> = {
  'place.create': '네이버 쿠폰 만들기', 'place.delete': '쿠폰 지우기', 'issue.usage': '사용으로 표시하기',
  'promotion.create': '주문 프로모션 만들기', 'promotion.extend': '기간 늘리기', 'promotion.end': '일찍 끝내기',
};
type Editor = { readonly type: 'place' | 'promotion' } | { readonly type: 'extend'; readonly ref: string; readonly name: string; readonly end: string };
type Review = NaverCouponCard & { readonly label?: string; readonly submitted?: true };

function endDate(row: Readonly<Record<string, unknown>>) {
  if (typeof row.to === 'string') return row.to;
  const period = row.displayPeriod;
  return period && typeof period === 'object' && 'to' in period && typeof period.to === 'string' ? period.to : '';
}

function namedRows(items: readonly Readonly<Record<string, unknown>>[] = []) {
  return items.flatMap(row => typeof row.ref === 'string' && typeof row.name === 'string' ? [{
    ref: row.ref, name: row.name, end: endDate(row), ended: row.state === 'ended',
  }] : []);
}

function exampleLedger(today: string): NaverLedgerDto {
  return { sourceRevision: 0, approvalsEnabled: true,
    placeCoupons: { items: [{ ref: 'example-place', name: '플레이스 첫 방문 쿠폰', to: addDays(today, 30) }], nextCursor: null },
    orderPromotions: { items: [{ ref: 'example-order', name: '주문 스탬프', to: addDays(today, 30) }], nextCursor: null },
    membership: { benefits: [{ ref: 'example-member', name: '회원 스탬프' }] } };
}

function updateExampleLedger(ledger: NaverLedgerDto, intent: NaverCouponIntent, ref: string): NaverLedgerDto {
  const place = ledger.placeCoupons, orders = ledger.orderPromotions;
  switch (intent.operation) {
    case 'place.create': return { ...ledger, placeCoupons: { ...place, items: [...place.items, { ref, name: intent.command.name, to: intent.command.displayPeriod?.to }] } };
    case 'place.delete': return { ...ledger, placeCoupons: { ...place, items: place.items.filter(row => row.ref !== intent.targetRef) } };
    case 'promotion.create': return { ...ledger, orderPromotions: { ...orders, items: [...orders.items, { ref, name: intent.command.name, to: intent.command.to }] } };
    case 'promotion.end': return { ...ledger, orderPromotions: { ...orders, items: orders.items.map(row => row.ref === intent.targetRef ? { ...row, state: 'ended' } : row) } };
    case 'promotion.extend': return { ...ledger, orderPromotions: { ...orders, items: orders.items.map(row => row.ref === intent.targetRef ? { ...row, to: intent.command.endDate } : row) } };
    case 'issue.usage': return ledger;
  }
}

const examples = new WeakMap<ReturnType<typeof useWidgetDataStore>, { ledger: NaverLedgerDto; used: ReadonlySet<string> }>();

export function NaverLedger({ ledger: serverLedger, today }: { readonly ledger: NaverLedgerDto | null; readonly today: string }) {
  const realPort = useRealPort(), { t, f, money } = useMkt();
  const port = realPort?.mode('coupons') === 'http' ? realPort : undefined;
  const store = useWidgetDataStore();
  const [example, setExample] = useState(() => examples.get(store) ?? { ledger: exampleLedger(today), used: new Set<string>() });
  const ledger = port ? serverLedger : example.ledger;
  const revision = ledger?.sourceRevision;
  const enabled = ledger?.approvalsEnabled === true && typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0;
  const place = namedRows(ledger?.placeCoupons?.items), promotions = namedRows(ledger?.orderPromotions?.items);
  const membership = ledger?.membership?.items ?? ledger?.membership?.benefits;
  const pendingHint = useId(), reviewTitle = useId();
  const [editor, setEditor] = useState<Editor>();
  const [review, setReview] = useState<Review>();
  const [end, setEnd] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checkingOutcome, setCheckingOutcome] = useState(false);
  const [message, setMessage] = useState<{ readonly error: boolean; readonly text: string }>();
  const [issues, setIssues] = useState<{ readonly ref: string; readonly rows?: readonly NaverIssue[]; readonly failed?: true }>();
  const effect = useRef<AbortController | null>(null), read = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => () => { effect.current?.abort(); read.current?.abort(); }, []);
  const reviewing = !!review;
  useEffect(() => { if (reviewing) heading.current?.focus(); }, [reviewing, review?.attemptKey, review?.approvalId]);

  const startReview = (intent: NaverCouponIntent, label?: string) => {
    if (!enabled || revision === undefined) return;
    setMessage(undefined);
    setCheckingOutcome(false);
    setEditor(undefined);
    setReview({ intent, expectedRevision: revision, attemptKey: globalThis.crypto.randomUUID(), label });
  };
  const loadIssues = (ref: string) => {
    if (!port) {
      const row = place.find(item => item.ref === ref);
      setIssues({ ref, rows: row?.end ? [{ ref, maskedNumber: '•••• 0123', issuedOn: today, expiresOn: row.end, used: example.used.has(ref) }] : [] });
      return;
    }
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    setIssues({ ref });
    void naverIssues(port.transport, ref, controller.signal).then(
      result => { if (!controller.signal.aborted) setIssues({ ref, rows: result.items }); },
      () => { if (!controller.signal.aborted) setIssues({ ref, failed: true }); },
    );
  };
  const act = async () => {
    if (!enabled || !review || effect.current) return;
    if (!port) {
      const { intent } = review;
      if (requiresExtraConfirmation(intent) && !review.approvalId) {
        setReview({ ...review, approvalId: review.attemptKey });
        return;
      }
      const used = new Set(example.used);
      if (intent.operation === 'issue.usage') {
        if (intent.command.status === 'used') used.add(intent.targetRef);
        else used.delete(intent.targetRef);
        setIssues(current => current?.rows ? { ...current, rows: current.rows.map(issue => issue.ref === intent.targetRef ? { ...issue, used: used.has(issue.ref) } : issue) } : current);
      } else if (intent.operation === 'place.delete') setIssues(undefined);
      const next = { ledger: updateExampleLedger(example.ledger, intent, review.attemptKey), used };
      examples.set(store, next);
      setExample(next);
      setReview(undefined);
      setMessage({ error: false, text: done[intent.operation] });
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    effect.current = controller;
    setBusy(true);
    setMessage(undefined);
    let card = review;
    try {
      if (!card.submitted && naverCouponApprovalExpired(card)) {
        throw new PortError(409, 'CONFLICT', 'APPROVAL_EXPIRED');
      }
      if (!card.approvalId) {
        const approval = await issueNaverCouponApproval(port.transport, card, signal);
        if (signal.aborted) return;
        card = { ...card, ...approval };
        setReview(card);
        if (requiresExtraConfirmation(card.intent)) return;
      } else if (requiresExtraConfirmation(card.intent) && !card.confirmed) {
        await issueNaverCouponApproval(port.transport, card, signal);
        if (signal.aborted) return;
        card = { ...card, confirmed: true };
        setReview(card);
      }
      card = { ...card, submitted: true };
      setReview(card);
      const result = await submitNaverCoupon(port.transport, card, signal);
      if (signal.aborted) return;
      if (result.state === 'pending') {
        setCheckingOutcome(true);
        setMessage({ error: false, text: '반영 결과를 확인하고 있어요' });
        return;
      }
      if (result.state !== 'applied' || !result.receiptId) throw new PortError(409, 'CONFLICT', 'NAVER_REJECTED');
      if (issues) {
        if (card.intent.operation === 'place.delete') setIssues(undefined);
        else if (card.intent.operation === 'issue.usage') loadIssues(issues.ref);
      }
      await port.retry('coupons');
      if (!signal.aborted) {
        setReview(undefined);
        setCheckingOutcome(false);
        setMessage({ error: false, text: done[card.intent.operation] });
      }
    } catch (error) {
      if (signal.aborted) return;
      const reason = error instanceof PortError ? error.reason ?? error.code : undefined;
      const stale = reason === 'STALE_REVISION' || reason === 'APPROVAL_EXPIRED';
      if (stale) {
        setReview(undefined);
        setCheckingOutcome(false);
        await port.retry('coupons');
      }
      if (error instanceof PortError && error.outcomeUnknown && card.submitted) setCheckingOutcome(true);
      if (!signal.aborted) setMessage({ error: true, text: stale ? '기록이 바뀌었어요. 새로 불러온 내용을 확인해 주세요'
        : error instanceof PortError && error.outcomeUnknown ? '반영 결과를 확인하지 못했어요. 같은 요청을 다시 확인할 수 있어요'
          : '네이버에 반영하지 못했어요. 기록을 확인한 뒤 다시 시도해 주세요' });
    } finally {
      if (effect.current === controller) effect.current = null;
      if (!signal.aborted) setBusy(false);
    }
  };
  const openEditor = (next: Editor) => { setReview(undefined); setEditor(next); setEnd(null); setMessage(undefined); };
  const locked = !enabled || busy || checkingOutcome;
  const approvalHint = enabled ? undefined : pendingHint;
  const empty = ledger ? '표시할 기록이 없어요' : '아직 볼 수 없어요';
  const preview = (state: Review) => {
    const intent = state.intent;
    switch (intent.operation) {
      case 'place.create': {
        const c = intent.command, b = c.benefit;
        return <ul>
          <li>{c.name} · {couponTypeNames[c.type]} · {audienceNames[c.audience]}</li>
          <li>{b.type === 'gift' ? `${b.item} 증정` : `${b.type === 'percent' ? f.percent(b.value) : money(b.value)} 할인`}</li>
          {c.displayPeriod ? <li>{f.date(c.displayPeriod.from, 'short')} ~ {f.date(c.displayPeriod.to, 'short')}</li> : null}
          {c.quantity ? <li>발급 {c.quantity}장</li> : null}
          {c.conditions ? <li>{c.conditions}</li> : null}
        </ul>;
      }
      case 'promotion.create': {
        const c = intent.command;
        return <ul>
          <li>{c.name} · {f.date(c.from, 'short')} ~ {f.date(c.to, 'short')}</li>
          <li>스탬프당 주문 금액 {money(c.orderAmountPerStamp)}</li>
          {c.coupons.map((reward, index) => <li key={index}>{reward.name} · 스탬프 {reward.stampCount}개 · {reward.validDays}일
            {' · '}{reward.canCombine ? '중복 사용 가능' : '단독 할인'}{' · '}{reward.canUseAlone ? '단독으로 사용 가능' : '주문 시 사용'}
            {reward.instructions ? ` · ${reward.instructions}` : ''}</li>)}
          {c.instructions ? <li>{c.instructions}</li> : null}
        </ul>;
      }
      case 'place.delete': return <p>새로 받을 수 없어요. 이미 받은 쿠폰은 원래 종료일까지 쓸 수 있어요.</p>;
      case 'promotion.end': return <p>오늘로 프로모션이 끝나고 새 스탬프를 받을 수 없어요.</p>;
      case 'promotion.extend': return <p>{state.label} · {f.date(intent.command.endDate, 'short')}까지</p>;
      case 'issue.usage': return <p>{state.label} · {intent.command.status === 'used' ? '사용 완료' : '사용 가능'}</p>;
      default: return <p>{state.label}</p>;
    }
  };

  const confirmation = review && enabled ? (() => {
    const operation = review.intent.operation;
    const destructive = requiresExtraConfirmation(review.intent);
    const target = review.label ?? '';
    const object = `${target}${hasBatchim(target) ? '을' : '를'}`;
    const title = operation === 'place.delete' ? `${object} 지울까요?`
      : operation === 'promotion.end' ? `${object} 오늘 끝낼까요?` : titles[operation];
    const label = checkingOutcome ? '결과 확인하기' : operation === 'place.delete'
      ? review.approvalId ? '쿠폰 지우기' : '지울 쿠폰 확인하기'
      : operation === 'promotion.end' ? review.approvalId ? '오늘 끝내기' : '끝낼 프로모션 확인하기'
        : '확인하고 실행하기';
    return <section aria-labelledby={reviewTitle} className="mkt-confirm mkt-inline-review" aria-busy={busy}>
      <h3 id={reviewTitle} ref={heading} tabIndex={-1}>{title}</h3>
      {preview(review)}
      <div className="mkt-actions">
        <ActionButton variant="secondary" disabled={busy || checkingOutcome} onClick={() => { setReview(undefined); setMessage(undefined); }}>그대로 두기</ActionButton>
        <ActionButton variant={destructive && review.approvalId ? 'destructive' : 'default'} disabled={busy} onClick={() => { void act(); }}>
          {busy ? <Spinner /> : null}{label}
        </ActionButton>
      </div>
    </section>;
  })() : null;
  const isRowReview = (operation: NaverCouponIntent['operation'], ref: string) =>
    review?.intent.operation === operation && 'targetRef' in review.intent && review.intent.targetRef === ref;
  const cancelEditor = () => setEditor(undefined);

  return <section aria-label="네이버 쿠폰" lang="ko" className="mkt-naver-ledger">
    <div className="mkt-ledger-section">
      <div className="mkt-ledger-heading">
        <h2>네이버 쿠폰</h2>
        <ActionButton variant="secondary" disabled={locked || editor?.type === 'place'} aria-describedby={approvalHint} onClick={() => openEditor({ type: 'place' })}>{titles['place.create']}</ActionButton>
      </div>
      {place.length > 0 ? <Table aria-label="네이버 쿠폰 목록" className="mkt-table">
        <thead><tr><th scope="col">{t('widget.coupon-status.colCoupon')}</th><th scope="col">{t('widget.coupon-status.colLeft')}</th><th scope="col">{t('widget.coupon-status.colActions')}</th></tr></thead>
        <tbody>{place.map(row => <Fragment key={row.ref}>
          <tr>
            <th scope="row"><span className="mkt-coupon-name">{row.name}</span></th>
            <td>{row.end ? `${f.date(row.end, 'short')}까지` : '기간 정보 없음'}</td>
            <td><div className="mkt-actions">
              <ActionButton variant="secondary" disabled={busy || checkingOutcome} aria-expanded={issues?.ref === row.ref}
                onClick={() => { if (issues?.ref === row.ref) { read.current?.abort(); setIssues(undefined); } else loadIssues(row.ref); }}>발급 목록 보기</ActionButton>
              <ActionButton variant="secondary" disabled={locked || isRowReview('place.delete', row.ref)} aria-describedby={approvalHint}
                onClick={() => startReview({ operation: 'place.delete', targetRef: row.ref, command: { confirmed: true } }, row.name)}>{titles['place.delete']}</ActionButton>
            </div></td>
          </tr>
          {isRowReview('place.delete', row.ref) && <tr className="mkt-expanded-row"><td colSpan={3}>{confirmation}</td></tr>}
          {issues?.ref === row.ref ? <tr className="mkt-expanded-row"><td colSpan={3}><div aria-live="polite" className="mkt-issued-coupons">
            {issues.failed ? <p role="alert">발급 목록을 불러오지 못했어요</p>
              : issues.rows === undefined ? <Spinner /> : issues.rows.length === 0 ? <p>{empty}</p> : <ul>{issues.rows.map(issue => {
                const expired = issue.expiresOn < today;
                return <li key={issue.ref}>
                  <div className="mkt-issued-row"><span>{issue.maskedNumber} · {f.date(issue.issuedOn, 'short')} 발급 · {f.date(issue.expiresOn, 'short')}까지</span>
                    {expired ? <span>기간 지남</span> : <ActionButton variant="secondary" disabled={locked || isRowReview('issue.usage', issue.ref)} aria-describedby={approvalHint}
                      onClick={() => startReview({ operation: 'issue.usage', targetRef: issue.ref, command: { status: issue.used ? 'unused' : 'used' } }, issue.maskedNumber)}>
                      {issue.used ? '사용 되돌리기' : titles['issue.usage']}
                    </ActionButton>}
                  </div>
                  {isRowReview('issue.usage', issue.ref) && confirmation}
                </li>;
              })}</ul>}
          </div></td></tr> : null}
        </Fragment>)}</tbody>
      </Table> : <p>{empty}</p>}
      {enabled && editor?.type === 'place' && <NaverPlaceForm today={today} onPreview={startReview} onCancel={cancelEditor} />}
      {review?.intent.operation === 'place.create' && confirmation}
    </div>
    <div className="mkt-ledger-section">
      <div className="mkt-ledger-heading">
        <h2>주문 프로모션</h2>
        <ActionButton variant="secondary" disabled={locked || editor?.type === 'promotion'} aria-describedby={approvalHint} onClick={() => openEditor({ type: 'promotion' })}>{titles['promotion.create']}</ActionButton>
      </div>
      {promotions.length > 0 ? <Table aria-label="주문 프로모션 목록" className="mkt-table">
        <thead><tr><th scope="col">{t('widget.coupon-status.colCoupon')}</th><th scope="col">{t('widget.coupon-status.colLeft')}</th><th scope="col">{t('widget.coupon-status.colActions')}</th></tr></thead>
        <tbody>{promotions.map(row => <Fragment key={row.ref}>
          <tr>
            <th scope="row"><span className="mkt-coupon-name">{row.name}</span></th>
            <td>{row.end ? `${f.date(row.end, 'short')}까지` : '기간 정보 없음'}</td>
            <td>{row.ended ? '끝남' : <div className="mkt-actions">
              <ActionButton variant="secondary" disabled={locked || !row.end || editor?.type === 'extend' && editor.ref === row.ref} aria-describedby={approvalHint}
                onClick={() => openEditor({ type: 'extend', ref: row.ref, name: row.name, end: row.end })}>{titles['promotion.extend']}</ActionButton>
              <ActionButton variant="secondary" disabled={locked || isRowReview('promotion.end', row.ref)} aria-describedby={approvalHint}
                onClick={() => startReview({ operation: 'promotion.end', targetRef: row.ref, command: { confirmed: true } }, row.name)}>{titles['promotion.end']}</ActionButton>
            </div>}</td>
          </tr>
          {(isRowReview('promotion.end', row.ref) || isRowReview('promotion.extend', row.ref)) && <tr className="mkt-expanded-row"><td colSpan={3}>{confirmation}</td></tr>}
          {enabled && editor?.type === 'extend' && editor.ref === row.ref && <tr className="mkt-expanded-row"><td colSpan={3}><div className="mkt-confirm mkt-inline-review">
            <DateField label="새 종료일" today={today} min={addDays(editor.end, 1)} value={end} onValueChange={setEnd} />
            <div className="mkt-actions"><ActionButton variant="secondary" onClick={cancelEditor}>취소</ActionButton>
              <ActionButton disabled={!end || end <= editor.end}
                onClick={() => { if (end) startReview({ operation: 'promotion.extend', targetRef: editor.ref, command: { endDate: end } }, editor.name); }}>늘릴 기간 확인하기</ActionButton></div>
          </div></td></tr>}
        </Fragment>)}</tbody>
      </Table> : <p>{empty}</p>}
      {enabled && editor?.type === 'promotion' && <NaverPromotionForm today={today} onPreview={startReview} onCancel={cancelEditor} />}
      {review?.intent.operation === 'promotion.create' && confirmation}
    </div>
    {!enabled && <p id={pendingHint} role="status">준비 중</p>}
    {message && <DetailFooterContent><p role={message.error ? 'alert' : 'status'}>{message.text}</p></DetailFooterContent>}
    <div className="mkt-ledger-section">
      <h2>멤버십 쿠폰</h2>
    {Array.isArray(membership) && membership.length ? <Table aria-label="멤버십 쿠폰 목록" className="mkt-table">
      <thead><tr><th scope="col">{t('widget.coupon-status.colCoupon')}</th></tr></thead>
      <tbody>{membership.map((row, index) => {
        if (!row || typeof row !== 'object') return null;
        const name = typeof row.name === 'string' ? row.name : typeof row.benefit === 'string' ? row.benefit : null;
        return name ? <tr key={typeof row.ref === 'string' ? row.ref : index}><th scope="row"><span className="mkt-coupon-name">{typeof row.provider === 'string' ? `${row.provider} · ` : ''}{name}</span></th></tr> : null;
      })}</tbody>
    </Table> : <p>{ledger ? '연결된 멤버십 상품이 없어요' : empty}</p>}
    <p>멤버십 쿠폰은 멤버십 제휴사 화면에서 바꿔요</p>
    <a className="mkt-touch-link mkt-ledger-link" href={naverCouponHelp} target="_blank" rel="noreferrer">네이버 쿠폰 관리 안내 열기</a>
    </div>
  </section>;
}
