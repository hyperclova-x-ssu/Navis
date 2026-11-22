import { useContext, useMemo, type ReactNode } from 'react';
import { useDomainState, useOptionalWidgetDataStore, useRealRetry, useWidgetView } from '../../../data/react';
import { useBundle } from '../../../i18n';
import { dataBundles, resolveDataText } from '../../../data/widget-data';
import { CustomOrderContext } from './context';
import { createHttpCustomPort } from './http-port';
import type { CustomOrderPort } from './port-types';
export type { CustomOrderPort, CustomReturnContext, CustomUiResult } from './port-types';

/** On an HTTP build the `custom` domain is served by the POS service; the widget then talks to it through the run's data port. */
export function CustomOrderProvider({ port, state = 'ready', children }: { readonly port: CustomOrderPort; readonly state?: 'ready' | 'empty' | 'error'; readonly children?: ReactNode }) {
  const store = useOptionalWidgetDataStore();
  const http = !!store?.real && store.real.mode('custom') === 'http';
  const effective = useMemo(() => http && store ? createHttpCustomPort(port, store) : port, [http, port, store]);
  return <CustomOrderContext.Provider value={{ port: effective, state }}>{children}</CustomOrderContext.Provider>;
}

export function CustomOrderReadBoundary({ children }: { children: ReactNode }) {
  const context = useContext(CustomOrderContext);
  return context?.port.real ? <HttpCustomOrderProvider port={context.port}>{children}</HttpCustomOrderProvider> : children;
}

function HttpCustomOrderProvider({ port, children }: { port: CustomOrderPort; children?: ReactNode }) {
  const domain = useDomainState('custom');
  const members = useWidgetView('members');
  const t = useBundle(...dataBundles);
  const retry = useRealRetry('custom');
  const effective = useMemo(() => ({ ...port, members: members.status === 'ready'
    ? members.model.rows.map(row => ({ memberId: row.memberId, code: row.memberCode, label: typeof row.name === 'string' ? row.name : resolveDataText(t.t, row.name) })) : [] }), [port, members, t]);
  const state = domain.status === 'idle' || domain.status === 'loading' ? 'loading' : domain.status === 'error' ? 'error' : 'ready';
  return <CustomOrderContext.Provider value={{ port: effective, state, retry }}>{children}</CustomOrderContext.Provider>;
}
