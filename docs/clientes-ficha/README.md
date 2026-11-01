# Ficha de clientes: contactos, Ingresos Brutos y consulta de CUIT en ARCA

Estado: implementación local. **Migración NO aplicada** en DEV ni PROD. **Consulta ARCA NO configurada y NO operativa:** queda pendiente de los requisitos de [Habilitación de ARCA](#habilitación-de-arca-pendiente).

## Alcance

- **Contactos.** Teléfono y email de contacto.
  - Obligatorios en el alta.
  - Pendientes (avisados) en clientes históricos.
- **Inscripción en Ingresos Brutos.** Es **informativa**:
  - Local, Simplificado, Exento, No Inscripto o Convenio Multilateral.
  - Con sus jurisdicciones y la sede (en CM).
- **Actividades.** Cada una con código, descripción y nomenclador.
  - Llevan alícuotas por jurisdicción, también **informativas**.
- **Botón «Consultar CUIT en ARCA».** Propone datos para revisar; nunca guarda por sí solo.

Fuera de alcance:
- El módulo de obligaciones de IIBB, vencimientos y liquidación de CM.
- Toda inferencia de régimen o alícuotas.

**Nada de esto cambia la liquidación.**
- El cálculo y las exportaciones siguen usando `Client.defaultIibbRate`.
- En el formulario, `defaultIibbRate` aparece en la sección secundaria «Alícuota usada por el cálculo actual».
  - Desde la rama de catálogos (`docs/catalogos-actividades/README.md`) se rotula «Alícuota del cálculo actual (%)», sigue editable en la ficha y se envía sólo si cambió.
- Las alícuotas por actividad no se combinan con `defaultIibbRate`: no se toma una actividad principal, ni un promedio, ni un máximo.

## Modelo de datos

Migración: `prisma/migrations/20261025120000_client_profile_iibb_contacts`. Es aditiva y transaccional, con `lock_timeout` 5s y `statement_timeout` 60s.

| Objeto | Contenido |
|---|---|
| `Client` | `phone`, `contactEmail`, `iibbRegistration`: todas nullable. Los históricos quedan en NULL (sin clasificar), sin transformación de datos. |
| `ClientIibbRegistration` | `LOCAL`, `SIMPLIFICADO`, `EXENTO`, `NO_INSCRIPTO`, `CONVENIO_MULTILATERAL` |
| `ClientJurisdiction` | Código 901–924 y `isHeadquarters`. Único por cliente. |
| `ClientActivity` | Nomenclador (`ARCA` / `NAES` / `PROVINCIAL` + jurisdicción / `OTRO` + referencia), código y descripción. Único por (cliente, nomenclador, jurisdicción del nomenclador, código). |
| `ClientActivityRate` | Actividad × jurisdicción. `rate DECIMAL(9,6)`: **NULL = sin informar**, `0` = cero explícito. |

Integridad:
- **Aislamiento entre organizaciones:** todas las FK son compuestas con `organizationId`, así que no puede haber relaciones entre organizaciones.
- **Borrado en cascada:**
  - Borrar un cliente elimina toda su ficha (jurisdicciones, actividades y alícuotas).
  - Borrar una jurisdicción elimina sus alícuotas. La FK de la alícuota a la jurisdicción es `ON DELETE CASCADE` y `ON UPDATE NO ACTION`.
  - Antes era `NO ACTION`, y PostgreSQL rechazaba el borrado de un cliente con alícuotas, porque verificaba esa FK antes de que la cascada desde la actividad las eliminara.
  - Desde la aplicación nada se borra en silencio: el servidor exige la [confirmación exacta](#quitas-confirmadas) de lo que se pierde, con la fila del cliente bloqueada y la versión verificada.
  - Un borrado directo en la base (fuera de la app) ya no está frenado por esta FK.
- **CHECKs:** códigos de jurisdicción, rango de la alícuota (0..100), textos no vacíos y coherencia del nomenclador provincial.

**Vigencias.** Las alícuotas viven en su propia tabla (actividad × jurisdicción). Para agregar vigencias más adelante basta con sumar `validFrom`/`validTo` y ampliar la unicidad, sin tocar `Client`.

**Catálogo de jurisdicciones.** `lib/iibb/jurisdictions.ts` usa los códigos de jurisdicción del Convenio Multilateral (COMARB), 901 = CABA … 924 = Tucumán. El sitio de la Comisión Arbitral lista CABA sin código; el 901 surge del rango 901–924 de la RG CA 3/2015. **No** son los `idProvincia` de ARCA. El domicilio que devuelve ARCA conserva su `idProvincia` aparte y no se mapea a jurisdicciones.

## Reglas de Ingresos Brutos

Están en `lib/iibb/registration.ts` y `lib/client-profile.ts`, y se validan igual en el navegador y en el servidor.

| Inscripción | Jurisdicciones | Sede |
|---|---|---|
| Local / Simplificado | exactamente 1 | no |
| Convenio Multilateral | 1 o más (sin mínimo de 2) | obligatoria, entre las elegidas |
| Exento | 1 o más | no |
| No Inscripto | 0 o más, rotuladas «jurisdicciones de actividad» (no son inscripciones) | no |

Reglas generales:
- No hay opción preseleccionada («Sin clasificar») y no se infiere nada de la condición de IVA.
- **Quitar información guardada exige una confirmación EXACTA** (ver [Quitas confirmadas](#quitas-confirmadas)).
- **Alícuotas:** sólo para jurisdicciones de la ficha, sin duplicados. Usan el mismo formato que `parseRate`: 0..100, hasta 6 decimales.
- **Códigos de actividad:** se guardan tal como se cargan, sin equivalencias automáticas entre nomencladores.

## Quitas confirmadas

La base de cada confirmación es lo **guardado**, no sólo lo que se ve en pantalla.

- **Jurisdicción guardada con asociaciones.** Se confirma con `{ code, associations }`: `associations` son las `activityKey` de **todas** sus asociaciones guardadas. Cuenta incluso si antes, en el mismo formulario, se quitó la actividad o se destildó la asociación.
- **Actividad guardada.** Se confirma con `{ key, jurisdictions }`: las jurisdicciones con alícuota guardada.
- **Diálogo.** Enumera cada dato que se pierde:
  - lo guardado, con su alícuota (`3.5 %`, `0 %` o «sin informar»);
  - aparte, lo visible sin guardar.
- **Mismo cálculo en los dos lados.** El formulario lo calcula sobre lo guardado al abrirse (`lib/client-profile-removal.ts`). El servidor lo calcula sobre la fila bloqueada, con la misma función `unconfirmedRemovals`.
- **Coincidencia exacta.** Si el conjunto confirmado no coincide con lo que realmente se pierde, el servidor responde 422 y no borra nada. Pasa si falta un elemento, si sobra uno o si otra persona agregó una asociación después del aviso.
- **Invalidación.** Volver a agregar la jurisdicción o la actividad invalida su confirmación. Antes de enviar, el formulario aplica la misma regla y, si algo cambió, vuelve a mostrar el aviso.

## Concurrencia de la edición

Concurrencia optimista sobre el cliente **completo**: campos generales, contactos y ficha IIBB. Es la misma convención que comprobantes y períodos.

1. **La página de edición lee primero `Client.updatedAt` y después la ficha IIBB.** Una ficha más nueva que la versión leída sólo puede terminar en 409, nunca en datos viejos aceptados.
2. **Todo `PATCH /api/clients/[id]` envía `expectedUpdatedAt`** (ISO exacto con milisegundos). Si falta o es inválido: 422 `expectedUpdatedAt`.
3. **Dentro de la transacción** (opciones por defecto de Prisma; las de 5 s / 10 s están reservadas a los writers del período):
   1. `SELECT … FROM "Client" WHERE id AND organizationId FOR UPDATE` (`lib/client-lock.ts`). Si es de otra organización o no existe: 404 idéntico.
   2. `updatedAt` distinto del esperado: **409 `CONFLICT` con `field: "expectedUpdatedAt"`**, antes de cualquier escritura o auditoría.
   3. Luego las validaciones de contactos y de quitas (422), la escritura y un único AuditLog.
4. **Avance de versión.** Toda escritura efectiva avanza `updatedAt` a `max(ahora, versión bloqueada + 1 ms)`, también si sólo cambió la ficha IIBB. La columna es `TIMESTAMP(3)`, así que el avance es estrictamente monotónico aunque el reloj esté atrasado. Sin cambios efectivos: 200 sin escritura, sin auditoría y sin avanzar la versión.
5. **El token nunca se renueva solo.** Ante un 409 el formulario:
   - conserva el borrador en pantalla;
   - bloquea el reenvío;
   - ofrece «Abrir la versión actual en otra pestaña» y «Descartar mis cambios y recargar».
6. **Alcance.** La baja (`DELETE`) y el alta (`POST`) no cambian de contrato.

## Contactos

- **Formato:**
  - Email: hasta 254 caracteres.
  - Teléfono: formato internacional permitido (`+`, espacios, guiones, paréntesis), 6 a 15 dígitos.
  - Un formato válido no acredita que el dato pertenezca al cliente.
  - El email de contacto **no** es el domicilio fiscal electrónico.
- **Edición:**
  - Un contacto ya cargado no se puede vaciar (422); sólo se reemplaza.
  - En clientes históricos, la falta de contactos no bloquea editar otros campos.
- **Sin unicidad global.**
- **Nunca en la auditoría:** la auditoría guarda sólo `changedFields` (nombres de campos), `condition` e `iibbRegistration`.

## Consulta de CUIT en ARCA

> **No operativa.** El código del adaptador existe y está probado sólo con respuestas sintéticas. Sin configuración no hace llamadas de red y la UI informa «Consulta ARCA no configurada»: nunca muestra datos ficticios ni un éxito aparente. Habilitarla requiere completar [Habilitación de ARCA](#habilitación-de-arca-pendiente).

**Servicio oficial.** Padrón «Constancia de Inscripción», `ws_sr_constancia_inscripcion`, operación `getPersona_v2`. Se autentica con WSAA (`LoginCms`). No hay scraping, ni proveedores comerciales, ni Clave Fiscal.

| | Homologación | Producción |
|---|---|---|
| WSAA | `https://wsaahomo.afip.gov.ar/ws/services/LoginCms` | `https://wsaa.afip.gov.ar/ws/services/LoginCms` |
| Padrón | `https://awshomo.arca.gob.ar/sr-padron/webservices/personaServiceA5` | `https://aws.arca.gob.ar/sr-padron/webservices/personaServiceA5` |

**Endpoint: `POST /api/arca/cuit-lookup`.** El cuerpo es `{ "cuit": "..." }`.
- **Acceso:**
  - Pide sesión, organización activa y un rol que pueda crear clientes (OWNER/ADMIN/ACCOUNTANT).
  - El CUIT se normaliza con el helper existente.
- **Límites de uso:** 10 consultas por minuto por usuario y 60 por hora por organización (429 con `Retry-After`).
- **Timeout:** 8 s por llamada.
- **Respuestas:**
  - 200 `FOUND` / `NOT_FOUND` / `NOT_CONFIGURED`;
  - 504 `ARCA_TIMEOUT`;
  - 502 `ARCA_UNAVAILABLE` / `ARCA_AUTH` / `ARCA_INVALID_RESPONSE`.
- **Sin escrituras de clientes:** no crea ni modifica clientes ni persiste la respuesta. El servidor conserva sólo el ticket de autenticación cifrado en la tabla técnica; no registra secretos en logs.

Qué se propone y qué no:
- **Se propone:** nombre o razón social y domicilio fiscal. Los campos con un valor distinto requieren confirmación para reemplazarse.
- **Actividades:** se ofrecen con nomenclador ARCA, sin preseleccionar.
- **Sólo lectura:** impuestos y categoría de monotributo se muestran como información.
- **Nunca se propone:** teléfono, email, inscripción IIBB, jurisdicciones ni alícuotas.
- **En el formulario:**
  - Se muestran la fuente y la fecha de la consulta.
  - Cambiar el CUIT descarta el resultado, y las respuestas fuera de orden se ignoran.
  - La carga manual funciona siempre.

### Variables de entorno (sólo servidor)

| Variable | Uso |
|---|---|
| `ARCA_PADRON_ENABLED` | `true` para habilitar |
| `ARCA_PADRON_ENV` | `homologacion` o `produccion` |
| `ARCA_PADRON_CUIT_REPRESENTADA` | CUIT que firma las consultas |
| `ARCA_WSAA_CERT_PEM` | Certificado X.509 emitido por ARCA |
| `ARCA_WSAA_KEY_PEM` | Clave privada del certificado, preferentemente cifrada |
| `ARCA_WSAA_KEY_PASSWORD` | Contraseña si la clave PEM está cifrada |
| `ARCA_WSAA_CACHE_KEY` | Clave independiente de 32 bytes en base64 para cifrar tickets |

Ninguna de estas variables existe hoy. Sin ellas, la UI muestra «Consulta ARCA no configurada».

### Habilitación de ARCA (pendiente)

Todo lo siguiente es requisito **antes** de configurar las variables.

**Requisitos externos:**

1. **Certificado digital.** En homologación se emite con WSASS; en producción, con «Administrador de Certificados Digitales» y la clave fiscal del CUIT representado. Lo gestiona el responsable del CUIT, no esta aplicación.
2. **Asociación del servicio.** Hay que asociar el certificado al servicio `ws_sr_constancia_inscripcion` en «Administrador de Relaciones de Clave Fiscal».
3. **Preparación local implementada:** firmante CMS SHA-256 con node-forge, caché cifrada compartida en PostgreSQL e invalidación condicional (A1/A2), respuesta incompleta inválida (A3), lectura acotada en bytes (A4), profundidad máxima 64 (A5), namespaces y cierres verificados (A6), Fault estructural (A7).
4. **Pendiente:** certificado y autorización reales, migración de la tabla de tickets en DEV/PROD, secretos del servidor y homologación. No está habilitada ni publicada esta preparación.

Guía operativa: [alta y homologación](../arca/ALTA-Y-HOMOLOGACION.md).

## Limitaciones

- **Límite de uso en memoria por instancia.** En funciones serverless cada instancia lleva su propia cuenta: es un freno contra el abuso, **no una protección global garantizada**. El ticket WSAA de esta preparación local usa un almacén PostgreSQL compartido y cifrado.
- **Parser XML mínimo y propio.** Rechaza DOCTYPE, usa sólo entidades predefinidas y tiene un tope de 512 KB.
- **Manual del servicio.** Se revisó el manual oficial v4.1 de marzo de 2026. Las pruebas siguen siendo sintéticas y locales; falta homologación real.
- **Conflicto de edición sin comparación campo a campo.** Ante un 409 el usuario reaplica sus cambios sobre la versión actual; no hay una fusión automática.
- **La versión es la del cliente completo.** Un cambio de otra persona en cualquier campo invalida los formularios abiertos, aunque toquen campos distintos.
- **Bloqueo sin `lock_timeout` propio.** Una edición concurrente espera el bloqueo de la fila dentro del `timeout` por defecto de la transacción interactiva de Prisma (5 s). Si se agota, la edición falla y no escribe nada.
- **Sin nomenclador NAES ni provincial.** No hay catálogo para ellos ni equivalencias con ARCA: el código se carga a mano.
- **La ficha IIBB no es una verificación oficial** ni una liquidación de Convenio Multilateral (no hay coeficientes ni distribución de base imponible).

## Formulario

Alta y edición comparten `app/(app)/clients/_components/client-profile-form.tsx`, que reemplaza al formulario de edición anterior (`edit-client-form.tsx`). Los errores de la API llevan `field`:
- `phone` / `contactEmail`: contacto inválido o pedido de vaciar uno ya cargado;
- `iibb.*`: reglas de la ficha;
- `iibb.confirmRemovedJurisdictions` / `iibb.confirmRemovedActivities`: quitas sin confirmación exacta;
- `expectedUpdatedAt`: versión ausente o inválida (422) u obsoleta (409).

## Estado y pendientes antes de publicar

- **Migración pendiente en DEV y PROD.** `20261025120000_client_profile_iibb_contacts` no está aplicada en ninguna base.
- **ARCA no configurada:** la preparación técnica local no reemplaza los requisitos externos, la migración del almacén de tickets y la homologación real.
- **Alícuotas por actividad y jurisdicción informativas.** El cálculo y las exportaciones siguen usando `defaultIibbRate` sin cambios.
- **Pruebas pendientes en DEV** (las automáticas usan una base simulada):
  - **Concurrencia real contra PostgreSQL:**
    - dos ediciones simultáneas del mismo cliente: espera del `FOR UPDATE` y 409 de la segunda;
    - formulario viejo tras un cambio de ficha;
    - avance de `updatedAt` al cambiar sólo la ficha;
    - las CHECK y la FK en cascada de la migración (ya probadas contra PostgreSQL 17 local: `scripts/pg-local-regression.sh`).
  - **Prueba visual del formulario:**
    - opciones de inscripción;
    - sede en CM;
    - varias actividades y alícuotas, distinguiendo 0 de «sin informar»;
    - avisos de quita;
    - recuperación ante un 409;
    - aviso «Consulta ARCA no configurada».
- **Timeout transaccional.** La edición usa los valores por defecto de la transacción interactiva de Prisma (`maxWait` 2 s, `timeout` 5 s), sin `lock_timeout` propio. Una espera de bloqueo mayor hace fallar la edición sin escribir.

## Despliegue (cuando se autorice)

1. Revisión, commit local y push/PR con autorización.
2. Migración en DEV **antes** de probar la Preview.
3. Pruebas en DEV (las de [Estado y pendientes](#estado-y-pendientes-antes-de-publicar)).
4. Preparación y migración en PROD (runbook con backup y verificación) **antes** del merge.
5. Merge y deploy.

El código nuevo falla al leer las columnas nuevas si la migración no está aplicada; el código actual de `main` funciona con el esquema migrado (columnas nuevas nullable).
