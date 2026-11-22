import { usePublicationText } from './menu-publication-text';
import { ActionButton, Spinner } from '../../../ui';
import type { ReactNode } from 'react';

export function PublicationCard({ flow, label, children, errors, requireExtra = false }: {
  flow: { pending: boolean; uncertain: boolean; error?: string; attempt?: unknown; awaitingConfirmation: boolean; confirm(requireExtra: boolean): void; cancel(): void };
  label: string; children: ReactNode; errors?: Record<string, string>; requireExtra?: boolean;
}) {
  const t = usePublicationText();
  const extra = flow.awaitingConfirmation;
  const removing = requireExtra && extra;
  const error = flow.error;
  const reason = error === 'NO_CHANGES' ? errors?.NO_CHANGES ?? t('noChanges')
    : error === 'STALE_REVISION' || error === 'STALE_CARD' || error === 'CARD_EXPIRED' || error === 'APPROVAL_EXPIRED' || error === 'PREVIEW_EXPIRED' ? t('stale') : errors?.[error ?? ''] ?? t('failure');

  return <>
    {flow.pending && <p role="status"><Spinner /> {t('checking')}</p>}
    {error && <p role={error === 'NO_CHANGES' ? 'status' : 'alert'}>{flow.uncertain ? t('uncertain') : reason}</p>}
    {flow.attempt ? <section aria-label={label}>
      {children}
      {removing && <p role="alert">{t('removePrompt')}</p>}
      <ActionButton type="button" loading={flow.pending} variant={removing ? 'destructive' : 'default'}
        onClick={() => flow.confirm(requireExtra)}>{flow.uncertain ? t('recheck') : removing ? t('confirmRemoval') : extra ? t('confirmAction') : label}</ActionButton>
      {!flow.uncertain && <ActionButton type="button" variant="secondary" disabled={flow.pending} onClick={flow.cancel}>{t('close')}</ActionButton>}
    </section> : null}
  </>;
}

export function PublicationReadState({ failed, retry }: { failed: boolean; retry(): void }) {
  const t = usePublicationText();
  return failed
    ? <><p role="alert">{t('readError')}</p><ActionButton type="button" variant="secondary" onClick={retry}>{t('retry')}</ActionButton></>
    : <p role="status"><Spinner /> {t('loading')}</p>;
}

export function PublicationChanges({ changes }: { changes: readonly { label: string; before: string; after: string }[] }) {
  const t = usePublicationText();
  return <dl>{changes.map(({ label, before, after }) =>
    <div key={label}><dt>{label}</dt><dd>{t('before')} {before || '—'} → {t('after')} {after || '—'}</dd></div>)}</dl>;
}
