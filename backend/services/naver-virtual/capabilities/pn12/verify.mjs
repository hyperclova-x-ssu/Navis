import console from 'node:console';
import process from 'node:process';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { URL, URLSearchParams, pathToFileURL } from 'node:url';

export async function verifyPnP3({ baseUrl, accountId, marketing, insight, account, customer, now, outsider, outsiderAccount }) {
  const base = new URL(baseUrl);
  assert.equal(base.protocol, 'http:');
  assert.ok(['naver-virtual', 'localhost', '127.0.0.1'].includes(base.hostname));
  const headers = (token, additional) => ({
    'x-navis-naver-virtual-token': token,
    'x-navis-naver-virtual-account': accountId,
    ...additional,
  });
  async function request(path, token, status, options = {}) {
    const response = await fetch(new URL(path, base), {
      ...options, redirect: 'manual', headers: headers(token, options.headers),
    });
    const body = await response.text();
    assert.equal(response.status, status, `${options.method ?? 'GET'} ${path.split('?')[0]}: ${response.status}`);
    return { data: response.headers.get('content-type')?.includes('json') && body ? JSON.parse(body) : body,
      headers: response.headers };
  }
  const json = (payload, method = 'POST') => ({
    method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const form = (values, additional = {}) => ({
    method: 'POST', headers: additional, body: new URLSearchParams(values),
  });
  const keys = (object, fields) => assert.deepEqual(Object.keys(object).sort(), fields.sort());
  const nonce = randomUUID();
  const dayOffset = (offset) => new Date(Date.parse(now) + (9 + offset * 24) * 3_600_000).toISOString().slice(0, 10);

  const hub = { 'x-ncp-apigw-api-key-id': 'fixture-hub', 'x-ncp-apigw-api-key': 'fixture-hub-key' };
  const name = encodeURIComponent('안숭잘부 카페');
  for (const [channel, fields] of Object.entries({
    blog: ['title', 'link', 'description', 'bloggername', 'bloggerlink', 'postdate'],
    cafearticle: ['title', 'link', 'description', 'cafename', 'cafeurl'],
    local: ['title', 'link', 'category', 'description', 'telephone', 'address', 'roadAddress', 'mapx', 'mapy'],
    news: ['title', 'link', 'description', 'originallink', 'pubDate'],
  })) {
    const { data } = await request(`/search/v1/${channel}?query=${name}`, marketing, 200, { headers: hub });
    keys(data, ['lastBuildDate', 'total', 'start', 'display', 'items']);
    keys(data.items[0], fields);
    if (channel === 'local') assert.equal(data.items[0].telephone, '');
  }
  const trend = json({ startDate: dayOffset(-2), endDate: dayOffset(-1), timeUnit: 'date',
    keywordGroups: [{ groupName: '커피', keywords: ['커피'] }] });
  trend.headers = { ...trend.headers, ...hub };
  const trendData = (await request('/search-trend/v1/search', marketing, 200, trend)).data;
  keys(trendData, ['startDate', 'endDate', 'timeUnit', 'results']);
  assert.deepEqual(trendData.results[0].data, [{ period: dayOffset(-2), ratio: 80 }, { period: dayOffset(-1), ratio: 100 }]);
  const mapData = (await request('/map-geocode/v2/geocode?query=' + encodeURIComponent('상도동 999-12'), marketing, 200, {
    headers: { accept: 'application/json', 'x-ncp-apigw-api-key-id': 'fixture-maps', 'x-ncp-apigw-api-key': 'fixture-maps-key' },
  })).data;
  keys(mapData.addresses[0].addressElements[0], ['types', 'longName', 'shortName', 'code']);

  const callback = 'https://navis.example.invalid/oauth/naver/callback';
  const authorize = '/oauth2.0/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: 'fixture-login', redirect_uri: callback, state: nonce,
  });
  const redirect = new URL((await request(authorize, account, 302)).headers.get('location'));
  assert.equal(redirect.origin + redirect.pathname, callback);
  assert.equal(redirect.searchParams.get('state'), nonce);
  const tokenRequest = form({ grant_type: 'authorization_code', client_id: 'fixture-login',
    client_secret: 'fixture-login-key', code: redirect.searchParams.get('code'), state: nonce });
  const token = (await request('/oauth2.0/token', account, 200, tokenRequest)).data;
  keys(token, ['access_token', 'refresh_token', 'token_type', 'expires_in']);
  assert.equal(typeof token.expires_in, 'number');
  assert.equal((await request('/oauth2.0/token', account, 200, tokenRequest)).data.error, 'invalid_grant');
  const oauth = { authorization: `Bearer ${token.access_token}` };
  const profile = (await request('/v1/nid/me', account, 200, { headers: oauth })).data;
  keys(profile, ['resultcode', 'message', 'response']);
  keys(profile.response, ['id']);
  await request('/v1/nid/me', account, 403, { headers: { authorization: 'Bearer fixture-cafe-write' } });
  const scheduleIcalString = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Navis//KO', 'BEGIN:VEVENT',
    `UID:${nonce}`, `DTSTAMP:${dayOffset(0).replaceAll('-', '')}T064500Z`,
    `DTSTART:${dayOffset(1).replaceAll('-', '')}T010000Z`, 'SUMMARY:카페 회의',
    'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  const calendarForm = form({ calendarId: 'fixture-calendar', scheduleIcalString }, oauth);
  const event = (await request('/calendar/createSchedule.json', customer, 200, calendarForm)).data;
  keys(event.returnValue, ['processType', 'calendarId', 'icalUid']);
  assert.equal(event.returnValue.processType, 'create');
  const resend = form({ calendarId: 'fixture-calendar', scheduleIcalString: scheduleIcalString.replace('SUMMARY:', 'SUMMARY:변경 ') }, oauth);
  assert.deepEqual((await request('/calendar/createSchedule.json', customer, 200, resend)).data,
    { ...event, returnValue: { ...event.returnValue, processType: 'modify' } });
  const revoked = form({ client_id: 'fixture-login', client_secret: 'fixture-login-key',
    token: token.refresh_token, token_type_hint: 'refresh_token' });
  assert.equal((await request('/oauth2.0/revoke', account, 200, revoked)).data, '');
  await request('/v1/nid/me', account, 401, { headers: oauth });

  const works = '/v1.0/users/fixture-owner/calendars/fixture-team/events';
  const worksAuth = { authorization: 'Bearer fixture-works-write' };
  const worksRead = { authorization: 'Bearer fixture-works-read' };
  const worksCreate = json({ eventComponents: [{ eventId: nonce, summary: '직원 회의',
    start: { dateTime: dayOffset(1) + 'T10:00:00', timeZone: 'Asia/Seoul' },
    end: { dateTime: dayOffset(1) + 'T11:00:00', timeZone: 'Asia/Seoul' },
  }], sendNotification: false });
  await request(works, customer, 403, { ...worksCreate, headers: { ...worksCreate.headers, ...worksRead } });
  const added = (await request(works, customer, 201, { ...worksCreate, headers: { ...worksCreate.headers, ...worksAuth } })).data;
  keys(added, ['eventComponents', 'organizerCalendarId']);
  keys(added.eventComponents[0], ['eventId', 'summary', 'start', 'end', 'createdTime', 'updatedTime']);
  const worksPath = works + '/' + nonce;
  assert.deepEqual((await request(worksPath, customer, 200, { headers: worksRead })).data, added);
  const changedBody = JSON.parse(worksCreate.body);
  changedBody.eventComponents[0].summary = '회의 변경';
  const update = json(changedBody, 'PUT');
  const updated = (await request(worksPath, customer, 200, { ...update, headers: { ...update.headers, ...worksAuth } })).data;
  assert.equal(updated.eventComponents[0].summary, '회의 변경');
  const span = new URLSearchParams({ fromDateTime: dayOffset(1) + 'T00:00:00+09:00',
    untilDateTime: dayOffset(2) + 'T00:00:00+09:00' });
  const listed = (await request(works + '?' + span, customer, 200, { headers: worksRead })).data;
  keys(listed, ['events']);
  assert.ok(listed.events.some((row) => row.eventComponents[0].eventId === nonce));
  await request(worksPath + '?sendNotification=false', customer, 204, { method: 'DELETE', headers: worksAuth });
  await request(worksPath, customer, 404, { headers: worksRead });

  const owner = '/partner-assumed/v1';
  const place = (await request(owner + '/reports/place?date=' + dayOffset(-1), insight, 200)).data;
  keys(place, ['period', 'cards']);
  assert.ok(place.cards.some((card) => card.metric === 'views'));
  const smartCall = place.cards.find((card) => card.metric === 'smartCallCalls');
  if (smartCall) assert.ok(Number.isSafeInteger(smartCall.value) && smartCall.value >= 0);
  const blog = (await request(owner + '/reports/blog?date=' + dayOffset(-1), insight, 200)).data;
  assert.deepEqual(blog.cards.map((card) => card.metric), ['dailyViews', 'cumulativeViews']);
  const withheld = (await request(owner + '/reports/blog?date=' + dayOffset(0), insight, 200)).data;
  assert.deepEqual(withheld.cards, []);
  const clip = (await request(owner + '/reports/clip', insight, 200)).data;
  assert.ok(clip.cards.every((card) => ['clipViews', 'profileViews', 'newFollowers'].includes(card.metric)));
  const clipCreate = json({ media: 'fixture-cafe-promo', caption: '카페 소개', visibility: 'public', tags: ['카페'] });
  clipCreate.headers['idempotency-key'] = nonce;
  await request(owner + '/clips', insight, 403, clipCreate);
  const unsupportedCategory = json({ ...JSON.parse(clipCreate.body), category: '' });
  await request(owner + '/clips', marketing, 400, { ...unsupportedCategory, headers: clipCreate.headers });
  const reviewMedia = json({ ...JSON.parse(clipCreate.body), media: 'data:image/png;base64,AAAA' });
  await request(owner + '/clips', marketing, 400, { ...reviewMedia, headers: clipCreate.headers });
  const posted = await request(owner + '/clips', marketing, 201, clipCreate);
  keys(posted.data, ['link']);
  const clipPath = posted.headers.get('location');
  assert.ok(clipPath.startsWith(owner + '/clips/'));
  assert.deepEqual((await request(clipPath, marketing, 200)).data, posted.data);
  assert.deepEqual((await request(owner + '/clips', marketing, 201, clipCreate)).data, posted.data);
  const conflictingClip = json({ ...JSON.parse(clipCreate.body), visibility: 'private' });
  await request(owner + '/clips', marketing, 409, { ...conflictingClip, headers: clipCreate.headers });
  await request(clipPath, marketing, 403, { headers: { 'x-navis-naver-virtual-account': 'another-account' } });
  if (outsider) await request(clipPath, outsider, 404, { headers: { 'x-navis-naver-virtual-account': outsiderAccount } });
  const adsPath = '/stats?' + new URLSearchParams({ id: 'cmp-a001-01-000000000000001',
    fields: JSON.stringify(['impCnt', 'clkCnt', 'salesAmt']),
    timeRange: JSON.stringify({ since: dayOffset(-1), until: dayOffset(-1) }), timeIncrement: '1' });
  const timestamp = String(Date.parse(now));
  const adsHeaders = { 'x-timestamp': timestamp, 'x-api-key': 'fixture-ads',
    'x-customer': '1000001', 'x-signature': createHmac('sha256', 'fixture-ads-key').update(timestamp + '.GET./stats').digest('base64') };
  const ads = (await request(adsPath, insight, 200, { headers: adsHeaders })).data;
  keys(ads, ['data', 'summary']);
  keys(ads.data[0], ['dateStart', 'dateEnd', 'impCnt', 'clkCnt', 'salesAmt']);
  await request(adsPath, insight, 403, { headers: { ...adsHeaders, 'x-customer': '1000002' } });

  const articleUrl = '/v1/cafe/10000001/menu/1/articles';
  const article = form({ subject: encodeURIComponent('카페 소식'), content: encodeURIComponent('안숭잘부 카페 모임 안내') },
    { authorization: 'Bearer fixture-cafe-write', 'idempotency-key': nonce });
  await request('/v1/cafe/10000001/menu/2/articles', marketing, 403, article);
  if (outsider) await request(articleUrl, outsider, 401, { ...article,
    headers: { ...article.headers, 'x-navis-naver-virtual-account': outsiderAccount } });
  const postedArticle = (await request(articleUrl, marketing, 200, article)).data;
  keys(postedArticle, ['@type', '@service', '@version', 'status', 'result']);
  keys(postedArticle.result, ['msg', 'cafeUrl', 'articleId', 'articleUrl']);
  assert.equal(typeof postedArticle.result.articleId, 'number');
  assert.notEqual(postedArticle.result.articleUrl, posted.data.link);
  assert.deepEqual((await request(articleUrl, marketing, 200, article)).data, postedArticle);
  return { path: clipPath, data: posted.data };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [baseUrl, accountId, marketing, insight, account, customer, now] = process.argv.slice(2);
  await verifyPnP3({ baseUrl, accountId, marketing, insight, account, customer, now });
  console.log('PN-P3 provider HTTP contract assertions passed.');
}
