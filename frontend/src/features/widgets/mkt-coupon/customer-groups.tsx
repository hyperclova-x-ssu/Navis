/**
 * 손님 그룹 (customer-groups, F-52, SCR-37/39): panel (7명 + PanelAction), the three groups (떠날 수 있는 손님 · 첫 방문 · 단골)
 * by card visits, and ‘이 손님들 챙기기’: consenting customers pre-selected, the rest disabled with the reason,
 * shared SMS preview with fixed ad and opt-out lines, and a confirmation step with no undo.
 */
import { useRef, useState } from 'react';
import type { WidgetDetailProps, WidgetHost, WidgetModule, WidgetPanelProps } from '../../../contracts';
import { useDataDispatch, useWidgetView } from '../../../data/react';
import type { CustomerGroupId, CustomerGroupsModel, GroupCustomer, WidgetView } from '../../../data/widget-data';
import { ActionButton, ConfirmStep, DetailTabs, Icon, RecipientList, StatusBadge, useKitT } from '../../../ui';
import { koreanLang } from '../mkt-local/fit';
import { MktPanel } from './panel';
import { DetailNotReady, EditableSmsPreview, Live, LiveText, NoteLine, PanelNotReady, recipientMeta, reportResult, useActionFocus, useFormKey, useKept, useMkt, useSendPhase, SentStatus } from './shared';

const ID = 'customer-groups' as const;

export function CustomerGroupsPanel({ width, height, shape, editing, host }: WidgetPanelProps) {
  const { t, f, dt } = useMkt();
  const view = useWidgetView(ID);
  const name = t('widget.customer-groups.title');
  if (view.status !== 'ready') return <PanelNotReady view={view} widgetName={name} host={host} shape={shape} width={width} shortMessage={view.status === 'empty' && view.messageKey === 'data.state.customer-groups.no-history' ? t('widget.customer-groups.state.no-history.short') : undefined}
    onEmptyAction={() => host.openDetail({ featureId: 'members' })} emptyActionLabel={view.status === 'empty' && view.messageKey === 'data.state.customer-groups.no-history' ? t('widget.customer-groups.state.no-history.action') : undefined} />;
  const m = view.model;
  const churn = m.counts['churn-risk'];
  const note = view.notes?.[0];
  const group = t('data.marketing.group.churnRisk');
  const descs = (shape === 'Q' || shape === 'T' ? [note ? t(note.messageKey) : group] : [t('widget.customer-groups.panelW', { a: m.counts['first-visit'], b: m.counts.regular }), group]);
  const rows = [
    ...m.groups.filter((g) => (shape !== 'S' && shape !== 'L') || g.id !== 'churn-risk').map((g) => <li key={g.id} data-row-id={g.id}>{t('widget.customer-groups.groupLine', { group: t(g.nameKey), n: f.count(g.count, 'person') })}</li>),
    ...(shape === 'S' || shape === 'L' ? m.churnRisk.slice(0, 3).map((c) => <li key={c.customerId} lang={koreanLang(dt(c.name))} data-row-id={c.customerId}>{dt(c.name)}{'\u00A0·\u00A0'}{t('widget.customer-groups.lastVisit', { date: f.date(c.lastVisit, 'short') })}</li>) : []),
  ];
  return <MktPanel id={ID} shape={shape} width={width} height={height} editing={editing}
    label={group} kpi={{ value: String(churn), unit: t('widget.customer-groups.unitName') }}
    descs={descs} aside={view.notes?.length ? <NoteLine notes={view.notes} compact={editing} /> : undefined} rows={rows}
    action={m.canReachOut ? { label: shape === 'Q' || shape === 'T' ? t('marketing.reachOut') : t('marketing.reachOutToThese'), widgetName: name, onPress: () => host.openDetail({ featureId: ID, view: 'reach-out', focus: 'action' }) } : null} />;
}

export function useCustomerGroupsSummary(): string {
  const { t } = useMkt();
  const view = useWidgetView(ID);
  if (view.status !== 'ready') return t(view.messageKey);
  const c = view.model.counts;
  return t('widget.customer-groups.summary', { n: c['churn-risk'], a: c['first-visit'], b: c.regular });
}

