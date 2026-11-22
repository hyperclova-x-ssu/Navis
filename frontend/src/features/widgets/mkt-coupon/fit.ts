import { editClashElements, fitScore } from '../mgmt-money/fit';

/** Recompute from all candidates; a transient metric/font size never becomes a permanent row or description limit. */
export function fitCouponPanel(content: HTMLElement) {
  const root = content.querySelector<HTMLElement>('.mkt-panel');
  if (!root) return;
  const desc = root.querySelector<HTMLElement>('.mkt-desc');
  const candidates = Array.from(root.querySelectorAll<HTMLElement>('[data-mkt-desc-candidate]'));
  const note = root.querySelector<HTMLElement>('.mkt-note');
  const secondary = root.querySelector<HTMLElement>('.ui-panel-secondary');
  const notePart = secondary ?? note;
  const rows = Array.from(root.querySelectorAll<HTMLElement>('.mkt-rows > li'));
  for (const el of root.querySelectorAll('[data-fit-hidden]')) el.removeAttribute('data-fit-hidden');
  if (secondary && !note && !secondary.querySelector('.mkt-desc')) secondary.setAttribute('data-fit-hidden', '');
  const selectDesc = (index: number) => {
    candidates.forEach((candidate, i) => { candidate.hidden = i !== Math.min(index, candidates.length - 1); });
    desc?.toggleAttribute('data-fit-hidden', index >= candidates.length);
  };
  selectDesc(0);
  if (content.clientHeight === 0) return;
  const initial = fitScore(content);
  if (initial === 0) return;
  // A note spilling into the list, or touching a handle, is not fixed by dropping unrelated rows.
  if (note && ((secondary && secondary.scrollHeight > secondary.clientHeight + 1) || editClashElements(content).some(el => note.contains(el)))) notePart?.setAttribute('data-fit-hidden', '');
  let index = 0;
  // D-333: the rows a large card adds (`data-mkt-extra`) go first, from the end; then the small-size rows, also from the end.
  const dropOrder = [...rows.filter((row) => row.hasAttribute('data-mkt-extra')).reverse(), ...rows.filter((row) => !row.hasAttribute('data-mkt-extra')).reverse()];
  let dropped = 0;
  while (fitScore(content) > 0 && dropped < dropOrder.length - 1) dropOrder[dropped++]!.setAttribute('data-fit-hidden', '');
  while (fitScore(content) > 0 && index < candidates.length) selectDesc(++index);
  if (fitScore(content) > 0 && note) notePart?.setAttribute('data-fit-hidden', '');
  const best = fitScore(content);
  if (best >= initial) {
    for (const el of root.querySelectorAll('[data-fit-hidden]')) el.removeAttribute('data-fit-hidden');
    selectDesc(0);
    return;
  }
  // Restore every part that did not help, in priority order: rows, note, description.
  for (let i = dropped - 1; i >= 0; i--) {
    dropOrder[i]!.removeAttribute('data-fit-hidden');
    if (fitScore(content) > best) dropOrder[i]!.setAttribute('data-fit-hidden', '');
  }
  const singleSlotRow = root.dataset.widget === 'slot-coupon' && rows.filter(row => !row.hasAttribute('data-fit-hidden')).length === 1;
  if (note && !singleSlotRow) {
    notePart?.removeAttribute('data-fit-hidden');
    if (fitScore(content) > best) notePart?.setAttribute('data-fit-hidden', '');
  } else if (singleSlotRow && note) notePart?.setAttribute('data-fit-hidden', '');
  for (let i = 0; i <= index; i++) {
    selectDesc(i);
    if (fitScore(content) <= best) break;
    selectDesc(index);
  }
}
