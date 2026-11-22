/**
 * SCR-271 WORKS team schedule (PN11 · AC-1611, one way, GAPUI-CAL). The Navis roster stays the source: a shift is sent to the team calendar
 * the server links to the owner, changed there with the same event, or removed there (second press; the Navis shift stays). Only the card's
 * primary button reaches the server. The fifth tab lists what this account sent, 31 days at a time. HTTP mode only.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useRealPort, useWidgetDataStore } from '../../../data/react';
import type { Staff, StaffSchedule } from '../../../data/widget-data';
import { staffLocalTimestamp } from '../../../data/iteration7/staff/clock';
import { exportReasonBundle, exportReasonKey } from '../../../data/reality/07/export-copy';
import { exportOutcome, listWorksExports, worksExportChanged, type WorksListItem, type WorksTime } from '../../../data/reality/07/naver';
import { useExportCard } from '../../../data/reality/07/use-export-card';
import { addDays } from '../../../data/db/time';
import { useBundle, useI18n } from '../../../i18n';
import { ActionButton, DateStepper, Icon, InlineEmpty, Table } from '../../../ui';

export const worksBundle = {
  id: 'widget.staff-schedule.works',
  ko: {
    'works.heading': 'WORKS 팀 일정', 'works.tab': 'WORKS로 보낸 일정',
    'works.create': 'WORKS로 보내기', 'works.update': 'WORKS 일정 고치기', 'works.delete': 'WORKS에서 지우기',
    'works.deleteNote': 'WORKS 일정만 지우고 Navis 근무는 그대로예요', 'works.confirmDelete': '지우기 확인하기',
    'works.sent': 'WORKS에 보냄', 'works.sentAt': 'WORKS에 보냄 · {date} {time}',
    'works.done.create': 'WORKS에 보냈어요', 'works.done.update': 'WORKS 일정을 고쳤어요', 'works.done.delete': 'WORKS에서 지웠어요',
    'works.failed': '보내지 못했어요 · {reason}', 'works.unknown': '보낸 결과를 확인해 주세요', 'works.check': '결과 확인하기',
    'works.stale': '그사이 근무가 바뀌었어요. 새로 불러온 내용을 확인해 주세요', 'works.reopen': '다시 확인하기',
    'works.staff': '직원', 'works.date': '날짜', 'works.time': '시간', 'works.destination': '받는 곳', 'works.team': '선택한 팀 캘린더',
    'works.sentColumn': '보낸 시각', 'works.off': '직원 휴무', 'works.allDay': '종일', 'works.sending': '보내고 있어요', 'works.close': '닫기',
    'works.loading': 'WORKS 일정을 불러오는 중이에요', 'works.loadFailed': 'WORKS 일정을 불러오지 못했어요', 'works.retry': '다시 시도하기',
    'works.empty': '아직 WORKS로 보낸 일정이 없어요', 'works.oneWay': 'WORKS에서 고친 내용은 Navis로 돌아오지 않아요',
  },
  en: {
    'works.heading': 'WORKS team schedule', 'works.tab': 'Sent to WORKS',
    'works.create': 'Send to WORKS', 'works.update': 'Update in WORKS', 'works.delete': 'Remove from WORKS',
    'works.deleteNote': 'Only the WORKS event is removed. The Navis shift stays', 'works.confirmDelete': 'Confirm removal',
    'works.sent': 'Sent to WORKS', 'works.sentAt': 'Sent to WORKS · {date} {time}',
    'works.done.create': 'Sent to WORKS', 'works.done.update': 'Updated in WORKS', 'works.done.delete': 'Removed from WORKS',
    'works.failed': "Couldn't send · {reason}", 'works.unknown': 'Please check the send result', 'works.check': 'Check result',
    'works.stale': 'This shift changed. Check the updated details', 'works.reopen': 'Check again',
    'works.staff': 'Staff', 'works.date': 'Date', 'works.time': 'Time', 'works.destination': 'Goes to', 'works.team': 'Selected team calendar',
    'works.sentColumn': 'Sent at', 'works.off': 'Day off', 'works.allDay': 'All day', 'works.sending': 'Sending', 'works.close': 'Close',
    'works.loading': 'Loading WORKS schedule', 'works.loadFailed': "Couldn't load the WORKS schedule", 'works.retry': 'Try again',
    'works.empty': 'Nothing has been sent to WORKS yet', 'works.oneWay': 'Changes made in WORKS do not come back to Navis',
  },
  'zh-Hans': {
    'works.heading': 'WORKS 团队日程', 'works.tab': '已发送到 WORKS 的日程',
    'works.create': '发送到 WORKS', 'works.update': '更新 WORKS 日程', 'works.delete': '从 WORKS 删除',
    'works.deleteNote': '只删除 WORKS 日程，Navis 班次保持不变', 'works.confirmDelete': '确认删除',
    'works.sent': '已发送到 WORKS', 'works.sentAt': '已发送到 WORKS · {date} {time}',
    'works.done.create': '已发送到 WORKS', 'works.done.update': '已更新 WORKS 日程', 'works.done.delete': '已从 WORKS 删除',
    'works.failed': '未能发送 · {reason}', 'works.unknown': '请确认发送结果', 'works.check': '确认结果',
    'works.stale': '班次已有变化，请确认最新内容', 'works.reopen': '重新确认',
    'works.staff': '员工', 'works.date': '日期', 'works.time': '时间', 'works.destination': '发送到', 'works.team': '所选团队日历',
    'works.sentColumn': '发送时间', 'works.off': '员工休息', 'works.allDay': '全天', 'works.sending': '正在发送', 'works.close': '关闭',
    'works.loading': '正在加载 WORKS 日程', 'works.loadFailed': '无法加载 WORKS 日程', 'works.retry': '再试一次',
    'works.empty': '还没有发送到 WORKS 的日程', 'works.oneWay': '在 WORKS 中的修改不会同步回 Navis',
  },
  'zh-Hant': {
    'works.heading': 'WORKS 團隊行程', 'works.tab': '已傳送到 WORKS 的行程',
    'works.create': '傳送到 WORKS', 'works.update': '更新 WORKS 行程', 'works.delete': '從 WORKS 刪除',
    'works.deleteNote': '只刪除 WORKS 行程，Navis 班次維持不變', 'works.confirmDelete': '確認刪除',
    'works.sent': '已傳送到 WORKS', 'works.sentAt': '已傳送到 WORKS · {date} {time}',
    'works.done.create': '已傳送到 WORKS', 'works.done.update': '已更新 WORKS 行程', 'works.done.delete': '已從 WORKS 刪除',
    'works.failed': '未能傳送 · {reason}', 'works.unknown': '請確認傳送結果', 'works.check': '確認結果',
    'works.stale': '班次已有變更，請確認最新內容', 'works.reopen': '重新確認',
    'works.staff': '員工', 'works.date': '日期', 'works.time': '時間', 'works.destination': '傳送到', 'works.team': '所選團隊行事曆',
    'works.sentColumn': '傳送時間', 'works.off': '員工休假', 'works.allDay': '全天', 'works.sending': '正在傳送', 'works.close': '關閉',
    'works.loading': '正在載入 WORKS 行程', 'works.loadFailed': '無法載入 WORKS 行程', 'works.retry': '再試一次',
    'works.empty': '還沒有傳送到 WORKS 的行程', 'works.oneWay': '在 WORKS 中的修改不會同步回 Navis',
  },
} as const;

type ListState = { readonly status: 'loading' } | { readonly status: 'error'; readonly reason: string } | { readonly status: 'ready'; readonly items: readonly WorksListItem[] };

/** This owner's WORKS exports for 31 days from `startDate` (store-local). A read failure is shown as such, never as an empty list. */
export function useWorksList(startDate: string, enabled = true) {
  const port = useRealPort();
  const [version, setVersion] = useState(0);
  const key = `${startDate}|${version}`;
  /** The answer for one window and reload; any other key is still loading, so an old window never shows under a new heading. */
  const [result, setResult] = useState<{ readonly key: string; readonly state: ListState }>();
  useEffect(() => {
    if (!port || !enabled) return;
    const controller = new AbortController();
    listWorksExports(port.transport, startDate, controller.signal).then(
      list => { if (!controller.signal.aborted) setResult({ key, state: { status: 'ready', items: Array.isArray(list?.items) ? list.items : [] } }); },
      error => {
        if (controller.signal.aborted) return;
        const outcome = exportOutcome(error, false);
        setResult({ key, state: { status: 'error', reason: outcome.kind === 'failed' ? outcome.reason : 'UNKNOWN' } });
      },
    );
    return () => controller.abort();
  }, [port, enabled, startDate, key]);
  const reload = useCallback(() => setVersion(value => value + 1), []);
  const state: ListState = result?.key === key ? result.state : { status: 'loading' };
  return { state, reload };
}

