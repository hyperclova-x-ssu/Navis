import { REAL_DOMAINS, type DomainAdapter, type RealDomain, type RealSource } from './port';

const registered = new Map<RealDomain, DomainAdapter>();

/** Called once from each pair's `src/data/reality/nn/register.ts`. Registering is what makes a domain *able* to run over HTTP; the env decides whether it does. */
export function registerDomain(adapter: DomainAdapter): void {
  if (!REAL_DOMAINS.includes(adapter.domain)) throw new Error(`Unknown real domain: ${adapter.domain}`);
  registered.set(adapter.domain, adapter);
}
export const registeredAdapters = (): readonly DomainAdapter[] => [...registered.values()];
/** Test hook: forget every registration. */
export const clearRegisteredDomains = (): void => registered.clear();

type Env = Readonly<Record<string, unknown>>;
/**
 * The single place the data source env is read. `http` only when the build asked for it
 * (`VITE_NAVIS_DATA_SOURCE=http`) and the domain is not listed in `VITE_NAVIS_FIXTURE_DOMAINS` (comma list, e.g. an isolated demo reset).
 * A domain without a registered adapter always runs on the fixture store, whatever this says (see `RealPort.mode`).
 */
export function dataSourceFor(domain: RealDomain, env: Env = import.meta.env as Env): RealSource {
  if (env.VITE_NAVIS_DATA_SOURCE !== 'http') return 'fixture';
  const fixture = String(env.VITE_NAVIS_FIXTURE_DOMAINS ?? '').split(',').map(part => part.trim()).filter(Boolean);
  return fixture.includes(domain) ? 'fixture' : 'http';
}
