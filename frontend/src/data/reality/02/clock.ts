/** The store clock of the mockup is Korea Standard Time (D-248: business timestamps are store-local strings, never the device clock). */
const KST_MS = 9 * 3_600_000;

/** `2026-10-26T06:45:00.000Z` → `2026-10-26T15:45` (the local shape every POS row uses). */
export function kstLocal(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) throw new Error('INVALID_INSTANT');
  return new Date(at + KST_MS).toISOString().slice(0, 16);
}

/** `2026-10-26T15:45` (store-local) → ISO instant with an explicit +09:00 offset, as the terminal record requires. */
export function kstOffset(local: string): string {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(local)) throw new Error('INVALID_LOCAL_TIME');
  return `${local}:00+09:00`;
}
