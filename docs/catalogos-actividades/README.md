# Catálogos oficiales de actividades, asistencia de alícuotas y errores por campo

Estado: **implementación local**, sin commits, sin migraciones remotas. La migración `20261027120000_activity_catalog_rate_origin` está **preparada, no aplicada** en DEV ni PROD.

**Cobertura al 28/10/2026.** Diego Rojas aprobó expresamente los tres nomencladores oficiales cargados, con sus niveles técnico y de vigencia. Se habilitan la búsqueda y copia de actividades. **Las reglas de alícuotas continúan pendientes de revisión y no se habilitan.**

| Dato | Archivo | Contenido | Estado |
|---|---|---|---|
| NAES | `data/activity-catalogs/naes-rg-ca-19-2025.json` | 1013 códigos con vigencia propia: 4 bajas al 31/12/2025 y 18 altas desde 01/2026 | `REVISADO` (28/10/2026) |
| ARCA / CLAE F.883 | `data/activity-catalogs/clae-rg-afip-3537-2013.json` | 951 actividades | `REVISADO` (28/10/2026) |
| Alícuotas CABA 2026 | `data/iibb-rate-rules/caba-ley-6927-2026.json` | 33 reglas sobre 799 códigos NAES de las Planillas 1 a 11. **15 retenidas** por interpretación pendiente: la Ley 6948 desde junio y el 4 % residencial | `PENDIENTE_REVISION` |
| NAIIB-18 (ARBA, 902) | `data/activity-catalogs/arba-naiibb18-2026-10-27.json` (+ `.correspondencias.json`, no aplicado) | 1035 códigos de la exportación oficial del 27/10/2026 | `REVISADO` (28/10/2026) |
| Alícuotas Buenos Aires 2026 | `data/iibb-rate-rules/arba-ley-15558-2026.json` | 71 reglas sobre 1022 códigos, contrastadas con el art. 20 de la Ley 15.558 sin diferencias; 222 códigos retenidos | `PENDIENTE_REVISION` |
| Alícuotas Santa Cruz | — | Anexo I oficial de la Ley 3760 (BO 25/11/2021) leído y cotejado sólo como evidencia | **Pendiente**: vigencia posterior a 2021 no acreditada (ver `REVISION.md`) |
| Alícuotas Corrientes | — | Ley 6249 (copia oficial de la DGR, 2021), con alícuotas por descripción | **Pendiente**: falta el texto oficial de la RG DGR 293/2025 |

**Ninguna regla condicionada se guarda como «sugerencia de la norma»:** el servidor no puede acreditar al guardar los ingresos ni los hechos declarados, que no se guardan. Esas alícuotas se registran como **decisión del estudio** (`STUDIO_MANUAL`), sin `ruleRef`. Hoy todas las reglas cargadas (CABA y Buenos Aires) son condicionadas.

Lo que el estudio tiene que revisar está en [`REVISION.md`](REVISION.md). La evidencia persistente (fuentes, textos extraídos, cotejos y SHA-256) está fuera del repo, en `~/Liquidador-evidencia-fiscal/2026-10-27-catalogos-alicuotas/`.

El sistema **no afirma cobertura nacional**. Sin un catálogo revisado, la ficha usa la carga manual identificada como tal. Sin reglas revisadas, la asistencia responde «Alícuota pendiente de determinar».

## Fuentes oficiales (consultadas y descargadas el 2026-10-27)

