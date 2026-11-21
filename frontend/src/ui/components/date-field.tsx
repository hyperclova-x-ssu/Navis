import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref } from 'react';
import { useKitT } from '../kit-i18n';
import { Icon } from '../icons';
import { POS_BUSINESS_DATE } from '../../pos/clock';
import { ActionButton } from './controls';
import { FieldFrame, describeField } from './forms';
import { PickerField } from './picker-field';
import { addDays, addMonths, clampIso, isDisabledDay, monthMatrix, parseIsoDate, weekHeaderDates } from './date-grid';
import './kit-controls.css';

export interface DateFieldProps {
  readonly label: string;
  /** Store-local `YYYY-MM-DD`, or null while nothing is chosen. The value is never shown as an ISO string. */
  readonly value: string | null;
  readonly onValueChange: (value: string | null) => void;
  readonly min?: string;
  readonly max?: string;
  /** Store-local today (default: the demo business date). Marks today in the calendar and feeds the 오늘 shortcut. */
  readonly today?: string;
  readonly placeholder?: string;
  readonly error?: string;
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly id?: string;
  readonly name?: string;
  readonly className?: string;
  /** Show the short date (`1/25(월)`, the same as a table cell) instead of the long one. DataGrid cell editor. */
  readonly short?: boolean;
  /** Open the calendar on mount (DataGrid cell editor). */
  readonly defaultOpen?: boolean;
  /** Receives the field's button. */
  readonly buttonRef?: Ref<HTMLButtonElement>;
  /** Show a 지우기 button in the calendar and allow the value to go back to null. */
  readonly clearable?: boolean;
  /** Tests only: render the browser's own date input instead of the popover calendar. Never use it on a screen. */
  readonly native?: boolean;
}

/**
 * DS 11.4 DateField (K-C, DS 6.1 G-25 + G-17): a 48-high text-like button that shows the long date `{M}월 {D}일 {요일}` and opens a kit
 * calendar popover. Keyboard: Down opens; in the calendar arrows move a day or a week, Home/End the week edges, PageUp/PageDown a month
 * (with Shift a year), Enter or Space picks, Esc closes and focus returns to the field.
 */
export function DateField({ label, value, onValueChange, min, max, today = POS_BUSINESS_DATE, placeholder, error, hint, disabled, required, id, name, className, clearable = false, native = false, short = false, defaultOpen = false, buttonRef }: DateFieldProps) {
  const { t, format } = useKitT();
  const generated = useId(); const fieldId = id ?? generated;
  if (native) {
    return (
      <FieldFrame label={label} error={error} hint={hint} id={fieldId} className={className} fieldId={fieldId}>
        <input id={fieldId} name={name} className="ui-text-input" type="date" value={value ?? ''} min={min} max={max} disabled={disabled} required={required} aria-invalid={error ? true : undefined} aria-describedby={describeField(fieldId, error, hint)} onChange={event => onValueChange(event.currentTarget.value || null)} />
      </FieldFrame>
    );
  }
  const shown = parseIsoDate(value) ? value! : null;
  return (
    <PickerField
      label={label} id={fieldId} icon="calendar" display={shown ? format.date(shown, short ? 'short' : 'long') : placeholder ?? t('ui.dateField.pick')} empty={!shown}
      popoverLabel={t('ui.dateField.pick')} error={error} hint={hint} disabled={disabled} required={required} name={name} value={shown ?? ''} className={className} defaultOpen={defaultOpen} buttonRef={buttonRef}
    >
      {({ close }) => <DateCalendar value={shown} today={today} min={min} max={max} clearable={clearable} onPick={next => { onValueChange(next); close('select'); }} />}
    </PickerField>
  );
}

export interface DateCalendarProps {
  readonly value: string | null;
  readonly today: string;
  readonly min?: string;
  readonly max?: string;
  readonly clearable?: boolean;
  readonly onPick: (iso: string | null) => void;
}

