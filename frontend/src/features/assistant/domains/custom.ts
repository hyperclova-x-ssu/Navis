import type { DetailRef, Locale } from '../../../contracts';
import type { ReversiblePickupCommand } from '../../../data/commands/types';
import type { DataSnapshot } from '../../../data/db/types';
import { NOW, TODAY, addDays, isIsoDate } from '../../../data/db/time';
import { planCustomOrderCommand, selectCustomOrders, type CustomOrderCommand, type CustomOrderRead, type CustomReceipt,
  type CustomOrderView, type CustomTemplate, type CustomTemplateField } from '../../../data/iteration7/custom-orders';
import { selectCustomOrderRead } from '../../../data/pos/projection';
import { normalizeMemberPhone } from '../../../data/commands/management-guards';
import { activeMember, maskCustomer } from '../../../data/derive/members';
import { resolveDataText } from '../../../data/text';
import { createTranslator, baseBundles } from '../../../i18n';
import { dataBundles } from '../../../data/messages';
import { maskName, maskPhone, orderNumber, stageLabels, paymentLabels, channelLabels } from '../../widgets/i7-custom/copy';
import { agentCommandPolicy, validateAgentCommandArgs, validateAgentDraft, validateAgentPrefill,
  type AgentFact, type AgentKnownCommand, type AgentWireArgs } from '../../../../shared/navis-agent-schema.mjs';
import { normalizeNavisInput, normalizeNavisName, parseNavisDate, parseNavisMoney, parseNavisNumber, parseNavisTime } from '../navis-input';
import type { DomainAdapter, DomainDetail, DomainRoute, DomainTurnInput, LocalSlots,
  RecordAdapter, RecordSearch, RecordTargets, RunCommandAdapter } from './registry';

const featureId = 'custom-order';
const defaultCondition = { kind: 'default' } as const;
const tr = (locale: Locale) => createTranslator<string>(locale, ...baseBundles, ...dataBundles);
const local = (locale: Locale, ko: string, en: string, hans: string, hant: string) => ({ ko, en, 'zh-Hans': hans, 'zh-Hant': hant })[locale];
const str = (v: unknown): v is string => typeof v === 'string';
const shortText = (v: unknown): v is string => str(v) && v.length <= 500;
const filled = (v: unknown): v is string => shortText(v) && !!v.trim();
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const key = normalizeNavisName;
const slot = (name: string) => ({ slot: name });
const select = (snapshot: DataSnapshot) => selectCustomOrders(selectCustomOrderRead(snapshot));

const stageText = (locale: Locale, stage: CustomOrderView['stage']) => local(locale, stageLabels[stage], {
  received: 'Received', quote_pending: 'Quote pending', approval_pending: 'Awaiting customer approval', revision_requested: 'Revision requested',
  payment_pending: 'Awaiting payment', in_production: 'In production', production_complete: 'Production complete',
  received_by_customer: 'Picked up', canceled: 'Canceled',
}[stage], {
  received: '已接单', quote_pending: '待报价', approval_pending: '待顾客确认', revision_requested: '请求修改', payment_pending: '待付款',
  in_production: '制作中', production_complete: '制作完成', received_by_customer: '已取货', canceled: '已取消',
}[stage], {
  received: '已接單', quote_pending: '待報價', approval_pending: '待顧客確認', revision_requested: '請求修改', payment_pending: '待付款',
  in_production: '製作中', production_complete: '製作完成', received_by_customer: '已取貨', canceled: '已取消',
}[stage]);

const paymentText = (locale: Locale, status: CustomOrderView['payment']['status']) => local(locale, paymentLabels[status], {
  unpaid: 'Unpaid', paid: 'Paid', canceled: 'Payment canceled', refunded: 'Refunded',
}[status], { unpaid: '未付款', paid: '已付款', canceled: '付款已取消', refunded: '已退款' }[status],
{ unpaid: '未付款', paid: '已付款', canceled: '付款已取消', refunded: '已退款' }[status]);

function memberIdentity(snapshot: DataSnapshot, memberId: string | null) {
  const profile = snapshot.tables.memberProfile.find(row => row.memberId === memberId);
  return profile && snapshot.tables.marketing.mktCustomer.find(row => row.customerId === profile.customerId && !row.deletedAt);
}

function customerName(snapshot: DataSnapshot, row: CustomOrderView, locale: Locale) {
  if (row.guest) return maskName(row.guest.name);
  const customer = memberIdentity(snapshot, row.memberId);
  if (!customer) return '';
  const { name, maskedName, maskKey } = customer;
  const masked = name ? maskCustomer({ name, maskKey }).name : maskedName ?? { key: maskKey };
  return typeof masked === 'string' ? masked : resolveDataText(tr(locale).t, masked);
}

function orderLabel(snapshot: DataSnapshot, row: CustomOrderView, locale: Locale) {
  return [orderNumber(row.customOrderId, row.orderNo), row.productLabel, customerName(snapshot, row, locale)].filter(Boolean).join(' · ');
}

function scopedOrderRows(snapshot: DataSnapshot, query: string, locale: Locale) {
  const normalized = key(query);
  if (!normalized) return [];
  const rows = select(snapshot).orders;
  const exact = rows.filter(row => [row.customOrderId, orderNumber(row.customOrderId, row.orderNo), row.productLabel,
    row.guest?.name ?? '', customerName(snapshot, row, locale), memberIdentity(snapshot, row.memberId)?.name ?? '',
    row.pickup?.reservationId ?? ''].some(alias => key(alias) === normalized));
  if (exact.length) return exact;
  return rows.filter(row => normalized.length > 1 && key(row.productLabel).includes(normalized));
}

const isUnpaid = (row: CustomOrderView) => row.payment.status === 'unpaid' && row.stage !== 'canceled' && row.stage !== 'received_by_customer';
const paymentRequired = (row: CustomOrderView) => row.payment.amountSettled > row.payment.amountReturned;
const approvalCurrent = (row: CustomOrderView) => row.customerDecision === 'approved' && row.approvedQuoteRevision === row.quoteRevision;
const orderFields = (row: CustomOrderView) => ({
  stage: row.stage, date: (row.confirmedPickupAt ?? row.desiredPickupAt).slice(0, 10), quoteRevision: row.quoteRevision,
  approvalCurrent: approvalCurrent(row), paymentReversalRequired: paymentRequired(row), paymentTiming: row.paymentTiming,
  paymentComplete: row.quoteAmount !== null && row.payment.amountSettled - row.payment.amountReturned === row.quoteAmount,
  ...(row.proposedPickupAt ? { proposedPickupAt: row.proposedPickupAt } : {}),
});

function orderSearch({ snapshot, query, locale }: RecordSearch) {
  return scopedOrderRows(snapshot, query, locale).map((row, i) => ({ row, handle: `custom-order-${i + 1}` }));
}
const orderReader: RecordAdapter = {
  kind: 'customOrder',
  search(input) {
    return orderSearch(input).map(({ row, handle }) => ({ handle, match: 'exact',
      ...(!input.privateLookup ? { label: orderLabel(input.snapshot, row, input.locale).slice(0, 180) } : {}),
      fields: orderFields(row),
    }));
  },
  resolve: (input, handle) => orderSearch(input).find(match => match.handle === handle)?.row.customOrderId,
  describe(match, locale, input) {
    const hit = input && orderSearch(input).find(row => row.handle === match.handle);
    if (!hit || !input) return match.label;
    const { row } = hit;
    return [orderLabel(input.snapshot, row, locale), stageText(locale, row.stage), paymentText(locale, row.payment.status),
      row.quoteAmount === null ? '' : tr(locale).format.money(row.quoteAmount, 'full'),
      row.pickup?.status === 'confirmed' ? row.confirmedPickupAt?.replace('T', ' ') : undefined].filter(Boolean).join(' · ');
  },
};

function templateSearch({ snapshot, query }: RecordSearch) {
  const value = key(query);
  const templates = select(snapshot).templates;
  const exact = templates.filter(template => [template.templateId, template.name].some(alias => key(alias) === value));
  const matches = exact.length ? exact : templates.filter(template => value.length > 1 && key(template.name).includes(value));
  return matches.map((template, i) => ({ template, handle: `custom-template-${i + 1}` }));
}

const templateReader: RecordAdapter = {
  kind: 'customTemplate',
  search(input) {
    return templateSearch(input).map(({ template, handle }) => ({ handle, match: 'exact',
      ...(!input.privateLookup ? { label: template.name.slice(0, 180) } : {}),
    }));
  },
  resolve: (input, handle) => templateSearch(input).find(match => match.handle === handle)?.template.templateId,
  describe: match => match.label,
};

