# Smoke en DEV — importación del Libro IVA Digital (TXT) y de la descarga de Portal IVA (ZIP/CSV)

**Sólo DEV** (`esyfpakajthdifhnhcew`), **sólo datos sintéticos**. Nada de este guion se ejecutó todavía. Cada paso remoto requiere autorización explícita:
- publicar la Preview;
- crear datos en DEV;
- ejecutar el SQL de limpieza.

No usar archivos reales ni PROD.

## 0. Preparación local

Generá los archivos fuera del repositorio. El generador se niega a escribir adentro y no sobrescribe.

```sh
./node_modules/.bin/vite-node --config vitest.config.ts scripts/libro-iva-import/generate-synthetic.ts -- \
  --out ~/lid-smoke-202610 --period 202610 --sales 20 --purchases 15 --with-issues
./node_modules/.bin/vite-node --config vitest.config.ts scripts/libro-iva-import/generate-synthetic.ts -- \
  --out ~/lid-smoke-202611 --period 202611 --sales 5 --purchases 5
```

Cada carpeta contiene:
- **TXT:** el par de ventas y el par de compras del Libro IVA Digital.
- **Portal IVA:** `comprobantes_periodo_<p>_{ventas,compras}_SINTETICO.zip` y el mismo CSV suelto. Las NC vienen en negativo y las dos FC B a consumidores con DNI, **sin denominación**.
- **Resumen:** `RESUMEN_SINTETICO_<p>.txt`, con lo esperado.

Esperado para 202610 (verificado en local con la vista previa real):

| Archivo | Se importan | Ya cargados | Revisar | Error | IVA que se importa | IVA que queda afuera para revisar |
|---|---|---|---|---|---|---|
| Ventas, ZIP de Portal IVA (primero) | 21 | 0 | 2 (denominación vacía) | 0 | 4.935,00 | 63,00 |
| Ventas, par TXT (después) | 2 | 21 | 1 (total que no cierra) | 1 (CUIT inválido) | 63,00 | — |
| Compras, CSV de Portal IVA (primero) | 16 | 0 | 0 | 0 | 3.643,50 | — |
| Compras, par TXT (después) | 0 | 16 | 1 | 1 | 0 | — |

## 1. Datos de prueba en DEV, por la interfaz y con un usuario ACCOUNTANT u OWNER

1. Creá el cliente **«CLIENTE SINTETICO LID SMOKE»**, Responsable Inscripto, con un CUIT ficticio válido. Anotá su id.
2. Creá los períodos **10/2026** y **11/2026**, abiertos y sin prorrateo.

## 2. Casos

| # | Acción (período 10/2026) | Resultado esperado |
|---|---|---|
| 1 | Formato «Descarga de Portal IVA» → Ventas → ZIP → Vista previa | 21 «Se importa» y 2 «Revisar» («no informa la denominación»). «Lo que queda afuera» muestra 2 comprobantes con IVA 63,00. En la tabla por tipo, la NC A resta. El puente cierra. Junto al botón: «Se importan 21 … quedan para revisar 2 con IVA 63,00». |
| 2 | Confirmar sin tildar la importación parcial | El botón está deshabilitado; si se fuerza por la API, 422 |
| 3 | Tildar y Confirmar | 21 importados, 2 no importados |
| 4 | Formato «Libro IVA Digital» → Ventas → par TXT → Vista previa → tildar → Confirmar | 21 «Ya cargado», 2 «Se importa» (las FC B, con denominación), 1 «Revisar», 1 «Error». Se importan 2. |
| 5 | Subir otra vez el ZIP de ventas, y después el CSV suelto | Todo «Ya cargado»: las dos FC B ya no figuran como pendientes. Confirmar → «no hay comprobantes para importar». |
| 6 | Compras: CSV suelto de Portal IVA → Confirmar; después el par TXT | 16 importados; el TXT muestra 16 «Ya cargado» + 1 «Revisar» + 1 «Error» y no hay nada para importar |
| 7 | Página del período y liquidación | Débito 4.998,00 y crédito 3.643,50 (sin retenciones) |
| 8 | Período 11/2026: vista previa del ZIP de ventas de `~/lid-smoke-202611`; cerrar el período en otra pestaña; Confirmar | 409 «El período está cerrado…»; nada escrito. Reabrir y confirmar: se importa. |
| 9 | Auditoría (lectura de `AuditLog`) | Una fila `invoice.import` por confirmación, con `format` (`PORTAL_CSV` o `LID_TXT`), conteos y huellas; sin CUIT, nombres ni importes |
| 10 | VIEWER intenta importar | Sin botón; por la API, 403 |
| 10b | Corte o recarga: confirmar y recargar la página antes de la respuesta; reintentar | La pantalla muestra «Verificando…» y luego «Confirmación aplicada (… según el registro del período)» o «no se aplicó» (sólo si todos los envíos tienen su falla registrada). «Confirmaciones registradas» lista la operación. Reintentar devuelve el mismo resultado sin escribir |
| 10c | Corte real: confirmar una carga que supere los 30 s de la Preview (504) | «Verificando…» mientras la transacción sigue; después «Confirmación aplicada» con los conteos del registro. Conteos del período, historial y duplicados coinciden con la importación |
| 10d | Sin registro pasados 75 s (corte de red controlado en el navegador antes de enviar, y sin red para la consulta) | «Resultado sin confirmar» con el `operationId` completo y «Volver a verificar». Recargar conserva el mismo estado; al volver la red, «Volver a verificar» muestra el resultado registrado |
| 11 | Volumen (opcional): ventas TXT 7.500 y ZIP de Portal IVA de unas 9.000 ventas (`--sales 7500` / `--sales 9000` en otra carpeta y otro período) | Medir vista previa y confirmación. Ver límites abajo. |

