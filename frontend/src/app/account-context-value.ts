import {createContext,useContext,useSyncExternalStore} from 'react';
import type {AccountController,AccountHost} from './account-host';
export const AccountContext=createContext<AccountHost|null>(null);
const noSubscribe=()=>()=>undefined;
/** The signed-in account (stores, store switch, sign-out), or null on fixture builds. */
export function useAccountController():AccountController|null{
 const host=useContext(AccountContext);
 return useSyncExternalStore(host?host.subscribe:noSubscribe,()=>host?host.getController():null,()=>null);
}
/** Only the active store's name (`null` on fixture builds, no account). The board must not re-render when the sync status flips to saving and back after each layout write. */
export function useAccountStoreName():string|undefined|null{
 const host=useContext(AccountContext);
 return useSyncExternalStore(host?host.subscribe:noSubscribe,()=>host?host.getController().storeName:null,()=>null);
}
