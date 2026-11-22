// Agent v1 carries local slot references and revision-scoped handles. The
// expanded schemas also validate values when the browser resolves those refs.
import { PROMO_REFERENCE_IDS } from './promo-references.mjs';

export const AGENT_PROTOCOL_HEADER = 'x-navis-protocol';
export const AGENT_PROTOCOL = 'agent-v1';

const record = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const optional = properties => record(properties, []);
const patch = properties => ({ ...optional(properties), minProperties: 1 });
const array = (items, maxItems, minItems = 0) => ({ type: 'array', items, maxItems, minItems });
const unique = (items, maxItems) => ({ ...array(items, maxItems), uniqueItems: true });
const string = (maxLength, pattern = '\\S') => ({ type: 'string', maxLength, pattern });
const integer = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: 'integer', minimum, maximum });
const oneOf = (...values) => ({ enum: values });
const either = (...choices) => ({ anyOf: choices });
const nullable = schema => either(schema, oneOf(null));
const number = (minimum = 0, maximum = Number.MAX_SAFE_INTEGER) => ({ type: 'number', minimum, maximum });
const positive = { ...number(), exclusiveMinimum: 0 };
const flag = { type: 'boolean' };
const id = string(100, '^[A-Za-z0-9_-]+$');
const widgetId = { ...id };
const fieldId = string(64, '^[A-Za-z][A-Za-z0-9_]{0,63}$');
const key = string(120, '^[A-Za-z0-9][A-Za-z0-9._:-]*$');
const text = string(1000);
const emptyText = string(1000, '');
const date = { ...string(10, '^\\d{4}-\\d{2}-\\d{2}$'), format: 'date' };
const time = string(5, '^(?:[01]\\d|2[0-3]):[0-5]\\d$');
const dateTime = { ...string(16, '^\\d{4}-\\d{2}-\\d{2}T(?:[01]\\d|2[0-3]):[0-5]\\d$'), format: 'local-date-time' };
const clockStamp = { ...string(32, '^\\d{4}-\\d{2}-\\d{2}T(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d{1,3})?)?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)?$'), format: 'local-date-time' };
// The old value remains readable on outstanding cards and earlier replay snapshots.
const category = oneOf('coffee', 'tea', 'beverage', 'dessert', 'drink');
const status = oneOf('selling', 'sold_out');
const unit = oneOf('pcs', 'L', 'mL', 'kg', 'g');
const price = integer(1);
const phone = string(11, '^\\d{10,11}$');
const eventCategory = oneOf('store-operations', 'purchasing', 'tax-admin');
const channel = oneOf('store', 'online');
const layer = oneOf('management', 'marketing', 'pos');
const source = oneOf('pos', 'demand', 'promo-estimate', 'promo-references');
const page = integer(1, 5);
const locale = oneOf('ko', 'en', 'zh-Hans', 'zh-Hant');
const closureTab = oneOf('sales', 'drawer', 'history');
const condition = either(
  record({ kind: oneOf('default') }),
  record({ kind: oneOf('snapshot'), asOf: date }),
  record({ kind: oneOf('dateRange'), start: date, end: date }),
);
const handleKinds = new WeakMap();
function target(...kinds) {
  const schema = { ...id };
  handleKinds.set(schema, kinds);
  return schema;
}

const menuId = target('menu');
const stockId = target('stock');
const memberId = target('member');
const eventId = target('event');
const purchaseItemId = target('purchaseItem');
const supplierId = target('supplier');
const reservationId = target('reservation');
const customOrderId = target('customOrder');
const templateId = target('customTemplate');
const threadId = target('thread');
const couponId = target('coupon');
const taxPaymentId = target('taxPayment');
const manualId = target('manual');
const draftId = target('manualDraft');
const staffId = target('staff');
// N10 generated shift IDs contain colon-delimited date/time keys locally.
const scheduleId = { ...key };
handleKinds.set(scheduleId, ['shift']);
const staffDetailId = { ...key };
handleKinds.set(staffDetailId, ['staff', 'shift']);
// End N10 local shift identifiers.
const playlistId = target('playlist');
const offerId = target('offer');
const videoId = target('promoVideo');
const codeId = target('couponCode');
const closure = nullable(record({ kind: oneOf('regular', 'temporary'), endDate: date }));
const menuFields = { name: string(120), category, price, memo: text };
const eventFields = { title: text, date, time: nullable(time), memo: text, categoryId: eventCategory, storeClosure: closure };
// N10 calendar exceptions require explicit browser intent.
const calendarDateIntent = oneOf('historical');
const calendarDuplicateIntent = oneOf(true);
const calendarWriteIntent = { dateIntent: calendarDateIntent, confirmDuplicate: calendarDuplicateIntent };
const calendarSource = oneOf('pickup', 'delivery', 'reservation', 'shift', 'deadline', 'direct');
// End N10 calendar exceptions.
// N04 preserves the canonical recipe:<menu>:<ingredient> line identifiers.
const recipeLine = record({ itemId: stockId, quantity: positive, unit, recipeLineId: key }, ['itemId', 'quantity', 'unit']);
const optionRecipe = record({ itemId: stockId, quantityBase: price, unitDimension: oneOf('pcs', 'mL', 'g') });
const option = record({
  optionId: id, groupId: id, name: text, extraPrice: integer(), extraCost: nullable(integer()), extraRecipe: array(optionRecipe, 32), archivedAt: clockStamp,
}, ['optionId', 'groupId', 'name', 'extraPrice', 'extraCost', 'extraRecipe']);
const optionGroup = record({
  // N04 accepts ordering metadata on seeded option groups. Array order is
  // retained by the write handler when it reconstructs the group records.
  groupId: id, menuId, name: text, required: flag, options: array(option, 32), archivedAt: clockStamp, sortOrder: integer(),
}, ['groupId', 'menuId', 'name', 'required', 'options']);
const guest = record({ name: text, phone }, ['name']);
const bookingFields = { date, time, partySize: price, tableChoice: either(oneOf('auto'), record({ tableId: target('table') })), memberId, guest, request: nullable(emptyText) };
const purchaseFields = { supplierId, minimumQty: positive, unitPrice: integer(), orderStep: positive, leadDays: integer() };
const supplierFields = { name: text, contact: text, phone, memo: text };
// N11 ledger draft and form categories.
const expenseCategory = oneOf('ingredients', 'operations', 'supplies', 'labor', 'rent', 'other');
// End N11 ledger draft and form categories.
const taxPatch = patch({ type: text, amount: price, dueOn: date, paidOn: nullable(date), status: oneOf('paid', 'unpaid') });
const customFields = {
  answers: { type: 'object', required: [], properties: {}, additionalProperties: either(emptyText, array(text, 32)), maxProperties: 32, propertyNames: id },
  productLabel: text, quantity: price, channel: oneOf('phone', 'message', 'visit'), desiredPickupAt: dateTime,
  memberId: nullable(memberId), guest: nullable(record({ name: text, phone })), request: emptyText,
  options: array(text, 32), referencePhotoKeys: array(key, 20),
};
const customStage = oneOf('received', 'quote_pending', 'approval_pending', 'revision_requested', 'payment_pending', 'in_production', 'production_complete', 'received_by_customer', 'canceled');
const customOption = record({ optionId: id, label: text, extraAmount: integer() });
const customField = record({ fieldId: id, label: text, input: oneOf('text', 'single', 'multiple', 'datetime'), required: flag, options: array(customOption, 32) });
// N14 manuals and grants.
const grantApplicationStatus = oneOf('applied', 'reviewing', 'selected', 'rejected', 'completed');
const manualStepNumber = integer(1);
const manualSection = oneOf('handover', 'store-info');
const manualCategory = oneOf('opening', 'closing', 'recipe', 'cleaning', 'new-staff', 'hygiene', 'store-info');
const manualFields = {
  section: manualSection, title: text, category: manualCategory,
  steps: array(either(text, record({ body: text, photoKey: key }, ['body'])), 64, 1), cautions: emptyText,
};
// End N14 manuals and grants.
const noticeKind = oneOf('regular_closure', 'temporary_closure', 'hours_change', 'other');
const audience = oneOf('all_contactable', 'group');
const groupIds = unique(oneOf('regular', 'first-visit', 'churn-risk'), 3);
const noticeDraftId = target('noticeDraft');
const noticeFields = {
  noticeId: noticeDraftId, kind: noticeKind, title: text, body: text, startDate: date, endDate: date, audience, groupIds, closureEventId: nullable(eventId),
};
// N18. Catalog selections and owner memo resolve from local slots.
const promoDraft = {
  menuIds: unique(menuId, 20), photoIds: unique(key, 64),
  concepts: unique(oneOf('review-roundup', 'behind-the-scenes', 'todays-deal', 'new-item', 'day-at-shop'), 5),
  moods: unique(oneOf('warm', 'clean', 'lively', 'elegant'), 4),
  lengthSec: oneOf(10, 15, 30), locale,
  referenceId: oneOf(...PROMO_REFERENCE_IDS),
  memo: string(200, '^[\\s\\S]{0,100}$'),
};
const promoMake = optional({
  ...promoDraft,
  menuIds: { ...promoDraft.menuIds, minItems: 1 }, photoIds: { ...promoDraft.photoIds, minItems: 5 },
  moods: { ...promoDraft.moods, minItems: 1 }, concepts: { ...promoDraft.concepts, minItems: 1 },
});
const videoPostRoute = oneOf('clip', 'reels', 'shorts');
const reachOutFields = { groupId: oneOf('regular', 'first-visit', 'churn-risk'), body: text, sendAt: dateTime };
// End N18 draft fields.
const address = { layer, page };
// N07 layout address and dimensions are public dashboard metadata.
const layoutLayer = oneOf('management', 'marketing');
const layoutAddress = { layer: layoutLayer, page };
const sizeValue = integer(1, 4);
const placement = { width: sizeValue, height: sizeValue, column: integer(0, 7), row: integer(0, 5) };
const layoutWidget = { featureId: widgetId, ...layoutAddress, ...placement, condition };
// End N07 layout fields.
const detailRef = {
  featureId: widgetId, view: key, tab: key, itemId: target('*'), focus: key, date, condition, filter: key,
  prefill: { type: 'object', properties: {}, required: [], propertyNames: fieldId, additionalProperties: text, maxProperties: 12 },
};
// N03: field and view names are public metadata. Field values are local.
const n03DraftFieldView = { ...key };
const n03DraftValue = either(text, number(-Number.MAX_SAFE_INTEGER), flag, array(text, 64));
const risk = (featureId, choice = {}) => ({ featureId, confirmation: 'normal', risk: 'local', policy: 'propose', ...choice });
const extra = (featureId, classification = 'destructive') => risk(featureId, { confirmation: 'extra-confirm', risk: classification });
const widgetOnly = (featureId, classification) => risk(featureId, { policy: 'widget-only', risk: classification });
const handoff = (featureId, classification) => risk(featureId, { policy: 'handoff', risk: classification });