Registrá los tiempos, las respuestas y las capturas, sin datos reales.

## Límites de volumen

**Medido en local** (`LID_VOLUME=1 scripts/pg-local-regression.sh`, PostgreSQL local, rutas reales):

| Caso | Archivo | Solicitud | Respuesta de la vista previa | Vista previa | Confirmación |
|---|---|---|---|---|---|
| Ventas TXT, 7.500 (2 alícuotas) | 1,92 + 0,92 MB | 3,78 MB | 2,41 MB | 0,29 s | 1,5 s |
| Compras TXT, 6.000 (2 alícuotas) | 1,87 + 0,98 MB | 3,81 MB | 1,93 MB | 0,22 s | 1,2 s |
| Portal IVA, 9.000 ventas | ZIP de 0,25 MB (CSV de 1,66 MB) | 0,34 MB | 2,91 MB | 0,33 s | 1,7 s |

**Límites del código:**
- 2 MB por archivo; en el ZIP, por CSV descomprimido;
- transacción de la confirmación de 40 s (excepción inventariada);
- solicitud y respuesta de hasta 6 MB en Netlify Functions;
- respuesta cortada con 504 a los 30 s en la Preview.

En Portal IVA el límite efectivo es el CSV descomprimido de 2 MB (unas 10.800 ventas con dos alícuotas). A ese tamaño, la respuesta de la vista previa estimada es de unos 3,5 MB.

**Medido en DEV:** ver la tabla de volumen en [README.md](README.md). En resumen:
- 4.001, 6.001 y 7.503 filas confirman bien (20–29 s);
- con 9.001, la respuesta da 504 a los 30 s aunque la transacción se confirma completa: la pantalla recupera el resultado por `operationId`;
- para correlacionar con los logs de Netlify, buscar `[libro-iva-import] confirm` y el `x-nf-request-id` de la respuesta.

## 3. Limpieza (sólo DEV, con autorización; mostrar las sentencias antes)

La app no tiene borrado masivo de comprobantes, así que se limpia por SQL, acotado al cliente sintético. El AuditLog se conserva como historial.

```sql
-- 1) Verificar: debe devolver exactamente el cliente sintético y sus conteos.
SELECT c.id, c.name, count(DISTINCT p.id) AS periodos, count(i.id) AS comprobantes,
       count(i.id) FILTER (WHERE i.source = 'IMPORT') AS importados
FROM "Client" c LEFT JOIN "Period" p ON p."clientId" = c.id LEFT JOIN "Invoice" i ON i."periodId" = p.id
WHERE c.id = :'client_id' AND c.name = 'CLIENTE SINTETICO LID SMOKE'
GROUP BY c.id, c.name;

-- 2) Borrar dentro de una transacción. Las líneas de IVA caen en cascada con el comprobante.
BEGIN;
DELETE FROM "Invoice" i USING "Period" p
 WHERE i."periodId" = p.id AND p."clientId" = :'client_id';   -- debe coincidir con "comprobantes" del paso 1
DELETE FROM "TaxRecord" t USING "Period" p WHERE t."periodId" = p.id AND p."clientId" = :'client_id';
DELETE FROM "PeriodVatSettings" s USING "Period" p WHERE s."periodId" = p.id AND p."clientId" = :'client_id';
DELETE FROM "Period" WHERE "clientId" = :'client_id';
DELETE FROM "Client" WHERE id = :'client_id' AND name = 'CLIENTE SINTETICO LID SMOKE';
-- Revisar los conteos de cada DELETE antes de confirmar. Si alguno no coincide: ROLLBACK;
COMMIT;
```
