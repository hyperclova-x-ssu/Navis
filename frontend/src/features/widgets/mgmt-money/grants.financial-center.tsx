import { useCallback, useEffect, useState } from 'react';
import type { PortTransport } from '../../../data/reality/00';
import { readFundingDetail, readFundingList } from '../../../data/reality/11/financial-center';
import { useRealPort } from '../../../data/react';
import { InlineError, StatusChip } from '../../../ui';
import { useGrantsCopy } from './grants.copy';
import { useMoneyT } from './shared';
import { noticeDay, noticeStamp } from './grants.dates';

function useFundingRead<T>(read: (transport: PortTransport, signal: AbortSignal) => Promise<T>) {
  const port = useRealPort();
  const [value, setValue] = useState<T>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!port) return;
    const controller = new AbortController();
    const { signal } = controller;
    void read(port.transport, signal).then(
      result => { if (!signal.aborted) setValue(result); },
      () => { if (!signal.aborted) setFailed(true); },
    );
    return () => controller.abort();
  }, [port, read, attempt]);
  return { value, failed, retry: () => { setFailed(false); setAttempt(value => value + 1); } };
}

export function FinancialCenterRecommendations({ selected, onSelect }: {
  readonly selected?: string;
  readonly onSelect: (ref: string) => void;
}) {
  const { t } = useGrantsCopy();
  const { value: list, failed, retry } = useFundingRead(readFundingList);
  return (
    <section aria-label={t('funding.title')} data-slot="grants.financial-center">
      {failed ? <InlineError message={t('funding.error')} onRetry={retry} />
        : !list ? <p role="status">{t('funding.loading')}</p>
        : list.state === 'not-connected' ? <p>{t('funding.disconnected')}</p>
        : !list.items.length ? <p>{t('funding.empty')}</p>
        : <ul className="mm-select-list">
          {[...list.items].sort((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed')).map(row => <li key={row.ref}>
            <button type="button" className="mm-select-row" aria-pressed={selected === row.ref} onClick={() => onSelect(row.ref)}>
              <span className="mm-select-row__text"><strong>{row.title}</strong><span>{t('funding.source')}</span></span>
              {row.status === 'closed' && <StatusChip semantic="none">{t('funding.closed')}</StatusChip>}
            </button>
          </li>)}
        </ul>}
    </section>
  );
}

export function FundingNotice({ refId }: { readonly refId: string }) {
  const { t } = useGrantsCopy();
  const { format } = useMoneyT();
  const read = useCallback((transport: PortTransport, signal: AbortSignal) => readFundingDetail(transport, refId, signal), [refId]);
  const { value: detail, failed, retry } = useFundingRead(read);
  if (failed) return <InlineError message={t('funding.error')} onRetry={retry} />;
  if (!detail) return <p role="status">{t('funding.loading')}</p>;
  return (
    <div className="mm-item" data-slot="grants.financial-center.detail">
      <h3 className="mm-card__title">{detail.title}</h3>
      <p className="mm-muted">{t('funding.source')} {detail.status === 'closed' && <StatusChip semantic="none">{t('funding.closed')}</StatusChip>}</p>
      <p>{detail.overview}</p>
      <dl className="mm-dl mm-grant-facts">
        {detail.startDate && <div><dt>{t('grants.start')}</dt><dd>{noticeDay(format, detail.startDate)}</dd></div>}
        {detail.endDate && <div><dt>{t('funding.end')}</dt><dd>{noticeDay(format, detail.endDate)}</dd></div>}
        <div><dt>{t('grants.target')}</dt><dd>{detail.eligibility}</dd></div>
        <div><dt>{t('grants.method')}</dt><dd>{detail.applicationMethod}</dd></div>
        {!!detail.documents?.length && <div><dt>{t('funding.documents')}</dt><dd><ul className="mm-bullets">{detail.documents.map(document => <li key={document}>{document}</li>)}</ul></dd></div>}
        <div><dt>{t('funding.basis')}</dt><dd><time dateTime={detail.asOf}>{noticeStamp(format, detail.asOf)}</time></dd></div>
      </dl>
      <div className="mm-actions">
        <a className="ui-button ui-button--secondary ui-button--default" href={detail.officialNoticeUrl} target="_blank" rel="noopener noreferrer">
          <span className="ui-press-surface">{t('funding.open')}</span>
        </a>
      </div>
    </div>
  );
}
