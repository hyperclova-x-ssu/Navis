import { Component,type ReactNode } from 'react';
import { InlineError } from './presentation';
export interface ContentRecoveryProps {readonly children:ReactNode;readonly fallback?:ReactNode;readonly onRetry?:()=>void;readonly resetKey?:string|number}
/** Keep this boundary inside an overlay body so title, close and focus survive. */
export class ContentRecovery extends Component<ContentRecoveryProps,{failed:boolean;resetKey:string|number|undefined}> {
  state={failed:false,resetKey:this.props.resetKey};
  static getDerivedStateFromError(){return {failed:true};}
  static getDerivedStateFromProps(props:ContentRecoveryProps,state:{resetKey:string|number|undefined}){return props.resetKey!==state.resetKey?{failed:false,resetKey:props.resetKey}:null;}
  render(){return this.state.failed?this.props.fallback??<InlineError onRetry={()=>{this.props.onRetry?.();this.setState({failed:false});}}/>:this.props.children;}
}
