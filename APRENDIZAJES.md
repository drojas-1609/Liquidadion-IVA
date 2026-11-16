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
