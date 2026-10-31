# Prueba visual ARCA en Preview / DEV

## Estado y alcance

Preparación revisable, sin transferencia de secretos todavía. Rama exclusiva `codex/arca-homologacion-segura`; proyecto Netlify `liquidadoriva`, ID `d017ec41-acf9-4334-9c65-7d7e23045359`, equipo `drojas-s83-g`.

Pruebas locales del usuario acreditan autenticación, NOT_FOUND del titular y FOUND del ejemplo oficial20164755100 (nombre/domicilio disponibles, 1actividad y3impuestos), con ticket compartido reutilizado entre ejecuciones. El runner no muestra datos personales ni guarda clientes. La interfaz web todavía no se probó con ARCA habilitada.

Producción no se habilita con este cambio: el servidor exige una marca generada en build sólo para Deploy Preview de esta rama, activación explícita de homologación, vencimiento de máximo7días y destinos DATABASE_URL/DIRECT_URL/NEXT_PUBLIC_SUPABASE_URL de DEV. Reevalúa la fecha y los destinos al consultar. Acepta únicamente titular y ejemplo oficial durante la prueba. Usa explícitamente el endpoint operativo AFIP de homologación ya contrastado con su WSDL, sin fallback ni dirección configurable por el navegador.

## Configuración propuesta para aprobación

Crear nueve variables nuevas, todas `is_secret=true`, scope exclusivamente `functions` y contexto `branch` de la rama indicada:

- ARCA_PADRON_ENABLED, ARCA_PADRON_ENV y ARCA_PADRON_CUIT_REPRESENTADA.
- ARCA_WSAA_CERT_PEM, ARCA_WSAA_KEY_PEM, ARCA_WSAA_KEY_PASSWORD y ARCA_WSAA_CACHE_KEY.
- ARCA_HOMO_PREVIEW y ARCA_HOMO_HASTA (24h desde la carga).

El usuario debe autorizar expresamente que el certificado de homologación, la clave privada cifrada, su contraseña local y la clave de caché se almacenen en Netlify para esta rama. El cifrado del archivo no evita que el servidor pueda usarla al disponer también de la contraseña. No es la Clave Fiscal, y ésta nunca se transmite a Netlify. No se cargan valores para main, otras ramas ni contextos generales. Los valores no aparecen en el chat, argv ni archivos del repositorio.

## Ejecutor preparado (no ejecutar hasta aprobar la transferencia)

```sh
node scripts/arca/configure-preview.mjs /ruta/local/a/la/carpeta-del-certificado --apply
```

Pide la contraseña local en prompt oculto. Intenta reutilizar la autorización Netlify CLI del usuario activo, sólo desde su archivo privado estándar y sin mostrarla; si no hay una válida con ese formato, pide un token personal en prompt oculto. No crea ni guarda el token; el usuario lo gestiona en Netlify y puede revocarlo después. Verifica sitio/equipo y una constancia pública sin secretos, generada por el build de la Preview con las URLs reales. Comprueba el hash y tamaño exactos mediante el índice autenticado de archivos de Netlify; no necesita atravesar la protección SSO ni copiar cookies. Exige commit local exacto, PR20, rama/contexto correctos, build listo de menos de24h y variables de destino sin modificaciones posteriores a su creación. Las tres variables deben estar disponibles tanto en builds como functions. Relee los metadatos antes de enviar; cualquier cambio detiene la carga. El servidor vuelve a exigir DEV al consultar. La constancia no habilita ARCA ni demuestra conectividad con PostgreSQL. Las variables secretas de Netlify son write-only: nunca se intenta recuperar su valor original. Se niega a sobrescribir cualquier variable de este namespace que ya exista. Comprueba certificado/clave y reutiliza wsaa-cache-dev.secret.

Antes de enviar muestra alcance/caducidad y exige CONFIGURAR-ARCA-HOMO-PREVIEW-NETLIFY. Crea las9variables en una única solicitud y relee metadatos. No llama deploy, no hace merge y no cambia permisos. Si el plan/API no admite scope functions o secreto, no amplía scopes ni contrata planes: se detiene. Tras una respuesta incierta puede haber variables parciales; no repetir ni borrar a ciegas. Revisar metadatos antes de decidir.

Documentación primaria: [variables por rama](https://www.netlify.com/blog/branch-specific-environment-variable-values-from-the-netlify-ui-cli-or-api/), [API de variables](https://open-api.netlify.com/). El contexto por rama aplica también a las Deploy Previews de esa rama. Los scopes granulares están sujetos al plan de Netlify.

## Secuencia y verificación visual

1. Publicar el código en un PR draft y confirmar Preview del SHA exacto. Sin variables debe mostrar Consulta ARCA no configurada.
2. Con autorización, ejecutar la carga. Revisar RESULT y metadatos sin revelar secretos. Hace falta un nuevo deploy para que las funciones reciban las variables.
3. Iniciar sesión con OWNER de DEV. En Nuevo Cliente, probar el CUIT titular (NOT_FOUND) y20164755100 (FOUND). No guardar clientes.
4. Revisar nombre/domicilio/actividad propuestos. Aplicar sólo al borrador, preservar teléfono/email/IIBB y exigir confirmación si ya había valores distintos. Cambiar CUIT descarta propuesta. Revisar errores y consola sin secretos.
5. Comprobar en DEV por lectura que conteos de negocio/AuditLog no cambiaron; sólo el almacén técnico puede variar. No reutilizar el postcheck de migración que exige tabla de tickets vacía, porque ya contiene el ticket de homologación.
6. Al terminar, la activación caduca automáticamente en runtime. Eliminar después los valores de esta rama con revisión de metadatos y un nuevo deploy; los deploys publicados conservan su entorno previo. No borrar la clave de caché local ni tickets vigentes para forzar autenticaciones.

Límites: no demuestra funcionamiento de producción, todos los roles, límites globales entre instancias ni casos de indisponibilidad. Cualquier despliegue de producción requiere revisión separada, migración y certificado/servicio propios.


## Alternativa local autorizada
El intento de carga fue rechazado403: la cuenta no tiene env_var_scopes. Se verificó que no hay variables ARCA creadas. El usuario eligió continuar localmente sin ampliar scopes ni contratar planes. Ver [LOCAL.md](LOCAL.md); la prueba web remota queda pausada.
