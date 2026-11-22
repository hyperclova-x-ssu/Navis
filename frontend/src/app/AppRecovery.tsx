import {Component,Fragment,type ReactNode} from 'react';
/** This fallback must render even when the provider or its token context failed. */
export function AppFailure({onRestart}:{readonly onRestart:()=>void}){return <main className="app-fatal" role="alert"><h1>화면을 보여 주지 못했어요</h1><p>다시 시작하면 업종 선택부터 새로 시작해요</p><button type="button" onClick={onRestart}>다시 시작하기</button></main>;}
export function AccountUnavailable({onRetry}:{readonly onRetry:()=>void}){
 const dark=typeof window.matchMedia==='function'&&window.matchMedia('(prefers-color-scheme: dark)').matches;
 return <main className="app-signin" lang="ko" data-theme={dark?'dark':'light'}>
  <section className="app-signin__card" role="alert" aria-labelledby="account-unavailable-title">
   <h1 id="account-unavailable-title">서버에 연결하지 못했어요</h1>
   <p className="app-signin__help">잠시 뒤 다시 열어 주세요</p>
   <button type="button" className="app-signin__submit" onClick={onRetry}>다시 열기</button>
  </section>
 </main>;
}
export class AppRecovery extends Component<{readonly children:ReactNode;readonly onRestart?:()=>void},{readonly failed:boolean;readonly attempt:number}>{
 state={failed:false,attempt:0};static getDerivedStateFromError(){return {failed:true};}
 render(){return this.state.failed?<AppFailure onRestart={()=>{this.props.onRestart?.();this.setState(s=>({failed:false,attempt:s.attempt+1}));}}/>:<Fragment key={this.state.attempt}>{this.props.children}</Fragment>;}
}