function pickupSearch(input: RecordSearch) {
  return scopedOrderRows(input.snapshot, input.query, input.locale)
    .flatMap(row => row.pickup ? [{ row, pickup: row.pickup }] : [])
    .map((item, i) => ({ ...item, handle: `pickup-${i + 1}` }));
}

const pickupReader: RecordAdapter = {
  kind: 'reservation',
  search(input) {
    return pickupSearch(input).map(({ row, pickup, handle }) => ({ handle, match: 'exact',
      ...(!input.privateLookup ? { label: orderLabel(input.snapshot, row, input.locale).slice(0, 180) } : {}),
      fields: { kind: 'pickup', date: pickup.date, time: pickup.time, status: pickup.status, paymentReversalRequired: paymentRequired(row) },
    }));
  },
  resolve: (input, handle) => pickupSearch(input).find(match => match.handle === handle)?.pickup.reservationId,
  describe: match => [match.fields?.date, match.fields?.time].filter(Boolean).join(' '),
};

/** Keep visit and pickup lookups on their own selectors on the shared reservation tool. */
export function withCustomPickup(booking: DomainAdapter): DomainAdapter {
  const selectReader = (visit: RecordAdapter, input: RecordSearch) =>
    input.command?.startsWith('pickup.') || input.querySlot === 'pickup' ? pickupReader : visit;
  return { ...booking, reads: booking.reads.map(visit => visit.kind !== 'reservation' ? visit : {
    kind: 'reservation',
    search: input => selectReader(visit, input).search(input),
    resolve: (input, handle) => selectReader(visit, input).resolve?.(input, handle),
    describe: (match, locale, input) => (match.fields?.kind === 'pickup' ? pickupReader : visit).describe?.(match, locale, input),
  }) };
}

const orderFact = (id: string, field: string) => `custom.order.${id}.${field}`;

function widgetProjection(snapshot: DataSnapshot, locale: Locale) {
  const model = select(snapshot);
  const today = snapshot.pos?.businessDate ?? TODAY;
  const tomorrow = addDays(today, 1);
  const formatted = tr(locale).format;
  const quantity = (n: number) => local(locale, `${formatted.number(n)}건`, formatted.number(n), `${formatted.number(n)}笔`, `${formatted.number(n)}筆`);
  const make = (key: string, value: string | number, label: string, display: string, unit = 'text', date?: string): AgentFact =>
    ({ key: key.slice(0, 100), value: typeof value === 'string' ? value.slice(0, 500) : value,
      label: label.slice(0, 250), display: display.slice(0, 500), unit, ...(date ? { date } : {}) });
  const sum = (key: string, n: number, label: string, date?: string) => make(key, n, label, quantity(n), 'count', date);
  const rows = model.orders.flatMap(row => {
    const id = row.customOrderId;
    const label = orderLabel(snapshot, row, locale);
    const amount = row.quoteAmount === null ? '' : tr(locale).format.money(row.quoteAmount, 'full');
    const stage = stageText(locale, row.stage), payment = paymentText(locale, row.payment.status);
    return [
      make(orderFact(id, 'row'), row.productLabel, label, [stage, amount, payment, row.pickup?.status === 'confirmed' && row.confirmedPickupAt?.replace('T', ' ')].filter(Boolean).join(' · ')),
      make(orderFact(id, 'stage'), row.stage, orderNumber(id, row.orderNo), stage),
      make(orderFact(id, 'payment'), row.payment.status, orderNumber(id, row.orderNo), payment),
      ...(row.quoteAmount === null ? [] : [make(orderFact(id, 'quote'), row.quoteAmount, orderNumber(id, row.orderNo), amount, 'KRW')]),
      make(orderFact(id, 'desiredPickup'), row.desiredPickupAt, local(locale, '희망 픽업', 'Requested pickup', '希望取货', '希望取貨'),
        row.desiredPickupAt.replace('T', ' '), 'datetime', row.desiredPickupAt.slice(0, 10)),
      ...(row.pickup?.status === 'confirmed' ? [make(orderFact(id, 'pickup'), row.pickup.time, label, row.pickup.time, 'time', row.pickup.date)] : []),
    ];
  });
  const next = model.orders.filter(row => row.pickup?.status === 'confirmed' && row.confirmedPickupAt
    && row.confirmedPickupAt >= `${today}T${NOW.slice(11, 16)}`).sort((a, b) => a.confirmedPickupAt!.localeCompare(b.confirmedPickupAt!))[0];
  const { summary } = model;
  const unpaidCount = model.orders.filter(isUnpaid).length;
  return [
    sum('custom.active.count', summary.inProgress, local(locale, '진행 중', 'In progress', '进行中', '進行中'), today),
    sum('custom.unpaid.count', unpaidCount, local(locale, '결제 전', 'Unpaid', '未付款', '未付款')),
    sum('custom.approvalPending.count', summary.approvalPending, local(locale, '승인 대기', 'Awaiting approval', '待确认', '待確認'), today),
    sum('pickup.today.count', summary.todayPickup, local(locale, '오늘 픽업', 'Today’s pickups', '今日取货', '今日取貨'), today),
    sum('pickup.tomorrow.count', summary.tomorrowPickup, local(locale, '내일 픽업', 'Tomorrow’s pickups', '明日取货', '明日取貨'), tomorrow),
    sum('pickup.today.incomplete.count', summary.todayNotComplete, local(locale, '오늘 픽업 제작 미완료', 'Today’s unfinished pickups', '今日取货未做完', '今日取貨未做完'), today),
    ...(next?.confirmedPickupAt ? [make('pickup.next', next.confirmedPickupAt, local(locale, '다음 픽업', 'Next pickup', '下次取货', '下次取貨'),
      next.confirmedPickupAt.replace('T', ' '), 'datetime', next.pickup?.date)] : []),
    ...(!next ? [sum('pickup.upcoming.count', 0, local(locale, '앞으로 픽업', 'Upcoming pickups', '待取货', '待取貨'))] : []),
    sum('custom.template.count', model.templates.length, local(locale, '템플릿', 'Templates', '模板', '範本')),
    ...model.templates.flatMap(template => [
      make(`custom.template.${template.templateId}.name`, template.name, local(locale, '템플릿', 'Template', '模板', '範本'), template.name),
      ...template.fields.map(field => make(`custom.template.${template.templateId}.field.${field.fieldId}`,
        field.label, template.name, [field.label, ...field.options.map(option => option.extraAmount
          ? `${option.label} +${formatted.money(option.extraAmount, 'full')}` : option.label)].join(' · '))),
    ]),
    ...rows,
  ];
}

const types = ['customOrder.create', 'customOrder.update', 'customOrder.quote', 'customOrder.recordDecision',
  'customOrder.setStage', 'customOrder.receive', 'customOrder.cancel', 'pickup.reschedule', 'pickup.cancel',
  'customTemplate.generate', 'customTemplate.save', 'customTemplate.delete'] as const;
type CustomType = typeof types[number];
type ChatCommand = Extract<CustomOrderCommand, { type: CustomType }>;

const validators = {
  name: filled, templateId: filled, memberQuery: filled, guestName: filled, phone: (v: unknown) => str(v) && /^\d{10,11}$/u.test(v),
  productKind: filled, productLabel: filled, templateName: filled, keywords: shortText, request: shortText,
  answers: object, fields: Array.isArray, quantity: count, quoteAmount: count, quoteRevision: count,
  desiredPickupAt: filled, proposedPickupAt: filled, date: isIsoDate, time: filled,
};

function expand(value: unknown, slots: LocalSlots, targets: RecordTargets): unknown {
  if (Array.isArray(value)) return value.map(item => expand(item, slots, targets));
  if (!object(value)) return value;
  if (typeof value.slot === 'string' && Object.keys(value).length === 1) return slots[value.slot];
  if (typeof value.handle === 'string' && Object.keys(value).length === 1) return targets.get(value.handle)?.id;
  return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, expand(child, slots, targets)]));
}

const cash = (locale: Locale, amount: number | null | undefined) => amount == null ? '' : tr(locale).format.money(amount, 'full');
const timingText = (locale: Locale, timing: CustomOrderView['paymentTiming']) => timing === 'advance'
  ? local(locale, '미리 결제', 'Pay in advance', '提前付款', '提前付款')
  : local(locale, '받을 때 결제', 'Pay at pickup', '取货时付款', '取貨時付款');

