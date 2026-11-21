import { isUuid, sha256, type PromoArtifacts } from '../../../services/marketing/promo/contracts.ts';
import type { PromoUsage } from '../../../services/insight/usage.ts';

type Endpoint = { baseUrl: string; token: string };
type Meter = { record(storeId: string, usage: PromoUsage, signal?: AbortSignal): Promise<void> };

function workloadClient(endpoint: Endpoint) {
  return async (path: string, init: RequestInit, signal?: AbortSignal) => {
    const timeout = AbortSignal.timeout(10_000);
    const response = await fetch(new URL(path, endpoint.baseUrl), {
      ...init, redirect: 'error', signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      headers: { authorization: `Bearer ${endpoint.token}`, ...init.headers },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Promo workload request failed');
    }
    return response;
  };
}

function jsonPost(body: object): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

const artifactPath = '/internal/v1/promo-artifacts';

export function createArtifactClient(endpoint: Endpoint): PromoArtifacts {
  const request = workloadClient(endpoint);
  return {
    async put(scope, identity, purpose, mime, bytes, signal) {
      const registration = await request(artifactPath, jsonPost({
        ...scope, artifactId: identity, purpose, mime, sizeBytes: bytes.length, sha256: sha256(bytes),
      }), signal);
      const { fileId, status } = await registration.json();
      if (!isUuid(fileId) || !['ready', 'uploading'].includes(status)) throw new Error('Unexpected promo artifact receipt');
      if (status === 'uploading') {
        await request(`${artifactPath}/${fileId}/bytes?storeId=${scope.storeId}`, {
          method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(bytes),
        }, signal);
      }
      const verification = await request(`${artifactPath}/${fileId}/verify`, jsonPost(scope), signal);
      const ready = await verification.json();
      if (ready.fileId !== fileId || ready.status !== 'ready') throw new Error('Promo artifact is not ready');
      return fileId;
    },
    async read(scope, fileId, signal) {
      const response = await request(`${artifactPath}/${fileId}/read`, jsonPost(scope), signal);
      return { bytes: Buffer.from(await response.arrayBuffer()), mime: response.headers.get('content-type') ?? '' };
    },
  };
}

export function createUsageClient(endpoint: Endpoint): Meter {
  const request = workloadClient(endpoint);
  return {
    async record(storeId, usage, signal) {
      const init = jsonPost(usage);
      const response = await request(`/internal/v1/insight/stores/${storeId}/ai/usage`, {
        ...init, headers: { ...init.headers, 'x-navis-store-id': storeId },
      }, signal);
      await response.body?.cancel();
    },
  };
}
