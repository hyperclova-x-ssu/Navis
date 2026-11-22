// Build the reviewed Sangdo-dong official snapshot from files written by fetch-official.sh.
// Usage: node build-snapshot.mjs RAW_DIR OUTPUT_JSON
// Only derived values leave RAW_DIR: hourly averages per quarter and weekday, and selected public license and event rows.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [rawDir, output] = process.argv.slice(2);
if (!rawDir || !output) throw new Error('Usage: node build-snapshot.mjs RAW_DIR OUTPUT_JSON');

const REGION = '서울 동작구 상도동';
const DONGS = { 11590530: '상도1동', 11590540: '상도2동', 11590550: '상도3동', 11590560: '상도4동' };
const FROM = '2026-07-01';
const POPULATION_URL = 'https://data.seoul.go.kr/dataList/OA-23016/S/1/datasetView.do';
const LICENSE_URLS = {
  general: 'https://data.seoul.go.kr/dataList/OA-18671/S/1/datasetView.do',
  rest: 'https://data.seoul.go.kr/dataList/OA-18696/S/1/datasetView.do',
};
const NAMESPACE = 'b7a4f0d2-4f37-5c1e-9a55-1b9c0b2f6d13';

const cp949 = new TextDecoder('euc-kr');
const read = path => cp949.decode(readFileSync(join(rawDir, path)));

/** RFC 4180 CSV with quoted fields, including separators and line breaks inside quotes. */
function parseCsv(text, separator = ',') {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === separator) { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(cells => cells.some(cell => cell.trim()));
}

function records(text) {
  const [header, ...rows] = parseCsv(text);
  return rows.map(cells => Object.fromEntries(header.map((name, index) => [name.trim(), (cells[index] ?? '').trim()])));
}