| Ámbito | Organismo | Norma, publicación y vigencia | Archivo oficial (sha256) | Cómo se verificó |
|---|---|---|---|---|
| NAES | Comisión Arbitral del Convenio Multilateral | [RG CA 19/2025](https://www.ca.gob.ar/resoluciones/resoluciones/gr/2025/2025-19.pdf), del 10/12/2025, [BO 15/12/2025](https://www.boletinoficial.gob.ar/detalleAviso/primera/336184/20251215). Es un ordenamiento integral sin cambios normativos. Integra la [RG CA 12/2025](https://www.ca.gob.ar/resoluciones/resoluciones/gr/2025/2025-12.pdf), aplicable desde el 01/01/2026: altas, y bajas de 530090, 631110, 631120 y 649290. El sitio de la CA la rotula «Versión vigente». Revisé las RG CA 2026 número 1, 2 y 4 a 11, y la 3/2026 en el [BO del 02/03/2026](https://www.boletinoficial.gob.ar/detalleAviso/primera/338936/20260302) (ordenamiento jurídico de las normas de la CA): ninguna modifica el NAES. No revisé las Disposiciones ni normas posteriores al 19/10/2026 | [ANEXO_NAES_RG_19-2025.xlsx](https://www.ca.gob.ar/descargas/padron_federal/ANEXO_NAES_RG_19-2025.xlsx), 211 958 bytes (`f1bb5ccb…aca31c`) | Contra el anexo I en PDF de la RG 19/2025 (`b30af3a1…5747ea`): 1013 códigos en el mismo orden, sin códigos de más, descripciones y vigencias idénticas (`cli.ts crosscheck`, 0 diferencias). Los 4 códigos dados de baja coinciden con el art. 3° de la RG 12/2025 |
| ARCA / CLAE F.883 | AFIP (hoy ARCA) | [RG AFIP 3537/2013](https://biblioteca.arca.gob.ar/search/query/norma.aspx?p=t:RAG%7Cn:3537%7Co:3%7Ca:2013%7Cf:30/10/2013), sancionada el 30/10/2013, [BO 01/11/2013](https://www.argentina.gob.ar/normativa/nacional/resoluci%C3%B3n-3537-2013-221649), aplicable desde el 01/11/2013 (art. 2°) y «Vigente» según la Biblioteca de ARCA. La RG 5607/2024, que llevaba la nómina a 966 actividades, fue [abrogada por la RG 5612/2024](https://www.argentina.gob.ar/normativa/nacional/norma-407012) (BO 10/12/2024) | Anexo «Estructura detallada» `RG_3537_AFIP_A1_ESTDET.pdf` (PDF de texto del 18/11/2013, 36 páginas, `6027657f…784565af`) | Importado del PDF con posiciones de línea (PDFKit, `cli.ts import-pdf-table`): 951 códigos, que es la cifra de la norma. Coincide con los 951 códigos ARCA de la tabla de equivalencias de la RG CA 19/2025, usada **sólo para cotejar** y no como equivalencia. 941 descripciones son idénticas. Contra el [nomenclador en línea de ARCA](https://serviciosweb.afip.gob.ar/genericos/nomencladoractividades/index.aspx), consultado el 27/10/2026, coinciden los 951 códigos y 950 descripciones; 492150 difiere sólo por un artefacto de la página (`cli.ts compare-arca-web`) |
| Alícuotas CABA 2026 | Legislatura de la Ciudad | [Ley 6927](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/829857) (Ley Impositiva 2026): sanción 27/11/2025, BOCBA 7269 del 19/12/2025, vigencia 01/01/2026. Su anexo trae la fe de erratas de BOCBA 7275 (02/01/2026). [Ley 6948](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/855152), BOCBA 7369 del 19/05/2026, sustituye los arts. 3°, 5°, 6° y 8° a 11 desde el primer día hábil del mes siguiente (lunes 01/06/2026). La [Ley 6942](https://boletinoficial.buenosaires.gob.ar/normativaba/norma/850088) sólo agrega una cláusula transitoria de Patentes | [Anexo con fe de erratas](https://documentosboletinoficial.buenosaires.gob.ar/publico/PL-FEERR-LCABA-LCABA-6927-25-ANX.pdf) (`318aad34…7827b0`) y [Ley 6948](https://documentosboletinoficial.buenosaires.gob.ar/publico/ck_PL-LEY-LCABA-LCBA-6948-26-7369.pdf) (`588681c6…b85b59c`) | Tasas y umbrales transcriptos de los arts. 1° a 11. El generador comprueba que cada una de las 848 filas de las planillas del PDF tenga las tasas de su artículo (1277 celdas). Las planillas del anexo original y del corregido son idénticas |
| Alícuotas Santa Cruz | ASIP | Ley Impositiva 3485 y modificatorias (Leyes 3596, 3759 y 3760, según la búsqueda) | — | **Pendiente**: el 27/10/2026, en todos los reintentos, el sitio de ASIP respondía 503 y el dominio del digesto provincial no resolvía. No se pudo leer el texto vigente ni las modificatorias. La tabla NAES de ASIP de 2021 no se usa como vigente. Queda la carga manual |

Herramientas de extracción: **PDFKit de macOS** (vía `swift`, que ya estaba instalado; `scripts/activity-catalogs/pdftext.swift` y `pdflines.swift`) y el paquete `xlsx`, que ya era dependencia. **No se agregó ninguna dependencia.** No hay `pdftotext`, `pypdf` ni `pdfplumber`. Los PDF usados tienen texto (no son escaneos), así que no hizo falta OCR.

Reglas que siguen:
- No se usan fuentes secundarias (blogs, calculadoras) para datos fiscales.
- No se usa IA para extraer códigos ni tasas: la extracción es determinística (PDFKit y `xlsx`) y se coteja.
- No se inventan ediciones anuales: si el organismo mantiene vigente una versión, se usa esa versión con su vigencia.

## Modelo

- **Catálogos** (`data/activity-catalogs/<id>.json`, `lib/activity-catalog/`):
  - Cada versión es un archivo con su manifiesto: organismo, fuente y norma, fechas de publicación y consulta, versión, vigencia, jurisdicción si es provincial, checksums de la fuente y de las entradas, y estado de revisión.
  - Los códigos son **strings**, con ceros iniciales.
  - Una actualización es un **archivo nuevo** (`supersedes`) y nunca sobrescribe el anterior.
  - Se publican sólo las versiones `REVISADO` registradas en `lib/activity-catalog/registry.ts`, que además se revalidan al cargar (estructura y checksum).
- **Reglas de alícuotas** (`lib/iibb-rates/`): están separadas del catálogo. Cada conjunto corresponde a una norma de una jurisdicción y su nomenclador (NAES o provincial), con vigencia y revisión propias. Cada regla tiene:
  - códigos exactos;
  - inscripciones a las que aplica;
  - vigencia propia, para cambios dentro del año;
  - tratamiento (`RATE` o `EXEMPT`) y tasa;
  - condiciones: umbral de ingresos del ejercicio anterior o hechos declarados;
  - referencia legal.

  **No hay reglas sobre ARCA/CLAE**: nunca se infiere una tasa de IIBB a partir de ARCA.
- **Ficha** (migración `20261027120000`, aditiva):
  - `ClientActivity.origin` (`CATALOG` o `MANUAL`) con `catalogId` y `catalogVersion`. La copia de catálogo es fija: código, descripción, referencia y versión.
  - `ClientActivityRate.treatment` (`RATE` o `EXEMPT`), `rateOrigin` (`STUDIO_MANUAL` o `CONFIRMED_SUGGESTION`) y `ruleRef`.
  - Los CHECK garantizan:
    - copia de catálogo completa;
    - exención sin tasa;
    - regla sólo en una sugerencia confirmada;
    - dato ausente sin origen.
  - Las filas existentes quedan `MANUAL` y `RATE` sin origen registrado, sin transformar datos.
  - **0 %, exento y sin informar** son tres datos distintos.

## Procedencia (autoridad: servidor)

`lib/iibb-profile-sources.ts`, en el alta y en la edición:
- Una actividad `CATALOG` nueva o modificada debe coincidir **exactamente** con una entrada de una versión revisada.
- Una tasa `CONFIRMED_SUGGESTION` debe coincidir con una regla revisada de esa jurisdicción, nomenclador y código: mismo tratamiento y misma tasa.
- Lo guardado **sin cambios no se reverifica**. Si se retira una versión de catálogo o una norma, las fichas siguen editables y conservan su copia: nada cambia en silencio.

## Importar y publicar un catálogo (reproducible, sin automatizaciones)

Todos los comandos pasan por `scripts/activity-catalogs/cli.ts`, porque vite-node no deja que un módulo detecte si es el principal. Ningún comando descarga nada ni se conecta a una base.

1. **Descargar a mano** el archivo oficial a un directorio nuevo y registrar la URL, la fecha, el tamaño y el sha256.
2. **Importar.** El resultado queda siempre en `PENDIENTE_REVISION` y nunca sobrescribe. La importación falla ante filas incompletas, duplicados, códigos numéricos sin `--code-length` o vigencias que no sean `MM/AAAA` o `AAAA-MM-DD`.
   - Desde una planilla (NAES):
     ```bash
     npx --no-install vite-node scripts/activity-catalogs/cli.ts -- import \
       --source ANEXO_NAES_RG_19-2025.xlsx --sheet "Anexo I_NAES_ordenado" \
       --code-header "Código NAES" --description-header "Descripción de la Actividad" --code-length 6 \
       --valid-from-header "Inicio de Vigencia:" --valid-to-header "Fin de Vigencia:" \
       --id naes-rg-ca-19-2025 --nomenclator NAES --name "NAES – Ordenamiento integral (Anexo I)" \
       --organism "Comisión Arbitral del Convenio Multilateral" --norm "RG CA 19/2025" \
       --version "Ordenamiento integral RG CA 19/2025" --source-url https://www.ca.gob.ar/descargas/padron_federal/ANEXO_NAES_RG_19-2025.xlsx \
       --published 2025-12-15 --consulted 2026-10-27 --valid-from 2018-01-01 --out data/activity-catalogs/naes-rg-ca-19-2025.json
     ```
     El XLSX guarda los códigos como número con formato `000000`. Con `--code-length 6` se completan los ceros a la izquierda en 120 códigos, y en los 1013 el resultado coincide con el texto que muestra la planilla.
   - Desde un PDF de texto (CLAE). Primero se vuelcan las líneas con su posición y después se importa:
     ```bash
     swiftc -O -o /tmp/pdflines scripts/activity-catalogs/pdflines.swift
     /tmp/pdflines RG_3537_AFIP_A1_ESTDET.pdf > clae.lines
     npx --no-install vite-node scripts/activity-catalogs/cli.ts -- import-pdf-table \
       --pdf RG_3537_AFIP_A1_ESTDET.pdf --lines clae.lines --until "TABLA ANEXA AL F. 883" --code-x 120:130 --description-x 155 \
       --id clae-rg-afip-3537-2013 --nomenclator ARCA --name "CLAE – Clasificador de Actividades Económicas F. 883 (Anexo, estructura detallada)" \
       --organism "AFIP (hoy ARCA)" --norm "RG AFIP 3537/2013" --version "F. 883 – RG 3537/2013 (951 actividades)" \
       --source-url "https://biblioteca.arca.gob.ar/search/query/adjunto.aspx?p=t:RAG|n:3537|o:3|a:2013|d:RG_3537_AFIP_A1_ESTDET.pdf" \
       --published 2013-11-01 --consulted 2026-10-27 --valid-from 2013-11-01 --out data/activity-catalogs/clae-rg-afip-3537-2013.json
     ```
     Las notas «(Incluye…)» no se copian, y la «Tabla anexa» de responsables no comprendidos (jubilado, estudiante, etc.) no es una actividad y queda afuera.
3. **Cotejar.**
   - Contra el anexo en PDF, cuando la norma lo publica: `pdftext.swift` y `cli.ts -- crosscheck --file … --text … --from "…" --until "…"`.
   - El CLAE, además, contra el nomenclador web de ARCA: `cli.ts -- compare-arca-web --file … --html …`.
   - Los cotejos informan códigos faltantes o sobrantes y descripciones o vigencias distintas, y salen con código 3 si hay diferencias.
4. **Registrar los resultados del preparador** con `cli.ts -- add-check --file … --level … --kind AUTOMATICO|INVESTIGACION --result … --summary … --evidence …`. No cambian ninguna decisión.
5. **Revisión del estudio, nivel por nivel:** `cli.ts -- review --file … --level technical|validity --decision CONFORME|OBSERVADO …`. Después, la aprobación final con `cli.ts -- approve …`, que sólo funciona con todos los niveles CONFORME. La guía está en `REVISION.md`.
6. **Registrar** la versión en `lib/activity-catalog/registry.ts`, con un import explícito revisable en el PR. Los tres nomencladores actuales están registrados y aprobados; las versiones nuevas siguen requiriendo revisión propia.

### Revisión por niveles

`lib/activity-catalog/review.ts`. Cada archivo tiene, por nivel, la **decisión del estudio** y aparte los **checks del preparador**:

- **Decisiones:** `PENDIENTE`, `OBSERVADO` (con notas) o `CONFORME`, con revisor y fecha.
- **Niveles:**
  - catálogos: `technical` y `validity`;
  - reglas: además, `interpretation`.
- **Publicación:** `REVISADO` exige todos los niveles CONFORME y una aprobación final. Una decisión nueva sobre algo aprobado lo devuelve a pendiente.
- **Controles en el servidor:** el buscador, la asistencia y la verificación de procedencia exigen la aprobación completa.

Una versión nueva **no modifica clientes**, porque la ficha guarda copias.

**Vigencia por código.** Una versión puede traer vigencias propias por código, como el anexo I de la RG CA 19/2025, que tiene «Inicio» y «Fin de Vigencia». El buscador ofrece cada código sólo dentro de su vigencia efectiva, que es la de la versión acotada por la del código. Con «incluir históricos», los muestra marcados como no vigentes.

## Reglas de alícuotas de CABA 2026

`scripts/iibb-rates/caba-2026.ts` (`cli.ts -- caba-2026`) arma el conjunto así:

- **Planillas.** Lee las Planillas 1 a 11 del anexo corregido de la Ley 6927.
- **Tasas transcriptas.** Las tasas y umbrales de los arts. 1° a 11 están transcriptos en el script (`ARTICLES`). La generación **falla** si una fila del PDF tiene otras tasas o si un código no está vigente en el NAES 2026.
- **Arts. con umbral** (3°, 5°, 6° y 8° a 11), dos tramos por ingresos brutos anuales del ejercicio fiscal anterior:
  - del 01/01 al 31/05/2026, los umbrales de la Ley 6927: $2.004.000.000, y $364.000.000 en el art. 5°;
  - desde el 01/06/2026, los de la Ley 6948: $2.154.300.000, y $391.128.000 en el art. 5°. Estas 14 reglas están **retenidas** (`pendingInterpretation`) hasta que el estudio decida el inicio de vigencia (art. 10) y el alcance de la «adecuación de las planillas» (art. 9°);
  - las tasas no cambian;
  - «iguales o inferiores» lleva la tasa baja.
- **Tasa única:** art. 1° (0 % explícito, que no es exención), art. 2° (1 %), art. 4° (2 %) y art. 7° (2 %).
- **Art. 3°, consumidor residencial:** el 4 % queda **retenido**. Exceptúa «el inciso 20 del artículo 19 y el artículo 58», y el art. 58 del Anexo trata de carteles publicitarios. Mientras esté retenido, la tasa general de la Planilla 3 nunca se presenta como única.
- **Reglas retenidas:** nunca se sugieren ni se aceptan al guardar, aunque el conjunto esté aprobado. Si una retenida podría aplicar, la respuesta lo informa y no es «única».
- **Hechos declarados.**
  - Cada regla exige declarar «sin otro tratamiento en la Ley Impositiva ni en el Código Fiscal», porque así lo condicionan los arts. 1° a 11.
  - El art. 2° exige además: ventas que no sean a los Estados ni a consumidores finales, actividad industrial no hidrocarburífera, y que no se trate de ventas de bienes de uso.
  - Sin esas declaraciones, la respuesta es «alternativas, con datos faltantes». El panel permite declararlos para la consulta, sin guardarlos, y arrancan siempre en «Sin indicar».
  - Para confirmar una alternativa con condiciones sin verificar hay que marcar la aceptación, que nunca viene marcada.
- **Quedan sin regla** (respuesta «Alícuota pendiente de determinar»):
  - los 187 códigos citados en los arts. 12 a 21 y 26, porque según el art. 22 el articulado prevalece sobre las planillas; 39 de ellos figuran también en planillas;
  - los 18 códigos NAES que no figuran en ninguna planilla, como administración pública, organizaciones religiosas u obras sociales.
- **Códigos en dos planillas:** cinco códigos figuran en dos planillas a la vez (301200, 302000 y 303000 en las Planillas 2 y 5; 639100 y 639900 en las 8 y 11). Quedan **sin tasa automática**.
- **Fecha de la consulta:** la elige el usuario en el panel (por defecto, hoy en Argentina), porque las normas cambian dentro del año. La regla confirmada queda guardada con su `ruleRef`, que identifica el tramo y su vigencia.
- **Fuera de 2026 no hay cobertura.**

## Asistencia de alícuotas

`POST /api/iibb-rates/suggest`. Los datos del cliente van en el cuerpo, nunca en la URL, y no se guardan. Respuestas posibles:

| Estado | Cuándo |
|---|---|
| `SIN_COBERTURA` | No hay un conjunto revisado vigente para esa jurisdicción, nomenclador y fecha (o hay más de uno) |
| `SIN_REGLA` | La norma no tiene una regla para ese código |
| `NO_APLICA` | Ninguna regla aplica con los datos y la fecha indicados |
| `UNICA` | Una sola regla y todas sus condiciones verificadas con datos |
| `ALTERNATIVAS` | Varias reglas posibles o datos faltantes (por ejemplo, ingresos del ejercicio anterior o inscripción) |

En todos los casos:
- La UI muestra la fuente, la vigencia, la referencia legal y las condiciones.
- **Nada se incorpora sin «Confirmar»**, y nunca se presenta como aplicable a todos los contribuyentes.
- La tasa manual del estudio se identifica como tal.
- No se calcula Convenio Multilateral ni cambia la liquidación.

## Alícuota del cálculo actual (`defaultIibbRate`)

Por decisión del 27/10, se edita **dentro de la ficha**, sin pantalla separada.

- **Rótulo:** «Alícuota del cálculo actual (%)». El texto aclara que el cálculo y las exportaciones todavía usan este único valor, que no se obtiene automáticamente de las actividades ni de las alícuotas por jurisdicción y que no representa una liquidación por jurisdicción.
- **Estado mostrado:**
  - en el alta, «3 %: valor predeterminado, pendiente de confirmación», o «Valor indicado en el alta» si se cambia;
  - en clientes existentes, «Sin constancia de revisión», porque no se puede inferir si el estudio lo revisó.
- **Envío:** sólo si cambió. Sin cambios, el alta usa el valor predeterminado del contrato (3) y la edición conserva el guardado.
- **Validación:** las mismas reglas que la API (obligatoria, sin signo, máximo de decimales), con el error junto al campo.
- **Liquidación y Excel:** una aclaración junto a la alícuota (texto en la pantalla y en la columna C del Excel). Fórmulas y resultados no cambian.
- **Sin migración ni cambio de valores existentes:** no se registra quién revisó la alícuota ni cuándo.

## Errores visibles y accesibles

- Hay un resumen en el encabezado con enlaces a cada campo, y el foco va al primer error al enviar.
- Junto a cada campo:
  - borde y mensaje con texto «Error:» e ícono, no sólo color;
  - `aria-invalid` y `aria-describedby`.
- **Claves estables:**
  - las filas de actividades se identifican por `uid`, nunca reutilizado;
  - las alícuotas, por jurisdicción;
  - los errores del servidor (con índices) se traducen con la foto de lo enviado.
- **Tipos de error separados:** validación, conflicto de versión (409, con el borrador conservado y el reenvío bloqueado, como en el PR #17) y error general.
- Las reglas no se duplican: se reutiliza el validador autoritativo (`validateIibbProfile`) por campo y por fila.

## ARCA (sin cambios de configuración)

La consulta sigue **no configurada** («Consulta ARCA no configurada») y la carga manual funciona siempre.

Cómo se vincularían las actividades obtenidas de ARCA, con el CLAE ya importado y una vez revisado:
- Se busca el **código exacto** en la versión revisada y vigente del CLAE.
- Si existe, se propone como actividad `CATALOG` (nomenclador ARCA) con la descripción oficial. Si no, queda como carga manual «informada por ARCA».
- **Nunca** se deriva una actividad NAES ni provincial, ni una tasa de IIBB, a partir del código ARCA. Las tablas de equivalencia NAES↔ARCA de la Comisión Arbitral son de otro organismo y no se aplican automáticamente.

Hoy las actividades propuestas por ARCA se agregan como carga manual identificada.

## Limitaciones y pendientes

- **Revisión del estudio:** NAES, CLAE y CABA tienen todos sus niveles en PENDIENTE. Hasta la aprobación completa no se publican. La guía está en `REVISION.md`.
- **CABA:**
  - Desde el 01/06/2026 no hay tasas habilitadas para las Planillas 3, 5, 6 y 8 a 11, porque las reglas de la Ley 6948 están retenidas hasta que decidas sus arts. 9° y 10.
  - Los tratamientos especiales de los arts. 12 a 21 y 26 y las exenciones del Código Fiscal no están modelados: quedan sin regla o como condición declarada.
  - La alícuota subsidiaria del art. 21 tampoco está modelada.
- **Santa Cruz:** no hay cobertura. Hay que obtener de fuente oficial el texto vigente de la Ley 3485 y de sus modificatorias, que hoy no se pudieron consultar.
- **Otras jurisdicciones:** sin revisar.
- **Extracción:** depende de PDFKit (macOS). En otro sistema operativo se puede volver a correr la importación desde los volcados de líneas, que son texto, o con un extractor equivalente que produzca el mismo formato.
- **Descripciones del CLAE:** 10 difieren de la transcripción de la Comisión Arbitral. El anexo de ARCA y el nomenclador en línea de ARCA coinciden con el texto importado, así que no se sustituyó nada.
- **Convenio Multilateral:** no se calcula y la liquidación no cambia.
- **Pruebas en navegador:** no hubo pruebas manuales en un navegador real. Los tests de lógica y de rutas no demuestran el comportamiento visual ni de foco.
- **Catálogo sintético de prueba visual:** `lib/preview-fixtures/` contiene un catálogo y reglas «[PRUEBA] … (no oficial)». Sólo se empaqueta y se sirve en un Deploy Preview conectado a DEV, con activación explícita y vencimiento. Fuera de ese caso, el build de producción no lo incluye; se comprueba con `node scripts/preview-fixtures/verify-build.mjs --expect absent`. Detalle en `PRUEBA-VISUAL.md`.