function useTables() {
  const store = useWidgetDataStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot).tables;
}

const timeText = (start: WorksTime, end: WorksTime | undefined) =>
  'dateTime' in start ? `${start.dateTime.slice(11, 16)}~${end && 'dateTime' in end ? end.dateTime.slice(11, 16) : ''}` : null;
const shiftTime = (shift: StaffSchedule) => shift.kind === 'work' && shift.start && shift.end ? `${shift.start}~${shift.end}` : null;

type Operation = 'works.create' | 'works.update' | 'works.delete';
type Summary = { readonly staff: string; readonly date: string; readonly time: string | null; readonly operation: Operation };

/** The `WORKS 팀 일정` area under an existing shift in the right side panel. */
export function WorksShiftSection({ row }: { readonly row: StaffSchedule }) {
  const port = useRealPort();
  const { t } = useBundle(worksBundle, exportReasonBundle);
  const { format } = useI18n();
  const tables = useTables();
  const headingId = useId();
  const shift = tables.staffSchedule.find(item => item.scheduleId === row.scheduleId) ?? row;
  const person: Staff | undefined = tables.staff.find(item => item.staffId === shift.staffId);
  const enabled = port?.state('staff').mode === 'http';
  const list = useWorksList(shift.date, enabled);
  const [summary, setSummary] = useState<Summary>();
  const card = useExportCard({ onDone: list.reload });
  const phase = card.state?.phase;
  useEffect(() => { if (phase === 'stale') void port?.retry('staff'); }, [phase, port]);
  if (!enabled) return null;

  const sent = list.state.status === 'ready' ? list.state.items.find(item => item.scheduleId === shift.scheduleId) : undefined;
  const changed = !!sent && !!person && worksExportChanged(sent, shift, person.name);
  const open = (operation: Operation) => {
    const current = shift;
    const owner = person;
    if (typeof current.revision !== 'number' || (operation !== 'works.delete' && typeof owner?.revision !== 'number')) return;
    setSummary({ staff: owner?.name ?? '', date: format.date(current.date, 'short'), time: shiftTime(current), operation });
    card.open({
      operation, resourceId: current.scheduleId, expectedRevision: current.revision,
      ...(operation !== 'works.delete' ? { expectedStaffRevision: owner!.revision } : {}),
    });
  };
  const busy = phase === 'sending' || phase === 'confirm';
  let status: ReactNode;
  if (list.state.status === 'loading') status = <p role="status" className="staff-works__status">{t('works.loading')}</p>;
  else if (list.state.status === 'error') {
    status = list.state.reason === 'WORKS_CALENDAR_REQUIRED' || list.state.reason === 'SESSION_ENDED'
      ? <p className="staff-works__status">{t(exportReasonKey(list.state.reason))}</p>
      : <div className="staff-works__status"><p role="alert">{t('works.loadFailed')}</p><ActionButton variant="secondary" onClick={list.reload}>{t('works.retry')}</ActionButton></div>;
  } else if (sent) {
    const at = sent.sentAt ? staffLocalTimestamp(sent.sentAt) : undefined;
    status = <>
      <p className="staff-works__status">{at ? t('works.sentAt', { date: format.date(at.date, 'short'), time: format.time(at.time) }) : t('works.sent')}</p>
      <div className="staff-works__actions">
        {changed ? <ActionButton variant="secondary" disabled={busy} onClick={() => open('works.update')}>{t('works.update')}</ActionButton> : null}
        <ActionButton variant="ghost" className="staff-works__delete" disabled={busy} onClick={() => open('works.delete')}>{t('works.delete')}</ActionButton>
      </div>
    </>;
  } else if (!(phase === 'done' && summary?.operation === 'works.delete')) {
    status = <div className="staff-works__actions"><ActionButton variant="secondary" disabled={busy} onClick={() => open('works.create')}>{t('works.create')}</ActionButton></div>;
  }
  return <section className="staff-works" aria-labelledby={headingId}>
    <h3 id={headingId} className="staff-works__title">{t('works.heading')}</h3>
    {status}
    {card.state && summary ? <WorksReview card={card} summary={summary} onReopen={() => open(summary.operation)} /> : null}
  </section>;
}