/** Stable name-based UUID (version 5) so a re-import updates the same rows. */
function stableId(name) {
  const hash = createHash('sha1').update(Buffer.from(NAMESPACE.replaceAll('-', ''), 'hex')).update(name).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const isoDay = compact => `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
const quarterOf = date => `${date.slice(0, 4)}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
const isoWeekday = date => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const decodeEntities = text => text.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const manifest = Object.fromEntries(parseCsv(readFileSync(join(rawDir, 'manifest.tsv'), 'utf8'), '\t').slice(1)
  .map(([path, dataset, url, disposition, bytes, sha256, retrievedAt]) => [path, { dataset, url, disposition, bytes: Number(bytes), sha256, retrievedAt }]));

// Population: OA-23016 monthly files win; the recent Sheet rows fill later days and must agree where both exist.
const hourly = new Map();
const rowPattern = /^"(\d{8})"[;,]"(\d{2})"[;,]"(\d{8}) *"[;,]"([\d.]+)"/;
let overlaps = 0, mismatches = 0;
function addPopulation(text, preferred) {
  for (const line of text.split(/\r?\n/)) {
    const match = rowPattern.exec(line);
    if (!match || !DONGS[match[3]]) continue;
    const key = `${isoDay(match[1])}|${Number(match[2])}|${match[3]}`;
    const value = Number(match[4]);
    if (hourly.has(key)) {
      overlaps++;
      if (Math.abs(hourly.get(key) - value) > 0.01) mismatches++;
      if (!preferred) continue;
    }
    hourly.set(key, value);
  }
}
const popFiles = readdirSync(join(rawDir, 'pop')).sort();
for (const name of popFiles.filter(file => file.endsWith('_sangdo.csv'))) addPopulation(read(`pop/${name}`), true);
for (const name of popFiles.filter(file => file.startsWith('recent_') && file.endsWith('.csv'))) addPopulation(read(`pop/${name}`), false);

const complete = new Map();
for (const key of hourly.keys()) {
  const [date, hour] = key.split('|');
  const slot = `${date}|${hour}`;
  if (complete.has(slot)) continue;
  const values = Object.keys(DONGS).map(code => hourly.get(`${slot}|${code}`));
  if (values.every(value => value !== undefined)) complete.set(slot, values.reduce((sum, value) => sum + value, 0));
}
const bands = new Map();
const quarters = {};
for (const [slot, total] of complete) {
  const [date, hourText] = slot.split('|');
  if (date < FROM) continue;
  const quarter = quarterOf(date), weekday = isoWeekday(date), hour = Number(hourText);
  const band = bands.get(`${quarter}|${weekday}|${hour}`) ?? { quarter, weekday, hour, sum: 0, days: 0 };
  band.sum += total; band.days++;
  bands.set(`${quarter}|${weekday}|${hour}`, band);
  const span = quarters[quarter] ??= { from: date, to: date, days: new Set() };
  if (date < span.from) span.from = date;
  if (date > span.to) span.to = date;
  span.days.add(date);
}
const popRetrieved = Object.entries(manifest).filter(([path]) => path.startsWith('pop/')).map(([, file]) => file.retrievedAt).sort().at(-1);
const population = [...bands.values()].sort((a, b) => a.quarter.localeCompare(b.quarter) || a.weekday - b.weekday || a.hour - b.hour)
  .map(band => ({ quarter: band.quarter, weekday: band.weekday, startHour: band.hour, endHour: band.hour + 1,
    estimate: Math.round(band.sum / band.days), referenceDate: quarters[band.quarter].to, refreshedAt: popRetrieved, sourceUrl: POPULATION_URL }));

// Food licenses: Dongjak-gu rows whose legal dong is 상도동 or 상도1동, licensed since FROM and still operating.
const inSangdo = row => /^서울특별시 동작구 상도1?동 /.test(row['지번주소']) ||
  (!row['지번주소'] && /\(상도1?동[,)]/.test(row['도로명주소']));
const roadShort = address => address.replace(/^서울특별시 동작구 /, '').replace(/\s*\(.*\)$/, '').split(',')[0].trim();
const licenseAsOf = [];
const changes = [];
let garbled = 0;
// A few portal rows hold characters outside CP949; never show replacement characters to the owner.
function keep(change) {
  if (`${change.title}${change.authority}`.includes('\uFFFD')) garbled++;
  else changes.push(change);
}
for (const [type, label] of [['general', '일반음식점'], ['rest', '휴게음식점']]) {
  const path = `licenses/dongjak_${type}_restaurants.csv`;
  for (const row of records(read(path))) {
    const updated = row['데이터갱신일자'].slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(updated)) licenseAsOf.push(updated);
    const licensed = row['인허가일자'].slice(0, 10);
    if (!inSangdo(row) || licensed < FROM || row['영업상태명'] !== '영업/정상') continue;
    const where = roadShort(row['도로명주소']) || row['지번주소'].replace(/^서울특별시 동작구 /, '');
    keep({ id: stableId(`food-license:${row['관리번호']}`), kind: 'food-license',
      title: clip(`${row['사업장명'].replace(/\s+/g, ' ')} · ${label}(${row['업태구분명']}) · ${where}`, 160),
      authority: '서울특별시 동작구', referenceDate: licensed, sourceUrl: LICENSE_URLS[type] });
  }
}

// Events: Seoul culture portal entries in Dongjak-gu held at a Sangdo venue.
const eventRows = records(read('events/seoul_cultural_events.csv'));
let dongjakEvents = 0;
for (const row of eventRows) {
  if (row['자치구'] !== '동작구') continue;
  dongjakEvents++;
  const start = row['시작일'].slice(0, 10), place = decodeEntities(row['장소']);
  let url;
  try { url = new URL(row['문화포털상세URL'].replace(/^http:/, 'https:')); } catch { continue; }
  if (start < FROM || !/상도|숭실/.test(place) || !/(^|\.)go\.kr$/.test(url.hostname)) continue;
  const name = decodeEntities(row['공연/행사명']);
  const suffix = ` · ${clip(place, 40)}`;
  keep({ id: stableId(`festival:${url.searchParams.get('cultcode') ?? url.href}`), kind: 'festival',
    title: `${clip(`[${row['분류']}] ${name}`, 160 - suffix.length)}${suffix}`,
    authority: clip(decodeEntities(row['기관명']) || '서울특별시', 100), referenceDate: start, sourceUrl: url.href });
}
changes.sort((a, b) => a.referenceDate.localeCompare(b.referenceDate) || a.id.localeCompare(b.id));