// The executor owns baseRevision and idempotency keys. Policies apply before
// tool selection. A schema alone does not enable a command in the bridge.
const definitions = {
  'menu.create': [record(menuFields, ['name', 'category', 'price']), risk('menu')],
  'menu.update': [record({ menuId, patch: patch({ ...menuFields, memo: nullable(emptyText) }) }), risk('menu')],
  'menu.setSaleStatus': [record({ menuId, status }), risk('menu')],
  'menu.delete': [record({ menuId }), extra('menu')],
  'menu.setRecipe': [record({ menuId, lines: array(recipeLine, 64) }), risk('menu')],
  'menu.setOptions': [record({ menuId, groups: array(optionGroup, 24) }), risk('menu')],
  'inventory.createItem': [record({ sku: text, name: text, unit, stock: number(), threshold: number(), trackRestock: flag }, ['sku', 'name', 'unit', 'stock', 'threshold']), risk('inventory-booking')],
  'inventory.updateItem': [{ ...record({ itemId: stockId, name: text, stock: number(), threshold: number() }, ['itemId']), minProperties: 2 }, risk('inventory-booking')],
  'inventory.moveChannel': [record({ itemId: stockId, from: channel, to: channel, qty: price }), risk('inventory-booking')],
  'inventory.deleteItem': [record({ itemId: stockId }), extra('inventory-booking')],
  'inventory.setTracking': [{ ...record({ itemId: stockId, trackRestock: flag, trackExpiry: flag }, ['itemId']), minProperties: 2 }, risk('inventory-booking')],
  // N06 visit booking commands.
  'booking.create': [record(bookingFields, ['date', 'time', 'partySize', 'tableChoice']), risk('voice-booking')],
  'booking.update': [record({ reservationId, patch: patch(bookingFields) }), risk('voice-booking')],
  'booking.confirm': [record({ reservationId }), risk('voice-booking')],
  'booking.propose': [record({ reservationId, time }), handoff('voice-booking', 'external')],
  'booking.cancel': [record({ reservationId }), extra('voice-booking')],
  'booking.markCompleted': [record({ reservationId }), risk('voice-booking')],
  'booking.markNoShow': [record({ reservationId }), risk('voice-booking')],
  // End N06 visit booking commands.
  // N09 supplier commands. Local scheduling also requires trusted adapter registration.
  'suppliers.createPurchaseItem': [record({ itemId: stockId, ...purchaseFields }), risk('suppliers')],
  'suppliers.updatePurchaseItem': [record({ purchaseItemId, patch: patch(purchaseFields) }), risk('suppliers')],
  'suppliers.deletePurchaseItem': [record({ purchaseItemId }), extra('suppliers')],
  'suppliers.createSupplier': [record(supplierFields, ['name', 'contact', 'phone']), risk('suppliers')],
  'suppliers.updateSupplier': [record({ supplierId, patch: patch({ ...supplierFields, memo: nullable(emptyText) }) }), risk('suppliers')],
  'suppliers.deleteSupplier': [record({ supplierId }), extra('suppliers')],
  'suppliers.createOrder': [record({ purchaseItemId, qty: positive, dueDate: date, suggestionItemId: stockId }, ['purchaseItemId', 'qty']), risk('suppliers')],
  'suppliers.changeDueDate': [record({ poId: target('purchaseOrder'), date }), risk('suppliers')],
  'suppliers.cancelOrder': [record({ poId: target('purchaseOrder') }), extra('suppliers')],
  'suppliers.recordReceipt': [record({ polId: target('purchaseOrderLine'), qty: positive }), risk('suppliers', { risk: 'accounting' })],
  // End N09 supplier commands.
  // N10 calendar and staff commands.
  'calendar.addEvent': [record({ ...eventFields, ...calendarWriteIntent }, ['title', 'date']), risk('calendar')],
  'calendar.updateEvent': [{ ...record({ eventId, ...eventFields, ...calendarWriteIntent, memo: nullable(emptyText) }, ['eventId']), minProperties: 2 }, risk('calendar')],
  'calendar.addTodo': [record({ title: text, date, memo: text, ...calendarWriteIntent }, ['title']), risk('calendar')],
  'calendar.deleteEvent': [record({ eventId }), extra('calendar')],
  'calendar.setCategoryVisible': [record({ categoryId: eventCategory, visible: flag }), risk('calendar')],
  'calendar.setSourceVisible': [record({ source: calendarSource, visible: flag }), risk('calendar')],
  'staff.create': [record({ name: text }), risk('staff-schedule')],
  'staff.update': [record({ staffId, name: text }), risk('staff-schedule')],
  'staff.delete': [record({ staffId, cascadeSchedules: oneOf(true) }), extra('staff-schedule')],
  'staff.saveSchedule': [record({ staffId, date, kind: oneOf('work', 'off'), scheduleId, start: nullable(time), end: nullable(time), breakMinutes: integer(0, 1438) }, ['staffId', 'date', 'kind']), risk('staff-schedule')],
  'staff.deleteSchedule': [record({ scheduleId }), extra('staff-schedule')],
  'staff.moveHandoff': [record({ date, fromTime: time, toTime: time }), risk('staff-schedule')],
  // End N10 calendar and staff commands.
  'ledger.recordExpense': [record({
    date, category: expenseCategory, amount: price,
    evidence: oneOf('receipt', 'tax-invoice', 'card', 'none'), memo: text, supplierId,
  }, ['date', 'category', 'amount']), risk('ledger', { risk: 'accounting' })],
  'ledger.confirmCandidate': [record({ expenseId: target('candidate', 'expense') }), risk('ledger', { risk: 'accounting' })],
  // D-326 expense edits accept one resolved row and at least one change.
  'ledger.updateExpense': [{ ...record({ expenseId: target('expense'), date, amount: price, category: expenseCategory, memo: emptyText }, ['expenseId']), minProperties: 2 }, risk('ledger', { risk: 'accounting' })],
  // End D-326 expense edit.
  'tax.createPayment': [record({ taxType: text, amount: price, dueOn: date }), risk('tax', { risk: 'accounting' })],
  'tax.updatePayment': [record({ taxPaymentId, patch: taxPatch }), risk('tax', { risk: 'accounting' })],
  'tax.deletePayment': [record({ taxPaymentId }), extra('tax', 'accounting')],
  'tax.markPaid': [record({ taxPaymentId }), widgetOnly('tax', 'accounting')],
  'tax.setEvidence': [record({ taxPaymentId, evidence: oneOf('example', 'none') }), risk('tax', { risk: 'accounting' })],
  'tax.markChecked': [record({ refId: target('taxItem') }), risk('tax')],
  // N12 member commands. Private name, phone and note body enter through slots.
  'members.create': [record({ name: text, phone }), risk('members', { risk: 'personal-data' })],
  'members.update': [{ ...record({ memberId, name: text, phone }, ['memberId']), minProperties: 2 }, risk('members', { risk: 'personal-data' })],
  'members.setGrade': [record({ memberId, grade: oneOf('regular', 'frequent', 'occasional', 'inactive', null) }), risk('members')],
  'members.addNote': [record({ memberId, body: text }), risk('members', { risk: 'personal-data' })],
  'members.updateNote': [record({ memberId, noteId: target('note'), body: text }), risk('members', { risk: 'personal-data' })],
  'members.deleteNote': [record({ memberId, noteId: target('note') }), extra('members')],
  'members.delete': [record({ memberId }), extra('members')],
  // End N12 member commands.
  // N13 local custom-order proposals and finance widget routes.
  'customOrder.create': [record({ templateId, ...customFields }, ['templateId', 'answers', 'productLabel', 'quantity', 'channel', 'desiredPickupAt']), risk('custom-order')],
  'customOrder.update': [{ ...record({ customOrderId, expectedQuoteRevision: integer(), ...customFields }, ['customOrderId', 'expectedQuoteRevision']), minProperties: 3 }, risk('custom-order')],
  'customOrder.quote': [record({ customOrderId, quoteAmount: price, proposedPickupAt: dateTime, productionAt: nullable(dateTime) }, ['customOrderId', 'quoteAmount', 'proposedPickupAt']), risk('custom-order')],
  'customOrder.recordDecision': [record({ customOrderId, quoteRevision: price, decision: oneOf('approved', 'rejected', 'revision_requested'), paymentTiming: oneOf('advance', 'on_pickup') }), risk('custom-order')],
  'customOrder.setStage': [record({ customOrderId, nextStage: customStage }), risk('custom-order')],
  'customOrder.receive': [record({ customOrderId }), risk('custom-order', { risk: 'accounting' })], // D-326 paid pickup.
  'customOrder.openPayment': [optional({ customOrderId }), widgetOnly('custom-order', 'payment')],
  'customOrder.openRefund': [optional({ customOrderId }), widgetOnly('custom-order', 'payment')],
  'customOrder.cancel': [record({ customOrderId, confirmedCorrectionQuoteId: id }, ['customOrderId']), extra('custom-order')],
  'pickup.reschedule': [record({ reservationId, date, time }), risk('custom-order')],
  'pickup.cancel': [record({ reservationId, confirmedCorrectionQuoteId: id }, ['reservationId']), extra('custom-order')],
  'customTemplate.generate': [record({ productKind: text, keywords: emptyText }), risk('custom-order')],
  'customTemplate.save': [record({ name: text, fields: array(customField, 32, 1), templateId }, ['name', 'fields']), risk('custom-order')],
  'customTemplate.delete': [record({ templateId }), extra('custom-order')],
  // End N13 commands.
  // N14 manuals and grant records.
  'manuals.create': [record(manualFields, ['section', 'title', 'category', 'steps']), risk('manuals')],
  'manuals.update': [record({ manualId, patch: patch(manualFields) }), risk('manuals')],
  'manuals.setPublished': [record({ manualId, published: oneOf(false) }), extra('manuals')], // D-326 unpublish.
  'manuals.delete': [record({ manualId }), extra('manuals')],
  'manuals.toggleStep': [record({ manualId, stepNo: manualStepNumber, checked: flag }, ['manualId', 'stepNo']), risk('manuals')],
  'manuals.createDraftFromMemo': [record({ memo: text, section: manualSection, cautions: emptyText }, ['memo']), risk('manuals')],
  'manuals.saveDraft': [record({ draftId, section: manualSection, cautions: emptyText, title: text, steps: array(text, 64, 1), category: manualCategory }, ['draftId']), risk('manuals')],
  'manuals.discardDraft': [record({ draftId }), extra('manuals')],
  'grants.apply': [record({ noticeId: target('grantNotice') }), risk('grants')],
  'grants.updateApplication': [{ ...record({ applicationId: target('grantApplication'), status: grantApplicationStatus, resultMemo: nullable(emptyText) }, ['applicationId']), minProperties: 2 }, risk('grants')],
  'grants.deleteApplication': [record({ applicationId: target('grantApplication') }), extra('grants')],
  'grants.markReviewed': [record({ noticeId: target('grantNotice') }), risk('grants')],
  // End N14 commands.
  'notice.saveDraft': [record(noticeFields, ['kind', 'title', 'body', 'startDate', 'endDate', 'audience', 'groupIds']), risk('notice-send')],
  'notice.importClosure': [record({ eventId, noticeId: noticeDraftId }, ['eventId']), risk('notice-send')],
  'notice.deleteDraft': [record({ noticeId: noticeDraftId }), extra('notice-send')],
  // N16 coupon approval policies.
  // D-328 extends the local Place News draft to all widget benefit kinds.
  'coupon.createExpiry': [record({ itemId: stockId, route: oneOf('place_news'), discountRate: integer(1, 100),
    benefit: record({ kind: oneOf('percent', 'amount', 'setPrice'), value: price }), withSet: flag }, ['itemId', 'route']), risk('expiry-coupon')],
  'coupon.update': [{ ...record({ couponId, benefitValue: price, quantity: price }, ['couponId']), minProperties: 2 }, risk('coupon-status')],
  'coupon.endEarly': [record({ couponId }), extra('coupon-status')],
  'coupon.unpublish': [record({ codeId }), extra('coupon-status')],
  // End D-326 coupon lifecycle.
  'coupon.pause': [record({ couponId }), risk('coupon-status')],
  'coupon.resume': [record({ couponId }), risk('coupon-status')],
  'coupon.extend': [record({ couponId }), risk('coupon-status')],
  'coupon.sendSlot': [record({ slotId: target('slot'), benefitId: oneOf('free-shot', 'percent-10', 'amount-500'), body: text, sendAt: dateTime }, ['slotId', 'benefitId']), risk('slot-coupon', { risk: 'external' })],
  'coupon.notifyEnding': [record({ couponId }), risk('coupon-status', { risk: 'external' })],
  'coupon.markPosted': [record({ codeId }), extra('expiry-coupon', 'irreversible')],
  // End N16 coupon approval policies.
  // N17 draft persistence and per-target simulated outbound actions.
  'reply.draft': [record({ threadId }), risk('ai-response')],
  'inquiry.saveDraft': [record({ threadId, body: text, revision: integer(1) }), risk('ai-response')],
  'inquiry.send': [record({ threadId, body: text }), risk('ai-response', { risk: 'external' })],
  'inquiry.post': [record({ threadId, body: text }), risk('ai-response', { risk: 'external' })],
  'community.accept': [record({ offerId }), risk('community', { risk: 'external' })],
  'community.decline': [record({ offerId }), risk('community', { risk: 'external' })],
  'community.sendInterest': [record({ offerId }), risk('community', { risk: 'external' })],
  // End N17 commands.
  // N18 promotion actions use browser-owned drafts and scoped current records.
  'promo.draft.set': [patch(promoDraft), risk('promo-video')],
  'video.make': [promoMake, risk('promo-video', { risk: 'cost' })],
  'video.markPosted': [record({ videoId, route: videoPostRoute }), extra('promo-video', 'irreversible')],
  'coupon.sendReachOut': [optional(reachOutFields), risk('customer-groups', { risk: 'external' })],
  'video.retry': [record({ videoId }), risk('promo-video', { risk: 'cost' })], // D-328
  // End N18 promotion actions.
  'environment.setPlaying': [record({ playing: flag }), risk('store-environment')],
  'environment.skipTrack': [record({ direction: oneOf('previous', 'next') }), risk('store-environment')],
  'environment.selectPlaylist': [record({ playlistId }), risk('store-environment')],
  'environment.selectTrack': [record({ trackId: target('track'), playlistId }, ['trackId']), risk('store-environment')],
  'environment.setVolume': [record({ volumePct: integer(0, 100) }), risk('store-environment')],
  'cctv.markPeakForReview': [record({ date, hour: integer(0, 23) }), risk('customer-analysis')],
  'localChanges.acknowledge': [record({ changeId: target('localChange') }), risk('local-changes')],
  'localChanges.unacknowledge': [record({ changeId: target('localChange') }), risk('local-changes')],
  // N07 layout proposals.
  'layout.add_widget': [record(layoutWidget, ['featureId']), risk(null)],
  'layout.remove_widget': [record({ featureId: widgetId, ...layoutAddress }, ['featureId']), extra(null)],
  'layout.remove_widgets': [record({ ...layoutAddress, featureIds: { ...unique(widgetId, 6), minItems: 2 } }, ['featureIds']), extra(null)],
  'layout.move_widget': [record({ featureId: widgetId, ...layoutAddress, column: placement.column, row: placement.row }, ['featureId', 'column', 'row']), risk(null)],
  'layout.resize_widget': [record({ featureId: widgetId, ...layoutAddress, width: sizeValue, height: sizeValue }, ['featureId', 'width', 'height']), risk(null)],
  'layout.move_to_page': [record({ featureId: widgetId, ...layoutAddress, destinationPage: page }, ['featureId', 'destinationPage']), risk(null)],
  'layout.add_page': [optional({ layer: layoutLayer }), risk(null, { risk: 'irreversible' })],
  'layout.add_widgets': [record({ ...layoutAddress, widgets: array(record(layoutWidget, ['featureId']), 6, 1) }, ['widgets']), risk(null)],
  'layout.swap_widgets': [record({ ...layoutAddress, a: widgetId, b: widgetId }, ['a', 'b']), risk(null)],
  'layout.set_condition': [record({ featureId: widgetId, ...layoutAddress, condition }, ['featureId', 'condition']), risk(null)],
  'layout.start_with_three': [optional({ layer: oneOf('management') }), risk(null)],
  'layout.start_with_preset': [optional({ layer: oneOf('marketing') }), risk(null)],
  // End N07 layout proposals.
  // N08 presentation proposals. The variant is a public registry identifier;
  // the settings adapter checks it against the target widget before proposing.
  'settings.set_theme': [record({ theme: oneOf('light', 'dark') }), risk(null)],
  'settings.set_text_scale': [record({ scale: oneOf(100, 125) }), risk(null)],
  'settings.set_locale': [record({ locale }), risk(null)],
  'settings.set_preview_family': [record({ family: oneOf('normal', 'empty', 'error', 'special') }), risk(null)],
  'settings.set_preview_variant': [record({ featureId: widgetId, variant: nullable(widgetId) }), risk(null)],
  'settings.reset_widget_preview': [record({ featureId: widgetId }), risk(null)],
  'settings.set_closing_preview': [record({ scenario: oneOf('normal', 'no-payments', 'error', null) }), risk(null)],
  'settings.set_pos_preview': [record({ scenario: oneOf('normal', 'empty', 'error', 'payment-failure', null) }), risk(null)],
  'settings.set_detail_fullscreen': [record({ fullscreen: flag }), risk(null)],
  // End N08 presentation proposals.
  'ui.openDetail': [record(detailRef, ['featureId']), risk(null)],
  'ui.switch_layer': [record({ layer }), risk(null)],
  'ui.go_to_page': [record({ page }), risk(null)],
  'ui.show_panel': [record({ featureId: widgetId, ...address }, ['featureId']), risk(null)],
  'ui.go_back': [record({}), risk(null)],
  'ui.open_drawer': [optional({ group: key, query: text }), risk(null)],
  'ui.close_overlay': [record({}), risk(null)],
  'ui.open_settings': [optional({ view: key }), risk(null)],
  'ui.open_widget_help': [record({ featureId: widgetId }), risk(null)],
  'ui.close_chat': [record({}), risk(null)],
  'ui.skip_coaches': [record({}), risk(null)],
  'ui.enter_layout_edit': [record({}), risk(null)],
  'ui.exit_layout_edit': [record({}), risk(null)],
  'ui.set_pos_tab': [record({ tab: oneOf('order', 'status', 'tables') }), risk(null)],
  'ui.open_closing': [optional({ tab: closureTab }), risk(null)],
  'ui.openSettlement': [record({ purpose: oneOf('charge_topup', 'receivable_collection', 'refund'), memberId, amount: price }), handoff('credit-receivable', 'payment')],
  'ui.setDraftField': [record({ featureId: widgetId, view: n03DraftFieldView, field: fieldId, value: n03DraftValue }, ['featureId', 'field', 'value']), handoff(null, 'local')],
  'ui.setCctvMode': [record({ mode: oneOf('mock', 'live') }), risk('customer-analysis')],
  'ui.acknowledgeBriefing': [record({}), risk('briefing')],
  'ui.replayBriefing': [record({}), risk('briefing')],
  // N15. Legacy widget handoff keeps its optional form fields; the proposal is narrower.
  'notice.send': [optional({ ...noticeFields, draftRevision: integer(1), previewId: id, sendAt: dateTime }), risk('notice-send', { risk: 'external' })], // D-326 schedule.
  'supplier.sendOrder': [optional({ purchaseItemId, qty: positive, dueDate: date }), widgetOnly('suppliers', 'external')],
  'closing.closeDay': [optional({ date }), widgetOnly('pos-closing', 'payment')],
  'closing.undoDay': [optional({ date }), widgetOnly('pos-closing', 'payment')],
  'pos.payment': [optional({ amount: price, memberId }), widgetOnly('pos', 'payment')],
  'pos.refund': [optional({ amount: price, memberId }), widgetOnly('pos', 'payment')],
  // N08 drawer writes hand off to the closing drawer tab.
  'pos.drawerMovement': [optional({ amount: price, memo: text }), widgetOnly('pos-closing', 'payment')],
  'memberships.useOnce': [optional({ memberId, membershipId: id }), widgetOnly('members', 'payment')],
  'memberships.cancelUse': [optional({ memberId, membershipId: id }), widgetOnly('members', 'payment')],
  'members.setConsent': [optional({ memberId, consent: flag }), widgetOnly('members', 'personal-data')],
  // N12 selected member widget entries.
  'members.review': [record({ memberId }), widgetOnly('members', 'personal-data')],
  'memberships.sale': [record({ memberId }), widgetOnly('members', 'payment')],
  // End N12 selected member widget entries.
  'tax.export': [optional({ period: record({ start: date, end: date }) }), widgetOnly('tax', 'external')],
  'shop.updateSettings': [optional({ businessType: key, paymentStyle: key, tablesEnabled: flag }), widgetOnly('settings', 'local')],
  'menu.setPhoto': [optional({ menuId, photoKey: nullable(key) }), widgetOnly('menu', 'local')],
};

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const entries = Object.entries(definitions);
export const AGENT_COMMAND_SCHEMAS = freeze(Object.fromEntries(entries.map(([command, [schema]]) => [command, schema])));
export const AGENT_COMMAND_CATALOG = freeze(Object.fromEntries(entries.map(([command, [schema, metadata]]) => [
  command, { ...metadata, required: schema.required, optional: Object.keys(schema.properties).filter(field => !schema.required.includes(field)) },
])));
export const AGENT_COMMANDS = freeze(entries.filter(([, [, metadata]]) => metadata.policy === 'propose').map(([command]) => command));
const knownCommands = oneOf(...Object.keys(definitions));

