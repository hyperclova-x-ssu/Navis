import { useId, type ReactNode } from 'react';
import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup as BaseRadioGroup } from '@base-ui/react/radio-group';
import { Icon } from '../icons';
import './kit-controls.css';

/**
 * K-C G1 (DS 6.1, 11.4): checkbox and radio rows. The control itself is a 48 hit area (56 with `size="primary"`) that draws a 24 visible box,
 * the focus ring is 3px, and the whole row (box, label, description) is one hit target. Space toggles; the accessible name is the label text.
 */
export interface CheckboxProps {
  readonly checked: boolean;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly label: ReactNode;
  /** Caption line under the label (also the accessible description). */
  readonly description?: ReactNode;
  readonly disabled?: boolean;
  readonly name?: string;
  readonly id?: string;
  readonly size?: 'default' | 'primary';
  readonly className?: string;
}
export function Checkbox({ checked, onCheckedChange, label, description, disabled = false, name, id, size = 'default', className = '' }: CheckboxProps) {
  const generated = useId(); const base = id ?? generated;
  return (
    <div className={`ui-check ${className}`} data-size={size} data-checked={String(checked)} data-disabled={disabled || undefined}>
      <BaseCheckbox.Root id={base} name={name} checked={checked} disabled={disabled} onCheckedChange={next => onCheckedChange(next)} className="ui-check__box" aria-labelledby={`${base}-label`} aria-describedby={description ? `${base}-desc` : undefined}>
        <BaseCheckbox.Indicator className="ui-check__tick"><Icon name="check" /></BaseCheckbox.Indicator>
      </BaseCheckbox.Root>
      <span className="ui-check__text"><span id={`${base}-label`} className="ui-check__label">{label}</span>{description ? <span id={`${base}-desc`} className="ui-check__desc">{description}</span> : null}</span>
    </div>
  );
}

export interface RadioOption<V extends string> { readonly value: V; readonly label: ReactNode; readonly description?: ReactNode; readonly disabled?: boolean }
export interface RadioGroupProps<V extends string> {
  readonly value: V | null;
  readonly onValueChange: (value: V) => void;
  readonly options: readonly RadioOption<V>[];
  /** The group's name: shown as a heading unless `hideLabel`, and always the accessible name. */
  readonly label: string;
  readonly hideLabel?: boolean;
  readonly name?: string;
  readonly disabled?: boolean;
  readonly size?: 'default' | 'primary';
  readonly orientation?: 'vertical' | 'horizontal';
  readonly className?: string;
}
export function RadioGroup<V extends string>({ value, onValueChange, options, label, hideLabel = false, name, disabled = false, size = 'default', orientation = 'vertical', className = '' }: RadioGroupProps<V>) {
  const id = useId();
  return (
    <div className={`ui-radio-group ${className}`} data-orientation={orientation}>
      <span id={`${id}-label`} className={hideLabel ? 'ui-sr-only' : 'ui-radio-group__label'}>{label}</span>
      <BaseRadioGroup<V> value={value ?? undefined} onValueChange={next => onValueChange(next)} name={name} disabled={disabled} aria-labelledby={`${id}-label`} className="ui-radio-group__options">
        {options.map(option => {
          const rid = `${id}-${option.value}`; const checked = option.value === value; const off = disabled || option.disabled === true;
          return (
            <div key={option.value} className="ui-check" data-size={size} data-checked={String(checked)} data-disabled={off || undefined}>
              <Radio.Root value={option.value} id={rid} disabled={option.disabled} className="ui-check__box" data-shape="round" aria-labelledby={`${rid}-label`} aria-describedby={option.description ? `${rid}-desc` : undefined}>
                <Radio.Indicator className="ui-check__dot" />
              </Radio.Root>
              <span className="ui-check__text"><span id={`${rid}-label`} className="ui-check__label">{option.label}</span>{option.description ? <span id={`${rid}-desc`} className="ui-check__desc">{option.description}</span> : null}</span>
            </div>
          );
        })}
      </BaseRadioGroup>
    </div>
  );
}
