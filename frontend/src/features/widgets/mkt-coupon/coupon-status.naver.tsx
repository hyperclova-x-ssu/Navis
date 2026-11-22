import { useEffect, useId, useRef, useState } from 'react';
import { addDays } from '../../../data/db/time';
import { useRealPort } from '../../../data/react';
import { PortError } from '../../../data/reality/00';
import { naverCouponHelp, type NaverLedgerDto } from '../../../data/reality/14/dto';
import { issueNaverCouponApproval, naverCouponApprovalExpired, naverIssues, requiresExtraConfirmation, submitNaverCoupon,
  type NaverCouponCard, type NaverCouponIntent, type NaverIssue } from '../../../data/reality/14/naver';
import { ActionButton, DateField, Spinner, Table } from '../../../ui';
import { NaverPlaceForm, NaverPromotionForm } from './coupon-status.naver-forms';
import { audienceNames, couponTypeNames } from './coupon-status.naver-labels';
import { useMkt } from './shared';

/** T-28 (P4/R3): what the owner's press did to the coupon list, never "반영했어요" (nothing is said about what NAVER shows outside the app). */
const done: Record<NaverCouponIntent['operation'], string> = {
  'place.create': '쿠폰을 만들었어요', 'place.delete': '쿠폰을 지웠어요', 'issue.usage': '사용 처리했어요',
  'promotion.create': '주문 프로모션을 만들었어요', 'promotion.extend': '기간을 늘렸어요', 'promotion.end': '프로모션을 일찍 끝냈어요',
};
const titles: Record<NaverCouponIntent['operation'], string> = {
  'place.create': '네이버 쿠폰 만들기', 'place.delete': '쿠폰 삭제', 'issue.usage': '사용 처리',
  'promotion.create': '주문 프로모션 만들기', 'promotion.extend': '기간 늘리기', 'promotion.end': '일찍 끝내기',
};
type Editor = { readonly type: 'place' | 'promotion' } | { readonly type: 'extend'; readonly ref: string; readonly name: string; readonly end: string };
type Review = NaverCouponCard & { readonly label?: string; readonly submitted?: true };

function namedRows(items: readonly Readonly<Record<string, unknown>>[] = []) {
  return items.flatMap(row => typeof row.ref === 'string' && typeof row.name === 'string' ? [{
    ref: row.ref, name: row.name, end: typeof row.to === 'string' ? row.to : '', ended: row.state === 'ended',
  }] : []);
}

