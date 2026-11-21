import type { ReactNode } from 'react';
import { CustomOrderContext } from './context';
import type { CustomOrderPort } from './port-types';
export type { CustomOrderPort, CustomReturnContext, CustomUiResult } from './port-types';
export function CustomOrderProvider({ port, state = 'ready', children }: { readonly port: CustomOrderPort; readonly state?: 'ready' | 'empty' | 'error'; readonly children?: ReactNode }) {
  return <CustomOrderContext.Provider value={{ port, state }}>{children}</CustomOrderContext.Provider>;
}