const plainObject = value => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function isoDay(value) {
  const day = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(day.getTime()) && day.toISOString().slice(0, 10) === value;
}
function matches(schema, value) {
  if (schema.enum) return schema.enum.includes(value);
  if (schema.anyOf) return schema.anyOf.some(choice => matches(choice, value));
  if (schema.type === 'object') {
    if (!plainObject(value)) return false;
    const fields = Object.keys(value);
    return fields.length >= (schema.minProperties ?? 0) && fields.length <= (schema.maxProperties ?? Infinity)
      && schema.required.every(field => Object.hasOwn(value, field))
      && fields.every(field => (!schema.propertyNames || matches(schema.propertyNames, field))
        && (Object.hasOwn(schema.properties, field) ? matches(schema.properties[field], value[field])
          : schema.additionalProperties !== false && matches(schema.additionalProperties, value[field])));
  }
  if (schema.type === 'array') return Array.isArray(value) && value.length >= schema.minItems && value.length <= schema.maxItems
    && Array.from(value).every(item => matches(schema.items, item))
    && (!schema.uniqueItems || new Set(value).size === value.length);
  if (schema.type === 'string') return typeof value === 'string' && value.length <= schema.maxLength
    && new RegExp(schema.pattern, 'u').test(value) && (!schema.format || isoDay(value.slice(0, 10)));
  if (schema.type === 'boolean') return typeof value === 'boolean';
  return (schema.type === 'integer' ? Number.isSafeInteger(value) : Number.isFinite(value))
    && value >= schema.minimum && value <= schema.maximum && (schema.exclusiveMinimum === undefined || value > schema.exclusiveMinimum);
}
function validCondition(value) {
  return matches(condition, value) && (value.kind !== 'dateRange' || value.start <= value.end);
}
const clockMinutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

export function validateAgentCommandArgs(command, args) {
  if (!Object.hasOwn(AGENT_COMMAND_SCHEMAS, command) || !matches(AGENT_COMMAND_SCHEMAS[command], args)) return false;
  if (command === 'coupon.createExpiry') return !Object.hasOwn(args, 'withSet')
    && Object.hasOwn(args, 'discountRate') !== Object.hasOwn(args, 'benefit');
  if (args.condition && !validCondition(args.condition)) return false;
  if (args.storeClosure && args.date && args.storeClosure.endDate < args.date) return false;
  if (command === 'notice.saveDraft') return args.startDate <= args.endDate
    && (args.audience === 'group' ? args.groupIds.length > 0 : args.groupIds.length === 0);
  if (command === 'inventory.moveChannel') return args.from !== args.to;
  if (command === 'inventory.createItem') {
    const precision = args.unit === 'L' || args.unit === 'kg' ? 1000 : 1;
    return [args.stock, args.threshold].every(quantity => {
      const base = quantity * precision;
      return Number.isSafeInteger(Math.round(base)) && Math.abs(Math.round(base) - base) < 1e-8;
    });
  }
  if (command === 'staff.saveSchedule') {
    if (args.kind === 'off') return args.start == null && args.end == null && (args.breakMinutes ?? 0) === 0;
    return typeof args.start === 'string' && typeof args.end === 'string'
      && clockMinutes(args.end) - clockMinutes(args.start) > (args.breakMinutes ?? 0);
  }
  if (command === 'booking.create' || command === 'customOrder.create') return Boolean(args.memberId) !== Boolean(args.guest);
  if (command === 'booking.update') return !(args.patch.memberId && args.patch.guest);
  if (command === 'customOrder.update') return !(args.memberId && args.guest);
  if (command === 'menu.setOptions') return args.groups.every(group => group.menuId === args.menuId
    && group.options.every(item => item.groupId === group.groupId));
  if (command === 'layout.swap_widgets') return args.a !== args.b;
  if (command === 'layout.add_widgets') return new Set(args.widgets.map(widget => widget.featureId)).size === args.widgets.length
    && args.widgets.every(widget => !widget.condition || validCondition(widget.condition));
  if (command === 'tax.updatePayment') return !(args.patch.status === 'unpaid' && args.patch.paidOn);
  return true;
}

