import { useContext, useEffect, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { ManagementTemplateId, PaymentStyle, RunStore, ShopSettings } from '../../contracts';
import type { PresentationRunStore } from '../../state';
import { getManagementTemplates } from '../../catalog/management-templates';
import { createTableLayout, tableLayoutEnabled } from '../../layout/table-layout';
import { koreanScreenText, useBundle } from '../../i18n';
import {
  ActionButton, ChoiceCard, ContentRecovery, EmptyStartOption, OnboardingFrame, OnboardingFooter,
  OnboardingStepTransition, ReasonLine, TemplateCard, TemplatePreview, consumeDismissSequence, timePolicy,
} from '../../ui';
import { SessionActionsContext } from '../../app/session-actions';
import { shellBundle } from '../settings/messages';
import { BusinessOptions } from './BusinessOptions';
import { TableEditor } from './TableEditor';
import { iteration5Bundle } from './messages';
import './onboarding.css';

export { BusinessOptions } from './BusinessOptions';
export type { BusinessOptionsProps } from './BusinessOptions';
export interface SessionActions {
  readonly completeOnboarding: (templateId: ManagementTemplateId | null) => unknown;
  readonly updateSettings?: (settings: ShopSettings) => unknown;
}
export interface OnboardingScreenProps {
  readonly run: RunStore;
  readonly sessionActions?: Pick<SessionActions, 'completeOnboarding'>;
}

// The shell accepts the base store interface. Check and narrow the actual port;
// a missing port reports failure instead of silently creating a local draft.
function hasTableDraftPort(run: RunStore): run is PresentationRunStore {
  return 'updateOnboardingTableDraft' in run.actions && typeof run.actions.updateOnboardingTableDraft === 'function';
}

// Payment selection advances the step, so arrow keys only browse these cards.
function focusPaymentChoice(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
  const radios = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
  const index = radios.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  event.preventDefault();
  event.stopPropagation();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? radios.length - 1
    : (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + radios.length) % radios.length;
  radios[next]?.focus();
}

function PaymentOptions({ value, onSelect }: { value: PaymentStyle | null; onSelect: (value: PaymentStyle) => void }) {
  const { t } = useBundle(iteration5Bundle);
  return <div role="radiogroup" aria-label={t('payment.title')} className="t207-choices" onKeyDownCapture={focusPaymentChoice}>
    {(['prepaid', 'postpaid'] as const).map(option => <ChoiceCard key={option} value={option}
      icon={option === 'prepaid' ? 'receipt' : 'table'} label={t(`payment.${option}`)}
      description={t(`payment.${option}.description`).replace(' 예:', '\n예:')}
      selected={value === option} onSelect={() => onSelect(option)} />)}
  </div>;
}

export function OnboardingScreen({ run, sessionActions }: OnboardingScreenProps) {
  const contextActions = useContext(SessionActionsContext);
  const completeOnboarding = sessionActions?.completeOnboarding ?? contextActions?.completeOnboarding;
  const state = useSyncExternalStore(run.subscribe, run.getState);
  const { t, locale } = useBundle(shellBundle, iteration5Bundle);
  const { step, draft, selectedTemplateId } = state.onboarding;
  const [skipped, setSkipped] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const current = step === 'business' ? 0 : step === 'payment' ? 1 : step === 'tables' ? 2 : 3;
  const [navigation, setNavigation] = useState({ index: current, direction: 'forward' as 'forward' | 'back' });
  if (navigation.index !== current) setNavigation({ index: current, direction: current < navigation.index ? 'back' : 'forward' });
  useEffect(() => {
    if (!skipped) return;
    const timer = setTimeout(() => setSkipped(null), timePolicy.noticeMs);
    return () => clearTimeout(timer);
  }, [skipped]);

  const food = draft.businessType === 'cafe' || draft.businessType === 'restaurant' || draft.businessType === 'pub';
  const off = current > 0 && (!food || draft.paymentStyle === 'prepaid');
  const enabled = tableLayoutEnabled(draft.businessType, draft.paymentStyle);
  const names = [t('step.business'), t('step.payment'), t('step.tables'), t('step.start')];
  const steps = names.map((label, index) => ({ id: String(index), label,
    state: (index === 2 && off ? 'off' : index === current ? 'current' : index < current ? 'done' : 'next') as 'off' | 'current' | 'done' | 'next',
    reasonId: index === 2 && off ? 'table-reason' : undefined,
  }));
  const previous = current === 3 && !enabled ? 1 : current - 1;
  const title = step === 'business' ? t('onboarding.title') : step === 'payment' ? t('payment.title') : step === 'tables' ? t('tables.title') : t('start.title');
  const subtitle = step === 'business' ? t('onboarding.description') : step === 'payment' ? t('payment.description') : step === 'tables' ? t('tables.description') : t('start.description');
  const layout = draft.tableLayout ?? createTableLayout();
  const templates = getManagementTemplates({ businessType: draft.businessType, paymentStyle: draft.paymentStyle ?? 'prepaid', presetId: state.screenPreset.id });
  const chosen = selectedTemplateId ?? templates.find(item => item.recommended)!.id;
  const summary = t('tables.total', { n: layout.tables.length, m: layout.tables.reduce((sum, table) => sum + table.seats, 0) });
  const complete = (id: ManagementTemplateId | null) => {
    const result = completeOnboarding?.(id);
    setError(!result || typeof result === 'object' && 'ok' in result && result.ok === false);
  };

  return <div className="t207-onboarding-host" data-step={step}><OnboardingFrame title={title} subtitle={subtitle} steps={steps}
    reason={off ? <ReasonLine id="table-reason">{t('table.reason')}</ReasonLine> : undefined}
    previousStepName={names[previous]} onPrevious={current > 0 ? () => run.actions.onboardingBack() : undefined}>
    <OnboardingStepTransition stepKey={`${state.runId}:${step}`} direction={navigation.direction}>
      <div className={`t207-step-body t207-step-body--${step}`}>
        {step === 'business' ? <div className="t207-business">
          <ContentRecovery><BusinessOptions value={draft.businessType} onChoose={(type, event) => {
            consumeDismissSequence(event.nativeEvent);
            run.actions.chooseBusiness(type);
          }} /></ContentRecovery>
          <ActionButton variant="ghost" onClick={() => run.actions.skipBusiness()}>{t('onboarding.skip')}</ActionButton>

        </div> : step === 'payment' ? <PaymentOptions value={draft.paymentStyle} onSelect={paymentStyle => run.actions.setOnboardingAnswer({ paymentStyle })} />
          : step === 'tables' ? <>
            <TableEditor value={layout} onChange={next => {
              if (!hasTableDraftPort(run) || !run.actions.updateOnboardingTableDraft(next, { runId: state.runId, transitionToken: state.transitionToken })) setError(true);
            }} />
            <OnboardingFooter summary={<span aria-live="polite" aria-atomic="true" aria-label={summary}>{state.locale==='ko'?koreanScreenText(summary):summary}</span>}>
              <ActionButton variant="secondary" size="primary" onClick={() => {
                if (run.actions.skipOnboardingTables()) setSkipped(run.getState().transitionToken);
              }}>{t('later')}</ActionButton>
              <ActionButton size="primary" onClick={() => run.actions.saveOnboardingTables(layout)}>{t(locale==='ko'?'common.ok':'next')}</ActionButton>
            </OnboardingFooter>
          </> : <>

            <div role="radiogroup" aria-label={t('start.group')} className="t207-templates">
              {templates.map(template => {
                const definitions = template.panels.map(panel => ({ panel, feature: run.catalog.find(item => item.id === panel.featureId)! }));
                return <TemplateCard key={template.id} id={template.id}
                  name={t(template.nameKey as keyof typeof iteration5Bundle.ko)} description={t(template.descriptionKey as keyof typeof iteration5Bundle.ko)}
                  panelNames={definitions.map(({ feature }) => feature.label)} selected={chosen === template.id} recommended={template.recommended}
                  onSelect={() => run.actions.selectStartTemplate(template.id)}
                  preview={<TemplatePreview columns={state.screenPreset.grid.columns} rows={state.screenPreset.grid.rows}
                    items={definitions.map(({ panel, feature }) => ({ id: feature.id, label: feature.label, groupId: feature.groupId, ...panel }))} />} />;
              })}
            </div>
            <OnboardingFooter summary={<EmptyStartOption onClick={() => complete(null)} />}>
              <ActionButton size="primary" onClick={() => complete(chosen)}>{t('start.button')}</ActionButton>
            </OnboardingFooter>
            {skipped === state.transitionToken ? <p role="status">{t('tables.later')}</p> : null}
          </>}
      </div>
    </OnboardingStepTransition>
    {error ? <p role="alert">{t('session.error')}</p> : null}
  </OnboardingFrame></div>;
}
