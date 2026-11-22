import { useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { readAppClock } from '../../../data/db/app-clock';
import type { ObservationCommand, StoreEnvironment } from '../../../data/iteration7/environment/types';
import { dataBundle } from '../../../data/messages';
import { useDataExecute, useRealRetry, useWidgetDataStore } from '../../../data/react';
import { useBundle } from '../../../i18n';
import { ActionButton, DateField, FieldFrame, TimeField } from '../../../ui';

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

function NumberField({ label, name, value, min, max }: { label: string; name: string; value?: number; min: number; max: number }) {
  const id = useId();
  return <FieldFrame label={label} fieldId={id}><input className="ui-text-input ui-number-input" id={id} name={name} type="number" inputMode="decimal" min={min} max={max} step="any" defaultValue={value} required /></FieldFrame>;
}

function ManualResult({ message, saved }: { message: string; saved?: boolean }) {
  const result = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => { result.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }, [message, saved]);
  return <p ref={result} role={saved ? 'status' : 'alert'}>{message}</p>;
}

function ReadingForm() {
  const save = useManualSubmit('측정값을 저장했어요');
  // The kit pickers (DS 11.4) instead of the browser's datetime-local: the date reads "11월 22일 일요일", never "2026. 11. 22. 오후 12:07" (gate r1a W11 D1).
  const [start] = useState(() => { const { calendarDate, time } = readAppClock(); return { date: calendarDate, time }; });
  const [date, setDate] = useState<string | null>(start.date);
  const [time, setTime] = useState<string | null>(start.time);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!date || !time) return save.invalid('측정 날짜와 시각을 골라 주세요');
    const values = new FormData(event.currentTarget);
    const measuredAt = new Date(`${date}T${time}:00+09:00`);
    const now = Date.parse(`${readAppClock().local}+09:00`);
    if (Number.isNaN(+measuredAt) || +measuredAt > now) return save.invalid('현재 시각 이전의 측정 시각을 입력해 주세요');
    void save.submit({ type: 'environment.recordReading', measuredAt: measuredAt.toISOString(), temperatureC: Number(values.get('temperature')), humidityPct: Number(values.get('humidity')) });
  }
  return <form className="i7-environment-manual-form" aria-label="측정값 입력" onSubmit={submit}>
    <h3>측정값 입력</h3>
    <fieldset disabled={save.pending}>
      <DateField label="측정 날짜" value={date} today={start.date} required onValueChange={setDate} />
      <TimeField label="측정 시각(한국 시간)" value={time} step={5} required onValueChange={setTime} />
      <NumberField label="온도(°C)" name="temperature" min={-50} max={80} />
      <NumberField label="습도(%)" name="humidity" min={0} max={100} />
    </fieldset>
    <ActionButton type="submit" loading={save.pending} disabled={save.pending}>측정값 저장하기</ActionButton>
    {save.message && <ManualResult message={save.message} saved={save.saved} />}
  </form>;
}

function LimitsForm({ environment }: { environment: StoreEnvironment }) {
  const store = useWidgetDataStore();
  const [revision, setRevision] = useState(environment.limitsRevision);
  const save = useManualSubmit('적정 범위를 저장했어요');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (revision === undefined || revision !== environment.limitsRevision) return;
    const values = new FormData(event.currentTarget);
    const temperatureRange = [Number(values.get('temperatureMin')), Number(values.get('temperatureMax'))] as const;
    const humidityRange = [Number(values.get('humidityMin')), Number(values.get('humidityMax'))] as const;
    if (temperatureRange[0] > temperatureRange[1] || humidityRange[0] > humidityRange[1]) return save.invalid('최솟값은 최댓값보다 작거나 같아야 해요');
    void save.submit({ type: 'environment.updateLimits', expectedRevision: revision, temperatureRange, humidityRange }).then(saved => {
      if (saved) setRevision(store.getSnapshot().tables.storeEnvironment.limitsRevision);
    });
  }
  const revisionChanged = revision !== environment.limitsRevision;
  return <form className="i7-environment-manual-form" aria-label="적정 범위" onSubmit={submit}>
    <h3>적정 범위</h3>
    <fieldset key={revision} disabled={save.pending || revisionChanged}>
      <NumberField label="최저 온도(°C)" name="temperatureMin" value={environment.temperatureRange[0]} min={-50} max={80} />
      <NumberField label="최고 온도(°C)" name="temperatureMax" value={environment.temperatureRange[1]} min={-50} max={80} />
      <NumberField label="최저 습도(%)" name="humidityMin" value={environment.humidityRange[0]} min={0} max={100} />
      <NumberField label="최고 습도(%)" name="humidityMax" value={environment.humidityRange[1]} min={0} max={100} />
    </fieldset>
    {revisionChanged ? <ActionButton onClick={() => setRevision(environment.limitsRevision)}>최신 범위 불러오기</ActionButton>
      : <ActionButton type="submit" variant="secondary" loading={save.pending} disabled={save.pending}>적정 범위 저장하기</ActionButton>}
    {save.message && <ManualResult message={save.message} saved={save.saved} />}
  </form>;
}

/**
 * The approved owner entry (M11.1: a measured temperature and humidity, and the allowed range). The window opens as the original one; the two forms open
 * from two buttons inside the climate section, so a screen with a sensor-less store reads the same as the sample screen until the owner asks to enter a value.
 */
export function ManualMeasurementEntry() {
  const store = useWidgetDataStore();
  const { tables } = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [open, setOpen] = useState<'reading' | 'limits' | null>(null);
  const toggle = (form: 'reading' | 'limits') => setOpen(current => current === form ? null : form);
  return <div className="i7-environment-manual">
    <div className="i7-environment-manual-actions">
      <ActionButton variant="secondary" aria-expanded={open === 'reading'} onClick={() => toggle('reading')}>측정값 입력하기</ActionButton>
      <ActionButton variant="secondary" aria-expanded={open === 'limits'} onClick={() => toggle('limits')}>적정 범위 바꾸기</ActionButton>
    </div>
    {open === 'reading' && <ReadingForm />}
    {open === 'limits' && <LimitsForm environment={tables.storeEnvironment} />}
  </div>;
}