export function NaverLedger({ ledger, today }: { readonly ledger: NaverLedgerDto | null; readonly today: string }) {
  const port = useRealPort(), { t, f, money } = useMkt();
  const revision = ledger?.sourceRevision;
  const enabled = !!port && ledger?.approvalsEnabled === true && typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0;
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
  useEffect(() => { if (reviewing) heading.current?.focus(); }, [reviewing, review?.approvalId]);

  const startReview = (intent: NaverCouponIntent, label?: string) => {
    if (!enabled || revision === undefined) return;
    setMessage(undefined);
    setCheckingOutcome(false);
    setEditor(undefined);
    setReview({ intent, expectedRevision: revision, attemptKey: globalThis.crypto.randomUUID(), label });
  };
  const loadIssues = (ref: string) => {
    if (!port) return;
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
    if (!port || !enabled || !review || effect.current) return;
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
  const openEditor = (next: Editor) => { setEditor(next); setEnd(null); setMessage(undefined); };
  const locked = !enabled || !!editor || !!review;
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
          {c.displayPeriod ? <li>{f.date(c.displayPeriod.from, 'short')} – {f.date(c.displayPeriod.to, 'short')}</li> : null}
          {c.quantity ? <li>발급 {c.quantity}장</li> : null}
          {c.conditions ? <li>{c.conditions}</li> : null}
        </ul>;
      }
      case 'promotion.create': {
        const c = intent.command;
        return <ul>
          <li>{c.name} · {f.date(c.from, 'short')} – {f.date(c.to, 'short')}</li>
          <li>스탬프당 주문 금액 {money(c.orderAmountPerStamp)}</li>
          {c.coupons.map((reward, index) => <li key={index}>{reward.name} · 스탬프 {reward.stampCount}개 · {reward.validDays}일
            {' · '}{reward.canCombine ? '중복 사용 가능' : '단독 할인'}{' · '}{reward.canUseAlone ? '단독으로 사용 가능' : '주문 시 사용'}
            {reward.instructions ? ` · ${reward.instructions}` : ''}</li>)}
          {c.instructions ? <li>{c.instructions}</li> : null}
        </ul>;
      }
      case 'place.delete': return <p>{state.label} · 이미 받은 쿠폰은 원래 종료일까지 쓸 수 있어요.</p>;
      case 'promotion.extend': return <p>{state.label} · {f.date(intent.command.endDate, 'short')}까지</p>;
      case 'issue.usage': return <p>{state.label} · {intent.command.status === 'used' ? '사용 완료' : '사용 가능'}</p>;
      default: return <p>{state.label}</p>;
    }
  };

  return <section aria-label="네이버 쿠폰" lang="ko">
    {/* The same table family as the Navis code coupons above it (name column, remaining period, actions), under its own heading. */}
    <h2>네이버 쿠폰</h2>
    {place.length > 0 ? <Table aria-label="네이버 쿠폰 목록" className="mkt-table">
      <thead><tr><th scope="col">{t('widget.coupon-status.colCoupon')}</th><th scope="col">{t('widget.coupon-status.colLeft')}</th><th scope="col">{t('widget.coupon-status.colActions')}</th></tr></thead>
      <tbody>{place.map(row => <tr key={row.ref}>
        <th scope="row"><span className="mkt-coupon-name">{row.name}</span></th>
        <td>{row.end ? `${f.date(row.end, 'short')}까지` : ''}</td>
        <td>
          <div className="mkt-actions">
            <ActionButton variant="secondary" disabled={!port || !!review} onClick={() => loadIssues(row.ref)}>발급 목록</ActionButton>
            <ActionButton variant="secondary" disabled={locked} aria-describedby={approvalHint}
              onClick={() => startReview({ operation: 'place.delete', targetRef: row.ref, command: { confirmed: true } }, row.name)}>{titles['place.delete']}</ActionButton>
          </div>
          {issues?.ref === row.ref ? <div aria-live="polite">
            {issues.failed ? <p role="alert">발급 목록을 불러오지 못했어요</p>
              : issues.rows === undefined ? <Spinner /> : issues.rows.length === 0 ? <p>{empty}</p> : <ul>{issues.rows.map(issue => {
                const expired = issue.expiresOn < today;
                return <li key={issue.ref}>{issue.maskedNumber} · {f.date(issue.issuedOn, 'short')} 발급 · {f.date(issue.expiresOn, 'short')}까지{' '}
                  <ActionButton variant="secondary" disabled={locked || expired} aria-describedby={approvalHint}
                    onClick={() => startReview({ operation: 'issue.usage', targetRef: issue.ref, command: { status: issue.used ? 'unused' : 'used' } }, issue.maskedNumber)}>
                    {issue.used ? '사용 되돌리기' : '사용 처리'}
                  </ActionButton>
                </li>;
              })}</ul>}
          </div> : null}
        </td>
      </tr>)}</tbody>
    </Table> : <p>{empty}</p>}
    <ActionButton variant="secondary" disabled={locked} aria-describedby={approvalHint} onClick={() => openEditor({ type: 'place' })}>{titles['place.create']}</ActionButton>
    <h2>주문 프로모션</h2>
    {promotions.length > 0 ? <Table aria-label="주문 프로모션 목록" className="mkt-table">
      <thead><tr><th scope="col">{t('widget.coupon-status.colCoupon')}</th><th scope="col">{t('widget.coupon-status.colLeft')}</th><th scope="col">{t('widget.coupon-status.colActions')}</th></tr></thead>
      <tbody>{promotions.map(row => <tr key={row.ref}>
        <th scope="row"><span className="mkt-coupon-name">{row.name}</span></th>
        <td>{row.end ? `${f.date(row.end, 'short')}까지` : ''}</td>
        <td>{!row.ended ? <div className="mkt-actions">
          <ActionButton variant="secondary" disabled={locked || !row.end} aria-describedby={approvalHint}
            onClick={() => openEditor({ type: 'extend', ref: row.ref, name: row.name, end: row.end })}>{titles['promotion.extend']}</ActionButton>
          <ActionButton variant="secondary" disabled={locked} aria-describedby={approvalHint}
            onClick={() => startReview({ operation: 'promotion.end', targetRef: row.ref, command: { confirmed: true } }, row.name)}>{titles['promotion.end']}</ActionButton>
        </div> : null}</td>
      </tr>)}</tbody>
    </Table> : <p>{empty}</p>}
    <ActionButton variant="secondary" disabled={locked} aria-describedby={approvalHint} onClick={() => openEditor({ type: 'promotion' })}>{titles['promotion.create']}</ActionButton>
    {!enabled ? <p id={pendingHint} role="status">준비 중</p> : null}
    {enabled && editor ? <div className="mkt-confirm">
      {editor.type === 'place' ? <NaverPlaceForm today={today} onPreview={startReview} />
        : editor.type === 'promotion' ? <NaverPromotionForm today={today} onPreview={startReview} />
          : editor.type === 'extend' ? <>
            <DateField label="새 종료일" today={today} min={addDays(editor.end, 1)} value={end} onValueChange={setEnd} />
            <ActionButton disabled={!end || end <= editor.end}
              onClick={() => { if (end) startReview({ operation: 'promotion.extend', targetRef: editor.ref, command: { endDate: end } }, editor.name); }}>늘릴 기간 확인하기</ActionButton>
          </> : null}
      <ActionButton variant="secondary" onClick={() => setEditor(undefined)}>{t('widget.expiry-coupon.notNow')}</ActionButton>
    </div> : null}
    {enabled && review ? <section aria-labelledby={reviewTitle} className="mkt-confirm" aria-busy={busy}>
      <h3 id={reviewTitle} ref={heading} tabIndex={-1}>{titles[review.intent.operation]}</h3>
      {preview(review)}
      <div className="mkt-actions">
        <ActionButton disabled={busy} onClick={() => { void act(); }}>
          {busy ? <Spinner /> : null}{checkingOutcome ? '결과 확인하기' : requiresExtraConfirmation(review.intent)
            ? review.approvalId ? t('common.navis.agent.confirmAgain') : '내용 확인하기' : '확인하고 실행하기'}
        </ActionButton>
        <ActionButton variant="secondary" disabled={busy || checkingOutcome} onClick={() => { setReview(undefined); setMessage(undefined); }}>{t('widget.expiry-coupon.notNow')}</ActionButton>
      </div>
    </section> : null}
    {message ? <p role={message.error ? 'alert' : 'status'}>{message.text}</p> : null}
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
    <a className="mkt-touch-link" href={naverCouponHelp} target="_blank" rel="noreferrer">네이버 쿠폰 관리 안내 열기</a>
  </section>;
}
