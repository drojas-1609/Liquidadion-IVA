# Alta de ARCA: certificado y homologación

Estado: preparación local, sin certificados reales, sin variables remotas y sin consultas reales. El botón sigue no configurado en producción. La homologación no habilita producción.

## 1. Crear la solicitud local

En una terminal, desde este worktree:

```sh
node scripts/arca/setup-certificate.mjs
```

Ingresá el CUIT de la **persona física que entra a WSASS** (el mismo del CSR), un nombre para identificar el estudio y una contraseña LOCAL nueva de al menos 16 caracteres. No es la Clave Fiscal. La contraseña no se muestra. El programa crea una clave RSA 3072 cifrada y un CSR en `~/.tax-liquidator-arca/homologacion-<fecha>/`, con directorio privado y archivos privados. No envía nada ni sobrescribe directorios existentes.

Conservá `privada-cifrada.key` y su contraseña por separado y fuera de Git, Drive y chats. Subí a ARCA **solamente `solicitud.csr`**. Si se pierde la contraseña no se puede recuperar la clave. El CSR contiene datos identificatorios: tampoco hace falta pegarlo acá.

## 2. Obtener certificado de homologación

Ingresá personalmente con Clave Fiscal al servicio WSASS. Si no lo tenés disponible, habilitalo siguiendo las instrucciones oficiales de ARCA. En «Nuevo Certificado», elegí un alias nuevo, por ejemplo `taxliquidator-homo`, y usá el CSR. El CUIT de la sesión debe coincidir con el del CSR. Guardá el certificado PEM emitido junto a la clave, sin pegarlo en el chat.

Fuente: [manual oficial: crear certificado](https://www.afip.gob.ar/ws/WSASS/html/crearcertificado.html).

## 3. Autorizar el servicio en homologación

En WSASS, «Crear Autorizacion a Servicio»: elegí el alias, el CUIT representado del estudio y el servicio **Constancia de Inscripción**, identificador `ws_sr_constancia_inscripcion`. El CUIT del certificado y el representado son conceptos distintos; confirmá la representación correspondiente. No autorices servicios de facturación que no necesita esta consulta.

Fuente: [manual oficial: autorización de acceso](https://www.afip.gob.ar/ws/WSASS/html/crearautorizacion.html).

## 4. Preparar DEV antes de habilitar

Pendiente: revisar y autorizar la migración nueva `20261028120000_arca_wsaa_ticket_cache` en DEV mediante un kit con preflight y postcheck. Ya se ensayó en PostgreSQL local descartable. No se aplicó en bases remotas. La tabla técnica guarda tickets cifrados, tiene RLS y no concede permisos a PUBLIC ni a los roles anon/authenticated/service_role.

Luego cargar secretos **sólo del servidor y sólo de una Preview/DEV**: `ARCA_PADRON_ENABLED=true`, `ARCA_PADRON_ENV=homologacion`, `ARCA_PADRON_CUIT_REPRESENTADA`, `ARCA_WSAA_CERT_PEM`, `ARCA_WSAA_KEY_PEM`, contraseña opcional `ARCA_WSAA_KEY_PASSWORD` y `ARCA_WSAA_CACHE_KEY` (32 bytes aleatorios en base64, secreto independiente). Ninguno lleva prefijo NEXT_PUBLIC. No pegar valores en chats ni comandos con historial. La contraseña de la clave se conserva como secreto del servidor; el cifrado del archivo no sustituye proteger el acceso a esas variables.

## 5. Ensayo real pendiente

Verificar certificado/clave/fechas y servicio; probar una consulta autorizada de homologación, caso inexistente, error de autenticación e indisponibilidad; comprobar reutilización de ticket entre instancias y ausencia de secretos en logs y navegador. No reintentar LoginCms indiscriminadamente: el almacén serializa emisiones y guarda un enfriamiento tras errores. Durante el último minuto de un ticket no se inicia otra autenticación; tras un rechazo del padrón se espera como mínimo su vencimiento antes de solicitar otro. Si se pierde el ticket o se rota la clave de caché, detener consultas y esperar la expiración del ticket emitido antes de reconfigurar; no borrar la fila para forzar una renovación.

El control de tasa por usuario/organización sigue siendo por instancia, no global. La respuesta de ARCA se propone en el borrador: no guarda el cliente, no confirma contactos ni determina inscripción o alícuotas IIBB.

## 6. Producción, después

Requiere certificado y autorización propios de producción, homologación aprobada, respaldo y migración PROD autorizada, revisión del cambio y publicación. No se reutiliza el certificado de homologación. La clave fiscal se usa sólo por el titular en ARCA, nunca en la aplicación.

Referencia técnica: [Constancia de Inscripción, manual oficial v4.1](https://www.arca.gob.ar/ws/WSCI/manual_ws_sr_ws_constancia_inscripcion.pdf), [WSAA](https://www.afip.gob.ar/ws/WSAA/WSAAmanualDev.pdf). Los endpoints del adaptador usan los dominios `arca.gob.ar` del manual; los namespaces SOAP mantienen los identificadores del servicio.
