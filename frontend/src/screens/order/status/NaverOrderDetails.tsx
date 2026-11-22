import { useCallback, useState } from 'react';
import type { PosProviderLinks } from '../../../data/reality/02/dto';
import type { NaverPosRemote } from '../../../data/reality/02/naver';
import { useBundle } from '../../../i18n';
import { ActionButton, PosMoney, PosStatusChip, posClasses } from '../../../ui';
import { naverBundle } from './naver-copy';
import { useNaverRead } from './useNaverRead';
import type { NpayRead } from './useNaverOrders';

export function NaverOrderDetails({ links, remote, settlement }: { links: PosProviderLinks; remote?: NaverPosRemote; settlement?: NpayRead }) {
  const { t, locale } = useBundle(naverBundle);
  const { source, naverPayPaymentId, smartstoreProductOrderId } = links;
  return <>
    {(source === 'naver' || source === 'connect' || naverPayPaymentId) && <section lang={locale}>
      <h4>{t('npayPayment')}</h4>
      {naverPayPaymentId
        ? remote
          ? <NpayDetails key={naverPayPaymentId} remote={remote} paymentId={naverPayPaymentId} firstPage={settlement}/>
          : <p>{t('unavailable')}</p>
        : <p>{t(source === 'connect' ? 'terminalSettlementUnavailable' : 'paymentUnlinked')}</p>}
    </section>}
    {smartstoreProductOrderId && <section lang={locale}>
      <h4>{t('commerce')}</h4>
      {remote ? <SmartStoreDetails remote={remote} productOrderId={smartstoreProductOrderId}/> : <p>{t('unavailable')}</p>}
    </section>}
  </>;
}

function NpayDetails({ remote, paymentId, firstPage }: { remote: NaverPosRemote; paymentId: string; firstPage?: NpayRead }) {
  const { t, format } = useBundle(naverBundle);
  const [page, setPage] = useState({ number: 1, total: 1 });
  const load = useCallback((signal: AbortSignal) => remote.settlement('payments', paymentId, page.number, signal), [remote, paymentId, page.number]);
  const [retryFirstPage, setRetryFirstPage] = useState(false);
  const cached = page.number === 1 && !retryFirstPage ? firstPage : undefined;
  const { result: loaded, error: loadError, refresh } = useNaverRead(cached ? undefined : load);
  const result = cached?.status === 'ready' ? cached.data : loaded;
  const error = cached?.status === 'error' || !!loadError;
  const total = result?.page.totalPageCount ?? page.total;
  const approval = result?.items.find(row => row.kind === 'approval');

  return <>
    <div aria-live="polite">
      {error ? <p>{t('settlementFailed')}</p> : !result ? <p>{t('loading')}</p> : <>
        {!result.items.length && <p>{t('noSettlement')}</p>}
        {result.items.map(row => {
          const partial = row.kind === 'cancellation' && approval && Math.abs(row.paySettleAmount) < approval.paySettleAmount;
          const status = row.kind === 'approval' ? t('paymentApproved') : row.kind === 'cancellation'
            ? partial ? t('paymentPartiallyCanceled', { amount: format.money(row.paySettleAmount, 'full').replace(/^-/, '−') }) : t('paymentCanceled')
            : null;
          const settledAt = row.status === 'settled'
            ? row.settleCompleteDate.match(/^(\d{4})-?(\d{2})-?(\d{2})$/u)?.slice(1).join('-') : undefined;
          return <section key={row.payHistId} className="order-status__npay-record">
            {row.kind === 'cancellation' && <h5>{status}</h5>}
            <dl className={posClasses.receipt}>
              {status && row.kind !== 'cancellation' && <div><dt>{t('paymentStatus')}</dt><dd>{status}</dd></div>}
              <div><dt>{t('paySettleAmount')}</dt><dd><PosMoney amount={row.paySettleAmount}/></dd></div>
              <div><dt>{t('settleType')}</dt><dd lang="ko">{row.settleType}</dd></div>
              {settledAt && <>
                <div><dt>{t('settleCompleteDate')}</dt><dd><time dateTime={settledAt}>{format.date(settledAt, 'short')}</time></dd></div>
                <div><dt>{t('totalCommissionAmount')}</dt><dd><PosMoney amount={row.totalCommissionAmount} sign={row.totalCommissionAmount > 0 ? 'plus' : undefined}/></dd></div>
              </>}
            </dl>
            {!settledAt && <p>{t('noSettlement')}</p>}
          </section>;
        })}
      </>}
    </div>
    {error && <ActionButton variant="secondary" onClick={() => cached ? setRetryFirstPage(true) : refresh()}>{t('retry')}</ActionButton>}
    {total > 1 && <div className={posClasses.summaryRow}>
      <ActionButton variant="secondary" disabled={page.number === 1} onClick={() => setPage({ number: page.number - 1, total })}>{t('prevPage')}</ActionButton>
      <span>{t('page', { n: page.number })}</span>
      <ActionButton variant="secondary" disabled={page.number >= total} onClick={() => setPage({ number: page.number + 1, total })}>{t('nextPage')}</ActionButton>
    </div>}
  </>;
}

function SmartStoreDetails({ remote, productOrderId }: { remote: NaverPosRemote; productOrderId: string }) {
  const { t } = useBundle(naverBundle);
  const load = useCallback((signal: AbortSignal) => remote.smartStore([productOrderId], signal), [remote, productOrderId]);
  const { result, error, refresh } = useNaverRead(load);
  const status = result?.items.find(row => row.productOrderId === productOrderId)?.productOrderStatus;
  return <>
    <div aria-live="polite">
      {error ? <p>{t('commerceFailed')}</p> : !result ? <p>{t('loading')}</p> : <dl className={posClasses.receipt}>
        <div><dt>{t('productOrderId')}</dt><dd translate="no">{productOrderId}</dd></div>
        <div><dt>{t('paymentStatus')}</dt><dd>{status
          ? <PosStatusChip semantic="none">{Object.hasOwn(naverBundle.ko, status) ? t(status as keyof typeof naverBundle.ko) : status}</PosStatusChip>
          : t('unavailable')}</dd></div>
      </dl>}
    </div>
    {error && <ActionButton variant="secondary" onClick={refresh}>{t('retry')}</ActionButton>}
  </>;
}
