# Reglas de alícuotas de Ingresos Brutos (conjuntos por norma)

Un archivo `<id>.json` por conjunto de reglas, generado por un script reproducible desde la norma oficial. Las reglas están separadas de los catálogos de actividades y nunca se editan a mano: un cambio normativo es un conjunto nuevo.

Sólo se usan para sugerir los conjuntos aprobados (niveles `technical`, `validity` e `interpretation` en CONFORME, y `REVISADO`) registrados en `lib/iibb-rates/registry.ts`. Las reglas marcadas `pendingInterpretation` nunca se usan. Toda sugerencia requiere aceptación explícita en la ficha.

| Archivo | Norma | Generador | Estado |
|---|---|---|---|
| `caba-ley-6927-2026.json` | CABA, Ley 6927 (Ley Impositiva 2026, con fe de erratas) y Ley 6948 | `scripts/iibb-rates/caba-2026.ts` | REVISADO (24/11/2026); retenido sólo el 4 % residencial |
| `arba-ley-15558-2026.json` | Provincia de Buenos Aires, Ley 15.558 (Impositiva 2026), art. 20, contrastada con la exportación de ARBA | `scripts/iibb-rates/arba-2026.ts` | REVISADO (24/11/2026); 1022 códigos, con avisos y alternativas arts. 22 y 134 |
| `corrientes-rg-293-2025.json` | Corrientes, RG DGR 293/2025 Anexo I y Ley Tarifaria 6249 art. 10 (mínimos) | `scripts/iibb-rates/table-2026.ts` (`ctes-2026`) | REVISADO (26/11/2026); 1008 códigos, 16 retenidos |
| `santa-cruz-ley-3485-2026.json` | Santa Cruz, Ley 3485, anexo de referencia de ASIP (nomenclador ARCA) | `scripts/iibb-rates/table-2026.ts` (`sc-2026`) | REVISADO (26/11/2026); 949 códigos |

Qué cubre y qué no: `docs/catalogos-actividades/README.md`, «Reglas de alícuotas de CABA 2026». Guía de revisión: `docs/catalogos-actividades/REVISION.md`.
