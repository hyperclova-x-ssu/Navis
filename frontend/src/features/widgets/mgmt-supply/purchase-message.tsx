import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PortTransport } from '../../../data/reality/00/port';
import { usePublication } from '../../../data/reality/01/use-publication';
import { useBundle, type MessageBundle } from '../../../i18n';
import { ActionButton, SegmentedControl, StatusChip } from '../../../ui';
import { PublicationCard, PublicationReadState } from '../mgmt-products/menu-publication-card';
import { exampleSupplierTransport } from './purchase-message-example';

const bundle: MessageBundle<string> = {
  id: 'gap-inv.supplier',
  ko: { action: '발주사에 발주 보내기', preview: '보낼 내용 확인하기', send: '발주 보내기', channel: '보낼 곳', sms: '문자', mail: '메일', schedule: '내일 8시', queued: '보내기 대기', dispatching: '보내고 있어요', accepted: '접수했어요', delivered: '보냈어요', failed: '보내지 못했어요', blocked: '보낼 수 없어요', unknown: '발송 결과를 확인해 주세요', verify: '발주를 받았는지는 발주사에 확인해 주세요', virtualDelivery: '시험 발송으로 기록했어요', virtualNotice: '실제로 발송하지 않았어요', noChannel: '발주사 연락처에 이 수단이 없어요', tooLong: '문자로 보내기엔 길어요. 메일로 보내 주세요', already: '이미 이 발주를 보냈어요', copy: '문구 복사하기', copied: '문구를 복사했어요', copyFailed: '문구를 복사하지 못했어요' },
  en: { action: 'Send order to supplier', preview: 'Review message', send: 'Send order', channel: 'Send via', sms: 'Text', mail: 'Email', schedule: 'Tomorrow at 8 AM', queued: 'Waiting to send', dispatching: 'Sending', accepted: 'Accepted by provider', delivered: 'Delivered', failed: 'Could not deliver', blocked: 'Sending unavailable', unknown: 'Check the delivery result', verify: 'Check with the supplier that they received the order.', virtualDelivery: 'Recorded as a test send', virtualNotice: 'No message was sent to the supplier.', noChannel: 'This contact method is missing for the supplier.', tooLong: 'The message is too long for text. Send it by email.', already: 'This order has already been sent.', copy: 'Copy message', copied: 'Message copied.', copyFailed: 'Could not copy the message.' },
  'zh-Hans': { action: '向供应商发送订单', preview: '查看发送内容', send: '发送订单', channel: '发送方式', sms: '短信', mail: '邮件', schedule: '明天上午 8 点', queued: '等待发送', dispatching: '正在发送', accepted: '服务商已受理', delivered: '已送达', failed: '发送失败', blocked: '无法发送', unknown: '请确认发送结果', verify: '请向供应商确认是否收到订单。', virtualDelivery: '已记录为测试发送', virtualNotice: '没有向供应商发送消息。', noChannel: '供应商缺少此联系方式。', tooLong: '内容超出短信长度，请改用邮件。', already: '该订单已发送。', copy: '复制内容', copied: '内容已复制。', copyFailed: '无法复制内容。' },
  'zh-Hant': { action: '向供應商傳送訂單', preview: '查看傳送內容', send: '傳送訂單', channel: '傳送方式', sms: '簡訊', mail: '郵件', schedule: '明天上午 8 點', queued: '等待傳送', dispatching: '正在傳送', accepted: '服務商已受理', delivered: '已送達', failed: '傳送失敗', blocked: '無法傳送', unknown: '請確認傳送結果', verify: '請向供應商確認是否收到訂單。', virtualDelivery: '已記錄為測試傳送', virtualNotice: '沒有向供應商傳送訊息。', noChannel: '供應商缺少此聯絡方式。', tooLong: '內容超出簡訊長度，請改用郵件。', already: '此訂單已傳送。', copy: '複製內容', copied: '內容已複製。', copyFailed: '無法複製內容。' },
};
type SupplierChannel = 'sms' | 'mail';
// Only the browser-visible fields needed to render or follow the receipt.
type SupplierMessageReceipt = {
  receiptId: string;
  channel: SupplierChannel;
  scheduledAt: string | null;
  providerMode?: 'virtual' | 'live';
  reason?: string;
  state: 'queued' | 'dispatching' | 'accepted' | 'delivered' | 'failed' | 'blocked' | 'unknown';
};
type MessageView = { supplierName: string; targetHint: string; title: string; body: string; scheduledAt: string | null };