/** The calendar body of DateField: month header, Monday-first grid of 48 day buttons (roving focus), 오늘 and optional 지우기. */
export function DateCalendar({ value, today, min, max, clearable = false, onPick }: DateCalendarProps) {
  const { t, format } = useKitT();
  const start = clampIso(value ?? today, min, max);
  const [cursor, setCursor] = useState(start);
  const grid = useRef<HTMLTableElement>(null);
  const moveFocus = useRef(false);
  const parts = parseIsoDate(cursor)!;
  const weeks = monthMatrix(parts.y, parts.m);
  const titleId = useId();
  // Opening the popover puts focus on the chosen (or today's) day so the arrow keys work at once.
  useEffect(() => { grid.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus(); }, []);
  useEffect(() => {
    if (!moveFocus.current) return;
    moveFocus.current = false;
    grid.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus();
  }, [cursor]);
  const go = (next: string, focus: boolean) => { const clamped = clampIso(next, min, max); moveFocus.current = focus; setCursor(clamped); };
  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    const step = (days: number) => { event.preventDefault(); go(addDays(cursor, days), true); };
    const month = (months: number) => { event.preventDefault(); go(addMonths(cursor, months), true); };
    switch (event.key) {
      case 'ArrowLeft': return step(-1);
      case 'ArrowRight': return step(1);
      case 'ArrowUp': return step(-7);
      case 'ArrowDown': return step(7);
      case 'Home': return step(-weekOffset(cursor));
      case 'End': return step(6 - weekOffset(cursor));
      case 'PageUp': return month(event.shiftKey ? -12 : -1);
      case 'PageDown': return month(event.shiftKey ? 12 : 1);
      default:
    }
  };
  const header = weekHeaderDates(cursor);
  const canToday = !isDisabledDay(today, min, max);
  return (
    <div className="ui-calendar">
      <div className="ui-calendar__head">
        <ActionButton variant="ghost" size="icon" aria-label={t('ui.dateField.prevMonth')} onClick={() => go(addMonths(cursor, -1), false)}><Icon name="chevron-left" /></ActionButton>
        <strong id={titleId} className="ui-calendar__title" aria-live="polite">{t('ui.dateField.month', { y: parts.y, month: t(`format.month.short.${parts.m}` as never) })}</strong>
        <ActionButton variant="ghost" size="icon" aria-label={t('ui.dateField.nextMonth')} onClick={() => go(addMonths(cursor, 1), false)}><Icon name="chevron-right" /></ActionButton>
      </div>
      <table ref={grid} className="ui-calendar__grid" role="grid" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <thead><tr>{header.map(day => <th key={day} scope="col" abbr={format.weekday(day, 'long')}>{format.weekday(day, 'short')}</th>)}</tr></thead>
        <tbody>
          {weeks.map(week => (
            <tr key={week[0]!.iso}>
              {week.map(day => {
                const selected = day.iso === value; const disabled = isDisabledDay(day.iso, min, max);
                return (
                  <td key={day.iso} role="gridcell" aria-selected={selected}>
                    <button
                      type="button" className="ui-calendar__day" tabIndex={day.iso === cursor ? 0 : -1} disabled={disabled}
                      data-selected={selected || undefined} data-today={day.iso === today || undefined} data-outside={!day.inMonth || undefined}
                      aria-current={day.iso === today ? 'date' : undefined} aria-label={format.date(day.iso, 'long')}
                      onClick={() => onPick(day.iso)} onFocus={() => { if (day.iso !== cursor) setCursor(day.iso); }}
                    >{day.day}</button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ui-calendar__foot">
        <ActionButton variant="secondary" disabled={!canToday} onClick={() => onPick(today)}>{t('format.period.today')}</ActionButton>
        {clearable && value ? <ActionButton variant="ghost" onClick={() => onPick(null)}>{t('ui.dateField.clear')}</ActionButton> : null}
      </div>
    </div>
  );
}
const weekOffset = (iso: string): number => { const header = weekHeaderDates(iso); return header.indexOf(iso); };