const slotRef = record({ slot: fieldId });
const handleRef = record({ handle: id });
const targetSchemes = new WeakMap();
function wireSchema(schema) {
  // N10 confirmation overrides originate in the browser, like typed dates.
  if (schema === calendarDateIntent || schema === calendarDuplicateIntent) return slotRef;
  if (schema === n03DraftValue) return slotRef;
  if (handleKinds.has(schema)) {
    const wire = record(handleRef.properties);
    targetSchemes.set(wire, handleKinds.get(schema));
    return wire;
  }
  if (schema.enum || schema === flag || schema === condition || schema === widgetId || schema === fieldId || schema === n03DraftFieldView) return schema;
  if (schema.anyOf) return either(...schema.anyOf.map(wireSchema));
  if (schema.type === 'object' && schema.additionalProperties === false) {
    return { ...schema, properties: Object.fromEntries(Object.entries(schema.properties).map(([field, rule]) => [field, wireSchema(rule)])) };
  }
  // Local strings, numbers and collections never travel in proposal payloads.
  return slotRef;
}
const menuWire = record({ name: record({ slot: oneOf('name') }), category, price: record({ slot: oneOf('price') }), memo: record({ slot: oneOf('memo') }) }, ['name', 'category', 'price']);
const wireCommands = Object.fromEntries(entries.map(([command, [schema]]) => [
  command, command === 'menu.create' ? menuWire : command.startsWith('layout.') ? schema : wireSchema(schema), // N07
]));
const draftSchemas = Object.fromEntries(Object.entries(wireCommands).map(([command, schema]) => [command, optional(schema.properties)]));
// N15. The owner approves a saved draft revision; preview IDs stay local.
const noticeRevisionRef = record({ slot: oneOf('draftRevision') });
const noticeSendWire = record({
  noticeId: wireCommands['notice.send'].properties.noticeId, draftRevision: noticeRevisionRef,
  sendAt: wireCommands['notice.send'].properties.sendAt, // D-326, caller's local time slot.
}, ['noticeId', 'draftRevision']);
// D-328 accepts the legacy percent slot or a typed widget benefit with a browser-local value.
const { itemId: expiryItemId, route: expiryRoute, discountRate: expiryRate, benefit: expiryBenefit } = wireCommands['coupon.createExpiry'].properties;
const expiryCreateWire = {
  required: ['itemId', 'route'],
  ...either(record({ itemId: expiryItemId, route: expiryRoute, discountRate: expiryRate }),
    record({ itemId: expiryItemId, route: expiryRoute, benefit: expiryBenefit })),
};
// N18. Reach-out has a legacy prefill but only the widget's immediate churn-risk send is approved.
const reachOutWire = record({ groupId: oneOf('churn-risk'), body: slotRef }, ['groupId']);
const actionWire = command => command === 'notice.send' ? noticeSendWire
  : command === 'coupon.createExpiry' ? expiryCreateWire
  : command === 'coupon.sendReachOut' ? reachOutWire : wireCommands[command];
const proposalSchemas = Object.fromEntries(AGENT_COMMANDS.map(command => [
  command, record({ command: oneOf(command), args: actionWire(command) }),
]));
const proposal = either(...Object.values(proposalSchemas));
// N09 purchase order lifecycle shared by orders and receipt lines.
const supplierOrderStatus = oneOf('scheduled', 'partial', 'complete', 'canceled');
const recordFields = {
  menu: { category, seasonal: flag, price, status, kind: oneOf('menu', 'retail'), soldToday: integer(), cost: integer() },
  // N05 inventory record projection.
  stock: { kind: oneOf('ingredient', 'retail'), unit, sku: string(120), referenced: flag, store: integer(), online: integer(),
    expiryEligible: flag, expiryHandled: flag }, // D-326 coupon eligibility.
  // End N05 inventory record projection.
  // N09 purchase item operational fields.
  purchaseItem: { unit, minimumQty: positive, unitPrice: integer(), orderStep: positive, leadDays: integer(), referenced: flag, suggested: flag },
  // End N09 purchase item operational fields.
  // N12 member lookup evidence. The note owner uses the member's opaque handle.
  member: { grade: oneOf('regular', 'frequent', 'occasional', 'inactive'), deleteBlocked: flag },
  note: { date, ownerHandle: id },
  // End N12 member lookup evidence.
  // N10 operational fields. Raw titles, memo and staff identifiers stay local for writes.
  event: { date, source: calendarSource, time, kind: oneOf('event', 'todo'), categoryId: eventCategory, closure: flag, linkedDraftCount: integer() },
  staff: { scheduleCount: integer() },
  shift: { date, kind: oneOf('work', 'off'), start: time, end: time, breakMinutes: integer(0, 1438) },
  // End N10 operational fields.
  // N15 operational evidence; write lookups do not need the notice text.
  noticeDraft: { kind: noticeKind, date, revision: integer(1), businessTime: time, sendAllowed: flag, scheduleAllowed: flag,
    closureLink: oneOf('none', 'current', 'changed', 'removed', 'dates'), alreadySent: flag },
  recipe: { unit },
  // N09 supplier and order operational fields. Contacts and identities stay local.
  supplier: { referenced: flag },
  purchaseOrder: { date, status: supplierOrderStatus, open: flag },
  purchaseOrderLine: { unit, status: supplierOrderStatus, open: flag, remaining: number(), unitPrice: integer() },
  // End N09 supplier and order operational fields.
  // N11 ledger and tax operational fields.
  expense: { date, amount: price, status: oneOf('candidate', 'confirmed', 'canceled'), closed: flag }, // D-326.
  candidate: { date, amount: price, status: oneOf('candidate', 'confirmed', 'canceled') },
  taxPayment: { date, amount: price, status: oneOf('paid', 'unpaid'), paidOn: date, evidence: oneOf('example', 'none') },
  taxItem: { date, amount: price, status: oneOf('needs-check', 'checked') },
  // End N11 ledger and tax operational fields.
  accountTxn: { date },
  // N13 operational fields. Receipt contents and contact details stay local.
  customOrder: {
    stage: customStage, date, proposedPickupAt: dateTime, quoteRevision: integer(),
    approvalCurrent: flag, paymentReversalRequired: flag, paymentComplete: flag, paymentTiming: oneOf('advance', 'on_pickup'),
  },
  customTemplate: {},
  // End N13 custom-order projection.
  // N06 operational fields only. Identity, contact, request and call text stay local.
  reservation: {
    kind: oneOf('visit', 'pickup'), date, time, partySize: price,
    status: oneOf('needs-check', 'confirmed', 'proposed', 'canceled', 'completed', 'no-show'),
    source: oneOf('phone_ai', 'direct'), origin: oneOf('local', 'call', 'naver'),
    allocationWarning: oneOf('NO_MATCHING_TABLE', 'SEAT_LIMIT'), visitStarted: flag,
    paymentReversalRequired: flag, // N13 linked pickup only.
  },
  // End N06 reservation projection.
  // N14 operational fields only. Draft content stays local.
  manual: { section: manualSection, checklist: flag, stepNumbers: array(manualStepNumber, 64), checkedSteps: array(manualStepNumber, 64), published: flag },
  manualDraft: { section: manualSection },
  grantNotice: { date, canApply: flag, applied: flag, reviewed: flag },
  grantApplication: { date, status: grantApplicationStatus },
  // End N14 projection.
  noticeSent: { date },
  // N16 eligibility only. Recipient IDs and message bodies stay local.
  coupon: { status: oneOf('active', 'paused', 'ended'), date, endingSoon: flag, reminderRecipients: integer() },
  couponCode: { route: oneOf('place_news', 'blog', 'clip', 'sms'), activated: flag, eligible: flag, unpublished: flag },
  slot: { date, hour: integer(0, 23), handled: flag, recipientCount: integer() },
  // End N16 eligibility.
  // N17 operational evidence. Quotes, drafts and contacts stay out of record matches.
  thread: {
    status: oneOf('waiting', 'draft_ready', 'done'), type: oneOf('message', 'review', 'call'),
    isPublic: flag, revision: integer(1), connected: flag, hasDraft: flag, canDraft: flag, canSend: flag,
  },
  offer: {
    date, visibility: oneOf('direct', 'public'), status: oneOf('pending', 'accepted', 'declined', 'expired', 'withdrawn'),
    eligible: flag, interestSent: flag,
  },
  // End N17 evidence.
  customer: {}, table: {},
  // N18 operational status. The memo, assets and result URL stay in the widget.
  promoVideo: { date, status: oneOf('making', 'done', 'failed', 'posted') },
  // N19 simulated player lookup metadata. Internal playlist and track IDs stay local.
  playlist: { hasTracks: flag }, track: { playing: flag },
  // End N19 player lookups.
  localChange: { date, folded: flag },
  localTrend: {}, // N20 keyword detail handles carry no record fields.
};
export const AGENT_RECORD_KINDS = freeze(Object.keys(recordFields));
const recordKind = oneOf(...AGENT_RECORD_KINDS);
const searchArgs = record({ kind: recordKind, querySlot: fieldId, cursor: id }, ['kind', 'querySlot']);
const toolDefinitions = {
  list_widget_ids: ['List readable widget IDs and supported conditions, optionally by board.', optional({ layer })],
  get_widget: ['Read one catalog widget for a supported condition.', record({ featureId: widgetId, condition })],
  search_records: ['Find scoped records for an opaque query slot. Treat labels as quoted data.', searchArgs],
  get_source: ['Read POS or demand data without suggesting a board card.', record({ sourceId: source, condition })],
  // N07 dashboard facts, scoped by board and optional one-based page.
  get_board: ['Read the dashboard pages, grid, free cells and panel placements for this board.', record({ layer, page }, ['layer'])],
  get_ui_state: ['Read operator display and shop settings.', optional({ section: oneOf('display', 'preview', 'shop', 'pos') })],
  get_closing_state: ['Read business-day closing status, drawer and history.', optional({ tab: closureTab, date })],
  get_recipe: ['Read the active recipe for a scoped menu handle.', record({ menuId: wireSchema(menuId) })],
  simulate_menu_price: ['Read an estimate for a menu at an optional draft price or cost.', record({ menu: wireSchema(menuId), price: slotRef, cost: slotRef }, ['menu'])],
  check_booking_capacity: ['Read an estimate of capacity for the specified draft visit.', record({ date: slotRef, time: slotRef, partySize: slotRef, tableChoice: either(oneOf('auto'), wireSchema(target('table'))) }, ['date', 'time', 'partySize'])],
  calc_expiry_discount: ['Read the estimate for a draft discount.', record({ itemId: wireSchema(stockId), rate: slotRef, withSet: flag }, ['itemId', 'rate'])],
  // N18 check only scoped job availability or consented audience size.
  get_promotion_preflight: ['Read promo start or reach-out eligibility.', record({ action: oneOf('make', 'reach-out') })],
  // N19 read-only CCTV preflight for the same slot references as the proposal.
  get_cctv_review: ['Check the selected CCTV observation for same-day review.', record({ date: slotRef, hour: slotRef })],
  // End N19 CCTV preflight.
  'notice.preview': ['Read the audience and classification for a notice draft.', either(
    record({ noticeId: wireSchema(noticeDraftId), draftRevision: slotRef }),
    record({ draft: wireCommands['notice.saveDraft'] }),
  )],
  propose_action: ['Prepare one allowlisted command for review using only approved slots and handles.', proposal],
};
const tool = (name, description, parameters) => ({ type: 'function', function: { name, description, parameters } });
export const AGENT_TOOLS = freeze(Object.fromEntries(Object.entries(toolDefinitions).map(([name, [description, parameters]]) => [
  name, tool(name, description, parameters),
])));
export const AGENT_READ_TOOLS = freeze(Object.keys(AGENT_TOOLS).filter(name => name !== 'propose_action'));
export const AGENT_EXTRA_READ_TOOLS = freeze(AGENT_READ_TOOLS.slice(4));
export function agentProposalTool(command) {
  return Object.hasOwn(proposalSchemas, command)
    ? tool('propose_action', AGENT_TOOLS.propose_action.function.description, proposalSchemas[command])
    : undefined;
}

