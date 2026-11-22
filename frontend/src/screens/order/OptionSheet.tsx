import { useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import type { PosCatalogItem, PosOption, PosOptionGroup } from '../../contracts/pos';
import { ActionButton, ChipChoice, Icon, PosDialog, PosMoney, PosStatusChip, TextField, formatPosMoney } from '../../ui';
import { activeOptions, objectParticle, optionCaption, optionDelta, optionLabel, orderedOptions } from './option-text';

export interface OptionSheetPrices { readonly base: number; readonly option: number; readonly unit: number }
export interface OptionSheetProps {
  readonly open: boolean;
  readonly item: PosCatalogItem | null;
  /** True when a cart line is being edited: the same picker, plus 요청사항, [빼기] and [바꾸기]. */
  readonly editing: boolean;
  readonly selected: readonly string[];
  readonly request: string;
  readonly requestLimit: boolean;
  /** Required groups the staff still has to choose from. */
  readonly missingGroups: readonly PosOptionGroup[];
  readonly prices: OptionSheetPrices | null;
  readonly returnFocusRef: RefObject<HTMLElement | null>;
  /** Unique prefix for element ids (Composer's useId). */
  readonly idPrefix: string;
  readonly onChoose: (group: PosOptionGroup, option: PosOption) => void;
  readonly onRequest: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onRemove: () => void;
  readonly onClose: () => void;
}

/** Optional groups: any number of choices. Same chip look as the required groups; arrow keys move focus, Space toggles. */
function ToggleGroup({ label, options, selected, onToggle }: {
  readonly label: string; readonly options: readonly PosOption[]; readonly selected: readonly string[]; readonly onToggle: (option: PosOption) => void;
}) {
  const [active, setActive] = useState<string | undefined>();
  const target = options.some(option => option.optionId === active) ? active : (options.find(option => selected.includes(option.optionId)) ?? options[0]).optionId;
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    buttons[(index + step + buttons.length) % buttons.length]?.focus();
  };
  return <div role="group" aria-label={label} className="order-option__chips" onKeyDown={move}>
    {options.map(option => {
      const on = selected.includes(option.optionId);
      return <button key={option.optionId} type="button" role="checkbox" aria-checked={on} tabIndex={target === option.optionId ? 0 : -1}
        className="ui-choice-chip order-option__chip" onFocus={() => setActive(option.optionId)} onClick={() => onToggle(option)}>
        <span>{option.name}</span>{' '}{option.extraPrice ? <small className="order-option__delta">{optionDelta(option)}</small> : <span className="ui-sr-only">추가 금액 없음</span>}
        {on ? <Icon name="check" aria-hidden="true"/> : null}
      </button>;
    })}
  </div>;
}

/** SCR-242 옵션 창. A new line starts without selected options. */
export function OptionSheet({ open, item, editing, selected, request, requestLimit, missingGroups, prices, returnFocusRef, idPrefix, onChoose, onRequest, onSubmit, onRemove, onClose }: OptionSheetProps) {
  const body = useRef<HTMLDivElement | null>(null);
  // Focus the chosen option of the first group (or the first chip) once the sheet has mounted its content.
  const initialFocus = useMemo(() => ({ get current() {
    const group = body.current?.querySelector('.order-option__group');
    return group?.querySelector<HTMLElement>('[aria-checked="true"]')
      ?? group?.querySelector<HTMLElement>('[role="radio"], [role="checkbox"]') ?? null;
  } }), []);
  const groups = item?.groups.filter(group => group.required || activeOptions(group).length) ?? [];
  const picked = item ? optionCaption(orderedOptions(item, groups.flatMap(activeOptions).filter(option => selected.includes(option.optionId)))) : '';
  const hintId = (group: PosOptionGroup) => `${idPrefix}-option-hint-${group.groupId}`;
  return <PosDialog open={open} title={item ? `${item.name}${groups.length ? ' 옵션' : ''}` : '옵션'} kind="option" returnFocusRef={returnFocusRef} initialFocusRef={initialFocus} onClose={onClose}
    footer={item && prices ? <div className="order-option__footer">
      <div role="group" aria-label="합계" className="order-option__total">
        {picked ? <span className="order-option__picked">{picked}</span> : null}
        <span className="order-option__sum">{`기본 ${formatPosMoney(prices.base)}${prices.option ? ` + 옵션 ${formatPosMoney(prices.option)}` : ''}`}</span>
        <PosMoney className="order-option__amount" size="control" amount={prices.unit} aria-live="polite" aria-atomic="true"/>
      </div>
      <div className="order-option__actions">
        {editing ? <ActionButton variant="ghost" onClick={onRemove}>빼기</ActionButton> : null}
        <ActionButton size="primary" disabled={missingGroups.length > 0} aria-describedby={missingGroups.map(hintId).join(' ') || undefined} onClick={onSubmit}>{editing ? '바꾸기' : '담기'}</ActionButton>
      </div>
    </div> : null}>
    {item ? <div ref={body} className="order-option">
      {groups.map(group => {
        const options = activeOptions(group);
        const missing = missingGroups.includes(group);
        return <section key={group.groupId} className="order-option__group" data-required={group.required || undefined}>
          <h3 className="order-option__title"><span>{group.name}</span><span className="order-option__kind"><PosStatusChip semantic="none">{group.required ? '필수' : '선택'}</PosStatusChip></span></h3>
          {group.required
            ? <div className="order-option__single"><ChipChoice label={group.name} value={options.find(option => selected.includes(option.optionId))?.optionId ?? ''}
              options={options.map(option => ({ value: option.optionId, label: optionLabel(option) }))}
              onChange={id => { const option = options.find(candidate => candidate.optionId === id); if (option) onChoose(group, option); }}/></div>
            : <ToggleGroup label={group.name} options={options} selected={selected} onToggle={option => onChoose(group, option)}/>}
          {missing ? <p id={hintId(group)} className="order-option__hint">{options.length ? `${group.name}${objectParticle(group.name)} 골라 주세요` : '고를 수 있는 옵션이 없어요'}</p> : null}
        </section>;
      })}
      {editing ? <TextField name="line-request" label="요청사항" placeholder="예: 샷 연하게" value={request} onValueChange={onRequest} hint={`${[...request].length}/100`} error={requestLimit ? '100자까지 쓸 수 있어요' : undefined}/> : null}
    </div> : null}
  </PosDialog>;
}
