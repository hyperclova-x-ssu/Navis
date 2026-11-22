import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { seedCatalog } from '../../../frontend/src/data/db/generated/catalog.ts';

export async function verifyNaverPos(call, root, signIn) {
  const pos = root + '/pos/naver';
  const list = await call('GET', pos + '/orders', 200);
  const next = list.items.find(order => order.orderNumber === 'order-01');
  assert.equal(next.status, 'received');
  const preparing = pos + '/orders/order-01/prepare';
  const confirmation = { key: 'compose-naver-pos-prepare',
    body: { expectedRevision: next.revision, preparationMinutes: 10 } };
  await call('POST', preparing, 400, { body: confirmation.body });
  await call('POST', preparing, 409, { key: 'compose-naver-pos-stale',
    body: { ...confirmation.body, expectedRevision: next.revision + 1 } });
  const prepared = await call('POST', preparing, 200, confirmation);
  assert.equal(prepared.status, 'preparing');
  assert.deepEqual(await call('POST', preparing, 200, confirmation), prepared);
  const ready = list.items.find(order => order.orderNumber === 'order-02');
  const picked = await call('POST', pos + '/orders/order-02/pickup', 200,
    { key: 'compose-naver-pos-pickup', body: { expectedRevision: ready.revision } });
  assert.equal(picked.status, 'picked-up');
  const payment = pos + '/npay/payments/PN09SETTLED01';
  const settlement = await call('GET', payment, 200);
  assert.deepEqual(settlement.items.map(item => item.kind), ['approval', 'cancellation']);
  const history = await call('GET', pos + '/npay/pay-histories/PN09SETTLED01-C1', 200);
  assert.deepEqual(history.items.map(item => item.kind), ['cancellation']);
  const statuses = await call('POST', pos + '/smartstore/order-statuses', 200,
    { body: { productOrderIds: ['202611170001001', '202611160001101', '999999'] } });
  assert.equal(statuses.items.length, 2);
  assert.deepEqual(statuses.unavailable, ['999999']);
  await call('POST', payment + '/cancel', 404, { body: {} });
  await signIn();
  assert.equal((await call('GET', pos + '/orders/order-01', 200)).revision, prepared.revision);
  assert.equal((await call('GET', pos + '/orders/order-02', 200)).revision, picked.revision);
  const reopened = await call('GET', payment, 200);
  assert.deepEqual(reopened.items, settlement.items);
  assert.deepEqual(reopened.totals, settlement.totals);
  console.info('PASS POS PN02 owner card, stale and same-key retry, PN09 settlement and PN16 Smart Store readback');
}

