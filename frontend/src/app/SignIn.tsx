import {useState,type FormEvent} from 'react';
/**
 * Owner sign-in (REAL-PLAN F00, SCREENS SCR-352, DESIGN_SYSTEM §21.2). Like AppFailure this renders before any provider or run exists, so it uses plain elements, Korean (the default language)
 * and only the :root tokens of tokens.css; with no stored theme yet it follows the operating system's color scheme. The behavior (labels, one submit, error text, no secret in the DOM after use) is final.
 */
const systemTheme=():'light'|'dark'=>typeof window!=='undefined'&&typeof window.matchMedia==='function'&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
export function SignIn({onSignIn}:{readonly onSignIn:(loginId:string,password:string)=>Promise<void>}){
 const [loginId,setLoginId]=useState(''),[password,setPassword]=useState(''),[pending,setPending]=useState(false),[error,setError]=useState<'credentials'|'unavailable'|null>(null),[theme]=useState(systemTheme);
 const submit=(event:FormEvent)=>{
  event.preventDefault();
  if(pending||!loginId.trim()||!password)return;
  setPending(true);setError(null);
  onSignIn(loginId.trim(),password).then(()=>setPassword(''),(failure:{readonly reason?:string;readonly status?:number}|null)=>{setError(failure?.reason==='BAD_CREDENTIALS'||failure?.status===401?'credentials':'unavailable');setPassword('');setPending(false);});
 };
 return <main className="app-signin" lang="ko" data-theme={theme}><form className="app-signin__card" onSubmit={submit} aria-busy={pending||undefined}>
  <p className="app-signin__brand">Navis</p>
  <h1>로그인</h1>
  <p id="signin-help" className="app-signin__help">사장님 계정으로 들어와 주세요</p>
  <label className="app-signin__field">아이디<input name="loginId" autoComplete="username" value={loginId} onChange={event=>setLoginId(event.target.value)} required autoFocus aria-describedby="signin-help"/></label>
  <label className="app-signin__field">비밀번호<input name="password" type="password" autoComplete="current-password" value={password} onChange={event=>setPassword(event.target.value)} required/></label>
  {error?<p role="alert" className="app-signin__error">{error==='credentials'?'아이디나 비밀번호를 확인해 주세요':'지금은 들어갈 수 없어요. 잠시 뒤 다시 해 주세요'}</p>:null}
  <button type="submit" className="app-signin__submit" disabled={pending}>{pending?'확인하는 중이에요':'들어가기'}</button>
 </form></main>;
}
