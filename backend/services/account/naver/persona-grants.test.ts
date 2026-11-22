import { describe, expect, it, vi } from 'vitest';
import { createPersonaOwnerGrants } from './persona-grants.ts';

describe('persona owner grants', () => {
  it('requests a synthetic grant only for the configured owner and scope', async () => {
    const owner = { storeId: 'store', actorId: 'owner' };
    const handler = vi.fn(() => Response.json({ accessToken: 'fixture-grant', expiresIn: 60 }));
    const reader = createPersonaOwnerGrants({ owner, scopes: ['calendar'], bindings: [{
      mode: 'fake', storeId: owner.storeId, providerAccount: 'fixture', operation: 'pn11.fixture.owner-grant',
      grade: 'P', method: 'POST', route: /^\/partner-assumed\/v1\/fixture\/owner-grants$/, handler,
    }] });
    expect(await reader.read({ ...owner, actorId: 'other' }, 'calendar')).toBeUndefined();
    expect(await reader.read(owner, 'cafe')).toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
    expect(await reader.resolve(owner, 'calendar')).toBe('fixture-grant');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
