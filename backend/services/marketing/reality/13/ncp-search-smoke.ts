import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readSecret } from '../../../../packages/db/index.ts';
import { createNcpSearchPort } from './ncp-search.ts';

const [approval, operation, ...rest] = process.argv.slice(2);
const channels = ['blog', 'cafearticle', 'local', 'news'] as const;
const channel = channels.find(name => name === operation);
let status = 0;
let count = 0;

if (approval === '--approve-live' && !rest.length && (channel || operation === 'trend' || operation === 'geocode')) {
  const keys = join(homedir(), '.navis-ncp', 'secrets');
  const binding = createNcpSearchPort({ storeId: 'c05409a6-f082-5964-a787-c1ed3184988b',
    apiHub: operation !== 'geocode', maps: operation === 'geocode' }, {
    readCredential: file => readSecret(join(keys, basename(file))),
    async fetcher(url, init) {
      const response = await fetch(url, init);
      status = response.status;
      return response;
    },
  });
  const signal = AbortSignal.timeout(4_000);
  try {
    if (binding && channel) {
      count = (await binding.port.search(channel, { query: '상도동 카페', display: 1, signal })).result.items.length;
    } else if (binding && operation === 'trend') {
      const { result } = await binding.port.trend({ request: { startDate: '2026-11-01', endDate: '2026-11-07', timeUnit: 'date',
        keywordGroups: [{ groupName: '카페', keywords: ['카페'] }] }, signal });
      count = result.results.flatMap(group => group.data).length;
    } else if (binding && operation === 'geocode') {
      const { result } = await binding.port.geocode({ query: '서울 동작구 상도동 999-12', count: 1, signal });
      count = result.addresses.length;
      if (result.status !== 'OK') process.exitCode = 1;
    }
  } catch { process.exitCode = 1; }
}
if (status !== 200) process.exitCode = 1;
console.log(JSON.stringify({ status, count }));
