import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import { useKitT } from '../kit-i18n';
import { FieldFrame, describeField } from './forms';
import { PickerField } from './picker-field';
import { isTimeString, timeSlots } from './date-grid';
import './kit-controls.css';

export interface TimeFieldProps {
  readonly label: string;
  /** `HH:MM` (24 hour, store-local), or null while nothing is chosen. */
  readonly value: string | null;
  readonly onValueChange: (value: string | null) => void;
  /** Minutes between the listed times (default 30). A value off the grid is still listed so it can be seen and kept. */
  readonly step?: number;
  readonly min?: string;
  readonly max?: string;
  readonly placeholder?: string;
  readonly error?: string;
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly id?: string;
  readonly name?: string;
  readonly className?: string;
  /** Tests only: render the browser's own time input instead of the popover list. Never use it on a screen. */
  readonly native?: boolean;
}

/**
 * DS 11.4 TimeField (K-C, G-17): a 48-high text-like button showing `HH:MM` that opens a list of times (a listbox of 48 high options).
 * Down opens; in the list Up/Down/Home/End move, Enter or Space picks, Esc closes and focus returns to the field.
 */
export function TimeField({ label, value, onValueChange, step = 30, min, max, placeholder, error, hint, disabled, required, id, name, className, native = false }: TimeFieldProps) {
  const { t, format } = useKitT();
  const generated = useId(); const fieldId = id ?? generated;
  if (native) {
    return (
      <FieldFrame label={label} error={error} hint={hint} id={fieldId} className={className} fieldId={fieldId}>
        <input id={fieldId} name={name} className="ui-text-input" type="time" step={step * 60} value={value ?? ''} min={min} max={max} disabled={disabled} required={required} aria-invalid={error ? true : undefined} aria-describedby={describeField(fieldId, error, hint)} onChange={event => onValueChange(event.currentTarget.value || null)} />
      </FieldFrame>
    );
  }
  const shown = isTimeString(value) ? value : null;
  const slots = timeSlots(step, min, max);
  const options = shown && !slots.includes(shown) ? [...slots, shown].sort() : slots;
  return (
    <PickerField
      label={label} id={fieldId} icon="clock" display={shown ? format.time(shown) : placeholder ?? t('ui.timeField.pick')} empty={!shown}
      popoverLabel={t('ui.timeField.pick')} error={error} hint={hint} disabled={disabled} required={required} name={name} value={shown ?? ''} className={className}
    >
      {({ close }) => <TimeList label={label} options={options} value={shown} onPick={next => { onValueChange(next); close('select'); }} />}
    </PickerField>
  );
}

/** The list body of TimeField: roving focus, 48-high options, the chosen time marked and scrolled into view. */
export function TimeList({ label, options, value, onPick }: { readonly label: string; readonly options: readonly string[]; readonly value: string | null; readonly onPick: (time: string) => void }) {
  const list = useRef<HTMLDivElement>(null);
  const current = value && options.includes(value) ? value : options[0];
  useEffect(() => {
    const target = list.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]');
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: 'center' });
  }, []);
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...list.current!.querySelectorAll<HTMLButtonElement>('button[role="option"]')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? index + 1 : event.key === 'ArrowUp' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    const target = buttons[Math.max(0, Math.min(buttons.length - 1, next))];
    for (const button of buttons) button.tabIndex = button === target ? 0 : -1;
    target?.focus();
  };
  return (
    <div ref={list} className="ui-time-list" role="listbox" aria-label={label} onKeyDown={move}>
      {options.map(time => <button key={time} type="button" role="option" className="ui-time-list__option" aria-selected={time === value} tabIndex={time === current ? 0 : -1} onClick={() => onPick(time)}>{time}</button>)}
    </div>
  );
}
