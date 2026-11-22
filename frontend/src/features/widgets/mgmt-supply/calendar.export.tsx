import { useLayoutEffect, useRef, useState } from 'react';
import { useRealPort } from '../../../data/react';
import { useBundle } from '../../../i18n';
import { ActionButton } from '../../../ui';

const bundle = {
  id: 'widget.calendar.export',
  ko: { download: '일정 파일 받기', error: '일정 파일을 받지 못했어요. 다시 시도해 주세요' },
  en: { download: 'Download calendar file', error: 'Could not download the calendar file. Try again.' },
  'zh-Hans': { download: '下载日程文件', error: '无法下载日程文件，请重试。' },
  'zh-Hant': { download: '下載行程檔案', error: '無法下載行程檔案，請重試。' },
} as const;

/** The calendar file is the supported handoff from Navis Calendar. */
export function CalendarExport({ startDate, endDate }: { startDate: string; endDate: string }) {
  const port = useRealPort();
  const { t } = useBundle(bundle);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = useRef<AbortController | null>(null);
  useLayoutEffect(() => () => active.current?.abort(), []);
  if (!port || port.state('staff').mode !== 'http') return null;

  const download = async () => {
    if (active.current) return;
    const request = new AbortController();
    active.current = request;
    setLoading(true);
    setFailed(false);
    try {
      const file = await port.transport.request<Blob>({ method: 'GET', path: '/calendar/exports', query: { startDate, endDate },
        responseAs: 'blob', signal: request.signal });
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
    <ActionButton variant="outline" loading={loading} onClick={() => void download()}>{t('download')}</ActionButton>
    {failed ? <p role="alert" className="ms-error">{t('error')}</p> : null}
  </div>;
}
