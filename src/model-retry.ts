import OpenAI from 'openai';

// SDK-typed transport/provider failures only. Never classify by error wording
// or retry a locally rejected semantic/protocol result.
export function transientModelError(error:unknown):boolean{
 return error instanceof OpenAI.APIConnectionError||error instanceof OpenAI.APIError&&error.status!==undefined&&([408,409,429].includes(error.status)||error.status>=500&&error.status<=599);
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
