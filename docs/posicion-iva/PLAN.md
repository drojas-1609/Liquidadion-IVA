# Posición de IVA — relevamiento y plan de la etapa 2

**Estado:** relevamiento, sin código. Las reglas se codifican sólo con fuente oficial vigente verificada. El control con el período real del estudio se hace localmente, fuera del repositorio; acá sólo hay ejemplos sintéticos.

## Qué hace hoy el motor (`lib/liquidation-calc.ts`)

| Concepto | Hoy |
|---|---|
| Débito fiscal | Σ ventas, signo por código oficial, del IVA liquidado |
| Crédito fiscal | Directo (líneas computables) + prorrateo global; falla cerrada sin coeficiente |
| «Saldo técnico» | débito − crédito (puede ser negativo) |
| Retenciones / percepciones | **Una sola suma** de `TaxRecord` con tipo que contiene «IVA» (retención y percepción juntas) |
| Saldo a pagar | «saldo técnico» − esa suma; si es negativo se muestra «Saldo a favor», sin distinguir su naturaleza |

**No soporta:**
- saldo técnico a favor del período anterior;
- saldo de libre disponibilidad anterior;
- percepciones aduaneras y pagos a cuenta;
- restituciones.

## Defectos a corregir en esta etapa

1. **Se mezclan los dos saldos a favor.** Hoy un saldo técnico a favor (crédito mayor que débito) absorbe retenciones y percepciones como si fueran el mismo saldo. Son saldos distintos: el técnico se traslada al período siguiente y el de libre disponibilidad tiene otro régimen.
2. **Percepciones de IVA de las compras.** La importación guarda las percepciones de IVA sufridas (`Invoice.vatPerceptionAmount`, campo 12 del libro de compras), pero la posición no las toma. Si además se cargan como `TaxRecord`, hay riesgo de omitirlas o de duplicarlas. Hay que definir una fuente única antes de mostrarlas.
3. **Retenciones y percepciones van juntas** en la pantalla y en el Excel.

## Estructura objetivo

Grilla «Liquidación» del F.2002, según el [Manual del Usuario F.2002, Mis Aplicaciones Web, v1.0.0 (24/02/2016), §3.4](https://www.afip.gob.ar/claveFiscal/manuales/documentos/dit.mis_aplicaciones_web.CF_MU_MAW_F2002-1.0.0.pdf). **Antes de codificar, verificar que la grilla siga vigente en el F.2002 del Portal IVA actual.**

1. Total del débito fiscal
2. Total del crédito fiscal (y ajustes anuales por operaciones exentas)
3. Saldo técnico a favor del responsable del período anterior (lo carga el usuario)
4. Saldo técnico del período: a favor de ARCA o del contribuyente
5. Saldo a favor de libre disponibilidad del período anterior, neto de usos
6. Retenciones sufridas · percepciones impositivas sufridas · percepciones aduaneras · pagos a cuenta (cada uno por separado)
7. Restituciones de percepciones y retenciones
8. Saldo de libre disponibilidad a favor del contribuyente del período / saldo de impuesto a favor de ARCA

## Datos a agregar (requiere migración, a planificar)

- Por período:
  - saldo técnico anterior;
  - saldo de libre disponibilidad anterior neto de usos;
  - referencia (DJ anterior o cálculo de la app), origen y quién lo cargó.
- Retenciones y percepciones con tipo separado (catálogo cerrado actual: retención IVA / percepción IVA) y la decisión sobre la fuente única de las percepciones de compras.
- **Lo que el par de TXT no informa**, como clasificación pendiente de revisión del estudio y nunca inferida:
  - en ventas, el tipo de sujeto comprador (responsable inscripto, monotributista, consumidor final o exento). Una factura A no lo determina;
  - en compras, el concepto del crédito (bienes, locaciones, prestaciones de servicios o bienes de uso).

## Ejemplo sintético de la grilla

| Renglón | Importe |
|---|---|
| Débito fiscal | 1.000,00 |
| Crédito fiscal computable | 400,00 |
| Saldo técnico a favor del responsable del período anterior | 100,00 |
| Saldo técnico a favor de ARCA del período | 500,00 |
| Libre disponibilidad anterior · retenciones · percepciones · pagos a cuenta | 0 |
| Saldo a favor de ARCA | 500,00 |

El motor actual daría 600,00: no admite el saldo técnico anterior.

## Control local con un período real del estudio

Se corre fuera del repositorio, con los TXT autorizados: vista previa de la importación → liquidación en memoria → comparación con el saldo a pagar que informa el sistema anterior. Ninguna cifra real entra en Git, fixtures ni entornos remotos.
