/** F00 data port — public entry. Adapters import from here; see PORT.md. (Never import `./autoload` from a `register.ts`.) */
export * from './port';
export { registerDomain, registeredAdapters, clearRegisteredDomains, dataSourceFor } from './registry';
export { createPortTransport, createPortReads, buildUrl, toPortError } from './transport';
export { createPortFiles } from './files';
export { createRealPort, errorResult, failure, type RealPortOptions } from './real-port';
