# Importación programada de ARCA

En Importar, el Propietario o Administración puede activar el día 25 y elegir hasta dos días adicionales por cliente. El calendario usa hora argentina y selecciona el período abierto del mes en curso. Los días que superan la duración del mes coinciden con su último día. «Importar ahora» trabaja con el período abierto que se está viendo.

Cada corrida registra ventas, compras, retenciones y percepciones por separado. Si ARCA avisa que venció la sesión, el conector vuelve a ingresar una vez y repite la fuente pendiente. Un reintento manual retoma las fuentes fallidas. Los comprobantes ya cargados conservan sus clasificaciones y los períodos cerrados se protegen con los mismos controles que en la importación manual.

## Descarga, vista previa y confirmación

Ni «Importar ahora» ni el calendario incorporan datos por su cuenta. Cada fuente sigue tres pasos:

1. **Descarga.** El conector consulta ARCA y entrega el archivo.
2. **Vista previa.** El importador existente lo lee sin escribir. El panel muestra, por fuente, filas nuevas, duplicadas, pendientes y con error, los totales de las filas nuevas (neto e IVA por alícuota en los libros) y las filas sin incorporar agrupadas por motivo.
3. **Confirmación.** Una persona con permiso de carga confirma o descarta cada fuente. Al confirmar se recalcula la vista previa: si cambió desde que se mostró, no se escribe y se presenta la nueva.

El archivo descargado se guarda sólo mientras la vista previa espera y se borra al confirmar, descartar o reemplazar la corrida. El resumen guarda conteos, totales y motivos, sin datos de comprobantes. Mientras haya vistas previas sin resolver, «Importar ahora» sólo reintenta las fuentes fallidas. Una corrida del calendario reemplaza las vistas previas anteriores sin incorporarlas.

Una consulta que ARCA responde sin datos se muestra como consulta correcta, no como falla.

### Ventas a consumidor final sin identificar

Mis Comprobantes informa esas ventas con documento 99 y sin denominación. Quedan para revisar, y la vista previa ofrece aplicar la leyenda «CONSUMIDOR FINAL» (Libro IVA Digital, Especificaciones, Ventas, campos 6 a 8) mostrando cuántas filas quedan aptas y cuántas siguen pendientes. La leyenda se aplica sólo si la persona la marca al confirmar. Completa la denominación y nada más: los comprobantes siguen individuales y no se infieren importes, alícuotas ni códigos de operación. Una venta B sin detalle de alícuotas cuyo total se explica con exento o no gravado se informa como operación sin IVA a la que le falta el código de operación; si el total no se explica, como falta de información. En ambos casos sigue pendiente.

## Fuentes

| Fuente | Consulta |
| --- | --- |
| Ventas, CUIT propio | Portal IVA → Libro IVA → Libro Ventas → CSV |
| Compras, CUIT propio | Portal IVA → Libro IVA → Libro Compras → CSV |
| Ventas, sociedad representada | Mis Comprobantes → Emitidos → rango del mes → CSV |
| Compras, sociedad representada | Mis Comprobantes → Recibidos → rango del mes → CSV |
| Retenciones | Mis Retenciones → Impositivas → SIRE IVA 216 y SICORE 767 → Retención |
| Percepciones | Mis Retenciones → Impositivas → SICORE 767 → Percepción |

Para una sociedad representada el conector no entra a Portal IVA: ahí la consulta deriva a IVA Simple y abre una declaración. Mis Comprobantes es sólo consulta. En la versión anterior de Mis Retenciones, «Exportar a Texto» abre el contenido en la pestaña; el conector pide esa misma dirección después de comprobar CUIT, período, impuesto y tipo.

Una respuesta explícita de ARCA sin resultados se registra como vacía. Una descarga interrumpida o un archivo incompatible se registra como falla. Las corridas sólo consultan y descargan datos en ARCA. El cierre y la presentación se realizan desde sus pantallas habituales.

## Despliegue y acceso

Aplicar las migraciones antes de publicar. Configurar `ARCA_SYNC_APP_ORIGIN`, `ARCA_SYNC_CONNECTOR_TOKEN` y `ARCA_CLIENT_CREDENTIAL_KEY` en Functions para el entorno correspondiente. La clave de cifrado debe tener 32 bytes aleatorios en hexadecimal. El token interno necesita al menos 32 caracteres.

Desde **Nuevo Cliente** o **Editar Cliente**, Propietario y Administración pueden guardar o reemplazar el acceso a ARCA. Para una empresa, se indica el CUIT y la clave fiscal del administrador autorizado, y el conector selecciona el CUIT de la ficha en cada servicio. Si ARCA no confirma el CUIT representado, esa fuente queda marcada con una falla de representación.

La clave fiscal se cifra con AES-256-GCM y queda asociada a la organización, ficha y CUIT. El formulario siempre recibe el campo de clave vacío. Para conservar el acceso anterior de Netlify, mantener `ARCA_SYNC_CREDENTIALS` y configurar `ARCA_SYNC_LEGACY_CLIENT_ID` con el ID de la ficha que ya lo usaba. Cuando esa ficha guarda un acceso cifrado, se usa el acceso de la ficha.

La función programada revisa el calendario y recupera tareas interrumpidas. La función en segundo plano abre ARCA, descarga un archivo y lo envía a una ruta interna autenticada. Esa ruta verifica el período, el vencimiento de la tarea y el permiso de quien la inició, pide la vista previa al importador existente y la guarda. La confirmación la hace una persona desde el panel, con su propia sesión; el importador vuelve a validar duplicados y registra la auditoría con sus reglas habituales.

## Comprobación

El 14/11/2026 se recorrieron a mano, con una sesión abierta por el administrador, las pantallas de Mis Comprobantes y Mis Retenciones de una sociedad representada para octubre de 2026, y sus archivos pasaron por el importador sin errores de formato. Las pantallas observadas están reproducidas con datos sintéticos en `tests/_fixtures/fake-arca.ts`.

En octubre de 2026, el conector descargó los ZIP reales de Portal IVA. El lector existente aceptó los 27 comprobantes de ventas y los 21 de compras sin errores de formato. En Mis Retenciones, las consultas de retenciones y percepciones por separado devolvieron resultados vacíos válidos. Falta comprobar en vivo la exportación de Mis Retenciones con un período que tenga resultados.

ARCA describe las fuentes en [Portal IVA](https://www.arca.gob.ar/iva/iva-simple/confeccion-declaracion.asp) y [Mis Retenciones](https://www.arca.gob.ar/genericos/retenciones.asp). La revisión del [catálogo de servicios web](https://www.arca.gob.ar/ws/documentacion/catalogo.asp) no confirmó un servicio de descarga integral para las cuatro fuentes.
