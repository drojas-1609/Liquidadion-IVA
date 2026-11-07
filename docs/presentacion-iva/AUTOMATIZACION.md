# Automatización con ARCA — relevamiento (06/11/2026)

**Alcance.** Sólo fuentes oficiales: el catálogo de web services de ARCA y los manuales que enlaza. No se ejecutó ninguna presentación ni se subió ningún archivo, y nada se habilitó en producción.

## Catálogo oficial consultado

- [Catálogo de otros WS de negocio](https://www.arca.gob.ar/ws/documentacion/catalogo.asp), consultado el 06/11/2026.
- [WebService Presentación de DDJJ – Manual para el desarrollador](https://www.afip.gob.ar/ws/wsddjj/WSPresentaciondeDDJJManualparaelDesarrollador.pdf), revisión del 24/11/2016, sha256 `b5f45076…0c5a`.

## Matriz

| Tarea | Vía oficial verificada | Automatizable | Implementado | Requiere intervención |
|---|---|---|---|---|
| Comprobantes **emitidos** propios | Factura electrónica (WSFEv1, `FECompConsultar`): consulta de a un comprobante por punto de venta y número | Parcial: sirve para verificar, no para listar | No | Certificado y relación con el servicio por cliente |
| Comprobantes **recibidos** / Mis Comprobantes | **No figura** en el catálogo. Sólo [Constatación de Comprobantes (WSCDCV1)](https://www.arca.gob.ar/ws/WSCDCV1/WSCDC-manual-desarrollador-v4.pdf), que verifica uno por uno si un comprobante está autorizado | Verificar sí; listar o descargar no, por WS | No | La descarga de Mis Comprobantes se hace en el navegador con clave fiscal |
| Retenciones y percepciones | [SIRE (SOAP)](https://www.arca.gob.ar/sistemaIntegralRetenElect/SOAP-SIRE-IVA-Manualparaeldesarrollador_V1_0_0.pdf) figura sin descripción; es un régimen de información para **agentes**, no una consulta del sujeto retenido. SICORE y Mis Retenciones no figuran | No verificado para el sujeto retenido | No | Mis Retenciones (descarga en el navegador); falta una muestra del archivo |
| Situación frente al régimen de percepción de IVA | [Régimen Percepción IVA](https://www.arca.gob.ar/ws/manuales/manualdesarrolladorWSRGIVA.pdf): consulta de la situación fiscal | Sí (consulta) | No | Certificado |
| Carga del Libro IVA y la apertura | **No hay WS.** La importación de TXT y CSV es en el Portal IVA, con clave fiscal | No por WS | **Se generan los archivos** (paquete) | La persona los importa en el Portal IVA |
| Presentación del **F.2051** | El WS «Presentación de DDJJ» presenta archivos con el formato del *documento técnico de interfaz* de cada formulario. Perfiles `presentacionprocessor`, `djprocessorcontribuyente` y `djprocessorcontribuyente_cf`; operaciones `dummy`, `upload` (MTOM, devuelve el número de transacción) y `consulta` | **No verificado.** No se encontró un documento técnico de interfaz publicado para el F.2051. El manual no lista formularios, y el F.2051 se confecciona dentro del Portal IVA. **Que exista el WS genérico no confirma que admita el F.2051** | No | La presentación se hace en el Portal IVA con revisión y confirmación de la persona |
| Pago (VEP) | [SETIWS-PAGO-API](https://www.arca.gob.ar/ws/SETIWS-PAGO-API/Manual_para_el_desarrollador_setiws-pago-api.pdf): crear, enviar y consultar VEP, para **organismos** | No para el estudio | No | Pago con los medios vigentes |
| Datos de contribuyentes | Constancia de Inscripción y Padrón A4/A10/A13 | Sí | Sí, ya existía la consulta de padrón (WSAA, certificados cifrados, cupos) | — |
| F.931 (contribuciones para el Anexo I) | [Trabajo F931](https://www.arca.gob.ar/ws/TRABAJO_F931/TrabajoF931-ManualParaElDesarrollador.pdf): consulta de DDJJ F.931 | Posible, sin verificar | No | Certificado y relación; el computable lo sigue informando el estudio |

## Flujo de navegador (como el de Aconpy)

**No evaluado.** No hubo grabación ni sesión de lectura autorizada disponible en esta sesión. Para evaluarlo hace falta una de las dos cosas.

Lo que se observe ahí **no es una API oficial**. Si se implementa, las condiciones son:
- una sesión aislada por cliente;
- manejo de vencimiento de sesión;
- MFA y CAPTCHA siempre con intervención humana, sin eludir controles;
- prevención de duplicados por período, archivo y huella;
- recuperación de fallas con verificación del estado en el Portal antes de reintentar;
- conservación del acuse.

## Requisitos para cualquier presentación automatizada futura

- Revisar el resumen y confirmar explícitamente en cada presentación.
- Usar sólo la versión **cerrada**: el paquete y su sha256.
- Conservar el acuse (número de transacción) asociado a la versión.
- Ser idempotente: reintentar con los mismos parámetros, como indica el manual del WS (§2.4).
- Mantener las credenciales cifradas, como en `ArcaWsaaTicket`, nunca en texto plano.

**Esta etapa no incluye ninguna presentación real.**
