import { readSecret } from '../../packages/db/index.ts';
import { runForecast } from './run.ts';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}

try {
  const fixture = process.env.NAVIS_FORECAST_FIXTURE_NOW;
  const now = fixture ? () => new Date(fixture) : undefined;
  const result = await runForecast({
    storeId: required('NAVIS_FORECAST_STORE_ID'),
    now,
    insight: {
      baseUrl: required('NAVIS_INSIGHT_BASE_URL'),
      token: readSecret(required('NAVIS_FORECAST_INSIGHT_TOKEN_FILE')),
    },
    inventory: {
      baseUrl: required('NAVIS_INVENTORY_BASE_URL'),
      token: readSecret(required('NAVIS_FORECAST_INVENTORY_TOKEN_FILE')),
    },
  });
  console.info(JSON.stringify({ status: result.status, targetDate: result.targetDate, targets: result.results.length }));
} catch {
  console.error('Forecast run failed. Check configuration and private service status.');
  process.exitCode = 1;
}
