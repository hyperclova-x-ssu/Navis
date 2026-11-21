import { createWorkerRuntime } from './worker-runtime';
import type { WorkerInbound } from './worker-runtime';
// Native local module Worker, bundled by Vite; no server or external service.
const tasks:(()=>void)[]=[];
const channel=new MessageChannel();
channel.port1.onmessage=()=>tasks.shift()?.();
const runtime=createWorkerRuntime(message=>globalThis.postMessage(message),{now:()=>performance.now(),schedule:callback=>{tasks.push(callback);channel.port2.postMessage(null);}});
globalThis.onmessage=(event:MessageEvent<WorkerInbound>)=>runtime.receive(event.data);
