/** Guardas puras de homologación web. No se aceptan destinos desde el navegador. */
export const ARCA_HOMO_BRANCH='codex/arca-homologacion-segura';
export const ARCA_HOMO_EXAMPLE_CUIT='20164755100';
export const ARCA_HOMO_BUILD_FLAG='ARCA_HOMO_BUILD_ELIGIBLE';
export function arcaHomoBuildEligible(env:Readonly<Record<string,string|undefined>>){
 return env.CONTEXT==='deploy-preview'&&env.HEAD===ARCA_HOMO_BRANCH;
}
export function arcaHomoRuntimeEligible(env:Readonly<Record<string,string|undefined>>,built:string|undefined,now:number){
 if(built!=='1'||env.ARCA_HOMO_PREVIEW!=='1'||env.ARCA_PADRON_ENV!=='homologacion')return false;
 if(env.CONTEXT!==undefined&&env.CONTEXT!=='deploy-preview')return false;
 if(env.HEAD!==undefined&&env.HEAD!==ARCA_HOMO_BRANCH)return false;
 const until=env.ARCA_HOMO_HASTA??'';
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(until))return false;
 const end=Date.parse(until);if(!Number.isFinite(end)||end<=now||end-now>7*86400000)return false;
 const dev='esyfpakajthdifhnhcew',prod='bqqruaikbqculvmtirvy';
 const db=(raw:string|undefined)=>{
  if(!raw||raw.includes(prod))return false;
  try{const u=new URL(raw);return ['postgres:','postgresql:'].includes(u.protocol)&&u.pathname==='/postgres'&&(u.hostname===`db.${dev}.supabase.co`||(u.hostname.endsWith('.pooler.supabase.com')&&decodeURIComponent(u.username)===`postgres.${dev}`));}catch{return false;}
 };
 if(!db(env.DATABASE_URL)||(env.DIRECT_URL&&!db(env.DIRECT_URL)))return false;
 try{const u=new URL(env.NEXT_PUBLIC_SUPABASE_URL??'');return u.origin===`https://${dev}.supabase.co`&&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password;}catch{return false;}
}
