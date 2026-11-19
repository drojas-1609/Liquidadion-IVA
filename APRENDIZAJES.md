# Aprendizajes

Registro de errores y correcciones del proyecto: fecha · qué pasó · causa · regla nueva.
Leerlo antes de volver a trabajar en el flujo correspondiente.

## Importación automática desde ARCA («Importar ahora»)

### 2026-11-14 · Ventas y compras de una sociedad representada: se agotaba la espera

- **Qué pasó:** `ARCA_TIMEOUT_QUERY` en el paso `portal-open-periods` (registro de la función, 10:49).
- **Causa:** los botones de Portal IVA exponen como nombre accesible su `aria-label`
  («Sin texto (iva.…alt)»), no el texto visible. El PR #52 ancló la expresión al texto
  («^ingresar$») y dejó de encontrar el botón. Además, para una sociedad representada
  Portal IVA puede derivar a IVA Simple, que abre una declaración en borrador.
- **Regla:** los comprobantes de una sociedad representada se consultan en Mis
  Comprobantes (sólo consulta). El conector no entra a IVA Simple ni toca un borrador.
  Antes de cambiar un selector, mirar el DOM real: el texto visible no es el nombre accesible.

### 2026-11-14 · Retenciones y percepciones: `ARCA_FORMAT` sin archivo

- **Qué pasó:** `format step=tax-kind-fields` (retenciones) y `format step=tax-date-fields`
  (percepciones). No se había descargado nada: el mensaje «formato» era engañoso.
- **Causa:** en la versión anterior de Mis Retenciones el propio formulario oculta dos de
  los tres radios cuando el impuesto es 216, y los rótulos traen espacios duros. El
  conector contaba radios visibles y buscaba los campos por el texto del rótulo.
- **Regla:** ubicar los campos por su `name` en el formulario. Un control ausente es
  `ARCA_PAGE`; un período no confirmado, `ARCA_PERIOD`; `ARCA_FORMAT` queda sólo para un
  archivo vacío o excedido, e `IMPORT_REJECTED` para el rechazo del importador.

### 2026-11-14 · «Exportar a Texto» no es una descarga

- **Qué pasó:** el enlace abre el contenido en la pestaña (`text/plain` sin
  `Content-Disposition`); esperar un evento de descarga habría agotado la espera.
- **Regla:** pedir la dirección del enlace desde la página y tomar los bytes. La
  dirección repite la consulta: comprobar CUIT, período, impuesto y tipo antes de pedirla.
- **También:** sin datos, ARCA responde «No se han encontrado datos para esta consulta…»
  y no muestra el encabezado con el CUIT. Eso es «sin resultados», no un error de representación.

### 2026-11-14 · Pruebas locales que no acreditaban el recorrido real

- **Qué pasó:** dos correcciones publicadas con pruebas en verde y el mismo fallo en producción.
- **Causa:** las pruebas no ejercitaban las pantallas; los selectores se dedujeron de capturas.
- **Regla:** ante un fallo del conector, primero el registro de la función (paso y código)
  y el DOM real con una sesión abierta por el usuario; después el cambio. Las pantallas
  observadas se reproducen en `tests/_fixtures/fake-arca.ts` con datos sintéticos.

### 2026-11-14 · La corrida automática incorporaba sin mostrar nada

- **Qué pasó:** «Importar ahora» confirmaba solo las filas aptas apenas terminaba la descarga.
- **Regla:** descarga -> vista previa -> confirmación explícita, por fuente. El calendario
  también termina en vista previa. La primera corrida de un cliente nunca incorpora sola.

### 2026-11-14 · Ventas a consumidor final: todas para revisar

- **Qué pasó:** las 7.113 ventas B de octubre quedaron pendientes porque Mis Comprobantes
  no informa denominación para el documento 99.
- **Regla:** la leyenda «CONSUMIDOR FINAL» es una sugerencia que la persona acepta al
  confirmar; completa sólo la denominación. No se infieren alícuotas, códigos de operación
  ni importes para cerrar una fila: lo que el archivo no informa queda pendiente con su motivo.

### 2026-11-15 · Las filas pendientes no se podían corregir ni incorporar

- **Qué pasó:** en producción, un cliente incorporó ventas y compras, pero 1.033 filas quedaron
  pendientes (1.022 ventas, 11 compras) sin forma de verlas ni corregirlas.
- **Causa:** el importador nunca incorpora filas para revisar, la app no ofrecía cómo
  resolverlas y el archivo descargado se borraba al confirmar.
- **Regla:** una fila pendiente siempre tiene un camino de salida: su motivo a la vista, una
  corrección elegida por la persona (nunca inferida) que queda en las notas, y una nueva
  vista previa antes de incorporar. El archivo se conserva mientras haya pendientes.

### 2026-11-15 · Recálculo de ventas sin respuesta y leyenda desmarcada

