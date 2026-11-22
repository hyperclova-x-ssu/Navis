import {useEffect,useState,useSyncExternalStore} from 'react';
import {App} from './App';
import {AppFailure} from './AppRecovery';
import {SignIn} from './SignIn';
import {AccountProvider} from './account-context';
import {createBrowserBootstrap} from './run';
import {readVerification} from './verification-policy';
import type {Locale} from '../contracts';
import {createKitTranslator,layoutTokens} from '../ui';
/** No run exists while this shows, and every new run starts in Korean (API-03 v4): the default language's kit sentence, outside the providers. */
const NEW_RUN_LOCALE:Locale='ko';
const preparingText=createKitTranslator(NEW_RUN_LOCALE).t('ui.loading');
function Preparing(){const [visible,setVisible]=useState(false);useEffect(()=>{const timer=window.setTimeout(()=>setVisible(true),layoutTokens.prepareThresholdMs);return()=>window.clearTimeout(timer);},[]);return visible?<main className="app-fatal" role="status" lang={NEW_RUN_LOCALE}><p>{preparingText}</p></main>:null;}
export function BrowserApp(){const [bootstrap]=useState(()=>createBrowserBootstrap(window));const status=useSyncExternalStore(bootstrap.subscribe,bootstrap.getStatus);useEffect(()=>()=>bootstrap.dispose(),[bootstrap]);const scenario=readVerification(window.location.search);return status.phase==='ready'&&status.run?<AccountProvider host={status.account}><App key={status.run.getState().runId} run={status.run} onRestart={bootstrap.restart} manageLifecycle={false} verification={scenario?{scenario}:undefined}/></AccountProvider>:status.phase==='signin'&&status.account?<SignIn onSignIn={status.account.getController().signIn}/>:status.phase==='failed'||status.phase==='signin'?<AppFailure onRestart={bootstrap.restart}/>:<Preparing/>;}
