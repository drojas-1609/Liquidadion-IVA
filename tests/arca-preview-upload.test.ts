import {createHash} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {buildPayload,effectiveValue,checkDestinations,KEYS,BRANCH,tokenFromCliConfig,validateDestinationProof,safePrecheckError,SITE_ID,proofFromFileIndex} from '../scripts/arca/configure-preview.mjs';
const db='postgresql://postgres:x@db.esyfpakajthdifhnhcew.supabase.co:5432/postgres';
const vars=[{key:'DATABASE_URL',values:[{context:'deploy-preview',value:db},{context:'production',value:'PROD'}]},{key:'NEXT_PUBLIC_SUPABASE_URL',values:[{context:'deploy-preview',value:'https://esyfpakajthdifhnhcew.supabase.co'}]}];
describe('carga Netlify acotada',()=>{
 it('nueve claves, sólo functions y rama exacta, sin contexto de producción',()=>{
  const p=buildPayload(Object.fromEntries(KEYS.map((k:string)=>[k,'SINTETICO'])));
  expect(p).toHaveLength(9);for(const v of p){expect(v.scopes).toEqual(['functions']);expect(v.is_secret).toBe(true);expect(v.values).toEqual([{context:'branch',context_parameter:BRANCH,value:'SINTETICO'}]);}
 });
 it('valores incompletos no producen payload',()=>expect(()=>buildPayload({})).toThrow());
 it('no toma producción como fallback y respeta el override de rama',()=>{
  expect(effectiveValue(vars,'DATABASE_URL')).toBe(db);
  expect(()=>checkDestinations(vars)).not.toThrow();
  expect(()=>checkDestinations([...vars,{key:'DIRECT_URL',values:[{context:'branch',context_parameter:BRANCH,value:'postgresql://postgres:x@db.bqqruaikbqculvmtirvy.supabase.co/postgres'}]}])).toThrow();
 });
 it('no sobrescribe namespace ARCA existente',()=>expect(()=>checkDestinations([...vars,{key:'ARCA_WSAA_CERT_PEM',values:[]}])).toThrow());
});

describe('credencial CLI existente',()=>{
 it('sólo selecciona el token del usuario activo',()=>{
 expect(tokenFromCliConfig({userId:'a',users:{a:{auth:{token:'SINTETICO'}},b:{auth:{token:'OTRO'}}}})).toBe('SINTETICO');
 expect(tokenFromCliConfig({userId:'c',users:{b:{auth:{token:'OTRO'}}}})).toBeNull();
 expect(tokenFromCliConfig({})).toBeNull();
 });
});

describe('constancia del destino sin revelar variables secretas',()=>{
 const now=Date.parse('2026-10-28T18:00:00Z'), head='a'.repeat(40);
 const deploy={site_id:SITE_ID,branch:BRANCH,context:'deploy-preview',review_id:20,state:'ready',commit_ref:head,created_at:'2026-10-28T17:00:00Z'};
 const proof={version:1,commit:head,branch:BRANCH,dev:true};
 const secretVars=['DATABASE_URL','DIRECT_URL','NEXT_PUBLIC_SUPABASE_URL'].map(key=>({key,is_secret:true,scopes:['builds','functions'],updated_at:'2026-10-28T16:00:00Z',values:[{context:'deploy-preview',value:'valor-enmascarado'}]}));
 it('acepta sólo prueba DEV de build posterior a las variables',()=>expect(validateDestinationProof(secretVars,deploy,proof,head,now)).toBe(true));
 it.each([{site_id:'otro'},{branch:'main'},{context:'production'},{review_id:19},{state:'building'},{commit_ref:'b'.repeat(40)},{created_at:'invalid'},{created_at:'2026-10-26T17:00:00Z'},{created_at:'2026-10-29T17:00:00Z'}])('rechaza identidad/estado/edad %j',change=>expect(()=>validateDestinationProof(secretVars,{...deploy,...change},proof,head,now)).toThrow());
 it.each([{dev:false},{version:2},{commit:'b'.repeat(40)},{branch:'main'}])('rechaza constancia contradictoria %j',change=>expect(()=>validateDestinationProof(secretVars,deploy,{...proof,...change},head,now)).toThrow());
 it.each([{updated_at:'2026-10-28T17:01:00Z'},{updated_at:'invalid'},{scopes:['functions']},{scopes:['builds']},{values:[]}])('rechaza configuración sin prueba vigente %j',change=>expect(()=>validateDestinationProof([{...secretVars[0],...change},...secretVars.slice(1)],deploy,proof,head,now)).toThrow());
 it('sin constancia no interpreta un secreto enmascarado como DEV',()=>expect(()=>checkDestinations(secretVars)).toThrow('NETLIFY_DATABASE_NO_DEV'));
 it('sólo comunica códigos conocidos, nunca errores internos con secretos',()=>{
 expect(safePrecheckError(Error('NETLIFY_DATABASE_NO_DEV'))).toBe('NETLIFY_DATABASE_NO_DEV');
 expect(safePrecheckError(Error('API_NETLIFY_403'))).toBe('API_NETLIFY_403');
 expect(safePrecheckError(Error('postgresql://usuario:secreto@host'))).toBe('PRECHECK_NO_COMPLETADO');
 });
});

describe('índice autenticado de archivos del deploy',()=>{
 const head='a'.repeat(40),deploy={id:'deploy-sintetico'};
 const body=JSON.stringify({version:1,commit:head,branch:BRANCH,dev:true});
 const file={path:'/.well-known/arca-preview-destination.json',site_id:SITE_ID,deploy_id:deploy.id,size:Buffer.byteLength(body),sha:createHash('sha1').update(body).digest('hex')};
 it('acredita el contenido exacto sin descargar el sitio protegido',()=>expect(proofFromFileIndex([file],deploy,head).dev).toBe(true));
 it.each([{sha:'0'.repeat(40)},{size:0},{site_id:'otro'},{deploy_id:'otro'},{path:'/otro.json'}])('rechaza índice incorrecto %j',change=>expect(()=>proofFromFileIndex([{...file,...change}],deploy,head)).toThrow());
});
