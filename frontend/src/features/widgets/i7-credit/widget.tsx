import { useEffect, useRef, useState } from 'react';
import { creditDetailEntry } from '../../assistant/domains/members';
import type { WidgetDetailProps, WidgetPanelProps } from '../../../contracts';
import { TODAY } from '../../../data/widget-data';
import { useDomainState, useRealRetry, useWidgetDataStore } from '../../../data/react';
import { memberDateTime } from '../../../data/reality/05/dto';
import { useI18n } from '../../../i18n';
import { ActionButton, ChipChoice, DataGrid, DetailSidePanel, DetailTabs, Icon, MetricFit, PanelAction, PanelState, SearchField, Table, layoutTokens, type DataGridHandle, type GridColumn, type GridFocus } from '../../../ui';
import { FitProbe } from '../mgmt-money/fit';
import { PanelFrame } from '../mgmt-customers/shared';
import { formatMaskedCustomer, memberDisplayId } from '../../../data/customer-display';
import { restoreGrid, useSideGrid } from '../mgmt-customers/workspace';
import { AccountActions, OriginalTransactionButton } from './account-controls';
import { useMemberFunding } from './use-member-funding';
import { creditCopy, hasOriginal, maskedPhone, money, noKindRows, number, signedMoney, transactionLabel } from './copy';
import type { AccountMember, AccountTransaction, CreditBinding, CreditPort } from './types';
import { PanelRemainder } from '../i7-staff/panel-remainder';
import './credit.css';

const tabs = [{ value: 'members', label: '회원별 현황' }, { value: 'charge', label: '충전금 내역' }, { value: 'receivable', label: '외상·수금 내역' }] as const;
type Tab = typeof tabs[number]['value'];
const minWidth = layoutTokens.targetDefault * 3;
const hasBalance = (member: AccountMember) => member.chargeBalance > 0 || member.receivableBalance > 0;
/** Members who hold a balance come first (stable by member id); with hundreds of members they would otherwise sit far down the list. */
const holdersFirst = (members: readonly AccountMember[]) => members.slice().sort((a, b) => Number(hasBalance(b)) - Number(hasBalance(a)));

