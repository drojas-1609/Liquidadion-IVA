#!/usr/bin/env node
import {X509Certificate,createPrivateKey} from 'node:crypto';
import {readFile,lstat,realpath} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {homedir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createInterface} from 'node:readline/promises';
export const SITE_ID='d017ec41-acf9-4334-9c65-7d7e23045359';
export const BRANCH='codex/arca-homologacion-segura';
export const KEYS=['ARCA_PADRON_ENABLED','ARCA_PADRON_ENV','ARCA_PADRON_CUIT_REPRESENTADA','ARCA_WSAA_CERT_PEM','ARCA_WSAA_KEY_PEM','ARCA_WSAA_KEY_PASSWORD','ARCA_WSAA_CACHE_KEY','ARCA_HOMO_PREVIEW','ARCA_HOMO_HASTA'];
export function buildPayload(values){
 if(KEYS.some(k=>typeof values[k]!=='string'||!values[k]))throw Error('VALORES_INCOMPLETOS');
 return KEYS.map(key=>({key,scopes:['functions'],is_secret:true,values:[{context:'branch',context_parameter:BRANCH,value:values[key]}]}));
}
export function effectiveValue(vars,key){
 const variable=vars.find(x=>x.key===key);if(!variable)return undefined;
 const values=variable.values??[];
 return(values.find(x=>x.context==='branch'&&x.context_parameter===BRANCH)??values.find(x=>x.context==='deploy-preview')??values.find(x=>x.context==='all'))?.value;
}
export function isDevDatabase(raw){
 try{const u=new URL(raw);return !raw.includes('bqqruaikbqculvmtirvy')&&['postgres:','postgresql:'].includes(u.protocol)&&u.pathname==='/postgres'&&(u.hostname==='db.esyfpakajthdifhnhcew.supabase.co'||(u.hostname.endsWith('.pooler.supabase.com')&&decodeURIComponent(u.username)==='postgres.esyfpakajthdifhnhcew'));}catch{return false;}
}
export function checkDestinations(vars){
 if(!isDevDatabase(effectiveValue(vars,'DATABASE_URL')))throw Error('NETLIFY_DATABASE_NO_DEV');
 const direct=effectiveValue(vars,'DIRECT_URL');if(direct&&!isDevDatabase(direct))throw Error('NETLIFY_DIRECT_NO_DEV');
 const publicUrl=effectiveValue(vars,'NEXT_PUBLIC_SUPABASE_URL');
 if(!['https://esyfpakajthdifhnhcew.supabase.co','https://esyfpakajthdifhnhcew.supabase.co/'].includes(publicUrl))throw Error('NETLIFY_SUPABASE_NO_DEV');
 if(vars.some(x=>KEYS.includes(x.key)))throw Error('VARIABLES_ARCA_YA_EXISTEN_NO_SOBRESCRIBIR');
}
async function hidden(label){
 if(!process.stdin.isTTY)throw Error('TERMINAL_INTERACTIVA');process.stdout.write(label);process.stdin.setRawMode(true);process.stdin.resume();
 return new Promise((resolve,reject)=>{let value='';const finish=()=>{process.stdin.off('data',data);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');};const data=chunk=>{for(const c of chunk.toString()){if(c==='\u0003'){finish();reject(Error('CANCELADO'));return;}if(c==='\r'||c==='\n'){finish();resolve(value);return;}if(c==='\u007f')value=value.slice(0,-1);else if(c>=' ')value+=c;}};process.stdin.on('data',data);});
}
async function ask(label){const r=createInterface({input:process.stdin,output:process.stdout});try{return await r.question(label);}finally{r.close();}}
async function main(){
 const [folder,flag]=process.argv.slice(2);if(!folder||flag!=='--apply')throw Error('USO_REQUIERE_CARPETA_Y_APPLY');
 const root=await realpath(join(homedir(),'.tax-liquidator-arca')),dir=await realpath(resolve(folder));if(!dir.startsWith(root+sep)||((await lstat(dir)).mode&0o077)!==0)throw Error('CARPETA_NO_PRIVADA');
 const data={};for(const [name,file] of [['cert','certificado.pem'],['key','privada-cifrada.key'],['cache','wsaa-cache-dev.secret']]){
  const path=join(dir,file),st=await lstat(path);if(!st.isFile()||st.isSymbolicLink()||st.size>65536||(name!=='cert'&&(st.mode&0o077)!==0))throw Error('ARCHIVO_NO_PRIVADO');data[name]=await readFile(path,'utf8');
 }
 if(!data.key.startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----')||!/^[A-Za-z0-9+/]{43}=$/.test(data.cache.trim()))throw Error('MATERIAL_NO_VALIDO');
 const password=await hidden('Contraseña LOCAL de la clave (no se muestra): ');
 const cert=new X509Certificate(data.cert),key=createPrivateKey({key:data.key,format:'pem',passphrase:password});
 if(!cert.checkPrivateKey(key)||Date.now()<Date.parse(cert.validFrom)||Date.now()>=Date.parse(cert.validTo))throw Error('CERTIFICADO_NO_VALIDO');
 const cuit=cert.subject.match(/serialNumber\s*=\s*CUIT\s*(\d{11})/i)?.[1];if(!cuit)throw Error('CUIT_CERTIFICADO');
 const token=await hidden('Token personal de Netlify (no se muestra; no se guarda): ');if(!token.trim())throw Error('TOKEN_VACIO');
 const api=async(path,options={})=>{
  const response=await fetch('https://api.netlify.com/api/v1'+path,{...options,redirect:'error',signal:AbortSignal.timeout(20000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'}});
  if(!response.ok)throw Error('API_NETLIFY_'+response.status);return response.status===204?null:response.json();
 };
 const site=await api('/sites/'+SITE_ID);
 if(site.id!==SITE_ID||site.name!=='liquidadoriva'||site.account_slug!=='drojas-s83-g'||!site.account_id)throw Error('SITIO_NO_COINCIDE');
 const path='/accounts/'+encodeURIComponent(site.account_id)+'/env?site_id='+SITE_ID;
 const vars=await api(path);if(!Array.isArray(vars))throw Error('METADATOS_NO_VALIDOS');checkDestinations(vars);
 const until=new Date(Date.now()+24*3600000).toISOString();
 const payload=buildPayload({ARCA_PADRON_ENABLED:'true',ARCA_PADRON_ENV:'homologacion',ARCA_PADRON_CUIT_REPRESENTADA:cuit,ARCA_WSAA_CERT_PEM:data.cert,ARCA_WSAA_KEY_PEM:data.key,ARCA_WSAA_KEY_PASSWORD:password,ARCA_WSAA_CACHE_KEY:data.cache.trim(),ARCA_HOMO_PREVIEW:'1',ARCA_HOMO_HASTA:until});
 console.log('Destino verificado: liquidadoriva, rama '+BRANCH+'. Sólo functions; caduca '+until+'.');
 console.log('Se enviarán a Netlify certificado, clave cifrada, contraseña local y clave de caché. Se crearán 9 variables sin valores para main ni otras ramas.');
 console.log('No crea token ni cambia permisos de cuenta, no sobrescribe variables, no hace deploy. Si el plan no admite el alcance, se detiene sin ampliarlo.');
 if((await ask('Escribí CONFIGURAR-ARCA-HOMO-PREVIEW-NETLIFY para enviar: '))!=='CONFIGURAR-ARCA-HOMO-PREVIEW-NETLIFY')throw Error('CANCELADO');
 let attempted=false;
 try{
  attempted=true;await api(path,{method:'POST',body:JSON.stringify(payload)});
  const after=await api(path);
  for(const key of KEYS){const v=after.find(x=>x.key===key);if(!v||v.is_secret!==true||v.scopes?.length!==1||v.scopes[0]!=='functions'||v.values?.length!==1||v.values[0].context!=='branch'||v.values[0].context_parameter!==BRANCH)throw Error('VERIFICACION_INCIERTA');}
  console.log('RESULT '+JSON.stringify({site:'liquidadoriva',branch:BRANCH,variables:KEYS.length,scope:'functions',caduca:until,production_values:0,verified:true,deploy_triggered:false}));
 }catch{console.error(attempted?'DETENIDO: configuración incierta o rechazada. No reintentar ni ampliar el alcance; revisar sólo metadatos.':'DETENIDO: sin envío.');process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(()=>{console.error('DETENIDO: precheck no completado; no se muestran errores internos ni secretos.');process.exitCode=1;});
