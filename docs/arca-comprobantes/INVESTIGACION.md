# Comprobantes desde ARCA: vías de importación y descarga automática

**Estado:** investigación (03/11/2026). No se pidieron ni guardaron Claves Fiscales, no se consultó ARCA con credenciales y no se leyeron archivos reales para este documento.

La fuente operativa de los comprobantes es **ARCA**; Aconpy queda como referencia opcional de conciliación. **La descarga de comprobantes y la presentación de la DJ de IVA son procesos separados:** este documento trata sólo la descarga.

## 1. Qué acepta hoy el sistema

| Origen | Formato | Estado |
|---|---|---|
| Libro IVA Digital: archivos para «Importar archivos» de Portal IVA (par comprobantes + alícuotas, ventas y compras, general y TurIVA) | TXT de posiciones fijas, ANSI, según el [Anexo I – Diseños de Registros](https://www.afip.gob.ar/iva/documentos/libro-iva-digital-diseno-registros.pdf) y las [Especificaciones (rev. 30/07/2025)](https://www.arca.gob.ar/iva/documentos/Libro-IVA-Digital-Especificaciones.pdf) | **Implementado**: vista previa, errores por fila, conciliación, duplicados y confirmación en período abierto (`docs/libro-iva-import/README.md`) |
| Descarga del Libro IVA desde Portal IVA (exportar o vista previa) | Según las [novedades oficiales del 19/11/2020](https://arca.gob.ar/iva/sujetos-exentos/novedades.asp): .zip con un .xml sin el detalle de comprobantes, más **.csv** de detalle por categoría de compras y ventas, separador `;`, decimal `,`, importes en pesos y **notas de crédito en negativo** | **Implementado** (ZIP o CSV): lector propio que reutiliza la vista previa, la conciliación, los duplicados y la confirmación (ver `docs/libro-iva-import/README.md`) |
| Mis Comprobantes (emitidos y recibidos) | CSV / XLSX | **Pendiente de muestra.** No hay diseño oficial publicado de sus columnas (ver §2) |

## 2. Mis Comprobantes: qué se sabe y qué falta confirmar con muestras

No encontré en las fuentes oficiales un diseño de columnas de la exportación. Las únicas descripciones son de terceros (guías de usuario), así que **no se usan para codificar**. Con muestras autorizadas de emitidos y de recibidos hay que confirmar:

- **Columnas y encabezados:** fecha, tipo, punto de venta, número y número hasta, documento y denominación de la contraparte, importes por alícuota o agregados, exento, no gravado, otros tributos, total, moneda y tipo de cambio.
- **Moneda:** si los importes vienen en la moneda original o en pesos. Hay exportaciones con la leyenda «montos expresados en pesos».
- **Signo:** si las notas de crédito vienen en positivo o en negativo.
- **Campos que la exportación no permite recuperar.** Hay que marcarlos para revisión; el TXT del libro tampoco trae los dos primeros:
  - condición frente al IVA de la contraparte (sujeto comprador para el F.2002);
  - concepto del crédito (bienes, locaciones, servicios o bienes de uso);
  - crédito fiscal computable (lo decide el contribuyente);
  - percepciones sufridas, si la exportación no las discrimina;
  - comprobantes no electrónicos y despachos de importación.

## 3. Descarga automática por cliente: qué ofrece ARCA

Revisé el [catálogo oficial de web services](https://www.arca.gob.ar/ws/documentacion/catalogo.asp) el 03/11/2026. **No hay un servicio general para Mis Comprobantes ni para el Libro IVA.** Lo que hay:

| Servicio | Qué permite | Cobertura | Sirve para listar |
|---|---|---|---|
| **WSFEv1** (`FECompUltimoAutorizado`, `FECompConsultar`; [manual del desarrollador](https://www.afip.gob.ar/fe/documentos/manual-desarrollador-ARCA-COMPG-v4-0.pdf)) | Último número autorizado por tipo y punto de venta, y los datos de un comprobante **emitido** a partir de tipo, punto de venta y número (incluye alícuotas, tributos, CAE y tipo de emisión) | Sólo **emitidos** por el propio CUIT. **A verificar en homologación:** si devuelve comprobantes emitidos por otros canales (Comprobantes en línea, Facturador) y qué servicio cubre las clases M y de exportación | Sí, de forma indirecta: recorriendo cada tipo y punto de venta hasta el último autorizado |
| **WSCDC** – Constatación de comprobantes ([manual v3](https://www.arca.gob.ar/ws/WSCDCV1/WSCDC_manual_desarrollador_v.3.pdf)) | Verifica si un comprobante **recibido**, ya conocido, está autorizado | Recibidos, uno por uno, con sus datos | No: constata, no lista |
| **WSCEC** – Consulta de comprobantes, Ley de Economía del Conocimiento ([manual](https://www.arca.gob.ar/ws/wscec/manual-wscec.pdf)) | Comprobantes de exportación de servicios de contribuyentes de ese régimen | Sólo ese régimen | No es una vía general |

**Autorización:** el mismo modelo que ya usa la app para el padrón.
- Autenticación WSAA con el **certificado del estudio**.
- Cada cliente **delega el web service** (por ejemplo, WSFE) al CUIT del estudio en el Administrador de Relaciones de Clave Fiscal.
- La app no recibe ni guarda Claves Fiscales; guarda el estado de la autorización por cliente.

**Seguiría siendo manual:**
- **Recibidos:** no hay listado oficial por web service. Se descargan desde Mis Comprobantes o desde Portal IVA, con acceso de Clave Fiscal del cliente o delegado al estudio, y se suben a la app.
- **Comprobantes no electrónicos y despachos de importación.**
- **Clasificaciones de la DJ:** sujeto comprador, concepto del crédito y crédito computable.
- **Presentación de la DJ (F.2002 / Libro IVA Digital) en Portal IVA:** no encontré un web service oficial de presentación; es otra etapa.

## 4. Qué falta para automatizar la descarga

1. Confirmar en homologación la cobertura de `FECompConsultar` por canal de emisión y por clase de comprobante, con el certificado de homologación ya existente.
2. Definir qué servicio delega cada cliente y cómo registra la app esa autorización, sin Claves Fiscales.
3. Diseñar el recorrido: tipos, puntos de venta y rango de números desde el último descargado; cupos propios y reintentos manuales, como en la consulta de padrón; reconciliación con el libro importado.
4. Reutilizar el mismo modelo, la vista previa y la confirmación que la importación de archivos, con origen distinto.
5. Mantener los recibidos por archivo (Mis Comprobantes o Portal IVA) hasta que ARCA publique una vía oficial.
