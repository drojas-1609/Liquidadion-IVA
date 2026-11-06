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