export function validateAgentToolArgs(name, args) {
  if (!Object.hasOwn(AGENT_TOOLS, name) || !matches(AGENT_TOOLS[name].function.parameters, args)) return false;
  if (name === 'propose_action') {
    const { command, args: draft } = args;
    if (agentCommandPolicy(command, draft)?.policy !== 'propose') return false;
    if (command === 'inventory.moveChannel' && draft.from === draft.to) return false;
    if (command === 'staff.saveSchedule') {
      if (draft.kind === 'work') return Boolean(draft.start && draft.end);
      return draft.start == null && draft.end == null;
    }
    if (command === 'booking.create' || command === 'customOrder.create') return Boolean(draft.memberId) !== Boolean(draft.guest);
    if (command === 'booking.update') return !(draft.patch.memberId && draft.patch.guest);
    if (command === 'customOrder.update') return !(draft.memberId && draft.guest);
    if (command.startsWith('layout.')) return validateAgentCommandArgs(command, draft); // N07
  }
  return !Object.hasOwn(args, 'condition') || validCondition(args.condition);
}
export function agentDraftSchema(command) {
  return Object.hasOwn(draftSchemas, command) ? draftSchemas[command] : undefined;
}
export function validateAgentDraft(command, args) {
  return Object.hasOwn(draftSchemas, command) && matches(draftSchemas[command], args);
}
export function agentCommandPolicy(command, args = {}) {
  if (!Object.hasOwn(AGENT_COMMAND_CATALOG, command)) return undefined;
  const metadata = AGENT_COMMAND_CATALOG[command];
  if (command === 'ui.setDraftField' && matches(widgetId, args.featureId)) return { ...metadata, featureId: args.featureId };
  // N15. Unsaved outbound copy routes to the existing widget.
  if (command === 'notice.send' && !args.noticeId) return { ...metadata, policy: 'widget-only' };
  // N17 preserves the widget route for sends and responses without exact card arguments.
  if (['inquiry.send', 'inquiry.post'].includes(command) && (!args.threadId || !args.body)
    || ['community.accept', 'community.decline', 'community.sendInterest'].includes(command) && !args.offerId) {
    return { ...metadata, policy: 'widget-only' };
  }
  // End N17 handoff.
  // N16 preserves the widget entry when an outbound action has no exact target.
  if (command === 'coupon.sendSlot' && (!args.slotId || !args.benefitId)
    || command === 'coupon.notifyEnding' && !args.couponId
    || command === 'coupon.markPosted' && !args.codeId) {
    return { ...metadata, policy: 'widget-only' };
  }
  // End N16 handoff.
  // D-326 retains widget prefill for incomplete expiry requests.
  if (command === 'coupon.createExpiry' && (Object.hasOwn(args, 'withSet')
    || (!args.discountRate && !args.benefit) || metadata.required.some(field => !Object.hasOwn(args, field)))) {
    return { ...metadata, policy: 'widget-only' };
  }
  // N18 incomplete legacy drafts still open the widget.
  if (command === 'video.make' && Object.keys(promoMake.properties).some(field => !Object.hasOwn(args, field))
    || command === 'video.retry' && !args.videoId
    || command === 'video.markPosted' && (!args.videoId || !args.route)
    || command === 'coupon.sendReachOut' && (args.groupId !== 'churn-risk' || Object.hasOwn(args, 'sendAt'))) {
    return { ...metadata, policy: 'widget-only' };
  }
  // End N18 handoff.
  if (command === 'tax.updatePayment' && (Object.hasOwn(args.patch ?? {}, 'paidOn') || Object.hasOwn(args.patch ?? {}, 'status'))
    || ['customOrder.cancel', 'pickup.cancel'].includes(command) && Object.hasOwn(args, 'confirmedCorrectionQuoteId')) {
    return { ...metadata, policy: 'widget-only' };
  }
  if (command === 'tax.setEvidence') {
    if (args.evidence === 'example') return { ...metadata, policy: 'handoff' };
    if (args.evidence === 'none') return { ...metadata, policy: 'widget-only' };
  }
  return metadata;
}
export function agentMissingField(command, args, slots) {
  const schema = actionWire(command);
  if (!schema) return undefined;
  // N06 starts an underspecified visit by asking for a guest or member.
  if (command === 'booking.create' && !args.memberId && !args.guest) return 'guest';
  for (const field of schema.required) {
    if (!Object.hasOwn(args, field)) return field;
  }
  if (command === 'staff.saveSchedule' && args.kind === 'work') {
    if (!args.start) return 'start';
    if (!args.end) return 'end';
  }
  if (command === 'customOrder.create' && !args.memberId && !args.guest) return 'guest';
  if (Object.keys(args).length < (schema.minProperties ?? 0)) return 'change';
  return Object.entries(args).find(([, value]) => agentArgumentRefs(value).some(ref => ref.slot && !slots.includes(ref.slot)))?.[0];
}

export function agentFieldChoices(command, field) {
  if (field === 'change') return AGENT_COMMAND_CATALOG[command]?.optional ?? [];
  const values = AGENT_COMMAND_SCHEMAS[command]?.properties[field]?.enum;
  return (values ?? []).filter(value => value !== null);
}
export function agentArgumentRefs(value, schema) {
  if (Array.isArray(value)) return value.flatMap(item => agentArgumentRefs(item));
  if (!plainObject(value)) return [];
  if (Object.hasOwn(value, 'slot')) return [{ slot: value.slot }];
  if (schema?.anyOf) schema = schema.anyOf.find(choice => matches(choice, value));
  if (Object.hasOwn(value, 'handle')) return [{ handle: value.handle, kinds: targetSchemes.get(schema) }];
  return Object.entries(value).flatMap(([field, child]) => agentArgumentRefs(child, schema?.properties?.[field]));
}
export function agentCommandRefs(command, args) {
  return agentArgumentRefs(args, wireCommands[command]);
}
export function agentToolRefs(name, args) {
  return agentArgumentRefs(args, AGENT_TOOLS[name]?.function.parameters);
}

// N03 detail, shell and local-form contracts. The expanded values are checked
// again by the browser after expanding slots and resolving snapshot handles.
const detailHours = integer(0, 23);
// N20 keeps the browser-local keyword ID format while scoping detail handles.
const localTrendId = { ...key };
handleKinds.set(localTrendId, ['localTrend']);
// End N20 keyword detail target.
const detailMemberGrade = oneOf('regular', 'frequent', 'occasional', 'inactive');
const couponBenefit = oneOf('free-shot', 'percent-10', 'amount-500');
const navigationBoards = oneOf('management', 'marketing');
const navigationGroups = oneOf('recommended', 'products', 'stock', 'finance', 'members', 'store',
  'misc', 'schedule', 'news', 'money', 'customers', 'neighborhood');
const dateRange = condition.anyOf[2];
const detailPeriod = either(condition.anyOf[0], dateRange);
const settlementPurpose = oneOf('charge_topup', 'receivable_collection', 'refund');
const actionFocus = oneOf('action');

const widgetPrefill = freeze({
  // N04 menu registration and margin simulator fields.
  menu: menuFields,
  margin: { price, cost: integer() },
  // End N04 menu registration and margin simulator fields.
  'inventory-booking': { sku: text, name: text, unit, stock: number(), threshold: number(), trackRestock: flag },
  // N09 order form prefill uses local values. The form resolves the purchase row.
  suppliers: { purchaseItemId: id, qty: positive, dueDate: date },
  // End N09 order form prefill.
  // N11 money form prefill.
  ledger: { amount: price, date, category: expenseCategory, memo: text, evidence: oneOf('receipt', 'tax-invoice', 'card', 'none') },
  tax: { taxType: text, amount: price, dueOn: date },
  // End N11 money form prefill.
  members: { name: text, phone },
  'credit-receivable': { purpose: settlementPurpose, memberId, amount: price },
  'custom-order': { templateId, ...customFields },
  'voice-booking': bookingFields,
  calendar: eventFields,
  // N10 staff detail routing.
  'staff-schedule': { name: text, staffId, scheduleId, date, start: time, end: time, breakMinutes: integer(), orientation: oneOf('employee', 'date') },
  manuals: manualFields,
  grants: { body: string(900) }, // N14 unsaved application draft.
  'notice-send': noticeFields,
  'ai-response': { threadId, body: text },
  community: { offerId, body: text },
  'slot-coupon': {
    slotId: target('slot'), benefit: couponBenefit, excludeRecipients: unique(id, 50), messageText: text,
    sendMode: oneOf('now', 'schedule'), sendTime: time,
  },
  'expiry-coupon': { itemId: stockId, rate: integer(1, 100), withSet: flag },
  'coupon-status': { couponId, body: text, sendAt: dateTime },
  'customer-groups': { groupId: oneOf('regular', 'first-visit', 'churn-risk'), messageBody: text },
  'promo-video': { ...promoDraft, tab: integer(0, 3), composing: oneOf(true) },
});

function detailViews(views, extra = {}) {
  const view = oneOf(...views);
  return { view, tab: view, ...extra };
}

const detailWidgets = freeze({
  // N04 menu detail focus.
  menu: detailViews(['list', 'item', 'register', 'recipe', 'options'], { itemId: menuId, focus: actionFocus }),
  // N05 inventory detail focus.
  'inventory-booking': detailViews(['ingredients', 'materials', 'products', 'register', 'history'], { itemId: stockId, focus: actionFocus }),
  // End N05 inventory detail focus.
  suppliers: detailViews(['orders', 'order', 'purchase-items', 'suppliers', 'register'], {
    itemId: target('purchaseOrder', 'purchaseItem', 'supplier'),
  }),
  // N04 margin detail focus.
  margin: detailViews(['items', 'simulator'], { itemId: menuId, condition: detailPeriod, focus: actionFocus }),
  // N11 money detail tabs and unsaved forms.
  ledger: detailViews(['sales', 'expenses', 'profit', 'candidates', 'evidence'], {
    itemId: target('expense', 'candidate'), condition: detailPeriod, focus: actionFocus,
  }),
  tax: detailViews(['payments', 'checks', 'evidence'], { itemId: target('taxPayment', 'taxItem'), condition: detailPeriod, focus: actionFocus }),
  // End N11 money detail tabs and unsaved forms.
  members: detailViews(['list', 'memberships', 'register'], { itemId: memberId, filter: record({ grade: detailMemberGrade }) }),
  'credit-receivable': detailViews(['charge', 'receivable', 'history', ...settlementPurpose.enum], { itemId: memberId, focus: actionFocus }),
  'custom-order': detailViews(['register', 'templates', 'pickup'], { itemId: target('customOrder', 'customTemplate', 'reservation') }),
  'voice-booking': detailViews(['date', 'register'], { itemId: reservationId, date, time }),
  calendar: detailViews(['day', 'week', 'month', 'add'], { itemId: eventId, date, focus: actionFocus }),
  'staff-schedule': detailViews(['week', 'month', 'staff', 'history', 'add-staff'], {
    itemId: staffDetailId, date, focus: actionFocus,
  }),
  manuals: detailViews(['handover', 'store-info'], { itemId: manualId, focus: actionFocus }),
  grants: detailViews(['notices', 'applications', 'template', 'official'], { itemId: target('grantNotice', 'grantApplication'), focus: actionFocus }), // N14
  'notice-send': detailViews(['drafts', 'history', 'compose', 'scheduled'], { itemId: target('noticeDraft', 'noticeSent'), focus: actionFocus }),
  briefing: detailViews(['alerts', 'closing']),
  'customer-analysis': detailViews(['setup', 'zones'], { date, hour: detailHours }),
  'store-environment': detailViews(['sensor', 'player']),
  'local-changes': detailViews(['open', 'folded'], { itemId: target('localChange') }),
  'trade-area': detailViews(['hour'], { hour: detailHours, condition: detailPeriod }),
  'local-trends': detailViews(['keywords'], { itemId: localTrendId, condition: detailPeriod }), // N20
  'ai-response': detailViews(['message', 'review', 'waiting', 'history'], {
    itemId: threadId, filter: oneOf('praise'), focus: actionFocus,
  }),
  community: detailViews(['received', 'browse'], { itemId: offerId }),
  'slot-coupon': detailViews(['send'], { itemId: target('slot'), focus: actionFocus }),
  'expiry-coupon': detailViews(['create'], { itemId: stockId, focus: actionFocus }),
  'coupon-status': detailViews(['active', 'ended', 'reminder'], { itemId: couponId, focus: actionFocus }),
  'customer-groups': detailViews(['regular', 'first-visit', 'churn-risk', 'reach-out'], { focus: actionFocus }),
  'promo-video': detailViews(['create'], { itemId: videoId, focus: actionFocus }),
});