/** Both states keep a next action (H1): retry for a failed load, the member list for an empty one. */
function CreditState({ status, compact = false, detail = false, retry, openMembers }: { readonly status: 'empty' | 'error'; readonly compact?: boolean; readonly detail?: boolean; readonly retry: () => void; readonly openMembers: () => void }) {
  const state = <PanelState tone={status === 'error' ? 'error' : 'info'} message={status === 'error' ? creditCopy.error : creditCopy.empty} shortMessage={compact && status === 'error' ? creditCopy.shortError : undefined}
    action={status === 'error' ? { label: '다시 시도하기', widgetName: creditCopy.title, onPress: retry } : { label: creditCopy.openMembers, widgetName: creditCopy.title, onPress: openMembers }}>
    {status === 'empty' && detail ? <p className="credit-secondary">{creditCopy.emptyNext}</p> : null}
  </PanelState>;
  return <div lang="ko" className={detail ? 'credit-detail-state' : undefined}>{state}</div>;
}
function Metric({ amount, label, longest }: { readonly amount: number; readonly label: string; readonly longest: string }) {
  return <div className="credit-metric" data-credit-metric><MetricFit value={number(amount)} unit="원" longest={longest} stacked={false} /><p className="credit-label">{label}</p></div>;
}
/** The two account totals as two summary cards with big values (SCR-279). */
function SummaryCards({ items }: { readonly items: readonly { readonly label: string; readonly amount: number }[] }) {
  const longest = items.map(item => number(item.amount)).sort((a, b) => b.length - a.length)[0] ?? '0';
  return <dl className="credit-summary">{items.map(item => <div className="credit-summary-card" key={item.label}><dt>{item.label}</dt><dd><MetricFit value={number(item.amount)} unit="원" longest={longest} stacked={false} /></dd></div>)}</dl>;
}
const SHORT_FIT = [{ selector: '.credit-last-column' }, { selector: '.credit-member-rows .credit-value-row', last: true }, { selector: '.credit-panel-history li', last: true }, { selector: '.credit-panel-table tbody tr', last: true }] as const;
/** D-333: on the large card the recent-transaction lines (and their title) go first, then the table's last-visit column and rows. */
const LARGE_FIT = [{ selector: '.credit-panel-recent li', last: true }, { selector: '.credit-panel-recent .credit-history-title' }, ...SHORT_FIT] as const;
const RECENT_ROWS = 12;
export function CreditPanel(props: WidgetPanelProps & CreditBinding) {
  const { view } = props;
  const today = props.today ?? TODAY;
  const t = useI18n();
  const when = (at: string) => t.format.dateTime(props.today ? memberDateTime(at) : at, { today });
  const state = useDomainState('members'), retry = useRealRetry('members');
  const { memberProfile } = useWidgetDataStore().getSnapshot().tables;
  const codes = new Map(memberProfile.map(row => [row.memberId, row.memberCode]));
  // From a dashboard panel the members window opens like the panel's own windows (focus returns to this panel); openLinked is for windows already open.
  const openMembers = () => props.host.openDetail({ featureId: 'members' });
  if (state.status === 'idle' || state.status === 'loading') return <p role="status">{creditCopy.loading}</p>;
  if (view.status !== 'ready') return <CreditState status={view.status} compact={props.height === 1 && props.width <= 2} retry={state.mode === 'http' ? retry : props.host.resetPreview} openMembers={openMembers} />;
  const model = view.model;
  const names = new Map(model.members.map(row => [row.memberId, row.name]));
  const displayName = (id: string) => formatMaskedCustomer(names.get(id), id, codes.get(id));
  const rows = [...model.transactions].sort((a, b) => b.at.localeCompare(a.at));
  const compact = props.width === 1 && props.height === 1;
  const longest = [number(model.chargeBalance), number(model.receivableBalance)].sort((a, b) => b.length - a.length)[0]!;
  const metrics = <div className="credit-metrics"><Metric amount={model.chargeBalance} label="총 충전금" longest={longest} />{!compact && <Metric amount={model.receivableBalance} label="총 외상" longest={longest} />}</div>;
  const tallHistory = props.width === 1 && props.height === 4;
  const history = <div className="credit-panel-history-wrap"><ul className={`credit-history credit-panel-history${tallHistory ? ' credit-panel-history--dated' : ''}`} aria-label="최근 거래 내역">{rows.slice(0, tallHistory ? RECENT_ROWS : props.height >= 3 ? 4 : props.height > 1 ? 3 : 2).map(txn => <li key={txn.txnId}><span className="credit-history-text"><span>{displayName(txn.memberId)}</span><span>{transactionLabel(txn)}</span>{tallHistory && <span className="credit-when">{when(txn.at)}</span>}</span><strong>{signedMoney(txn.amount)}</strong></li>)}</ul>{props.width === 1 && <PanelRemainder total={rows.length} rowSelector=".credit-panel-history li" unit="건" />}</div>;
  const members = model.members.filter(hasBalance);
  const latest = (row: AccountMember) => [...row.transactions].sort((a, b) => b.at.localeCompare(a.at))[0]?.at;
  const table = <div className="credit-panel-table"><Table aria-label="회원별 현황"><thead><tr><th scope="col">회원</th><th scope="col">충전금 잔액</th><th scope="col">외상 잔액</th><th scope="col" className="credit-last-column">최근 거래</th></tr></thead><tbody>{members.slice(0, props.height === 4 ? undefined : props.height >= 3 ? 6 : 4).map(row => <tr key={row.memberId}><td>{displayName(row.memberId)}</td><td>{money(row.chargeBalance)}</td><td>{money(row.receivableBalance)}</td><td className="credit-last-column">{latest(row) ? when(latest(row)!) : '—'}</td></tr>)}</tbody></Table></div>;
  // D-333: a card 4 rows high has room for the recent transactions the account holds too, each with its date (the reverse of the short cards' drop order); no transaction, no block.
  const dated = props.width >= 3 && props.height >= 4 && rows.length > 0;
  const recent = dated ? <div className="credit-panel-history-wrap credit-panel-recent"><p className="credit-label credit-history-title">최근 거래 내역</p>
    <ul className="credit-history credit-panel-history credit-panel-history--dated" aria-label="최근 거래 내역">{rows.slice(0, RECENT_ROWS).map(txn => <li key={txn.txnId}><span className="credit-history-text"><span>{displayName(txn.memberId)}</span><span>{transactionLabel(txn)}</span><span className="credit-when">{when(txn.at)}</span></span><strong>{signedMoney(txn.amount)}</strong></li>)}</ul></div> : null;
  const action = props.width >= 2 && props.height >= 2 ? <div className="credit-actions"><PanelAction label="충전하기" widgetName={creditCopy.title} onPress={() => props.host.openDetail({ featureId: props.featureId, view: 'charge_topup' })} /><PanelAction label="외상 수금하기" widgetName={creditCopy.title} onPress={() => props.host.openDetail({ featureId: props.featureId, view: 'receivable_collection' })} /></div> : undefined;
  return <PanelFrame id={props.featureId}><div lang="ko" className="credit-root credit-panel" data-width={props.width} data-height={props.height}>
    {metrics}
    {!compact && (props.width >= 3 && props.height >= 2 ? table : props.height > 1 || props.width >= 3 ? history : null)}
    {recent}
    {props.width === 2 && props.height >= 3 && <div className="credit-member-rows">{members.slice(0, 4).map(member => <div className="credit-value-row" key={member.memberId}><span>{displayName(member.memberId)}</span><strong>충전금 {money(member.chargeBalance)}</strong></div>)}</div>}
    {action}
    <FitProbe order={dated ? LARGE_FIT : SHORT_FIT} deps={[props.width, props.height, model.chargeBalance, model.receivableBalance, rows.length]} />
  </div></PanelFrame>;
}

