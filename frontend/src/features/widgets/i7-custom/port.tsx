import { useMemo, type ReactNode } from 'react';
import { useOptionalWidgetDataStore } from '../../../data/react';
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