function WorksReview({ card, summary, onReopen }: { readonly card: ReturnType<typeof useExportCard>; readonly summary: Summary; readonly onReopen: () => void }) {
  const { t } = useBundle(worksBundle, exportReasonBundle);
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const state = card.state!;
  const attempt = state.card.attemptKey;
  useLayoutEffect(() => { heading.current?.focus(); }, [attempt]);
  const { phase } = state;
  const sending = phase === 'sending';
  const remove = summary.operation === 'works.delete';
  let line: ReactNode = null;
  if (sending) line = <p className="ui-confirm-step__status" role="status">{t('works.sending')}</p>;
  else if (phase === 'done' && 'operation' in state.receipt) {
    line = <p className="ui-confirm-step__status" role="status"><Icon name="check" />{t(`works.done.${state.receipt.operation}`)}</p>;
  } else if (phase === 'review' && state.error) line = <p className="staff-error" role="alert"><Icon name="error" />{t('works.failed', { reason: t(exportReasonKey(state.error)) })}</p>;
  else if (phase === 'unknown') line = <p className="staff-error" role="alert"><Icon name="error" />{t('works.unknown')}</p>;
  else if (phase === 'stale') line = <p className="staff-error" role="alert"><Icon name="error" />{t('works.stale')}</p>;
  const label = t(summary.operation === 'works.create' ? 'works.create' : summary.operation === 'works.update' ? 'works.update' : 'works.delete');
  const press = () => void card.press();
  const primary = phase === 'done' ? null
    : phase === 'stale' ? <ActionButton size="primary" onClick={onReopen}>{t('works.reopen')}</ActionButton>
      : phase === 'unknown' ? <ActionButton size="primary" onClick={press}>{t('works.check')}</ActionButton>
        : phase === 'confirm' ? <ActionButton size="primary" variant="destructive" onClick={press}>{t('works.confirmDelete')}</ActionButton>
          : <ActionButton size="primary" variant={remove ? 'destructive' : 'default'} loading={sending} disabled={sending} onClick={press}>{label}</ActionButton>;
  return <section className="ui-confirm-step" aria-labelledby={titleId} data-esc-layer="">
    <h4 id={titleId} ref={heading} tabIndex={-1} className="ui-confirm-step__title">{label}</h4>
    <dl className="ui-confirm-step__summary">
      <div><dt>{t('works.staff')}</dt><dd>{summary.staff}</dd></div>
      <div><dt>{t('works.date')}</dt><dd>{summary.date}</dd></div>
      <div><dt>{t('works.time')}</dt><dd>{summary.time ?? t('works.off')}</dd></div>
      <div><dt>{t('works.destination')}</dt><dd>{t('works.team')}</dd></div>
    </dl>
    {remove ? <p className="staff-works__note">{t('works.deleteNote')}</p> : null}
    {line}
    <div className="ui-confirm-step__actions">
      {primary}
      <ActionButton variant="secondary" data-esc-close="" disabled={sending} onClick={card.close}>{t('works.close')}</ActionButton>
    </div>
  </section>;
}

