import { ActionButton, DetailDialog } from '../../../ui';
import { useManualsCopy } from './manuals.copy';
import { useT } from './shared';

export function ManualConfirmation({ open, purpose, name, pending, error, onConfirm, onClose }: {
  open: boolean; purpose: 'publish' | 'delete'; name: string; pending?: boolean; error?: string; onConfirm: () => void; onClose: () => void;
}) {
  const t = useT();
  const copy = useManualsCopy();
  const remove = purpose === 'delete';
  return <DetailDialog open={open} dialogRole="alertdialog" title={copy.t(remove ? 'manuals.deleteQuestion' : 'manuals.publishQuestion')} onClose={onClose} closeLocked={pending} footer={
    <div className="mgmt-actions"><ActionButton variant="secondary" disabled={pending} onClick={onClose}>{t.t('common.cancel')}</ActionButton>
      <ActionButton variant={remove ? 'destructive' : 'default'} loading={pending} onClick={onConfirm}>{remove ? t.t('widget.manuals.delete') : copy.t('manuals.publish')}</ActionButton></div>
  }><p>{name}</p>{error ? <p role="alert" className="ui-field__error">{error}</p> : null}</DetailDialog>;
}