const detailWidgetId = oneOf(...Object.keys(detailWidgets));
const navigationWidgetId = oneOf(...detailWidgetId.enum, 'marketing-today');
const shellNavigation = freeze({
  'ui.switch_layer': record({ layer }),
  'ui.go_to_page': record({ page }),
  'ui.show_panel': record({ featureId: navigationWidgetId, layer: navigationBoards, page }, ['featureId']),
  'ui.go_back': record({}),
  'ui.open_drawer': optional({ group: navigationGroups, query: string(120) }),
  'ui.close_overlay': record({}),
  'ui.open_settings': optional({ view: oneOf('preview', 'tables') }),
  'ui.open_widget_help': record({ featureId: navigationWidgetId }),
  'ui.close_chat': record({}),
  'ui.skip_coaches': record({}),
  'ui.enter_layout_edit': record({}),
  'ui.exit_layout_edit': record({}),
  'ui.set_pos_tab': record({ tab: oneOf('order', 'status', 'tables') }),
  'ui.open_closing': optional({ tab: closureTab }),
});
export const AGENT_NAVIGATION_COMMANDS = freeze(['ui.openDetail', ...Object.keys(shellNavigation)]);
export const isAgentNavigationCommand = command => AGENT_NAVIGATION_COMMANDS.includes(command);

function n03DetailRules(featureId, view, wire) {
  if (typeof featureId !== 'string' || !Object.hasOwn(detailWidgets, featureId)) {
    return record({ featureId: detailWidgetId });
  }
  const detail = detailWidgets[featureId];
  const rules = { featureId: detailWidgetId, condition: condition.anyOf[0], ...detail };
  const itemKind = {
    suppliers: { orders: 'purchaseOrder', order: 'purchaseOrder', 'purchase-items': 'purchaseItem', suppliers: 'supplier' },
    grants: { notices: 'grantNotice', applications: 'grantApplication', template: 'grantNotice', official: 'grantNotice' },
    'notice-send': { drafts: 'noticeDraft', history: 'noticeSent', compose: 'noticeDraft' },
    'custom-order': { templates: 'customTemplate', pickup: 'reservation' },
  }[featureId];
  const specifiedKind = typeof view === 'string' && itemKind && Object.hasOwn(itemKind, view) ? itemKind[view] : undefined;
  if (specifiedKind) rules.itemId = target(specifiedKind);
  // N20 accepts both the original browser-local slot and the scoped detail handle.
  if (wire && featureId === 'local-trends') rules.itemId = either(slotRef, wireSchema(rules.itemId));
  else if (wire && rules.itemId) rules.itemId = wireSchema(rules.itemId);
  if (Object.hasOwn(widgetPrefill, featureId)) {
    rules.prefill = n03PrefillRule(featureId, wire);
  }
  return record(rules, ['featureId']);
}

function n03PrefillRule(featureId, wire) {
  if (typeof featureId !== 'string' || !Object.hasOwn(widgetPrefill, featureId)) return undefined;
  const expanded = patch(widgetPrefill[featureId]);
  return wire ? wireSchema(expanded) : expanded;
}

export function validateAgentPrefill(featureId, value) {
  const rule = n03PrefillRule(featureId, false);
  if (!rule || !matches(rule, value)) return false;
  if (value.startDate && value.endDate && value.startDate > value.endDate) return false;
  if (featureId === 'slot-coupon' && value.sendMode === 'now' && value.sendTime) return false;
  return true;
}

function n03NavigationSchema(command, args, wire) {
  if (command === 'ui.openDetail') return n03DetailRules(args.featureId, args.view ?? args.tab, wire);
  if (wire && command === 'ui.open_drawer') return optional({ group: navigationGroups, query: slotRef });
  return shellNavigation[command];
}

export function agentNavigationIssue(command, args, wire = false) {
  if (!isAgentNavigationCommand(command) || !plainObject(args)) return 'target';
  const rule = n03NavigationSchema(command, args, wire);
  for (const field of rule.required) if (!Object.hasOwn(args, field)) return field;
  for (const [field, value] of Object.entries(args)) {
    if (!Object.hasOwn(rule.properties, field)) {
      return Object.hasOwn(detailRef, field) || ['hour', 'time'].includes(field) ? field : 'target';
    }
    if (!matches(rule.properties[field], value)) return field;
  }
  if (command !== 'ui.openDetail') return undefined;
  if (args.condition && !validCondition(args.condition)) return 'condition';
  if (args.view && args.tab && args.view !== args.tab) return 'tab';
  const view = args.view ?? args.tab;
  if (args.itemId && view === 'register') return 'itemId';
  // N04 prefill applies only to a new menu or an item's read-only simulator.
  if (args.featureId === 'margin' && args.prefill && (view !== 'simulator' || !args.itemId)) return 'prefill';
  // N14 unsaved grant application text belongs to the template editor.
  if (args.featureId === 'grants' && view !== 'template') {
    if (args.prefill) return 'prefill';
    if (args.focus) return 'focus';
  }
  if (args.prefill && ((!wire && !validateAgentPrefill(args.featureId, args.prefill))
    || args.featureId === 'slot-coupon' && args.prefill.sendMode === 'now' && args.prefill.sendTime)) return 'prefill';
  return undefined;
}

export const validateAgentDetailRef = ref => !agentNavigationIssue('ui.openDetail', ref);
export const validateAgentNavigationArgs = (command, args) => !agentNavigationIssue(command, args);
export const validateAgentNavigationWireArgs = (command, args) => !agentNavigationIssue(command, args, true);

export function agentNavigationRefs(command, args, field) {
  const rule = n03NavigationSchema(command, args, true);
  return agentArgumentRefs(args[field], rule.properties[field]);
}

export function agentNavigationItemKinds(ref) {
  if (!validateAgentNavigationWireArgs('ui.openDetail', ref)) return [];
  const rule = n03DetailRules(ref.featureId, ref.view ?? ref.tab, false);
  return handleKinds.get(rule.properties.itemId) ?? [];
}

export function agentNavigationHandoffIssue(command, draft, wire = false) {
  if (command === 'tax.setEvidence') {
    if (!draft?.taxPaymentId) return 'taxPaymentId';
    if (draft.evidence !== 'example' || !(wire ? validateAgentDraft(command, draft) : validateAgentCommandArgs(command, draft))) return 'evidence';
    return undefined;
  }
  // N06 requires both scoped suggestion fields before opening the handoff.
  if (command === 'booking.propose') {
    if (!draft?.reservationId) return 'reservationId';
    if (!draft.time || !(wire ? validateAgentDraft(command, draft) : validateAgentCommandArgs(command, draft))) return 'time';
    return undefined;
  }
  // End N06 suggestion handoff.
  if (command === 'ui.openSettlement') {
    if (!plainObject(draft)) return 'purpose';
    const rule = AGENT_COMMAND_SCHEMAS[command];
    for (const field of rule.required) if (!Object.hasOwn(draft, field)) return field;
    return (wire ? validateAgentDraft(command, draft) : validateAgentCommandArgs(command, draft)) ? undefined : 'amount';
  }
  if (command !== 'ui.setDraftField') return undefined;
  if (!plainObject(draft) || !matches(detailWidgetId, draft.featureId)) return 'featureId';
  const rule = n03PrefillRule(draft.featureId, wire);
  if (!matches(fieldId, draft.field) || !rule || !Object.hasOwn(rule.properties, draft.field)) return 'value';
  const ref = { featureId: draft.featureId, ...(draft.view ? { view: draft.view } : {}) };
  const issue = agentNavigationIssue('ui.openDetail', ref, wire);
  if (issue) return issue;
  if (wire) return matches(slotRef, draft.value) ? undefined : 'value';
  return validateAgentPrefill(draft.featureId, { [draft.field]: draft.value }) ? undefined : 'value';
}

// Form destinations cannot carry execution/preview authority from an intent.
export function agentHandoffFields(command, draft) {
  // N13 corrections are authorized and quoted in the widget.
  if (command === 'customOrder.cancel' || command === 'pickup.cancel') {
    const { confirmedCorrectionQuoteId: _quoteId, ...prefill } = draft;
    return prefill;
  }
  if (command === 'notice.send') {
    const { previewId: _previewId, draftRevision: _draftRevision, ...prefill } = draft;
    return prefill;
  }
  return draft;
}

const navigationResult = record({
  command: oneOf(...AGENT_NAVIGATION_COMMANDS), args: optional({}), runId: id, snapshotRevision: integer(), layer, page,
}, ['command', 'args', 'runId', 'snapshotRevision', 'layer']);
const navigationDone = record({ outcome: oneOf('navigate'), navigation: navigationResult });
function validNavigationDone(data) {
  if (!plainObject(data.navigation?.args) || !validateAgentNavigationWireArgs(data.navigation.command, data.navigation.args)) return false;
  return matches(navigationDone, { ...data, navigation: { ...data.navigation, args: {} } });
}

function navigationRequestForValidation(value) {
  if (value?.intent?.kind !== 'command' || !isAgentNavigationCommand(value.intent.command)) return value;
  const { args } = value.intent;
  // Preserve invalid fields for a typed clarification without exposing them upstream.
  if (args === undefined || !plainObject(args) || Object.keys(args).length > 16) return value;
  return { ...value, intent: { ...value.intent, args: {} } };
}
// End N03 detail, shell and local-form contracts.

// N04 menu edit and read projections. Full recipe and option edits travel in
// browser-local slots. Only display facts and scoped handles reach the model.
export const AGENT_MENU_EDIT_COMMANDS = freeze([
  'menu.update', 'menu.setSaleStatus', 'menu.delete', 'menu.setRecipe', 'menu.setOptions',
]);
const distinctMenuValues = values => new Set(values).size === values.length;
const menuBaseQuantity = (value, measure) => {
  const base = value * (measure === 'kg' || measure === 'L' ? 1000 : 1);
  const rounded = Math.round(base);
  return Number.isSafeInteger(rounded) && rounded > 0 && Math.abs(base - rounded) < 1e-7;
};

