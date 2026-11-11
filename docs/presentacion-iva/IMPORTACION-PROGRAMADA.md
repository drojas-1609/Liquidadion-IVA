# Importación programada de ARCA

En Importar, el Propietario o Administración puede activar el día 25 y elegir hasta dos días adicionales por cliente. El calendario usa hora argentina y selecciona el período abierto del mes en curso. Los días que superan la duración del mes coinciden con su último día. «Importar ahora» trabaja con el período abierto que se está viendo.

Cada corrida registra ventas, compras, retenciones y percepciones por separado. Si ARCA avisa que venció la sesión, el conector vuelve a ingresar una vez y repite la fuente pendiente. El resultado muestra las filas incorporadas, las duplicadas y las que requieren revisión. Un reintento manual retoma las fuentes fallidas. Los comprobantes ya cargados conservan sus clasificaciones y los períodos cerrados se protegen con los mismos controles que en la importación manual.

## Fuentes

| Fuente | Consulta |
| --- | --- |
| Ventas | Portal IVA → Libro IVA → Libro Ventas → CSV |
| Compras | Portal IVA → Libro IVA → Libro Compras → CSV |
| Retenciones | Mis Retenciones → Impositivas → SIRE IVA 216 y SICORE 767 → Retención |
| Percepciones | Mis Retenciones → Impositivas → SICORE 767 → Percepción |

Una respuesta explícita de ARCA sin resultados se registra como vacía. Una descarga interrumpida o un archivo incompatible se registra como falla. Las corridas sólo consultan y descargan datos en ARCA. El cierre y la presentación se realizan desde sus pantallas habituales.

## Despliegue y acceso

Aplicar las migraciones de cuentas por proveedor e importación programada antes de publicar. Configurar `ARCA_SYNC_APP_ORIGIN`, `ARCA_SYNC_CONNECTOR_TOKEN` y `ARCA_SYNC_CREDENTIALS` en el contexto y el alcance Functions que correspondan. El token interno necesita al menos 32 caracteres. Las credenciales se configuran como secreto de Netlify, en un objeto JSON con la forma `{"CUIT":{"cuit":"CUIT","password":"…" }}`. El conector sólo acepta el acceso del mismo CUIT para esta primera versión. Las credenciales de otros clientes se incorporan cuando cada titular autorice su acceso.

La función programada revisa el calendario y recupera tareas interrumpidas. La función en segundo plano abre ARCA, descarga un archivo y lo envía al importador existente mediante una ruta interna autenticada. Esa ruta verifica el período, el vencimiento de la tarea, el permiso de quien la inició y los archivos antes de escribir. El importador vuelve a validar duplicados y registra la auditoría con sus reglas habituales.

## Comprobación

En octubre de 2026, el conector descargó los ZIP reales de Portal IVA. El lector existente aceptó los 27 comprobantes de ventas y los 21 de compras sin errores de formato. En Mis Retenciones, las consultas de retenciones y percepciones por separado devolvieron resultados vacíos válidos. Falta comprobar en vivo la exportación de Mis Retenciones con un período que tenga resultados.

ARCA describe las fuentes en [Portal IVA](https://www.arca.gob.ar/iva/iva-simple/confeccion-declaracion.asp) y [Mis Retenciones](https://www.arca.gob.ar/genericos/retenciones.asp). La revisión del [catálogo de servicios web](https://www.arca.gob.ar/ws/documentacion/catalogo.asp) no confirmó un servicio de descarga integral para las cuatro fuentes.
