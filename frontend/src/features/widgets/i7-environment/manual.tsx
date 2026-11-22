import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { readAppClock } from '../../../data/db/app-clock';
import type { ObservationCommand, StoreEnvironment } from '../../../data/iteration7/environment/types';
import { dataBundle } from '../../../data/messages';
import { useDataExecute, useRealRetry, useWidgetDataStore } from '../../../data/react';
import { useBundle } from '../../../i18n';
import { ActionButton, DateField, DetailFooterContent, FieldFrame, TimeField } from '../../../ui';

function useManualSubmit(success: string) {
  const execute = useDataExecute();
  const data = useBundle(dataBundle);
  const retry = useRealRetry('cctv');
  const [state, setState] = useState<{ pending?: boolean; saved?: boolean; message?: string }>({});
  const busy = useRef(false);
  async function submit(command: ObservationCommand): Promise<boolean> {
    if (busy.current) return false;
    busy.current = true;
    setState({ pending: true });
    try {
      const result = await execute(command);
      if (!result.ok && result.code === 'CONFLICT') retry();
      // A refusal the form has no sentence for reads the shared line "실행하지 못했어요 · {이유}. {다음}" (T-17).
      const line = !result.ok && result.messageKey.startsWith('data.real.commandFailure.result.') ? data.t(result.messageKey as never) : undefined;
      setState(result.ok ? { saved: true, message: success } : { message: result.reason === 'STALE_REVISION' ? '다른 곳에서 범위를 바꿨어요. 최신 범위를 확인해 주세요' : line ?? '저장하지 못했어요. 입력값을 확인해 주세요' });
      return result.ok;
    } finally {
      busy.current = false;
    }
  }
  return { ...state, submit, invalid: (message: string) => setState({ message }) };
}

function NumberField({ label, name, value, min, max, error }: { label: string; name: string; value?: number; min: number; max: number; error?: string }) {
  const id = useId();
  return <FieldFrame label={label} fieldId={id} error={error}><input className="ui-text-input ui-number-input" id={id} name={name} type="number" inputMode="decimal" min={min} max={max} step="any" defaultValue={value} aria-invalid={Boolean(error) || undefined} aria-describedby={error ? `${id}-error` : undefined} required /></FieldFrame>;
}

function ManualResult({ message, saved }: { message: string; saved?: boolean }) {
  const result = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => { result.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [message, saved]);
  return <p ref={result} className={saved ? undefined : "ui-field__error"} role={saved ? 'status' : 'alert'}>{message}</p>;
}

function ReadingForm({ open }: { open: boolean }) {
  const save = useManualSubmit('측정값을 저장했어요');
  const [fieldErrors, setFieldErrors] = useState<{ temperature?: string; humidity?: string }>({});
  const formId = useId();
  // The kit pickers (DS 11.4) instead of the browser's datetime-local: the date reads "11월 22일 일요일", never "2026. 11. 22. 오후 12:07" (gate r1a W11 D1).
  const [start] = useState(() => { const { calendarDate, time } = readAppClock(); return { date: calendarDate, time }; });
  const [date, setDate] = useState<string | null>(start.date);
  const [time, setTime] = useState<string | null>(start.time);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!date || !time) return save.invalid('측정 날짜와 시각을 골라 주세요');
    const values = new FormData(event.currentTarget);
    const temperature = String(values.get('temperature') ?? '');
    const humidity = String(values.get('humidity') ?? '');
    const temperatureError = !temperature ? '온도를 넣어 주세요' : Number(temperature) < -50 || Number(temperature) > 80 ? '온도는 -50~80°C로 넣어 주세요' : undefined;
    const humidityError = !humidity ? '습도를 넣어 주세요' : Number(humidity) < 0 || Number(humidity) > 100 ? '습도는 0~100%로 넣어 주세요' : undefined;
    setFieldErrors({ temperature: temperatureError, humidity: humidityError });
    if (temperatureError || humidityError) return;
    const measuredAt = new Date(`${date}T${time}:00+09:00`);
    const now = Date.parse(`${readAppClock().local}+09:00`);
    if (Number.isNaN(+measuredAt) || +measuredAt > now) return save.invalid('현재 시각 이전의 측정 시각을 입력해 주세요');
    void save.submit({ type: 'environment.recordReading', measuredAt: measuredAt.toISOString(), temperatureC: Number(values.get('temperature')), humidityPct: Number(values.get('humidity')) });
  }
  return <form id={formId} className="i7-environment-manual-form" aria-label="측정값 입력" hidden={!open} noValidate onSubmit={submit}>
    <h3>측정값 입력</h3>
    <fieldset disabled={save.pending}>
      <DateField label="측정 날짜" value={date} today={start.date} required onValueChange={setDate} />
      <TimeField label="측정 시각" value={time} step={5} required onValueChange={setTime} />
      <NumberField label="온도(°C)" name="temperature" min={-50} max={80} error={fieldErrors.temperature} />
      <NumberField label="습도(%)" name="humidity" min={0} max={100} error={fieldErrors.humidity} />
    </fieldset>
    {open && <DetailFooterContent><div className="detail-footer-actions">
      <ActionButton type="submit" form={formId} loading={save.pending} disabled={save.pending}>측정값 저장하기</ActionButton>
      {save.message && <ManualResult message={save.message} saved={save.saved} />}
    </div></DetailFooterContent>}
  </form>;
}

