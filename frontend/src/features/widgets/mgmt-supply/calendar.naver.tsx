/**
 * SCR-224 `[네이버에 일정 추가하기]` (PN11 · AC-1590 · AC-1611, one way, GAPUI-CAL). One direct event at a time goes to the owner's NAVER
 * Calendar default calendar through a confirm step; only the card's primary button reaches the server (approval, then the export with the
 * approval as its key). Sending the same event again changes the one NAVER event (`네이버 일정을 고쳤어요`). Nothing comes back from NAVER:
 * the Navis calendar stays the source, and the ICS download beside it is unchanged. HTTP mode only, like the ICS download.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { CalendarEvent } from '../../../data/db/types';
import { useRealPort } from '../../../data/react';
import { staffLocalTimestamp } from '../../../data/iteration7/staff/clock';
import { exportReasonBundle, exportReasonKey } from '../../../data/reality/07/export-copy';
import { readCalendarExport, type CalendarPushReceipt } from '../../../data/reality/07/naver';
import { useExportCard } from '../../../data/reality/07/use-export-card';
import { useBundle } from '../../../i18n';
import { ActionButton, Icon } from '../../../ui';
import { useSupplyText } from './shared';

const bundle = {
  id: 'widget.calendar.naver',
  ko: {
    'naver.add': '네이버에 일정 추가하기',
    'naver.pickOne': '직접 추가한 일정 하나를 골라 주세요',
    'naver.destination': '네이버 캘린더 기본 캘린더에 넣어요',
    'naver.title': '일정 제목', 'naver.when': '날짜와 시간', 'naver.memo': '일정 내용', 'naver.noMemo': '없음',
    'naver.sending': '보내고 있어요',
    'naver.added': '네이버에 추가했어요',
    'naver.modified': '네이버 일정을 고쳤어요',
    'naver.failed': '추가하지 못했어요 · {reason}',
    'naver.unknown': '보낸 결과를 확인해 주세요',
    'naver.check': '결과 확인하기',
    'naver.stale': '그사이 일정이 바뀌었어요. 새로 불러온 내용을 확인해 주세요',
    'naver.reopen': '다시 확인하기',
    'naver.sent': '네이버에 보냄 · {date} {time}',
    'naver.close': '닫기',
  },
  en: {
    'naver.add': 'Add to Naver Calendar',
    'naver.pickOne': 'Choose one event you added yourself',
    'naver.destination': 'Goes to your default Naver calendar',
    'naver.title': 'Title', 'naver.when': 'Date and time', 'naver.memo': 'Details', 'naver.noMemo': 'None',
    'naver.sending': 'Sending',
    'naver.added': 'Added to Naver',
    'naver.modified': 'Updated the Naver event',
    'naver.failed': "Couldn't add · {reason}",
    'naver.unknown': 'Please check the send result',
    'naver.check': 'Check result',
    'naver.stale': 'This event changed. Check the updated details',
    'naver.reopen': 'Check again',
    'naver.sent': 'Sent to Naver · {date} {time}',
    'naver.close': 'Close',
  },
  'zh-Hans': {
    'naver.add': '添加到 Naver 日历',
    'naver.pickOne': '请选择一条自己添加的日程',
    'naver.destination': '将添加到 Naver 日历的默认日历',
    'naver.title': '日程标题', 'naver.when': '日期和时间', 'naver.memo': '日程内容', 'naver.noMemo': '无',
    'naver.sending': '正在发送',
    'naver.added': '已添加到 Naver',
    'naver.modified': '已更新 Naver 日程',
    'naver.failed': '未能添加 · {reason}',
    'naver.unknown': '请确认发送结果',
    'naver.check': '确认结果',
    'naver.stale': '日程已有变化，请确认最新内容',
    'naver.reopen': '重新确认',
    'naver.sent': '已发送到 Naver · {date} {time}',
    'naver.close': '关闭',
  },
  'zh-Hant': {
    'naver.add': '新增到 Naver 行事曆',
    'naver.pickOne': '請選擇一筆自己新增的行程',
    'naver.destination': '將新增到 Naver 行事曆的預設行事曆',
    'naver.title': '行程標題', 'naver.when': '日期和時間', 'naver.memo': '行程內容', 'naver.noMemo': '無',
    'naver.sending': '正在傳送',
    'naver.added': '已新增到 Naver',
    'naver.modified': '已更新 Naver 行程',
    'naver.failed': '未能新增 · {reason}',
    'naver.unknown': '請確認傳送結果',
    'naver.check': '確認結果',
    'naver.stale': '行程已有變更，請確認最新內容',
    'naver.reopen': '重新確認',
    'naver.sent': '已傳送到 Naver · {date} {time}',
    'naver.close': '關閉',
  },
} as const;

type Summary = { readonly title: string; readonly when: string; readonly memo: string | null };

/** The direct event a card may send: an event (not a to-do) the owner added, with its server revision. */
export const naverEligible = (event: CalendarEvent | undefined): event is CalendarEvent & { readonly revision: number } =>
  !!event && event.kind === 'event' && typeof event.revision === 'number';

/**
 * State for the toolbar button, the confirm step and the `네이버에 보냄` row line. The receipt of the selected event is read when it is
 * selected (one read per event per open window) and replaced by the card's own receipt after a send.
 */
