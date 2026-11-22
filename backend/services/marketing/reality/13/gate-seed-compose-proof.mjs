import assert from 'node:assert/strict';
import { request } from 'node:http';

const [edge = 'http://127.0.0.1:18180', origin = edge, replayInstant] = process.argv.slice(2);
const cafe = 'c05409a6-f082-5964-a787-c1ed3184988b';
const peer = '33123a19-6780-4d38-9bca-ce96efcf8559';
const store = '/api/v1/stores/' + cafe;

function call(path, session) {
  const headers = { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin' };
  if (session) headers.authorization = 'Bearer ' + session.accessToken;
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, edge), {
      method: session ? 'GET' : 'POST', headers, signal: AbortSignal.timeout(10_000),
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        try {
          assert.equal(res.statusCode, 200, path + ': ' + (res.statusCode === 200 ? '' : text));
          resolve({ body: JSON.parse(text), cookie: res.headers['set-cookie']?.[0] });
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function readFixtures() {
  const { body: session, cookie } = await call('/api/v1/auth/demo');
  assert.equal(session.storeId, cafe);
  assert.match(cookie, /^navis_refresh=/);
  const paths = ['/marketing/offers/peers', '/marketing/offers', '/reservations/naver-booking-02'];
  const [{ body: peers }, { body: offers }, { body: result }] = await Promise.all(
    paths.map(path => call(store + path, session)));
  assert.equal(peers.status, 'available');
  assert.ok(peers.items.some(item => item.storeId === peer));
  const received = offers.items.filter(item => item.senderStoreId === peer && item.recipientStoreId === cafe);
  assert.ok(received.length >= 3);
  assert.ok(received.every(item => item.status === 'pending' && item.canRespond));
  const booking = result.item ?? result;
  assert.equal(booking.status, 'confirmed');
  assert.equal(booking.sourceMetadata.npayLinked, true);
  assert.equal(booking.sourceMetadata.paymentAmount, 4500);
  assert.equal(booking.actions.cancelRequiresRefund, true);
  const pathsWithExtraFixtures = ['/reservation-suggestions?status=pending', '/calendar/events?closuresOnly=true',
    '/customers', '/marketing/place/news'];
  const [{ body: calls }, { body: calendar }, { body: customers }, { body: news }] = await Promise.all(
    pathsWithExtraFixtures.map(path => call(store + path, session)));
  assert.equal(calls.items.length, 3);
  assert.ok(calendar.items.some(item => item.eventId === 'ca44a795-1e6d-49bd-af4e-f21d2d836a86'));
  if (replayInstant) assert.equal(calendar.asOf, new Date(replayInstant).toISOString());
  assert.ok(customers.items.some(item => item.consent.marketingAllowed));
  assert.ok(customers.items.some(item => !item.consent.marketingAllowed));
  assert.equal(news.items.filter(item => item.pin).length, 4);
  return { cookie, received, booking, calls: calls.items, calendar: calendar.items, news: news.items };
}

const first = await readFixtures();
const second = await readFixtures();
assert.notEqual(first.cookie, second.cookie, 'separately issued demo refresh credentials');
assert.deepEqual(second.received, first.received);
assert.deepEqual(second.booking, first.booking);
assert.deepEqual(second.calls, first.calls);
assert.deepEqual(second.calendar, first.calendar);
assert.deepEqual(second.news, first.news);
console.log('PASS approved community peer, three received proposals and confirmed ₩4,500 Npay booking in two fresh gateway sessions');
console.log('PASS phone requests, closure, member consent and four pinned Place news entries through the gateway');
