export type SensSettings = { storeName: string; senderNumber: string | null; optOutNumber: string | null };

export function configuredSensSettings(value: SensSettings | null, senderNumber?: string):
  value is SensSettings & { senderNumber: string; optOutNumber: string } {
  return Boolean(value && typeof value.storeName === 'string' && value.storeName.trim() && !/[\r\n]/.test(value.storeName)
    && /^[0-9]{8,11}$/.test(value.senderNumber ?? '') && /^080[0-9]{7,8}$/.test(value.optOutNumber ?? '')
    && (senderNumber === undefined || value.senderNumber === senderNumber));
}

export function liveAdvertisingText(body: string, settings: SensSettings & { optOutNumber: string }) {
  return `(광고) ${settings.storeName.trim()}\n${body.trim().replace(/^\(광고\)\s*/, '')}\n무료수신거부 ${settings.optOutNumber}`;
}

export function createSensSettingsReader(account: URL, token: string) {
  return async (storeId: string): Promise<SensSettings | null> => {
    const response = await fetch(new URL(`/internal/v1/account/stores/${storeId}/sens-settings`, account), {
      redirect: 'error', signal: AbortSignal.timeout(2500), headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404) return null;
      throw new Error('Store SENS settings unavailable');
    }
    const settings = await response.json() as SensSettings | null;
    return configuredSensSettings(settings) ? settings : null;
  };
}
