import '../ui/test-setup';
import '@testing-library/jest-dom/vitest';
import {afterEach,expect,it} from 'vitest';
import {render,screen,waitFor,cleanup} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {createRunStore} from '../state';
import {getRegistry,getCatalog} from '../catalog';
import {preview,screenPresets} from '../layout';
import {testTime} from '../layout/test-policy';
import type {LayoutAdapter,LayoutWorkerRequest,LayoutWorkerResponse} from '../contracts';
import {createPortTransport} from '../data/reality/00/transport';
import {fakeBackend,reply} from '../data/reality/00/testing';
import {buildAccountHost} from './account-host';
import {createBrowserBootstrap} from './run';
import {SignIn} from './SignIn';

const solve=(request:LayoutWorkerRequest):LayoutWorkerResponse=>({...request,result:preview(request.beforePanels,request.intent,screenPresets[request.presetId].grid,getCatalog(request.presetId))});
const adapter=():LayoutAdapter=>({ready:async()=>{},submit:(request,receive)=>receive(solve(request)),cancel(){},dispose(){}});
const newRun=()=>createRunStore({screenPreset:screenPresets.A,catalog:getRegistry('A'),time:testTime,clock:()=>0,theme:'light',layoutAdapter:adapter()});
const stored={profile:{storeId:'s',name:'모아 카페',businessType:'cafe',paymentStyle:'prepaid',tableLayout:null,onboardingDone:true,revision:3},preferences:{theme:'dark',textScale:125,locale:'en',revision:2}};
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
afterEach(cleanup);

function backendWith(over:{profile?:unknown}={}){
 const backend=fakeBackend();
 backend.on('GET','/profile',()=>over.profile??stored.profile);
 backend.on('GET','/preferences',()=>stored.preferences);
 backend.on('GET','/boards',()=>({items:[],nextCursor:null,asOf:'x',sourceRevision:1}));
 backend.on('GET','/api/v1/stores',()=>({items:[{storeId:'s',name:'모아 카페',role:'owner',current:true}],nextCursor:null,asOf:'x',sourceRevision:1}));
 return backend;
}
const bootstrapOver=(backend:ReturnType<typeof fakeBackend>)=>{
 const transport=createPortTransport(backend.fetch);
 return {transport,bootstrap:createBrowserBootstrap(window,()=>newRun(),(run,control)=>buildAccountHost(run,control,transport))};
};

it('restores the stored account into the run before the first screen is ready',async()=>{
 const {bootstrap}=bootstrapOver(backendWith());
 const stop=bootstrap.subscribe(()=>{});
 expect(bootstrap.getStatus().phase).toBe('preparing');
 await waitFor(()=>expect(bootstrap.getStatus().phase).toBe('ready'));
 const state=bootstrap.getStatus().run!.getState();
 expect(state).toMatchObject({screen:'dashboard',theme:'dark',textScale:125,locale:'en',businessType:'cafe',onboarding:{step:'done'}});
 stop();bootstrap.dispose();
});

it('asks for sign-in when no session can be started, then continues after a successful sign-in',async()=>{
 const backend=backendWith();
 let signedIn=false;
 backend.on('POST','/api/v1/auth/refresh',()=>signedIn?{accessToken:'t',expiresIn:600,storeId:backend.storeId}:reply(401,{code:'UNAUTHENTICATED'}));
 backend.on('POST','/api/v1/auth/demo',()=>reply(404,{code:'NOT_FOUND'}));
 backend.on('POST','/api/v1/auth/login',call=>(call.body as {password:string}).password==='pw'?(signedIn=true,{accessToken:'login-token',expiresIn:600,storeId:backend.storeId}):reply(401,{code:'UNAUTHENTICATED',reason:'BAD_CREDENTIALS'}));
 const {bootstrap}=bootstrapOver(backend);
 const stop=bootstrap.subscribe(()=>{});
 await waitFor(()=>expect(bootstrap.getStatus().phase).toBe('signin'));
 const account=bootstrap.getStatus().account!;
 const user=userEvent.setup();
 render(<SignIn onSignIn={account.getController().signIn}/>);
 await user.type(screen.getByLabelText('아이디'),'owner');
 await user.type(screen.getByLabelText('비밀번호'),'wrong');
 await user.click(screen.getByRole('button',{name:'들어가기'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('아이디나 비밀번호를 확인해 주세요');
 expect(screen.getByLabelText('비밀번호')).toHaveValue('');
 await user.type(screen.getByLabelText('비밀번호'),'pw');
 await user.click(screen.getByRole('button',{name:'들어가기'}));
 const seen:string[]=[];bootstrap.subscribe(()=>seen.push(bootstrap.getStatus().phase));
 await waitFor(()=>expect(bootstrap.getStatus().phase).toBe('ready'),{timeout:1500}).catch(error=>{console.log('PHASES',seen,backend.calls.map(c=>c.method+' '+c.path),backend.authCalls);throw error;});
 expect(bootstrap.getStatus().run!.getState().onboarding.step).toBe('done');
 stop();bootstrap.dispose();
});

it('can retry a temporary account failure in the same run',async()=>{
 const backend=backendWith();
 let unavailable=true;
 backend.on('GET','/profile',()=>unavailable?reply(503,{code:'SERVICE_UNAVAILABLE'}):stored.profile);
 const {bootstrap}=bootstrapOver(backend);
 const stop=bootstrap.subscribe(()=>{});
 await waitFor(()=>expect(bootstrap.getStatus().phase).toBe('account-unavailable'));
 const run=bootstrap.getStatus().run;
 unavailable=false;
 bootstrap.retry();
 await waitFor(()=>expect(bootstrap.getStatus().phase).toBe('ready'));
 expect(bootstrap.getStatus().run).toBe(run);
 stop();bootstrap.dispose();
 await settle();
});

it('switches store by saving, adopting the new session and starting a new run that reads the new store',async()=>{
 const backend=backendWith();
 backend.on('POST','/api/v1/auth/store',()=>({accessToken:'store-2',expiresIn:600,storeId:backend.storeId}));
 const {bootstrap}=bootstrapOver(backend);
 const stop=bootstrap.subscribe(()=>{});
 await waitFor(()=>expect(bootstrap.getStatus().phase).toBe('ready'));
 const first=bootstrap.getStatus().run;
 await bootstrap.getStatus().account!.getController().switchStore('s');
 await waitFor(()=>{expect(bootstrap.getStatus().phase).toBe('ready');expect(bootstrap.getStatus().run).not.toBe(first);});
 expect(backend.calls.filter(call=>call.path==='/profile').length).toBeGreaterThanOrEqual(2);
 stop();bootstrap.dispose();
});
