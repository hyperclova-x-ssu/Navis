import { preparePersonaDatabase, startPersona } from '../persona.ts';

/**
 * Compose-only launcher for the committed naver-virtual provider (PN-P0..P5 registrars) with the
 * PN-A2 marketing grant. Migrates and seeds a fresh database at the D-313 fixed clock, then serves the
 * private port 3000. TalkTalk callbacks go to http://marketing:3000 (PN-P0 callback allowlist).
 */
const databaseUrl = process.env.PN_A2_DATABASE_URL;
if (!databaseUrl) throw new Error('PN_A2_DATABASE_URL is required');
await preparePersonaDatabase(databaseUrl);
const persona = await startPersona({ databaseUrl, host: '0.0.0.0', port: 3000 });
process.once('SIGTERM', () => void persona.close());
