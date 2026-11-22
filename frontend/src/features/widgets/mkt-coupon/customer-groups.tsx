/**
 * 손님 그룹 (customer-groups, F-52, SCR-37/39): panel (7명 + PanelAction), the three groups (떠날 수 있는 손님 · 첫 방문 · 단골)
 * by card visits, and ‘이 손님들 챙기기’: consenting customers pre-selected, the rest disabled with the reason,
 * shared SMS preview with fixed ad and opt-out lines, and a confirmation step with no undo.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { WidgetDetailProps, WidgetHost, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useDataDispatch, useDataExecute, useDomainState, useRealRetry, useWidgetDataStore, useWidgetView } from '../../../data/react';
import { formatMaskedCustomer } from '../../../data/customer-display';
import { customersOf } from '../../../data/marketing/derive';
import type { CustomerGroupId, CustomerGroupsModel, GroupCustomer, WidgetView } from '../../../data/widget-data';
import { NAVER_BENEFIT_ADMIN_URL } from '../../../data/reality/19/dto';
import { smsSenderConfigured } from '../../../data/reality/14/sms';
import { useReachOutCheck, useReachOutMode } from '../../../data/reality/19/reach-out';
import { ActionButton, ConfirmStep, DetailFooterContent, DetailTabs, Icon, RecipientList, useKitT } from '../../../ui';
import { isLargeCard, koreanLang } from '../mkt-local/fit';
import { MktPanel } from './panel';
import { DetailNotReady, EditableSmsPreview, extraRow, listRows, Live, LiveText, NoteLine, PanelNotReady, reportResult, SmsSetupHelp, useActionFocus, useFormKey, useKept, useMkt, useSendPhase, SentStatus } from './shared';

const ID = 'customer-groups' as const;

const NO_IDS: ReadonlySet<string> = new Set();

/** HTTP groups domain: the error state's retry re-reads the service instead of resetting a sample state. */
function useRetryHost(host: WidgetHost): WidgetHost {
  const retry = useRealRetry('groups');
  const http = useDomainState('groups').mode === 'http';
  return http ? { ...host, resetPreview: retry } : host;
}

export function CustomerGroupsPanel({ width, height, shape, editing, host: shellHost }: WidgetPanelProps) {
  const { t, f, dt } = useMkt();
  const view = useWidgetView(ID);
  const host = useRetryHost(shellHost);
  const name = t('widget.customer-groups.title');
  if (view.status !== 'ready') return <PanelNotReady view={view} widgetName={name} host={host} shape={shape} width={width} shortMessage={view.status === 'empty' && view.messageKey === 'data.state.customer-groups.no-history' ? t('widget.customer-groups.state.no-history.short') : undefined}
    onEmptyAction={() => host.openDetail({ featureId: 'members' })} emptyActionLabel={view.status === 'empty' && view.messageKey === 'data.state.customer-groups.no-history' ? t('widget.customer-groups.state.no-history.action') : undefined} />;
  const m = view.model;
  const churn = m.counts['churn-risk'];
  const note = view.notes?.[0];
  const group = t('data.marketing.group.churnRisk');
  const descs = shape === 'W' ? [t('widget.customer-groups.panelW', { a: m.counts['first-visit'], b: m.counts.regular })]
    : shape === 'Q' && note ? [t(note.messageKey)] : [];
  const large = isLargeCard(shape, height);
  const rows = [
    ...m.groups.filter(g => g.id !== 'churn-risk').map((g) => <li key={g.id} data-row-id={g.id}>{t('widget.customer-groups.groupLine', { group: t(g.nameKey), n: f.count(g.count, 'person') })}</li>),
    // D-333: 3-high cards list 6 customers who may leave and 4-high cards 9 (never more than the data has); the 4-high card also says each one's usual visit cycle, as the reach-out list does.
    ...(shape === 'S' || shape === 'L' ? m.churnRisk.slice(0, listRows(shape, height, 3, 9)).map((c, index) => <li key={c.customerId} lang={koreanLang(formatMaskedCustomer(dt(c.name), undefined, c.memberCode))} data-row-id={c.customerId} {...extraRow(index)}>
      {formatMaskedCustomer(dt(c.name), undefined, c.memberCode)}{'\u00A0·\u00A0'}{t('widget.customer-groups.lastVisit', { date: f.date(c.lastVisit, 'short') })}{large ? `\u00A0·\u00A0${c.usualCycleDays === null ? t('widget.customer-groups.cycleNone') : t('widget.customer-groups.cycle', { n: c.usualCycleDays })}` : ''}
    </li>) : []),
  ];
  return <MktPanel id={ID} shape={shape} width={width} height={height} editing={editing}
    label={group} kpi={{ value: String(churn), unit: t('widget.customer-groups.unitName') }}
    descs={descs} aside={view.notes?.length ? <NoteLine notes={view.notes} compact={editing} /> : undefined} rows={rows}
    action={m.canReachOut ? { label: t('marketing.sendCoupon'), widgetName: name, onPress: () => host.openDetail({ featureId: ID, view: 'reach-out', focus: 'action' }) } : null} />;
}

