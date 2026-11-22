import { useCallback, useRef, useState } from 'react';
import { PortError } from '../../../data/reality/00/port';
import { projectNaverOrderStatus, type NaverOrder, type NaverPosRemote, type NaverTransition } from '../../../data/reality/02/naver';
import { useBundle } from '../../../i18n';
import { ActionButton, AnchoredPopover, ChipChoice, NumberField, type GridAction } from '../../../ui';
import type { ComposerNotice } from '../Composer';
import { useNaverRead } from './useNaverRead';
import { naverBundle } from './naver-copy';
import { naverRowBundle } from './naver-row-copy';

interface Attempt { action: NaverTransition; revision: number; key: string }
const QUICK_MINUTES = [5, 10, 15, 20] as const;

export function useNaverOrders(remote: NaverPosRemote | undefined, notify: (notice: ComposerNotice) => void) {
  const { t } = useBundle(naverBundle, naverRowBundle);
  const [cursor, setCursor] = useState<string>();
  const [pending, setPending] = useState<ReadonlyMap<string, Attempt>>(new Map());
  const [busyId, setBusyId] = useState<string>();
  const [failed, setFailed] = useState(false);
  const [prepare, setPrepare] = useState<NaverOrder>();
  const [minutes, setMinutes] = useState<number | null>(null);
  const anchor = useRef<HTMLElement | null>(null);
  const inFlight = useRef(false);
  const load = useCallback((signal: AbortSignal) => remote!.orders(cursor, signal), [remote, cursor]);
  const { result: fresh, error, refresh } = useNaverRead(remote ? load : undefined);
  const [kept, setKept] = useState({ remote, result: fresh });
  if (kept.remote !== remote || fresh && fresh !== kept.result) setKept({ remote, result: fresh });
  const connected = !!remote && error?.reason !== 'NAVER_NOT_CONNECTED';
  const result = connected ? fresh ?? (kept.remote === remote ? kept.result : undefined) : undefined;
  const rows = (result?.items ?? []).map(projectNaverOrderStatus);
  const valid = minutes !== null && Number.isInteger(minutes) && minutes > 0 && minutes <= 2147483647;

  const recordAttempt = (id: string, attempt?: Attempt) => setPending(current => {
    const next = new Map(current);
    if (attempt) next.set(id, attempt);
    else next.delete(id);
    return next;
  });
  async function confirm(id: string, attempt: Attempt) {
    if (!remote || inFlight.current) return;
    inFlight.current = true;
    recordAttempt(id, attempt);
    setBusyId(id);
    setFailed(false);
    setPrepare(undefined);
    try {
      await remote.transition(id, attempt.action, attempt.revision, attempt.key);
      recordAttempt(id);
      notify({ message: t(attempt.action.kind === 'prepare' ? 'prepareDone' : 'pickupDone', { id }) });
    } catch (failure) {
      // Keep the exact attempt when the service could have committed before the connection ended.
      if (!(failure instanceof PortError && failure.outcomeUnknown)) {
        recordAttempt(id);
        setFailed(true);
      }
    } finally {
      inFlight.current = false;
      setBusyId(undefined);
      refresh();
    }
  }

  const actions = (order: NaverOrder): GridAction[] => {
    const prior = pending.get(order.orderNumber);
    const disabled = !!busyId || (!fresh && !error);
    if (prior && busyId !== order.orderNumber) return [{ id: 'naver.retry', label: t('retry'), disabled, onPress: () => void confirm(order.orderNumber, prior) }];
    if (order.actions.prepare) return [{ id: 'naver.prepare', label: t('prepare'), disabled, onPress: () => { setMinutes(null); setPrepare(order); } }];
    if (order.actions.pickup) return [{ id: 'naver.pickup', label: t('pickup'), disabled, onPress: () => void confirm(order.orderNumber, { action: { kind: 'pickup' }, revision: order.revision, key: crypto.randomUUID() }) }];
    return [];
  };

  return {
    rows, actions, anchor,
    paging: connected && (cursor || result?.nextCursor) ? <div className="order-status__tools">
      {cursor && <ActionButton variant="secondary" disabled={!!busyId} onClick={() => setCursor(undefined)}>{t('back')}</ActionButton>}
      {result?.nextCursor && <ActionButton variant="secondary" disabled={!!busyId || !fresh} onClick={() => setCursor(result.nextCursor ?? undefined)}>{t('more')}</ActionButton>}
    </div> : null,
    feedback: connected ? <>
      {error && <p role="alert">{t('failed')} <ActionButton onClick={refresh}>{t('retry')}</ActionButton></p>}
      {!error && !result && <p role="status">{t('loading')}</p>}
      {result?.status === 'partial' && <p>{t('partial')}</p>}
      {busyId && <p role="status">{t('pending')}</p>}
      {failed && <p role="alert">{t('actionFailed')}</p>}
      {!busyId && pending.size > 0 && <p role="alert">{t('uncertain')}</p>}
    </> : null,
    popover: prepare ? <AnchoredPopover open anchorRef={anchor} side="bottom" focusOnOpen label={t('prepare')} onClose={() => setPrepare(undefined)}>
      <div className="pos-naver__prepare">
        <NumberField label={t('minutes')} name="naver-preparation-minutes" min={1} max={2147483647} value={minutes} onValueChange={setMinutes} error={minutes !== null && !valid ? t('badMinutes') : undefined}/>
        <ChipChoice label={t('naver.quickLabel')} value={QUICK_MINUTES.some(q => q === minutes) ? String(minutes) : ''} onChange={value => setMinutes(Number(value))}
          options={QUICK_MINUTES.map(q => ({ value: String(q), label: t('naver.quick', { n: q }) }))}/>
        <div className="pos-naver__prepare-actions">
          <ActionButton variant="ghost" onClick={() => setPrepare(undefined)}>{t('close')}</ActionButton>
          <ActionButton size="primary" disabled={!valid} onClick={() => { if (valid) void confirm(prepare.orderNumber, { action: { kind: 'prepare', preparationMinutes: minutes }, revision: prepare.revision, key: crypto.randomUUID() }); }}>{valid ? t('naver.startWith', { n: minutes }) : t('prepare')}</ActionButton>
        </div>
      </div>
    </AnchoredPopover> : null,
  };
}
