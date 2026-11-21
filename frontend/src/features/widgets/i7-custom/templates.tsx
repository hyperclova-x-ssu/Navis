import { useEffect, useRef, useState } from 'react';
import { selectCustomOrders, type CustomAnswers, type CustomReceipt, type CustomTemplate, type CustomTemplateField } from '../../../data/iteration7/custom-orders';
import { useBundle } from '../../../i18n';
import { ActionButton, Checkbox, InlineForm, NumberField, Spinner, Textarea, TextField, posTimeTokens } from '../../../ui';
import { commandError, customOrderListBundle, inputLabels, isPastPickup, requestKey } from './copy';
import { DateTimeField } from './date-time-field';
import type { CustomOrderPort, CustomUiResult } from './port';
import type { CustomOrderRow } from './widget';

// SCR-276 names these reference products independently of the visible order list.
const referencePhotos = [
  { key: 'cake-reference', label: '레터링 생크림 케이크 1호' },
  { key: 'gift-reference', label: '답례 쿠키 세트 20박스' },
] as const;

const newField = (): CustomTemplateField => ({ fieldId: requestKey(), label: '', input: 'text', required: false, options: [] });
function AnswerFields({ fields, answers, onChange }: { fields: readonly CustomTemplateField[]; answers: CustomAnswers; onChange: (answers: CustomAnswers) => void }) {
  return <div className="custom-fields">{fields.map(field => <div key={field.fieldId}>
    {field.input === 'single' ? <label className="custom-field">{field.label}{field.required ? ' (필수 입력)' : ''}<select className="ui-text-input" value={String(answers[field.fieldId] ?? '')} onChange={event => onChange({ ...answers, [field.fieldId]: event.currentTarget.value })}><option value="">선택해 주세요</option>{field.options.map(option => <option key={option.optionId} value={option.optionId}>{option.label} +{option.extraAmount.toLocaleString('ko-KR')}원</option>)}</select></label>
      : field.input === 'multiple' ? <fieldset className="custom-fieldset"><legend>{field.label}{field.required ? ' (필수 입력)' : ''}</legend>{field.options.map(option => { const selected = answers[field.fieldId]; const values = Array.isArray(selected) ? selected : []; return <Checkbox key={option.optionId} checked={values.includes(option.optionId)} onCheckedChange={checked => onChange({ ...answers, [field.fieldId]: checked ? [...values, option.optionId] : values.filter(value => value !== option.optionId) })} label={`${option.label} +${option.extraAmount.toLocaleString('ko-KR')}원`} />; })}</fieldset>
        : field.input === 'datetime' ? <DateTimeField label={`${field.label}${field.required ? ' (필수 입력)' : ''}`} dateLabel={`${field.label} 날짜${field.required ? ' (필수 입력)' : ''}`} timeLabel={`${field.label} 시각${field.required ? ' (필수 입력)' : ''}`} value={String(answers[field.fieldId] ?? '')} onValueChange={value => onChange({ ...answers, [field.fieldId]: value })} /> : <TextField name={field.fieldId} label={`${field.label}${field.required ? ' (필수 입력)' : ''}`} value={String(answers[field.fieldId] ?? '')} onValueChange={value => onChange({ ...answers, [field.fieldId]: value })} />}
  </div>)}</div>;
}
export function TemplateManager({ port, templates, notify, initialTemplateId }: { port: CustomOrderPort; templates: readonly CustomTemplate[]; notify: (result: CustomUiResult) => void; initialTemplateId?: string }) {
  const { t } = useBundle(customOrderListBundle);
  const [editor, setEditor] = useState<CustomTemplate | 'new' | null>(() => templates.find(template => template.templateId === initialTemplateId) ?? null), [productKind, setProductKind] = useState(''), [keywords, setKeywords] = useState('');
  const [generating, setGenerating] = useState(false), [error, setError] = useState(''), [kindError, setKindError] = useState(''), [pendingDelete, setPendingDelete] = useState<CustomTemplate | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), generatingRef = useRef(false);
  useEffect(() => () => { clearTimeout(timer.current); generatingRef.current = false; }, []);
  const generate = () => {
    if (generatingRef.current) return;
    if (!productKind.trim()) { setKindError(t('widget.custom-order.productKindRequired')); return; }
    generatingRef.current = true; setGenerating(true); setError(''); setKindError('');
    timer.current = setTimeout(() => {
      const result = port.dispatch({ type: 'customTemplate.generate', productKind, keywords, idempotencyKey: requestKey() });
      generatingRef.current = false; setGenerating(false);
      if (!result.ok) { setError(commandError(result.reason)); return; }
      notify(result);
      const template = selectCustomOrders(port.read()).templates.find(item => item.templateId === result.value?.templateId);
      if (template) setEditor(template);
    }, posTimeTokens.payApproveMs);
  };
  return <section className="custom-templates" aria-label="템플릿 관리">
    <div className="custom-toolbar"><TextField label={t('widget.custom-order.productKind')} hint={t('widget.custom-order.productKindHint')} error={kindError || undefined} value={productKind} onValueChange={value => { setProductKind(value); setKindError(''); }} /><TextField label={t('widget.custom-order.keywords')} hint={t('widget.custom-order.keywordsHint')} value={keywords} onValueChange={setKeywords} />
      <ActionButton disabled={generating} aria-busy={generating || undefined} onClick={generate}>{generating ? <><Spinner />AI가 예시 템플릿을 만들고 있어요</> : 'AI로 템플릿 만들기'}</ActionButton><ActionButton variant="secondary" disabled={generating} onClick={() => setEditor('new')}>템플릿 만들기</ActionButton></div>
    {error && <p role="alert" className="custom-error">{error}</p>}
    {!templates.length ? <p>저장된 템플릿이 없어요</p> : <ul className="custom-template-list">{templates.map(template => <li key={template.templateId}><strong>{template.name}</strong><ActionButton variant="secondary" aria-label={`${template.name} 템플릿 고치기`} onClick={() => setEditor(template)}>템플릿 고치기</ActionButton><ActionButton variant="secondary" aria-label={`${template.name} 템플릿 지우기`} onClick={() => { setError(''); setPendingDelete(template); }}>템플릿 지우기</ActionButton></li>)}</ul>}
    {editor && <TemplateEditor key={editor === 'new' ? 'new' : editor.templateId} template={editor === 'new' ? undefined : editor} port={port} onClose={() => setEditor(null)} onSaved={result => { notify(result); setEditor(null); }} />}
    {pendingDelete && <InlineForm title="템플릿 지우기" saveLabel="지우기" onClose={() => setPendingDelete(null)} onSave={() => { const result = port.dispatch({ type: 'customTemplate.delete', templateId: pendingDelete.templateId, idempotencyKey: requestKey() }); if (result.ok) { notify(result); setError(''); setPendingDelete(null); } else setError(commandError(result.reason)); }}><p>{pendingDelete.name}을 지워요. 접수된 주문의 내용은 보관해요.</p></InlineForm>}
  </section>;
}
function TemplateEditor({ template, port, onClose, onSaved }: { template?: CustomTemplate; port: CustomOrderPort; onClose: () => void; onSaved: (result: CustomUiResult) => void }) {
  const [name, setName] = useState(template?.name ?? ''), [fields, setFields] = useState<readonly CustomTemplateField[]>(template?.fields ?? [newField()]);
  const [preview, setPreview] = useState(false), [answers, setAnswers] = useState<CustomAnswers>({}), [error, setError] = useState('');
  const [key] = useState(requestKey);
  const patch = (fieldId: string, changes: Partial<CustomTemplateField>) => setFields(fields.map(field => field.fieldId === fieldId ? { ...field, ...changes } : field));
  return <InlineForm title={template ? '템플릿 고치기' : '템플릿 만들기'} saveLabel="템플릿 저장하기" onClose={onClose} onSave={() => {
    if (!name.trim() || !fields.length || fields.some(field => !field.label.trim() || field.options.some(option => !option.label.trim() || !Number.isSafeInteger(option.extraAmount) || option.extraAmount < 0) || ((field.input === 'single' || field.input === 'multiple') && !field.options.length))) { setError('필수 항목을 모두 넣어 주세요'); return; }
    const result = port.dispatch({ type: 'customTemplate.save', ...(template ? { templateId: template.templateId } : {}), name, fields, idempotencyKey: key });
    if (result.ok) onSaved(result); else setError(commandError(result.reason));
  }}>
    <TextField label="템플릿 이름" value={name} onValueChange={setName} />
    {fields.map((field, index) => <fieldset className="custom-fieldset" key={field.fieldId}><legend>입력 항목 {index + 1}</legend><TextField label={`항목 ${index + 1} 이름`} value={field.label} onValueChange={label => patch(field.fieldId, { label })} />
      <label className="custom-field">입력 방식<select className="ui-text-input" value={field.input} onChange={event => patch(field.fieldId, { input: event.currentTarget.value as CustomTemplateField['input'] })}>{Object.entries(inputLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <Checkbox checked={field.required} onCheckedChange={required => patch(field.fieldId, { required })} label="필수 입력" />
      {(field.input === 'single' || field.input === 'multiple') && <>{field.options.map((option, optionIndex) => <div className="custom-toolbar" key={option.optionId}><TextField label={`항목 ${index + 1} 옵션 ${optionIndex + 1}`} value={option.label} onValueChange={label => patch(field.fieldId, { options: field.options.map(item => item.optionId === option.optionId ? { ...item, label } : item) })} /><NumberField label={`옵션 ${optionIndex + 1} 추가 금액`} min={0} unit="원" value={option.extraAmount} onValueChange={extraAmount => patch(field.fieldId, { options: field.options.map(item => item.optionId === option.optionId ? { ...item, extraAmount: extraAmount ?? 0 } : item) })} /><ActionButton variant="secondary" aria-label={`항목 ${index + 1} 옵션 ${optionIndex + 1} 지우기`} onClick={() => patch(field.fieldId, { options: field.options.filter(item => item.optionId !== option.optionId) })}>옵션 지우기</ActionButton></div>)}<ActionButton variant="secondary" onClick={() => patch(field.fieldId, { options: [...field.options, { optionId: requestKey(), label: '', extraAmount: 0 }] })}>선택 옵션 추가하기</ActionButton></>}
      <ActionButton variant="secondary" aria-label={`항목 ${index + 1} 지우기`} onClick={() => setFields(fields.filter(item => item.fieldId !== field.fieldId))}>항목 지우기</ActionButton>
    </fieldset>)}
    <div className="custom-toolbar"><ActionButton variant="secondary" onClick={() => setFields([...fields, newField()])}>입력 항목 추가하기</ActionButton><ActionButton variant="secondary" aria-expanded={preview} onClick={() => setPreview(!preview)}>미리보기</ActionButton></div>
    {preview && <section aria-label="템플릿 미리보기"><h4>{name}</h4><AnswerFields fields={fields} answers={answers} onChange={setAnswers} /></section>}{error && <p role="alert" className="custom-error">{error}</p>}
  </InlineForm>;
}
export function ReceiptForm({ port, templates, order, prefill, focusProduct, today, now, onClose, onSaved }: {
  port: CustomOrderPort; templates: readonly CustomTemplate[]; order?: CustomOrderRow;
  prefill?: Partial<CustomReceipt> & { readonly templateId?: string }; focusProduct?: boolean;
  today?: string; now?: string; onClose: () => void; onSaved: (result: CustomUiResult) => void;
}) {
  const { t } = useBundle(customOrderListBundle);
  const draftTemplate = templates.find(item => item.templateId === prefill?.templateId);
  const [templateId, setTemplateId] = useState(order?.templateId ?? draftTemplate?.templateId ?? templates[0]?.templateId ?? '');
  const [answers, setAnswers] = useState<CustomAnswers>(order?.answers ?? (draftTemplate ? prefill?.answers : undefined) ?? {});
  const template = order?.templateSnapshot ?? templates.find(item => item.templateId === templateId);
  const [channel, setChannel] = useState(order?.channel ?? prefill?.channel ?? 'phone'), [memberId, setMemberId] = useState(order?.memberId ?? port.members?.find(member => member.memberId === prefill?.memberId)?.memberId ?? ''), [name, setName] = useState(order?.guest?.name ?? prefill?.guest?.name ?? ''), [phone, setPhone] = useState(order?.guest?.phone ?? prefill?.guest?.phone ?? '');
  const [productLabel, setProductLabel] = useState(order?.productLabel ?? prefill?.productLabel ?? ''), [options, setOptions] = useState(order?.options.join(', ') ?? prefill?.options?.join(', ') ?? ''), [quantity, setQuantity] = useState<number | null>(order?.quantity ?? prefill?.quantity ?? 1);
  const [request, setRequest] = useState(order?.request ?? prefill?.request ?? ''), [pickupAt, setPickupAt] = useState(order?.desiredPickupAt ?? prefill?.desiredPickupAt ?? ''), [photos, setPhotos] = useState<readonly string[]>(order?.referencePhotoKeys ?? []);
  const [error, setError] = useState(''), [pickupError, setPickupError] = useState(''), [key] = useState(requestKey);
  const productInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focusProduct) productInput.current?.focus(); }, [focusProduct]);
  return <InlineForm title={order ? '주문 고치기' : '주문 접수'} saveLabel={order ? '주문 고치기' : '주문 접수하기'} onClose={onClose} onSave={() => {
    if (!template || !productLabel.trim() || !pickupAt || !Number.isSafeInteger(quantity) || (quantity ?? 0) < 1 || (!memberId && (!name.trim() || !phone.trim())) || template.fields.some(field => field.required && (!answers[field.fieldId] || !answers[field.fieldId]?.length))) { setError('필수 항목을 모두 넣어 주세요'); return; }
    if (isPastPickup(pickupAt, now) && pickupAt !== order?.desiredPickupAt) { setError(''); setPickupError(t('widget.custom-order.pickupPast')); return; }
    const receipt = { answers, channel, memberId: memberId || null, guest: memberId ? null : { name, phone }, productLabel, options: options.split(',').map(value => value.trim()).filter(Boolean), quantity: quantity!, request, desiredPickupAt: pickupAt, referencePhotoKeys: photos };
    const result = port.dispatch(order ? { type: 'customOrder.update', customOrderId: order.customOrderId, expectedQuoteRevision: order.quoteRevision, ...receipt } : { type: 'customOrder.create', templateId, ...receipt, idempotencyKey: key });
    if (result.ok) onSaved(result); else setError(commandError(result.reason));
  }}>
    {!order && <label className="custom-field">주문서 템플릿<select className="ui-text-input" value={templateId} onChange={event => { setTemplateId(event.currentTarget.value); setAnswers({}); }}><option value="">선택해 주세요</option>{templates.map(item => <option value={item.templateId} key={item.templateId}>{item.name}</option>)}</select></label>}
    {!template && <p>저장된 템플릿이 없어요. 템플릿 관리에서 먼저 만들어 주세요</p>}
    <label className="custom-field">접수 경로<select className="ui-text-input" value={channel} onChange={event => setChannel(event.currentTarget.value as typeof channel)}><option value="phone">전화</option><option value="message">메시지</option><option value="visit">방문</option></select></label>
    <label className="custom-field">회원에서 찾기<select className="ui-text-input" value={memberId} onChange={event => setMemberId(event.currentTarget.value)}><option value="">비회원</option>{port.members?.map(member => <option key={member.memberId} value={member.memberId}>{member.label}</option>)}</select></label>
    {!memberId && <><TextField label="손님 이름" name="guestName" value={name} onValueChange={setName} /><TextField label="연락처" name="guestPhone" type="tel" value={phone} onValueChange={setPhone} /></>}
    <TextField inputRef={productInput} label="상품" value={productLabel} onValueChange={setProductLabel} /><TextField label="상품 옵션" value={options} onValueChange={setOptions} /><NumberField label="수량" min={1} value={quantity} onValueChange={setQuantity} />
    <DateTimeField label="희망 픽업 일시" dateLabel="희망 픽업 날짜" timeLabel="희망 픽업 시각" today={today} value={pickupAt} error={pickupError || undefined} onValueChange={value => { setPickupAt(value); setPickupError(''); }} /><Textarea label="요청사항" value={request} onValueChange={setRequest} />
    <fieldset className="custom-fieldset">
      <legend>{t('widget.custom-order.referencePhotos')}</legend>
      {referencePhotos.map(photo => <Checkbox key={photo.key} label={photo.label} checked={photos.includes(photo.key)}
        onCheckedChange={checked => setPhotos(current => checked ? [...current, photo.key] : current.filter(value => value !== photo.key))} />)}
    </fieldset>
    {template && <AnswerFields fields={template.fields} answers={answers} onChange={setAnswers} />}
    {error && <p role="alert" className="custom-error">{error}</p>}
  </InlineForm>;
}
