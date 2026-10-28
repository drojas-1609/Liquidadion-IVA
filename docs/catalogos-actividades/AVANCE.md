# Avance: catálogos de actividades, asistencia de alícuotas y errores por campo

Rama `feature/catalogos-actividades-validacion`, en el worktree `.claude/worktrees/catalogos-actividades-validacion`.
- Se creó desde `origin/main` = `40413ea` (merge del PR #17).
- No tiene upstream configurado: no hay push, commits ni PR.
- `node_modules` es una copia local independiente (clon APFS), así que `prisma generate` no afecta a otros worktrees.

## Estado (2026-10-27)

- [x] Preflight: PR #17 mergeado; `origin/main` = `40413ea`, sin avances posteriores.
- [x] Investigación de fuentes oficiales (`README.md`, «Fuentes»).
- [x] Descarga e importación del NAES (RG CA 19/2025, XLSX, sha256 `f1bb5ccb…`): 1013 códigos con vigencia por código; cotejado contra el anexo PDF sin diferencias. **Pendiente de revisión del estudio.**
- [x] CLAE (RG AFIP 3537/2013) importado desde el PDF de la Biblioteca de ARCA con PDFKit: 951 actividades, que es la cifra de la norma (la RG 5607 fue abrogada). **Pendiente de revisión del estudio.**
- [x] Reglas CABA 2026 (Ley 6927 con fe de erratas y Ley 6948): 33 reglas sobre 799 códigos, generadas y cotejadas contra las planillas. 15 reglas **retenidas** (Ley 6948 desde junio y el 4 % residencial) y 5 códigos ambiguos sin tasa. **Pendientes de revisión del estudio.**
- [x] (27/10, segunda pasada) Revisión por niveles: `technical`, `validity` e `interpretation`, con decisiones del estudio separadas de los checks del preparador. Reglas retenidas. Fecha de referencia y aceptación explícita en el panel.
- [x] RG CA 3/2026 resuelta con el BO: ordenamiento jurídico, no modifica el NAES.
- [x] CLAE: las 10 discrepancias con la CA se contrastaron con el nomenclador en línea de ARCA; el texto importado coincide.
- [x] Evidencia persistente en `~/Liquidador-evidencia-fiscal/2026-10-27-catalogos-alicuotas/` (`LEEME.md`, `SHA256SUMS`).
- [ ] Santa Cruz: fuentes oficiales no disponibles el 27/10 (ASIP 503 en todos los reintentos, digesto sin DNS). Cobertura pendiente; queda la carga manual.
- [x] Modelo y migración aditiva `20261027120000_activity_catalog_rate_origin` (no aplicada; DDL igual al `prisma migrate diff` + 3 CHECK).
- [x] Catálogos versionados, validación, checksum, registro (NAES y CLAE pendientes), buscador y API (`/api/activity-catalogs`, `/search`).
- [x] Importadores (XLSX y PDF de texto), cotejo contra PDF y revisión reproducibles (`scripts/activity-catalogs/cli.ts`), siempre en `PENDIENTE_REVISION`.
- [x] Reglas de alícuotas separadas, validación y motor de sugerencias (`/api/iibb-rates/suggest`). CABA 2026 generado y pendiente de revisión; Santa Cruz sin datos.
- [x] Procedencia verificada en el servidor (catálogo y regla) sin reverificar lo guardado y sin cambios.
- [x] Alícuota del cálculo actual: editable en la ficha y enviada sólo si cambió. Sin pantalla separada (el parche se descartó).
- [x] Errores por campo accesibles con claves estables, y clasificación validación/conflicto/general.
- [x] Validaciones finales:
  - Prisma validate/generate con URLs ficticias;
  - `tsc` sin errores;
  - Vitest: 2919 tests en verde, 10 omitidos (al 27/10, después de importar datos oficiales);
  - ESLint con `--max-warnings=0`;
  - `next build` sin credenciales;
  - `git diff --check`.
- [ ] Prueba manual en navegador (foco, enlaces del resumen, lectores de pantalla): no realizada.

## Para retomar

1. Revisión del estudio de NAES, CLAE y CABA con la guía de `REVISION.md`: `cli.ts review` por nivel y `cli.ts approve`. Ya están registrados.
2. Decisiones de CABA: arts. 9° y 10 de la Ley 6948, la remisión al art. 58 del art. 3° y los arts. 12 a 21. Después, regenerar el conjunto sin las retenciones que se resuelvan.
3. (Resuelto el 27/10: la alícuota del cálculo actual se edita en la ficha.)
4. Santa Cruz: reintentar ASIP y el Boletín Oficial provincial para obtener la Ley 3485 vigente y sus modificatorias.
5. Prueba visual en la Preview, cuando se autorice publicar: buscador, panel de alícuotas con hechos declarados y errores por campo.

Evidencia: las fuentes, los textos extraídos, los cotejos y las copias de los manifiestos están en `~/Liquidador-evidencia-fiscal/2026-10-27-catalogos-alicuotas/` (fuera del repo, en sólo lectura, con `SHA256SUMS`). El repo guarda la URL y el sha256 de cada fuente.

## Decisiones

- Los catálogos son archivos versionados (`data/activity-catalogs/`), no filas de la base: son públicos, se revisan en el PR y nunca se siembran en bases remotas.
- La ficha guarda una **copia** de lo elegido, así que una versión nueva no cambia las actividades guardadas.
- Las reglas viven aparte, en `lib/iibb-rates/registry.ts`. Sólo se sugieren las de conjuntos aprobados en los tres niveles, y nunca las retenidas.
- Sin reglas, la respuesta es «Alícuota pendiente de determinar».
- La extracción de PDF usa PDFKit (macOS, `swift`) sin dependencias nuevas, con volcados de líneas con posición. No se usa OCR ni IA.
- En CABA, ante una duda de encuadre (arts. 12 a 21 y 26, o códigos en dos planillas), no se elige: queda pendiente o como alternativas.

## Carpeta «LEY IIBB » (27/10, interrumpido por límite de uso)
Notas y evidencia: `~/Liquidador-evidencia-fiscal/2026-10-27-carpeta-ley-iibb/NOTAS.md`. ARBA analizado (exportación oficial descargada; pendiente importador TSV), Santa Cruz contrastado con el BO (sigue pendiente). CABA y Corrientes no iniciados. El cierre pedido antes (condiciones sin verificar en servidor/panel, flujo de alícuota heredada, NAES Disposiciones/ordenamiento, revisión final) NO se hizo.

## Reanudación (27/10/2026, después del límite de uso)
Verificado en disco: `tsc`, ESLint y Vitest en verde (2935 tests); SHA256SUMS de ambos directorios de evidencia OK.
- [x] Servidor (`lib/iibb-profile-sources.ts`): una regla con condiciones (ingresos o hechos declarados) NO se guarda como `CONFIRMED_SUGGESTION`; si exige inscripción, debe coincidir con la de la ficha, también cuando la alícuota guardada no cambia y cambia la inscripción.
- [x] Panel: sólo una respuesta única sin condiciones ofrece «Confirmar sugerencia de la norma»; lo demás, «Registrar como decisión del estudio» (STUDIO_MANUAL, sin `ruleRef`), con constancia explícita sin marcar.
- [x] ARBA (902), sobre la exportación oficial del 27/10/2026 leída como texto (`cli.ts arba-naiibb`):
  - catálogo NAIIB-18 `data/activity-catalogs/arba-naiibb18-2026-10-27.json`: 1035 códigos, pendiente;
  - correspondencias `…correspondencias.json` (3525, separadas y no aplicadas);
  - alícuotas normalizadas, como evidencia, en `~/Liquidador-evidencia-fiscal/2026-10-27-arba-pba/derivados/`.
- [x] ARBA 2026 (`cli.ts arba-2026`): los 1022 códigos se contrastaron con la tabla del art. 20 de la Ley 15.558, sin diferencias.
  - 71 reglas condicionadas, pendientes; 222 códigos retenidos (bonificación, AlicuotaSUS y arts. 22 y 134).
  - Se descartaron 32 filas duplicadas de la exportación.
  - Ninguna regla puede guardarse como sugerencia de la norma (todas son condicionadas).
- [x] Límite de descripción de actividad: 300 caracteres (era 250), sin cambios en la base (TEXT). Lo exigen 4 descripciones oficiales de ARBA de 253 caracteres.
- [x] Santa Cruz: Anexo I oficial de la Ley 3760 obtenido del archivo PDF del BO provincial (BO 5615, 25/11/2021). «ALICUTAS 2026.pdf» de la carpeta difiere en 465 de 956 códigos y no se usa. Sigue sin reglas: falta acreditar la vigencia posterior a 2021 y decidir cómo representar los códigos de 5 dígitos.
- [x] CABA (carpeta): la ley de la carpeta es el anexo original de la Ley 6927, con planillas idénticas; la Res. AGIP 365/2025 coincide con las altas y bajas del NAES. Las cuotas fijas del régimen simplificado y los vencimientos quedan aparte, sin implementar.
- [x] Corrientes: la Ley 6249 de la carpeta es idéntica al PDF de la DGR (2021); sus alícuotas van por descripción, sin código. Pendiente el texto oficial de la RG DGR 293/2025.
- [x] NAES: RG CA 12 a 15/2026 con HTTP 500; sin Disposiciones 2026 halladas; ordenamiento electrónico no localizado. Quedó registrado como check de vigencia.
- [x] Alícuota heredada: flujo de alta y primera liquidación, y propuesta mínima sin implementar, en `REVISION.md` §7.
- [x] Validaciones (reanudación): `tsc`, ESLint, Vitest (2949 tests, 10 omitidos), Prisma validate/generate con URLs ficticias, `next build` sin credenciales, `git diff --check`.

### Pendiente (siguiente sesión)
1. Revisión del estudio por niveles, y decisiones de CABA (Ley 6948 y art. 58), ARBA (retenciones e inscripción) y la pantalla de cálculo heredado.
2. Santa Cruz: vigencia de la Ley 3760 (Código Fiscal) y modificaciones del Anexo I desde 2022; ASIP.
3. Corrientes: RG DGR 293/2025 desde una fuente oficial, y verificar el fallo de la Corte Suprema sobre el art. 6° de la Ley 6249.
4. Prueba en navegador (no realizada).

## Tercera etapa (27/10/2026)
- [x] Fichas de decisión en `REVISION.md` («Fichas de decisión»): CABA C1–C4, ARBA B1–B5, Santa Cruz S1 (con ejemplos de diferencias), Corrientes R1 y NAES R2.
- [x] Revisión del nomenclador separada de las alícuotas. Un conjunto de reglas sólo se usa si su catálogo está aprobado (`withApprovedCatalog` / `usableRateRuleSets`, en la asistencia y al guardar); el catálogo se aprueba sin depender de sus reglas.
- [x] Panel: muestra el valor actual que se reemplazaría y qué se registra exactamente; nada cambia en la base hasta «Guardar».
- [x] Alícuota heredada: rótulos de la ficha («valor predeterminado del alta (no revisado por el estudio)» / «sin revisión registrada por el estudio»). La pantalla separada quedó retirada y guardada como parche; el rótulo de liquidación y Excel, propuesto sin aplicar.
- [x] Fuentes alternativas: Infoleg/BO para la CA (las Disposiciones ratificadas 1, 5, 8 y 9/2026 no tratan del NAES); DGR Corrientes, con las RG 279–281/2025 halladas pero no la 293.
- [x] Propuesta de prueba visual: `PRUEBA-VISUAL.md`. Requiere decidir entre Supabase local y Preview DEV.
- [x] Validación completa: Vitest (2952 tests, 10 omitidos), ESLint, `tsc`, `next build` sin credenciales, `git diff --check`.

## Cuarta etapa (27/10/2026): decisiones del usuario aplicadas
- [x] «Alícuota del cálculo actual (%)» editable en la ficha.
  - Estado: «3 %: valor predeterminado, pendiente de confirmación» en el alta y «Sin constancia de revisión» en clientes existentes.
  - Texto de alcance: único valor usado por el cálculo y las exportaciones, no viene de las actividades y no es una liquidación por jurisdicción.
  - Se envía sólo si cambió y se valida con las reglas de la API.
  - Sin migración ni cambios de valores existentes. Se descartó el parche de la pantalla separada.
- [x] Liquidación y Excel: aclaración junto a la alícuota (`LIQUIDATION_RATE_NOTE`; en el Excel, la columna C de la fila del impuesto). Fórmulas, valores y posiciones de A/B sin cambios.
- [x] Catálogos y reglas: sin aprobar ni habilitar. Búsqueda y sugerencias, separadas. Las ambigüedades siguen en las fichas de `REVISION.md`.
- [x] `PRUEBA-VISUAL.md`, plan concreto para la Preview en DEV, **no ejecutado**: migraciones, aislamiento de los fixtures en el build, datos, casos, limpieza y comprobación de DEV.
- [x] Pruebas de estos cambios: 1274 tests afectados en verde (ficha, errores, Excel, páginas y API), y luego la validación final.

### Pendiente
1. Autorizaciones para el plan de Preview: kit y migración en DEV, variable de Netlify sólo para previews, push y Preview, y datos sintéticos.
2. ~~Implementar las barreras de los fixtures sintéticos~~ (hecho en la quinta etapa).
3. Decisiones de las fichas (CABA C1–C4, ARBA B1–B5, Santa Cruz S1, Corrientes R1, NAES R2) y la revisión por niveles de cada conjunto.

## Quinta etapa (27/10/2026): preparación local de la prueba visual
- [x] Barreras de los catálogos sintéticos implementadas:
  - `lib/preview-fixtures/gate.ts` evalúa las dos fases con una sola función: build, en `next.config.ts`, y runtime, en `loader.ts`, que es `server-only` y se reevalúa en cada llamada;
  - exigen `CONTEXT=deploy-preview`, `CATALOGOS_SINTETICOS=1`, `CATALOGOS_SINTETICOS_HASTA` con un plazo de ≤ 7 días, y `DATABASE_URL`, `DIRECT_URL` y `NEXT_PUBLIC_SUPABASE_URL` de DEV;
  - si falta algo o hay datos contradictorios, quedan deshabilitadas. Nada depende del navegador.
- [x] Con la barrera de build cerrada, un alias de Turbopack y webpack reemplaza `data.ts` por `data-disabled.ts`, y los datos no entran al bundle. Los catálogos oficiales siguen pendientes y deshabilitados.
- [x] Evidencia del aislamiento:
  - 26 tests de la barrera y 9 de endpoints con los registros reales;
  - `scripts/preview-fixtures/verify-build.mjs`: en el build de producción, `--expect absent` da OK (0 marcas, incluidos los `.map`); en un build de Preview simulado con URLs ficticias, `--expect present` da OK (sólo servidor, nada en `static`).
- [x] Kit `~/catalogos-dev-kit` (fuera del repo), con preflight, un único intento, postcheck exacto (deparse de PG17 comparado en la base) y diagnóstico sin reintentos:
  - fixtures generados con un PostgreSQL 17 local descartable;
  - `selftest.sh` offline: 49 bloques OK, 59 de ellos casos de evaluación;
  - **`EXPECTED_HEAD` PENDIENTE**: la guarda rechaza siempre hasta que exista el commit definitivo.
- [x] `PRUEBA-VISUAL.md` reescrito:
  - el destino del servidor se verifica desde la configuración de Netlify, el log del build y la barrera de runtime;
  - centinelas, 10 casos, auditoría, limpieza y desactivación: el vencimiento apaga sin redeploy; quitar las variables requiere redeploy y su verificación;
  - acciones remotas pendientes.
- [x] Validación: `tsc` y ESLint sin errores; vitest 2988 pasados y 10 omitidos (integración PG); `next build` sin credenciales con `verify-build --expect absent` OK; `git diff --check` limpio.
- Nada remoto: sin commits, push, Netlify, migraciones ni consultas a DEV o PROD.

### Pendiente
Las acciones remotas de `PRUEBA-VISUAL.md` §6, cada una con su autorización. Siguen pendientes las decisiones de las fichas de `REVISION.md`.

## Sexta etapa (27/10/2026): cierre local y commit
- [x] Revisión del diff completo:
  - alcance autorizado;
  - endpoints con autenticación y rol de la organización activa;
  - la baja de clientes no consulta catálogos;
  - lo guardado sin cambios no se reverifica;
  - sin secretos (sólo credenciales sintéticas de tests).
- [x] Tests nuevos:
  - el vencimiento corta en la llamada siguiente del mismo proceso, sin caché que lo prolongue;
  - un cliente con actividad sintética se elimina (204) con las barreras ya deshabilitadas.
- [x] Integración con PostgreSQL 17 local descartable (`scripts/pg-local-regression.sh`): 9 migraciones, schema igual a las migraciones y 10/10 tests.
- [x] Un único commit local en `feature/catalogos-actividades-validacion`, sin push. Su SHA está fijado en `EXPECTED_HEAD` de `~/catalogos-dev-kit`, fuera del repo.

## Punto de retomada (28/10/2026)
- **Commit local:** `76ef23509948a5f5104495184f421da5ce31fe78` (padre `40413ea`), **sin push**. Esta nota se agregó después del commit, así que el worktree tiene este único cambio sin commitear.
- **Migración DEV:** `20261027120000_activity_catalog_rate_origin` aplicada y verificada por el postcheck del kit y por una verificación independiente de sólo lectura.
  - 9 migraciones terminadas, ninguna fallida ni revertida.
  - Huella DEV: `75563a6ceca6e2f8e1c2d342089d439ec152477649c82356ceb16ea298b2bc23`.
  - AuditLog 118; sin datos temporales ni actividad o locks residuales.
- **Corrida:** `~/catalogos-dev-kit/runs/20261028T002336Z-migrate`.
- **Próximo paso:** revisar en sólo lectura la configuración de Netlify y preparar la Preview según `PRUEBA-VISUAL.md` §3 y §6, cada paso con su autorización.
- **Variables sintéticas** (`CATALOGOS_SINTETICOS`, `CATALOGOS_SINTETICOS_HASTA`): todavía sin activar.
- **PROD:** sin esta migración. **No mergear** hasta migrarla con su propio runbook y autorización.
- **Conjuntos fiscales:** sin aprobar ni habilitar.


## Cierre del smoke desde Codex (28/10/2026 UTC)

- PR draft [#18](https://github.com/drojas-1609/Liquidadion-IVA/pull/18), head `76ef23509948a5f5104495184f421da5ce31fe78`, ya subido. `main` sigue en `40413ea` según la verificación del push.
- Deploy Preview `6ae1431d7059c0a271478097`: exitoso; log de fixtures HABILITADOS y centinelas autenticados correctos.
- Smoke ejecutado con OWNER. Evidencia, IDs y límites en `SMOKE-DEV.md`.
- Limpieza por UI y SELECT final dentro de BEGIN READ ONLY: clientes1, períodos1, comprobantes3, líneasIVA3, jurisdicciones/actividades/alícuotas0, retenciones0; cero centinelas y descendientes. AuditLog128 (118+10 entradas exactas de la prueba).
- Liquidación y Excel: base1000, IVA210, IIBB30 al3%, aclaración en C17. No se capturaron payloads HTTP; VoiceOver pendiente.
- Los fixtures siguen con vencimiento `2026-10-28T21:30:00-03:00`; no se verificó aún el apagado.
- Conjuntos oficiales continúan pendientes y deshabilitados. ARCA sin configurar. PROD sin la nueva migración. No mergear.
- Documentación corregida localmente, sin nuevo commit ni push. La nota de retomada anterior se conserva como historial.

## Preparación ARCA y publicación de nomencladores — 28/10/2026

PR #19 mergeado con autorización expresa y producción Published main@5324424. Se verificó en producción el listado de NAES, CLAE y NAIIB-18 y la búsqueda del código 692000 en los tres; no se crearon ni modificaron clientes. Las reglas de alícuotas siguen pendientes.

Rama local `codex/arca-homologacion-segura`: preparación de CMS, tickets cifrados compartidos, parser/transporte limitado y generador local de CSR. Guía: `docs/arca/ALTA-Y-HOMOLOGACION.md`. No se generaron credenciales reales ni se configuró ARCA remota. La migración `20261028120000_arca_wsaa_ticket_cache` sólo se ensayó en PostgreSQL local; DEV y PROD siguen con 9 migraciones. No usar los kits anteriores para esta migración. Pendientes: revisión del cambio, certificado y autorización WSASS, nuevo kit y autorización de migración DEV, secretos de Preview y homologación real antes de producción.

## Homologación ARCA: ejecutor local preparado — 28/10/2026

Certificado y autorización WSASS obtenidos por el usuario; certificado legible/vigente y clave pública coincidente con el CSR (sin abrir la clave privada). Migración de tickets aplicada y verificada en DEV, corrida `~/arca-dev-kit/runs/20261028T170450Z-migrate`: Prisma0, postcheckOK, AuditLog128 y conteos sin cambios, huella `37460066024602df4109ae1e6996a1d2315b8ce0da52e25f6188cf493511c9de`. PROD sin esta migración. El kit quedó fijado al commit4d16b72; ya cumplió su propósito y no debe repetirse.

Runner `node scripts/arca/homologate.mjs <carpeta-certificado>` listo para que el titular ingrese URLDEV y contraseña en prompts ocultos. Usa el adaptador real, certificado cifrado local y caché compartida cifrada en DEV. El runner genera/preserva `wsaa-cache-dev.secret` (no se leyó ni generó con datos reales en esta preparación); limita la consulta al CUIT titular, pide frase final y resume sólo estados/contadores. No crea clientes.

Corrección de endpoints: la página oficial WSAA publica afip.gov.ar, se corrigieron constantes. El dominio arca de WSAA falló TLS y el de padrón no resolvió aquí; los WSDL AFIP de homologación respondieron200 con TLSválido y direcciónSOAPcoincidente. Runner usa ese perfil explícitamente, sin fallback; servidor padrón mantiene dominioarca documentado en v4.1 hasta definir configuración final. Ver guíaARCA para fuentes y límites.

Validación: 3011 tests, 15 integración omitidos en la suite (ya verificados con PostgreSQL local en la etapa anterior); tipos/lint/buildOK. Autoprueba de prompts por terminal con dos cadenas ficticiasOK. Sólo se hicieron GET públicos de WSDL, ninguna autenticación o consulta de persona real, ni carga de secretos en Netlify, push, merge o deploy. Pendiente: el usuario ejecuta la prueba con su clave, revisar RESULT antes de avanzar a Preview.

## Primer ensayo real y ejemplo del manual — 28/10/2026

RESULT del titular: primeraNOT_FOUND, segundaNOT_FOUND, llamadasWSAA1, padrón2, reutilizacióntrue y conteos/marca cliente sin cambios. Reportado por el usuario; sin consultas independientes nuevas ni lectura de secretos. No demuestra FOUND ni autocompletado.

Se prepara modo `--example` limitado a20164755100, ejemplo getPersona_v2 del manual oficialv4.1 (páginas9–12), sin garantía de disponibilidad actual. No se ejecutó con credenciales reales en esta etapa. Conserva el scope/titular/caché, exige frase distinta, se detiene con NOT_FOUND/error y sólo repite si FOUND. Pendiente RESULT del usuario antes de avanzar al formulario Preview.
