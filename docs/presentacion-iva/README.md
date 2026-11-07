# Presentación de IVA — clasificaciones, cierre versionado y paquete para ARCA

Rama `feature/iva-exportacion-cierre` (sale de `feature/liquidacion-ajustes-credito-fiscal`, PR #32, que a su vez incluye #33).
Migración `20261107120000_vat_export_close_versions`, aditiva, aplicada en DEV el 06/11/2026 ([DEV-MIGRACION.md](DEV-MIGRACION.md)).

**Orden a main:** #33 (Tique Factura A 081) → #32 (ajustes al crédito fiscal) → esta rama (PR #34).
El PR #34 tiene base `main` para generar su Deploy Preview, así que incluye también los commits de #33 (`1989e6e`) y de #32 (`3ac69dc`, `7653d10`, `2891b98`). No se mergea antes que ellos. Diff sólo de esta etapa: `git diff 2891b98...feature/iva-exportacion-cierre`.

La aplicación **genera** los archivos, la conciliación y el resumen. **No** sube archivos a ARCA ni presenta declaraciones.

## Circuito

| Paso | Dónde | Estado |
|---|---|---|
| 1. Importar ventas y compras | Período → Importar (Libro IVA Digital TXT o descarga de Portal IVA) | Ya existía (#25, #33) |
| 2. Cargar o editar comprobantes faltantes | Ventas / Compras → Nuevo | Ya existía |
| 3. Retenciones y percepciones con su detalle del F.2051 | Retenciones/Percepciones | **Nuevo** detalle; percepción tomada de una compra |
| 4. Revisar controles y clasificar | Período → **Presentación ARCA** | **Nuevo** |
| 5. Saldos anteriores y ajustes | Liquidación → Ajustes y saldos | **Nuevo**: libre disponibilidad anterior |
| 6. Determinación | Liquidación, Excel y paquete: **un único motor** (`lib/liquidation-calc.ts`) | Ampliado |
| 7. Cerrar | Período → Cerrar | **Nuevo**: guarda una versión con el paquete |
| 8. Descargar | Presentación ARCA → borrador (abierto) o versión final (cerrado) | **Nuevo** |
| 9. Reabrir | Período → Reabrir (con motivo) | **Nuevo**: la versión queda reemplazada y auditada |

**Descargas de ARCA:** desde el 06/11/2026 también se importan, con lectores probados con muestras sintéticas que reproducen la forma de las descargas reales (ver «Descargas de ARCA»):
- Mis Comprobantes;
- percepciones de IVA.

## Fuentes oficiales (consultadas el 06/11/2026)

| Documento | URL | sha256 | Uso |
|---|---|---|---|
| Libro IVA Digital – Anexo I – Diseños de registros | https://www.arca.gob.ar/iva/documentos/libro-iva-digital-diseno-registros.pdf | `d8ea46d0…ba1571`, igual que el 03/11 | Posiciones de los TXT |
| Libro IVA Digital – Especificaciones, revisión 30/07/2025 | https://www.arca.gob.ar/iva/documentos/Libro-IVA-Digital-Especificaciones.pdf | `ce75f7d6…3a020` | Reglas de escritura (ver abajo) |
| IVA simple – Especificación de Importaciones Apertura de otros conceptos | https://www.arca.gob.ar/iva/documentos/LID-Ajustes-y-otros-conceptos-para-generar-la-DJ.pdf | `09f5db75…151e0` | Los 4 CSV |
| F.2051 – Especificación de importaciones (12/11/2025) | https://www.arca.gob.ar/iva/documentos/F2051-IVA-especificacion-de-importaciones.pdf | `cef374e0…3a823` | Retenciones, percepciones y percepciones aduaneras |
| Aplicativo IVA – Instructivo 19.0.0 (14/11/2014) | https://www.afip.gob.ar/aplicativos/IVA/documentos/dit.iva.AP_INS_IVA-19.0.0.pdf | `ad71bc6c…122dd` | Significado de «Débito Fiscal O.D.P.» |
| IVA Simple – Confección, Retenciones y percepciones, Presentación | https://www.arca.gob.ar/iva/iva-simple/ | — | Circuito y enlaces a los diseños |

**Muestras autorizadas.** Son las 3 plantillas de ejemplo de IVA Simple (`ejemplo_operaciones_cf/df/rest_df.csv`). Se leyeron, pero no están en el repositorio. Las pruebas usan datos sintéticos.

## Decisiones de interpretación

1. **«Débito Fiscal O.D.P.» es el débito de operaciones de dación en pago del Decreto 1145/09**, sólo para los beneficiarios del régimen. Así lo nombra el instructivo oficial del aplicativo de IVA: «Débito Fiscal - Operaciones dación en pago Decreto N° 1.145/09».
   - **No** se iguala al débito facturado, aunque los ejemplos del PDF y de las plantillas lo repitan.
   - Cada venta tiene la marca `dationInPayment`, que por defecto dice «no». Sólo con la marca su débito va a la columna O.D.P.
   - Sin operaciones marcadas, la columna va vacía.
2. **Encabezado de los CSV de la apertura.** El PDF no fija un encabezado. Las plantillas de IVA Simple sí lo traen, entre comillas.
   - Se escribe como en las plantillas.
   - Cada registro lleva la cantidad completa de campos del diseño; los vacíos del final se escriben, como en los ejemplos del PDF.
   - El separador de línea es CRLF y el archivo no termina en salto de línea.
   - **A verificar en la primera importación real.** Si ARCA rechazara la primera línea, quitar el encabezado: es un cambio de una línea en `lib/vat-export/iva-simple-csv.ts`.
3. **CSV del F.2051.** El diseño no prevé encabezado, así que se escriben sin él. Importes con «,» decimal; fechas en formato ISO.
4. **Tipo de operación 3 de la apertura (no gravadas o exentas, excepto exportaciones).** Lleva:
   - el exento y el no gravado del comprobante;
   - el neto al 0 % con código de operación E, N o A.

   Las exportaciones (clase E) no integran la apertura: su total va a los conceptos a cargar en ARCA. Una venta al 0 % con otro código bloquea la exportación.
5. **Tipo de sujeto comprador.**
   - Se deriva sólo de la condición frente al IVA oficial ya registrada, cuando la correspondencia es literal: 1 → RI; 6, 13 y 16 → monotributo; 4, 5 y 15 → consumidor final, exento y no alcanzado.
   - Los demás códigos (7, 8, 9 y 10), o la condición sin dato, quedan para el estudio.
6. **Restituciones.** Las notas de crédito emitidas van a «Restitución de Débito Fiscal» y las recibidas a «Restitución de Crédito Fiscal».
   - Los importes van positivos: el signo sale del código del comprobante y nunca se invierte dos veces.
   - La restitución de crédito informa el crédito **facturado**, como manda el diseño. Si la nota de crédito tiene un crédito computable parcial, queda una advertencia.
7. **Crédito computable con prorrateo global.**
   - Libro IVA Digital, campo 21: va en cero con prorrateo global y con el computable directo en «directo y global», según las Especificaciones.
   - Los valores de la pestaña «CF Computable Global» van a los conceptos a cargar.
   - La apertura de crédito por concepto **no** se genera con líneas de prorrateo global (bloqueo explicado), porque repartirlo por concepto no tiene regla oficial.
8. **Percepciones: fuente única.** La liquidación computa sólo las retenciones y percepciones **registradas**.
   - La percepción informada en una compra (campo 12) se registra «tomándola del comprobante». El importe debe coincidir y un índice único impide registrarla dos veces.
   - Mientras no se registre, queda una advertencia: no se computa ni se duplica.
9. **Retención o percepción:** sale del tipo, que es un catálogo cerrado. La percepción aduanera sale de la naturaleza.
   - El saldo de libre disponibilidad anterior, las retenciones y las percepciones sólo cancelan el saldo técnico a favor de ARCA.
   - El excedente es saldo a favor de libre disponibilidad, distinto del saldo técnico a favor, que se traslada.

## Archivos del paquete (ZIP)

| Archivo | Formato | Si no hay datos |
|---|---|---|
| `LIBRO_IVA_DIGITAL_VENTAS_CBTE.txt` / `_ALICUOTAS.txt` | 266 / 62 posiciones, ISO 8859-1, CRLF | Se omite; el libro va sin movimientos |
| `LIBRO_IVA_DIGITAL_VENTAS_TURIVA_*` | 281 / 62 | Se omite |
| `LIBRO_IVA_DIGITAL_COMPRAS_CBTE.txt` / `_ALICUOTAS.txt` | 325 / 84 | Se omite. Si todas son B o C, va sólo la cabecera |
| `LIBRO_IVA_DIGITAL_COMPRAS_TURIVA_*` | 340 / 84 | Se omite |
| `IVA_SIMPLE_DEBITO_FISCAL.csv` | 8 campos | Se omite |
| `IVA_SIMPLE_RESTITUCION_DEBITO_FISCAL.csv` | 7 campos | Se omite |
| `IVA_SIMPLE_CREDITO_FISCAL.csv` | 5 campos | Se omite |
| `IVA_SIMPLE_RESTITUCION_CREDITO_FISCAL.csv` | 4 campos | Se omite |
| `F2051_RETENCIONES.csv` / `F2051_PERCEPCIONES.csv` / `F2051_PERCEPCIONES_ADUANERAS.csv` | 9 / 7 / 4 campos | Se omite |
| `RESUMEN.txt` | UTF-8 | Siempre |
| `CONCEPTOS_A_CARGAR_EN_ARCA.txt` | UTF-8 | Siempre |
| `LEEME.txt` | UTF-8 | Siempre |

**`RESUMEN.txt`** incluye:
- identificación: cliente, CUIT, período, versión, fecha de generación, versión del motor y huella del contenido;
- la determinación;
- la conciliación de los archivos contra el motor (débito, crédito, retenciones);
- la huella sha256 de cada archivo incluido, y los omitidos con su motivo;
- los controles.

**`LEEME.txt`** da el orden de importación en el Portal IVA.

**Borrador.** El ZIP se llama `BORRADOR_IVA_<CUIT>_<AAAAMM>.zip` y sus textos llevan el prefijo `BORRADOR_` y el aviso «NO PRESENTAR».

**Final.** El ZIP se llama `IVA_<CUIT>_<AAAAMM>_v<n>.zip`. Se genera **sólo en el cierre** y se descarga con los bytes guardados.

Se omiten los archivos vacíos porque ARCA no documenta la importación de un archivo sin registros. Cada omisión figura en el resumen.

**Reglas de escritura del Libro IVA Digital (Especificaciones):**
- importes positivos de 15 posiciones, con centavos implícitos;
- numéricos con ceros a la izquierda y texto con blancos a la derecha (la denominación se recorta a 30);
- PES con tipo de cambio `0001000000`;
- cantidad de alícuotas 0 para compras B y C;
- código de operación sólo con alícuota 0 (si no, «0»);
- una operación sin IVA lleva una alícuota 0003 con neto 0;
- despacho, emisor/corredor e IVA comisión en ceros o blancos;
- el mismo orden de comprobantes en la cabecera y en las alícuotas.

## Conceptos que se cargan a mano en el Portal IVA

`CONCEPTOS_A_CARGAR_EN_ARCA.txt` los lista con sus valores:
- crédito fiscal por contribuciones a la Seguridad Social: Anexo I Ley 27.541 y Art. 91 Ley 27.467 (contribuciones y computable);
- saldo técnico a favor del período anterior y saldo de libre disponibilidad anterior, con su referencia;
- retenciones y percepciones: importar los CSV o validar las precargadas por SIRE/SICORE, **sin duplicar**;
- total de exportaciones;
- con prorrateo, la pestaña «CF Computable Global».

**No previstos por la aplicación:**
- pagos a cuenta;
- crédito fiscal por otros conceptos (POS, Ley 27.618);
- ajuste anual del prorrateo;
- ajustes al débito por perfeccionamiento del hecho imponible;
- débito fiscal por otros conceptos;
- restituciones por bienes usados.

## Controles (pantalla «Presentación ARCA»)

| Nivel | Ejemplos | Efecto |
|---|---|---|
| Impide importar / pendiente de revisión | Fila con error o para revisar en la vista previa | Se resuelve en la importación: no llega al período |
| Impide liquidar | Falta el coeficiente de prorrateo global | No hay liquidación ni paquete |
| Impide exportar | Venta sin actividad, tipo de operación o sujeto; compra sin concepto; código de operación faltante; denominación no ANSI; retención sin datos del F.2051; prorrateo global en la apertura | El borrador omite el archivo afectado; el cierre guarda la versión **sin** paquete |
| Advertencia | Percepción de compra sin registrar; nota de crédito con crédito parcial; denominación recortada; moneda distinta de pesos | No bloquea |

**Clasificación por lote:**
- ventas: actividad, tomada de la ficha con nomenclador ARCA; tipo de operación; tipo de sujeto; dación en pago;
- compras: concepto del crédito;
- ambas: código de operación, sólo al 0 % o sin IVA.

Nada se completa solo: «Sin cambios» no toca el dato y «Quitar» lo vuelve a dejar pendiente. Se aplica hasta de a 500 comprobantes por vez, con `lockPeriodForWrite`.

## Cierre, versiones y reapertura

**Cierre** (OWNER, ADMIN, ACCOUNTANT, OPERATOR). En la **misma transacción** y bajo el mismo `FOR UPDATE` del período que toman todas las escrituras:
- carga el período en lotes;
- calcula con el motor único;
- arma el paquete final si no hay bloqueos;
- guarda `PeriodLiquidationVersion` con el número de versión, el actor, la versión del motor, la huella del contenido, el resumen en JSON y el ZIP con su sha256.

Ninguna edición ni importación se intercala. Una que llega durante el cierre recibe `409 PERIOD_CLOSED` o `PERIOD_BUSY`.

La transacción tiene un timeout de 40 s, inventariado como la importación. En local, cerrar 7.500 ventas tarda 1 s.

**Versión final.** Se descargan los bytes guardados en el cierre. Antes de entregarlos se verifica:
- el sha256 del ZIP;
- que la huella del contenido actual coincida con la del cierre (si no, 409).

La ficha del cliente puede editarse con el período cerrado sin alterar el paquete: su identificación al cierre queda en el resumen.

**Reapertura** (OWNER, ADMIN; nunca OPERATOR):
- el motivo es obligatorio, de 5 a 500 caracteres;
- la versión vigente queda **reemplazada**, con fecha, quién y el motivo, y se conserva con su paquete;
- el AuditLog `period.reopen` registra el número de versión y la longitud del motivo;
- un nuevo cierre genera la versión n+1.

A lo sumo hay una versión vigente por período (índice único parcial). Un período con versiones no se elimina.

## Permisos y seguridad

Cada página y API exige organización activa, módulo IVA, cliente en el alcance (si no, 404) y el rol que corresponde:
- leer y descargar: todos los roles;
- clasificar y cargar: OWNER, ADMIN, ACCOUNTANT, OPERATOR;
- cerrar: los mismos;
- reabrir: OWNER, ADMIN.

El Operador conserva su alcance por clientes asignados y no reabre.

**Tabla nueva:** RLS sin políticas y sin privilegios para PUBLIC ni para los roles anon, authenticated y service_role.

**AuditLog sin importes ni CUIT de contrapartes:**
- `invoice.classification_change`: conteo y nombres de campos;
- `vat.package.export`: modo, versión y sha256;
- `period.close` y `period.reopen`, con la versión.

## Pruebas

**Exportadores y controles.** `tests/vat-export.test.ts`, 25 casos, se verifican con lectores **independientes** del escritor:
- el lector del importador (`parseLidFile` + `buildImportPreview`) lee los TXT de ida y vuelta, todo importable y con los mismos importes;
- se controlan posiciones fijas del Anexo I, verificadas a mano;
- un parser CSV y un lector ZIP propios de la prueba (CRC con `node:zlib`) leen los demás archivos;
- se controlan los totales contra el motor, los signos de las notas de crédito, ANSI, longitudes y un ZIP determinista.

**Circuito.** `tests/integration/vat-export-close-pg.test.ts` corre contra PostgreSQL, por las rutas reales y con datos sintéticos:
- importación, clasificación (roles, alcance, otra organización, reglas por categoría y CHECK de la base);
- percepción vinculada sin duplicar (importe exacto, índice único, FK RESTRICT);
- posición con saldos anteriores;
- borrador, cierre con paquete y descarga final reproducible (bytes idénticos), contenido de los archivos leído de forma independiente;
- período cerrado sin escrituras; ficha editada sin efecto sobre lo cerrado; contenido alterado por fuera, rechazado;
- reapertura con motivo y versión 2; cierre concurrente con una clasificación;
- un período con versiones no se borra; RLS y privilegios;
- con `LID_VOLUME=1`, 7.500 ventas: cierre y paquete con 7.500 registros.

**Analizador de bloqueos:**
- las versiones sólo se escriben en las transiciones (`LIQUIDATION_VERSION_WRITE_OUTSIDE_TRANSITION`);
- el timeout del cierre está inventariado;
- la clasificación por lote es un writer inventariado.

## Límites y pendientes

**Retenciones de IVA:** se importan desde la descarga de ARCA o desde el archivo de importación del F.2051 (ver «Retenciones de IVA» más abajo). La escala de los importes sin decimales no está documentada: esas filas quedan para revisar salvo confirmación explícita.

**Formatos no generados:**
- importaciones (despacho), importación de servicios, bienes usados, liquidaciones de granos e intermediarios: no se modelan;
- rangos agrupados de comprobantes.

**Prorrateo global:** la apertura de crédito computable por concepto se carga en ARCA.

**Reglas de ARCA no verificadas por la app:**
- la vigencia del régimen y la ventana de fechas de retenciones y percepciones las valida ARCA al importar;
- el código de régimen lo informa el estudio.

**Encabezado de los CSV de la apertura:** a confirmar con la primera importación real (decisión 2).

**IIBB:** sigue siendo informativo y no se congela con el cierre.

**Automatización de ARCA:** ver [AUTOMATIZACION.md](AUTOMATIZACION.md).

## Descargas de ARCA (muestras observadas el 06/11/2026, período 10/2026)

Las muestras se leyeron en un directorio aislado. No hay datos reales en el repositorio ni en las pruebas.

### Mis Comprobantes

Formato «Mis Comprobantes» en Importar, emitidos = ventas y recibidos = compras. Lector: `lib/libro-iva-import/mis-comprobantes-csv.ts`.

- **Forma observada:** el ZIP con un CSV UTF-8 sin BOM, separado por `;`, con encabezado entre comillas, salto LF, fecha `AAAA-MM-DD` y decimal `,`. Hay 28 columnas en emitidos y 30 en recibidos (documento del emisor y del receptor). Para cada alícuota, el neto y el IVA vienen en columnas separadas; además trae «Otros Tributos», «Total IVA» e «Imp. Total».
- **Impuestos incluidos:** IVA por alícuota, no gravado, exento y «Otros Tributos». **No trae percepciones de IVA separadas, código de operación ni crédito computable.**
- **Signo:** las notas de crédito vienen **positivas** (a diferencia de la descarga de Portal IVA). El signo sale del código, como en el TXT.
- **Reglas que aplica la app:**
  - el encabezado se valida exacto;
  - en recibidos, el receptor debe ser el cliente (si no, error);
  - «Otros Tributos» queda como otros tributos, con una nota: puede incluir percepciones, que no se computan hasta registrarlas;
  - el crédito computable es igual al IVA **sólo** sin prorrateo; con prorrateo, la fila queda para revisar.
- **Resultado con la muestra de octubre:**
  - emitidos: 21 filas, 19 importables y 2 para revisar (denominación vacía);
  - recibidos: 25 filas, 22 importables y 3 para revisar: tipos 18 y 63, fuera del catálogo admitido, y un total que no cierra.

### Percepciones de IVA

Archivo `Percepciones-impositivas-AAAAMM.csv`, en Retenciones y percepciones → Importar. Lector: `lib/tax-import/perceptions-csv.ts`.

- **Forma observada:** sin encabezado, `;`, LF y **8 campos**: régimen · un campo sin documentar (observado `0`) · CUIT del agente · CUIT intermediario (vacío) · fecha ISO · tipo de comprobante · número (16 dígitos, sin guion) · importe con **punto** decimal.
- **Discrepancia con el diseño de IMPORTACIÓN publicado del F.2051** (12/11/2025): ese diseño tiene **7 campos** e importe con **coma**. El lector acepta sólo la forma observada (y la coma); si el segundo campo no es `0`, la fila queda para revisar.
- **El exportador del F.2051 no se cambió:** sigue el diseño publicado mientras no haya evidencia de qué acepta el Portal IVA. También queda por confirmar el número de 16 dígitos frente al formato `99999-99999999` de la tabla para el tipo 1.
- **Reglas de la importación:**
  - con fecha fuera del período, la fila queda para revisar (la imputación según RG 5750 se carga a mano);
  - con tipo fuera de la tabla del F.2051, queda para revisar;
  - una percepción ya registrada se omite;
  - una fila repetida en el archivo es un error;
  - la confirmación vuelve a calcular todo bajo el bloqueo del período, con token y AuditLog `taxrecord.import` (sin importes ni CUIT).
- **Resultado con la muestra de octubre:** 1 percepción importable. Si se usa en septiembre, queda para revisar por la fecha: octubre no se mezcla con la conciliación de septiembre.

### Retenciones de IVA

Archivo `Retenciones-AAAAMM.csv` o el archivo de importación del F.2051, en Retenciones y percepciones → Importar → «Retenciones con certificado». Lector: `lib/tax-import/retentions-csv.ts`. Muestras observadas: dos archivos del período 09/2026.

- **Formas aceptadas** (sin encabezado, `;`, todas las filas con la misma cantidad de campos):
  - **diseño de importación del F.2051, 9 campos:** impuesto · régimen · CUIT del agente · CUIT intermediario · fecha · tipo de comprobante · número · certificado · importe;
  - **descarga de ARCA, 10 campos:** la misma secuencia con un campo sin documentar después del régimen (observado `0`, como en percepciones).
- **Validaciones:**
  - impuesto 767 o 216, y si no, error;
  - CUIT del agente (y del intermediario, si viene) con dígito verificador;
  - fecha ISO válida y dentro del período, y si no, revisar;
  - tipo de comprobante de la tabla del F.2051 y número con el formato de ese tipo, y si no, revisar;
  - certificado obligatorio;
  - importe positivo.
- **Importes sin decimales:** en las muestras no se puede saber si son pesos enteros o centavos. La fila queda **para revisar** salvo que el usuario marque «Confirmo que los importes sin decimales del archivo son pesos enteros»; la confirmación cambia el token de la vista previa.
- **Duplicados:** la clave es agente + certificado.
  - Una retención ya registrada para el cliente, en cualquier período, se omite. Eso vale entre las dos formas: el mismo certificado en el diseño y en la descarga es la misma retención. En la base, además, lo impide el índice único `TaxRecord_retention_certificate_key`.
  - Una fila repetida dentro del archivo es un error.
- **Confirmación:** reutiliza el circuito de percepciones:
  - permisos de alta, `lockPeriodForWrite` (409 si el período está cerrado u ocupado);
  - relectura bajo el bloqueo y comparación del token;
  - `createMany` con el detalle completo del F.2051;
  - AuditLog `taxrecord.import` con la forma, los conteos y la huella del archivo, sin importes, CUIT ni certificados.
- **Filas no importadas:** se muestran aparte («Pendientes (no se importan)») con su estado y motivo, y su total queda fuera del total importado. Siguen visibles después de confirmar.
- **Resultado con las muestras de septiembre** (sólo agregados):
  - el primer archivo tiene 2 filas para revisar por importe sin decimales, que pasan a 2 importables con la confirmación;
  - el segundo da duplicados después del primero, y para revisar si se usa en octubre.

## Evidencia y validación

- Smoke en la Deploy Preview, separado por interfaz y por API, con metadatos de Netlify: [SMOKE-PREVIEW.md](SMOKE-PREVIEW.md).
- Procedimiento para validar que ARCA acepte los archivos, sin presentar: [VALIDACION-ARCA.md](VALIDACION-ARCA.md).
- **Huella del contenido.** Usa un esquema versionado (`v1`, con campos explícitos). Las versiones cerradas antes de `v1`, sin `summary.hashScheme`, se verifican con el esquema `v0`, que se conserva sin cambios.
