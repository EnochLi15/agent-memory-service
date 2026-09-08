/** Repair only delimiters: trailing commas and paired typographic quotes on
 * identifier keys. Never edit values, invent fields or complete partial JSON. */
export function parseModelJson(content:string):{value:unknown;trailingCommas:number;keyQuotes?:number}{
 try{return {value:JSON.parse(content),trailingCommas:0};}catch(error){
  if(!(error instanceof SyntaxError))throw error;
  let quoted=false,escaped=false,previous='',result='',removed=0,keyQuotes=0;
  for(let i=0;i<content.length;i++){
   const c=content[i]!;
   if(quoted){result+=c;if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;previous=c;continue;}
   if(c==='“'&&(previous==='{'||previous===',')){
    const key=content.slice(i).match(/^“([A-Za-z_][A-Za-z0-9_]*)”(?=[\x20\t\r\n]*:)/);
    if(key){result+='"'+key[1]+'"';i+=key[0].length-1;previous='"';keyQuotes++;continue;}
   }
   if(c==='"')quoted=true;
   if(c===','&&previous&&!['[','{',':',','].includes(previous)){
    let next=i+1;while(/[\x20\t\r\n]/.test(content[next]??'')&&next<content.length)next++;
    if(content[next]===']'||content[next]==='}'){removed++;continue;}
   }
   result+=c;if(!/[\x20\t\r\n]/.test(c))previous=c;
  }
  if(!removed&&!keyQuotes)throw error;
  return {value:JSON.parse(result),trailingCommas:removed,...(keyQuotes?{keyQuotes}:{})};
 }
}
