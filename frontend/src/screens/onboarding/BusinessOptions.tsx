import { useLayoutEffect, useRef, type MouseEvent } from 'react';
import type { BusinessType } from '../../contracts';
import { useBundle } from '../../i18n';
import { BusinessCard } from '../../ui';
import { shellBundle } from '../settings/messages';
import './onboarding.css';

const businesses: readonly BusinessType[] = ['cafe', 'restaurant', 'pub', 'beauty', 'retail', 'academy', 'fitness', 'other'];
export interface BusinessOptionsProps {
  readonly value: BusinessType | null;
  readonly onChoose: (type: BusinessType, event: MouseEvent<HTMLButtonElement>) => void;
  readonly compact?: boolean;
  readonly focusOnMount?: boolean;
}

/** The same eight kit BusinessCards on the question and inside the existing settings dialog. Names are the kit's ui.business.* (T-055). */
export function BusinessOptions({ value, onChoose, compact = false, focusOnMount = false }: BusinessOptionsProps) {
  const current = useRef<HTMLButtonElement>(null);
  const { t } = useBundle(shellBundle);
  useLayoutEffect(() => { if (focusOnMount) current.current?.focus({ preventScroll: true }); }, [focusOnMount]);
  return <div role="group" aria-label={t('business.group')} className={`business-options${compact ? ' business-options--compact' : ''}`}>
    {businesses.map(type => {
      const selected = value === type;
      return <BusinessCard key={type} ref={type === (value ?? businesses[0]) ? current : undefined} businessType={type} selected={selected} compact={compact} onClick={event => onChoose(type, event)} />;
    })}
  </div>;
}
