import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

type Obj = Record<string, any>;
const env = (process.env.MAKEFUN_ENV_URL || '').replace(/\/+$/, '');
const promptFile = process.env.MAKEFUN_PROMPT_FILE || '';
const isObj = (x: unknown): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x);
const schemas: Record<string, any> = {};
if (promptFile) {
  const source = readFileSync(promptFile, 'utf8');
  for (const match of source.matchAll(/\{[^{}]*"schema"\s*:\s*"[^"]+"[^{}]*\}/g)) {
    try { const o = JSON.parse(match[0]); schemas[o.schema] = o; } catch { /* nested documents are parsed below */ }
  }
  const doc = (schema: string) => {
    const at = source.search(new RegExp(`"schema"\\s*:\\s*"${schema.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}"`));
    if (at < 0) return null;
    const start = source.lastIndexOf('{', at);
    let depth = 0, quoted = false, slash = false;
    for (let i = start; i < source.length; i++) {
      const c = source[i];
      if (quoted) { if (slash) slash = false; else if (c === '\\') slash = true; else if (c === '"') quoted = false; continue; }
      if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) return JSON.parse(source.slice(start, i + 1));
    }
    return null;
  };
  for (const s of ['free-model-aggregator-01/providers/v1','free-model-aggregator-01/ratings/v1','free-model-aggregator-01/workload/v1']) schemas[s] = doc(s);
}
const directory: Obj = schemas['free-model-aggregator-01/providers/v1'] || { providers: [] };
const ratings: Obj = schemas['free-model-aggregator-01/ratings/v1'] || { ratings: [], best: [] };
const workload: Obj = schemas['free-model-aggregator-01/workload/v1'] || { manifest: [] };
const ratingMap = new Map((ratings.ratings || []).map((r: Obj) => [`${r.provider}/${r.model}`, r]));
const join = (base: string) => /^https?:/.test(base) ? base.replace(/\/+$/, '') : `${env}${base.startsWith('/') ? '' : '/'}${base}`;
function auth(p: Obj): Obj {
  if (p.auth === 'bearer') return { authorization: `Bearer ${p.key}` };
  if (p.auth === 'x-api-key') return { 'x-api-key': p.key };
  if (p.auth === 'x-goog-api-key') return { 'x-goog-api-key': p.key };
  return {};
}
async function probe(p: Obj): Promise<Obj> {
  try {
    const base = join(p.base_url || p.path);
    let url = p.wire === 'gemini' ? `${base}/v1beta/models` : `${base}/v1/models`;
    const res = await fetch(url, { headers: auth(p), signal: AbortSignal.timeout(5000) });
    const body = await res.json() as Obj;
    let rows: Obj[] = [];
    if (p.wire === 'gemini') rows = (body.models || []).map((m: Obj) => ({ id: String(m.name || '').replace(/^models\//, ''), display_name: m.displayName || m.name }));
    else rows = body.data || [];
    return { provider: p, ok: res.ok, models: rows };
  } catch { return { provider: p, ok: false, models: [] }; }
}
let probes: Obj[] = [];
let catalog: Obj = { providers: [] };
const catalogText = () => JSON.stringify(catalog);
function caps(p: Obj, m: Obj): Obj { return ratingMap.get(`${p.id}/${m.id}`) || {}; }
function free(p: Obj, m: Obj): boolean { const r = caps(p,m); return r.free === true || m.free === true; }
function listModels(): Obj[] {
  return probes.flatMap(q => q.ok ? q.models.filter((m: Obj) => free(q.provider,m)).map((m: Obj) => ({ id:m.id, provider:q.provider.id, display_name:m.display_name || m.id })) : []);
}
function satisfies(req: Obj, c: Obj): boolean {
  return (!req.tools || c.tools === true) && (!req.vision || c.vision === true) && (!req.json || c.json === true) && (!req.min_context || (typeof c.context_length === 'number' && c.context_length >= req.min_context));
}
function candidates(req: Obj): Obj[] {
  const out: Obj[] = [];
  for (const q of probes) if (q.ok) for (const m of q.models) {
    const c = caps(q.provider,m); if (!free(q.provider,m) || !satisfies(req,c)) continue;
    out.push({ q, m, rating: c.rating_milli || 0, calls: providerCalls.get(q.provider.id) || 0 });
  }
  out.sort((a,b) => b.rating-a.rating || a.calls-b.calls || a.q.provider.id.localeCompare(b.q.provider.id) || a.m.id.localeCompare(b.m.id));
  const leaders: Obj[] = [];
  for (const item of out) if (!leaders.some(x => x.q.provider.id === item.q.provider.id)) leaders.push(item);
  const span = Math.min(4, leaders.length);
  const offset = requestIndex % Math.max(1, span);
  const order = span > 1 ? [...leaders.slice(offset, span), ...leaders.slice(0, offset), ...leaders.slice(span)] : leaders;
  return order.flatMap(item => out.filter(x => x.q.provider.id === item.q.provider.id));
}
const providerCalls = new Map<string, number>();

async function readBody(req: any): Promise<Obj> {
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
  const val = JSON.parse(Buffer.concat(chunks).toString('utf8')); return isObj(val) ? val : {};
}
function textOf(v: any): string { if (typeof v === 'string') return v; return Array.isArray(v) ? v.filter(x=>isObj(x)&&x.type==='text').map(x=>x.text).join('\n') : ''; }
function anthropicRequest(b: Obj, model: string): Obj {
  const messages: Obj[]=[]; const sys=textOf(b.system); if(sys) messages.push({role:'system',content:sys});
  for(const m of b.messages||[]) {
    if(typeof m.content==='string'){messages.push({role:m.role,content:m.content});continue;}
    const parts: Obj[]=[]; const calls: Obj[]=[];
    for(const x of m.content||[]) if(isObj(x)) {
      if(x.type==='text') parts.push({type:'text',text:x.text});
      if(x.type==='image'&&isObj(x.source)) parts.push({type:'image_url',image_url:{url:x.source.type==='url'?x.source.url:`data:${x.source.media_type};base64,${x.source.data}`}});
      if(x.type==='tool_use') calls.push({id:x.id,type:'function',function:{name:x.name,arguments:JSON.stringify(x.input||{})}});
      if(x.type==='tool_result') messages.push({role:'tool',tool_call_id:x.tool_use_id,content:textOf(x.content)||JSON.stringify(x.content)});
    }
    messages.push({role:m.role,content:parts.length?parts:null,...(calls.length?{tool_calls:calls}:{})});
  }
  const o:Obj={model,messages};
  for(const [src,dst] of [['max_tokens','max_tokens'],['temperature','temperature'],['top_p','top_p']] as string[][]) if(b[src]!==undefined)o[dst]=b[src];
  if(b.stop_sequences)o.stop=b.stop_sequences;
  if(Array.isArray(b.tools)&&b.tools.length)o.tools=b.tools.map((t:Obj)=>({type:'function',function:{name:t.name,description:t.description||'',parameters:t.input_schema||{type:'object',properties:{}}}}));
  if(b.tool_choice?.type==='auto')o.tool_choice='auto'; else if(b.tool_choice?.type==='any')o.tool_choice='required'; else if(b.tool_choice?.type==='tool')o.tool_choice={type:'function',function:{name:b.tool_choice.name}};
  if(b.stream){o.stream=true;o.stream_options={include_usage:true};}
  return o;
}
function toAnthropic(a: Obj, model: string): Obj {
  const ch=a.choices?.[0]||{}, msg=ch.message||{}, content:Obj[]=[];
  if(typeof msg.content==='string')content.push({type:'text',text:msg.content});
  for(const t of msg.tool_calls||[]) content.push({type:'tool_use',id:t.id,name:t.function?.name,input:parseArgs(t.function?.arguments)});
  if(!content.length)content.push({type:'text',text:''});
  return {id:`msg_${a.id||'aggregate'}`,type:'message',role:'assistant',model,content,stop_reason:stop(ch.finish_reason),stop_sequence:null,usage:{input_tokens:a.usage?.prompt_tokens||0,output_tokens:a.usage?.completion_tokens||0}};
}
function parseArgs(v:any):Obj {try{return typeof v==='string'?JSON.parse(v):v||{};}catch{return {};}}
function stop(v:any):string {return v==='length'?'max_tokens':v==='tool_calls'?'tool_use':v==='content_filter'?'refusal':'end_turn';}

async function upstream(p: Obj, m: Obj, b: Obj, api: string): Promise<{status:number; body:Obj; raw:string}> {
  const base=join(p.base_url||p.path), headers:Obj={'content-type':'application/json',...auth(p)};
  let url='', payload:Obj, kind=p.wire;
  if(kind==='openai') { url=`${base}/v1/chat/completions`; payload=api==='anthropic'?anthropicRequest(b,m.id):{...b,model:m.id,...(b.stream?{stream_options:{...(b.stream_options||{}),include_usage:true}}:{})}; }
  else if(kind==='anthropic') {
    url=`${base}/v1/messages`;
    if(api==='anthropic') payload={...b,model:m.id};
    else {
      let system=''; const messages:Obj[]=[];
      for(const row of b.messages||[]) {
        if(row.role==='system'||row.role==='developer') { system+=(system?'\n':'')+textOf(row.content); continue; }
        const content=Array.isArray(row.content)?row.content.flatMap((part:Obj)=>{
          if(part?.type==='text')return [{type:'text',text:part.text}];
          if(part?.type==='image_url') {
            const url=part.image_url?.url||'', match=url.match(/^data:([^;]+);base64,(.*)$/);
            return match?[{type:'image',source:{type:'base64',media_type:match[1],data:match[2]}}]:[{type:'image',source:{type:'url',url}}];
          }
          return [];
        }):row.content;
        messages.push({role:row.role==='assistant'?'assistant':'user',content});
      }
      payload={model:m.id,max_tokens:b.max_tokens||512,messages,...(system?{system}:{}),...(b.temperature!==undefined?{temperature:b.temperature}:{}),...(Array.isArray(b.stop)?{stop_sequences:b.stop}:{}),...(b.tools?{tools:b.tools.map((t:Obj)=>({name:t.function?.name,description:t.function?.description||'',input_schema:t.function?.parameters||{type:'object',properties:{}}}))}:{}),...(b.tool_choice?{tool_choice:b.tool_choice==='required'?{type:'any'}:b.tool_choice==='auto'?{type:'auto'}:b.tool_choice}:{}),...(b.stream?{stream:true}:{})};
    }
  }
  else {
    const contents:any[]=[]; let systemInstruction:any;
    const msgs=api==='anthropic'?anthropicRequest(b,m.id).messages:b.messages||[];
    for(const msg of msgs) {
      if(msg.role==='system'||msg.role==='developer'){systemInstruction={parts:[{text:textOf(msg.content)}]};continue;}
      const role=msg.role==='assistant'?'model':'user', parts:any[]=[];
      if(typeof msg.content==='string')parts.push({text:msg.content});
      else for(const part of msg.content||[]) if(isObj(part)) {
        if(part.type==='text')parts.push({text:part.text});
        if(part.type==='image_url') { const u=part.image_url?.url||''; const mt=u.match(/^data:([^;]+);base64,(.*)$/); if(mt)parts.push({inlineData:{mimeType:mt[1],data:mt[2]}}); else parts.push({text:u}); }
      }
      if(msg.tool_calls) for(const call of msg.tool_calls)parts.push({functionCall:{name:call.function?.name,args:parseArgs(call.function?.arguments)}});
      contents.push({role,parts});
    }
    const stopList=Array.isArray(b.stop)?b.stop:b.stop_sequences;
    payload={contents,generationConfig:{...(b.max_tokens?{maxOutputTokens:b.max_tokens}:{}),...(b.temperature!==undefined?{temperature:b.temperature}:{}),...(Array.isArray(stopList)?{stopSequences:stopList}:{}),...(b.response_format?.type==='json_object'?{responseMimeType:'application/json'}:{})},...(systemInstruction?{systemInstruction}:{})};
    if(b.tools?.length)payload.tools=[{functionDeclarations:b.tools.map((t:Obj)=>({name:t.function?.name,description:t.function?.description,parameters:t.function?.parameters}))}];
    url=`${base}/v1beta/models/${encodeURIComponent(m.id)}:${b.stream?'streamGenerateContent?alt=sse':'generateContent'}`;
  }
  if(b.stream)headers.accept='text/event-stream';
  const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(payload),signal:AbortSignal.timeout(25000)});
  const raw=await response.text();
  let answer:Obj={};
  if(response.ok) {
    if(b.stream) answer=assemble(raw,kind);
    else try{answer=JSON.parse(raw);}catch{answer={};}
    if(kind==='gemini') answer=geminiAnswer(answer,m.id);
    if(kind==='anthropic'&&api==='openai') answer=anthropicAnswer(answer,m.id);
  }
  return {status:response.status,body:answer,raw};
}
function assemble(raw:string, wire:string):Obj {
  const frames=raw.split(/\r?\n\r?\n/).map(f=>f.split(/\r?\n/).filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n')).filter(Boolean);
  const chunks:any[]=[]; for(const frame of frames) { if(frame==='[DONE]')continue; try{chunks.push(JSON.parse(frame));}catch{} }
  if(wire==='openai') {
    const out:Obj={id:'chatcmpl-stream',object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:''},finish_reason:'stop'}],usage:{prompt_tokens:0,completion_tokens:0}};
    for(const c of chunks){const d=c.choices?.[0]?.delta||{}; const msg=out.choices[0].message;
      if(typeof d.content==='string')msg.content+=d.content;
      for(const tc of d.tool_calls||[]){let x=msg.tool_calls?.find((z:Obj)=>z.index===tc.index); if(!x){if(!msg.tool_calls)msg.tool_calls=[]; x={index:tc.index,id:'',type:'function',function:{name:'',arguments:''}};msg.tool_calls.push(x);} if(tc.id)x.id=tc.id;if(tc.function?.name)x.function.name+=tc.function.name;if(tc.function?.arguments)x.function.arguments+=tc.function.arguments;}
      if(c.choices?.[0]?.finish_reason)out.choices[0].finish_reason=c.choices[0].finish_reason;
      if(c.usage)out.usage={prompt_tokens:c.usage.prompt_tokens||0,completion_tokens:c.usage.completion_tokens||0};
    }
    for(const t of out.choices[0].message.tool_calls||[]) delete t.index;
    return out;
  }
  if(wire==='gemini') {
    const first=chunks.find(c=>c.candidates?.length)?.candidates?.[0]||{};
    const parts:any[]=[];
    for(const c of chunks) for(const p of c.candidates?.[0]?.content?.parts||[]) {
      const prior=p.text!==undefined?parts.find(x=>x.text!==undefined):undefined;
      if(prior)prior.text+=p.text; else parts.push({...p});
    }
    return {candidates:[{...first,content:{role:'model',parts},finishReason:chunks.map(c=>c.candidates?.[0]?.finishReason).filter(Boolean).at(-1)}],usageMetadata:chunks.map(c=>c.usageMetadata).filter(Boolean).at(-1)||{}};
  }
  if(wire==='anthropic') {
    let msg:Obj={id:'msg_stream',type:'message',role:'assistant',content:[],stop_reason:'end_turn',usage:{input_tokens:0,output_tokens:0}};
    for(const c of chunks) { const ev=c.event||c.type; const d=c.data||c;
      if(ev==='message_start'&&d.message)msg={...d.message,content:[]};
      if(ev==='content_block_start')msg.content[d.index]=d.content_block;
      if(ev==='content_block_delta') { const block=msg.content[d.index];if(d.delta?.type==='text_delta'&&block)block.text=(block.text||'')+d.delta.text;if(d.delta?.type==='input_json_delta'&&block)block.inputJson=(block.inputJson||'')+d.delta.partial_json; }
      if(ev==='message_delta'){msg.stop_reason=d.delta?.stop_reason||msg.stop_reason;msg.usage={...msg.usage,output_tokens:d.usage?.output_tokens||0};}
    }
    for(const b of msg.content||[])if(b.inputJson){b.input=parseArgs(b.inputJson);delete b.inputJson;}
    return msg;
  }
  return chunks.at(-1)||{};
}
function geminiAnswer(a:Obj, model:string):Obj {
  const c=a.candidates?.[0]||{}, parts=c.content?.parts||[]; let content='', calls:Obj[]=[];
  for(const p of parts){if(typeof p.text==='string')content+=p.text;if(p.functionCall)calls.push({id:`call_${calls.length}`,type:'function',function:{name:p.functionCall.name,arguments:JSON.stringify(p.functionCall.args||{})}});}
  const usage=a.usageMetadata||{};
  return {id:`gemini_${model}`,object:'chat.completion',model,choices:[{index:0,message:{role:'assistant',content:content||null,...(calls.length?{tool_calls:calls}:{})},finish_reason:c.finishReason==='MAX_TOKENS'?'length':calls.length?'tool_calls':'stop'}],usage:{prompt_tokens:usage.promptTokenCount||0,completion_tokens:usage.candidatesTokenCount||0}};
}
function anthropicAnswer(a:Obj, model:string):Obj {
  const content:string[]=[]; const calls:Obj[]=[];
  for(const block of a.content||[]) {if(block.type==='text')content.push(block.text);if(block.type==='tool_use')calls.push({id:block.id,type:'function',function:{name:block.name,arguments:JSON.stringify(block.input||{})}});}
  return {id:a.id||`msg_${model}`,model,choices:[{index:0,message:{role:'assistant',content:content.join('')||null,...(calls.length?{tool_calls:calls}:{})},finish_reason:a.stop_reason==='max_tokens'?'length':a.stop_reason==='tool_use'||calls.length?'tool_calls':a.stop_reason==='refusal'?'content_filter':'stop'}],usage:{prompt_tokens:a.usage?.input_tokens||0,completion_tokens:a.usage?.output_tokens||0}};
}
function anthropicNative(a:Obj, model:string):Obj {
  return a.type==='message' ? {...a,model} : toAnthropic(a,model);
}
function sse(name:string,data:unknown):string{return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;}
function anthropicStream(a:Obj,model:string):string {
  const msg=toAnthropic(a,model), out:string[]=[];
  out.push(sse('message_start',{type:'message_start',message:{...msg,content:[],stop_reason:null,usage:{input_tokens:msg.usage.input_tokens,output_tokens:0}}}));
  let i=0; for(const block of msg.content){out.push(sse('content_block_start',{type:'content_block_start',index:i,content_block:block.type==='text'?{type:'text',text:''}:{type:'tool_use',id:block.id,name:block.name,input:{}}}));
    if(block.type==='text')out.push(sse('content_block_delta',{type:'content_block_delta',index:i,delta:{type:'text_delta',text:block.text}}));
    else out.push(sse('content_block_delta',{type:'content_block_delta',index:i,delta:{type:'input_json_delta',partial_json:JSON.stringify(block.input)}}));
    out.push(sse('content_block_stop',{type:'content_block_stop',index:i++})); }
  out.push(sse('message_delta',{type:'message_delta',delta:{stop_reason:msg.stop_reason,stop_sequence:null},usage:{output_tokens:msg.usage.output_tokens}}),sse('message_stop',{type:'message_stop'})); return out.join('');
}
function json(res:any,status:number,value:unknown){const s=JSON.stringify(value);res.writeHead(status,{'content-type':'application/json','content-length':Buffer.byteLength(s)});res.end(s);}
function error(api:string,status:number,detail:string){return api==='anthropic'?{type:'error',error:{type:'api_error',message:detail}}:{error:{message:detail,type:'upstream_error',code:null}};}
let requestIndex=0, busy=false;
async function handle(req:any,res:any) {
  const path=new URL(req.url||'/', 'http://local').pathname;
  if(req.method==='GET'&&path==='/v1/models') {
    const ms=listModels(); if(req.headers['x-api-key'])return json(res,200,{data:ms.map(m=>({type:'model',id:m.id,display_name:m.display_name,created_at:'2026-01-01T00:00:00Z'})),has_more:false});
    return json(res,200,{object:'list',data:ms.map(m=>({id:m.id,object:'model',created:1767225600,owned_by:m.provider}))});
  }
  const api=path==='/v1/messages'?'anthropic':'openai';
  if(req.method!=='POST'||!['/v1/messages','/v1/chat/completions'].includes(path))return json(res,404,error(api,404,'route not found'));
  if(busy)return json(res,429,error(api,429,'concurrent request'));
  busy=true;
  try {
    const body=await readBody(req), entry=workload.manifest?.[requestIndex++], requires=entry?.requires||{};
    const picks=candidates(requires); if(!picks.length)return json(res,503,error(api,503,'no eligible free model'));
    const tried=new Set<string>(); let result:any=null, chosen:any=null;
    for(const pick of picks){const pid=pick.q.provider.id;if(tried.has(pid))continue;tried.add(pid);
      providerCalls.set(pid,(providerCalls.get(pid)||0)+1);
      try {const got=await upstream(pick.q.provider,pick.m,body,api); if(got.status===402||got.status===429||got.status>=500){result=got;continue;} if(got.status>=200&&got.status<300){result=got;chosen=pick;break;} result=got;} catch(e){result={status:502,raw:String(e)};}
    }
    if(!chosen)return json(res,result?.status||503,error(api,result?.status||503,result?.raw||'providers unavailable'));
    if(api==='anthropic') {
      const requested=typeof body.model==='string'?body.model:chosen.m.id;
      if(body.stream===true){const chat=result.body.type==='message'?anthropicAnswer(result.body,requested):result.body;res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache',connection:'keep-alive'});res.end(anthropicStream(chat,requested));}
      else json(res,200,anthropicNative(result.body,requested));
    } else if(body.stream===true) {
      // Re-emit assembled content in valid OpenAI chunks; usage is copied verbatim from the upstream answer.
      const a=result.body, c=a.choices?.[0]||{}, msg=c.message||{}, id=a.id||'chatcmpl-aggregated';
      res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache',connection:'keep-alive'});
      const chunk=(delta:Obj,finish:any=null,usage?:Obj)=>`data: ${JSON.stringify({id,object:'chat.completion.chunk',created:1767225600,model:chosen.m.id,choices:[{index:0,delta,finish_reason:finish}],...(usage?{usage}:{})})}\n\n`;
      res.write(chunk({role:'assistant'})); if(msg.content)res.write(chunk({content:msg.content}));
      for(const [i,t] of (msg.tool_calls||[]).entries())res.write(chunk({tool_calls:[{index:i,...t}]}));
      res.write(chunk({},c.finish_reason||'stop'));res.write(chunk({},null,a.usage||{prompt_tokens:0,completion_tokens:0}));res.end('data: [DONE]\n\n');
    } else json(res,200,result.body);
  } finally {busy=false;}
}

async function start(){
  probes=await Promise.all((directory.providers||[]).map(probe));
  catalog={providers:probes.map(q=>({id:q.provider.id,base_url:join(q.provider.base_url||q.provider.path),key_env:q.provider.key_env||'',wire:q.provider.wire,models:q.models.map((m:Obj)=>{const c=caps(q.provider,m);return {id:m.id,free:free(q.provider,m),context_length:c.context_length??null};})}))};
  if(process.argv.includes('--list')){process.stdout.write(catalogText()+'\n');return;}
  if(!env)throw new Error('MAKEFUN_ENV_URL is missing');
  const server=createServer((req,res)=>{void handle(req,res).catch(e=>{if(!res.headersSent)json(res,500,error(req.url?.includes('messages')?'anthropic':'openai',500,String(e)));});});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'0.0.0.0',resolve);});
  const addr=server.address();if(!addr||typeof addr==='string')throw new Error('no listener port');
  const reg=await fetch(`${env}/register`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({protocol_version:1,port:addr.port,catalog})});
  if(!reg.ok)throw new Error(`registration failed: ${reg.status}`);
  const timer=setInterval(()=>{void fetch(`${env}/work`).then(r=>r.json()).then(w=>{if(w.done){clearInterval(timer);server.close();process.exit(0);}}).catch(()=>{});},100);
}
start().catch(e=>{process.stderr.write(`${String(e)}\n`);process.exit(1);});