function preview(snapshot: DataSnapshot, read: CustomOrderRead, after: CustomOrderRead, result: { customOrderId?: string; templateId?: string }, locale: Locale) {
  const beforeRows = selectCustomOrders(read), afterRows = selectCustomOrders(after);
  const before = beforeRows.orders.find(row => row.customOrderId === result.customOrderId);
  const next = afterRows.orders.find(row => row.customOrderId === result.customOrderId);
  const oldTemplate = beforeRows.templates.find(row => row.templateId === result.templateId);
  const newTemplate = afterRows.templates.find(row => row.templateId === result.templateId);
  const fields: { label: string; before: string; after: string }[] = [];
  const add = (label: string, beforeValue: string | number | null | undefined, afterValue: string | number | null | undefined) => {
    if (beforeValue !== afterValue) fields.push({ label, before: String(beforeValue ?? '—') || '—', after: String(afterValue ?? '—') || '—' });
  };
  if (next) {
    if (before) fields.push({ label: local(locale, '주문', 'Order', '订单', '訂單'),
      before: orderNumber(before.customOrderId, before.orderNo), after: orderNumber(next.customOrderId, next.orderNo) });
    add(local(locale, '상품', 'Product', '商品', '商品'), before?.productLabel, next.productLabel);
    add(local(locale, '손님', 'Customer', '顾客', '顧客'), before && customerName(snapshot, before, locale), customerName(snapshot, next, locale));
    add(local(locale, '연락처', 'Contact', '联系方式', '聯絡方式'), before?.guest && maskPhone(before.guest.phone), next.guest && maskPhone(next.guest.phone));
    add(local(locale, '진행 상태', 'Status', '状态', '狀態'), before && stageText(locale, before.stage), stageText(locale, next.stage));
    add(local(locale, '수량', 'Quantity', '数量', '數量'), before?.quantity, next.quantity);
    add(local(locale, '요청사항', 'Request', '要求', '要求'), before?.request, next.request);
    add(local(locale, '접수 경로', 'Channel', '接单渠道', '接單管道'), before && channelLabels[before.channel], channelLabels[next.channel]);
    add(local(locale, '견적 금액', 'Quote', '报价', '報價'), cash(locale, before?.quoteAmount), cash(locale, next.quoteAmount));
    add(local(locale, '견적 픽업', 'Quoted pickup', '报价取货', '報價取貨'), before?.proposedPickupAt, next.proposedPickupAt);
    add(local(locale, '희망 픽업', 'Requested pickup', '希望取货', '希望取貨'), before?.desiredPickupAt, next.desiredPickupAt);
    const confirmed = (row: CustomOrderView | undefined) => row?.pickup?.status === 'confirmed' ? row.confirmedPickupAt : null;
    add(local(locale, '확정 픽업', 'Confirmed pickup', '已确认取货', '已確認取貨'), confirmed(before), confirmed(next));
    add(local(locale, '결제 시점', 'Payment timing', '付款时间', '付款時間'), before && timingText(locale, before.paymentTiming), timingText(locale, next.paymentTiming));
    for (const field of next.templateSnapshot.fields) {
      const display = (value: string | readonly string[] | undefined) => value === undefined ? undefined
        : (typeof value === 'string' ? [value] : value).map(id => field.options.find(option => option.optionId === id)?.label ?? id).join(', ');
      add(field.label, display(before?.answers[field.fieldId]), display(next.answers[field.fieldId]));
    }
  } else {
    add(local(locale, '템플릿 이름', 'Template name', '模板名称', '範本名稱'), oldTemplate?.name, newTemplate?.name);
    add(local(locale, '입력 항목', 'Fields', '字段', '欄位'), oldTemplate?.fields.length, newTemplate?.fields.length);
  }
  return { title: local(locale, '주문제작', 'Custom orders', '定制订单', '客製訂單'),
    target: next ? orderLabel(snapshot, next, locale) : newTemplate?.name ?? oldTemplate?.name, fields };
}

type Draft = { args: Record<string, unknown>; locale: Locale };
function commandAdapter(type: CustomType): RunCommandAdapter<Draft> {
  return {
    command: type, slots: validators,
    resolve(wire, slots, _snapshot, targets) {
      if (!validateAgentDraft(type, wire)) return;
      const args = expand(wire, slots, targets);
      if (object(args) && validateAgentCommandArgs(type, args) && agentCommandPolicy(type, args).policy === 'propose') {
        const locale = slots.navisLocale;
        return { args, locale: locale === 'en' || locale === 'zh-Hans' || locale === 'zh-Hant' ? locale : 'ko' };
      }
    },
    preflight({ args, locale }, { snapshot, idempotencyKey }) {
      if (typeof args.memberId === 'string' && !activeMember(snapshot, args.memberId)) return { kind: 'invalid', field: 'memberId' };
      // D-326 Q5: a card-pressed pickup is the reversible kind; the widget's own pickup keeps its closing receipt.
      const command = { type, ...args, idempotencyKey, baseRevision: snapshot.revision,
        ...(type === 'customOrder.receive' ? { reversiblePickup: true } : {}) } as ChatCommand;
      const read = selectCustomOrderRead(snapshot);
      const plan = planCustomOrderCommand(read, command);
      if (!plan.ok) return { kind: plan.code === 'CONFLICT' ? 'conflict' : 'invalid', field: plan.field, messageKey: plan.messageKey };
      if (!plan.changed) return { kind: 'unchanged' };
      // Only the pickup's own sale entry may book money here. Payments, refunds and corrections stay in their widgets.
      if (Object.entries(plan.moneyEffects).some(([kind, effects]) => effects.length > 0
        && !(type === 'customOrder.receive' && kind === 'recognitions'))) return { kind: 'invalid' };
      return {
        kind: 'ready', preview: preview(snapshot, read, { ...read, tables: plan.tables }, plan.value, locale),
        // HTTP builds run this same widget command through the data port: the card waits for the service's receipt and its undo is the receipt's.
        realCommand: Object.freeze({ ...command }), featureId,
        execute(_run, store) {
          if (!store || store.getSnapshot() !== snapshot) return { kind: 'conflict' };
          const result = store.dispatch(command);
          if (!result.ok) {
            const kind = result.reason === 'TRANSACTION_BUSY' ? 'busy'
              : result.code === 'CONFLICT' || result.code === 'NOT_FOUND' ? 'conflict' : 'invalid';
            return { kind, field: result.field, messageKey: result.messageKey };
          }
          if (result.duplicate || result.revision === snapshot.revision) return { kind: 'unchanged' };
          const { undoToken } = result;
          return {
            kind: 'applied',
            notice: { kind: 'success', featureId, messageKey: result.noticeKey ?? 'common.navis.agent.changeApplied' },
            ...(undoToken ? { undo: () => store.undo(undoToken).ok } : {}),
          };
        },
      };
    },
  };
}

const customWords = /주문\s*제작|맞춤\s*주문|케이크\s*주문|쿠키\s*(?:세트\s*)?주문|CO-\d+|CT-[\w-]+|픽업|쿠키\s*세트|주문서|답례품|템플릿/iu;
const templateWords = /주문서|양식|템플릿|CT-[\w-]+/iu;
const readWords = /알려|보여|몇|언제|어떻게\s*됐|어떤\s*상태|목록|내용|얼마|뭐야|있어|뭐\s*있/u;
const changeWords = /바꿔|늘려|줄여|수정|변경|고쳐|미뤄|되돌려|다시|처리|기록|해\s*줘|할게|됐어|다\s*만들|가져가|찾아갔|들어가/u;
const orderCode = /\b(?:PICKUP-)?CO-\d+\b/iu;
const explicitOrder = /CO-\d+|CT-[\w-]+|주문\s*제작|맞춤\s*주문|주문서|픽업/iu;
const endsAtVisit = (text: string) => /예약/u.test(text) && !explicitOrder.test(text);
const phonePattern = /(?<!\d)01[016789][ -]?\d{3,4}[ -]?\d{4}(?!\d)/u;
const maskedPattern = /[가-힣][○*●]{1,3}[가-힣]?/u;
const quotedText = /['“‘"]([^'”’"]+)['”’"]/gu;
const orderWording = (text: string) => /문구|요청\s*사항|메모/u.test(text) ? text.replace(quotedText, ' ') : text;
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const mentionsName = (text: string, name: string) => new RegExp(
  `(?<![가-힣])${escapePattern(name)}(?:님|씨)?(?:이랑|랑|하고|과|와|에게|한테|께|은|는|이|가|을|를|의|도|만)?(?![가-힣])`, 'u',
).test(text);

type OrderScope = { query?: string; rows: readonly CustomOrderView[]; multipleReferences?: boolean };

