export const verificationScenarios=['error-provider','error-canvas','error-detail','error-settings','error-briefing','preview-start-rejected','layout-pending','layout-worker-error'] as const;
export type VerificationScenario=typeof verificationScenarios[number];
export interface AppVerification {readonly scenario:VerificationScenario;readonly initialFailure?:boolean}
export function readVerification(search:string):VerificationScenario|null{if(!import.meta.env.DEV)return null;const value=new URLSearchParams(search).get('verify');return verificationScenarios.find(s=>s===value)??null;}