export async function verifyNaverInventory(call, root, signIn) {
  const inv = root + '/inventory';
  const { items: catalog } = await call('GET', inv + '/menu?limit=100', 200);
  assert.equal(catalog.filter(item => item.photoFileId).length, seedCatalog.menu.length);
  const photo = seedCatalog.menu.find(item => item.menuId === 'm-americano');
  const pictured = await call('GET', `${inv}/menu/${photo.dbId}`, 200);
  assert.ok(pictured.photoFileId, 'seeded café menu has an Account file reference');
  const bytes = await call('GET', `${root}/files/${pictured.photoFileId}/content`, 200);
  assert.equal(bytes.readUInt16BE(0), 0xffd8);

  async function confirm(path, input, operation, resourceId) {
    await call('POST', path + '/confirm', 403, { key: 'typed-confirmation', body: { confirmed: true } });
    const { previewId, expectedRevision } = await call('POST', path + '/preview', 200, { body: { input } });
    await call('POST', path + '/confirm', 403, { key: previewId, body: { approvalId: previewId, previewId, expectedRevision } });
    const { approvalId } = await call('POST', inv + '/approvals', 200,
      { body: { stage: 'press', operation, resourceId, expectedRevision, previewId } });
    const card = { key: approvalId, body: { approvalId, previewId, expectedRevision } };
    const result = await call('POST', path + '/confirm', 200, card);
    assert.deepEqual(await call('POST', path + '/confirm', 200, card), result);
    return result;
  }
  const menu = await call('POST', inv + '/menu', 201, { key: 'compose-place-new-menu',
    body: { name: '연결 검증 라떼', category: 'drink', price: 4900 } });
  assert.equal((await confirm(`${inv}/menu/${menu.resourceId}/place`, {}, 'place.menu.publish', menu.resourceId)).readBack.price, 4900);
  const venue = inv + '/place/venue';
  assert.ok((await call('GET', venue, 200)).name);
  await confirm(venue, { keywords: ['안숭잘부', '로컬 검증'] }, 'place.venue.publish', 'venue');

  const houseBean = seedCatalog.items.find(item => item.itemId === 'i-bean-house');
  const houseItem = `${inv}/items/${houseBean.dbId}`;
  const commerce = houseItem + '/commerce-stock';
  const original = await call('GET', commerce, 200);
  assert.equal(original.originProductNo, 10001);
  const stockBefore = (await call('GET', houseItem, 200)).stock.rawQuantityBase;
  const [option] = original.options;
  const stockQuantity = option.stockQuantity + 1;
  const result = await confirm(commerce, { optionId: option.id, stockQuantity }, 'commerce.stock.set', houseBean.dbId);
  assert.deepEqual(result.readBack.options.find(item => item.id === option.id), { ...option, stockQuantity });

  const supplier = await call('POST', inv + '/suppliers', 201, { key: 'compose-gap-supplier',
    body: { name: '가상 거래처', contact: 'supplier@example.invalid', phone: '01000000001' } });
  const terms = await call('POST', inv + '/purchase-items', 201, { key: 'compose-gap-terms',
    body: { itemId: houseBean.dbId, supplierId: supplier.resourceId, minimumQty: 1, orderStep: 1, unitPrice: 2000, leadDays: 1 } });
  const purchase = await call('POST', inv + '/purchase-orders', 201, { key: 'compose-gap-purchase',
    body: { purchaseItemId: terms.resourceId, qty: 2, dueDate: '2026-11-19', expectedRevision: terms.revision } });
  const supplierMessage = `${inv}/purchase-orders/${purchase.poId}/supplier-message`;
  assert.deepEqual((await call('GET', supplierMessage, 200)).items, []);
  for (const channel of ['sms', 'mail']) {
    const receipt = await confirm(supplierMessage, { channel }, 'supplier.message.send', purchase.poId);
    assert.equal(receipt.state, 'queued');
  }
  await signIn();
  assert.ok((await call('GET', inv + '/place/menu', 200)).items.some(item => item.name === '연결 검증 라떼'));
  assert.deepEqual((await call('GET', venue, 200)).keywords, ['안숭잘부', '로컬 검증']);
  assert.equal((await call('GET', commerce, 200)).options.find(item => item.id === option.id).stockQuantity, stockQuantity);
  assert.equal((await call('GET', houseItem, 200)).stock.rawQuantityBase, stockBefore);
  let states;
  for (let attempt = 0; attempt < 60; attempt++) {
    states = Object.fromEntries((await call('GET', supplierMessage, 200)).items.map(item => [item.channel, item.state]));
    if (states.sms === 'delivered' && states.mail === 'delivered') break;
    await delay(250);
  }
  assert.deepEqual(states, { mail: 'delivered', sms: 'delivered' });
  console.info('PASS Inventory Account photo, Place card/readback, isolated online stock and relay-driven synthetic SMS/Mail delivery');
}

