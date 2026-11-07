# Validación de aceptación en ARCA (procedimiento listo para revisión, NO ejecutado: pendiente de la elección del período y la autorización del titular)

**Objetivo:** confirmar que el Portal IVA **acepta importar** los archivos del paquete, sin presentar el Libro IVA Digital (F.2083) ni la declaración F.2051, y sin pagar.

Lo ejecuta una persona del estudio con clave fiscal y con autorización explícita para esa sesión. La aplicación no sube nada a ARCA.

## Antes de entrar

1. **Período elegido:** un período **no presentado** de un cliente real, por ejemplo el próximo a liquidar, ya procesado en la app y **cerrado**, con su paquete final.
   - **No usar un período ya presentado** (como 09/2026): importar ahí lleva a una rectificativa.
2. **Archivos:** descargar el paquete final y anotar el sha256 de cada archivo, que figura en `RESUMEN.txt`.
3. **Encabezado:** se importan los `IVA_SIMPLE_*.csv` **tal como los genera la app**. Si el Portal los rechaza, se registra el mensaje textual y se **detiene** esa parte. No se reintenta quitando el encabezado ni con otro formato sin evidencia del formato que exige el Portal: un diseño o una plantilla oficial, o un mensaje que lo indique.
4. **Constancia:** acordar quién hace las capturas de cada pantalla antes y después de cada importación.

## En el Portal IVA (período elegido)

| Paso | Acción | Registrar |
|---|---|---|
| 1 | Entrar al período. **No** tocar «Presentar», «Presentar declaración jurada», «Generar VEP» ni «Pagar» en ningún momento | Captura del estado inicial: comprobantes precargados de Mis Comprobantes, apertura y retenciones precargadas |
| 2 | Libro IVA → Ventas → Importar: `LIBRO_IVA_DIGITAL_VENTAS_CBTE.txt` + `_ALICUOTAS.txt`, con «Los Importes están expresados en Pesos Argentinos» | Si se aceptó y cualquier mensaje, textual. Si el Portal ofrece «reemplazar» o «agregar» frente a lo precargado, anotar la opción y **no** elegir sin revisar |
| 3 | Libro IVA → Compras → Importar el par de compras | Ídem |
| 4 | Comparar los totales del Portal (débito, crédito) con `RESUMEN.txt` | Diferencias, si las hay |
| 5 | Ajustes y otros conceptos → Apertura → importar cada `IVA_SIMPLE_*.csv` en su bloque | Aceptado o rechazado. Si se rechaza, mensaje textual y **sin reintentos** |
| 6 | Retenciones y percepciones: importar `F2051_*.csv` **sólo si** no hay precargadas que se dupliquen | Aceptado o rechazado; duplicados detectados. La descarga de percepciones observada (8 campos, punto decimal) difiere del diseño publicado (7 campos, coma): registrar cuál acepta el Portal |
| 7 | Ver la determinación del Portal (sin presentar) y compararla con `RESUMEN.txt` y `CONCEPTOS_A_CARGAR_EN_ARCA.txt` | Saldo del Portal frente al de la app |
| 8 | Cerrar la sesión **sin presentar** | — |

## Prueba de aceptación: archivo, pantalla y totales (preparada el 07/11/2026)

**Antes de empezar, el titular:**
1. **Elige el período:** un cliente real y un período no presentado ni vencido, ya cerrado en la app y con el **paquete final** (`IVA_<CUIT>_<AAAAMM>_v<n>.zip`).
   - El paquete final sólo se genera sin bloqueos de exportación.
   - El período real de 10/2026 con el par sólo exento **no sirve** mientras su código de operación siga pendiente.
2. **Autoriza por escrito** la carga en el borrador de ARCA de ese período, con la lista de archivos de abajo.
3. **Anota** de `RESUMEN.txt`:
   - la huella sha256 de cada archivo;
   - la determinación;
   - las líneas `[OK]` de la conciliación.

   Si alguna línea dice `[REVISAR]`, **no se carga**.

