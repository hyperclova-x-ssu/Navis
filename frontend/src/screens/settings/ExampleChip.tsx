import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import type { RunStore } from '../../contracts';
import { useBundle } from '../../i18n';
import { ActionButton, ExampleStateChip, Icon, useKitT } from '../../ui';
import { shellBundle } from './messages';
import { posBundle } from '../../i18n/messages/pos';
import { openSettingsAt } from './start-view';

/**
 * Header chip of the sample-state selection (SCR-29, DS 11.4): shown only when the family is not normal or any widget has its own pick.
 * Pressing it opens settings on the 예시 상태 보기 screen. Screens that have a header (dashboard, coming-soon) mount it left of the mode button.
 */
/**
 * K-E 8: the header's title and date are centred on the page, so a chip to the left of the mode button used to run over the date. The slot reports where
 * the chip starts (`--example-chip-left`, in untransformed canvas pixels, on the app root) so dashboard.css can end the title block before it; the date shrinks with an ellipsis.
 */
function ChipSlot({ children }: { readonly children: ReactNode }) {
  const slot = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const node = slot.current, root = node?.closest<HTMLElement>('.ui-root') ?? null;
    if (!node || !root) return;
    const apply = () => {
      const box = root.getBoundingClientRect(), chip = node.getBoundingClientRect(), scale = root.offsetWidth ? box.width / root.offsetWidth : 1;
      root.dataset.exampleChip = 'true';
      root.style.setProperty('--example-chip-left', `${(chip.left - box.left) / scale}px`);
    };
    apply();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply);
    resize?.observe(node); if (node.parentElement) resize?.observe(node.parentElement);
    return () => { resize?.disconnect(); delete root.dataset.exampleChip; root.style.removeProperty('--example-chip-left'); };
  }, []);
  return <span ref={slot} className="app-example-chip-slot">{children}</span>;
}
export function ExampleStateChipForRun({ run }: { readonly run: RunStore }) {
  const preview = useSyncExternalStore(run.subscribe, () => run.getState().preview);
  const { t } = useBundle(shellBundle, posBundle);
  const kit = useKitT();
  const picks = Object.keys(preview.overrides).length;
  const open = () => openSettingsAt(run, 'preview');
  if (preview.pos && preview.pos !== 'normal') return <ChipSlot><span lang="ko"><ExampleStateChip state={t(preview.pos==='payment-failure'?'pos.paymentFailure':`preview.family.${preview.pos}`)} onPress={open}/></span></ChipSlot>;
  if (picks > 0) {
    const text = t('preview.family.byWidgetChip', { n: picks });
    return <ChipSlot><ActionButton variant="ghost" className="ui-example-chip" aria-label={`${text}. ${kit.t('ui.example.chipOpen')}`} onClick={open}><Icon name="info" />{text}</ActionButton></ChipSlot>;
  }
  if (preview.family === 'normal') return null;
  return <ChipSlot><ExampleStateChip state={t(`preview.family.${preview.family}`)} onPress={open} /></ChipSlot>;
}