function orderScope(text: string, snapshot: DataSnapshot, locale: Locale): OrderScope {
  const input = orderWording(text);
  const references = [...new Set([...input.matchAll(/\b(?:PICKUP-)?(CO-\d+)\b/giu)].map(match => match[1].toUpperCase()))];
  if (references.length > 1) {
    return { query: references[0], rows: references.flatMap(id => scopedOrderRows(snapshot, id, locale)), multipleReferences: true };
  }
  const rows = select(snapshot).orders;
  const ownerAliases = (row: CustomOrderView) => [row.guest?.name, memberIdentity(snapshot, row.memberId)?.name, customerName(snapshot, row, locale)];
  const knownOwners = rows.flatMap(ownerAliases)
    .filter((name): name is string => !!name && key(name).length >= 2 && mentionsName(input, name));
  const unmatchedMasks = [...input.matchAll(new RegExp(maskedPattern, 'gu'))].map(match => match[0])
    .filter(name => !knownOwners.some(known => mentionsName(name, known)));
  const owners = [...new Set([...unmatchedMasks, ...knownOwners])];
  const ownedBy = (row: CustomOrderView, name: string) => ownerAliases(row).some(alias => alias && key(alias) === key(name));
  const compact = key(input);
  const product = rows.map(row => row.productLabel).filter(label => key(label).length >= 2 && compact.includes(key(label)))
    .sort((a, b) => b.length - a.length)[0] ?? /쿠키\s*세트|케이크|쿠키|답례품/u.exec(input)?.[0];
  const query = references[0] ?? owners[0] ?? product;
  if (!query) return { rows: [] };
  if (!references.length && owners.length > 1 && !rows.some(row => owners.every(name => ownedBy(row, name)))) {
    return { query, rows: rows.filter(row => owners.some(name => ownedBy(row, name))), multipleReferences: true };
  }
  return { query, rows: scopedOrderRows(snapshot, query, locale).filter(row =>
    owners.every(name => ownedBy(row, name))
    && (!product || key(row.productLabel).includes(key(product)))),
  };
}

function templateQuery(text: string, templates: readonly CustomTemplate[]) {
  const id = /\bCT-[\w-]+\b/iu.exec(text)?.[0];
  if (id) return id;
  const compact = key(text);
  return templates.filter(template => compact.includes(key(template.name))).sort((a, b) => b.name.length - a.name.length)[0]?.name
    ?? /케이크|답례품|쿠키|단체/u.exec(text)?.[0];
}

const clarifications = {
  name: ['어느 주문이에요?', 'Which order?', '哪一笔订单？', '哪一筆訂單？'],
  templateId: ['어느 주문서예요?', 'Which order form?', '哪张订单表？', '哪張訂單表？'],
  productKind: ['어떤 상품의 주문서예요?', 'What product is the form for?', '订单表用于什么商品？', '訂單表用於什麼商品？'],
  productLabel: ['어떤 상품이에요?', 'Which product?', '什么商品？', '什麼商品？'],
  quantity: ['수량을 한 개 이상 알려 주세요.', 'Enter a quantity of at least one.', '数量至少为一。', '數量至少為一。'],
  phone: ['손님 연락처를 알려 주세요.', 'What’s the customer’s phone number?', '顾客的联系电话是？', '顧客的聯絡電話是？'],
  guestName: ['손님 이름을 알려 주세요.', 'What’s the customer’s name?', '顾客姓名是？', '顧客姓名是？'],
  channel: ['전화, 메시지, 방문 중 어떻게 받았어요?', 'Was it by phone, message or in person?', '通过电话、消息还是到店接单？', '透過電話、訊息還是到店接單？'],
  date: ['픽업 날짜를 알려 주세요.', 'What’s the pickup date?', '取货日期是？', '取貨日期是？'],
  time: ['픽업 시각을 30분 단위로 알려 주세요.', 'Choose a pickup time in half-hour steps.', '请选择整点或半点取货。', '請選擇整點或半點取貨。'],
  quoteAmount: ['견적 금액을 1원 이상 알려 주세요.', 'Enter a quote of at least one won.', '报价至少为 1 韩元。', '報價至少為 1 韓元。'],
  request: ['요청사항을 알려 주세요.', 'What’s the request?', '有什么要求？', '有什麼要求？'],
  paymentTiming: ['미리 결제할까요, 받을 때 결제할까요?', 'Pay in advance or at pickup?', '提前付款还是取货时付款？', '提前付款還是取貨時付款？'],
  templateName: ['새 주문서 이름을 알려 주세요.', 'What’s the new form name?', '新的订单表名称是？', '新的訂單表名稱是？'],
  fields: ['항목 이름과 선택지를 알려 주세요.', 'What are the field name and options?', '字段名称和选项是？', '欄位名稱和選項是？'],
} as const;

function ask(field: keyof typeof clarifications, locale: Locale, resume?: (value: string) => DomainRoute | undefined): Extract<DomainRoute, { kind: 'clarification' }> {
  const [ko, en, hans, hant] = clarifications[field];
  return { kind: 'clarification', field, answer: local(locale, ko, en, hans, hant), ...(resume ? { resume } : {}) };
}

function answer(locale: Locale, ko: string, en: string, hans: string, hant: string): DomainRoute {
  return { kind: 'answer', answer: local(locale, ko, en, hans, hant) };
}

function widgetOnly(command: 'customOrder.receive' | 'customOrder.openPayment' | 'customOrder.openRefund', row: CustomOrderView | undefined,
  locale: Locale, copy: readonly [string, string, string, string]): DomainRoute {
  return {
    kind: 'refusal', reason: 'widget_only', answer: local(locale, ...copy),
    ...(row || command !== 'customOrder.receive' ? { alternative: { featureId, command,
      draft: row ? { customOrderId: row.customOrderId } : {} } } : {}),
  };
}

const missingOrder = (locale: Locale): DomainRoute => ({
  kind: 'refusal', reason: 'invalid_target',
  answer: local(locale, '그 주문이 없어요.', 'No matching order.', '没有这笔订单。', '沒有這筆訂單。'),
});
const invalidStage = (locale: Locale): DomainRoute => ({
  kind: 'refusal', reason: 'unsupported',
  answer: local(locale, '지금 상태에서는 바꿀 수 없어요.', 'That change is unavailable at this stage.', '当前状态下无法更改。', '目前狀態下無法更改。'),
});
const approvalNeeded = (locale: Locale): DomainRoute => ({
  kind: 'refusal', reason: 'unsupported',
  answer: local(locale, '손님 승인을 먼저 기록해 주세요.', 'Record the customer’s approval first.', '请先记录顾客的确认。', '請先記錄顧客的確認。'),
});
const missingPickup = (locale: Locale): DomainRoute => ({
  kind: 'refusal', reason: 'unsupported',
  answer: local(locale, '확정된 픽업이 없어요. 희망 픽업이나 견적을 바꿀 수 있어요.', 'There’s no confirmed pickup. You can change the requested pickup or the quote.',
    '没有已确认的取货安排。可以更改希望取货时间或报价。', '沒有已確認的取貨安排。可以更改希望取貨時間或報價。'),
});
const past = (locale: Locale): DomainRoute => ({
  kind: 'refusal', reason: 'unsupported',
  answer: local(locale, '지난 시간은 픽업으로 잡을 수 없어요.', 'Pickup must be in the future.', '不能安排已过去的取货时间。', '不能安排已過去的取貨時間。'),
});

const paymentCopy = ['주문제작에서 결제해 주세요.', 'Take payment in Custom orders.', '请在定制订单中收款。', '請在客製訂單中收款。'] as const;
const refundCopy = ['주문제작에서 환불을 확인해 주세요.', 'Review the refund in Custom orders.', '请在定制订单中确认退款。', '請在客製訂單中確認退款。'] as const;

const wire = (command: AgentKnownCommand, args: AgentWireArgs, slots: LocalSlots = {},
  lookups: DomainTurnInput['lookups'] = []): DomainTurnInput =>
  ({ intent: { kind: 'command', command, args, ...(lookups.length ? { querySlot: lookups[0].querySlot } : {}) }, slots, lookups });

function orderAction(command: CustomType, query: string, args: AgentWireArgs = {}, slots: LocalSlots = {}) {
  return wire(command, args, { ...slots, name: query }, [{ kind: command.startsWith('pickup.') ? 'reservation' : 'customOrder',
    querySlot: 'name', bind: [command.startsWith('pickup.') ? 'reservationId' : 'customOrderId'] }]);
}