export function useCustomerGroupsSummary(): string {
  const { t } = useMkt();
  const view = useWidgetView(ID);
  if (view.status !== 'ready') return t(view.messageKey);
  const c = view.model.counts;
  return t('widget.customer-groups.summary', { n: c['churn-risk'], a: c['first-visit'], b: c.regular });
}

export function CustomerGroupsDetail({ detailRef, host: shellHost }: WidgetDetailProps) {
  const view = useWidgetView(ID);
  const host = useRetryHost(shellHost);
  const root = useRef<HTMLDivElement>(null);
  useActionFocus(root, detailRef, ['reach-out']);
  return <div ref={root} className="mkt-detail mkt-detail--single" data-widget={ID}>
    {view.status !== 'ready' ? <EmptyOrError view={view} host={host} /> : <GroupsBody model={view.model} notes={view.notes} host={host} initialTab={groupOf(detailRef.view)} />}
  </div>;
}

/** The empty (no visit history) state names its next step: the member list is where contacts and text consent are checked (A10). */
function EmptyOrError({ view, host }: { readonly view: Exclude<WidgetView<unknown>, { status: 'ready' }>; readonly host: WidgetHost }) {
  const { t } = useMkt();
  const noHistory = view.status === 'empty' && view.messageKey === 'data.state.customer-groups.no-history';
  return <DetailNotReady view={view} host={host}
    next={noHistory ? { text: t('widget.customer-groups.state.no-history.next'), label: t('widget.customer-groups.state.no-history.action'), onPress: () => host.openLinked({ featureId: 'members' }) } : undefined} />;
}

function customerRecipient(c: GroupCustomer, { t, f, dt }: ReturnType<typeof useMkt>, consent: boolean) {
  const last = t('widget.customer-groups.lastVisit', { date: f.date(c.lastVisit, 'short') });
  return { id: c.customerId, name: formatMaskedCustomer(dt(c.name), undefined, c.memberCode), consent,
    meta: c.usualCycleDays !== null ? `${last} · ${t('widget.customer-groups.cycle', { n: c.usualCycleDays })}` : last };
}

function CustomerRows({ customers, group, onSeeChurn }: { readonly customers: readonly GroupCustomer[]; readonly group: string; readonly onSeeChurn: () => void }) {
  const mkt = useMkt();
  const { t } = mkt;
  if (customers.length === 0) return <div className="mkt-none">
    <p className="mkt-hint">{t('widget.customer-groups.noneHere')}</p>
    <ActionButton variant="secondary" onClick={onSeeChurn}>{t('widget.customer-groups.seeChurn')}</ActionButton>
  </div>;
  return <RecipientList label={t('widget.customer-groups.listLabel', { group })}
    consentLabels={{ yes: t('widget.customer-groups.consentYes'), no: t('widget.customer-groups.consentNo') }}
    recipients={customers.map(c => customerRecipient(c, mkt, c.consentSms))} />;
}

/** N18 handoff: a Navis entry names the group tab (`view`); `reach-out` and anything else open the churn-risk tab, where the form lives. */
const groupOf = (view: string | undefined): CustomerGroupId => view === 'regular' || view === 'first-visit' ? view : 'churn-risk';

