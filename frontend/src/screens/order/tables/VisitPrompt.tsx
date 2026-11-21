import { dataBundles } from '../../../data/widget-data';
import { useBundle } from '../../../i18n';
import { posBundle } from '../../../i18n/messages/pos';
import { usePosSnapshot } from '../../../pos/react';
import { ActionButton, Icon } from '../../../ui';
import type { ComposerNotice } from '../Composer';
import { useTableCommands } from './actions';

export function VisitPrompt({ onNotice }: { onNotice: (notice: ComposerNotice) => void }) {
  const read = usePosSnapshot(), { t } = useBundle(posBundle, ...dataBundles), execute = useTableCommands(onNotice);
  const prompt = read.pos.reservationPrompts.find(p => p.decision === 'pending' && read.pos.bills.some(b => b.billId === p.billId && (b.status === 'open' || b.status === 'partial')));
  const reservation = read.data.reservations?.find(r => r.reservationId === prompt?.reservationId && r.status === 'confirmed');
  if (!prompt || !reservation) return null;
  const respond = (decision: 'accept' | 'defer') => execute({ type: 'reservation.respond', reservationId: prompt.reservationId, billId: prompt.billId, decision }, decision === 'accept' ? t('pos.changed') : undefined, decision === 'accept');
  return <div className="ui-notice pos-visit-prompt" data-pos-alert-blocker lang="ko" role="status"><Icon name="calendar"/><span className="ui-notice__message">{t('pos.visitPrompt', { name: typeof reservation.name === 'string' ? reservation.name : t(reservation.name.key) })}</span><ActionButton onClick={() => respond('accept')}>{t('pos.acceptVisit')}</ActionButton><ActionButton variant="secondary" onClick={() => respond('defer')}>{t('pos.deferVisit')}</ActionButton></div>;
}
