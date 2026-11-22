import { useLayoutEffect, useRef, useState } from 'react';
import type { CalendarEntry } from '../../../data/models/types';
import { useRealPort } from '../../../data/react';
import { useBundle } from '../../../i18n';
import { ActionButton } from '../../../ui';
import { useSupplyText } from './shared';

const bundle = {
  id: 'widget.calendar.export',
  ko: { download: '일정 파일 받기', error: '일정 파일을 받지 못했어요. 다시 시도해 주세요' },
  en: { download: 'Download calendar file', error: 'Could not download the calendar file. Try again.' },
  'zh-Hans': { download: '下载日程文件', error: '无法下载日程文件，请重试。' },
  'zh-Hant': { download: '下載行程檔案', error: '無法下載行程檔案，請重試。' },
} as const;

/** The calendar file is the supported handoff from Navis Calendar. */
export function CalendarExport({ startDate, endDate, entries }: { startDate: string; endDate: string; entries: readonly CalendarEntry[] }) {
  const port = useRealPort();
  const x = useSupplyText();
  const { t } = useBundle(bundle);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = useRef<AbortController | null>(null);
  useLayoutEffect(() => () => active.current?.abort(), []);

  const download = async () => {
    if (active.current) return;
    const request = new AbortController();
    active.current = request;
    setLoading(true);
    setFailed(false);
    try {
      const file = port?.state('staff').mode === 'http'
        ? await port.transport.request<Blob>({ method: 'GET', path: '/calendar/exports', query: { startDate, endDate }, responseAs: 'blob', signal: request.signal })
        : fixtureCalendarFile(entries.filter(row => row.date >= startDate && row.date <= endDate), x.text);
      if (request.signal.aborted) return;
      if (file.type.split(';')[0] !== 'text/calendar' || file.size === 0) throw new Error('Invalid calendar download');
      const url = URL.createObjectURL(file);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `navis-calendar-${startDate}.ics`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      if (!request.signal.aborted) setFailed(true);
    } finally {
      active.current = null;
      if (!request.signal.aborted) setLoading(false);
    }
  };
  return <div>
    <ActionButton variant="secondary" loading={loading} onClick={() => void download()}>{t('download')}</ActionButton>
    {failed ? <p role="alert" className="ms-error">{t('error')}</p> : null}
  </div>;
}

function fixtureCalendarFile(entries: readonly CalendarEntry[], text: ReturnType<typeof useSupplyText>['text']) {
  const escape = (value: string) => value.replace(/\\/gu, '\\\\').replace(/\r?\n/gu, '\\n').replace(/([;,])/gu, '\\$1');
  const date = (value: string) => value.replaceAll('-', '');
  const stamp = new Date().toISOString().replace(/[-:]|\.\d{3}/gu, '');
  const lines = ['BEGIN:VCALENDAR', 'PRODID:-//Navis//Store Calendar//KO', 'VERSION:2.0', 'CALSCALE:GREGORIAN'];
  for (const entry of entries) {
    const kind = entry.kind === 'todo' ? 'VTODO' : 'VEVENT';
    const utc = entry.time ? new Date(`${entry.date}T${entry.time}:00+09:00`).toISOString().replace(/[-:]|\.\d{3}/gu, '') : null;
    lines.push(`BEGIN:${kind}`, `UID:${escape(entry.id)}@navis`, `DTSTAMP:${stamp}`,
      utc ? `DTSTART:${utc}` : `DTSTART;VALUE=DATE:${date(entry.date)}`, `SUMMARY:${escape(text(entry.title))}`);
    if (entry.memo) lines.push(`DESCRIPTION:${escape(text(entry.memo))}`);
    lines.push(`END:${kind}`);
  }
  lines.push('END:VCALENDAR');
  const encoder = new TextEncoder();
  const fold = (line: string) => {
    let column = 0, folded = '';
    for (const character of line) {
      const bytes = encoder.encode(character).length;
      if (column + bytes > 75) { folded += '\r\n '; column = 1; }
      folded += character;
      column += bytes;
    }
    return folded;
  };
  return new Blob([`${lines.map(fold).join('\r\n')}\r\n`], { type: 'text/calendar;charset=utf-8' });
}
