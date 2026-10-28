#!/usr/bin/env node
// Compila con TypeScript ya instalado. El hijo usa la condición oficial react-server.
import {mkdtemp,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../..');let tmp;
try{
 tmp=await mkdtemp(join(tmpdir(),'arca-homologation-'));
 const compiled=spawnSync(process.execPath,[join(repo,'node_modules/typescript/bin/tsc'),join(repo,'scripts/arca/homologation-runner.ts'),'--outDir',tmp,'--rootDir',repo,'--module','commonjs','--moduleResolution','node','--target','ES2022','--strict','--esModuleInterop','--skipLibCheck','--noEmitOnError'],{cwd:repo,encoding:'utf8'});
 if(compiled.status!==0){console.error('DETENIDO: no se pudo compilar la prueba local.');process.exitCode=1;}
 else{
  await symlink(join(repo,'node_modules'),join(tmp,'node_modules'),'dir');
  const child=spawnSync(process.execPath,['--conditions=react-server',join(tmp,'scripts/arca/homologation-runner.js'),repo,...process.argv.slice(2)],{cwd:repo,stdio:'inherit'});
  process.exitCode=child.status??1;
 }
}catch{console.error('DETENIDO: no se pudo iniciar la prueba local.');process.exitCode=1;}
finally{if(tmp)await rm(tmp,{recursive:true,force:true});}
