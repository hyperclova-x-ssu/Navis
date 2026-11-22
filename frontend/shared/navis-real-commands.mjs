import { AGENT_COMMAND_CATALOG, agentCommandPolicy } from './navis-agent-schema.mjs';

// Each entry names the widget port binding an accepted card is allowed to use.
// The policy catalog still owns the wire name, arguments and confirmation tier.
const realCommandGroups = {
  menu: ['menu.create', 'menu.update', 'menu.setSaleStatus', 'menu.delete', 'menu.setRecipe', 'menu.setOptions'],
  stock: ['inventory.createItem', 'inventory.updateItem', 'inventory.moveChannel', 'inventory.deleteItem', 'inventory.setTracking'],
  purchase: ['suppliers.createPurchaseItem', 'suppliers.updatePurchaseItem', 'suppliers.deletePurchaseItem',
    'suppliers.createSupplier', 'suppliers.updateSupplier', 'suppliers.deleteSupplier', 'suppliers.createOrder',
    'suppliers.changeDueDate', 'suppliers.cancelOrder', 'suppliers.recordReceipt'],
  members: ['members.create', 'members.update', 'members.setGrade', 'members.addNote', 'members.updateNote', 'members.deleteNote', 'members.delete'],
  booking: ['booking.create', 'booking.update', 'booking.confirm', 'booking.cancel', 'booking.markCompleted', 'booking.markNoShow'],
  staff: ['calendar.addEvent', 'calendar.addTodo', 'calendar.updateEvent', 'calendar.deleteEvent',
    'calendar.setCategoryVisible', 'calendar.setSourceVisible', 'staff.create', 'staff.update', 'staff.delete',
    'staff.saveSchedule', 'staff.deleteSchedule', 'staff.moveHandoff'],
  custom: ['customOrder.create', 'customOrder.update', 'customOrder.quote', 'customOrder.recordDecision',
    'customTemplate.generate', 'customTemplate.save', 'customTemplate.delete',
    'customOrder.setStage', 'customOrder.receive', 'customOrder.cancel', 'pickup.reschedule', 'pickup.cancel'],
  briefing: [['ui.acknowledgeBriefing', 'briefing.acknowledge']],
  money: ['ledger.recordExpense', 'ledger.updateExpense', 'ledger.confirmCandidate'],
  cctv: ['cctv.markPeakForReview'],
  manuals: ['manuals.create', 'manuals.update', 'manuals.setPublished', 'manuals.delete', 'manuals.toggleStep',
    'manuals.createDraftFromMemo', 'manuals.saveDraft', 'manuals.discardDraft', 'grants.apply', 'grants.updateApplication',
    'grants.deleteApplication', 'grants.markReviewed'],
  local: ['localChanges.acknowledge', 'localChanges.unacknowledge', 'community.accept', 'community.decline', 'community.sendInterest'],
  coupons: ['coupon.sendSlot', 'coupon.createExpiry', 'coupon.markPosted', 'coupon.pause', 'coupon.resume', 'coupon.extend',
    'coupon.update', 'coupon.sendReachOut', 'coupon.endEarly', 'coupon.unpublish', 'coupon.notifyEnding'],
  inbox: ['notice.saveDraft', 'notice.importClosure', 'notice.deleteDraft', 'notice.send', 'reply.draft', 'inquiry.saveDraft',
    ['inquiry.send', 'inquiry.send', 'optional'], 'inquiry.post'],
  promo: [['promo.draft.set', 'promo.saveDraft'], ['video.make', 'video.make', true], ['video.retry', 'video.retry', true]],
  tax: ['tax.createPayment', 'tax.updatePayment', 'tax.deletePayment', 'tax.markChecked'],
};

export const realCommandRegistry = Object.freeze(Object.fromEntries(Object.entries(realCommandGroups).flatMap(([domain, commands]) =>
  commands.map(entry => {
    const [policyName, command, workflow] = typeof entry === 'string' ? [entry, entry] : entry;
    if (AGENT_COMMAND_CATALOG[policyName]?.policy !== 'propose') throw new Error(`Invalid Navis HTTP policy: ${policyName}`);
    return [policyName, Object.freeze({ domain, command, ...(workflow ? { workflow } : {}) })];
  }))));

export function realCommandFor(policyName, args) {
  if (!Object.hasOwn(realCommandRegistry, policyName)) return undefined;
  if (args !== undefined && agentCommandPolicy(policyName, args)?.policy !== 'propose') return undefined;
  return realCommandRegistry[policyName];
}

