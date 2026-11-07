# Importación del Libro IVA Digital (TXT) — etapa 1

Importa comprobantes de **ventas o compras** desde el par de archivos TXT del Libro IVA Digital (R.G. N° 4597): **comprobantes** (`…_CBTE`) y **alícuotas** (`…_ALICUOTAS`) del mismo período y libro. Antes de escribir hay una vista previa con errores por fila y conciliación de totales. La posición de IVA, el crédito por F.931 y la presentación quedan para sus etapas. Mis Comprobantes (CSV/XLSX) también queda pendiente: falta una muestra autorizada.

## Formatos aceptados

| Formato | Archivos | Notas |
|---|---|---|
| **Libro IVA Digital (par de TXT)** | Comprobantes + alícuotas, ventas o compras, general o TurIVA | Diseño oficial (ver abajo) |
| **Descarga de Portal IVA** | `comprobantes_periodo_AAAAMM_{ventas\|compras}_….zip` tal como se descarga, o el CSV que contiene («montos expresados en pesos») | Ver detalle debajo |
| **Mis Comprobantes** | `comprobantes_consulta_csv_{emitidos\|recibidos}_….zip` o el CSV que contiene | Ver [docs/presentacion-iva/README.md](../presentacion-iva/README.md#descargas-de-arca-muestras-observadas-el-06112026-período-102026) |

Detalle de la descarga de Portal IVA:
- **Formato:** ARCA no publica un diseño de esta descarga. Las [novedades del 19/11/2020](https://arca.gob.ar/iva/sujetos-exentos/novedades.asp) fijan `;` como separador, `,` como decimal, importes en pesos y notas de crédito en negativo. El encabezado se valida exacto: si cambia, el archivo se rechaza.
- **Signo:** las notas de crédito ya vienen negativas. El lector exige que el signo coincida con el tipo de comprobante; si no, la fila queda para revisión. Usa el valor absoluto y el signo contable sale sólo del código, así que nunca se invierte dos veces.
- **IVA:** se toman las columnas por alícuota. Si «Total IVA» o «Total Neto Gravado» difieren de su suma, el lector usa la suma y lo informa en la fila; en la descarga hay diferencias de centavos.
- **Datos que la descarga no informa:**
  - código de operación: los comprobantes sólo exentos o no gravados se importan con nota, y el 0 % gravado queda para revisión;
  - reintegro TurIVA: los comprobantes 195–197 quedan para revisión y se importan con el TXT de TurIVA;
  - denominación de algunos consumidores identificados: la fila queda para revisión.
- **Mismo control que el TXT:** usa la misma clave de duplicados, así que un comprobante ya importado por TXT queda «ya cargado» desde la descarga, y viceversa.

## Fuentes oficiales (consultadas el 03/11/2026)

- **Posiciones de los campos:** [Anexo I – Diseños de Registros](https://www.afip.gob.ar/iva/documentos/libro-iva-digital-diseno-registros.pdf) (sha256 `d8ea46d0…ba1571`).
  - Ventas (266), Ventas por TurIVA (281), Ventas – Alícuotas (62).
  - Compras (325), Compras por TurIVA (340), Compras – Alícuotas (84).
- **Reglas:** [Especificaciones, revisión 30/07/2025](https://www.arca.gob.ar/iva/documentos/Libro-IVA-Digital-Especificaciones.pdf).
  - Importes de 13 enteros y 2 decimales, con «-» en la primera posición si son negativos.
  - Archivos ANSI (ISO 8859-1 o Windows-1252).
  - Mismo orden en comprobantes y alícuotas.
  - Cantidad de alícuotas 0 para compras B y C.
  - Códigos de operación A, C, D, E, N, T, X y Z.
  - Crédito computable igual al IVA liquidado cuando el período no tiene prorrateo.
- **Tablas:** [Tablas del Sistema](https://www.arca.gob.ar/libro-iva-digital/documentos/Libro-IVA-Digital-Tablas-del-Sistema.pdf).
  - Alícuotas: 0003 = 0 %, 0004 = 10,5 %, 0005 = 21 %, 0006 = 27 %, 0008 = 5 % y 0009 = 2,5 %.
  - Comprobantes y documentos: el catálogo ya vigente en `lib/arca/catalogs.ts`.

## Primera carga

1. Abrí el período (debe estar **abierto**) y tocá **Importar Libro IVA Digital**. Lo pueden usar los roles OWNER, ADMIN y ACCOUNTANT, los mismos que cargan comprobantes.
2. Elegí **Ventas** o **Compras** y subí el TXT de comprobantes y el de alícuotas de ese libro y período, hasta 2 MB cada uno. Si el período tiene comprobantes TurIVA, cargalos aparte con su propio par de archivos (registro de 281 o 340); antes hay que activar «Incluido en el Régimen TurIVA» en el período.
3. **Vista previa.** Cada fila muestra su estado:

   | Estado | Qué significa |
   |---|---|
   | Se importa | El comprobante es válido |
   | Ya cargado | El mismo comprobante ya existe para el cliente, en cualquier período; se omite |
   | Revisar | Falta un dato o es ambiguo; no se importa |
   | Error | Contradice el diseño oficial o una regla vigente; no se importa |

4. **Conciliación.** Muestra:
   - las sumas tal como figuran en los archivos;
   - lo que se importa, separado en General, TurIVA y Consolidado, con signo contable (las notas de crédito restan);
   - el detalle por alícuota.

   Revisala antes de confirmar.
5. **Confirmar.** Si hay filas «Revisar» o «Error», hay que tildar la importación parcial. La confirmación vuelve a calcular todo con los mismos archivos. Si algo cambió desde la vista previa (otra carga, la configuración del período o los archivos), responde 409 y hay que generarla de nuevo. Un período cerrado en el medio se rechaza y no se escribe nada.
6. **Registro.** Los comprobantes quedan con origen `IMPORT`. Se registra un único AuditLog `invoice.import` con conteos, huellas sha256 de los archivos y el `operationId` de la confirmación; sin CUIT, nombres ni importes.
7. **Si la respuesta no llega** (corte de Netlify, red o recarga de la página), la pantalla consulta el resultado de esa confirmación y lo muestra (ver «Resultado de cada confirmación»).

## Resultado de cada confirmación

- **Identificador:** el navegador genera un `operationId` (UUID) antes de enviar la confirmación y lo guarda localmente. La API lo exige. Cada envío lleva además un `attemptId` propio (UUID, opcional en la API): un reintento de la misma operación es otro envío.
- **Aplicada:** existe el AuditLog `invoice.import` con ese `operationId`. Se escribe en la **misma transacción** que los comprobantes, así que si existe la importación está completa. Tiene prioridad sobre cualquier falla.
- **Fallida:** existe `invoice.import.failed` con ese `operationId`, el `attemptId` del envío y el código del error (período cerrado, período ocupado, vista previa vencida, tiempo agotado…). Se registra después de que la transacción se revirtió, y describe **ese envío**. La pantalla da la operación por fallida sólo cuando **todos** sus envíos tienen su falla registrada (o recibieron la respuesta de error de la app). Si un reintento choca con `PERIOD_BUSY` porque el envío anterior, cortado con 504, sigue escribiendo, la operación no se da por fallida.
- **En curso:** hay envíos sin resultado y el último salió hace menos de 75 s.
- **Resultado sin confirmar:** pasaron 75 s y sigue habiendo envíos sin registro. La pantalla **no** afirma que se aplicó ni que no se aplicó: el tiempo no lo prueba, y la falla se registra en modo best-effort. Muestra el `operationId` completo, conserva la operación en el navegador (también tras recargar) y ofrece «Volver a verificar», que repite la consulta con el mismo `operationId`.
- **Reintento de la misma operación:** si ya se aplicó, la API devuelve ese resultado (200, `replayed: true`) sin escribir. Lo comprueba antes del recálculo y otra vez bajo el bloqueo del período. Con otros archivos, responde 409. La pantalla reutiliza el mismo `operationId` cuando se reintenta con los mismos archivos.
- **Consulta:** `GET /api/periods/[id]/libro-iva-import?operationId=…` (sólo lectura, cualquier rol del período, filtrado por organización) devuelve el estado y las últimas confirmaciones. La pantalla las muestra en «Confirmaciones registradas en este período», también desde otro navegador.

## Cómo leer la conciliación

- **Sumas del archivo:** suman todas las filas leídas tal como figuran, **sin signo**. Una nota de crédito suma.
- **Lo que se importa:** va con signo contable. Las notas de crédito (códigos 003, 008, 013, 021, 053 y 197) restan.
- **Por tipo de comprobante:** muestra, para cada código, si suma o resta, cuántas filas hay y ambos totales.
- **Puente:** total sin signo de lo que se importa − 2 × notas de crédito = total con signo. Si no cierra, alguna fila quedó fuera; mirá «Revisar» y «Error».
- **Fuera del libro:** el saldo técnico y el de libre disponibilidad anteriores, las retenciones y percepciones sufridas y otros ajustes de la posición no vienen en el libro. Se cargan en la etapa de posición de IVA.

**Lo que el par de TXT no permite clasificar.** Hace falta para el F2002 y queda para la etapa de posición:
- en ventas, el **tipo de sujeto comprador** (responsable inscripto, monotributista, consumidor final o exento): el libro no informa la condición de la contraparte, y una factura A no la determina;
- en compras, el **concepto** del crédito (bienes, locaciones, prestaciones de servicios o bienes de uso).

**Base de IIBB.** La base que guarda la importación es neto gravado + neto sin discriminar, el mismo criterio que la carga manual. No incluye exento ni no gravado; revisarlo en la etapa de IIBB.

## Resolver filas pendientes

- **Lo que queda afuera:** la vista previa lo muestra separado de lo que se importa (comprobantes, neto, IVA y total para revisar y ya cargados), y lo resume junto al botón de confirmar.
- **Importar primero lo válido:** se tilda la importación parcial y se confirma; las pendientes no se escriben.
- **Completar después:**
  - **con otro archivo del mismo libro que traiga el dato,** por ejemplo el par TXT con la denominación. Lo ya importado aparece «Ya cargado» y sólo entran las pendientes;
  - **o por carga manual** desde la página de ventas o compras del período.
- **Volver a subir cualquiera de los archivos no agrega nada:** un comprobante ya cargado figura «Ya cargado» aunque además tenga motivos de revisión, que se muestran como detalle.
- **Faltante sin resolver:** la denominación nunca se completa sola. Si falta, la fila sigue pendiente.

## Qué queda para revisión y por qué

| Caso | Motivo |
|---|---|
| Códigos fuera del catálogo vigente (063, tiques 081–083, 033, etc.), documentos fuera del catálogo | No hay regla cargada para importarlos |
| Rango agrupado («número hasta» distinto) | No se modela en esta etapa |
| Moneda distinta de PES, o PES con tipo de cambio distinto de 1 | El modelo guarda pesos: hay que confirmar la conversión |
| Despacho de importación, emisor/corredor o IVA comisión | Importaciones y liquidaciones son otra etapa |
| Total que no cierra con sus componentes, o IVA que difiere en más de 0,01 del calculado por línea | Se muestra la diferencia |
| Alícuota 0 % sin código de operación, o la misma alícuota repetida en un comprobante | Dato ambiguo |
| Venta B sin detalle de alícuotas | No se puede determinar el débito |
| Crédito computable distinto del IVA en un período sin prorrateo | La regla oficial exige que coincidan |
| Crédito parcial con varias alícuotas, o período con prorrateo global | Asignarlo por línea es una decisión de la etapa de posición |

**Condición fiscal de la contraparte.** El formato del libro no la informa. Por eso no se evalúa la matriz normativa del alta manual y el campo queda vacío; sí se valida el formato del documento, incluido el dígito verificador del CUIT.

**Pertenencia de los archivos al cliente.** Tampoco se puede verificar: los archivos no traen el CUIT del informante. Hay que elegir el período del cliente correcto.

**Volumen.** Medido en local con libros sintéticos cerca del límite de 2 MB por archivo, por las rutas reales y contra PostgreSQL local (`LID_VOLUME=1 scripts/pg-local-regression.sh`):

| Libro | Comprobantes y líneas | Archivos | Solicitud | Respuesta de la vista previa | Vista previa | Confirmación |
|---|---|---|---|---|---|---|
| Ventas | 7.500 (15.000 líneas) | 1,92 + 0,92 MB | 3,78 MB | 2,41 MB | 0,27 s | 1,5 s |
| Compras | 6.000 (12.000 líneas) | 1,87 + 0,98 MB | 3,81 MB | 1,93 MB | 0,22 s | 1,1 s |
| Portal IVA (ventas) | 9.000 (18.000 líneas) | ZIP 0,25 MB (CSV 1,66 MB) | 0,34 MB | 2,91 MB | 0,33 s | 1,7 s |

**Límites:**
- 2 MB por archivo, así que dos archivos al máximo dan unos 5,6 MB de solicitud, por debajo de los 6 MB de Netlify Functions;
- la transacción de la confirmación tiene 40 s (única excepción inventariada al plazo de 10 s; ver `tests/_period-lock-structure.ts`);
- la respuesta de la función: en la Deploy Preview se cortó con 504 a los 30 s, antes de los 60 s documentados por Netlify.

**Medido en DEV** (Deploy Preview del 04/11/2026; función en Ohio, base en São Paulo):

| Carga | Vista previa | Confirmación | Plan | Bloqueo | Escritura | Commit |
|---|---|---|---|---|---|---|
| ZIP, 4.001 ventas | 9,4 s | 201 en 20,3 s | 3,6 s | 2,0 s | 10,5 s | 0,4 s |
| TXT, 6.001 compras | 12,8 s | 201 en 23,0 s | 3,6 s | 1,7 s | 13,2 s | 0,4 s |
| TXT, 7.503 ventas | 11,2 s | 201 en 28,8 s (un primer intento: 502 del runtime a los 13 s, sin escribir) | 5,3 s | 2,4 s | 15,9 s | 0,4 s |
| ZIP, 9.001 ventas | 10,3 s | **504 a los 30,1 s, pero la transacción se confirmó** a los 38,8 s | — | — | — | — |

- Postgres ejecuta cada lote de ~665 filas en ~70 ms; el resto es la latencia entre la función y la base (~1,1 s por lote).
- Con la región actual, el máximo práctico es de unas 7.500 filas por confirmación.
- Arriba de eso, la respuesta se corta, pero la pantalla recupera el resultado por `operationId` (aplicada o fallida según el registro; si no hay registro, «Resultado sin confirmar»). La importación es completa y atómica, y reintentarla no duplica nada.
- Mover las funciones a `gru` (São Paulo), donde están las bases de DEV y de PROD, ataca la causa. Es una configuración del sitio: afecta también a producción.

**Ensayo de recuperación tras un 504 real** (Deploy Preview contra DEV, 04/11/2026, cliente sintético, período 01/2027, CSV de Portal IVA con 9.003 ventas sintéticas en los puntos de venta 82/83). Las consultas de resultado se cortaron a propósito en el navegador hasta pasar los 75 s; la confirmación viajó normal:

| Hora (UTC) | Desde el envío | Qué pasó | Fuente |
|---|---|---|---|
| 11:57:11,16 | 0 s | El navegador envía la confirmación (operationId `1e01a35b…`, un envío) | navegador |
| 11:57:30,46 | 19,3 s | Empieza la transacción (fin del recálculo; `createdAt` de los comprobantes) | DEV |
| 11:57:42,57 | **31,4 s** | **504 de Netlify** al navegador; la pantalla pasa a «Verificando…» | navegador |
| 11:57:50,94 | **39,8 s** | AuditLog `invoice.import`: 9.001 importados, 0 ya cargados, 2 para revisar | DEV |
| 11:58:26 | 75 s | «Resultado sin confirmar», con el operationId completo y «Volver a verificar» | pantalla |
| 11:58:56 | — | «Volver a verificar» sin red: sigue sin confirmar, hora de verificación actualizada | pantalla |
| ≈11:59:00 | — | «Volver a verificar» con red: aplicada según el registro; el historial la lista como «Aplicada · 9001 · 0 · 2» | pantalla |

- **La respuesta del navegador no es el resultado de la importación.** El 504 a los 31,4 s es el corte de la puerta de enlace de la Preview; la función siguió y la importación quedó completa a los 39,8 s, **8,4 s después** de que el navegador recibió el error.
- Vista previa del mismo archivo: 13,3 s. Reintento de la misma operación con un envío nuevo: 200 `replayed` en 6,2 s, sin escribir.
- Después de recuperar: +9.001 comprobantes y +12.001 líneas de IVA en el período (las 2 filas para revisar no se importan), una sola fila `invoice.import` para la operación y 0 claves de comprobante repetidas en el cliente.
- En la Preview, el `router.refresh()` posterior recibió una redirección y Next.js hizo una navegación completa: el mensaje se perdía. Ahora el resultado confirmado se guarda en la sesión del navegador y sigue visible al recargar durante 10 minutos, o hasta la próxima vista previa o confirmación.

Cada confirmación registra en los logs de la función una línea `[libro-iva-import] confirm` con el `x-nf-request-id`, la etapa, conteos y milisegundos por fase (y el código de Prisma si falla), y devuelve `Server-Timing`.

**Datos sintéticos para el smoke:** `scripts/libro-iva-import/generate-synthetic.ts` (se niega a escribir dentro del repositorio). Guion: [SMOKE-DEV.md](SMOKE-DEV.md).

## Pruebas

- `tests/libro-iva-import.test.ts` (23 casos, sin base): posiciones del diseño, ANSI, importes negativos, vínculo con las alícuotas, errores por fila, duplicados, prorrateo, TurIVA y suma General + TurIVA = Consolidado.
- `tests/integration/libro-iva-import-pg.test.ts` (6 casos, por las rutas reales contra PostgreSQL local): organización, cliente y rol, varias alícuotas, fila inválida, segunda carga, cierre entre vista previa y confirmación, carga concurrente y TurIVA. Se ejecuta con `scripts/pg-local-regression.sh`.
- `tests/integration/libro-iva-import-volume-pg.test.ts` (opcional, `LID_VOLUME=1`): 7.500 ventas y 6.000 compras, confirmación completa y segunda carga entera como «ya cargado».
- Los archivos de prueba son sintéticos (`tests/helpers/libro-iva-synth.ts`); ningún dato es real.
