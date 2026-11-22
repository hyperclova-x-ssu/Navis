import type {ReactNode} from 'react';
import type {AccountHost} from './account-host';
import {AccountContext} from './account-context-value';
/** Provides the signed-in account to the shell. Absent on fixture builds. */
export function AccountProvider({host,children}:{readonly host:AccountHost|null|undefined;readonly children?:ReactNode}){return <AccountContext.Provider value={host??null}>{children}</AccountContext.Provider>;}
