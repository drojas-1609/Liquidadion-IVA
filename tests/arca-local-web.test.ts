import {describe,it,expect,vi,afterEach} from 'vitest';
import {NextRequest,NextResponse} from 'next/server';
import {withApiAuthz} from '@/lib/auth/authz';
import {proxy} from '@/proxy';
vi.mock('@/lib/supabase/proxy-session',()=>({resolveProxySession:vi.fn(async()=>{throw Error('no debe consultar sesión para una escritura bloqueada');})}));
afterEach(()=>vi.unstubAllEnvs());
describe('barrera real de escrituras del ensayo local',()=>{
 it.each(['POST','PATCH','DELETE'])('API %s no invoca el handler ni persiste',async method=>{
 vi.stubEnv('ARCA_LOCAL_HOMO','1');const handler=vi.fn(async()=>NextResponse.json({ok:true}));
 const response=await withApiAuthz(handler)(new Request('http://127.0.0.1:3217/api/clients',{method}));
 expect(response.status).toBe(403);expect(handler).not.toHaveBeenCalled();expect((await response.json()).error.code).toBe('LOCAL_HOMO_READ_ONLY');
 });
 it('proxy bloquea Server Actions sobre páginas protegidas',async()=>{
 vi.stubEnv('ARCA_LOCAL_HOMO','1');const response=await proxy(new NextRequest('http://127.0.0.1:3217/clients/new',{method:'POST',headers:{host:'127.0.0.1:3217'}}));
 expect(response.status).toBe(403);
 });
 it('bloquea también exportaciones GET que escriben auditoría',async()=>{
 vi.stubEnv('ARCA_LOCAL_HOMO','1');const handler=vi.fn(async()=>NextResponse.json({ok:true}));
 const response=await withApiAuthz(handler)(new Request('http://127.0.0.1:3217/api/client/sintetico/period/sintetico/export'));
 expect(response.status).toBe(403);expect(handler).not.toHaveBeenCalled();
 });
 it('acepta lectura con Host local aunque Next normalice la URL interna',async()=>{
 vi.stubEnv('ARCA_LOCAL_HOMO','1');const handler=vi.fn(async()=>NextResponse.json({ok:true}));
 const response=await withApiAuthz(handler)(new Request('http://localhost:3217/api/activity-catalogs',{headers:{host:'127.0.0.1:3217'}}));
 expect(response.status).toBe(200);expect(handler).toHaveBeenCalledOnce();
 });
 it('sin modo local conserva el handler normal',async()=>{
 vi.stubEnv('ARCA_LOCAL_HOMO','');const handler=vi.fn(async()=>NextResponse.json({ok:true}));
 const response=await withApiAuthz(handler)(new Request('http://localhost/api/clients',{method:'POST'}));expect(response.status).toBe(200);expect(handler).toHaveBeenCalledOnce();
 });
});
