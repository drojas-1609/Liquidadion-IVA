# Smoke PR18 en DEV — 28/10/2026 UTC

## Entorno y alcance
- Commit: 76ef23509948a5f5104495184f421da5ce31fe78.
- PR draft: https://github.com/drojas-1609/Liquidadion-IVA/pull/18
- Deploy: 6ae1431d7059c0a271478097.
- Preview: https://deploy-preview-18--liquidadoriva.netlify.app
- DEV: esyfpakajthdifhnhcew. No se consultó ni modificó PROD.
- Conjuntos fiscales oficiales pendientes y deshabilitados. Sólo fixtures sintéticos.
- Activación temporal autorizada hasta 28/10/2026 21:30 -03:00. Variables sólo con valor en Deploy Previews; All scopes por limitación del plan Netlify.
- Todas las escrituras de negocio fueron realizadas mediante UI. Las verificaciones SQL se ejecutaron desde el editor de Supabase DEV con BEGIN READ ONLY y COMMIT. No se ejecutaron migraciones.

## Línea base y centinelas
SQL a 00:56:25 UTC: AuditLog118, Client1, sin centinelas, ClientActivity0, ClientActivityRate0.

| Temporal | ID |
|---|---|
| Cliente A, CUIT sintético 30-99999917-0 | cmvremq9j0001kx09ut7cof3q |
| Cliente B, CUIT sintético 30-99999918-9 | cmvreo0cp0001l609jn9twms0 |
| Actividad A 999001 | cmvremr8f0004kx09vjblagud |
| Alícuota A | cmvremrfe0005kx094npng6f7 |
| Actividad B 999002 | cmvreo1c00004l609zr1sazfe |
| Alícuota B | cmvreo1j40005l6098zjoeebs |
| Período A 09/2026 | cmvrepx1h0009l609mjyeorbc |
| Venta A 0001-00001801 | cmvreryzf0001jq09c8izfpq6 |

## Resultados
| Caso | Evidencia y clasificación |
|---|---|
| V1 Alta predeterminada | UI muestra 3 % pendiente de confirmación; SQL confirma cálculo3. No se capturó payload POST: omisión de defaultIibbRate no demostrada por navegador. |
| V2 Alta con valor cambiado | UI muestra Valor indicado en el alta al introducir4.5; SQL confirma cálculo4.5. Payload POST no capturado. |
| V3 Edición sin cambiar tasa | Rótulo Sin constancia de revisión. Se cambia sólo el domicilio sintético A; SQL confirma cálculo3 y un client.update. No se capturó payload PATCH. |
| V4 Vacío y negativo | Vacío y -1 muestran error junto al campo y en resumen; el campo recibe foco, aria-invalid=true y borde rgb(239,68,68). Sin auditorías extra de esos intentos. |
| V5 Liquidación y Excel | Se crea un período09/2026 y una venta sintética neto1000, IVA21%=210, total1210. Liquidación muestra IVA210 e IIBB30 sobre base1000 al3%, no la tasa informativa1.23. Excel leído: B8=210, B12=210, B16=1000, B17=30, B19=30; C17 contiene la aclaración. Comparación aritmética contra esos datos, no ejecución comparativa del binario anterior. |
| V6 Catálogos | Servidor lista sólo prueba-sintetica-naes. Código oficial011111 sin resultados. Búsqueda999001 y consultoría correctas. 999003 visible con histórico activado: NO vigente2018-01-01 a2025-12-31. |
| V7 Sin condiciones | SQL confirma origen de actividad CATALOG, versión sintética; tasa1.23, rateOrigin CONFIRMED_SUGGESTION, ruleRef prueba-sintetica-reglas-901#sin-condiciones. |
| V8 Condicionada | Panel inicia hechos en Sin indicar, constancias desmarcadas, botones deshabilitados. Cerrar y reabrir conserva tasa sin informar. Confirmación explícita de2.5 como decisión del estudio: SQL STUDIO_MANUAL y ruleRefNULL. |
| V9 Accesibilidad | Foco, aria-invalid, aria-describedby, resumen enlazado y color observados. VoiceOver NO ejecutado; caso parcial. |
| V10 Versión obsoleta | Dos pestañas cargadas antes de editar. Primera guarda domicilio versión A. Segunda conserva borrador obsoleto, muestra conflicto y bloquea Guardar Cambios. SQL: sólo un client.update. No se capturó HTTP409, por lo que se acredita UI+DB sin afirmar status observado. |

## Limpieza final
Se eliminaron por UI la venta, el período, B y A. SELECT final a01:06:00 UTC:
- Client1, ClientJurisdiction0, ClientActivity0, ClientActivityRate0.
- Period1, Invoice3, InvoiceVatLine3, TaxRecord0.
- Centinelas por IDs y CUIT:0; hijos por clientId:0; período temporal0; comprobante temporal0.
- AuditLog128, incremento exacto10:
  - client.create: A1+B1.
  - client.update: A1.
  - period.create:1.
  - invoice.create:1.
  - liquidation.export:1.
  - invoice.delete:1.
  - period.delete:1.
  - client.delete: A1+B1.
No hay eventos adicionales desde la línea base. El inventario original de negocio queda con sus conteos previos; no se compararon todos los campos del cliente existente.

## Observaciones y límites
- Navegación/refresco tras acciones y enlaces con demora. No se duplicaron solicitudes para resolverla; se consultó SQL antes de continuar.
- La captura del evento download venció. El Excel sí estaba en Downloads y se inspeccionó localmente; sólo una exportación auditada.
- No se instrumentaron status HTTP ni cuerpos POST/PATCH. No se declara demostrada la omisión del campo en esos payloads.
- Sólo sesión OWNER; no se ejercitaron otros roles.
- Sin prueba VoiceOver, sin aprobación fiscal, sin cambios a código, commits, push, merge ni configuración adicional durante este smoke.
- Las variables de fixtures permanecen con el vencimiento autorizado. No se verificó todavía su apagado por vencimiento ni se retiraron.

Excel inspeccionado: `Liquidacion_PRUEBA_Cliente_sintético_A_09_2026.xlsx` (descarga local; no incluida en Git).

## Revisión técnica posterior
Revisión estática adicional de origen y confirmación de tasas, aprobación de registros, payload condicional de defaultIibbRate y SQL de la migración. Sin nuevos bloqueos detectados en ese alcance; no equivale a una aprobación formal en GitHub ni a una revisión fiscal. No se volvió a ejecutar la suite porque sólo se modificó documentación.
