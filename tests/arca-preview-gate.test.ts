import {describe,it,expect} from 'vitest';
import {arcaHomoBuildEligible,arcaHomoRuntimeEligible,ARCA_HOMO_BRANCH,arcaHomoLocalEligible,localHomoRequestAllowed} from '@/lib/arca-padron/preview-gate';
const now=Date.parse('2026-10-28T18:00:00Z');
const env={CONTEXT:'deploy-preview',HEAD:ARCA_HOMO_BRANCH,ARCA_HOMO_PREVIEW:'1',ARCA_PADRON_ENV:'homologacion',ARCA_HOMO_HASTA:'2026-10-29T18:00:00Z',DATABASE_URL:'postgresql://postgres:ficticia@db.esyfpakajthdifhnhcew.supabase.co:5432/postgres',NEXT_PUBLIC_SUPABASE_URL:'https://esyfpakajthdifhnhcew.supabase.co'};
describe('ARCA web sólo Preview y DEV',()=>{
 it('el build exige Preview y rama exacta',()=>{
 expect(arcaHomoBuildEligible(env)).toBe(true);expect(arcaHomoBuildEligible({...env,CONTEXT:'production'})).toBe(false);expect(arcaHomoBuildEligible({...env,HEAD:'main'})).toBe(false);expect(arcaHomoBuildEligible({})).toBe(false);
 });
 it('permite la ventana explícita con DEV',()=>expect(arcaHomoRuntimeEligible(env,'1',now)).toBe(true));
 it('sin marca de build no habilita aunque tenga secretos',()=>expect(arcaHomoRuntimeEligible(env,'0',now)).toBe(false));
 it.each([
 ['CONTEXT','production'],['HEAD','otra'],['ARCA_HOMO_PREVIEW',''],['ARCA_PADRON_ENV','produccion'],['ARCA_HOMO_HASTA','2026-10-28T17:00:00Z'],['ARCA_HOMO_HASTA','2027-01-01T00:00:00Z'],['ARCA_HOMO_HASTA','2026-10-29T18:00:00'],['DATABASE_URL','postgresql://postgres:x@db.bqqruaikbqculvmtirvy.supabase.co/postgres'],['DATABASE_URL','postgresql://postgres:x@evil.test/postgres'],['NEXT_PUBLIC_SUPABASE_URL','https://bqqruaikbqculvmtirvy.supabase.co'],['NEXT_PUBLIC_SUPABASE_URL','https://esyfpakajthdifhnhcew.supabase.co/?x=1'],['DIRECT_URL','postgresql://postgres:x@db.bqqruaikbqculvmtirvy.supabase.co/postgres'],
 ])('rechaza %s contradictorio', (key,value)=>expect(arcaHomoRuntimeEligible({...env,[key]:value},'1',now)).toBe(false));
 it('runtime admite ausencia de metadatos sólo con marca del build',()=>{
 const e={...env,CONTEXT:undefined,HEAD:undefined};expect(arcaHomoRuntimeEligible(e,'1',now)).toBe(true);expect(arcaHomoRuntimeEligible(e,undefined,now)).toBe(false);
 });
});

describe('homologación local separada de Netlify',()=>{
 const local={...env,NODE_ENV:'development',CONTEXT:undefined,HEAD:undefined,ARCA_LOCAL_HOMO:'1',ARCA_LOCAL_BIND:'127.0.0.1:3217'};
 it('habilita sólo desarrollo local explícito con DEV y caducidad',()=>{
 expect(arcaHomoLocalEligible(local)).toBe(true);expect(arcaHomoBuildEligible(local)).toBe(false);
 expect(arcaHomoRuntimeEligible(local,'1',now)).toBe(true);
 expect(arcaHomoRuntimeEligible(local,'0',now)).toBe(false);
 });
 it.each([{NODE_ENV:'production'},{CONTEXT:'deploy-preview'},{NETLIFY:'true'},{SITE_ID:'sitio'},{HEAD:'main'},{ARCA_LOCAL_BIND:'0.0.0.0:3217'},{DATABASE_URL:'postgresql://postgres:x@db.bqqruaikbqculvmtirvy.supabase.co/postgres'},{ARCA_HOMO_HASTA:'2026-10-28T17:00:00Z'}])('niega mezcla remota/producción/destino/fecha %j',change=>expect(arcaHomoRuntimeEligible({...local,...change},'1',now)).toBe(false));
 it.each(['POST','PATCH','DELETE','PUT'])('bloquea %s a clientes y acciones de página',method=>{
 expect(localHomoRequestAllowed(method,'/api/clients','127.0.0.1:3217')).toBe(false);
 expect(localHomoRequestAllowed(method,'/clients/new','127.0.0.1:3217')).toBe(false);
 });
 it('permite sólo lookup POST y lecturas, siempre con host local exacto',()=>{
 expect(localHomoRequestAllowed('POST','/api/arca/cuit-lookup','127.0.0.1:3217')).toBe(true);
 expect(localHomoRequestAllowed('GET','/clients/new','127.0.0.1:3217')).toBe(true);
 expect(localHomoRequestAllowed('POST','/api/arca/cuit-lookup','evil.test')).toBe(false);
 });
});