export function validateAgentMenuEditArgs(command, args) {
  if (!AGENT_MENU_EDIT_COMMANDS.includes(command) || !validateAgentCommandArgs(command, args)) return false;
  if (command === 'menu.setRecipe') {
    const { lines } = args;
    return distinctMenuValues(lines.map(line => line.itemId))
      && distinctMenuValues(lines.flatMap(line => line.recipeLineId ? [line.recipeLineId] : []))
      && lines.every(line => menuBaseQuantity(line.quantity, line.unit));
  }
  if (command === 'menu.setOptions') {
    const { groups } = args;
    return distinctMenuValues(groups.flatMap(group => [group.groupId, ...group.options.map(item => item.optionId)]))
      && groups.every(group => (group.archivedAt || !group.required || group.options.some(item => !item.archivedAt))
        && group.options.every(item => distinctMenuValues(item.extraRecipe.map(part => part.itemId))));
  }
  return true;
}

const menuSimulationFacts = ['price', 'unitCost', 'unitMargin', 'rate', 'unitMarginDelta', 'rateDelta']
  .map(key => `margin.simulation.${key}`);
function validMenuReading(reading) {
  if (!reading.facts) return true;
  if (reading.tool === 'get_recipe') {
    return reading.facts.length <= 64 && reading.facts.every(({ key, value, unit: measure }) =>
      key === 'menu.recipe.line' && matches(unit, measure) && typeof value === 'number' && menuBaseQuantity(value, measure));
  }
  if (reading.tool !== 'simulate_menu_price') return true;
  // The browser computes the estimate from the same scoped menu and draft
  // inputs as the Margin widget.
  const { facts } = reading;
  if (![4, 6].includes(facts.length) || !distinctMenuValues(facts.map(fact => fact.key))) return false;
  const values = new Map(facts.map(({ key, value }) => [key, value]));
  if (!menuSimulationFacts.slice(0, facts.length).every(key => Number.isFinite(values.get(key)))) return false;
  const [price, cost, margin, rate] = menuSimulationFacts.map(key => values.get(key));
  if (!Number.isSafeInteger(price) || price <= 0 || !Number.isSafeInteger(cost) || cost < 0 || price - cost !== margin) return false;
  const rateAtPrice = (margin / price) * 100;
  // Same one-decimal rounding as the Margin selector, including negative rates.
  return rate === Math.round(rateAtPrice * 10 + (rateAtPrice >= 0 ? 1e-9 : -1e-9)) / 10;
}
// End N04 menu edit and read projections.

const catalogEntry = record({ id, name: string(80), layer, description: string(160), conditions: array(condition, 32, 1) }, ['id', 'name', 'layer', 'conditions']);
const fact = record({
  key: string(100), value: either(number(-Number.MAX_VALUE, Number.MAX_VALUE), string(500, '')),
  unit: string(40, ''), label: string(250), display: string(500),
  date, start: date, end: date, source: string(100), text: string(500),
}, ['key', 'value', 'unit', 'label', 'display']);
const unavailableStatus = oneOf('missing', 'unavailable', 'unsupported_period');
const widgetFacts = { condition, facts: array(fact, 128) };
const missingFacts = { condition, status: unavailableStatus };
const snapshot = either(
  record({ featureId: widgetId, ...widgetFacts }),
  record({ featureId: widgetId, condition, unavailable: oneOf(true) }),
  record({ featureId: widgetId, ...missingFacts }),
  record({ sourceId: source, ...widgetFacts, candidateAllowed: oneOf(false) }, ['sourceId', 'condition', 'facts']),
  record({ sourceId: source, condition, unavailable: oneOf(true), candidateAllowed: oneOf(false) }, ['sourceId', 'condition', 'unavailable']),
  record({ sourceId: source, ...missingFacts, candidateAllowed: oneOf(false) }, ['sourceId', 'condition', 'status']),
);
const searchMatch = oneOf('exact', 'similar');
const searchProjection = either(...Object.entries(recordFields).map(([kind, properties]) => record({
  ...searchArgs.properties, kind: oneOf(kind),
  matches: array(record({
    handle: id, match: searchMatch, label: string(180),
    ...(kind === 'menu' ? { category, price } : {}), fields: optional(properties),
  }, ['handle', 'match']), 5), nextCursor: id, queryBinding: id, status: unavailableStatus,
}, ['kind', 'querySlot', 'matches'])));
const readingProjection = either(...AGENT_EXTRA_READ_TOOLS.map(name => {
  const params = AGENT_TOOLS[name].function.parameters;
  return either(
    record({ tool: oneOf(name), args: params, facts: array(fact, 128) }),
    record({ tool: oneOf(name), args: params, status: unavailableStatus }),
  );
}));
const commandIntent = either(...Object.entries(draftSchemas).map(([command, args]) => record({
  kind: oneOf('command'), command: oneOf(command), args, querySlot: fieldId,
}, ['kind', 'command'])),
record({ kind: oneOf('command'), command: oneOf('menu.setSaleStatus'), clarify: oneOf('menuId') }),
record({ kind: oneOf('command'), command: oneOf('menu.setSaleStatus'), clarify: oneOf('status'), querySlot: fieldId }),
record({ kind: oneOf('command'), command: oneOf('ledger.confirmCandidate'), clarify: oneOf('expenseId') }));
const compiledReadLimit = 4;
const compiledRead = either(
  record({ name: oneOf('get_widget'), args: record({ featureId: widgetId, condition }, ['featureId']) }),
  record({ name: oneOf('get_source'), args: record({ sourceId: source, condition }, ['sourceId']) }),
  record({ name: oneOf('search_records'), args: record({ ...searchArgs.properties,
    kind: oneOf(...AGENT_RECORD_KINDS, 'order') }, searchArgs.required) }),
);
const readIntent = either(
  record({ kind: oneOf('read'), reads: array(compiledRead, compiledReadLimit), queryBinding: id }, ['kind', 'reads']),
  record({ kind: oneOf('read'), featureId: id, sourceId: source, condition, recordKind, querySlot: fieldId,
    tool: oneOf(...AGENT_EXTRA_READ_TOOLS), queryBinding: id, cursor: id }, ['kind']),
);

/** Input aliases and defaults stop here. Model tool calls use strict canonical arguments. */
export function normalizeAgentReadSelection(selection) {
  if (!matches(compiledRead, selection)) return undefined;
  const { name, args } = selection;
  const normalized = name === 'search_records' ? { ...args, kind: args.kind === 'order' ? 'purchaseOrder' : args.kind }
    : { ...args, condition: args.condition ?? { kind: 'default' } };
  if (validateAgentToolArgs(name, normalized)) return { name, args: normalized };
  return undefined;
}

function validReadIntent(intent, slots) {
  if (intent.reads) return (!intent.queryBinding || intent.reads.length === 1 && intent.reads[0].name === 'search_records')
    && intent.reads.every(selection => normalizeAgentReadSelection(selection)
      && (!slots || selection.name !== 'search_records' || slots.includes(selection.args.querySlot)));
  return [intent.featureId, intent.sourceId, intent.tool].filter(Boolean).length <= 1
    && (!intent.condition || validCondition(intent.condition))
    && (!intent.cursor || intent.queryBinding) && (!intent.queryBinding || intent.recordKind && intent.querySlot);
}
// N02 conversation controls. Private continuation values and undo tokens stay local.
const conversationKind = oneOf('conversation');
const conversationIntent = either(
  record({ kind: conversationKind, action: oneOf('confirm'), pendingId: id, target: id }, ['kind', 'action', 'pendingId']),
  record({ kind: conversationKind, action: oneOf('confirm_extra'), pendingId: id, challengeId: id }),
  record({ kind: conversationKind, action: oneOf('cancel', 'edit'), pendingId: id }),
  record({ kind: conversationKind, action: oneOf('continue'), pendingId: id,
    selection: either(record({ querySlot: fieldId, handle: id }), record({ recordKind, querySlot: fieldId, handle: id, queryBinding: id })) }, ['kind', 'action', 'pendingId']),
  record({ kind: conversationKind, action: oneOf('undo'), pendingId: id, featureId: id, previous: flag }, ['kind', 'action']),
  record({ kind: conversationKind, action: oneOf('refer'), ordinal: integer(1, 5), recordKind, featureId: id }, ['kind', 'action']),
  record({ kind: conversationKind, action: oneOf('repeat_read'), period: oneOf('yesterday', 'previous_month') }, ['kind', 'action']),
  record({ kind: conversationKind, action: oneOf('repeat_read'), period: oneOf('month'), month: integer(1, 12) }),
  record({ kind: conversationKind, action: oneOf('repeat_command', 'hold') }),
);
const conversationChoice = either(
  record({ type: oneOf('record'), recordKind, querySlot: fieldId, handle: id, queryBinding: id }, ['type', 'recordKind', 'querySlot', 'handle']),
  record({ type: oneOf('widget'), featureId: id }),
  record({ type: oneOf('undo'), receiptId: id, target: oneOf('data', 'layout') }),
);
const conversationResolution = either(
  conversationChoice,
  record({ type: oneOf('confirm', 'cancel', 'edit'), pendingId: id }),
  record({ type: oneOf('continue'), pendingId: id, field: fieldId }),
  record({ type: oneOf('extra_confirm'), pendingId: id, challengeId: id }),
  record({ type: oneOf('reprepare'), pendingId: id, command: knownCommands }, ['type', 'command']),
  record({ type: oneOf('choose'), choices: array(conversationChoice, 5, 2) }),
  record({ type: oneOf('hold') }),
  record({ type: oneOf('unavailable'), reason: oneOf('pending_missing', 'target_required', 'reference_missing',
    'undo_expired', 'undo_unavailable'), featureId: id }, ['type', 'reason']),
);
// End N02 conversation controls.
// D-371: the owner's sentence may go to the model for READ-ONLY intent classification. The request carries the sentence, the browser's
// widget list (one "id|name|fact labels" line each) and an optional one-line summary of the previous turn. The answer is an intent plan.
export const INTENT_PLAN_PERIODS = freeze(['today', 'yesterday', 'tomorrow', 'week', 'lastWeek', 'month', 'lastMonth', 'last30', 'default']);
const classifyIntent = record({ kind: oneOf('classify'), text: string(240), widgets: array(string(400), 64, 1), previous: string(300) }, ['kind', 'text', 'widgets']);
// D-380: the model may write the answer sentences. The browser sends the question and the fact lines it already shows; the answer is checked
// against those lines by navis-answer-guard before it leaves the server and again before it is shown. It carries no command and writes nothing.
const composeIntent = record({ kind: oneOf('compose'), text: string(240), lines: array(string(240), 24, 1), previous: string(300) }, ['kind', 'text', 'lines']);
const planRead = record({ featureId: widgetId, period: oneOf(...INTENT_PLAN_PERIODS), hints: array(string(24), 4) }, ['featureId', 'period']);
// `compute` asks the browser for one derived number from two reads (a sum, a difference or a ratio of their first matching amounts).
const planCompute = record({ op: oneOf('sum', 'diff', 'ratio', 'min', 'max'), left: integer(0, 3), right: integer(0, 3) });
const intentPlan = either(
  record({ kind: oneOf('read'), reads: array(planRead, 4, 1), confidence: oneOf('high', 'low'), compute: planCompute }, ['kind', 'reads', 'confidence']),
  record({ kind: oneOf('clarify'), ask: string(120) }),
  record({ kind: oneOf('unsupported') }),
);
export const validateIntentPlan = value => matches(intentPlan, value);
const intent = either(
  record({ kind: oneOf('menu.create'), category }),
  commandIntent,
  readIntent,
  record({ kind: oneOf('help', 'layout', 'unsupported') }),
  conversationIntent,
  classifyIntent,
  composeIntent,
);
const request = record({
  runId: id, snapshotRevision: integer(), locale, layer, page, businessDate: date, intent,
  conversation: oneOf(true),
  slots: unique(fieldId, 48), catalog: array(catalogEntry, 32), snapshot: array(snapshot, 128),
  searches: array(searchProjection, 32), readings: array(readingProjection, 32), references: array(record({ featureId: widgetId, condition }), 6),
}, ['runId', 'snapshotRevision', 'layer', 'businessDate', 'intent', 'slots', 'catalog', 'snapshot', 'searches']);

