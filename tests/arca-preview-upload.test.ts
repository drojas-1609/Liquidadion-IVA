import {describe,it,expect} from 'vitest';
import {buildPayload,effectiveValue,checkDestinations,KEYS,BRANCH} from '../scripts/arca/configure-preview.mjs';
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