export function CustomerGroupsDetail({ detailRef, host }: WidgetDetailProps) {
  const view = useWidgetView(ID);
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

function CustomerRows({ customers, group, onSeeChurn }: { readonly customers: readonly GroupCustomer[]; readonly group: string; readonly onSeeChurn: () => void }) {
  const { t, f, dt } = useMkt();
  if (customers.length === 0) return <div className="mkt-none">
    <p className="mkt-hint">{t('widget.customer-groups.noneHere')}</p>
    <ActionButton variant="secondary" onClick={onSeeChurn}>{t('widget.customer-groups.seeChurn')}</ActionButton>
  </div>;
  return <ul className="mkt-customers" aria-label={t('widget.customer-groups.listLabel', { group })}>{customers.map((c) => <li key={c.customerId} data-row-id={c.customerId}>
    <span className="mkt-customers__name">{dt(c.name)}</span>
    <span className="mkt-customers__meta">{t('widget.customer-groups.lastVisit', { date: f.date(c.lastVisit, 'short') })}{'\u00A0·\u00A0'}{c.usualCycleDays === null ? t('widget.customer-groups.cycleNone') : t('widget.customer-groups.cycle', { n: c.usualCycleDays })}</span>
    <StatusBadge semantic={c.consentSms ? 'done' : 'warning'} label={c.consentSms ? t('widget.customer-groups.consentYes') : t('widget.customer-groups.consentNo')} />
  </li>)}</ul>;
}

/** N18 handoff: a Navis entry names the group tab (`view`); `reach-out` and anything else open the churn-risk tab, where the form lives. */
const groupOf = (view: string | undefined): CustomerGroupId => view === 'regular' || view === 'first-visit' ? view : 'churn-risk';

function GroupsBody({ model, notes, host, initialTab }: { readonly model: CustomerGroupsModel; readonly notes: Parameters<typeof NoteLine>[0]['notes']; readonly host: WidgetHost; readonly initialTab: CustomerGroupId }) {
  const { t, f } = useMkt();
  const [tab, setTab] = useState<CustomerGroupId>(initialTab);
  const basis = (id: CustomerGroupId) => t(`widget.customer-groups.basis.${id}`, { days: id === 'regular' ? model.rule.regularDays : model.rule.churnGapDays, n: model.rule.regularVisits });
  return <div data-slot="customer-groups.detail">
    <NoteLine notes={notes} />
    <DetailTabs value={tab} onValueChange={setTab} label={t('widget.customer-groups.groupsLabel')}
      tabs={model.groups.map((g) => ({ value: g.id, label: `${t(g.nameKey)} ${g.count}` }))}
      panels={Object.fromEntries(model.groups.map((g) => [g.id, <div key={g.id} className="mkt-group-panel">
        {g.id === 'regular' ? <p className="mkt-basis mkt-basis--answer" data-slot="customer-groups.regular-answer">{t('widget.customer-groups.regularAnswer', { n: g.count })}</p> : null}
        <p className="mkt-basis">{basis(g.id)}</p>
        <p className="mkt-basis mkt-basis--note">{t(model.basisKey)}</p>
        {g.id === 'churn-risk' ? <ReachOut model={model} host={host} /> : <CustomerRows customers={g.customers} group={t(g.nameKey)} onSeeChurn={() => setTab('churn-risk')} />}
      </div>])) as Partial<Record<CustomerGroupId, React.ReactNode>>} />
    <span className="ui-sr-only">{f.count(model.counts['churn-risk'], 'person')}</span>
  </div>;
}

function ReachOut({ model, host }: { readonly model: CustomerGroupsModel; readonly host: WidgetHost }) {
  const { t, f, dt } = useMkt();
  const kit = useKitT();
  const dispatch = useDataDispatch();
  const { phase, setPhase, startSending } = useSendPhase();
  const [key, renewKey] = useFormKey('reach');
  const [off, setOff] = useKept<readonly string[]>('customer-groups.off', []);
  const [edited, setEdited] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentCount, setSentCount] = useState<number | null>(null);
  const selectable = model.reachOut.recipientIds;
  const selected = selectable.filter((id) => !off.includes(id));
  const defaultBody = dt({ key: 'data.marketing.sms.reachOut' });
  const body = edited ?? defaultBody;
  const blocked = selected.length === 0 || !model.canReachOut;

  const send = () => {
    const messageEdits = edited !== null && edited.trim() !== defaultBody.trim() ? edited : undefined;
    const result = dispatch({ type: 'coupon.sendReachOut', recipientIds: selected, idempotencyKey: key, ...(messageEdits ? { messageEdits } : {}) });
    const failure = reportResult(result, host, t, 'data.notice.sent');
    if (failure) { setError(failure); setPhase('form'); return; }
    setError(null); setSentCount(selected.length); startSending();
  };
  const reset = () => { setPhase('form'); renewKey(); setEdited(null); setSentCount(null); setOff([]); };
  const count = sentCount ?? selected.length;

  return <div className="mkt-columns">
    <div className="mkt-col-main" data-first-control>
      <h2 className="mkt-h2">{t('marketing.reachOutToThese')}</h2>
      <RecipientList label={t('marketing.recipients')} selected={selected} onChange={(ids) => setOff(selectable.filter((id) => !ids.includes(id)))}
        recipients={[...model.churnRisk].sort((a, b) => Number(b.selectable) - Number(a.selectable)).map((c) => ({
          id: c.customerId, name: dt(c.name), consent: c.selectable,
          meta: recipientMeta(dt(c.name), `${t('widget.customer-groups.lastVisit', { date: f.date(c.lastVisit, 'short') })}\u00A0·\u00A0${c.usualCycleDays === null ? t('widget.customer-groups.cycleNone') : t('widget.customer-groups.cycle', { n: c.usualCycleDays })}`),
        }))} />
    </div>
    <div className="mkt-col-side">
      {phase === 'form' ? <>
        <div className="mkt-reach-out-form">
          <EditableSmsPreview body={body} onBodyChange={setEdited} recipientCount={selected.length} />
          <div className="mkt-reach-out-actions">
            <p>{t('marketing.recipients')} {f.count(selected.length, 'person')}</p>
            <ActionButton disabled={blocked} aria-describedby={selected.length === 0 ? 'cg-reason' : undefined} onClick={() => { setError(null); setPhase('confirm'); }} data-slot="customer-groups.send">
              {t('widget.customer-groups.send', { n: selected.length })}
            </ActionButton>
          </div>
        </div>
        {selected.length === 0 ? <p id="cg-reason" className="mkt-reason" role="status">{t('marketing.noRecipients')}</p> : null}
        {error ? <p className="mkt-reason" role="alert"><Icon name="error" aria-hidden />{error}</p> : null}
      </> : <>
        {phase === 'sent' ? <SentStatus /> : <ConfirmStep count={count} phase={phase === 'confirm' ? 'ask' : phase} onCancel={() => setPhase('form')} onSend={send}
          summary={[
            { label: t('marketing.recipients'), value: f.count(count, 'person') },
            { label: t('marketing.benefit'), value: t('data.marketing.coupon.thanksBackGroup') },
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
