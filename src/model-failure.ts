import OpenAI from 'openai';
import {ServiceError} from './types.js';

/** Export only bounded protocol metadata. Provider messages, headers, request
 * IDs and free-form error codes can echo input or credentials and are omitted. */
export function modelFailure(error:unknown,signal:AbortSignal,streamStarted:boolean,finishReason:string|null,refusalDetected=false){
 const finish=finishReason&&['stop','length','content_filter','tool_calls','function_call'].includes(finishReason)?finishReason:null;
 const http=error instanceof OpenAI.APIError&&Number.isInteger(error.status)&&error.status!>=400&&error.status!<=599?error.status!:null;
 const categories=signal.aborted?(signal.reason?.name==='TimeoutError'?'deadline':'cancelled'):error instanceof ServiceError&&error.code==='MODEL_OUTPUT'?(finish==='content_filter'||refusalDetected?'provider_filtered':finish==='length'||error.message==='Model output too large'?'output_limit':'incomplete_output'):
  error instanceof ServiceError?'service_validation':error instanceof SyntaxError?'invalid_json':
  error instanceof OpenAI.APIConnectionTimeoutError?'connection_timeout':error instanceof OpenAI.APIConnectionError?'connection':
  http!==null?'provider_http':error instanceof OpenAI.APIError?'provider_stream':'unknown';
 const names=['Error','SyntaxError','TypeError','AbortError','TimeoutError','APIError','APIConnectionError','APIConnectionTimeoutError','APIUserAbortError'];
 const errorType=error instanceof Error&&names.includes(error.name)?error.name:'unknown';
 const transportCodes=['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','ENOTFOUND','EAI_AGAIN','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT','UND_ERR_ABORTED'];
 const cause=error as {code?:unknown;cause?:{code?:unknown;cause?:{code?:unknown}}}|null;
 const code=[cause?.code,cause?.cause?.code,cause?.cause?.cause?.code].find(x=>typeof x==='string'&&transportCodes.includes(x));
 return {error_type:errorType,error_category:categories,http_status:http,signal_aborted:signal.aborted,stream_started:streamStarted,finish_reason:finish,refusal_detected:refusalDetected,transport_code:code??null};
}
