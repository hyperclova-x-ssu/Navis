import { useId, useRef, useState, type ReactNode, type Ref } from 'react';
import { Icon, type IconName } from '../icons';
import { AnchoredPopover } from './overlays';
import { FieldFrame, describeField } from './forms';
import './kit-controls.css';

export interface PickerFieldProps {
  readonly label: string;
  /** The text shown on the field (already formatted, e.g. `10월 26일 월요일`) or the placeholder when `empty`. */
  readonly display: string;
  readonly empty?: boolean;
  readonly icon: IconName;
  /** Accessible name of the opened popover. */
  readonly popoverLabel: string;
  readonly error?: string;
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly required?: boolean;
  readonly id?: string;
  readonly className?: string;
  /** Open the popover on mount (a DataGrid cell editor opens its calendar the moment the cell enters edit mode). */
  readonly defaultOpen?: boolean;
  /** Receives the field's button (the DataGrid editor focuses it). */
  readonly buttonRef?: Ref<HTMLButtonElement>;
  /** Posted with a form: a hidden input with this name carries `value`. */
  readonly name?: string;
  readonly value?: string;
  /** Popover body. It moves focus to its own current item on mount, and calls `close('select')` after a choice so focus returns to the field. */
  readonly children: (api: { readonly close: (reason?: 'select' | 'button') => void }) => ReactNode;
}

/**
 * Kit picker shell (K-C): a 48-high text-like button in the TextField frame (label above, hint and error sentence below) that opens an
 * AnchoredPopover. No browser date or time control, so nothing renders as a native white widget in dark mode (DS 6.1 G-17).
 * Down arrow opens it from the keyboard; Esc, a choice or the field itself closes it and focus goes back to the field.
 */
export function PickerField({ label, display, empty = false, icon, popoverLabel, error, hint, disabled = false, required, id, className, name, value, defaultOpen = false, buttonRef, children }: PickerFieldProps) {
  const generated = useId(); const fieldId = id ?? generated; const popoverId = `${fieldId}-popover`;
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(defaultOpen);
  const setButton = (node: HTMLButtonElement | null) => {
    anchor.current = node;
    if (typeof buttonRef === 'function') buttonRef(node); else if (buttonRef) (buttonRef as { current: HTMLButtonElement | null }).current = node;
  };
  const restoreFocus = () => { anchor.current?.focus(); };
  const close = () => { setOpen(false); restoreFocus(); };
  return (
    <FieldFrame label={label} error={error} hint={hint} id={fieldId} className={`ui-picker-field ${className ?? ''}`} fieldId={fieldId}>
      <button
        ref={setButton} id={fieldId} type="button" className="ui-picker-field__button" disabled={disabled}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popoverId : undefined} aria-required={required || undefined}
        aria-invalid={error ? true : undefined} aria-describedby={describeField(fieldId, error, hint)} aria-labelledby={`${fieldId}-label ${fieldId}-value`}
        onClick={() => setOpen(current => !current)}
        onKeyDown={event => { if (event.key === 'ArrowDown' && !open && !disabled) { event.preventDefault(); setOpen(true); } }}
      >
        <Icon name={icon} aria-hidden />
        <span id={`${fieldId}-value`} className="ui-picker-field__value" data-empty={empty || undefined}>{display}</span>
      </button>
      {name ? <input type="hidden" name={name} value={value ?? ''} /> : null}
      <AnchoredPopover
        open={open} anchorRef={anchor} side="bottom" id={popoverId} label={popoverLabel} allowAnchorInteraction
        onClose={reason => { setOpen(false); if (reason === 'Esc' || reason === 'button') restoreFocus(); }}
      >
        {open ? children({ close }) : null}
      </AnchoredPopover>
    </FieldFrame>
  );
}