function pickupMoment(text: string, today: string, fallbackDate?: string) {
  const raw = text.replace(phonePattern, ' ').replace(/([가-힣])(?=\d{1,2}시)/gu, '$1 ').replace(/(오늘|내일|모레|어제)(?=\d)/gu, '$1 ');
  const clockText = raw.replace(/(?<!\d)(?:\d{4}[-./])?\d{1,2}[-./]\d{1,2}(?!\d)|\d{1,2}\s*월\s*\d{1,2}\s*일/gu, ' ');
  const minute = /\d{1,2}\s*시\s*(\d{1,2})\s*분/u.exec(clockText)?.[1];
  const relative = /오늘|내일|모레|글피|어제|그저께|요일|(?:이번|다음|지난|저번)\s*달|\d{1,2}\s*월|\d{1,4}[/.-]\d{1,2}/u.test(raw);
  const date = parseNavisDate(raw, today) ?? (relative ? undefined : fallbackDate);
  let time = parseNavisTime(clockText, `${today}T${NOW.slice(11, 16)}`);
  if (time && minute) time = Number(minute) < 60 ? `${time.slice(0, 2)}:${minute.padStart(2, '0')}` : undefined;
  // Daytime pickup shorthand such as “3시” maps to 15:00. Explicit meridiem and 24-hour time retain their meaning.
  if (time && !/오전|오후|\d{1,2}:\d{2}|\b0\d\s*시/u.test(clockText) && Number(time.slice(0, 2)) >= 1 && Number(time.slice(0, 2)) <= 7) {
    time = `${12 + Number(time.slice(0, 2))}${time.slice(2)}`;
  }
  return { date, time };
}

function parsedQuantity(text: string): number | undefined {
  const match = /(?:수량\s*|[x×]\s*)(-?\d+)|(-?\d+|영|한|두|세|네|하나|둘|셋)\s*(?:개|박스|상자)(?![가-힣])/iu.exec(text)
    ?? /(-?\d+|영|한|두|세|네)\s*(?:개|박스|상자)(?=로|를|만)/u.exec(text);
  if (match) return parseNavisNumber(match[1] ?? match[2]);
  return /한\s*개|하나/u.test(text) ? 1 : undefined;
}

function completePickup({ date, time }: ReturnType<typeof pickupMoment>, today: string, locale: Locale,
  ready: (date: string, time: string) => DomainRoute): DomainRoute {
  if (!date) return ask('date', locale, value => {
    const next = pickupMoment(value, today);
    return next.date ? completePickup({ date: next.date, time: next.time ?? time }, today, locale, ready) : undefined;
  });
  if (!time || !['00', '30'].includes(time.slice(3))) return ask('time', locale, value => {
    const next = pickupMoment(value, today, date);
    return next.date && next.time ? completePickup(next, today, locale, ready) : undefined;
  });
  return ready(date, time);
}

const orderInput = /접수|주문\s*(?:받았|들어왔)|주문\s*하나|주문제작\s*새로|또\s*케이크\s*주문/u;
const channel = (text: string) => /전화/u.test(text) ? 'phone' : /메시지|카톡|문자/u.test(text) ? 'message' : /방문/u.test(text) ? 'visit' : undefined;
const exactQuote = (text: string) => text.matchAll(quotedText).next().value?.[1]?.trim();

function guestNameFrom(text: string, phone: string) {
  const beforePhone = text.slice(0, text.indexOf(phone));
  const adjacentName = /(?<![가-힣])([가-힣]{2,4}?)(?:\s*(?:손님|님|씨))?\s*[/,:·]?\s*$/u.exec(beforePhone)?.[1];
  return /(?:이름|성함)\s*[:：]?\s*([가-힣]{2,4})(?![가-힣])/u.exec(text)?.[1]
    ?? (adjacentName && !/^(?:전화|메시지|카톡|문자|방문|연락처|전화번호|휴대폰|핸드폰|번호|픽업|주문|접수)$/u.test(adjacentName) ? adjacentName : undefined)
    ?? /(?:축하해요|감사해요)\s+([가-힣]{2,4}?)\s*(?:손님|님|씨)?\s+(?:전화|메시지|카톡|문자|방문)/u.exec(beforePhone)?.[1];
}

function askTemplateAnswer(field: CustomTemplateField, today: string, locale: Locale,
  ready: (value: string | readonly string[]) => DomainRoute): DomainRoute {
  const choices = field.input === 'single' ? field.options.map(option => ({ id: option.optionId, label: option.label })) : undefined;
  const options = field.options.map(option => option.extraAmount
    ? `${option.label}(+${tr(locale).format.money(option.extraAmount, 'full')})` : option.label).join(' / ');
  const label = options ? `${field.label} (${options})` : field.label;
  return {
    kind: 'clarification', field: 'answers',
    answer: local(locale, `필수 항목 ‘${label}’을 알려 주세요.`, `Fill in the required field “${label}”.`,
      `请填写必填项“${label}”。`, `請填寫必填項「${label}」。`),
    ...(choices ? { choices } : {}),
    resume(value) {
      if (field.input === 'single') return field.options.some(option => option.optionId === value) ? ready(value) : undefined;
      if (field.input === 'multiple') {
        const names = value.split(/\s*[,/·]\s*/u).map(key);
        const selected = field.options.filter(option => names.includes(key(option.label))).map(option => option.optionId);
        return selected.length === names.length ? ready(selected) : undefined;
      }
      if (field.input === 'datetime') {
        const { date, time } = pickupMoment(value, today);
        return date && time ? ready(`${date}T${time}`) : undefined;
      }
      return filled(value) ? ready(value.trim()) : undefined;
    },
  };
}

function orderCreate(text: string, snapshot: DataSnapshot, locale: Locale,
  givenAnswers: Readonly<Record<string, string | readonly string[]>> = {}, givenGuestName?: string): DomainRoute {
  const { templates } = select(snapshot);
  const today = snapshot.pos?.businessDate ?? TODAY;
  const input = text.replace(quotedText, ' ');
  const resume = (value: string) => orderCreate(`${text} ${value}`, snapshot, locale, givenAnswers, givenGuestName);
  const product = /(?:레터링\s*)?(?:생크림\s*)?케이크(?:\s*\d+\s*호)?|레터링\s*\d+\s*호|(?:수제\s*)?쿠키(?:\s*세트)?|(?:답례\s*)?소금빵|카페라떼/u.exec(input)?.[0];
  const explicitSized = /(?:레터링\s*)?(?:생크림\s*)?케이크\s*\d+\s*호|레터링\s*\d+\s*호/u.exec(input)?.[0];
  const productLabel = explicitSized ?? product;
  const selectedChannel = channel(input), quantity = parsedQuantity(input);
  const moment = pickupMoment(input, today);
  const phone = phonePattern.exec(input)?.[0];
  const guestName = givenGuestName ?? (phone && guestNameFrom(input, phone));
  const contact = phone ? normalizeMemberPhone(phone) : undefined;
  const liveMember = snapshot.tables.marketing.mktCustomer.find(row => !row.deletedAt && row.name
    && (!contact || row.phone && normalizeMemberPhone(row.phone) === contact)
    && mentionsName(input, row.name)
    && snapshot.tables.memberProfile.some(member => member.customerId === row.customerId));
  const scopedMember = contact && liveMember && snapshot.tables.memberProfile.find(member => member.customerId === liveMember.customerId);
  const memberQuery = scopedMember ? scopedMember.memberId : liveMember?.name;
  if (!productLabel) return ask('productLabel', locale, resume);
  const productType = /케이크|레터링/u.test(productLabel) ? '케이크' : /쿠키/u.test(productLabel) ? '답례품' : productLabel;
  const template = templates.find(row => key(row.name).includes(key(productType))) ?? (templates.length === 1 ? templates[0] : undefined);
  if (!template) return ask('templateId', locale, resume);
  if (!quantity || quantity < 1) return ask('quantity', locale, value => orderCreate(`${text.replace(/(?:수량\s*|[x×]\s*)-?\d+|(?:-?\d+|영)\s*(?:개|박스|상자)/giu, '')} 수량 ${value}`, snapshot, locale, givenAnswers, givenGuestName));
  if (moment.date && (moment.date < today || moment.time && `${moment.date}T${moment.time}` < `${today}T${NOW.slice(11, 16)}`)) return past(locale);
  if (!memberQuery && !phone) {
    const question = ask('phone', locale, resume);
    return /단골|회원/u.test(input) ? { ...question, answer: local(locale,
      '일치하는 회원이 없어요. 비회원으로 접수하려면 연락처를 알려 주세요.', 'No member matched. Enter a phone number to register a guest order.',
      '没有匹配的会员。若要登记访客订单，请提供联系电话。', '沒有相符的會員。若要登記訪客訂單，請提供聯絡電話。') } : question;
  }
  if (!memberQuery && !guestName) return ask('guestName', locale, value => filled(value)
    ? orderCreate(text, snapshot, locale, givenAnswers, value.trim()) : undefined);

  const answers: Record<string, string | readonly string[]> = { ...givenAnswers };
  const message = exactQuote(text) ?? /문구\s*[:：]?\s*(.+?)(?=\s*(?:레터링|생크림\s*케이크|크기는|크기\s*기본|기본|크게|초\s*(?:추가|\d)|전화|메시지|카톡|방문|오늘|내일|모레|어제|\d{1,2}\s*월|[가-힣]{2,4}\s+01\d)|$)/u.exec(input)?.[1]?.trim()
    ?? /(?:생일\s*)?축하해요|감사해요/u.exec(input)?.[0];
  for (const field of template.fields) {
    if (answers[field.fieldId] !== undefined) continue;
    if (field.input === 'text' && /문구/u.test(field.label) && message) answers[field.fieldId] = message;
    if (field.input === 'single') {
      const options = field.options.filter(item => key(input).includes(key(item.label)));
      if (options.length === 1) answers[field.fieldId] = options[0].optionId;
    }
    if (field.input === 'multiple') {
      const options = field.options.filter(item => key(input).includes(key(item.label))).map(item => item.optionId);
      if (options.length) answers[field.fieldId] = options;
    }
    if (field.required && !answers[field.fieldId]) return askTemplateAnswer(field, today, locale, value =>
      orderCreate(text, snapshot, locale, { ...answers, [field.fieldId]: value }, givenGuestName));
  }
  if (!selectedChannel) return ask('channel', locale, resume);
  return completePickup(moment, today, locale, (date, time) => {
    const desiredPickupAt = `${date}T${time}`;
    if (desiredPickupAt < `${today}T${NOW.slice(11, 16)}`) return past(locale);
    return wire('customOrder.create', {
      answers: slot('answers'), productLabel: slot('productLabel'), quantity: slot('quantity'), channel: selectedChannel,
      desiredPickupAt: slot('desiredPickupAt'), ...(!memberQuery ? { guest: { name: slot('guestName'), phone: slot('phone') } } : {}),
    }, { templateId: template.templateId, productLabel, quantity, desiredPickupAt, answers,
      ...(memberQuery ? { memberQuery } : { guestName: guestName!, phone: contact! }),
    }, [
      { kind: 'customTemplate', querySlot: 'templateId', bind: ['templateId'] },
      ...(memberQuery ? [{ kind: 'member' as const, querySlot: 'memberQuery', bind: ['memberId'] }] : []),
    ]);
  });
}

