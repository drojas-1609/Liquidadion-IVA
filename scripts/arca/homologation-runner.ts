import {spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {PrismaClient} from '@prisma/client';
import {X509Certificate,randomBytes} from 'node:crypto';
import {readFile,lstat,realpath,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve,join,sep} from 'node:path';
import {createInterface} from 'node:readline/promises';
import {readArcaConfig} from '../../lib/arca-padron/config';
import {lookupCuit,ARCA_TIMEOUT_MS,type CuitLookupResult} from '../../lib/arca-padron/service';
import {postgresTicketStore,parseCacheKey} from '../../lib/arca-padron/ticket-store';
import {PADRON_ENDPOINTS} from '../../lib/arca-padron/padron';
import {WSAA_ENDPOINTS} from '../../lib/arca-padron/wsaa';

const DEV='esyfpakajthdifhnhcew',PROD='bqqruaikbqculvmtirvy';
const MIGRATION='20261028120000_arca_wsaa_ticket_cache';
const SHA='a5c214cc74826994411c44953983addda81e88e4076a742a33db437609ec743d';
const FP='37460066024602df4109ae1e6996a1d2315b8ce0da52e25f6188cf493511c9de';
export const HOMO={wsaa:'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',padron:'https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5'};
// Ejemplo público getPersona_v2, manual oficial v4.1, páginas impresas9–12.
// Es un caso documentado; no garantiza disponibilidad actual en homologación.
export const MANUAL_EXAMPLE_CUIT='20164755100';
export function queryTarget(ownCuit:string,args:readonly string[]){
 if(args.length===0)return {cuit:ownCuit,example:false,phrase:'PROBAR-ARCA-HOMO-DEV'};
 if(args.length===1&&args[0]==='--example')return {cuit:MANUAL_EXAMPLE_CUIT,example:true,phrase:'PROBAR-EJEMPLO-ARCA-HOMO-DEV'};
 throw Error('ARGUMENTOS_NO_ADMITIDOS');
}
export function canRepeat(result:CuitLookupResult,example:boolean){return result.status==='FOUND'||(!example&&result.status==='NOT_FOUND');}
export function devUrl(raw:string):boolean{
 try{const u=new URL(raw);if(raw.includes(PROD)||raw.split('@').length!==2||/\s/.test(raw)||!['postgres:','postgresql:'].includes(u.protocol)||!u.password||u.search||u.hash||u.pathname!=='/postgres'||(u.port&&u.port!=='5432'))return false;
 return(u.hostname===`db.${DEV}.supabase.co`&&decodeURIComponent(u.username)==='postgres')||(u.hostname.endsWith('.pooler.supabase.com')&&decodeURIComponent(u.username)===`postgres.${DEV}`);
 }catch{return false;}
}
export function safeResult(result:CuitLookupResult){
 if(result.status==='FOUND')return {status:'FOUND',nombre_disponible:Boolean(result.person.name),domicilio_disponible:Boolean(result.person.fiscalAddress?.street),actividades:result.person.activities.length,impuestos:result.person.taxes.length};
 return result.status==='ERROR'?{status:'ERROR',code:result.code}:{status:result.status};
}
async function hidden(label:string):Promise<string>{
 if(!process.stdin.isTTY)throw Error('TERMINAL_INTERACTIVA');
 process.stdout.write(label);process.stdin.setRawMode(true);process.stdin.resume();
 return new Promise((resolve,reject)=>{let value='';const finish=()=>{process.stdin.off('data',data);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');};const data=(chunk:Buffer)=>{for(const c of chunk.toString()){if(c==='\u0003'){finish();reject(Error('CANCELADO'));return;}if(c==='\r'||c==='\n'){finish();resolve(value);return;}if(c==='\u007f')value=value.slice(0,-1);else if(c>=' ')value+=c;}};process.stdin.on('data',data);});
}
async function ask(label:string){
 // Sin oyente, readline sólo pausa ante Ctrl+C y la pregunta quedaría pendiente.
 const r=createInterface({input:process.stdin,output:process.stdout}),abort=new AbortController();r.once('SIGINT',()=>abort.abort());
 try{return await r.question(label,{signal:abort.signal});}catch(error){if(abort.signal.aborted)throw Error('CANCELADO');throw error;}finally{r.close();}
}
export async function checkNetwork(fetchImpl:typeof fetch=fetch){
 for(const address of [HOMO.wsaa,HOMO.padron]){
  const response=await fetchImpl(address+'?WSDL',{redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!response.ok||Number(response.headers.get('content-length'))>1000000)throw Error('WSDL_NO_DISPONIBLE');
  const text=await response.text();if(text.length>1000000||!text.includes('location="'+address+'"'))throw Error('WSDL_NO_COINCIDE');
 }
}
async function snapshot(db:PrismaClient){
 const rows=await db.$queryRaw<Array<{state:unknown}>>`SELECT json_build_object('client',(SELECT count(*) FROM "Client"),'period',(SELECT count(*) FROM "Period"),'invoice',(SELECT count(*) FROM "Invoice"),'tax_record',(SELECT count(*) FROM "TaxRecord"),'audit',(SELECT count(*) FROM "AuditLog"),'jurisdiction',(SELECT count(*) FROM "ClientJurisdiction"),'activity',(SELECT count(*) FROM "ClientActivity"),'rate',(SELECT count(*) FROM "ClientActivityRate"),'client_updated',(SELECT max("updatedAt")::text FROM "Client")) AS state`;
 return JSON.stringify(rows[0].state);
}
async function precheck(db:PrismaClient){
 await db.$transaction(async tx=>{
  await tx.$executeRaw`SET TRANSACTION READ ONLY`;
  const m=await tx.$queryRaw<Array<{migration_name:string;checksum:string;finished:boolean;bad:boolean}>>`SELECT migration_name,checksum,finished_at IS NOT NULL AS finished,(rolled_back_at IS NOT NULL OR logs IS NOT NULL) AS bad FROM "_prisma_migrations" ORDER BY migration_name`;
  if(m.length!==10||m.some(x=>!x.finished||x.bad)||!m.some(x=>x.migration_name===MIGRATION&&x.checksum===SHA))throw Error('MIGRACIONES_DEV');
  const f=await tx.$queryRaw<Array<{fingerprint:string}>>`SELECT encode(sha256(convert_to(string_agg(id||':'||migration_name||':'||checksum,'|' ORDER BY migration_name),'UTF8')),'hex') AS fingerprint FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  if(f[0]?.fingerprint!==FP)throw Error('HUELLA_DEV');
  const t=await tx.$queryRaw<Array<{owner:string;rls:boolean;grants:bigint;policies:bigint;check_ok:boolean}>>`SELECT pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity AS rls,(SELECT count(*) FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner) AS grants,(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid) AS policies,EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid=c.oid AND k.conname='ArcaWsaaTicket_payload_check' AND k.convalidated AND pg_get_constraintdef(k.oid)='CHECK (((ciphertext IS NULL) = ("expiresAt" IS NULL)))') AS check_ok FROM pg_class c WHERE c.oid='"ArcaWsaaTicket"'::regclass`;
  if(t.length!==1||t[0].owner!=='postgres'||!t[0].rls||t[0].grants!==BigInt(0)||t[0].policies!==BigInt(0)||!t[0].check_ok)throw Error('PERMISOS_TABLA');
 },{timeout:10000});
}
async function publicKeyFromNetlify(){
 const file=join(homedir(),process.platform==='darwin'?'Library/Preferences/netlify/config.json':'.config/netlify/config.json');
 const st=await lstat(file);if(!st.isFile()||st.isSymbolicLink()||st.size>1000000||(st.mode&0o077)!==0||(process.getuid&&st.uid!==process.getuid()))throw Error('NETLIFY_PUBLIC_CONFIG');
 const cli=JSON.parse(await readFile(file,'utf8'));const token=cli.users?.[cli.userId]?.auth?.token;if(typeof token!=='string'||!token)throw Error('NETLIFY_PUBLIC_CONFIG');
 const response=await fetch('https://api.netlify.com/api/v1/accounts/6a8b6265db143e978f06992f/env?site_id=d017ec41-acf9-4334-9c65-7d7e23045359',{headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(20000)});
 if(!response.ok)throw Error('NETLIFY_PUBLIC_CONFIG');const vars=await response.json();
 const effective=(key:string)=>{const v=vars.find((x:{key:string})=>x.key===key);if(v?.is_secret)throw Error('NETLIFY_PUBLIC_CONFIG');return(v?.values?.find((x:{context:string;context_parameter?:string})=>x.context==='branch'&&x.context_parameter==='codex/arca-homologacion-segura')??v?.values?.find((x:{context:string})=>x.context==='deploy-preview')??v?.values?.find((x:{context:string})=>x.context==='all'))?.value;};
 if(effective('NEXT_PUBLIC_SUPABASE_URL')!==`https://${DEV}.supabase.co`)throw Error('NETLIFY_PUBLIC_CONFIG');
 const key=effective('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');if(typeof key!=='string'||!key.startsWith('sb_publishable_'))throw Error('NETLIFY_PUBLIC_CONFIG');return key;
}
// Ctrl+C llega a todo el grupo de procesos (lanzador, runner y Next). El runner sigue
// atendiendo SIGINT/SIGTERM hasta release(): así compara conteos e informa RESULT
// antes de que la terminal recupere el prompt, aunque se repita Ctrl+C.
export function superviseServer(child:Pick<ChildProcess,'kill'|'once'>,{maxMs,graceMs,notice}:{maxMs:number;graceMs:number;notice:(message:string)=>void}){
 let exited=false,closing=false,force:NodeJS.Timeout|undefined;
 const done=new Promise<void>((ok,no)=>{child.once('error',()=>no(Error('SERVIDOR_LOCAL')));child.once('exit',()=>{exited=true;clearTimeout(force);ok();});});
 done.catch(()=>{});
 const stop=()=>{if(exited||closing)return;closing=true;child.kill('SIGTERM');force=setTimeout(()=>{if(!exited)child.kill('SIGKILL');},graceMs);};
 const interrupt=()=>{notice(closing||exited?'Ya se está cerrando; esperá el RESULT.':'Cerrando el servidor local y comparando conteos de DEV; esperá el RESULT.');stop();};
 const timer=setTimeout(interrupt,maxMs);
 process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
 return{done,stop,exited:()=>exited,release(){clearTimeout(timer);clearTimeout(force);process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);}};
}
async function localWeb(repo:string,env:NodeJS.ProcessEnv,after:()=>Promise<void>){
 let server:ReturnType<typeof superviseServer>|undefined;
 try{
 // No se admiten .env locales: Next podría cargar destinos o credenciales ajenos al ensayo.
 for(const name of ['.env','.env.local','.env.development','.env.development.local']){try{await lstat(join(repo,name));throw Error('ENV_LOCAL_PRESENTE');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
 await new Promise<void>((ok,no)=>{const probe=createServer();probe.once('error',()=>no(Error('PUERTO_LOCAL_OCUPADO')));probe.listen(3217,'127.0.0.1',()=>probe.close(()=>ok()));});
 const child=spawn(process.execPath,[join(repo,'node_modules/next/dist/bin/next'),'dev','--hostname','127.0.0.1','--port','3217'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
 // Se descartan logs internos; nunca se imprimen errores que puedan contener material.
 child.stdout?.resume();child.stderr?.resume();
 server=superviseServer(child,{maxMs:30*60000,graceMs:10000,notice:m=>console.log(m)});
 try{
  let ready=false;for(let i=0;i<90&&!server.exited();i++){
   try{const r=await fetch('http://127.0.0.1:3217/login',{redirect:'manual',signal:AbortSignal.timeout(1000)});if(r.status===200){ready=true;break;}}catch{}
   await new Promise(r=>setTimeout(r,1000));
  }
  if(!ready)throw Error('SERVIDOR_LOCAL');
  console.log('LOCAL LISTO: http://127.0.0.1:3217/clients/new');
  console.log('Ingresá con tu usuario de DEV. Sólo titular y ejemplo 20164755100. Guardar está bloqueado. Ctrl+C para terminar; máximo30min.');
  await server.done;
 }finally{server.stop();await server.done.catch(()=>{});}
 await after();
 }finally{server?.release();}
}
async function main(){
 const [repo,folder,...args]=process.argv.slice(2);
 if(folder==='--check-network'){await checkNetwork();console.log('WSDL oficiales de homologación: HTTPS válido y direcciones coincidentes.');return;}
 if(folder==='--selftest-prompts'){
  const one=await hidden('Prueba oculta 1: '),two=await hidden('Prueba oculta 2: ');
  if(one!=='SINTETICO-UNO'||two!=='SINTETICO-DOS')throw Error('SELFTEST');
  console.log('Prompts ocultos: OK. Sin conexiones.');return;
 }
 if(folder==='--selftest'){
  if(!devUrl(`postgresql://postgres:ficticia@db.${DEV}.supabase.co:5432/postgres`)||devUrl(`postgresql://postgres:ficticia@db.${PROD}.supabase.co:5432/postgres`))throw Error('SELFTEST');
  console.log('Runner local: compilación y guardas básicas OK; sin conexiones.');return;
 }
 for(const key of Object.keys(process.env))if(key==='DATABASE_URL'||key==='DIRECT_URL'||key.startsWith('PG')||key.startsWith('ARCA_'))throw Error('ENTORNO_NO_LIMPIO');
 if(!folder)throw Error('FALTA_CARPETA_CERTIFICADO');
 const base=await realpath(join(homedir(),'.tax-liquidator-arca')),dir=await realpath(resolve(folder));
 if(!dir.startsWith(base+sep)||!process.stdin.isTTY)throw Error('CARPETA_O_TERMINAL');
 const folderStat=await lstat(dir);if((folderStat.mode&0o077)!==0)throw Error('CARPETA_NO_PRIVADA');
 const certPath=join(dir,'certificado.pem'),keyPath=join(dir,'privada-cifrada.key');
 for(const path of [certPath,keyPath]){const st=await lstat(path);if(!st.isFile()||st.isSymbolicLink()||st.size>65536)throw Error('ARCHIVO_NO_ADMITIDO');}
 if(((await lstat(keyPath)).mode&0o077)!==0)throw Error('CLAVE_NO_PRIVADA');
 const certPem=await readFile(certPath,'utf8'),cert=new X509Certificate(certPem);
 const cuit=cert.subject.match(/serialNumber\s*=\s*CUIT\s*(\d{11})/i)?.[1];if(!cuit)throw Error('CUIT_CERTIFICADO');
 const web=args.length===1&&args[0]==='--web';
 const target=queryTarget(cuit,web?[]:args);
 await checkNetwork(); // Ningún dato privado antes de comprobar TLS y WSDL.
 console.log(web?'Prueba web local de homologación, sin consultas automáticas ni guardado de clientes.':target.example?'Sólo homologación: ejemplo público 20164755100 del manual oficial v4.1. No se garantiza que siga cargado.':'Sólo homologación: dos consultas del CUIT titular para comprobar la caché compartida.');
 console.log('Se usará DEV; únicamente la tabla técnica de tickets puede recibir escrituras.');
 const url=await hidden('URL de conexión DEV (sesión :5432 o directa; no se muestra): ');if(!devUrl(url))throw Error('URL_DEV_RECHAZADA');
 const password=await hidden('Contraseña LOCAL de la clave privada (no se muestra): ');
 const keyPem=await readFile(keyPath,'utf8');if(!keyPem.startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----'))throw Error('CLAVE_SIN_CIFRAR');
 const cachePath=join(dir,'wsaa-cache-dev.secret');let cacheKey:string;
 try{const st=await lstat(cachePath);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)!==0)throw Error('CACHE_NO_PRIVADA');cacheKey=(await readFile(cachePath,'utf8')).trim();}
 catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;if(target.example||web)throw Error('CACHE_FALTANTE_NO_RECREAR');cacheKey=randomBytes(32).toString('base64');await writeFile(cachePath,cacheKey+'\n',{mode:0o600,flag:'wx'});}
 if(!parseCacheKey(cacheKey))throw Error('CACHE_INVALIDA');
 const config=readArcaConfig({ARCA_PADRON_ENABLED:'true',ARCA_PADRON_ENV:'homologacion',ARCA_PADRON_CUIT_REPRESENTADA:cuit,ARCA_WSAA_CERT_PEM:certPem,ARCA_WSAA_KEY_PEM:keyPem,ARCA_WSAA_KEY_PASSWORD:password,ARCA_WSAA_CACHE_KEY:cacheKey});
 if(!config.configured||!config.cacheKey||!config.ticketScope)throw Error('CERTIFICADO_CLAVE_O_CONTRASENA');
 const db=new PrismaClient({datasources:{db:{url}},log:[],errorFormat:'minimal'});
 try{
  await precheck(db);const before=await snapshot(db);
  console.log(target.example?'DEV y certificado: OK. El CUIT representado sigue siendo el titular; se consulta sólo el ejemplo documentado. No se envía la clave privada.':'DEV y certificado: OK. Se enviarán el certificado público y el CUIT titular sólo a ARCA homologación; nunca la clave privada.');
  console.log('WSAA: '+HOMO.wsaa+' | Padrón: '+HOMO.padron);
  if(web){
   const publicKey=await publicKeyFromNetlify();
   if((await ask('Escribí INICIAR-WEB-LOCAL-ARCA-HOMO-DEV para iniciar: '))!=='INICIAR-WEB-LOCAL-ARCA-HOMO-DEV')throw Error('CANCELADO');
   const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:homedir(),TMPDIR:process.env.TMPDIR,NODE_ENV:'development',NEXT_TELEMETRY_DISABLED:'1',ARCA_LOCAL_HOMO:'1',ARCA_LOCAL_BIND:'127.0.0.1:3217',ARCA_HOMO_PREVIEW:'1',ARCA_HOMO_HASTA:new Date(Date.now()+30*60000).toISOString(),DATABASE_URL:url,DIRECT_URL:url,NEXT_PUBLIC_SUPABASE_URL:`https://${DEV}.supabase.co`,NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:publicKey,ARCA_PADRON_ENABLED:'true',ARCA_PADRON_ENV:'homologacion',ARCA_PADRON_CUIT_REPRESENTADA:cuit,ARCA_WSAA_CERT_PEM:certPem,ARCA_WSAA_KEY_PEM:keyPem,ARCA_WSAA_KEY_PASSWORD:password,ARCA_WSAA_CACHE_KEY:cacheKey};
   await localWeb(repo,env,async()=>{
    const unchanged=(await snapshot(db))===before;
    console.log('RESULT '+JSON.stringify({caso:'web_local_homologacion',conteos_y_marca_cliente_sin_cambios:unchanged}));
    if(!unchanged)process.exitCode=1;
   });
   return;
  }
  if((await ask('Escribí '+target.phrase+' para consultar (si hay datos, se repite una vez para verificar caché): '))!==target.phrase)throw Error('CANCELADO');
  let wsaa=0,padron=0;const fetchImpl:typeof fetch=async(input,init)=>{
   const url=String(input);let target:string;
   if(url===WSAA_ENDPOINTS.homologacion){target=HOMO.wsaa;wsaa++;}
   else if(url===PADRON_ENDPOINTS.homologacion){target=HOMO.padron;padron++;}
   else throw Error('DESTINO_NO_ADMITIDO');
   return fetch(target,init);
  };
  const deps={config,fetchImpl,nowMs:Date.now,timeoutMs:ARCA_TIMEOUT_MS,ticketCache:{get:()=>null,set:()=>{throw Error('SIN_CACHE_LOCAL');}},ticketStore:postgresTicketStore(config.ticketScope,config.cacheKey,Date.now,db)};
  const first=await lookupCuit(target.cuit,deps);const afterFirst=wsaa;
  const successful=canRepeat(first,target.example);
  const second=successful?await lookupCuit(target.cuit,deps):null;
  const unchanged=(await snapshot(db))===before;
  const result={ambiente:'homologacion',caso:target.example?'ejemplo_manual_v4_1':'titular',primera:safeResult(first),segunda:second?safeResult(second):null,llamadas_wsaa:wsaa,llamadas_padron:padron,reutilizacion:second?wsaa===afterFirst:false,conteos_y_marca_cliente_sin_cambios:unchanged};
  console.log('RESULT '+JSON.stringify(result));
  if(!unchanged||!successful||!second||!canRepeat(second,target.example)||wsaa!==afterFirst)process.exitCode=1;
 }finally{await db.$disconnect();}
 // La clave y la contraseña nunca salen de este proceso.
}
const SAFE_CODES=new Set(['NETLIFY_PUBLIC_CONFIG','ENV_LOCAL_PRESENTE','PUERTO_LOCAL_OCUPADO','SERVIDOR_LOCAL','ARGUMENTOS_NO_ADMITIDOS','CACHE_FALTANTE_NO_RECREAR','TERMINAL_INTERACTIVA','CANCELADO','WSDL_NO_DISPONIBLE','WSDL_NO_COINCIDE','MIGRACIONES_DEV','HUELLA_DEV','PERMISOS_TABLA','ENTORNO_NO_LIMPIO','FALTA_CARPETA_CERTIFICADO','CARPETA_O_TERMINAL','CARPETA_NO_PRIVADA','ARCHIVO_NO_ADMITIDO','CLAVE_NO_PRIVADA','CUIT_CERTIFICADO','URL_DEV_RECHAZADA','CLAVE_SIN_CIFRAR','CACHE_NO_PRIVADA','CACHE_INVALIDA','CERTIFICADO_CLAVE_O_CONTRASENA']);
if(require.main===module)main().catch(error=>{const code=error instanceof Error&&SAFE_CODES.has(error.message)?error.message:'ERROR_NO_CLASIFICADO';console.error('DETENIDO: '+code+'. No reintentes hasta revisar el resultado; no compartas secretos.');process.exitCode=1;});