export function useCalendarNaver(selected: CalendarEvent | undefined) {
  const port = useRealPort();
  const enabled = port?.state('staff').mode === 'http';
  const x = useSupplyText();
  const [receipts, setReceipts] = useState<ReadonlyMap<string, CalendarPushReceipt | null>>(new Map());
  const [summary, setSummary] = useState<Summary>();
  const card = useExportCard({
    onDone: receipt => {
      if ('processType' in receipt) setReceipts(map => new Map(map).set(receipt.eventId, receipt));
    },
  });
  const selectedId = enabled && naverEligible(selected) ? selected.eventId : undefined;
  const known = selectedId !== undefined && receipts.has(selectedId);
  useEffect(() => {
    if (!port || !selectedId || known) return;
    const controller = new AbortController();
    readCalendarExport(port.transport, selectedId, controller.signal).then(
      result => { if (!controller.signal.aborted) setReceipts(map => new Map(map).set(selectedId, result.receipt ?? null)); },
      () => undefined,
    );
    return () => controller.abort();
  }, [port, selectedId, known]);
  const phase = card.state?.phase;
  useEffect(() => {
    // The record changed under the card: read it again so the refreshed card carries the current revision.
    if (phase === 'stale') void port?.retry('staff');
  }, [phase, port]);

  const describe = (event: CalendarEvent): Summary => ({
    title: x.text(event.title),
    when: `${x.format.date(event.date, 'long')} ${event.time ? x.format.time(event.time) : x.t('widget.calendar.allDay')}`,
    memo: event.memo ? x.text(event.memo) || null : null,
  });
  const open = (event: CalendarEvent | undefined) => {
    if (!naverEligible(event)) return;
    setSummary(describe(event));
    card.open({ operation: 'calendar.add', resourceId: event.eventId, expectedRevision: event.revision });
  };
  return { enabled, eligible: naverEligible(selected), receipts, summary, card, open: () => open(selected), reopen: open };
}

type Controller = ReturnType<typeof useCalendarNaver>;

export function CalendarNaverButton({ naver }: { readonly naver: Controller }) {
  const { t } = useBundle(bundle);
  const hint = useId();
  if (!naver.enabled) return null;
  const busy = naver.card.state?.phase === 'sending';
  return <>
    <ActionButton variant="secondary" disabled={!naver.eligible || busy} aria-describedby={naver.eligible ? undefined : hint}
      onClick={naver.open}>{t('naver.add')}</ActionButton>
    {naver.eligible ? null : <span id={hint} className="ms-caption">{t('naver.pickOne')}</span>}
  </>;
}

/** `네이버에 보냄 · {날짜} {시각}` under a selected direct event that has a receipt. */
export function CalendarNaverSent({ naver, eventId }: { readonly naver: Controller; readonly eventId: string }) {
  const { t } = useBundle(bundle);
  const x = useSupplyText();
  const receipt = naver.receipts.get(eventId);
  if (!naver.enabled || !receipt) return null;
  const sent = staffLocalTimestamp(receipt.sentAt);
  return <p className="ms-caption" data-naver-sent="">{t('naver.sent', { date: x.format.date(sent.date, 'short'), time: x.format.time(sent.time) })}</p>;
}

/** The confirm step (DS 11.9.4 ConfirmStep layout): what goes, where it goes, one primary press. */
export function CalendarNaverReview({ naver, current }: { readonly naver: Controller; readonly current: (eventId: string) => CalendarEvent | undefined }) {
  const { t } = useBundle(bundle, exportReasonBundle);
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const state = naver.card.state;
  const attempt = state?.card.attemptKey;
  useLayoutEffect(() => { if (attempt) heading.current?.focus(); }, [attempt]);
  if (!naver.enabled || !state || !naver.summary) return null;
  const { phase } = state;
  const sending = phase === 'sending';
  let line: ReactNode = null;
  if (sending) line = <p className="ui-confirm-step__status" role="status">{t('naver.sending')}</p>;
  else if (phase === 'done' && 'processType' in state.receipt) {
    line = <p className="ui-confirm-step__status" role="status"><Icon name="check" />{t(state.receipt.processType === 'modify' ? 'naver.modified' : 'naver.added')}</p>;
  } else if (phase === 'review' && state.error) line = <p className="ms-error" role="alert"><Icon name="error" />{t('naver.failed', { reason: t(exportReasonKey(state.error)) })}</p>;
  else if (phase === 'unknown') line = <p className="ms-error" role="alert"><Icon name="error" />{t('naver.unknown')}</p>;
  else if (phase === 'stale') line = <p className="ms-error" role="alert"><Icon name="error" />{t('naver.stale')}</p>;
  const primary = phase === 'done' ? null
    : phase === 'stale' ? <ActionButton size="primary" onClick={() => naver.reopen(current(state.card.resourceId))}>{t('naver.reopen')}</ActionButton>
      : <ActionButton size="primary" loading={sending} disabled={sending} onClick={() => void naver.card.press()}>
        {phase === 'unknown' ? t('naver.check') : t('naver.add')}</ActionButton>;
  return <section className="ui-confirm-step" aria-labelledby={titleId} data-esc-layer="" data-naver-review="">
    <h3 id={titleId} ref={heading} tabIndex={-1} className="ui-confirm-step__title">{t('naver.add')}</h3>
    <dl className="ui-confirm-step__summary">
      <div><dt>{t('naver.title')}</dt><dd>{naver.summary.title}</dd></div>
      <div><dt>{t('naver.when')}</dt><dd>{naver.summary.when}</dd></div>
      <div><dt>{t('naver.memo')}</dt><dd>{naver.summary.memo ?? t('naver.noMemo')}</dd></div>
    </dl>
    <p className="ms-caption">{t('naver.destination')}</p>
    {line}
    <div className="ui-confirm-step__actions">
      {primary}
      <ActionButton variant="secondary" data-esc-close="" disabled={sending} onClick={naver.card.close}>{t('naver.close')}</ActionButton>
    </div>
  </section>;
}
