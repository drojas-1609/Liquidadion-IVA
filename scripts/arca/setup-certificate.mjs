#!/usr/bin/env node
/** Local únicamente. Genera clave CIFRADA y CSR, nunca un certificado de ARCA. Exige --ambiente=homologacion|produccion. */
import {spawn} from 'node:child_process';
import {CSR_PROFILES,csrSubject,cuitOk,parseAmbiente} from './csr-profile.mjs';
import {mkdir,chmod,writeFile,readFile,stat,rm,mkdtemp} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {homedir,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const run=(args,input='')=>new Promise((resolve,reject)=>{
 args=args.map(x=>x==='stdin'?'env:ARCA_LOCAL_PASSPHRASE':x); const p=spawn('openssl',args,{env:{...process.env,ARCA_LOCAL_PASSPHRASE:input.replace(/\n$/, '')},stdio:['ignore','pipe','pipe']});let stdout='';p.stdout.on('data',d=>stdout+=d);p.stderr.resume();p.on('error',()=>reject(Error('No se pudo ejecutar OpenSSL.')));p.on('close',code=>code===0?resolve(stdout):reject(Error('OpenSSL rechazó la operación; no se muestra su salida para proteger la clave.')));
});
async function secret(label){
 if(!process.stdin.isTTY)throw Error('La clave se ingresa solo en una terminal interactiva.');
 process.stdout.write(label);process.stdin.setRawMode(true);process.stdin.resume();
 return new Promise((resolve,reject)=>{let value='';const finish=()=>{process.stdin.removeListener('data',data);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');};const data=chunk=>{for(const char of chunk.toString()){if(char==='\u0003'){finish();reject(Error('Cancelado.'));return;}if(char==='\r'||char==='\n'){finish();resolve(value);return;}if(char==='\u007f'){value=value.slice(0,-1);continue;}if(char>=' ')value+=char;}};process.stdin.on('data',data);});
}
async function generate(ambiente,dir,cuit,name,password){
 const subject=csrSubject(ambiente,name,cuit),profile=CSR_PROFILES[ambiente];
 if(password.length<16||/[\r\n\0]/.test(password))throw Error('La contraseña local debe tener al menos 16 caracteres y no contener saltos de línea.');
 await mkdir(dir,{mode:0o700});await chmod(dir,0o700);
 const key=join(dir,'privada-cifrada.key'),csr=join(dir,'solicitud.csr');
 await run(['genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:3072','-aes-256-cbc','-pass','stdin','-out',key],password+'\n');await chmod(key,0o600);
 await run(['req','-new','-sha256','-utf8','-key',key,'-passin','stdin','-subj',subject,'-out',csr],password+'\n');await chmod(csr,0o600);
 const data=await readFile(csr);await writeFile(join(dir,'LEEME.txt'),profile.readme+'privada-cifrada.key no se sube a ARCA, Git, chat ni Drive. Conservá la contraseña por separado.\nEl archivo CSR no es el certificado emitido por ARCA.\n',{mode:0o600,flag:'wx'});
 await writeFile(join(dir,'CSR-SHA256.txt'),createHash('sha256').update(data).digest('hex')+'  solicitud.csr\n',{mode:0o600,flag:'wx'});
 return {key,csr};
}
async function selftest(){const root=await mkdtemp(join(tmpdir(),'arca-csr-test-'));try{
 const cuit='30999999170';const password='SINTETICA-NO-REAL-987654';
 for(const ambiente of Object.keys(CSR_PROFILES)){
  const dir=join(root,ambiente);const {key,csr}=await generate(ambiente,dir,cuit,'ESTUDIO SINTETICO',password);
  if(!(await readFile(key,'utf8')).startsWith('-----BEGIN ENCRYPTED PRIVATE KEY-----'))throw Error('Clave sin cifrar');
  await run(['req','-in',csr,'-noout','-verify']);
  if(!(await run(['req','-in',csr,'-noout','-subject','-nameopt','RFC2253'])).includes('CN='+CSR_PROFILES[ambiente].cn))throw Error('Perfil de ambiente');
  if((await stat(key)).mode&0o077)throw Error('Permisos de clave');
  let rejected=false;try{await generate(ambiente,dir,cuit,'ESTUDIO SINTETICO',password);}catch{rejected=true;}if(!rejected)throw Error('Sobrescritura permitida');
 }
 console.log('CSR offline (homologación y producción sintéticos): clave cifrada, firma válida, perfil de ambiente, permisos privados y sin sobrescritura: OK');
}finally{await rm(root,{recursive:true,force:true});}}
try{
 if(process.argv.includes('--selftest'))await selftest();
 else{
  const ambiente=parseAmbiente(process.argv.slice(2)),profile=CSR_PROFILES[ambiente];
  console.log(`AMBIENTE: ${ambiente.toUpperCase()} (CN «${profile.cn}»). No se envía nada a ARCA.`);
  const r=createInterface({input:process.stdin,output:process.stdout});
  if(profile.confirm&&(await r.question(`Escribí ${profile.confirm} para continuar: `)).trim()!==profile.confirm){r.close();throw Error('Sin confirmación de producción.');}
  const cuit=(await r.question(profile.cuitPrompt)).replace(/[ -]/g,'');const name=(await r.question('Nombre del estudio para el certificado: ')).trim();r.close();
  if(!cuitOk(cuit))throw Error('CUIT inválido.');
  const password=await secret('Contraseña LOCAL para cifrar la clave (no se muestra, mínimo 16 caracteres): ');const confirm=await secret('Repetí la contraseña LOCAL: ');if(password!==confirm)throw Error('Las contraseñas no coinciden.');
  const parent=join(homedir(),'.tax-liquidator-arca');await mkdir(parent,{recursive:true,mode:0o700});await chmod(parent,0o700);
  const dir=resolve(parent,profile.dirPrefix+new Date().toISOString().replace(/[:.]/g,'-'));const result=await generate(ambiente,dir,cuit,name,password);
  console.log('Solicitud de '+ambiente.toUpperCase()+' creada en: '+result.csr+'\nClave privada cifrada en: '+result.key+'\nNo se enviaron datos a ARCA. Subí únicamente solicitud.csr ('+(ambiente==='produccion'?'Administración de Certificados Digitales':'WSASS')+'); nunca la clave privada.');
 }
}catch(err){if(process.argv.includes('--selftest')||/^(Indicá exactamente|Sin confirmación)/.test(err.message))console.error(err.message);console.error('DETENIDO: no se completó la solicitud. Revisá los datos, la coincidencia y longitud de la contraseña, OpenSSL y que el directorio no exista. No compartas la clave ni la contraseña.');process.exitCode=1;}