function templateAction(text: string, snapshot: DataSnapshot, locale: Locale): DomainRoute | undefined {
  const templates = select(snapshot).templates;
  const query = templateQuery(text, templates);
  const matches = query && templateSearch({ snapshot, query, locale, privateLookup: true });
  const template = matches && matches.length === 1 ? matches[0].template : undefined;
  if (/지워|삭제/u.test(text)) {
    if (!query) return ask('templateId', locale, value => templateAction(`${text} ${value}`, snapshot, locale));
    return wire('customTemplate.delete', {}, { name: query }, [{ kind: 'customTemplate', querySlot: 'name', bind: ['templateId'] }]);
  }
  if (/이름/u.test(text) && /바꿔|변경|수정|고쳐/u.test(text)) {
    if (!query) return ask('templateId', locale);
    const name = exactQuote(text) ?? /(?:이름\s*(?:을\s*)?(?:변경|수정|고쳐)\s*)(.+)$/u.exec(text)?.[1]?.trim();
    if (!name) return ask('templateName', locale, value => templateAction(`${text} '${value}'`, snapshot, locale));
    if (!template) return ask('templateId', locale);
    return wire('customTemplate.save', { name: slot('templateName'), fields: slot('fields') }, { name: query, templateName: name,
      fields: template.fields.map(field => ({ ...field, options: field.options.map(option => ({ ...option })) })) }, [
      { kind: 'customTemplate', querySlot: 'name', bind: ['templateId'] },
    ]);
  }
  if (/항목.*(?:추가|넣어)|입력\s*항목/u.test(text) && /추가|넣어/u.test(text)) return ask('fields', locale);
  if (/생성|만들어|만들래|만들기/u.test(text) && !readWords.test(text)) {
    // "포장 쿠키 주문제작 양식 견본 만들어줘": a sample/format word may sit between the form word and the verb, and the product is what precedes "주문제작".
    const named = /^\s*(.*?)\s*(?:주문서|템플릿|양식|서식)\s*(?:(?:견본|샘플|예시)\s*)?(?:템플릿\s*)?(?:AI로\s*)?(?:하나\s*)?(?:만들|생성)/u.exec(text)?.[1]?.trim();
    const productKind = named?.replace(/\s*(?:주문\s*제작|맞춤\s*(?:주문)?)$/u, '').trim();
    if (!productKind || /^(?:주문제작|맞춤)$/u.test(productKind)) return ask('productKind', locale, value => templateAction(`${value} 주문서 만들어줘`, snapshot, locale));
    const keywords = /키워드(?:는|로)?\s*[:：]?\s*(.+)$/u.exec(text)?.[1]?.trim()
      ?? /(?:만들어\s*줘|생성)\s+(.+)$/u.exec(text)?.[1]?.trim() ?? '';
    return wire('customTemplate.generate', { productKind: slot('productKind'), keywords: slot('keywords') }, { productKind, keywords });
  }
}

function checkOrderWrite(snapshot: DataSnapshot, row: CustomOrderView, command: ChatCommand | ReversiblePickupCommand, locale: Locale,
  proposed: () => DomainRoute): DomainRoute {
  const result = planCustomOrderCommand(selectCustomOrderRead(snapshot), command);
  if (result.ok) return result.changed ? proposed() : answer(locale, '이미 기록했어요.', 'Already recorded.', '已经记录了。', '已經記錄了。');
  if (result.reason === 'BOOKING_PAST') return past(locale);
  if (result.reason === 'PAYMENT_REVERSAL_REQUIRED') return widgetOnly('customOrder.openRefund', row, locale, refundCopy);
  if (result.reason === 'PAYMENT_REQUIRED') return widgetOnly('customOrder.openPayment', row, locale, paymentCopy);
  if (result.reason === 'APPROVAL_REQUIRED') return approvalNeeded(locale);
  if (result.reason === 'QUOTE_REISSUE_REQUIRED' || command.type === 'customOrder.recordDecision' && result.field === 'proposedPickupAt') {
    return { kind: 'refusal', reason: 'unsupported', answer: local(locale, '견적을 먼저 기록해 주세요.',
      'Record the quote first.', '请先记录报价。', '請先記錄報價。') };
  }
  return invalidStage(locale);
}

const receiveWords = /수령\s*(?:완료|처리|했)|찾아갔|가져가(?:셨어|신)/u;
const cancelWords = /취소|캔슬/u;
const stageWords = /제작\s*(?:시작|완료|중|다\s*됐|들어가)|다\s*만들/u;
const paidWords = /아직\s*결제\s*안|결제\s*전|미결제/u;
const approvalWords = /승인(?:했|됐|으로|\s*기록|\s*다시|\s*받을|\s*미리|\s*선결제|\s*취소)|거절|수정(?:해\s*달|\s*요청)/u;
const pickupWords = /픽업|찾으러\s*(?:와|오|온)/u;

