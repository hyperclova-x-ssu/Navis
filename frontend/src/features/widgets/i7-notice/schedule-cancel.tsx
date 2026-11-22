import { useId, useRef, useState } from 'react';
import { dataBundle } from '../../../data/messages';
import { useBundle } from '../../../i18n';
import { ActionButton, InlineForm } from '../../../ui';

export function NoticeScheduleCancel({ available, cancel }: {
  available: boolean;
  cancel(): boolean | Promise<boolean>;
}) {
  const { t } = useBundle(dataBundle);
  const trigger = useRef<HTMLButtonElement>(null);
  const locked = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState('');
  const formId = useId();
  const confirm = async () => {
    if (locked.current || !available) return;
    locked.current = true;
    setPending(true);
    try {
      const ok = await cancel();
      setConfirming(false);
      setFeedback(t(ok ? 'data.notices.notice.scheduleCancelled' : 'data.notices.error.SCHEDULE_NOT_CANCELLABLE'));
    } finally {
      locked.current = false;
      setPending(false);
    }
  };
  return <>
    {available && <ActionButton ref={trigger} variant="secondary" aria-expanded={confirming} aria-controls={confirming ? formId : undefined}
      onClick={() => { setFeedback(''); setConfirming(true); }}>{t('data.notices.schedule.cancel')}</ActionButton>}
    {available && confirming && <div id={formId}>
      <InlineForm title={t('data.notices.schedule.confirm')} saveLabel={t('data.notices.schedule.cancel')} closeLabel={t('common.back')}
        returnFocusRef={trigger} saving={pending} onClose={() => setConfirming(false)} onSave={() => void confirm()}>{null}</InlineForm>
    </div>}
    {feedback && <p role="status">{feedback}</p>}
  </>;
}
