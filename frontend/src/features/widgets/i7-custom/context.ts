import { createContext } from 'react';
import type { CustomOrderPort } from './port-types';
export const CustomOrderContext = createContext<{ port: CustomOrderPort; state: 'ready' | 'empty' | 'error' } | null>(null);
