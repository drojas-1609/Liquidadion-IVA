import {describe,it,expect} from 'vitest';
import {arcaHomoBuildEligible,arcaHomoRuntimeEligible,ARCA_HOMO_BRANCH} from '@/lib/arca-padron/preview-gate';
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