/** The fifth tab: what this account sent to the team calendar, 31 days at a time, read-only. */
export function WorksSentTab({ today }: { readonly today: string }) {
  const { t } = useBundle(worksBundle, exportReasonBundle);
  const { format } = useI18n();
  const tables = useTables();
  const [start, setStart] = useState(today);
  const list = useWorksList(start, useRealPort()?.state('staff').mode === 'http');
  const captionId = useId();
  const nameOf = (item: WorksListItem) => {
    const staffId = tables.staffSchedule.find(row => row.scheduleId === item.scheduleId)?.staffId;
    return tables.staff.find(person => person.staffId === staffId)?.name ?? item.summary.replace(/ (근무|휴무)$/, '');
  };
  const dateOf = (time: WorksTime) => 'date' in time ? time.date : time.dateTime.slice(0, 10);
  const sentOf = (item: WorksListItem) => {
    if (!item.sentAt) return '—';
    const at = staffLocalTimestamp(item.sentAt);
    return format.dateTime(`${at.date}T${at.time}`);
  };
  const period = `${format.date(start, 'short')} ~ ${format.date(addDays(start, 30), 'short')}`;
  let body: ReactNode;
  if (list.state.status === 'loading') body = <p role="status" className="staff-empty">{t('works.loading')}</p>;
  else if (list.state.status === 'error') {
    body = list.state.reason === 'WORKS_CALENDAR_REQUIRED' || list.state.reason === 'SESSION_ENDED'
      ? <p className="staff-empty">{t(exportReasonKey(list.state.reason))}</p>
      : <div className="staff-empty"><p role="alert">{t('works.loadFailed')}</p><ActionButton variant="secondary" onClick={list.reload}>{t('works.retry')}</ActionButton></div>;
  } else if (!list.state.items.length) body = <div className="staff-history-empty"><InlineEmpty title={t('works.empty')} /></div>;
  else {
    const rows = [...list.state.items].sort((a, b) => dateOf(a.start).localeCompare(dateOf(b.start)) || a.scheduleId.localeCompare(b.scheduleId));
    body = <Table className="staff-history" aria-label={t('works.tab')} aria-describedby={captionId}>
      <thead><tr><th>{t('works.staff')}</th><th>{t('works.date')}</th><th>{t('works.time')}</th><th>{t('works.sentColumn')}</th></tr></thead>
      <tbody>{rows.map(item => <tr key={item.eventId}>
        <td>{nameOf(item)}</td><td>{format.date(dateOf(item.start), 'short')}</td>
        <td>{timeText(item.start, item.end) ?? (/휴무$/.test(item.summary) ? t('works.off') : t('works.allDay'))}</td><td>{sentOf(item)}</td>
      </tr>)}</tbody>
    </Table>;
  }
  return <div className="staff-works-tab">
    <div className="staff-toolbar"><div className="staff-toolbar__view">
      <DateStepper text={period} onPrevious={() => setStart(addDays(start, -31))} onNext={() => setStart(addDays(start, 31))} />
    </div></div>
    <p id={captionId} className="staff-works__note">{t('works.oneWay')}</p>
    {body}
  </div>;
}
