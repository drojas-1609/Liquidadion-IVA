# Validación de aceptación en ARCA (procedimiento propuesto, NO ejecutado: pendiente)

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