- **Qué pasó:** en la prueba con 7.113 ventas el servidor guardó la vista previa corregida,
  pero el navegador mostró «No se pudo conectar»; al recargar, la leyenda «CONSUMIDOR FINAL»
  aparecía desmarcada y el panel arrastraba la marca de la corrida anterior.
- **Causa:** la respuesta superó el tiempo de espera de la función; la elección de la leyenda
  no se guardaba al recalcular y el panel la tomaba de la confirmación previa.
- **Regla:** ante una respuesta que no llega, releer el estado en vez de reintentar; las
  decisiones de la persona (leyenda, correcciones) se guardan en la vista previa de la corrida
  actual y el panel las toma de ahí.

### 2026-11-15 · Comprobantes de responsables inscriptos tomados de Mis Comprobantes

- **Qué pasó:** las ventas y compras de una sociedad representada responsable inscripta se
  importaron desde Mis Comprobantes. Faltaba el detalle por concepto (5 tiques de combustible
  quedaron pendientes: la diferencia eran impuestos internos, visibles sólo en el Portal IVA).
- **Causa:** el conector evitaba el Portal IVA de las representadas para no abrir un borrador
  en IVA Simple, y la fuente no dependía de la condición del cliente.
- **Regla:** Monotributo usa Mis Comprobantes; el resto, el Portal IVA. Consultar e importar
  sobre el borrador no afecta la declaración mientras no se presenta. Sólo se descarta el
  borrador de un período posterior; los datos iniciales nunca se suponen: los elige la persona
  por período (con predeterminados del cliente). Las escrituras de `Period` están reservadas a
  las transiciones de estado: la elección del período vive en `ArcaPeriodSetting`.

### 2026-11-15 · Esquema de Prisma sin validar antes del push

- **Qué pasó:** la Deploy Preview del PR #55 falló en `prisma generate`: la relación 1:1 de
  `ArcaPeriodSetting` con `Period` no tenía campos únicos.
- **Causa:** en el entorno de trabajo no se puede descargar el motor de Prisma y se subió sin validar.
- **Regla:** validar el esquema con `@prisma/prisma-schema-wasm` de la misma versión que
  `@prisma/engines-version` (instalado fuera del repositorio) antes de subir cambios de esquema.

### 2026-11-16 · La Deploy Preview probaba el conector de otro PR

- **Qué pasó:** la primera prueba del PR #55 en DEV volvió a descargar de Mis Comprobantes:
  el envío y la respuesta del conector iban a la Preview de un PR anterior.
- **Causa:** `ARCA_SYNC_APP_ORIGIN` del contexto «Deploy Previews» tenía la dirección fija de
  la Preview anterior, y las funciones toman el valor recién al volver a desplegar.
- **Regla:** antes de probar el conector en una Preview, apuntar `ARCA_SYNC_APP_ORIGIN`
  (sólo «Deploy Previews») a esa Preview, volver a desplegarla y confirmar en la vista previa
  el formato de la fuente (`PORTAL_CSV` o `MIS_COMPROBANTES`). Nunca cambiar el de Production.

## Frontend

### 2026-11-17 · Importes alineados a la izquierda pese a la clase `.num`

- **Qué pasó:** en la Deploy Preview del PR #57 las columnas de importes de Ventas y Compras
  seguían alineadas a la izquierda aunque las celdas tenían `className="num"`.
- **Causa:** `.table td { text-align: left }` (clase + elemento) tiene más especificidad que
  `.num` (sólo clase) y le ganaba.
- **Regla:** las alineaciones y anchos de celdas se declaran con el selector completo de la
  tabla (`.table td.num`, `.data-table td.num`). Verificar en la Preview con el estilo
  calculado (`getComputedStyle`), no sólo que la clase esté en el HTML.

## Exportación a Excel

### 2026-11-17 · El Excel con el detalle pesaba 6,7 MB

- **Qué pasó:** al sumar las hojas de comprobantes (7.113 ventas de un período), la descarga
  de la liquidación pasó a 6,7 MB.
- **Causa:** `XLSX.write` de SheetJS no comprime el archivo si no se le pide.
- **Regla:** exportar siempre con `compression: true` (el mismo libro quedó en 1,96 MB). Al
  agregar hojas grandes, medir el tamaño del archivo en la Preview con datos reales.

## Percepciones de las compras

### 2026-11-17 · «Percepción de IVA del comprobante sin registrar» con la percepción ya cargada

- **Qué pasó:** la presentación de OOSHEN 10/2026 avisaba dos percepciones sin registrar que ya
  estaban en Retenciones/Percepciones (importadas de ARCA), pero sin vínculo con su factura.
- **Causa:** la vinculación era manual. Crear un registro por cada percepción de factura las
  hubiera duplicado (factura + ARCA).
- **Regla:** las percepciones de las compras se concilian solas (lib/invoice-perceptions): si
  ARCA ya la informó (mismo CUIT y comprobante) se vincula y computa ARCA; si no, se toma del
  comprobante y la de ARCA la reemplaza cuando llega. Nunca crear registros sin buscar antes
  el informado por el agente.

