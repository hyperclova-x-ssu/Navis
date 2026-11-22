import { useEffect, useState } from 'react';
import { useRealPort, useWidgetDataStore } from '../../../data/react';

type MemberProjection = { readonly kind: 'sale' | 'cancel-use'; readonly id: string };
type Pending = MemberProjection & { readonly status: 'loading' | 'retry' };

/** Customer pass state is updated by the POS event consumer after the POS receipt. */
export function useMemberProjection() {
  const real = useRealPort();
  const store = useWidgetDataStore();
  const [pending, setPending] = useState<Pending | null>(null);
  useEffect(() => {
    if (!real || pending?.status !== 'loading') return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    let remaining = 6;
    async function check(port: NonNullable<typeof real>, projection: Pending) {
      const data = store.getSnapshot().tables.realMembers;
      const applied = projection.kind === 'sale' ? data?.passes.some(row => row.membershipId === projection.id)
        : data?.uses.some(row => row.useId === projection.id && row.canceledAt);
      if (applied) { setPending(null); return; }
      if (remaining-- <= 0) { setPending({ ...projection, status: 'retry' }); return; }
      await port.retry('members');
      if (active) timer = setTimeout(() => { void check(port, projection); }, 400);
    }
    void check(real, pending);
    return () => { active = false; clearTimeout(timer); };
  }, [pending, real, store]);
  return {
    status: pending?.status,
    waitFor: (projection: MemberProjection) => setPending({ ...projection, status: 'loading' }),
    retry: () => setPending(current => current && { ...current, status: 'loading' }),
  };
}
