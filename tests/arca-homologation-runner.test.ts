import {describe,it,expect,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {devUrl,safeResult,checkNetwork,HOMO,queryTarget,canRepeat,MANUAL_EXAMPLE_CUIT,superviseServer} from '../scripts/arca/homologation-runner';
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

describe('ejemplo público de homologación',()=>{
 it('permite sólo titular o el ejemplo fijo del manual; no CUIT arbitrario',()=>{
  expect(queryTarget('TITULAR',[]).cuit).toBe('TITULAR');
  expect(queryTarget('TITULAR',['--example'])).toMatchObject({cuit:MANUAL_EXAMPLE_CUIT,example:true});
  expect(()=>queryTarget('TITULAR',['--example','otro'])).toThrow();
  expect(()=>queryTarget('TITULAR',['--cuit','30999999170'])).toThrow();
 });
 it('se detiene si el ejemplo no existe y no altera la regla del caso titular',()=>{
  const missing={status:'NOT_FOUND' as const,cuit:MANUAL_EXAMPLE_CUIT};
  expect(canRepeat(missing,true)).toBe(false);expect(canRepeat(missing,false)).toBe(true);
  expect(canRepeat({status:'ERROR',code:'AUTH'},true)).toBe(false);
 });
});

describe('cierre del servidor web local',()=>{
 const fake=()=>{const child=Object.assign(new EventEmitter(),{kill:vi.fn(()=>true)});return child;};
 it('Ctrl+C repetido cierra una vez y mantiene las señales atendidas hasta release',async()=>{
 const child=fake(),notice=vi.fn(),before=process.listenerCount('SIGINT');
 const server=superviseServer(child as never,{maxMs:60000,graceMs:60000,notice});
 process.emit('SIGINT');process.emit('SIGINT');
 expect(child.kill).toHaveBeenCalledTimes(1);expect(child.kill).toHaveBeenCalledWith('SIGTERM');
 expect(notice).toHaveBeenNthCalledWith(1,expect.stringContaining('esperá el RESULT'));expect(notice).toHaveBeenNthCalledWith(2,expect.stringContaining('Ya se está cerrando'));
 child.emit('exit',0);await server.done;expect(server.exited()).toBe(true);
 process.emit('SIGINT');expect(child.kill).toHaveBeenCalledTimes(1);
 expect(process.listenerCount('SIGINT')).toBe(before+1);
 server.release();expect(process.listenerCount('SIGINT')).toBe(before);
 });
 it('fuerza SIGKILL si Next no termina dentro de la gracia y respeta el máximo',()=>{
 vi.useFakeTimers();try{
 const child=fake(),server=superviseServer(child as never,{maxMs:1000,graceMs:500,notice:()=>{}});
 vi.advanceTimersByTime(999);expect(child.kill).not.toHaveBeenCalled();
 vi.advanceTimersByTime(1);expect(child.kill).toHaveBeenLastCalledWith('SIGTERM');
 vi.advanceTimersByTime(500);expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
 server.release();
 }finally{vi.useRealTimers();}
 });
 it('no mata un proceso ya terminado y rechaza sin detalle si no inicia',async()=>{
 const ok=fake(),a=superviseServer(ok as never,{maxMs:60000,graceMs:10,notice:()=>{}});ok.emit('exit',1);await a.done;a.stop();expect(ok.kill).not.toHaveBeenCalled();a.release();
 const bad=fake(),b=superviseServer(bad as never,{maxMs:60000,graceMs:10,notice:()=>{}});bad.emit('error',Error('detalle interno'));await expect(b.done).rejects.toThrow(/^SERVIDOR_LOCAL$/);b.release();
 });
});
