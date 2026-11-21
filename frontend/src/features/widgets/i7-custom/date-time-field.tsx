import { useState } from 'react';
import { DateField, TimeField } from '../../../ui';

/**
 * A local `YYYY-MM-DDTHH:MM` value edited with the kit pickers (no browser date or time control). The value only changes once both
 * halves are chosen; until then the half that is already chosen stays on screen and the value reads as empty.
 */
export function DateTimeField({ label, dateLabel, timeLabel, value, onValueChange, today, error, clearable = false }: {
  readonly label: string; readonly dateLabel: string; readonly timeLabel: string;
  readonly value: string; readonly onValueChange: (value: string) => void;
  /** Store-local today, so the calendar marks the right day. */
  readonly today?: string; readonly error?: string; readonly clearable?: boolean;
}) {
  const [partial, setPartial] = useState<{ date: string | null; time: string | null }>({ date: null, time: null });
  const date = value ? value.slice(0, 10) : partial.date, time = value ? value.slice(11, 16) : partial.time;
  const emit = (nextDate: string | null, nextTime: string | null) => {
    if (nextDate && nextTime) { setPartial({ date: null, time: null }); onValueChange(`${nextDate}T${nextTime}`); return; }
    setPartial({ date: nextDate, time: nextTime }); onValueChange('');
  };
  return <fieldset className="custom-datetime" aria-label={label}>
    <DateField label={dateLabel} value={date} today={today} clearable={clearable} error={error} onValueChange={next => emit(next, time)} />
    <TimeField label={timeLabel} value={time} onValueChange={next => emit(date, next)} />
  </fieldset>;
}