// N08 browser-projected presentation and closing facts. Shared read tools also
// carry other slices' facts, so enforce the types only for the fields N08 owns.
export const AGENT_SETTINGS_COMMANDS = freeze(AGENT_COMMANDS.filter(command => command.startsWith('settings.')));
const n08DisplayFacts = {
  'ui.theme': oneOf('light', 'dark'),
  'ui.textScale': oneOf(100, 125),
  'ui.locale': locale,
  'ui.detailFullscreen': oneOf(0, 1),
  'ui.preview.family': oneOf('normal', 'empty', 'error', 'special'),
  'ui.preview.overrideCount': integer(),
  'ui.preview.closing': oneOf('inherit', 'normal', 'no-payments', 'error'),
  'ui.preview.pos': oneOf('inherit', 'normal', 'empty', 'error', 'payment-failure'),
  'ui.pos.approvalPending': oneOf(0, 1),
};
const n08ClosingFacts = {
  'closing.status': oneOf('open', 'closed', 'reopened'),
  'closing.closedAt': clockStamp,
  'closing.pendingBills': integer(),
  'closing.approvalPending': oneOf(0, 1),
  'closing.canClose': oneOf(0, 1),
  'closing.drawer.expected': integer(-Number.MAX_SAFE_INTEGER),
  'closing.drawer.actual': either(integer(), oneOf('unconfirmed')),
  'closing.drawer.difference': integer(-Number.MAX_SAFE_INTEGER),
  'closing.history.count': integer(),
};
function validN08Reading({ tool, facts }) {
  const fields = tool === 'get_ui_state' ? n08DisplayFacts : tool === 'get_closing_state' ? n08ClosingFacts : undefined;
  return !fields || (facts ?? []).every(({ key: name, value }) => {
    if (Object.hasOwn(fields, name)) return matches(fields[name], value);
    if (tool === 'get_ui_state' && /^ui\.preview\.(?:variant|override)\./u.test(name)) {
      return matches(widgetId, name.split('.').at(-1)) && matches(widgetId, value);
    }
    return true;
  });
}
function validN08Source(entry) {
  return entry.sourceId !== 'pos' || validN08Reading({ tool: 'get_closing_state', facts: entry.facts });
}
// End N08 browser-projected facts.

// D-325: A single delete may resolve to one target. Preserve ambiguity within
// a lookup so the owner can select one, while rejecting independently resolved targets.
const singleDeleteKinds = new Map([
  ['menu.delete', 'menu'], ['calendar.deleteEvent', 'event'], ['staff.deleteSchedule', 'shift'],
  ['tax.deletePayment', 'taxPayment'], ['members.delete', 'member'],
]);
function hasMultipleDeleteTargets(intent, searches) {
  const kind = intent.kind === 'command' && singleDeleteKinds.get(intent.command);
  if (!kind) return false;
  const exactTargets = new Set();
  for (const search of searches) {
    if (search.kind !== kind || search.cursor || search.nextCursor) continue;
    const exact = search.matches.filter(match => match.match === 'exact');
    if (exact.length === 1) exactTargets.add(exact[0].handle);
  }
  return exactTargets.size > 1;
}
// End D-325 single-delete validation.

export function validateAgentRequest(value) {
  if (!matches(request, navigationRequestForValidation(value))) return false; // N03
  const { intent, slots } = value;
  if (hasMultipleDeleteTargets(intent, value.searches)) return false; // D-325
  if (intent.kind === 'read' && !validReadIntent(intent, slots)) return false;
  if (intent.kind === 'conversation' && intent.action === 'continue' && intent.selection && !slots.includes(intent.selection.querySlot)) return false;
  if (intent.condition && !validCondition(intent.condition) || intent.querySlot && !slots.includes(intent.querySlot)) return false;
  const privateKinds = new Set(['member', 'customer', 'note', 'supplier', 'reservation', 'thread', 'customOrder']);
  const unmaskedContact = /(?:\p{Nd}[ .()-]*){8,}/u;
  return value.catalog.every(entry => entry.conditions.every(validCondition))
    && value.snapshot.every(entry => validCondition(entry.condition))
    && value.snapshot.every(validN08Source)
    && (value.readings ?? []).every(validN08Reading)
    && (value.references ?? []).every(ref => validCondition(ref.condition))
    && (value.readings ?? []).every(validMenuReading)
    && value.searches.every(search => (!search.cursor || search.queryBinding) && (!search.status || search.matches.length === 0 && !search.nextCursor)
      && (!privateKinds.has(search.kind) || search.matches.every(match => !match.label || !unmaskedContact.test(match.label))));
}

export const AGENT_PRICE_CLARIFICATION = freeze({
  field: 'price', promptKey: 'menu.price',
  choices: [{ id: '4500', value: 4500 }, { id: '5000', value: 5000 }, { id: '5500', value: 5500 }, { id: 'manual' }],
});
const modelReply = either(
  record({ outcome: oneOf('clarify'), field: fieldId }),
  record({ outcome: oneOf('reply'), facts: array(string(5, '^f\\d{1,4}$'), 12), text: string(16384) }, ['outcome']),
  record({ outcome: oneOf('refused') }),
);
export const validateAgentModelReply = value => matches(modelReply, value);

export const AGENT_STATUS_STEPS = freeze(['accepted', 'read_started', 'target_checked', 'assembling']);
export const AGENT_ERROR_CODES = freeze(['INVALID_OUTPUT', 'TIMEOUT', 'UNAVAILABLE', 'CANCELLED', 'OUT_OF_SCOPE']);
const size = record({ width: sizeValue, height: sizeValue });
const clarificationChoice = either(
  record({ id: oneOf('manual') }),
  record({ id, value: either(key, number(), flag) }),
);
const ambiguityChoice = record({ id, handle: id, label: string(180), category, price }, ['id', 'handle']);
const clarification = record({ field: fieldId, promptKey: key, choices: array(clarificationChoice, 6, 1), command: knownCommands }, ['field', 'promptKey', 'choices']);
const ambiguity = record({
  field: fieldId, promptKey: key, recordKind, querySlot: fieldId, choices: array(ambiguityChoice, 5, 1), nextCursor: id, queryBinding: id,
}, ['field', 'promptKey', 'recordKind', 'querySlot', 'choices']);
const routes = either(...Object.entries(draftSchemas).map(([command, draft]) => record({
  featureId: id, command: oneOf(command), draft, runId: id, snapshotRevision: integer(),
}, ['featureId', 'command', 'draft'])));
const refusal = record({
  reason: oneOf('widget_only', 'unsupported', 'unavailable', 'duplicate', 'invalid_target', 'out_of_scope'),
  alternative: either(routes, record({ featureId: widgetId })),
}, ['reason']);
const binding = {
  proposalId: id, runId: id, layer, page, tier: oneOf('normal', 'extra-confirm'),
};
const frameSchemas = {
  status: record({ step: oneOf(...AGENT_STATUS_STEPS), featureId: id }, ['step']),
  text_delta: record({ delta: string(16384) }),
  panels: record({ panels: array(record({ featureId: widgetId, condition, size, reason: text }), 3) }),
  action_proposal: either(...Object.entries(proposalSchemas).map(([command, schema]) => record({
    ...schema.properties, snapshotRevision: integer(), ...binding,
  }, command === 'menu.create' ? ['command', 'args', 'snapshotRevision'] : [
    'command', 'args', 'snapshotRevision', 'proposalId', 'runId', 'layer', 'tier',
  ]))),
  done: either(
    record({ outcome: oneOf('reply'), readStatuses: array(oneOf('ready', ...unavailableStatus.enum), compiledReadLimit) }, ['outcome']),
    record({ outcome: oneOf('proposal') }),
    record({ outcome: oneOf('refused'), refusal }, ['outcome']),
    record({ outcome: oneOf('clarify'), clarification, pendingId: id }, ['outcome', 'clarification']),
    record({ outcome: oneOf('ambiguous'), clarification: ambiguity, pendingId: id }, ['outcome', 'clarification']),
    record({ outcome: oneOf('handoff'), handoff: routes }),
    record({ outcome: oneOf('conversation'), resolution: conversationResolution }),
  ),
  error: record({ code: oneOf(...AGENT_ERROR_CODES) }),
  intent_plan: record({ plan: intentPlan }),
  composed: record({ text: string(600), used: array(integer(0, 23), 24) }, ['text']),
  action_result: record({ proposalId: id, outcome: oneOf('applied', 'unchanged', 'invalid', 'busy', 'conflict', 'cancelled'), revision: integer(), messageKey: string(120) }, ['proposalId', 'outcome']),
};

export function validateAgentFrame(event, data) {
  if (event === 'done' && data?.outcome === 'navigate') return validNavigationDone(data); // N03
  if (!Object.hasOwn(frameSchemas, event) || !matches(frameSchemas[event], data)) return false;
  if (event === 'action_proposal') {
    const { command, args, tier } = data;
    return !isAgentNavigationCommand(command) && validateAgentToolArgs('propose_action', { command, args })
      && (AGENT_COMMAND_CATALOG[command].confirmation !== 'extra-confirm' || tier === 'extra-confirm');
  }
  if (event === 'panels') return data.panels.every(panel => validCondition(panel.condition));
  if (event !== 'done') return true;
  if (data.outcome === 'clarify') {
    const { choices, command, field, promptKey } = data.clarification;
    if (!command && promptKey !== 'menu.price') return false;
    if (command && !AGENT_COMMAND_CATALOG[command].required.concat(AGENT_COMMAND_CATALOG[command].optional).includes(field)
      && !(field === 'change' && wireCommands[command].minProperties)
      && !(isAgentNavigationCommand(command) && ['target', 'hour', 'time'].includes(field))) return false; // N03
    if (promptKey === 'menu.price') return field === 'price' && choices.length === AGENT_PRICE_CLARIFICATION.choices.length
      && choices.every((choice, index) => choice.id === AGENT_PRICE_CLARIFICATION.choices[index].id
        && choice.value === AGENT_PRICE_CLARIFICATION.choices[index].value);
    return new Set(choices.map(choice => choice.id)).size === choices.length;
  }
  if (data.outcome === 'handoff') {
    const { featureId, command, draft } = data.handoff;
    const policy = agentCommandPolicy(command, draft);
    return policy.policy === 'handoff' && featureId === policy.featureId && !agentNavigationHandoffIssue(command, draft, true); // N03
  }
  if (data.outcome === 'refused' && data.refusal?.alternative?.command === 'notice.send') {
    const { draft } = data.refusal.alternative;
    return !Object.hasOwn(draft, 'previewId') && !Object.hasOwn(draft, 'draftRevision');
  }
  if (data.outcome === 'ambiguous') {
    const { choices } = data.clarification;
    return choices.every(choice => choice.id === choice.handle)
      && new Set(choices.map(choice => choice.handle)).size === choices.length;
  }
  return true;
}

export function isAgentPriceClarification(value) {
  return plainObject(value) && value.promptKey === 'menu.price'
    && validateAgentFrame('done', { outcome: 'clarify', clarification: value });
}

// N21 ordered plans carry intent selectors. Projected values, handles, drafts
// and confirmation controls belong to an individual turn, never to the plan.
const multiStep = record({
  id, intent: either(record({ kind: oneOf('command'), command: knownCommands }), readIntent),
  dependsOn: unique(id, 11),
}, ['id', 'intent']);
const multiPlan = record({ planId: id, runId: id, steps: array(multiStep, 12, 2) });

export function validateAgentMultiPlan(value) {
  if (!matches(multiPlan, value)) return false;
  const preceding = new Set();
  let hasDelete = false;
  for (const { id: stepId, intent, dependsOn } of value.steps) {
    if (preceding.has(stepId) || dependsOn?.some(parent => !preceding.has(parent))) return false;
    if (intent.kind === 'read') {
      if (!validReadIntent(intent)) return false;
    } else if (singleDeleteKinds.has(intent.command)) {
      if (hasDelete) return false;
      hasDelete = true;
    }
    preceding.add(stepId);
  }
  return true;
}
// End N21 ordered plans.