export async function verifyNaverCards(call, root, signIn) {
  const event = await call('POST', root + '/calendar/events', 201,
    { key: 'compose-gap-calendar-event', body: { kind: 'event', title: '카페 일정', date: '2026-11-23' } });
  const calendar = `${root}/calendar/events/${event.resourceId}/naver`;
  const form = { expectedRevision: event.revision, approvalId: randomUUID() };
  await call('POST', calendar, 403, { key: form.approvalId, body: form });
  const card = await call('POST', root + '/calendar/naver-approvals', 200,
    { body: { stage: 'press', operation: 'calendar.add', resourceId: event.resourceId, expectedRevision: event.revision } });
  const confirmed = { key: card.approvalId, body: { expectedRevision: event.revision, approvalId: card.approvalId } };
  const exported = await call('POST', calendar, 200, confirmed);
  assert.deepEqual(await call('POST', calendar, 200, confirmed), exported);
  assert.ok(['create', 'modify'].includes(exported.processType));

  const staff = await call('POST', root + '/staff', 201, { key: 'compose-gap-calendar-staff', body: { name: '가상 직원' } });
  const shift = { staffId: staff.resourceId, date: '2026-11-23', kind: 'work', start: '09:00', end: '17:30' };
  const created = await call('POST', root + '/shifts', 201, { key: 'compose-gap-calendar-shift', body: shift });
  const works = `${root}/shifts/${created.resourceId}/naver-works`;
  const range = '/shifts/naver-works?fromDateTime=2026-11-22T00:00:00%2B09:00&untilDateTime=2026-11-25T00:00:00%2B09:00';
  const approvals = root + '/approvals';
  const create = { targetRef: created.resourceId, expectedRevision: created.revision, command: { expectedStaffRevision: staff.revision } };
  const press = await call('POST', approvals, 200, { body: { stage: 'press', operation: 'works.create', ...create } });
  const copied = await call('POST', works, 200, { key: press.approvalId,
    body: { expectedRevision: create.expectedRevision, expectedStaffRevision: staff.revision, approvalId: press.approvalId } });
  assert.equal((await call('GET', root + range, 200)).items[0].eventId, copied.eventId);
  const changed = await call('PATCH', `${root}/shifts/${created.resourceId}`, 200,
    { key: 'compose-gap-calendar-edit', body: { ...shift, end: '18:00', expectedRevision: created.revision } });
  const update = await call('POST', approvals, 200, { body: { stage: 'press', operation: 'works.update', ...create, expectedRevision: changed.revision } });
  assert.equal((await call('PATCH', works, 200, { key: update.approvalId, body: {
    expectedRevision: changed.revision, expectedStaffRevision: staff.revision, approvalId: update.approvalId } })).eventId, copied.eventId);
  const intent = { operation: 'works.delete', targetRef: created.resourceId, expectedRevision: changed.revision, command: {} };
  const first = await call('POST', approvals, 200, { body: { stage: 'press', ...intent } });
  assert.equal(first.requiresConfirmation, true);
  const remove = { key: first.approvalId, body: { expectedRevision: changed.revision, approvalId: first.approvalId } };
  await call('DELETE', works, 403, remove);
  await call('POST', approvals, 200, { body: { stage: 'confirm', approvalId: first.approvalId, ...intent } });
  assert.equal((await call('DELETE', works, 200, remove)).operation, 'delete');

  const marketing = root + '/marketing';
  const board = (await call('GET', marketing + '/community/cafe-boards', 200)).items[0];
  assert.deepEqual(board, { clubid: '10000001', menuid: '1' });
  const posts = marketing + '/community/cafe-posts';
  const body = { ...board, subject: '카페 시연', text: '사장님 카드로 글을 올립니다.' };
  await call('POST', posts, 403, { body, key: `navis:${randomUUID()}` });
  const { sourceRevision } = await call('GET', posts, 200);
  const proposal = { operation: 'cafe.post', expectedRevision: sourceRevision, command: body };
  const cafePress = await call('POST', marketing + '/approvals', 200, { body: { ...proposal, stage: 'press' } });
  const publish = { body, key: `navis:${cafePress.approvalId}` };
  await call('POST', posts, 403, publish);
  await call('POST', marketing + '/approvals', 200,
    { body: { ...proposal, stage: 'confirm', approvalId: cafePress.approvalId } });
  const published = await call('POST', posts, 200, publish);
  assert.equal(published.state, 'published');
  assert.match(published.articleUrl, /^https:\/\/cafe\.naver\.com\//);
  assert.deepEqual(await call('POST', posts, 200, publish), published);
  const review = marketing + '/reviews/review-03';
  const format = { body: { style: '정중하게', length: '짧게' } };
  assert.equal((await call('POST', review + '/draft-preview', 200, format)).source, 'naver-ai');
  assert.equal((await call('POST', review + '/navis-draft-preview', 200, format)).source, 'navis');
  const trend = await call('GET', marketing + '/local-trends?from=2026-11-15&to=2026-11-17&keyword=%EC%B9%B4%ED%8E%98', 200);
  assert.equal(trend.search.unit, 'relative-index');
  assert.equal(trend.links.use, 'display-only');
  assert.equal(trend.links.blog.status, 'available');
  assert.equal(trend.links.cafearticle.status, 'available');
  await signIn();
  assert.deepEqual((await call('GET', calendar, 200)).receipt, exported);
  assert.deepEqual((await call('GET', root + range, 200)).items, []);
  assert.equal((await call('GET', `${root}/shifts/${created.resourceId}`, 200)).revision, changed.revision);
  assert.equal((await call('GET', posts, 200)).items[0].articleUrl, published.articleUrl);
  console.info('PASS PN11 Calendar/WORKS and PN17 Café cards, scoped grants, second confirmation, PN10 links and separate PN03/PN14 drafts');
}