function GroupsBody({ model, notes, host, initialTab }: { readonly model: CustomerGroupsModel; readonly notes: Parameters<typeof NoteLine>[0]['notes']; readonly host: WidgetHost; readonly initialTab: CustomerGroupId }) {
  const { t } = useMkt();
  const store = useWidgetDataStore();
  const marketing = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).tables.marketing;
  const coverage = model.real?.coverage ?? (() => {
    const customers = customersOf(marketing, 'normal');
    const grouped = new Set(model.groups.flatMap(group => group.customers.map(customer => customer.customerId)));
    return { activeMembers: customers.length, ungroupedMembers: customers.filter(customer => !grouped.has(customer.customerId)).length };
  })();
  const [tab, setTab] = useState<CustomerGroupId>(initialTab);
  const basis = (id: CustomerGroupId) => t(`widget.customer-groups.basis.${id}`, { days: id === 'regular' ? model.rule.regularDays : model.rule.churnGapDays, n: model.rule.regularVisits });
  return <div data-slot="customer-groups.detail">
    <DetailTabs value={tab} onValueChange={setTab} label={t('widget.customer-groups.groupsLabel')}
      tabs={model.groups.map((g) => ({ value: g.id, label: `${t(g.nameKey)} ${g.count}` }))}
      panels={Object.fromEntries(model.groups.map((g) => [g.id, <div key={g.id} className="mkt-group-panel">
        <div className="mkt-group-naver" data-slot="customer-groups.naver">
          <p className="mkt-basis">{t('widget.customer-groups.naverGuide')}</p>
          <a className="ui-button ui-button--link ui-button--default" href={NAVER_BENEFIT_ADMIN_URL} target="_blank" rel="noopener noreferrer"><span className="ui-press-surface">{t('data.real.groups.manageInNaver.open')}</span></a>
        </div>
        <p className="mkt-basis" data-slot="customer-groups.coverage">{t('widget.customer-groups.coverage', { active: coverage.activeMembers, ungrouped: coverage.ungroupedMembers })}</p>
        <NoteLine notes={notes} />
        <p className="mkt-basis">{basis(g.id)}</p>
        <p className="mkt-basis">{t('widget.customer-groups.posBasis')}</p>
        {g.id === 'churn-risk' ? <ReachOut model={model} host={host} /> : <CustomerRows customers={g.customers} group={t(g.nameKey)} onSeeChurn={() => setTab('churn-risk')} />}
      </div>])) as Partial<Record<CustomerGroupId, React.ReactNode>>} />
  </div>;
}

