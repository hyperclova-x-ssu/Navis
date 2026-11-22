export type TaxEvidenceFile = {
  fileId: string; contentType: 'image/png' | 'image/jpeg' | 'image/webp' | 'application/pdf'; size: number; sha256: string;
};
/** Resolves a complete Account file of purpose `tax-evidence` visible to this store owner, or null when there is none. */
export type VerifyTaxEvidence = (scope: { storeId: string; actorId: string; fileId: string }) => Promise<TaxEvidenceFile | null>;

const contentTypes = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseEvidenceFile(value: unknown): TaxEvidenceFile {
  if (!value || typeof value !== 'object') throw new Error('Account evidence metadata is invalid');
  const { fileId, purpose, contentType, size, sha256 } = value as Record<string, unknown>;
  const type = contentTypes.find(item => item === contentType);
  if (typeof fileId !== 'string' || !uuid.test(fileId) || purpose !== 'tax-evidence' || !type
    || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1
    || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('Account evidence metadata is invalid');
  return { fileId, contentType: type, size, sha256 };
}

/**
 * POS workload client for the Account verifier requested by the composition layer:
 * `POST /internal/v1/account/stores/{storeId}/files/{fileId}/evidence-verify` with `{actorId,purpose:'tax-evidence'}`.
 * 200 returns `{fileId,purpose,contentType,size,sha256}`; 404 means missing, pending, revoked, other purpose or not the owner.
 */
export function createTaxEvidenceVerifier(base: string | URL, token: string, fetcher: typeof fetch = fetch): VerifyTaxEvidence {
  const origin = new URL(base);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password ||
    origin.pathname !== '/' || origin.search || origin.hash || !token) {
    throw new Error('Invalid private Account origin or token');
  }
  return async ({ storeId, actorId, fileId }) => {
    const url = new URL(`/internal/v1/account/stores/${encodeURIComponent(storeId)}/files/${encodeURIComponent(fileId)}/evidence-verify`, origin);
    const response = await fetcher(url, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ actorId, purpose: 'tax-evidence' }), signal: AbortSignal.timeout(1_800), redirect: 'error',
    });
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error('Account evidence verifier unavailable');
    }
    const file = parseEvidenceFile(await response.json());
    if (file.fileId !== fileId.toLowerCase()) throw new Error('Account evidence metadata is invalid');
    return file;
  };
}