/** 원거래 column (LinkCell): label + right chevron, the whole cell is one press target. A row without an original shows its label as plain text. */
function OriginalLink({ transaction, memberId, port, detailRef }: { readonly transaction: AccountTransaction; readonly memberId: string; readonly port: CreditPort; readonly detailRef: WidgetDetailProps['detailRef'] }) {
  const ref = useRef<HTMLButtonElement>(null);
  const label = transaction.originalLabel ?? '—';
  if (!hasOriginal(transaction)) return <>{label}</>;
  return <button ref={ref} type="button" role="link" className="ui-grid-press credit-original-link" aria-label={`${label}, 원거래 보기`}
    onClick={() => port.openOriginalTransaction(transaction, { detailRef, selectedId: memberId, returnFocusRef: ref })}><span>{label}</span><Icon name="chevron-right" /></button>;
}
/** Zero rows are worded by what emptied the list, each with the way back (A10). */
function ZeroRows({ sentence, onClearSearch, onClearKind }: { readonly sentence: string; readonly onClearSearch?: () => void; readonly onClearKind?: () => void }) {
  return <div className="ui-data-grid__noresults" lang="ko"><p>{sentence}</p>
    {onClearSearch ? <ActionButton variant="secondary" onClick={onClearSearch}>{creditCopy.clearSearch}</ActionButton> : null}
    {onClearKind ? <ActionButton variant="secondary" onClick={onClearKind}>{creditCopy.clearKind}</ActionButton> : null}</div>;
}

