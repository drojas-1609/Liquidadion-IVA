# Catálogos oficiales de actividades (versiones)

Un archivo `<id>.json` por versión, generado con `scripts/activity-catalogs/cli.ts` (`import` o `import-pdf-table`) a partir del archivo oficial descargado a mano. Nunca se editan las entradas a mano ni se sobrescribe una versión: una actualización es un archivo nuevo (`supersedes`).

Sólo se publican las versiones aprobadas por el estudio (niveles `technical` y `validity` en CONFORME, y `REVISADO`) registradas en `lib/activity-catalog/registry.ts`. Procedimiento y fuentes: `docs/catalogos-actividades/README.md`.

| Archivo | Fuente | Entradas | Estado |
|---|---|---|---|
| `naes-rg-ca-19-2025.json` | Comisión Arbitral, RG CA 19/2025, anexo I (XLSX) | 1013 (con vigencia por código) | REVISADO — aprobación expresa del estudio 28/10/2026 |
| `clae-rg-afip-3537-2013.json` | AFIP/ARCA, RG 3537/2013, anexo «Estructura detallada» (PDF) | 951 | REVISADO — aprobación expresa del estudio 28/10/2026 |
| `arba-naiibb18-2026-10-27.json` | ARBA, NAIIB-18 (RN 38/2017 y modif.), exportación oficial del 27/10/2026 (texto tabulado) | 1035 (vigencia por código) | REVISADO — aprobación expresa del estudio 28/10/2026 |

`arba-naiibb18-2026-10-27.correspondencias.json`: correspondencias publicadas por ARBA (NAIIB 99, equivalencia AFIP, documentación tributaria). Son datos de referencia que la aplicación no carga ni aplica.
