import { posMessages } from './pos-messages';

export interface PosMoneyFormat {
  readonly style?:'full'|'compact';
  /** Force the operation's sign, including −0원 in the drawer. */
  readonly sign?:'auto'|'plus'|'minus';
}
const wholeWon = new Intl.NumberFormat('ko-KR', { maximumFractionDigits:0 });
const tenthMan = new Intl.NumberFormat('ko-KR', { minimumFractionDigits:1, maximumFractionDigits:1 });

/** DS 15.6 / Q-259. Display only: callers supply integer won from the domain. */
export function formatPosMoney(won:number, { style='full', sign='auto' }:PosMoneyFormat = {}):string {
  if (!Number.isSafeInteger(won)) throw new RangeError('POS amounts must be safe integer won');
  const absolute = Math.abs(won);
  const prefix = sign==='minus'||(sign==='auto'&&won<0)?'−':sign==='plus'?'+':'';
  const compact = style==='compact'&&absolute>=10000;
  const amount = prefix+(compact?tenthMan.format(Math.round(absolute/1000)/10):wholeWon.format(absolute));
  return (compact?posMessages['ui.pos.moneyCompact']:posMessages['ui.pos.moneyFull']).replace('{amount}',amount);
}