### 2026-11-17 · Tique con descuento: la diferencia era el descuento, no la percepción

- **Qué pasó:** FERRARI 00007-00013442 mostraba $ 26,26 de diferencia entre la percepción del
  comprobante y la de ARCA.
- **Causa:** el emisor calculó el IVA sobre el neto antes del descuento; ARCA informa ese neto
  y, para cerrar el total, el descuento quedó restado de la percepción del comprobante.
- **Regla:** ante una diferencia de percepción, revisar primero el comprobante físico
  (descuentos, redondeos). El criterio de registración es del estudio (acá: neto antes del
  descuento, computa ARCA) y se documenta con la nota del papel de trabajo.

### 2026-11-17 · Error de tipos que sólo aparece en el build de Netlify

- **Qué pasó:** la Deploy Preview del PR #60 falló en «Running TypeScript»: `Invoice.date` admite null.
- **Causa:** en el entorno de trabajo el cliente de Prisma no se genera y `tsc` local no ve los tipos reales.
- **Regla:** al leer columnas de Prisma, revisar en `schema.prisma` si son opcionales (`?`) antes de
  tiparlas, y esperar el build de la Preview antes de dar algo por listo.

### 2026-11-17 · «Error interno» al guardar la regla de «Otros tributos» (PR #62)

- **Qué pasó:** al guardar una regla por proveedor, la pantalla mostraba «Error interno» y no
  quedaba nada guardado.
- **Causa (dos):** (1) la restricción `TaxRecord_f2051_detail_check` sólo admitía `invoiceId` en
  percepciones de IVA, y la de IIBB tomada del comprobante se vincula a la compra; (2) la causa
  principal: la primera conciliación del período hacía ~50 escrituras en serie y, con ~0,25–0,45 s
  por ida y vuelta entre Netlify y la base (São Paulo), superaba el tope de 10 s de la transacción
  → rollback completo. El primer arreglo (sólo la restricción) no alcanzó: el error se reprodujo
  en la Preview y se midió el tiempo (13 s) antes de seguir.
- **Regla:** todo proceso que escribe «una fila por comprobante» dentro de la transacción del
  período se acota: agrupar en una sentencia lo que se pueda (`createMany`, `id in`) y trabajar
  por tramos con un tope (`RECONCILE_MAX_WRITES`) e indicador `pending`, repitiendo desde la
  pantalla. Medir en la Preview con datos de copia, no estimar. Y no dar por cerrado un arreglo
  sin reproducir el caso que falló.

### 2026-11-18 · Producción: tramos de conciliación vencían igual (P2028) — región de funciones

- **Qué pasó:** al cargar las reglas en producción, un tramo de conciliación seguía fallando con
  «Error interno» aun con tope de escrituras y plazo de 3,5 s.
- **Causa:** las funciones de Netlify corrían en Ohio (CMH) y la base en São Paulo: cada consulta
  cruzaba el continente y el bloqueo + lecturas + cierre ya rozaban los 10 s. El log sólo decía
  «PrismaClientKnownRequestError»; recién al registrar el código se vio que era P2028 (vencimiento
  de la transacción interactiva).
- **Arreglo:** región de funciones en GRU (São Paulo), autorizado por el usuario, y redeploy. El
  mismo tramo pasó de fallar a los 13–18 s a resolverse en 3,8 s.
- **Regla:** las funciones van en la misma región que la base (GRU ↔ sa-east-1). Ante un 500, leer
  el código de Prisma en el log de Netlify antes de cambiar código; no encadenar arreglos por hipótesis.

### 2026-11-18 · DDJJ de IIBB 10/2026 (OOSHEN): la base no coincidía con la presentada

- **Qué pasó:** la app calculaba 1.692.834,23 de impuesto y la DDJJ F.5680 presentada dice
  1.994.076,23. Además, el TXT de percepciones que descarga ASIP no se podía importar en ARCA.
- **Causa:** (1) la base de IIBB tomaba sólo el neto gravado; la DDJJ usa total − IVA, que incluye
  10.041.400,00 de ventas exentas de IVA. (2) La descarga de ASIP trae tipo y letra como texto e
  invertidos («1A», «6A», «F ») y el número sin el comprobante; el F.5680 exige códigos numéricos
  (letra 1=A…5=M; tipo 1=Factura, 3=Nota de crédito), que no están en el manual: se leyeron de los
  combos del formulario.
- **Regla:** antes de dar por buena una liquidación, compararla contra la DDJJ efectivamente
  presentada (se carga en «Datos de la DDJJ de IIBB» y la pantalla muestra la diferencia). Un
  código de tabla que el manual no publica se lee del formulario oficial, nunca se supone. Los
  TXT de muestra sirven para entender el diseño; los que se usan para presentar son los que
  ARCA aceptó.
