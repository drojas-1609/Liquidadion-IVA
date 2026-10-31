#!/usr/bin/env node
// Compila con TypeScript ya instalado. El hijo usa la condición oficial react-server.
import {mkdtemp,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');let tmp,runner,stopped=false;
// Ctrl+C llega a todo el grupo de procesos: el runner lo maneja y cierra Next. Este
// proceso no debe morir antes que él (devolvería el prompt antes del RESULT y
// dejaría el temporal compilado); sólo reenvía señales que no recibió el grupo.
process.on('SIGINT',()=>{});
for(const signal of ['SIGTERM','SIGHUP'])process.on(signal,()=>{stopped=true;runner?.kill(signal);});
try{
 tmp=await mkdtemp(join(tmpdir(),'arca-homologation-'));
 const compiled=spawnSync(process.execPath,[join(repo,'node_modules/typescript/bin/tsc'),join(repo,'scripts/arca/homologation-runner.ts'),'--outDir',tmp,'--rootDir',repo,'--module','commonjs','--moduleResolution','node','--target','ES2022','--strict','--esModuleInterop','--skipLibCheck','--noEmitOnError'],{cwd:repo,encoding:'utf8'});
 if(compiled.status!==0){console.error('DETENIDO: no se pudo compilar la prueba local.');process.exitCode=1;}
 else if(!stopped){
  await symlink(join(repo,'node_modules'),join(tmp,'node_modules'),'dir');
  runner=spawn(process.execPath,['--conditions=react-server',join(tmp,'scripts/arca/homologation-runner.js'),repo,...process.argv.slice(2)],{cwd:repo,stdio:'inherit'});
  const status=await new Promise(ok=>{runner.once('error',()=>ok(1));runner.once('exit',code=>ok(code??1));});
  process.exitCode=status;
 }
 else process.exitCode=1;
}catch{console.error('DETENIDO: no se pudo iniciar la prueba local.');process.exitCode=1;}
finally{if(tmp)await rm(tmp,{recursive:true,force:true});}
