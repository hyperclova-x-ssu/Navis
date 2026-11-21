import { useLayoutEffect, useState, type CSSProperties } from 'react';
import { motion, useIsPresent } from 'motion/react';
import { ActionButton, Icon, motionTokens, transitionFor, useUi } from '../../../ui';
import { useBundle } from '../../../i18n';
import { posBundle } from '../../../i18n/messages/pos';
import type { OrderStatusRow } from '../../../pos/status';

/** SCR-250 / M-121: retained exits cannot announce or accept another press. */
export function MissingOrderAlert({ row, count, hasNotice, location, onOpen, onDismiss }: {
  readonly row: OrderStatusRow; readonly count: number; readonly hasNotice: boolean;
  readonly location: 'management' | 'order' | 'tables';
  readonly onOpen: () => void; readonly onDismiss: () => void;
}) {
  const present = useIsPresent(), { reducedMotion } = useUi(), { t } = useBundle(posBundle);
  const [noticeHeight, setNoticeHeight] = useState(0);
  useLayoutEffect(() => {
    const notice = document.querySelector<HTMLElement>('.app-common-notice');
    if (!hasNotice || !notice) { setNoticeHeight(0); return; }
    const measure = () => setNoticeHeight(notice.offsetHeight);
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(notice);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [hasNotice, location]);
  const offset = reducedMotion ? 0 : motionTokens.translateToast;
  // The full-canvas portal host passes pointers through; only this live surface opts in.
  return <div className="pos-missing-alert-anchor" data-location={location} data-notice={hasNotice} style={{ '--pos-alert-notice-height': `${noticeHeight}px`, pointerEvents: present ? 'auto' : 'none' } as CSSProperties}><motion.div lang="ko" className="pos-missing-alert" role={present ? 'alert' : undefined} inert={!present || undefined} aria-hidden={!present || undefined}
    initial={{ opacity: 0, transform: `translateY(${offset}px)` }} animate={{ opacity: 1, transform: 'translateY(0px)' }}
    exit={{ opacity: 0, transform: `translateY(${offset}px)`, transition: transitionFor('rowOut', reducedMotion) }} transition={transitionFor('short', reducedMotion)}>
    <Icon name="warning"/><div><h2>{t('pos.alertTitle', { n: count })}</h2><p>{t(count === 1 ? 'pos.alertItem' : 'pos.alertMore', { no: row.no, item: row.menuText, n: count === 1 ? row.elapsedMin : count - 1 })}</p></div>
    <ActionButton variant="secondary" onClick={onOpen}>{t('pos.viewOrder')}</ActionButton><ActionButton variant="ghost" onClick={onDismiss}>{t('pos.closeAlert')}</ActionButton>
  </motion.div></div>;
}