function orderChange(text: string, snapshot: DataSnapshot, locale: Locale, scope: OrderScope): DomainRoute | undefined {
  const today = snapshot.pos?.businessDate ?? TODAY;
  const wording = orderWording(text);
  const resume = (value: string) => orderChange(`${text} ${value}`, snapshot, locale, scope);
  const requireTarget = (run: (query: string, row: CustomOrderView) => DomainRoute): DomainRoute => {
    if (!scope.query || scope.multipleReferences || scope.rows.length > 1) return ask('name', locale, value => {
      const next = orderScope(value, snapshot, locale);
      if (!next.query || next.multipleReferences || !next.rows.length) return undefined;
      const rows = scope.rows.length ? next.rows.filter(row => scope.rows.some(candidate => candidate.customOrderId === row.customOrderId)) : next.rows;
      return rows.length ? orderChange(text, snapshot, locale, { ...next, rows }) : undefined;
    });
    const [row] = scope.rows;
    return row ? run(row.customOrderId, row) : missingOrder(locale);
  };
  const check = (row: CustomOrderView, command: ChatCommand | ReversiblePickupCommand, proposed: () => DomainRoute) =>
    checkOrderWrite(snapshot, row, command, locale, proposed);
  const idem = 'navis-preview';

  if (/환불/u.test(wording)) return requireTarget((_name, row) => widgetOnly('customOrder.openRefund', row, locale, refundCopy));
  if (/결제\s*(?:받|해\s*줘|처리|완료로)|카드로\s*결제/u.test(wording)) return requireTarget((_name, row) => widgetOnly('customOrder.openPayment', row, locale, paymentCopy));
  if (receiveWords.test(wording) && !readWords.test(wording)) return requireTarget((name, target) => target.stage === 'received_by_customer'
    ? answer(locale, '이미 수령 완료로 기록했어요.', 'Pickup is already recorded.', '已记录取货。', '已記錄取貨。')
    // D-326 Q5: a fully paid order is a card (no payment moves). Pay-at-pickup and part-paid orders go to the payment screen.
    : target.stage === 'production_complete' ? check(target, { type: 'customOrder.receive', customOrderId: target.customOrderId, idempotencyKey: idem, reversiblePickup: true },
      () => orderAction('customOrder.receive', name)) : invalidStage(locale));
  if (cancelWords.test(wording) && !/승인\s*취소|제작\s*완료\s*취소/u.test(wording) && !readWords.test(wording)) {
    return requireTarget((name, target) => {
      if (pickupWords.test(wording)) {
        if (target.pickup?.status !== 'confirmed') return missingPickup(locale);
        return check(target, { type: 'pickup.cancel', reservationId: target.pickup.reservationId, idempotencyKey: idem },
          () => orderAction('pickup.cancel', name));
      }
      return check(target, { type: 'customOrder.cancel', customOrderId: target.customOrderId, idempotencyKey: idem },
        () => orderAction('customOrder.cancel', name));
    });
  }
  if (approvalWords.test(wording) && !/승인\s*대기/u.test(wording)) return requireTarget((name, target) => {
    const decision = /거절/u.test(wording) ? 'rejected' : /수정/u.test(wording) ? 'revision_requested' : 'approved';
    const timing = /선결제|미리\s*결제/u.test(wording) ? 'advance' : /받을\s*때|현장\s*결제|픽업\s*때/u.test(wording) ? 'on_pickup' : undefined;
    if (decision === 'approved' && approvalCurrent(target) && (!timing || target.paymentTiming === timing)) {
      return answer(locale, '이미 승인했어요.', 'Already approved.', '已确认。', '已確認。');
    }
    if (decision === 'approved' && !timing) return ask('paymentTiming', locale, resume);
    const paymentTiming = timing ?? target.paymentTiming;
    const { quoteRevision } = target;
    return check(target, { type: 'customOrder.recordDecision', customOrderId: target.customOrderId, quoteRevision, decision, paymentTiming, idempotencyKey: idem },
      () => orderAction('customOrder.recordDecision', name, { quoteRevision: slot('quoteRevision'), decision, paymentTiming }, { quoteRevision }));
  });
  if (stageWords.test(wording) && (changeWords.test(wording) || /다\s*됐|제작\s*중으로|제작\s*완료\s*취소/u.test(wording))) return requireTarget((name, target) => {
    const nextStage = /다\s*만들|다\s*됐|제작\s*완료/u.test(wording) && !cancelWords.test(wording) ? 'production_complete' : 'in_production';
    if (target.stage === nextStage) return nextStage === 'production_complete'
      ? answer(locale, '이미 제작 완료예요.', 'Production is already complete.', '已制作完成。', '已製作完成。')
      : answer(locale, '이미 제작 중이에요.', 'Already in production.', '已在制作中。', '已在製作中。');
    return check(target, { type: 'customOrder.setStage', customOrderId: target.customOrderId, nextStage, idempotencyKey: idem },
      () => orderAction('customOrder.setStage', name, { nextStage }));
  });
  if (/견적/u.test(wording) && !readWords.test(wording)) return requireTarget((name, target) => {
    if (paymentRequired(target)) return widgetOnly('customOrder.openRefund', target, locale, refundCopy);
    const amountPhrase = /견적\s*(?:금액\s*)?(?:을\s*)?(-?[\d,]+(?:만\s*[\d,]*천?)?|[일이삼사오육칠팔구십백천만억]+)\s*(?:원)?/u.exec(wording)?.[1];
    const quoteAmount = parseNavisMoney(wording) ?? (amountPhrase ? parseNavisNumber(amountPhrase) : undefined);
    if (!quoteAmount || quoteAmount < 1) return ask('quoteAmount', locale, value => {
      const next = parseNavisMoney(value);
      return next && next > 0 ? orderChange(amountPhrase ? text.replace(amountPhrase, String(next)) : `${text} ${next}원`, snapshot, locale, scope) : undefined;
    });
    return completePickup(pickupMoment(wording, today), today, locale, (date, time) => {
      const proposedPickupAt = `${date}T${time}`;
      return check(target, { type: 'customOrder.quote', customOrderId: target.customOrderId, quoteAmount, proposedPickupAt, idempotencyKey: idem },
        () => orderAction('customOrder.quote', name, { quoteAmount: slot('quoteAmount'), proposedPickupAt: slot('proposedPickupAt') }, { quoteAmount, proposedPickupAt }));
    });
  });
  if ((pickupWords.test(wording) || /희망\s*일시/u.test(wording))
    && (changeWords.test(wording) || /희망\s*일시|찾으러\s*온대|\d\s*시\s*(?:\d+\s*분)?(?:으?로|$)/u.test(wording))) {
    return requireTarget((name, target) => {
      const desired = /희망/u.test(wording);
      const pickup = desired ? undefined : target.pickup;
      if (!desired && pickup?.status !== 'confirmed') return missingPickup(locale);
      const moment = pickupMoment(wording, today, pickup?.date);
      if (moment.date && moment.date < today && moment.date !== (pickup?.date ?? target.desiredPickupAt.slice(0, 10))) return past(locale);
      return completePickup(moment, today, locale, (date, time) => {
        if (pickup) {
          return check(target, { type: 'pickup.reschedule', reservationId: pickup.reservationId, date, time, idempotencyKey: idem },
            () => orderAction('pickup.reschedule', name, { date: slot('date'), time: slot('time') }, { date, time }));
        }
        const quoteRevision = target.quoteRevision, desiredPickupAt = `${date}T${time}`;
        return check(target, { type: 'customOrder.update', customOrderId: target.customOrderId, expectedQuoteRevision: quoteRevision, desiredPickupAt },
          () => orderAction('customOrder.update', name, { expectedQuoteRevision: slot('quoteRevision'), desiredPickupAt: slot('desiredPickupAt') }, { quoteRevision, desiredPickupAt }));
      });
    });
  }
  if (/요청\s*사항|메모해/u.test(wording) && !readWords.test(wording)) return requireTarget((name, target) => {
    const request = exactQuote(text) ?? /요청\s*사항(?:에|을)?\s*[:：]?\s*(.*?)(?:\s*(?:적어|메모해|추가해).*)?$/u.exec(text)?.[1]?.trim();
    if (!request) return ask('request', locale, value => resume(`'${value}'`));
    const quoteRevision = target.quoteRevision;
    return check(target, { type: 'customOrder.update', customOrderId: target.customOrderId, expectedQuoteRevision: quoteRevision, request },
      () => orderAction('customOrder.update', name, { expectedQuoteRevision: slot('quoteRevision'), request: slot('request') }, { quoteRevision, request }));
  });
  if (changeWords.test(wording) && /수량|\d\s*(?:개|박스|상자)/u.test(wording) && !readWords.test(wording)) return requireTarget((name, target) => {
    const quantity = parsedQuantity(wording);
    if (!quantity || quantity < 1) return ask('quantity', locale, resume);
    const quoteRevision = target.quoteRevision;
    return check(target, { type: 'customOrder.update', customOrderId: target.customOrderId, expectedQuoteRevision: quoteRevision, quantity },
      () => orderAction('customOrder.update', name, { expectedQuoteRevision: slot('quoteRevision'), quantity: slot('quantity') }, { quoteRevision, quantity }));
  });
}

function readWidget(factKeys: readonly string[]): DomainTurnInput {
  return { intent: { kind: 'read', featureId, condition: defaultCondition }, factKeys };
}

