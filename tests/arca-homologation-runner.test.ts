import {describe,it,expect,vi} from 'vitest';
import {devUrl,safeResult,checkNetwork,HOMO} from '../scripts/arca/homologation-runner';
describe('runner de homologación: guardas y salida sin datos personales',()=>{
 it.each([
 ['postgresql://postgres:ficticia@db.esyfpakajthdifhnhcew.supabase.co:5432/postgres',true],
 ['postgresql://postgres.esyfpakajthdifhnhcew:ficticia@aws-0-sa-east-1.pooler.supabase.com:5432/postgres',true],
 ['postgresql://postgres:ficticia@db.bqqruaikbqculvmtirvy.supabase.co:5432/postgres',false],
 ['postgresql://postgres.esyfpakajthdifhnhcew:ficticia@aws-0-sa-east-1.pooler.supabase.com:6543/postgres',false],
 ['postgresql://postgres:ficticia@evil.test:5432/postgres',false],
 ['postgresql://postgres:ficticia@db.esyfpakajthdifhnhcew.supabase.co:5432/otra',false],
 ['postgresql://postgres:ficticia@db.esyfpakajthdifhnhcew.supabase.co:5432/postgres?host=evil',false],
 ['postgresql://postgres@db.esyfpakajthdifhnhcew.supabase.co:5432/postgres',false],
 ['postgresql://postgres:ficticia@no@db.esyfpakajthdifhnhcew.supabase.co:5432/postgres',false],
 ])('destino %s', (url,ok)=>expect(devUrl(url)).toBe(ok));
 it('no incluye datos de la persona ni textos de errores en el resumen',()=>{
  expect(safeResult({status:'NOT_FOUND',cuit:'SINTETICO'})).toEqual({status:'NOT_FOUND'});
  expect(safeResult({status:'ERROR',code:'AUTH'})).toEqual({status:'ERROR',code:'AUTH'});
 });
 it('verifica los dos WSDL con validación normal y sin redirecciones',async()=>{
  const fetchImpl=vi.fn(async(url)=>new Response(`<soap:address location="${String(url).replace('?WSDL','')}"/>`)) as unknown as typeof fetch;
  await checkNetwork(fetchImpl);expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(fetchImpl).toHaveBeenCalledWith(HOMO.wsaa+'?WSDL',expect.objectContaining({redirect:'error'}));
 });
 it('un WSDL con otro destino detiene antes de pedir credenciales',async()=>{
  const f=vi.fn(async()=>new Response('<soap:address location="https://evil.test"/>')) as unknown as typeof fetch;
  await expect(checkNetwork(f)).rejects.toThrow('WSDL_NO_COINCIDE');expect(f).toHaveBeenCalledTimes(1);
 });
 it('no cambia de host como respuesta a un fallo TLS',async()=>{
  const f=vi.fn(async()=>{throw Error('TLS');}) as unknown as typeof fetch;
  await expect(checkNetwork(f)).rejects.toThrow('TLS');expect(f).toHaveBeenCalledTimes(1);
 });
});
