# ARCA en producción: compuerta, cupos, tickets y auditoría

Estado: implementado y probado **sólo localmente** (rama `codex/arca-produccion-compuerta`). La migración `20261102120000_arca_production_controls` está **aplicada y verificada sólo en DEV** (03/11/2026 UTC); **PROD sigue sin aplicar**. No hay credenciales de producción cargadas y ARCA sigue sin consultarse en producción. Primera habilitación prevista: únicamente el estudio del titular.

## 1. Compuerta (deshabilitada por defecto)

La consulta en producción exige **todas** estas capas. Si falta cualquiera, o una lectura falla, no se consulta ARCA y la UI mantiene el alta manual.

| Capa | Condición | Dónde |
|---|---|---|
| Build | `NETLIFY=true`, `CONTEXT=production`, `HEAD=main`; queda inlineado `ARCA_PROD_BUILD_ELIGIBLE` | `lib/arca-padron/production-build.ts`, `next.config.ts` |
| Ambiente | `NODE_ENV=production` tomado del valor que Next inlinea en el build (no del entorno de runtime), `ARCA_PADRON_ENABLED=true`, `ARCA_PADRON_ENV=produccion` | `production-gate.ts`, `service.ts` |
| Separación | Ninguna de `ARCA_HOMO_PREVIEW`, `ARCA_HOMO_HASTA`, `ARCA_LOCAL_HOMO`, `ARCA_LOCAL_BIND`; build de homologación ≠ `1` | `production-gate.ts` |
| Base | `DATABASE_URL`/`DIRECT_URL` y `NEXT_PUBLIC_SUPABASE_URL` del proyecto PROD | `production-gate.ts` |
| Destinos | Constantes fijas `https://wsaa.afip.gov.ar/ws/services/LoginCms` y `https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5`; sin perfil de transporte de homologación | `production-gate.ts`, `service.ts` |
| Certificado | Declarados por el operador y con coincidencia exacta: `ARCA_WSAA_CERT_SHA256` (huella del PEM) y `ARCA_WSAA_CERT_CN` (único CN del sujeto). Además: PEM legible, vigencia, `serialNumber=CUIT <11 dígitos válidos>`, pareja con la clave y RSA ≥ 2048 (`cms.ts`); cadena validada por WSAA (manual §10.2) | `productionCertificateCheck`, `config.ts` |
| Configuración | Variables ARCA completas y válidas (`config.ts`), cupos válidos | `service.ts` |
| Interruptor | Fila `ArcaPadronControl('global').enabled = true`, leída en cada consulta | `production-switch.ts` |
| Organización | Fila `ArcaPadronOrganization(organizationId).enabled = true` | `production-switch.ts` |

Las barreras de homologación (`preview-gate.ts`) no cambiaron: una variable de producción no abre homologación y viceversa.

**CN y CUIT del sujeto.** El CN esperado **no está fijado en el código**: el operador lo declara en `ARCA_WSAA_CERT_CN`, sin valor por defecto, y debe coincidir exactamente (mayúsculas, espacios y longitud) con el único CN del certificado. El certificado de producción emitido tiene `CN=taxliquidatorprod`, distinto del CN `TaxLiquidator produccion` que usa el generador de CSR. Si la variable falta o tiene otro formato, la compuerta queda cerrada con `ARCA_WSAA_CERT_CN`; si no coincide, o el sujeto tiene más de un CN, queda cerrada con `CERT_CN`. El `serialNumber` debe ser `CUIT <11 dígitos con DV válido>`; si no lo es, el motivo es `CERT_SUJETO_NO_CONFIRMADO`. Los motivos no incluyen material del certificado. Las fuentes oficiales consultadas no publican el nombre del emisor por ambiente, por eso no se valida el emisor; la cadena la valida WSAA.

### Apagado sin redeploy (SQL del operador, no ejecutado)

```sql
-- Apagar TODO:
UPDATE "ArcaPadronControl" SET "enabled" = false, "updatedAt" = now() WHERE "id" = 'global';
-- Apagar una organización:
UPDATE "ArcaPadronOrganization" SET "enabled" = false, "updatedAt" = now() WHERE "organizationId" = '<id>';
```

Encender requiere autorización explícita y las dos filas en `true`. La migración crea la fila global en `false` y ninguna organización habilitada.