function ReachOut({ model, host }: { readonly model: CustomerGroupsModel; readonly host: WidgetHost }) {
  const mkt = useMkt();
  const { t, f, dt } = mkt;
  const kit = useKitT();
  const dispatch = useDataDispatch();
  const execute = useDataExecute();
  const check = useReachOutCheck();
  const { sendOpen } = useReachOutMode();
  const { phase, setPhase, startSending } = useSendPhase();
  const [key, renewKey] = useFormKey('reach');
  const [off, setOff] = useKept<readonly string[]>('customer-groups.off', []);
  const [edited, setEdited] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [sentCount, setSentCount] = useState<number | null>(null);
  // HTTP: members the service refused at the consent check stay listed with their reason and are never selected again until the groups are re-read
  // (a refusal belongs to the projection revision it was answered for, so a newer revision starts clean).
  const revision = model.real?.sourceRevision;
  const [refusal, setRefusal] = useState<{ readonly revision: number | undefined; readonly ids: ReadonlySet<string> }>({ revision, ids: NO_IDS });
  const refused = refusal.revision === revision ? refusal.ids : NO_IDS;
  const [checking, setChecking] = useState(false);
  const attempt = useRef(0);
  useEffect(() => () => { attempt.current += 1; }, []);
  const selectable = model.reachOut.recipientIds.filter((id) => !refused.has(id));
  const selected = selectable.filter((id) => !off.includes(id));
  const defaultBody = dt({ key: 'data.marketing.sms.reachOut' });
  const body = edited ?? defaultBody;
  const couponName = t('data.marketing.coupon.thanksBackGroup');
  const blocked = !smsSenderConfigured || selected.length === 0 || !model.canReachOut || checking;

  /** Opens the confirmation. Over HTTP the service checks consent first (nothing is written); a refused or stale answer keeps the owner on the form. */
  const begin = async () => {
    if (blocked) return;
    setError(null); setInfo(null);
    if (!check) { setPhase('confirm'); return; }
    const token = ++attempt.current;
    setChecking(true);
    const result = await check(selected);
    if (token !== attempt.current) return;
    setChecking(false);
    if (!result.ok) { setError(t(result.reason === 'STALE_REVISION' ? 'data.real.groups.check.stale' : 'data.real.groups.check.failed')); return; }
    if (result.blocked.length > 0) {
      setRefusal({ revision, ids: new Set([...refused, ...result.blocked.map((row) => row.memberId)]) });
      setError(t('data.real.groups.check.blocked', { n: result.blocked.length }));
      return;
    }
    // The send has no authoritative binding yet (B14): say so instead of running the local sample handler and reporting a send that did not happen.
    if (!sendOpen) { setInfo(t('data.real.groups.send.notYet')); return; }
    setPhase('confirm');
  };

  const send = async () => {
    if (blocked) return;
    const messageEdits = edited !== null && edited.trim() !== defaultBody.trim() ? edited : undefined;
    const command = { type: 'coupon.sendReachOut', recipientIds: selected, idempotencyKey: key, ...(messageEdits ? { messageEdits } : {}) } as const;
    if (check) {
      setPhase('sending');
      const result = await execute(command);
      const failure = reportResult(result, host, t, 'data.notice.sent');
      if (failure) { setError(failure); setPhase('form'); return; }
      setError(null); setSentCount(selected.length); setPhase('sent');
      return;
    }
    const result = dispatch(command);
    const failure = reportResult(result, host, t, 'data.notice.sent');
    if (failure) { setError(failure); setPhase('form'); return; }
    setError(null); setSentCount(selected.length); startSending();
  };
  const reset = () => { setPhase('form'); renewKey(); setEdited(null); setSentCount(null); setOff([]); setInfo(null); };
  const count = sentCount ?? selected.length;

  return <div className="mkt-columns mkt-reach-out">
    <div className="mkt-col-main" data-first-control>
      <h2 className="mkt-h2">{t('widget.customer-groups.recipientsTitle')}</h2>
      <RecipientList label={t('marketing.recipients')} selected={selected} onChange={(ids) => setOff(selectable.filter((id) => !ids.includes(id)))}
        consentLabels={{ yes: t('widget.customer-groups.consentYes'), no: t('widget.customer-groups.consentNo') }}
        recipients={model.churnRisk.map(c => customerRecipient(c, mkt, c.selectable && !refused.has(c.customerId)))
          .sort((a, b) => Number(b.consent) - Number(a.consent))} />
    </div>
    <div className="mkt-col-side">
      {phase === 'form' ? <>
        <p className="mkt-reach-out-coupon"><strong>{t('widget.customer-groups.couponName')}</strong> · {couponName}</p>
        <EditableSmsPreview body={body} onBodyChange={setEdited} />
        {!smsSenderConfigured && <SmsSetupHelp openSettings={host.openSettings} settingsPath />}
        <DetailFooterContent>
          <div className="mkt-reach-out-actions">
            <ActionButton disabled={blocked} aria-busy={checking || undefined} aria-describedby={selected.length === 0 ? 'cg-reason' : undefined} onClick={() => { void begin(); }} data-slot="customer-groups.send">
              {t('widget.customer-groups.send', { n: selected.length })}
            </ActionButton>
          </div>
        </DetailFooterContent>
        {selected.length === 0 ? <p id="cg-reason" className="mkt-reason" role="status">{t('marketing.noRecipients')}</p> : null}
        {error ? <p className="mkt-reason" role="alert"><Icon name="error" aria-hidden />{error}</p> : null}
        {info ? <p className="mkt-reason" role="status" data-slot="customer-groups.send-closed"><Icon name="info" aria-hidden />{info}</p> : null}
      </> : <>
        {phase === 'sent' ? (check ? <p className="ui-confirm-step__status" role="status"><Icon name="check" aria-hidden />{t('data.real.groups.send.requested')}</p> : <SentStatus />) : <ConfirmStep count={count} phase={phase === 'confirm' ? 'ask' : phase} onCancel={() => setPhase('form')} onSend={() => { void send(); }}
          summary={[
            { label: t('marketing.recipients'), value: f.count(count, 'person') },
            { label: t('marketing.benefit'), value: couponName },
            { label: kit.t('ui.send.time'), value: kit.t('ui.send.now') },
          ]} />}
        {phase === 'sent' ? <ActionButton variant="secondary" onClick={reset}>{t('widget.customer-groups.again')}</ActionButton> : null}
      </>}
      {model.sent.length > 0 ? <section className="mkt-sent" aria-labelledby="cg-sent">
        <h3 id="cg-sent">{t('widget.customer-groups.sentTitle')}</h3>
        <ul>{[...model.sent].reverse().map((row) => <li key={row.couponId}><LiveText value={`${row.used}/${row.issued}`}>
          {t('widget.slot-coupon.sentLine', { name: dt(row.name), used: row.used ?? 0, issued: row.issued, left: t('widget.coupon-status.daysLeft', { n: row.daysLeft }) })}
        </LiveText></li>)}</ul>
      </section> : null}
      <Live value={selected.length}><span className="ui-sr-only">{f.count(selected.length, 'person')}</span></Live>
    </div>
  </div>;
}

export const customerGroups: WidgetModule = { id: ID, Panel: CustomerGroupsPanel, Detail: CustomerGroupsDetail, useSummary: useCustomerGroupsSummary };
