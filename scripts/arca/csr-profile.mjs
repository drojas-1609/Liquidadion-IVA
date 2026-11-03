/** Perfiles puros del CSR por ambiente. Sin E/S: los usa setup-certificate.mjs y las pruebas. */
export const CSR_PROFILES = Object.freeze({
 homologacion: Object.freeze({
  cn: 'TaxLiquidator homologacion',
  dirPrefix: 'homologacion-',
  cuitPrompt: 'CUIT de la persona física que ingresa a WSASS (11 dígitos): ',
  confirm: null,
  readme: 'Solicitud local para HOMOLOGACIÓN de ARCA.\nSubir SOLO solicitud.csr a WSASS (homologación).\nNo sirve para producción.\n',
 }),
 produccion: Object.freeze({
  cn: 'TaxLiquidator produccion',
  dirPrefix: 'produccion-',
  cuitPrompt: 'CUIT del contribuyente para el que se crea el certificado de PRODUCCIÓN (11 dígitos): ',
  confirm: 'GENERAR-CSR-PRODUCCION',
  readme: 'Solicitud local para PRODUCCIÓN de ARCA.\nSubir SOLO solicitud.csr en «Administración de Certificados Digitales» (Agregar alias), con Clave Fiscal del titular.\nNo usar en WSASS ni en homologación.\n',
 }),
});
/** Exige `--ambiente=homologacion|produccion`; sin valor por defecto. */
export function parseAmbiente(argv){
 const values=argv.filter(a=>a.startsWith('--ambiente=')).map(a=>a.slice('--ambiente='.length));
 if(values.length!==1||!Object.hasOwn(CSR_PROFILES,values[0]))throw Error('Indicá exactamente --ambiente=homologacion o --ambiente=produccion.');
 return values[0];
}
export const cuitOk=s=>{if(!/^\d{11}$/.test(s))return false;const sum=[5,4,3,2,7,6,5,4,3,2].reduce((n,w,i)=>n+w*Number(s[i]),0);const dv=11-sum%11;return Number(s[10])===(dv===11?0:dv===10?9:dv);};
export function csrSubject(ambiente,name,cuit){
 const profile=CSR_PROFILES[ambiente];
 if(!profile)throw Error('Ambiente inválido.');
 if(!cuitOk(cuit))throw Error('CUIT inválido.');
 if(!/^[\p{L}\p{N} .,_-]{2,80}$/u.test(name))throw Error('Nombre inválido: usá letras, números y espacios.');
 return `/C=AR/O=${name}/CN=${profile.cn}/serialNumber=CUIT ${cuit}`;
}