function route(raw: string, snapshot: DataSnapshot, locale: Locale): DomainRoute | undefined {
  const text = normalizeNavisInput(raw);
  const wording = orderWording(text);
  if (/하지\s*마|말아\s*줘|이전\s*지시|무시|ignore\s+|\b(?:don't|never|do not)\b/iu.test(wording)) return;
  if (endsAtVisit(wording)) return;
  const scope = orderScope(text, snapshot, locale);
  const { query } = scope;
  const hasContext = customWords.test(text) || !!query && /주문|접수|수령|제작|견적|픽업|승인|거절|요청사항|수정\s*요청|상태|가져가|찾으러|다\s*만들|\d+\s*(?:개|박스|상자)로/u.test(text)
    || paidWords.test(text) && /주문/u.test(text);
  if (!hasContext && !/^(?:손님이\s*)?(?:승인했대|승인됐어|승인\s*기록해\s*줘)[.!]?$/u.test(text)
    && !/주문\s*(?:하나\s*)?접수/u.test(text)) return;

  const model = select(snapshot);
  if (templateWords.test(wording)) {
    const action = templateAction(text, snapshot, locale);
    if (action) return action;
    if (readWords.test(text) || /템플릿/u.test(text)) {
      const template = templateQuery(text, model.templates);
      const available = model.templates.filter(row => !template || key(row.name).includes(key(template)) || key(row.templateId) === key(template));
      return readWidget(['custom.template.count', ...available.flatMap(row => [
        `custom.template.${row.templateId}.name`,
        ...(/항목|선택지|옵션/u.test(text) ? row.fields.map(field => `custom.template.${row.templateId}.field.${field.fieldId}`) : []),
      ])]);
    }
  }
  if ((orderInput.test(wording) || /케이크\s*주문\s*박/u.test(wording)) && !readWords.test(wording)) return orderCreate(text, snapshot, locale);
  const mutation = orderChange(text, snapshot, locale, scope);
  if (mutation) return mutation;

  const today = snapshot.pos?.businessDate ?? TODAY;
  if (/미완료|아직\s*(?:못\s*만들|안\s*만들)/u.test(text) && pickupWords.test(text)) return readWidget(['pickup.today.incomplete.count']);
  if (/진행\s*중/u.test(text) && /몇|건/u.test(text)) return readWidget(['custom.active.count']);
  if (/승인\s*대기/u.test(text)) {
    const pending = model.orders.filter(order => order.stage === 'approval_pending' && order.customerDecision === 'pending');
    return readWidget(['custom.approvalPending.count', ...(!/몇\s*(?:건|개)/u.test(text) ? pending.map(order => orderFact(order.customOrderId, 'row')) : [])]);
  }
  if (paidWords.test(text)) {
    const unpaid = model.orders.filter(isUnpaid);
    return readWidget(unpaid.length ? unpaid.map(order => orderFact(order.customOrderId, 'payment')) : ['custom.unpaid.count']);
  }
  if (pickupWords.test(text)) {
    if (/다음\s*픽업|가장\s*가까운/u.test(text)) return readWidget(['pickup.next', 'pickup.upcoming.count']);
    const date = parseNavisDate(text, today);
    const countKey = date === addDays(today, 1) ? 'pickup.tomorrow.count' : 'pickup.today.count';
    const scoped = query ? scope.rows : model.orders;
    const picks = scoped.filter(order => order.pickup?.status === 'confirmed' && (!date || order.pickup.date === date));
    if (!query && /몇\s*(?:건|개|명)/u.test(text) && (!date || date === today || date === addDays(today, 1))) return readWidget([countKey]);
    if (!picks.length && !query && (date === today || date === addDays(today, 1))) return readWidget([countKey]);
    return readWidget(picks.map(order => orderFact(order.customOrderId, 'pickup')));
  }
  if (query) {
    if (scope.multipleReferences || scope.rows.length !== scopedOrderRows(snapshot, query, locale).length) {
      return readWidget(scope.rows.map(order => orderFact(order.customOrderId, 'row')));
    }
    return { intent: { kind: 'read', recordKind: 'customOrder', querySlot: 'name' }, slots: { name: query } };
  }
  return readWidget(['custom.active.count']);
}

function navigation(raw: string, snapshot: DataSnapshot, locale: Locale): DomainDetail | null | undefined {
  const text = orderWording(normalizeNavisInput(raw));
  if (/하지\s*마|말아\s*줘|무시|ignore\s+|\b(?:don't|never|do not)\b/iu.test(text)) return;
  if (endsAtVisit(text) || /캘린더/u.test(text)) return;
  const open = /열어|보여\s*줘|상세|입력창|편집\s*화면|탭\s*보여/u.test(text);
  const model = select(snapshot);
  if (templateWords.test(text) && open) {
    const query = templateQuery(text, model.templates);
    const template = /상세|고치/u.test(text) && query ? templateSearch({ snapshot, query, locale, privateLookup: true })[0]?.template : undefined;
    return { args: { featureId, view: 'templates', ...(template ? { itemId: template.templateId } : {}) },
      ...(template ? { target: { kind: 'customTemplate', id: template.templateId }, querySlot: 'name' } : {}) };
  }
  if (/(?:주문\s*접수|주문제작\s*새\s*주문)/u.test(text) && open || /^케이크\s*주문\s*받을게$/u.test(text)) {
    const productLabel = /(?:레터링\s*)?(?:생크림\s*)?케이크\s*\d+\s*호|(?:수제\s*)?쿠키\s*세트/u.exec(text)?.[0];
    const quantity = parsedQuantity(text);
    return { args: { featureId, view: 'register', ...(productLabel ? { prefill: { productLabel, ...(quantity && quantity > 0 ? { quantity } : {}) } } : {}) } };
  }
  if (pickupWords.test(text) && open && !readWords.test(text.replace(/보여\s*줘/u, ''))) {
    const { query, rows, multipleReferences } = orderScope(text, snapshot, locale);
    const pickup = !multipleReferences && rows.length === 1 ? rows[0].pickup : undefined;
    if (query && !pickup) return null;
    return { args: { featureId, view: 'pickup', ...(pickup ? { itemId: pickup.reservationId } : {}) },
      ...(pickup ? { target: { kind: 'reservation', id: pickup.reservationId }, querySlot: 'pickup' } : {}) };
  }
  if (!open || !customWords.test(text) && !/주문\s*상세/u.test(text)) return;
  const { query, rows, multipleReferences } = orderScope(text, snapshot, locale);
  if (!query) return;
  const row = !multipleReferences && rows.length === 1 ? rows[0] : undefined;
  if (row) return { args: { featureId, itemId: row.customOrderId }, target: { kind: 'customOrder', id: row.customOrderId }, querySlot: 'name' };
  // A generic product word with a widget word ("케이크 주문 위젯 열어") opens the widget; a named order that is not one row stays refused.
  return /위젯|패널/u.test(text) && !orderCode.test(text) && !maskedPattern.test(text) ? { args: { featureId } } : null;
}

export function customReceiptPrefill(ref: DetailRef) {
  if (ref.featureId !== 'custom-order' || ref.view !== 'register' || ref.prefill?.kind !== 'widget-draft'
    || !validateAgentPrefill(ref.featureId, ref.prefill.fields)) return undefined;
  return ref.prefill.fields as Partial<CustomReceipt> & { readonly templateId?: string };
}

function handoff(command: string, draft: Readonly<Record<string, unknown>>): DetailRef | undefined {
  const view = command === 'customOrder.receive' ? 'receive' : command === 'customOrder.openPayment' ? 'payment'
    : command === 'customOrder.openRefund' ? 'refund' : undefined;
  if (view) return { featureId, view, ...(typeof draft.customOrderId === 'string' ? { itemId: draft.customOrderId, focus: 'action' } : {}) };
}

function routeExplicit(text: string, snapshot: DataSnapshot, locale: Locale) {
  if (/공지|매뉴얼|지원금|지원\s*사업|지원\s*공고|신청서|권한|근무|발주|테이블|포스|원두|레시피|메뉴\s*(?:등록|추가)/u.test(text)
    && !/CO-\d+|주문\s*제작|맞춤\s*주문/iu.test(text)) return;
  if (endsAtVisit(text) || /캘린더/u.test(text) && !orderCode.test(text)) return;
  const explicit = /CO-\d+|CT-[\w-]+|주문\s*제작|맞춤\s*주문|주문서|템플릿|픽업/iu.test(text)
    || /주문\s*(?:하나\s*)?접수/u.test(text)
    || /케이크|쿠키|답례품/u.test(text) && /주문|접수|제작|견적|승인|취소|수령|가져가|찾으러|요청사항|어떤\s*상태|다\s*만들|\d+\s*(?:개|박스|상자)로/u.test(text)
    || maskedPattern.test(text) && /주문|견적|희망\s*일시|승인|거절|요청|수령|가져가|제작/u.test(text)
      && orderScope(text, snapshot, locale).rows.length > 0;
  if (explicit) return route(text, snapshot, locale);
}

export const customDomain: DomainAdapter = {
  featureIds: [featureId], commands: [], runCommands: types.map(commandAdapter), reads: [orderReader, templateReader], routePresentation: routeExplicit, route, navigation, handoff,
  projectWidget: (snapshot, feature, condition, locale) => feature !== featureId ? undefined
    : condition.kind !== 'default' ? { status: 'unsupported_period' } : { facts: widgetProjection(snapshot, locale) },
};