**Alcance del apagado:** el interruptor se lee al comienzo de cada consulta. Apagarlo impide consultas nuevas, pero **no cancela** las que ya pasaron esa lectura: terminan dentro de sus timeouts (8 s por llamada a WSAA y al padrón) y registran su resultado.

## 2. Cupos propios compartidos

No son límites de ARCA: el manual v4.1 no publica cuotas. Valores por defecto, configurables por variable (entero 1–1000; un valor inválido cierra la compuerta):

| Clave | Cupo | Ventana | Variable |
|---|---|---|---|
| `u:<profileId>` | 10 | 1 minuto | `ARCA_QUOTA_PROFILE_PER_MINUTE` |
| `o:<organizationId>` | 60 | 1 hora | `ARCA_QUOTA_ORGANIZATION_PER_HOUR` |
| `c:<alcance del certificado>` | 300 | 1 hora | `ARCA_QUOTA_CERTIFICATE_PER_HOUR` |

**Hora de referencia.** Todas las operaciones del cupo usan una única hora: `clock_timestamp()` de PostgreSQL, leída una vez dentro de la transacción y después de bloquear las filas. Como las filas bloqueadas serializan cada clave, el orden de las horas coincide con el de los commits. No se usa el reloj de la instancia, ni `now()`, que es la hora de inicio de la transacción y queda atrasada si se esperó un lock.

**Semántica (ventana deslizante exacta).** Un consumo registrado en el instante *t* cuenta para su clave mientras *now* < *t* + ventana. Se admite una consulta si en cada clave los consumos que cuentan son menos que el cupo. `Retry-After` = instante en que deja de contar el consumo que completa el cupo más restrictivo, menos *now*, redondeado hacia arriba en segundos.

- **Todos o ninguno:** los tres cupos se verifican y registran en una sola transacción; si uno está agotado no se registra ninguno. Un intento rechazado no consume.
- **Orden:** autenticación → organización → rol → CUIT válido → interruptor y organización → cupos e intento de auditoría (misma transacción) → ARCA → resultado. Lo que se rechaza antes no consume.
- **Sin devolución:** una consulta admitida consume aunque ARCA falle, para no alentar reintentos.
- **Concurrencia:** una fila de bloqueo por clave en `ArcaLookupQuota`, bloqueadas en orden de clave (sin deadlocks) con `lock_timeout` 1 s y `statement_timeout` 2 s. La transacción termina antes de llamar a ARCA.
- **Fallo del almacén:** responde 503 y no consulta ARCA. No hay respaldo en memoria.
- **Depuración:** al consumir se borran los consumos de esa clave fuera de su ventana.
- Homologación y ensayo local conservan el límite por instancia anterior.

## 3. Tickets WSAA: rotación y recuperación

- **Sin transacción durante LoginCms.** Una reserva corta (`leaseId`, `leaseUntil` = ahora + 30 s) en la fila evita emisiones simultáneas entre instancias. La instancia que no la obtiene responde 503 con `Retry-After` hasta el fin de la reserva, sin esperar ni reintentar.
- **Rotación de la clave de caché:** `ARCA_WSAA_CACHE_KEY` (vigente) y `ARCA_WSAA_CACHE_KEY_PREVIOUS` (opcional, distinta, sólo lectura). Los tickets nuevos usan el formato `v2` con un identificador de clave derivado por hash; un ticket leído con la clave anterior se vuelve a cifrar con la vigente.
- **Compatibilidad:** los tickets `v1` existentes se leen con la clave vigente o con la anterior y se migran a `v2` al usarse.
- **No se borra un ticket vigente** ni se fuerza otra autenticación:
  - ticket ilegible (por ejemplo, clave perdida): espera hasta su `expiresAt` en texto claro, fijo;
  - rechazo del padrón (AUTH): el ticket se conserva y se bloquea hasta su propio `expiresAt`; un segundo rechazo no lo prolonga;
  - último minuto del ticket: no se pide otro hasta su vencimiento;
  - emisión fallida: enfriamiento de 30 s desde el fallo, fijo.
- **Sin bucles automáticos:** cada espera se informa al usuario; sólo una nueva acción del usuario vuelve a intentar.