export function SupplierMessage({ transport, scope, poId, supplierName, phone, email, sendable, copyText, beforeActions }: {
  transport?: PortTransport; scope: object; poId: string; supplierName: string; phone?: string; email?: string; sendable: boolean; copyText: string;
  beforeActions?(reviewing: boolean): ReactNode;
}) {
  const { t, locale } = useBundle(bundle);
  const [opened, setOpened] = useState(false);
  const [channel, setChannel] = useState<SupplierChannel>();
  const [copyResult, setCopyResult] = useState<'copied' | 'copyFailed'>();
  const effective = useMemo(() => transport ?? exampleSupplierTransport(scope, poId, supplierName, { sms: phone, mail: email }, copyText), [transport, scope, poId, supplierName, phone, email, copyText]);
  const channels: SupplierChannel[] = [...(phone ? ['sms' as const] : []), ...(email ? ['mail' as const] : [])];
  const flow = usePublication<{ channel: SupplierChannel }, MessageView, { items: SupplierMessageReceipt[] }, SupplierMessageReceipt>(
    effective, { path: '/inventory/purchase-orders/' + encodeURIComponent(poId) + '/supplier-message',
      operation: 'supplier.message.send', resourceId: poId },
  );
  const stored = flow.data?.items ?? [];
  const receipt = flow.receipt && !stored.some(item => item.receiptId === flow.receipt?.receiptId) ? flow.receipt : undefined;
  const receipts = receipt ? [receipt, ...stored] : stored;
  const sendingLocked = receipts.some(item => item.state !== 'failed' && item.state !== 'blocked');
  const waiting = receipts.some(item => ['queued', 'dispatching', 'accepted', 'unknown'].includes(item.state));
  const { reload } = flow;
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => { void reload(); }, 5000);
    return () => window.clearInterval(timer);
  }, [waiting, reload]);

  const current = channel && channels.includes(channel) ? channel : channels[0];
  const view = flow.attempt?.diff;
  const contactHint = (available: readonly SupplierChannel[]) => locale !== 'ko' ? t('noChannel') :
    available.length === 0 ? '문자나 메일로 보내려면 발주사 탭에서 연락처와 메일 주소를 추가해 주세요' :
    available.includes('sms') ? '메일로 보내려면 발주사 탭에 메일 주소를 추가해 주세요' :
      '문자로 보내려면 발주사 탭의 연락처 칸에 휴대폰 번호를 넣어 주세요';
  const review = sendable || flow.uncertain ? flow : { ...flow, attempt: undefined };
  const copy = async () => {
    try { await navigator.clipboard.writeText(copyText); setCopyResult('copied'); }
    catch { setCopyResult('copyFailed'); }
  };
  const formatSchedule = (at: string) => new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul',
  }).format(new Date(at));

  return <>{beforeActions?.(!!review.attempt)}<section aria-label={t('action')}>
    {(!flow.data || flow.readError) && <PublicationReadState failed={!!flow.readError} retry={() => void reload()} />}
    {receipts.length > 0 && <div role="status">
      {receipts.map(item => <p key={item.receiptId}>
        {t(item.channel)}{' · '}
        <StatusChip tone={item.state === 'delivered' ? 'success' : ['failed', 'blocked', 'unknown'].includes(item.state) ? 'warning' : 'neutral'}>
          {t(item.providerMode === 'virtual' && (item.state === 'accepted' || item.state === 'delivered') ? 'virtualDelivery' : item.state)}
        </StatusChip>
        {item.state === 'queued' && item.scheduledAt && <> · {formatSchedule(item.scheduledAt)}</>}
      </p>)}
      {receipts.some(item => item.providerMode === 'virtual') && <p>{t('virtualNotice')}</p>}
      {receipts.some(item => item.providerMode !== 'virtual' && (item.state === 'delivered' || item.state === 'accepted')) && <p>{t('verify')}</p>}
    </div>}
    {sendable && flow.data && !flow.readError && !sendingLocked && <>
      {!opened && <ActionButton type="button" variant="secondary" onClick={() => setOpened(true)}>{t('action')}</ActionButton>}
      {opened && !flow.attempt && <>
        {current && <SegmentedControl label={t('channel')} value={current} onChange={setChannel}
          options={(['sms', 'mail'] as const).map(value => ({ value, label: t(value), disabled: !channels.includes(value) }))} />}
        {channels.length < 2 && <p>{contactHint(channels)}</p>}
        <blockquote className="ms-supplier-message-preview">{copyText}</blockquote>
        {current && <ActionButton type="button" variant="secondary" disabled={flow.pending}
          onClick={() => flow.preview({ channel: current })}>{t('preview')}</ActionButton>}
      </>}
    </>}
    <PublicationCard flow={review} label={t(view?.scheduledAt ? 'schedule' : 'send')}
      errors={{ SUPPLIER_CHANNEL_UNAVAILABLE: contactHint(current ? (current === 'sms' ? ['mail'] : ['sms']) : []), SUPPLIER_MESSAGE_TOO_LONG: t('tooLong'), SUPPLIER_ORDER_ALREADY_QUEUED: t('already') }}>
      {view && <>
        <p>{view.supplierName} · {view.targetHint}</p>
        <blockquote className="ms-supplier-message-preview">{view.body}</blockquote>
        {view.scheduledAt && <p>{t('schedule')} · {formatSchedule(view.scheduledAt)}</p>}
      </>}
    </PublicationCard>
    {sendable && !flow.attempt && !sendingLocked && (flow.readError || (opened && (!current || flow.error))) &&
      <ActionButton type="button" variant="secondary" onClick={() => { void copy(); }}>{t('copy')}</ActionButton>}
    {copyResult && <p role={copyResult === 'copied' ? 'status' : 'alert'}>{t(copyResult)}</p>}
  </section></>;
}