export function CreditDetail(props: WidgetDetailProps & CreditBinding) {
  const { view, host, detailRef } = props;
  const { port, dialog } = useMemberFunding(props.port, props.products, host);
  const state = useDomainState('members'), retry = useRealRetry('members');
  const { realMembers, memberProfile } = useWidgetDataStore().getSnapshot().tables;
  const profiles = realMembers?.profiles;
  const memberCodes = new Map(memberProfile.map(row => [row.memberId, row.memberCode]));
  const displayId = (memberId: string, name?: string) => memberDisplayId(memberId, memberCodes.get(memberId), profiles?.[memberId]?.name ?? name);
  const displayName = (memberId: string, name?: string, separator?: string) => formatMaskedCustomer(profiles?.[memberId]?.name ?? name, memberId, memberCodes.get(memberId), separator);
  const t = useI18n();
  const when = (at: string) => t.format.dateTime(props.today ? memberDateTime(at) : at, { today: props.today ?? TODAY });
  const [entry] = useState(() => creditDetailEntry(detailRef));
  const [tab, setTab] = useState<Tab>(entry.tab), [query, setQuery] = useState(''), [kind, setKind] = useState<AccountTransaction['kind'] | 'all'>('all');
  const [selected, setSelected] = useState<string | null>(entry.memberId ?? null), [focus, setFocus] = useState<GridFocus>(null);
  const grid = useRef<DataGridHandle>(null), searchBar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (detailRef.focus === 'action' && !entry.memberId) searchBar.current?.querySelector('input')?.focus({ preventScroll: true });
  }, [detailRef.focus, entry.memberId]);
  const model = view.status === 'ready' ? view.model : null;
  const q = query.trim().toLocaleLowerCase();
  const members = holdersFirst(model?.members.filter(row => !q || (profiles?.[row.memberId]?.name ?? row.name).toLocaleLowerCase().includes(q) || displayName(row.memberId, row.name).includes(q) || displayId(row.memberId, row.name).toLocaleLowerCase().includes(q) || row.memberId.toLocaleLowerCase().includes(q) || row.phone.replace(/\D/g, '').slice(-4).includes(q)) ?? []);
  const ids = new Set(members.map(row => row.memberId));
  const txns = model?.transactions.filter(txn => ids.has(txn.memberId) && (tab === 'members' || txn.account === tab) && (kind === 'all' || txn.kind === kind)).slice().sort((a, b) => b.at.localeCompare(a.at) || b.txnId.localeCompare(a.txnId)) ?? [];
  const selectedMember = members.find(row => row.memberId === selected || row.memberId === txns.find(txn => txn.txnId === selected)?.memberId);
  const { root, obscured } = useSideGrid(!!selectedMember, JSON.stringify([tab, query, selected, view]));
  const nameOf = (memberId: string) => displayName(memberId, model?.members.find(member => member.memberId === memberId)?.name);
  const memberColumns: GridColumn<AccountMember>[] = [
    { id: 'memberId', header: '회원 ID', kind: 'text', minWidth, value: row => displayId(row.memberId, row.name) || '—' },
    { id: 'name', header: '이름', kind: 'text', minWidth, value: row => formatMaskedCustomer(row.name) },
    { id: 'charge', header: '충전금 잔액', kind: 'number', minWidth, value: row => money(row.chargeBalance) },
    { id: 'debt', header: '외상 잔액(미수금)', kind: 'number', minWidth, value: row => money(row.receivableBalance) },
  ];
  const historyColumns: GridColumn<AccountTransaction>[] = [
    { id: 'at', header: '거래 시각', kind: 'text', minWidth, value: row => when(row.at) },
    { id: 'name', header: '회원', kind: 'text', minWidth, value: row => nameOf(row.memberId) },
    { id: 'kind', header: '거래 종류', kind: 'status', minWidth, value: transactionLabel },
    { id: 'amount', header: '금액', kind: 'number', minWidth, value: row => signedMoney(row.amount) },
    { id: 'original', header: '원거래', kind: 'link', minWidth, value: row => row.originalLabel ?? '—', accessibleValue: row => hasOriginal(row) ? `${row.originalLabel ?? '—'}, 원거래 보기` : row.originalLabel ?? '—',
      render: row => <OriginalLink transaction={row} memberId={row.memberId} port={port} detailRef={detailRef} /> },
  ];
  if (state.status === 'idle' || state.status === 'loading') return <p role="status">{creditCopy.loading}</p>;
  if (!model) return <CreditState status={view.status === 'empty' ? 'empty' : 'error'} detail retry={state.mode === 'http' ? retry : host.resetPreview} openMembers={() => host.openLinked({ featureId: 'members' })} />;
  const kindOptions = [
    { value: 'all' as const, label: '전체' },
    ...(tab === 'charge' ? [{ value: 'topup' as const, label: '충전' }, { value: 'use' as const, label: '충전금 사용' }]
      : [{ value: 'sale' as const, label: '외상 발생' }, { value: 'collection' as const, label: '외상 수금' }]),
    { value: 'reversal' as const, label: '취소·환불' }, { value: 'adjustment' as const, label: '조정' },
  ];
  const clearSearch = () => { setQuery(''); setSelected(null); queueMicrotask(() => searchBar.current?.querySelector('input')?.focus({ preventScroll: true })); };
  const clearKind = () => { setKind('all'); setSelected(null); };
  const filtered = tab !== 'members' && kind !== 'all';
  const zeroRows = <ZeroRows
    sentence={q ? creditCopy.noSearch : filtered ? noKindRows(kindOptions.find(option => option.value === kind)?.label ?? '') : tab === 'charge' ? creditCopy.noChargeRows : tab === 'receivable' ? creditCopy.noReceivableRows : creditCopy.empty}
    onClearSearch={q ? clearSearch : undefined} onClearKind={filtered ? clearKind : undefined} />;
  return <div ref={root} className="credit-detail mc-workspace" data-widget={props.featureId} lang="ko">
    {state.status === 'stale' ? <p role="status">최근 거래를 불러오지 못했어요 <ActionButton variant="ghost" onClick={retry}>다시 시도하기</ActionButton></p> : null}
    {!state.complete ? <p role="status">거래 내역을 일부만 불러왔어요</p> : null}
    <DetailTabs label="충전금·외상 보기" value={tab} onValueChange={value => { setTab(value); setKind('all'); setSelected(null); setFocus(null); }} tabs={tabs} />
    <div ref={searchBar} className="ui-data-grid__toolbar credit-search">
      <SearchField label={creditCopy.search} hideLabel placeholder={creditCopy.search} clearLabel={creditCopy.clearSearch} name="member-account-search" value={query} onValueChange={value => { setQuery(value); setSelected(null); }} />
    </div>
    <SummaryCards items={[{ label: '총 충전금 · 유효기간 없음', amount: model.chargeBalance }, { label: '총 외상(미수금)', amount: model.receivableBalance }]} />
    {tab !== 'members' && <ChipChoice label="거래 종류" value={kind} onChange={value => { setKind(value); setSelected(null); }} options={kindOptions} />}
    {tab === 'members' ? <DataGrid key="credit-members" ref={grid} id="credit-members" label="회원별 현황" rows={members} columns={memberColumns} getRowId={row => row.memberId} getRowLabel={row => displayName(row.memberId, row.name)} sort={null} onSortChange={() => {}} selectedRowId={selected} onSelectionChange={setSelected} focus={focus} onFocusChange={setFocus} expandedRowIds={new Set()} obscuredCells={obscured} emptyContent={zeroRows} />
      : <DataGrid key={`credit-history-${tab}`} ref={grid} id="credit-history" label={tab === 'charge' ? '충전금 내역' : '외상·수금 내역'} rows={txns} columns={historyColumns} getRowId={row => row.txnId} getRowLabel={row => `${nameOf(row.memberId)} ${transactionLabel(row)}`} sort={null} onSortChange={() => {}} selectedRowId={selected} onSelectionChange={setSelected} focus={focus} onFocusChange={setFocus} expandedRowIds={new Set()} obscuredCells={obscured} emptyContent={zeroRows} />}
    <DetailSidePanel open={!!selectedMember} selectedRowId={selected} title={selectedMember ? displayName(selectedMember.memberId, selectedMember.name, '\n') : '회원별 현황'} onClose={() => setSelected(null)} returnFocusKey={selected ?? ''} onRestoreFocus={key => restoreGrid(grid, key, tab === 'members' ? 'memberId' : 'at', tab === 'members' ? members.map(row => row.memberId) : txns.map(row => row.txnId))}>
      {selectedMember && <div className="credit-stack" key={selectedMember.memberId}>
        <p>{maskedPhone(selectedMember.phone)}</p>
        <SummaryCards items={[{ label: '충전금 잔액 · 유효기간 없음', amount: selectedMember.chargeBalance }, { label: '외상 잔액(미수금)', amount: selectedMember.receivableBalance }]} />
        <AccountActions member={selectedMember} port={port} detailRef={detailRef} initialPurpose={entry.purpose}
          initialAmount={selectedMember.memberId === entry.memberId ? entry.amount : null}
          focusAmount={detailRef.focus === 'action' && selectedMember.memberId === entry.memberId} />
        <h4>최근 거래 내역</h4><ul className="credit-history">{[...selectedMember.transactions].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10).map(txn => <li key={txn.txnId}><span>{when(txn.at)} · {transactionLabel(txn)} · {signedMoney(txn.amount)}</span><OriginalTransactionButton transaction={txn} memberId={selectedMember.memberId} port={port} detailRef={detailRef} /></li>)}</ul>
        {!selectedMember.transactions.length && <p>{creditCopy.empty}</p>}
      </div>}
    </DetailSidePanel>
    {dialog}
  </div>;
}
