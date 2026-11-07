# Smoke en la Deploy Preview de #34 (06/11/2026)

| Dato | Valor |
|---|---|
| Preview | https://deploy-preview-34--derocompanygestion.netlify.app, deploy `6aee085b…`, contexto `deploy-preview`, commit `ca347b5` |
| Sesión | OWNER de DEV, iniciada por el titular en su Chrome |
| Datos | Sólo sintéticos: cliente **CLIENTE SINTETICO SMOKE PR34** (CUIT 30-79999900-1, id `cmw5cv32v…`) y período **01/2027** (id `cmw5cv7eq…`). Archivos generados con `tests/helpers/libro-iva-synth.ts`, independiente del exportador |
| No se tocó | El período 09/2026 del cliente real: 43 comprobantes sin clasificar, sin retenciones ni versiones; últimas escrituras 04:06 y 14:02 UTC, anteriores al smoke. Tampoco hubo ninguna acción en ARCA |
| Verificación de DEV | Lecturas en DEV (`esyfpakajthdifhnhcew`) por el conector de Supabase, sólo `SELECT` |

## Recorrido

| # | Paso | Vía | Resultado | Evidencia en DEV |
|---|---|---|---|---|
| 1 | Alta del cliente con actividad ARCA 620100 | API (`POST /api/clients`) desde la página | 201 | Cliente, `ClientActivity` ARCA 620100 |
| 2 | Alta del período 01/2027 | API (`POST /api/periods`) | 201 | Período OPEN, `period.create` |
| 3 | Importación de ventas y compras (TXT sintéticos) | API (preview y confirm de la importación) | 2 + 2 importados, 0 en revisión o con error | 4 comprobantes; 2 `invoice.import` |
| 4 | Controles de «Presentación ARCA» | **Interfaz** | 7 impiden exportar y 1 advertencia de percepción, como se esperaba | — |
| 5 | Clasificación de las 2 ventas (actividad, tipo 1, RI) | **Interfaz**: casillas, selectores y «Aplicar» | «Clasificados 2 comprobantes»; bloqueos de 7 a 1; unos 10 s | Columnas cargadas; `invoice.classification_change` |
| 6 | Concepto de la compra (servicios) | API (`PATCH …/invoice-classification`) | 200; 0 bloqueos | `invoice.classification_change` |
| 7 | Percepción tomada de la compra | API (`POST /api/taxes`) | Con otro importe, 422 `amount`; correcta, 201; duplicada, 409 | Una sola percepción, vinculada |
| 8 | Retención con certificado | API | CUIT de agente inválido, 422 `agentCuit`; correcta, 201; certificado repetido, 409 | Una retención |
| 9 | Saldo técnico anterior 50, libre disponibilidad 20, Anexo I computable 73 | API (`PUT …/vat-position`) | 200 | Settings y ajuste; `period.vat_position_change` |
| 10 | Pantalla del período | **Interfaz** | Saldo técnico a favor 39,00, más 150,00 de libre disponibilidad | — |
| 11 | Borrador | API (`GET …/vat-package?mode=draft`) | 200, 5.408 bytes | `vat.package.export` (DRAFT) |
| 12 | Cierre | **Interfaz**: «Cerrar período» y «Sí, cerrar» | «Período cerrado» | Versión 1 con paquete de 5.490 bytes, sha256 `9dcc8dd8…`; conciliaciones OK; `period.close` con `packageReady: true` |
| 13 | Versión final, dos veces | API desde la página | 200 y 200, mismo sha256 `9dcc8dd8…`, igual al guardado | `vat.package.export` (FINAL) |
| 14 | Borrador con el período cerrado | API | 409 | — |
| 15 | Reapertura con motivo | **Interfaz**: «Reabrir período», motivo y «Sí, reabrir» | Período abierto; versión final, 409 | Versión 1 reemplazada con quién y el motivo; `period.reopen` con versión 1 y longitud del motivo 57 |
| 16 | Nuevo cierre | API | Con un token viejo, 409; con el vigente, versión 2 con paquete | Versión 2 vigente, misma huella de contenido que la 1, paquete `cfa46982…` |

## Conciliación de los archivos exportados (versión 1)

El ZIP se abrió en el navegador con un lector propio (directorio central y `DecompressionStream("deflate-raw")`), que no comparte código con el escritor.

