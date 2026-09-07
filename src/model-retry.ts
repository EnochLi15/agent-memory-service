import OpenAI from 'openai';

// Only the streaming boundary may construct this marker. APIError without a
// status is otherwise ambiguous; error text is never a retry signal.
class InterruptedProviderStream extends OpenAI.APIError {
 constructor(error:InstanceType<typeof OpenAI.APIError>){super(undefined,error.error,'Provider stream interrupted',error.headers);this.cause=error;}
}
const transientStreamTags=new Set(['server_error','api_error','upstream_error','internal_server_error','overloaded_error','rate_limit_error','rate_limit_exceeded','timeout','request_timeout']);
export function classifyStreamError(error:unknown,started:boolean,finish:string|null,refused:boolean):unknown{
 if(!started||finish!==null||refused||!(error instanceof OpenAI.APIError)||error.status!==undefined||error instanceof OpenAI.APIConnectionError||error instanceof OpenAI.APIUserAbortError)return error;
 if(!error.error||typeof error.error!=='object'||Array.isArray(error.error))return error;
 // Untyped SDK error frames indicate an interrupted provider stream. Explicit
 // unknown/permanent codes remain terminal even if their message says retry.
 if([error.type,error.code].some(tag=>tag!=null&&tag!==''&&!transientStreamTags.has(tag)))return error;
 return new InterruptedProviderStream(error);
}

// SDK-typed transport/provider failures only. Never classify by error wording
// or retry a locally rejected semantic/protocol result.
export function transientModelError(error:unknown):boolean{
 return error instanceof InterruptedProviderStream||error instanceof OpenAI.APIConnectionError||error instanceof OpenAI.APIError&&error.status!==undefined&&([408,409,429].includes(error.status)||error.status>=500&&error.status<=599);
}
/** Share a rate-limit cooldown even when this request has exhausted retries.
 * A long provider hint is retained for other callers; their own deadlines can
 * cancel waiting. It never permits this request extra attempts. */
export function modelRateLimitDelay(error:unknown,now=Date.now(),attempt=0):number|null{
 if(!(error instanceof OpenAI.APIError)||error.status!==429)return null;
 const headers=error.headers;
 const ms=headers?.get('retry-after-ms'),seconds=headers?.get('retry-after');
 if(ms&&/^\d+(?:\.\d+)?$/.test(ms.trim())&&Number.isFinite(Number(ms)))return Number(ms);
 if(seconds){
  if(/^\d+(?:\.\d+)?$/.test(seconds.trim())&&Number.isFinite(Number(seconds)*1000))return Number(seconds)*1000;
  const date=/GMT$/i.test(seconds.trim())?Date.parse(seconds):NaN;
  if(Number.isFinite(date))return Math.max(0,date-now);
 }
 return Math.min(5000,2000*2**attempt);
}
/** Transport retries remain under the original caller signal and configured limit.
 * Refuse long provider waits rather than retrying earlier than requested. */
export function modelRetryDelay(error:unknown,signal:AbortSignal,now=Date.now(),attempt=0):number|null{
 if(signal.aborted||!transientModelError(error))return null;
 const headers=error instanceof OpenAI.APIError?error.headers:undefined;
 if(headers?.get('x-should-retry')?.toLowerCase()==='false')return null;
 const numeric=(text:string|null|undefined):number|undefined=>text!==undefined&&text!==null&&/^\d+(?:\.\d+)?$/.test(text.trim())?Number(text):undefined;
 let delay=numeric(headers?.get('retry-after-ms'));
 if(delay===undefined){
  const hint=headers?.get('retry-after');
  if(hint){const seconds=numeric(hint);if(seconds!==undefined)delay=seconds*1000;else{const date=/GMT$/i.test(hint.trim())?Date.parse(hint):NaN;if(Number.isFinite(date))delay=Math.max(0,date-now);}}
 }
 if(delay!==undefined)return Number.isFinite(delay)&&delay<=5000?delay:null;
 return Math.min(1000,500*2**attempt);
}