| Orden | Archivo del paquete | Pantalla del Portal IVA (borrador del período) | Comparar antes de seguir (fuente) |
|---|---|---|---|
| 1 | `LIBRO_IVA_DIGITAL_VENTAS_CBTE.txt` + `LIBRO_IVA_DIGITAL_VENTAS_ALICUOTAS.txt` | Libro IVA → Ventas → Importar (los dos juntos, «importes en Pesos Argentinos») | Cantidad de comprobantes = registros del CBTE (`RESUMEN.txt`, archivos incluidos) · débito fiscal del Portal = «Total del débito fiscal» · neto e IVA por alícuota |
| 1b | `*_VENTAS_TURIVA_*` (sólo si existen) | Libro IVA → Ventas TURIVA | Ídem, en la pestaña TURIVA |
| 2 | `LIBRO_IVA_DIGITAL_COMPRAS_CBTE.txt` + `LIBRO_IVA_DIGITAL_COMPRAS_ALICUOTAS.txt` | Libro IVA → Compras → Importar | Cantidad de comprobantes · crédito fiscal computable del Portal = «Crédito fiscal por compras» |
| 2b | `*_COMPRAS_TURIVA_*` (sólo si existen) | Libro IVA → Compras TURIVA | Ídem |
| 3 | `IVA_SIMPLE_DEBITO_FISCAL.csv` | Ajustes y otros conceptos → Apertura de otros conceptos → Débito fiscal | Débito de la apertura − restitución = débito del motor (línea de conciliación) |
| 4 | `IVA_SIMPLE_RESTITUCION_DEBITO_FISCAL.csv` | Ídem → Restitución de débito fiscal | Ídem |
| 5 | `IVA_SIMPLE_CREDITO_FISCAL.csv` | Ídem → Crédito fiscal | Computable − restitución = crédito por compras (línea de conciliación) |
| 6 | `IVA_SIMPLE_RESTITUCION_CREDITO_FISCAL.csv` | Ídem → Restitución de crédito fiscal | Ídem |
| 7 | — (carga manual) | Ajustes al crédito fiscal · saldos del período anterior | Valores de `CONCEPTOS_A_CARGAR_EN_ARCA.txt` (Anexo I / Art. 91, saldo técnico y libre disponibilidad anteriores) |
| 8 | `F2051_RETENCIONES.csv` · `F2051_PERCEPCIONES.csv` · `F2051_PERCEPCIONES_ADUANERAS.csv` | Retenciones y percepciones → Importar, **sólo si no están precargadas** (si lo están, validar las precargadas sin duplicar) | Suma = «Retenciones · Percepciones · Percepciones aduaneras» de la determinación |
| 9 | — | Determinación (vista previa, **sin presentar**) | Saldo técnico, saldo a favor de ARCA o de libre disponibilidad = `RESUMEN.txt` |

**Si una importación se rechaza:**
- se copia el mensaje textual y una captura, y se **detiene** ese bloque;
- **no** se reintenta quitando el encabezado ni cambiando el formato sin evidencia del formato exigido.

**Diferencias.** Una diferencia de totales se registra con el valor del Portal y el de `RESUMEN.txt`. No se ajusta nada en ARCA para «hacerla cerrar».

**Al terminar:**
- el período sigue «no presentado»;
- no se generaron F.2083, F.2051 ni VEP.

El resultado de cada archivo (aceptado o rechazado, con el mensaje) vuelve a #34 o a un PR nuevo como evidencia.

## Qué queda guardado en ARCA

- **Los datos importados quedan cargados** en el borrador de ese período: comprobantes, apertura y retenciones. Siguen visibles para el estudio y **no tienen efecto hasta presentar**.
- **Nada se presenta ni se paga:** no se generan F.2083 ni F.2051, acuses ni VEP.
- **A verificar en la sesión:**
  - si el Portal permite eliminar o reemplazar lo importado;
  - si la importación reemplaza o suma lo precargado.

  Si no se puede eliminar, lo importado será la base de la presentación real de ese período, después de revisarla. Por eso se elige un período que igual se va a presentar con estos datos.

## Cómo evitar una presentación accidental

- Usar un período **no** vencido y no presentado, con tiempo antes del vencimiento.
- Ninguna persona hace clic en botones de presentación ni de pago. Las capturas se toman **antes** de cualquier botón de acción.
- La app no tiene ni tendrá ese botón en esta etapa (ver [AUTOMATIZACION.md](AUTOMATIZACION.md)).
- Si el Portal pide confirmar algo que no sea una importación, **cancelar** y anotarlo.
- Al terminar, volver a revisar que el estado del período en el Portal siga como «no presentado».

## Resultado esperado y siguiente paso

Con el registro de cada importación:
- se confirma o se corrige la decisión del encabezado de los CSV;
- se ajusta el exportador si el Portal marca algún campo, con una prueba nueva y una nueva versión del motor;
- la presentación real sigue siendo una decisión aparte del titular, después de revisar el resumen.