| Control | Archivos | Motor |
|---|---|---|
| Longitudes de registro | ventas 266 / 62, compras 325 / 84, CRLF | — |
| Débito: Σ IVA de las alícuotas de ventas con el signo del código (210 + 105 − 21) | 294,00 | 294,00 |
| Crédito: Σ campo 21 de compras | 210,00 | 210,00 |
| IVA Simple: débito − restitución (315 − 21) | 294,00 | 294,00 |
| IVA Simple: crédito computable | 210,00 | 210,00 |
| F.2051: retención 100 + percepción 30 | 130,00 | 130,00 |

**Contenido de los archivos:**
- La compra C va con 0 alícuotas y no entra en el CSV de crédito.
- La columna O.D.P. va vacía.
- Las monedas van como PES con tipo de cambio `0001000000`.
- `RESUMEN.txt`: versión 1, las 4 conciliaciones en `[OK]`, saldo técnico a favor 39,00 y libre disponibilidad 150,00.

## Variables de Netlify (metadatos de la API, sin valores)

Se consultó la API de Netlify, en modo lectura, con la sesión guardada del CLI del titular. Sin imprimir el token ni valores, se obtuvieron nombre, contextos y alcance de cada variable, y comparaciones booleanas.

**Para el contexto `deploy-preview`:**