function LimitsForm({ environment, manual }: { environment: StoreEnvironment; manual: boolean }) {
  const store = useWidgetDataStore();
  const currentRevision = environment.limitsRevision ?? (manual ? undefined : 0);
  const [revision, setRevision] = useState(currentRevision);
  const save = useManualSubmit('적정 범위를 저장했어요');
  const [errors, setErrors] = useState<{ temperature?: string; humidity?: string }>({});
  const formId = useId();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (revision === undefined || revision !== currentRevision) return;
    const values = new FormData(event.currentTarget);
    const temperatureRange = [Number(values.get('temperatureMin')), Number(values.get('temperatureMax'))] as const;
    const humidityRange = [Number(values.get('humidityMin')), Number(values.get('humidityMax'))] as const;
    const temperature = temperatureRange[0] > temperatureRange[1] ? '최저 온도가 최고 온도보다 높아요' : undefined;
    const humidity = humidityRange[0] > humidityRange[1] ? '최저 습도가 최고 습도보다 높아요' : undefined;
    setErrors({ temperature, humidity });
    if (temperature || humidity) return;
    void save.submit({ type: 'environment.updateLimits', expectedRevision: revision, temperatureRange, humidityRange }).then(saved => {
      if (saved) setRevision(store.getSnapshot().tables.storeEnvironment.limitsRevision);
    });
  }
  const revisionChanged = revision !== currentRevision;
  return <form id={formId} className="i7-environment-manual-form" aria-label="적정 범위" onSubmit={submit}>
    <h3>적정 범위</h3>
    <fieldset key={revision} disabled={save.pending || revisionChanged}>
      <NumberField label="최저 온도(°C)" name="temperatureMin" error={errors.temperature} value={environment.temperatureRange[0]} min={-50} max={80} />
      <NumberField label="최고 온도(°C)" name="temperatureMax" value={environment.temperatureRange[1]} min={-50} max={80} />
      <NumberField label="최저 습도(%)" name="humidityMin" error={errors.humidity} value={environment.humidityRange[0]} min={0} max={100} />
      <NumberField label="최고 습도(%)" name="humidityMax" value={environment.humidityRange[1]} min={0} max={100} />
    </fieldset>
    <DetailFooterContent><div className="detail-footer-actions">
    {revisionChanged ? <ActionButton onClick={() => setRevision(currentRevision)}>최신 범위 불러오기</ActionButton>
      : <ActionButton type="submit" form={formId} loading={save.pending} disabled={save.pending}>적정 범위 저장하기</ActionButton>}
    {save.message && <ManualResult message={save.message} saved={save.saved} />}
    </div></DetailFooterContent>
  </form>;
}

/**
 * The approved owner entry (M11.1: a measured temperature and humidity, and the allowed range). The window opens as the original one; the two forms open
 * from two buttons inside the climate section, so a screen with a sensor-less store reads the same as the sample screen until the owner asks to enter a value.
 */
export function ManualMeasurementEntry({ manual }: { manual: boolean }) {
  const store = useWidgetDataStore();
  const { tables } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [open, setOpen] = useState<'reading' | 'limits' | null>(null);
  const [readingOpened, setReadingOpened] = useState(false);
  function toggle(form: 'reading' | 'limits', trigger: HTMLButtonElement) {
    if (open === form) {
      setOpen(null);
      trigger.focus({ preventScroll: true });
      return;
    }
    if (form === 'reading') setReadingOpened(true);
    setOpen(form);
  }
  return <div className="i7-environment-manual" data-esc-layer={open ? true : undefined}>
    <div className="i7-environment-manual-actions">
      <ActionButton variant="secondary" aria-expanded={open === 'reading'} data-esc-close={open === 'reading' ? true : undefined} onClick={event => toggle('reading', event.currentTarget)}>측정값 입력하기</ActionButton>
      <ActionButton variant="secondary" aria-expanded={open === 'limits'} data-esc-close={open === 'limits' ? true : undefined} onClick={event => toggle('limits', event.currentTarget)}>적정 범위 바꾸기</ActionButton>
    </div>
    {readingOpened && <ReadingForm open={open === 'reading'} />}
    {open === 'limits' && <LimitsForm environment={tables.storeEnvironment} manual={manual} />}
  </div>;
}