**Contraste con la documentación oficial.** [WSAA, Manual del Desarrollador](https://www.afip.gob.ar/ws/WSAA/WSAAmanualDev.pdf), §10.6 «El CEE ya posee un TA valido para el acceso al WSN solicitado»:

- Indica que el lapso preventivo es actualmente de 10 minutos en testing y 2 minutos en producción, y que esos valores pueden modificarse dinámicamente y sin aviso previo.
- Recomienda volver a solicitar un TA recién cuando el anterior deja de estar vigente.

Como el lapso no es un valor estable, **no** se acortó la espera a 2 minutos: se conserva el comportamiento seguro previo (esperar el vencimiento del ticket) y el enfriamiento de 30 s tras errores de emisión.

## 4. Auditoría mínima

- **Dos filas por consulta**, acción `arca.cuit_lookup`, `targetType` `ArcaPadronLookup` y el mismo `targetId`: un identificador interno aleatorio de la consulta, nunca el CUIT.
  - **Intento** (`metadata.result = STARTED`): se registra antes de consultar ARCA, en la misma transacción que consume los cupos. Si falla, no se consume ningún cupo y no se consulta ARCA (503).
  - **Resultado:** un código fijo como `FOUND`, `NOT_FOUND`, `RETRY_LATER` o `ERROR_*`, registrado después de la consulta y fuera de toda transacción con ARCA.
- **Fallo del registro final:** el intento queda registrado, la API responde 503 sin entregar el dato y no se repite la consulta automáticamente. La lectura lo muestra como `SIN_RESULTADO`.
- **Qué se registra:** organización, perfil (`actorProfileId`), fecha (`createdAt`) y resultado. Nunca el CUIT consultado, la respuesta de ARCA, tokens ni credenciales; la lista permitida lo impone.
- **Lectura:** `GET /api/arca/lookup-audit`, sólo OWNER y ADMIN, sólo la organización activa, los últimos 100 intentos con su resultado. No expone el identificador interno.
- **No es anónima:** el identificador de perfil es un dato personal seudónimo del usuario del estudio.
- **Retención: decisión pendiente.** No se fijó un plazo legal ni se activó ninguna purga. Requiere definición con asesoría (Ley 25.326) antes de cualquier borrado.
- **Consumos de cupo:** `ArcaLookupQuotaEvent` conserva clave y hora por hasta 1 hora, con identificadores de perfil y organización; no contiene el CUIT.

## 5. Certificado de producción

```sh
node scripts/arca/setup-certificate.mjs --ambiente=produccion
```

- **Ambiente explícito:** sin `--ambiente` el script no corre.
- **Confirmación:** producción pide escribir `GENERAR-CSR-PRODUCCION`.
- **Perfil:** usa la carpeta `~/.tax-liquidator-arca/produccion-<fecha>/`, el CN `TaxLiquidator produccion` y un LEEME que indica subir sólo el CSR en «Administración de Certificados Digitales».
- **Lo ejecuta el titular:** con Clave Fiscal en ARCA, nunca en la aplicación ni en un chat.
- **Prueba sintética:** `--selftest` genera y borra material sintético de ambos ambientes.
- **CN del CSR:** el generador usa `TaxLiquidator produccion`. La compuerta no depende de ese valor: exige el CN declarado en `ARCA_WSAA_CERT_CN`.

### Configuración requerida del certificado (operador)

Variables **sólo del servidor y sólo del contexto de producción**, sin prefijo `NEXT_PUBLIC`:

| Variable | Valor | Si falta o es inválida |
|---|---|---|
| `ARCA_WSAA_CERT_PEM` | Certificado emitido por ARCA (PEM) | `ARCA_WSAA_CERT_SHA256` / `ARCA_WSAA_CERT_PEM` |
| `ARCA_WSAA_CERT_SHA256` | SHA-256 del certificado: 64 caracteres hexadecimales en minúscula, sin `:` | `ARCA_WSAA_CERT_SHA256` |
| `ARCA_WSAA_CERT_CN` | CN exacto del certificado: hoy `taxliquidatorprod`. Formato admitido: 1–64 caracteres `[A-Za-z0-9 ._-]`, sin espacios al inicio ni al final | `ARCA_WSAA_CERT_CN`; si no coincide, `CERT_CN` |
| `ARCA_WSAA_KEY_PEM` y, si corresponde, `ARCA_WSAA_KEY_PASSWORD` | Clave privada que corresponde al certificado | Si no corresponden: `SIGNER_UNAVAILABLE` |

Para obtener la huella y el sujeto se lee **sólo el certificado público**, nunca la clave privada, desde la carpeta del certificado y sin pegar los valores en chats:

```sh
openssl x509 -in certificado.pem -noout -fingerprint -sha256 | cut -d= -f2 | tr -d ':' | tr 'A-F' 'a-f'   # ARCA_WSAA_CERT_SHA256
openssl x509 -in certificado.pem -noout -subject -nameopt multiline                                      # commonName = ARCA_WSAA_CERT_CN
```

Verificar que el sujeto muestre un único `commonName` y `serialNumber = CUIT <titular>`. Copiar el CN tal cual, sin espacios adicionales. Cargar o cambiar estas variables en Netlify es un paso aparte que requiere autorización. Con cualquier diferencia, la consulta en producción queda deshabilitada y la UI mantiene el alta manual.

## 6. Migración (aplicada sólo en DEV)

`prisma/migrations/20261102120000_arca_production_controls/migration.sql`. Es transaccional y aditiva:

- **`ArcaWsaaTicket`:** agrega las columnas nullable `leaseId` y `leaseUntil`, con un CHECK que las exige juntas.
- **Tablas nuevas:** `ArcaPadronControl` (fila global en `false`), `ArcaPadronOrganization`, `ArcaLookupQuota` y `ArcaLookupQuotaEvent`.
- **Permisos:** RLS sin políticas y sin privilegios para PUBLIC, `anon`, `authenticated` ni `service_role`, incluida la secuencia.

**DEV:** aplicada con `~/arca-production-controls-dev-kit` (corrida `runs/20261103T015023Z-migrate`: Prisma 0, postcheck OK). Huella DEV leída y verificada por `80-h3-fingerprint.sh` (`runs/20261103T015213Z-h3`): `8fdb3152a0c7aecf35581f2dd8c82ccbd25d769f9efc8be7f5a0b9d86164a04f`. Sus 10 filas previas reproducen la huella anterior `37460066…11c9de`. El kit cumplió su propósito y no debe repetirse.

**Runner de homologación (H3).** `scripts/arca/homologation-runner.ts` verifica, en una transacción de sólo lectura y antes de cualquier consulta a ARCA:

- exactamente las 11 migraciones, con nombre y checksum completo, terminadas, sin rollback ni logs → si no, `MIGRACIONES_DEV`;
- la huella DEV verificada → si no, `HUELLA_DEV`;
- en `ArcaWsaaTicket`, las cuatro tablas nuevas y `ArcaLookupQuotaEvent_id_seq`: owner `postgres`, RLS activo sin FORCE en las tablas, sin políticas, sin privilegios fuera del propietario y ACL exacta (`{postgres=arwdDxtm/postgres}` en tablas, `{postgres=rwU/postgres}` en la secuencia) → si no, `PERMISOS_TABLA`;
- exactamente los CHECK esperados, validados y con su definición: reserva (`ArcaWsaaTicket_lease_check`), payload, fila única del interruptor y clave de cupo → si no, `RESTRICCION_TABLA`.

La huella no se calcula: incluye los UUID que Prisma asignó en DEV. Cualquier migración futura en DEV exige repetir H3 con una huella leída y verificada.

## 7. Pruebas locales

- **Unitarias y de API:** compuerta, rotación, cupos, flujo y roles. Corren sin red ni base con `npx vitest run`.
- **PostgreSQL local descartable:** `scripts/pg-local-regression.sh` corre en serie la ficha de clientes, WSAA, `arca-production-pg` y `arca-devlike-pg`. Cubre:
  - cupos concurrentes entre dos instancias, todo o nada, ventana con la hora de PostgreSQL y reloj de instancia adelantado;
  - intento de auditoría atómico con el cupo, fallos del almacén, interruptor, auditoría por organización y RLS;
  - reservas tomadas por otra instancia y ticket emitido pero no persistido;
  - cierre con el esquema previo, en una base con todas las migraciones salvo la última;
  - precheck del runner (`arca-runner-precheck-pg`): rechaza el esquema anterior aplicado con Prisma (10 migraciones), acepta las 11 sólo con su propia huella y detecta historial alterado, CHECK ausentes, `NOT VALID`, con otra expresión o extra, privilegios a `anon`, `service_role` o PUBLIC, RLS desactivado o forzado, políticas, otro propietario y relaciones ausentes. Cada alteración se deshace y se verifica que el precheck vuelve a pasar.