| Variable | Producción | Deploy Preview |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` (secreta) | con valor | **sin valor** |
| `ARCA_WSAA_CERT_PEM`, `ARCA_WSAA_KEY_PEM` (secretas) | con valor | **sin valor** (sólo existen en producción) |
| `ARCA_WSAA_KEY_PASSWORD`, `ARCA_WSAA_CACHE_KEY` (secretas) | con valor | **sin valor** |
| `ARCA_PADRON_*`, `ARCA_WSAA_CERT_CN/SHA256`, `USER_INVITE_*` | con valor | sin valor |
| `NEXT_PUBLIC_SUPABASE_URL` | proyecto PROD | **proyecto DEV** (valor legible) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | valor propio | valor **distinto** del de producción |
| `DATABASE_URL`, `DIRECT_URL` (secretas) | con valor | con valor: **ver abajo** |

**Por metadatos queda demostrado** que la Preview no recibe la clave de servicio de Supabase, el certificado ni la clave de ARCA, la clave de caché ni las variables de invitación de producción, y que su URL pública de Supabase es la de DEV.

**`DATABASE_URL` y `DIRECT_URL`: base efectiva de cada contexto.** Se resolvió con evidencia del servidor, en solo lectura, el 06/11/2026.

1. **Las máscaras de la API no sirven para comparar.** La API las enmascara en todos los contextos salvo `dev` ([Netlify, Secrets Controller](https://docs.netlify.com/build/environment-variables/secrets-controller/)). Que `deploy-preview` y `production` muestren la misma máscara no indica un valor compartido: cada contexto tiene **su propia entrada de valor** (ids `03b5b0…` y `77a2e0…` en `DATABASE_URL`; `451891…` y `4b3553…` en `DIRECT_URL`).
2. **Deploy Preview → DEV.** Todo lo que hizo el smoke en la Preview (cliente, período, comprobantes, versiones y AuditLog) quedó en DEV (`esyfpakajthdifhnhcew`), y el cliente sintético **no existe** en PROD.
3. **Production → PROD.** Hay escrituras que sólo genera la app, hechas por actores de la autenticación de PROD, y están en PROD (`bqqruaikbqculvmtirvy`):
   - `member.invite` el 05/11 22:54 UTC y `liquidation.export` el 05/11 22:23;
   - `arca.cuit_lookup` el 04/11, que **sólo puede salir del contexto `production`**: las variables de ARCA tienen valor únicamente ahí.

   Esos dos actores **no existen** en la autenticación ni en los perfiles de DEV, y esos eventos no están en DEV.
4. **Sin cambios desde entonces:** `DATABASE_URL` y `DIRECT_URL` no se modificaron desde el 08/09/2026, y el deploy de producción publicado (06/11 00:21 UTC, `main@4ebf540`) es posterior. Recibe los mismos valores.

**Conclusión:** producción usa la base de PROD y la Deploy Preview usa la de DEV.

**Falta verificar:** una escritura hecha por el deploy publicado *actual*. La última escritura de producción, del 05/11 22:54, es anterior a ese deploy. Se cierra leyendo en PROD, en solo lectura, el próximo evento de uso real de producción.

## Importadores de descargas de ARCA (06/11/2026, 21:30–22:00 UTC)

| Dato | Valor |
|---|---|
| Preview | deploy `6aee4858…`, contexto `deploy-preview`, commit `34a3cb5` |
| Sesión | OWNER de DEV (la del titular) |
| Datos | Sólo sintéticos, con **otro** cliente: **CLIENTE SINTETICO IMPORT PR34** (CUIT 30-79999800-5, id `cmw5ht3b…`) y período **10/2027** (id `cmw5ht7p…`). No se modificaron el cliente SMOKE PR34 ni el período 09/2026 |
| Verificación de DEV | Sólo `SELECT`. Desde las 21:00 UTC no hay escrituras en `Invoice`, `TaxRecord`, `Period` ni `AuditLog` fuera del período de prueba |

### Por interfaz

Archivos cargados con el selector de archivos de la pantalla.

| Paso | Resultado |
|---|---|
| Mis Comprobantes **emitidos** (ZIP) | Vista previa: 5 comprobantes, se importan 2, revisar 1, error 2. FC A 4-101 se importa con **sus** alícuotas; su repetición en el archivo da error («comprobante repetido en el archivo»); la fila con fecha 28/09 da error de período; la FC B sin denominación queda para revisar; la NC A 4-5 resta **una vez** (−121). Confirmación parcial con la casilla: importados 2, no importados 3 |
| Libro IVA Digital TXT (ventas) con la misma FC 4-101 | «Ya cargado para este cliente: se omite»: duplicado **entre formatos** |
| Mis Comprobantes **recibidos** (ZIP) | Se importan 2, revisar 1 (tipo 63 no admitido), error 1 (el receptor no es el cliente). «Otros Tributos» 30,00 queda en **Otros tributos**, con «Percepciones IVA» en 0,00 y una nota. La NC resta una vez (−48,40). Confirmados 2 |
| Percepciones (8 campos) | Se importa 1 (30,00); la fila del 30/09 queda en «Pendientes (no se importan)» con su total (12,00) **fuera** del total importado. Al reimportar: 1 «Ya registrada» y 1 para revisar |
| Retenciones, diseño F.2051 (9 campos) | Sin confirmar la escala: se importa 1 (3.101,70) y la de importe sin decimales queda para revisar (354.480,00, excluida). Con la casilla de pesos enteros: esa se importa y la primera aparece «Ya registrada» |
| Retenciones, descarga de ARCA (10 campos) con los mismos certificados | 2 «Ya registrada»: duplicado **entre formas** |
| Liquidación | Débito 294,00 (315 − 21 de la NC); crédito 201,60 (210 − 8,40); saldo técnico 92,40. Retenciones 357.581,70 y percepciones 30,00. Si «Otros Tributos» se computara como percepción serían 60,00. Libre disponibilidad 357.519,30 = 357.611,70 − 92,40 |
| Presentación ARCA | La determinación coincide con la liquidación. Ningún control por detalle faltante del F.2051 en las retenciones y percepciones importadas. Sólo quedan los controles de clasificación de los 4 comprobantes, que impiden exportar |
| Borrador del paquete | Se leyó dentro de la página, sin guardarlo. Contiene `F2051_RETENCIONES.csv` (138 bytes) y `F2051_PERCEPCIONES.csv` (52 bytes) |

### Por SQL en DEV (sólo lectura)

- `TaxRecord` del período:
  - 2 `RETENCION IVA` / `RETENTION`, por 357.581,70, con 2 certificados;
  - 1 `PERCEPCION IVA` / `PERCEPTION`, por 30,00;
  - todas con régimen, agente y número.
- `Invoice`: compra 001 con `otherTaxesAmount` 30,00 y `vatPerceptionAmount` 0,00; las NC guardadas con total negativo.
- `AuditLog` del período: `invoice.import` 2, `taxrecord.import` 3 y `vat.package.export` 2 (descargas del borrador).

### Sólo en pruebas locales (PostgreSQL 17, `scripts/pg-local-regression.sh`)

- **Permisos:** roles sin alta de impuestos, otro estudio y cliente fuera del alcance. En el navegador sólo hay sesión OWNER.
- **Período cerrado:** `PERIOD_CLOSED` al confirmar.
- Token desactualizado y las dos formas de retenciones (`tests/integration/arca-downloads-import-pg.test.ts`).

### Hallazgos de esta prueba

1. **Corregido en `34a3cb5`:** un comprobante repetido dentro de una descarga de un solo archivo sumaba sus alícuotas a la primera aparición y dejaba ambas con error. Ahora las alícuotas se vinculan por línea. Tiene prueba de regresión.
2. **Corregido en el commit siguiente:** al confirmar retenciones o percepciones, la pantalla borraba la vista previa. Ahora conserva las filas pendientes con su motivo y deja de ofrecer «Importar».
3. **Observado, sin confirmar:** en la Preview, el primer clic en «Confirmar importación» después de marcar la casilla no siempre se registró y hubo que repetirlo. El botón queda bajo la barra flotante de Netlify, que sólo existe en las Previews.

### Pendiente por interfaz (actualizado 07/11/2026)

El 07/11 la Preview (deploy `6aee75d6…`, commit `bac5c22`) quedó en la protección de equipo de Netlify («This site is private») en las pestañas nuevas del navegador. No se inicia sesión en nombre del titular. **Sin verificar por interfaz:**
- filas pendientes visibles después de confirmar retenciones o percepciones (corregido en `4f7f0ec`; cubierto por la lógica del componente);
- rechazo `PERIOD_CLOSED` al importar con el período cerrado (cubierto en PostgreSQL local);
- edición y baja de importados, «Volver a importar los comprobantes eliminados», documento 99 y «Consultar CUIT en ARCA» (con respuestas sintéticas inyectadas en el navegador, sin credenciales);
- permisos por rol en la interfaz: hay una sola sesión OWNER (los demás roles, en PostgreSQL local).

**Primer clic que no se registró: sin atribuir todavía.** Procedimiento para comprobarlo cuando haya acceso:
1. Con el botón «Confirmar importación» en la posición donde falló, medir `document.elementFromPoint` en el centro del botón y registrar qué elemento queda arriba (el botón o la barra de Netlify).
2. Repetir con el botón en el centro de la pantalla y con el teclado (foco y Enter).
3. Registrar `pointerdown` y `click` en el documento para ver si el evento llega al botón.

Hipótesis a descartar con esa evidencia: barra flotante encima del botón; el clic llega antes del re-render que lo habilita después de marcar la casilla; desplazamiento del elemento al hacer clic por referencia.


## Smoke por interfaz del 07/11/2026 (Propietario, Browser 2)

| Dato | Valor |
|---|---|
| SHA probado | `ce0ef2f` (deploy `6aef1c3b`) hasta la confirmación de la reimportación; desde ahí `39f36ab` (deploy `6aef21de`). Los dos confirmados por la API de Netlify: el alias `deploy-preview-34` servía ese deploy en estado `ready` |
| Base | DEV. El cliente creado desde la Preview existe en DEV y no en PROD (consulta de solo lectura) |
| Datos | Cliente sintético nuevo **CLIENTE SINTETICO SMOKE2 PR34** (CUIT 30-79999700-9), período 11/2027. Septiembre 2026, los otros clientes sintéticos y el par real de 10/2026 no se tocaron |
| Coordinación | Aviso previo a las sesiones de #25 y #32; ninguna tenía escrituras previstas en DEV |

### Verificado en el navegador (Propietario)

| Paso | Resultado |
|---|---|
| Importación parcial (Mis Comprobantes emitidos) | Se importan 4, revisar 1 (B sin denominación), error 1 (fecha de otro período). En `ce0ef2f`, después de confirmar sólo quedaba la cantidad de no importados: **defecto**, corregido en `39f36ab` y verificado (tabla «No importados en esta confirmación» con las 5 filas y su motivo) |
| Retenciones y percepciones (percepciones) | 1 importada y 1 para revisar (fecha de otro período). Tras confirmar, la fila pendiente sigue visible y desaparece «Importar» |
| Edición de importado con dos alícuotas (FC A 4-201) | El formulario detallado carga las dos líneas (10,5 % y 21 %) y la identidad fija. Se corrigió la razón social y la condición. En DEV: `source` IMPORT, las dos líneas intactas, AuditLog `invoice.update` con `changedFields` y `source` |
| Reimportación del corregido | «ya cargado … modificado en la app después de importarlo: se omite»; la corrección se conserva |
| Baja de importado (FC A 4-204) | La confirmación avisa que no se anula en ARCA y que al reimportar quedará para revisar. Al reimportar: «Revisar · se eliminó de la app». Con «Volver a importar…» se importa de nuevo y el registro de eliminación se libera (en DEV, 0 filas) |
| Desglose en Ventas y Compras | Ventas: «Exento $500,00» y «Exento $-500,00» en la FC/NC sólo exentas. Compras: «Exento $200,00 + Otros tributos $30,00», con total 1.440 = 1.000 + 210 + 200 + 30. «Otros tributos» no se computa como percepción |
| Documento 99 individual | FC B 8-1, «CONSUMIDOR FINAL», número 0. El modo no viene preseleccionado y «Consultar CUIT en ARCA» se oculta con el 99 |
| Documento 99 global diaria | Sin confirmar el umbral la carga se rechaza; con la confirmación se guarda la FC B 8-10 a 50 «VENTA GLOBAL DIARIA». Un comprobante 8-20 dentro del rango, enviado por la API desde la misma sesión: 409 «Se superpone con el rango 10–50». La columna «Número» mostraba sólo el primer número: corregido en `8ac3f48` |

### Primer clic que no llegaba: atribuido con evidencia

En `ce0ef2f`, con «Confirmar importación» al pie de la página:
- `document.elementFromPoint` en el centro del botón devolvía un **IFRAME**, la barra flotante de Netlify;
- un clic real del mouse en ese punto no generó `pointerdown` ni `click` en la página ni ninguna solicitud;
- con el teclado (foco y Enter), el clic y la solicitud salieron en 12 ms.

En `39f36ab`, el contenido deja 8rem libres al final: el botón queda por encima de la barra, `elementFromPoint` devuelve el botón, y el clic del mouse produjo `pointerdown`, `click` y la solicitud en 8 ms.

Además, las respuestas de la Preview tardan entre 10 y 15 s (confirmación 201 a los 14,5 s). Esa demora también se percibe como un clic perdido, pero el clic sí llega.

### Bloqueos reproducibles

- **Acceso de Netlify:** el token de acceso de Netlify venció durante la prueba. La descarga del borrador respondió 401 (HTML de Netlify) hasta que el navegador renovó el acceso por SSO.
- **Extensión del navegador:** la extensión se desconectó varias veces y se perdió el grupo de pestañas.

### Completado después de reconectar el navegador (SHA `7fa2953`, deploy `6aef39db`; mismo código que `8ac3f48`)

| Paso | Cómo | Resultado |
|---|---|---|
| Rango en la lista | Navegador | «0008-00000010 a 00000050» |
| TXT de ventas del borrador | Navegador (ZIP leído en la página, sin guardarlo) | Registros de 266 caracteres y CRLF. Individual: 99, documento 0, «CONSUMIDOR FINAL», desde = hasta = 1. Global: 99, documento 0, «VENTA GLOBAL DIARIA», desde 10 y hasta 50, total 60.500 |
| Código de operación de los sintéticos sólo exentos | API desde la sesión (PATCH detallado) | Sin código, el Libro IVA no se generaba (el escritor se detiene con datos pendientes y el borrador lo informa). Con «E» en la FC A 4-202 y la NC A 4-10, sintéticas, el TXT sale. El par real de 10/2026 queda sin tocar, con su código pendiente |
| Consulta de CUIT | Navegador | Botón oculto con documento 99 y con un CUIT inválido. Con un CUIT válido, la llamada real responde «Consulta ARCA no configurada» (DEV no tiene credenciales). Con una respuesta FOUND sintética inyectada en la página sólo para `/api/arca/cuit-lookup`: propone la denominación; «Aplicar» queda deshabilitado hasta confirmar el reemplazo de la ya cargada; al aplicar cambia el nombre y no la condición; avisa que la condición no se deduce. La comprobación llega hasta la interfaz y el servicio sin configurar; la respuesta real de ARCA no se probó |
| Cierre del período | Navegador | DEV: CLOSED, versión 1. La lista muestra «Período cerrado: sólo consulta» y no ofrece acciones; la edición muestra el aviso de período cerrado. Tras «Sí, cerrar», el encabezado siguió en «Abierto» hasta recargar (comportamiento existente, con su botón «Recargar») |
| Rechazos con el período cerrado | API desde la sesión | Corrección detallada, baja, confirmación de percepciones y confirmación de Mis Comprobantes: los cuatro `409 PERIOD_CLOSED`. La vista previa de Mis Comprobantes informa `periodOpen: false`. En DEV no cambió nada |

### Operador

No hubo una sesión de Operador en el navegador: la única cuenta Operador activa en DEV es de una persona real y no se inicia sesión con credenciales ajenas. Evidencia sólo en PostgreSQL local (`tests/integration/imported-invoice-edit-pg.test.ts`):
- el Operador corrige un importado (200);
- `DELETE` responde 403 al Operador y al Contable;
- la lista no ofrece «Eliminar» al Operador (`tests/invoice-edit.test.ts`, `invoiceRowActions`).

### Fuera del alcance de #34 (observado)

- Formulario de clientes: al escribir sobre un campo con error, los caracteres siguientes cayeron en otros campos (CUIT «3», teléfono «0+54…», email «-…»). Con valores asignados directamente se guardó bien.
- En DEV, a las 12:49–12:50Z, el Propietario pasó la cuenta A a Operador, con cuatro clientes, desde la Preview. No lo hizo esta sesión. Afecta la limpieza de #25 y la página Usuarios de las Previews de #25 y #29, que no conocen el rol Operador. Lo decide el titular.