const coverageDate = [licenseAsOf.sort().at(-1), manifest['events/seoul_cultural_events.csv'].retrievedAt.slice(0, 10)].sort()[0];
const file = path => ({ path, ...manifest[path] });
const snapshot = {
  meta: {
    region: REGION,
    regionRule: '생활인구는 행정동 상도1·2·3·4동(11590530·11590540·11590550·11590560) 합계, 인허가는 지번주소 법정동 상도동·상도1동, 행사는 동작구 행사 중 장소에 상도·숭실이 들어간 것',
    attribution: '출처: 서울특별시·KT, 서울시 통신데이터 (생활인구) · 서울 열린데이터광장 (인허가·문화행사)',
    window: { from: FROM, coverageDate },
    population: {
      dataset: 'OA-23016 [내국인] 행정동별 서울 생활인구(250m)', provider: '서울특별시 디지털도시국 데이터전략과',
      url: POPULATION_URL, unit: '시간대별 생활인구(추정) 평균, 명, 정수 반올림',
      method: '같은 분기·같은 요일의 같은 시각 값을 상도1~4동 합계로 더해 날짜 수로 나눔. 네 동이 모두 있는 시각만 씀.',
      terms: '별도 이용조건: 분석·가공한 통계·지표·시각화의 상업적 이용 허용(출처 표시 필수), 원본의 전부 또는 상당 부분 재배포·유상 제공 금지, 개인 식별 시도 금지',
      quarters: Object.fromEntries(Object.entries(quarters).sort().map(([quarter, span]) => [quarter, { from: span.from, to: span.to, days: span.days.size }])),
      sheetOverlapRows: overlaps, sheetMismatchRows: mismatches,
      files: Object.keys(manifest).filter(path => path.startsWith('pop/')).map(file),
    },
    codeTable: { dataset: 'OA-22172 서울시 상권분석서비스(점포-행정동)', url: 'https://data.seoul.go.kr/dataList/OA-22172/S/1/datasetView.do',
      dongs: DONGS, files: [file('codes/store_admdong_2025.zip')] },
    licenses: {
      datasets: ['OA-18671 서울시 동작구 일반음식점 인허가 정보', 'OA-18696 서울시 동작구 휴게음식점 인허가 정보'],
      provider: '서울특별시 동작구', terms: '이용허락범위 제한 없음', asOf: licenseAsOf.sort().at(-1),
      rule: `인허가일자 ${FROM} 이후, 영업상태 영업/정상, 지번주소 법정동 상도동·상도1동`,
      count: changes.filter(change => change.kind === 'food-license').length,
      files: [file('licenses/dongjak_general_restaurants.csv'), file('licenses/dongjak_rest_restaurants.csv')],
    },
    events: {
      dataset: 'OA-15486 서울시 문화행사 정보', provider: '서울특별시', url: 'https://data.seoul.go.kr/dataList/OA-15486/S/1/datasetView.do',
      terms: '이용허락범위 제한 없음', rule: `시작일 ${FROM} 이후, 자치구 동작구, 장소에 상도·숭실`, dongjakRows: dongjakEvents,
      count: changes.filter(change => change.kind === 'festival').length, files: [file('events/seoul_cultural_events.csv')],
    },
    skippedGarbledRows: garbled,
    builtWith: process.version,
  },
  snapshot: { region: REGION, coverageDate, kinds: ['food-license', 'festival'], changes, population },
};
writeFileSync(output, `${JSON.stringify(snapshot, null, 1)}\n`);
console.log(JSON.stringify({ population: population.length, quarters: snapshot.meta.population.quarters, overlaps, mismatches,
  licenses: snapshot.meta.licenses.count, events: snapshot.meta.events.count, dongjakEvents, garbled, coverageDate }, null, 1));
