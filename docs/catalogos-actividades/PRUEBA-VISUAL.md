# Prueba visual en Deploy Preview con Supabase DEV: preparada, NO ejecutada

Camino elegido: **Preview de Netlify contra DEV**, sin Docker ni Supabase local.

| | Proyecto |
|---|---|
| DEV | `esyfpakajthdifhnhcew` (`tax-liquidator-dev`) |
| PROD (nunca se toca) | `bqqruaikbqculvmtirvy` |

**Estado.** La preparación local está completa: las barreras, sus tests, el control de build y el kit de migración DEV. **No se ejecutó ningún paso remoto.** Cada uno de los pasos de la sección 6 necesita tu autorización explícita por separado.

## 1. Migración en DEV (kit `~/catalogos-dev-kit`)

| Migración | DEV hoy | Acción |
|---|---|---|
| Las 8 hasta `20261025120000_client_profile_iibb_contacts` (PR #17) | Aplicadas y verificadas el 26/10 | Ninguna; el preflight exige sus 8 checksums |
| `20261027120000_activity_catalog_rate_origin` (esta rama) | **No aplicada** | Sólo en DEV, con el kit nuevo |

El kit está en `~/catalogos-dev-kit/README.md` y su autoprueba offline pasa: 49 bloques, de los cuales 59 son casos de evaluación. Resumen:

- **Preflight de sólo lectura:**
  - la URL sólo puede ser DEV, y cualquier rastro de PROD lo detiene;
  - servidor 17 y sesión read-only;
  - repo en el commit fijado, limpio, sin `.env`, con la migración y el schema exactos en disco y en HEAD, y sin migraciones extra;
  - las 8 migraciones previas con su checksum, ninguna fallida y ninguna fila de la nueva;
  - forma previa exacta (columnas y 9 constraints) y ninguna estructura parcial;
  - actividad: transacciones largas, `idle in transaction`, bloqueos, locks sobre las tablas y advisory lock de Prisma;
  - observación de conteos y huella.
- **Un único intento:**
  - línea base de un preflight OK de ≤ 2 h;
  - preflight repetido sobre la misma conexión, con conteos y huella idénticos;
  - frase de confirmación;
  - marcador persistente;
  - un solo `prisma migrate deploy`, sin `resolve`, `reset` ni reintentos.
- **Postcheck exacto:**
  - enums, columnas, las 9 constraints previas y los 3 CHECK nuevos, con el deparse exacto de PG17 comparado dentro de la base;
  - fila terminada con su checksum y huella distinta;
  - las filas históricas quedan `MANUAL` y `RATE` sin origen;
  - los conteos de negocio y el `updatedAt` máximo no cambian;
  - `_prisma_migrations` aumenta en 1.
- **Diagnóstico sin acciones automáticas.**
- **SHA del commit: PENDIENTE.** `EXPECTED_HEAD` está vacío y la guarda rechaza siempre, también en el estado ideal. La autoprueba comprueba que hoy el kit se detiene antes de pedir la URL. Se fija recién cuando exista el commit definitivo.

**Riesgo de orden:** si la rama se mergeara antes de migrar PROD, la producción quedaría con código que espera columnas inexistentes. La migración de PROD es otra autorización, con su propio runbook.

## 2. Catálogos sintéticos: barreras implementadas

Los JSON oficiales siguen `PENDIENTE_REVISION` y deshabilitados, también en la Preview. Para ver la búsqueda y el panel se usa un catálogo **sintético**:

- `lib/preview-fixtures/data.ts`, con id `prueba-sintetica-naes`;
- códigos 999001, 999002 y 999003 (este último dado de baja), con textos «[PRUEBA] … (no oficial)»;
- reglas `prueba-sintetica-reglas-901` para la jurisdicción 901: una sin condiciones y dos condicionadas.

Todo lleva la marca `SINTETICO-NO-OFICIAL-PRUEBA-VISUAL`.

**Una sola función pura**, `evaluateFixtureGate(env, fase, ahora)` en `lib/preview-fixtures/gate.ts`, decide en dos momentos.

**Condiciones de las dos fases.** Cualquier dato faltante, inválido o contradictorio deshabilita:

- `CATALOGOS_SINTETICOS` vale exactamente `1`;
- `CATALOGOS_SINTETICOS_HASTA` es una fecha ISO con zona, futura y a ≤ 7 días;
- `DATABASE_URL` es DEV: host `db.<DEV>.supabase.co`, o pooler con usuario `postgres.<DEV>`;
- `DIRECT_URL`, si existe, también es DEV;
- `NEXT_PUBLIC_SUPABASE_URL` es exactamente `https://<DEV>.supabase.co`;
- ninguna de esas variables menciona el ref de PROD.

**Build** (`next.config.ts`):

- Exige además `CONTEXT=deploy-preview`.
- Si se cumple todo, inlinea `CATALOG_FIXTURES_BUILD="1"`. Si no, inlinea `"0"` y un alias de Turbopack y webpack resuelve `@/lib/preview-fixtures/data` al stub `data-disabled.ts`. **Los datos sintéticos no entran al bundle**, ni en el código ni en los source maps.
- El log del build imprime `[catalogos-sinteticos] HABILITADOS` cuando se empaquetan. Si `CATALOGOS_SINTETICOS` está definida pero falla otra condición, imprime `[catalogos-sinteticos] deshabilitados: <motivos>`, sin valores. Sin la variable, como en producción, no imprime nada: **la ausencia de «HABILITADOS» significa deshabilitado**.

**Runtime** (`loader.ts`, `server-only`, en cada llamada de `activityCatalogs()` y `rateRuleSets()`):

- Exige la constante del build en `1`.
- Exige que `CONTEXT`, si está visible, sea `deploy-preview`.
- Reevalúa activación, vencimiento y destino con el entorno real de la función. Un build con fixtures deja de servirlos en cuanto falla cualquier condición.

**Sin controles del cliente.** Nada depende de parámetros del navegador, cookies ni de la interfaz: sólo del entorno del servidor.

**Guardado.** Una actividad del catálogo sintético se acepta (201) sólo con las barreras habilitadas; si no, devuelve 422 como cualquier catálogo no disponible.

### Evidencia local del aislamiento

| Control | Resultado |
|---|---|
| `tests/preview-fixtures-gate.test.ts` (26 tests) | Clasificación de URLs. La fase de build se habilita sólo con todo correcto. 18 combinaciones deshabilitadas: producción, branch deploy, sin `CONTEXT`, activación ausente o distinta de «1», sin vencimiento, vencida, > 7 días, fecha sin zona, base PROD (directa o pooler), base faltante o ajena, `DIRECT_URL` PROD con base DEV, Supabase PROD con base DEV, Supabase faltante. Los motivos no contienen la clave ni los hosts. Runtime: constante 0 o ausente, borde exacto del vencimiento, `CONTEXT` de producción, cambio a PROD, activación ausente. |
| `tests/api/preview-fixtures.test.ts` (9 tests, registros reales) | Habilitado: el listado contiene **sólo** `prueba-sintetica-naes` (ningún id oficial), la búsqueda de 999001 encuentra el código y la de 011111 no, y la sugerencia de la 901 da `UNICA 1.23`. En 7 combinaciones deshabilitadas (constante 0, sin activación, vencida, base PROD, Supabase PROD, `CONTEXT` de producción, sin variables) no hay listado, búsqueda ni sugerencia (`SIN_COBERTURA`). El guardado da 422 deshabilitado y 201 habilitado. |
| `next build` sin variables + `node scripts/preview-fixtures/verify-build.mjs --expect absent` | OK: 0 archivos de `.next` (incluidos los `.map`) con alguna de las 5 marcas (`SINTETICO-NO-OFICIAL-PRUEBA-VISUAL`, los dos ids, `pruebaSinOtroTratamiento`, `lib/preview-fixtures/data.ts`). |
| `next build` con un entorno de Preview simulado (`CONTEXT=deploy-preview`, URLs DEV **ficticias**, sin credenciales reales) + `--expect present` | OK: marcas sólo en archivos de servidor y ninguna en `.next/static` (nada llega al navegador). Control negativo: cada modo falla sobre el build contrario. |

La búsqueda de «no oficial» en la interfaz es complementaria: la evidencia principal son el bundle y los endpoints.

## 3. Comprobar que el SERVIDOR usa DEV (antes de crear datos)

La pestaña Red del navegador sólo muestra a qué Supabase habla el cliente. Prisma se conecta desde la función de Netlify con `DATABASE_URL` y `DIRECT_URL`, y eso no se ve en el navegador. Por eso:

1. **Configuración de Netlify, en sólo lectura y sin copiar valores:**
   - en el contexto **Deploy Previews**, `DATABASE_URL`, `DIRECT_URL` y `NEXT_PUBLIC_SUPABASE_URL` mencionan `esyfpakajthdifhnhcew` y ninguna menciona `bqqruaikbqculvmtirvy`. Se miran sólo host, usuario y ref; nunca contraseñas ni claves;
   - `CATALOGOS_SINTETICOS` y `CATALOGOS_SINTETICOS_HASTA` existen **sólo** en Deploy Previews, con alcance Builds y Functions, y no en Production ni Branch deploys;
   - el comando de build es `prisma generate && next build` (no hay `netlify.toml` en el repo; se lee en la interfaz) y no ejecuta `prisma migrate`.
2. **Log del build de la Preview:**
   - corresponde al SHA esperado;
   - contiene `[catalogos-sinteticos] HABILITADOS`. Esa línea sólo aparece si la barrera vio `CONTEXT=deploy-preview` y las tres conexiones DEV en el entorno del build;
   - si aparece `deshabilitados`, o no aparece ninguna línea, se detiene y se revisan los motivos.
3. **Barrera de runtime como centinela del servidor:**
   - si `GET /api/activity-catalogs` (sesión del OWNER de prueba) devuelve `prueba-sintetica-naes`, la función vio en ese momento `DATABASE_URL` y `NEXT_PUBLIC_SUPABASE_URL` de DEV y ninguna de PROD;
   - si devuelve `[]`, algo no coincide: se detiene.
4. **Navegador:**
   - las llamadas de autenticación van a `esyfpakajthdifhnhcew.supabase.co`;
   - ningún recurso menciona `bqqruaikbqculvmtirvy`.
5. **Datos:** después de crear el primer cliente sintético, un conteo de sólo lectura en DEV (con autorización) lo encuentra por su CUIT de prueba. PROD no se consulta: lo garantizan los puntos 1 a 3.
6. **Si algo apunta a PROD o no coincide:** se detiene, no se crean datos y se informa.

## 4. Centinelas, casos, auditoría y limpieza

**Centinelas:**

| Centinela | Dónde | Esperado |
|---|---|---|
| Línea de la barrera | Log del build de la Preview | `[catalogos-sinteticos] HABILITADOS` |
| Listado | `GET /api/activity-catalogs` | Sólo `["prueba-sintetica-naes"]`, sin ningún id oficial (`naes-rg-ca-19-2025`, `clae-rg-afip-3537-2013`, `arba-naiibb18-2026-10-27`) |
| Código oficial | Búsqueda «011111» | Sin resultados (el NAES oficial sigue pendiente) |
| Regla sintética | Sugerencia 901 / 999001 / 2026 | `UNICA`, 1,23 %, con norma «[PRUEBA] …» |
| Clientes | CUIT de prueba `30-99999917-0` y `30-99999918-9` (dígito verificador válido, inexistentes), nombres «[PRUEBA] Cliente sintético A/B», `contacto@estudio.test` | Aparecen sólo en DEV |

**Datos:**

- el usuario OWNER de prueba de DEV y su organización, ya usados en el PR #17;
- sólo los dos clientes centinela;
- nunca datos de contribuyentes reales.

**Casos:**

| # | Caso | Esperado |
|---|---|---|
| V1 | Alta sin tocar «Alícuota del cálculo actual (%)» | Muestra «3 %: valor predeterminado, pendiente de confirmación»; el POST **no** lleva `defaultIibbRate`; se guarda 3 |
| V2 | Alta cambiando el valor a 4,5 | «Valor indicado en el alta»; el POST lleva `defaultIibbRate: "4.5"` |
| V3 | Edición sin tocar la alícuota | «Sin constancia de revisión»; el PATCH no la incluye; el valor no cambia |
| V4 | Edición con valor vacío o «-1» | Error junto al campo y en el resumen; no se envía |
| V5 | Liquidación y Excel | Importes iguales a los anteriores; la aclaración aparece junto a la alícuota y en C17 del Excel |
| V6 | Buscador | «consultoría» y «999001» encuentran el código sintético; se ven versión, vigencia y «[PRUEBA] … (no oficial)»; 999003 figura dado de baja |
| V7 | Regla sin condiciones (999001) | «Confirmar sugerencia de la norma»; se guarda como `CONFIRMED_SUGGESTION` con `ruleRef` |
| V8 | Regla condicionada (999002) | «Sin indicar», el aviso del valor actual, la constancia sin marcar y sólo «Registrar como decisión del estudio» (`STUDIO_MANUAL`, sin `ruleRef`). Cerrar sin guardar no cambia nada |
| V9 | Errores y foco | Resumen con enlaces, foco en el primer error y `aria-invalid`; prueba con VoiceOver |
| V10 | Conflicto de versión (dos pestañas) | Se conserva el borrador y se bloquea el reenvío |

**Auditoría:** consultas de sólo lectura en DEV, con autorización:

- antes de empezar, contar las filas de `AuditLog` de la organización de prueba y las filas de los dos CUIT centinela (deben ser 0);
- al terminar, el aumento de `AuditLog` corresponde sólo a altas, ediciones y bajas de los centinelas. Las filas de `AuditLog` son de sólo agregado y quedan como registro de la prueba, como en el PR #17.

**Limpieza:**

- eliminar los dos clientes desde la interfaz: sin períodos, o primero su período;
- verificar en sólo lectura que no quedan filas de los centinelas en `Client`, `ClientJurisdiction`, `ClientActivity` ni `ClientActivityRate`;
- no se ejecuta SQL de escritura.

## 5. Desactivación final

- **Sin redeploy:** al pasar `CATALOGOS_SINTETICOS_HASTA`, la barrera de runtime deja de servir los fixtures aunque siga publicado el mismo build, porque se reevalúa en cada llamada. Por eso la fecha se fija en el fin previsto de la prueba, nunca a más de 7 días. Verificación: después del vencimiento, `GET /api/activity-catalogs` sobre la misma Preview devuelve `[]`.
- **Quitar las variables:**
  - borrar `CATALOGOS_SINTETICOS` y `CATALOGOS_SINTETICOS_HASTA` de Netlify. En Netlify, el entorno de las funciones queda fijado al publicar, así que el cambio **no afecta a un deploy ya publicado**;
  - si se necesita apagar antes del vencimiento, hace falta un **redeploy** de la Preview;
  - verificar el redeploy con tres controles: el log ya no contiene `HABILITADOS` (sin la variable no se imprime ninguna línea), `verify-build --expect absent` sobre el artefacto da OK (o, sin acceso al artefacto, el listado devuelve `[]`) y la búsqueda de «999001» no encuentra nada.
- **Producción:** no necesita nada. Su build tiene `CONTEXT=production`, así que la barrera de build está cerrada y los datos no se empaquetan, como prueba el control `--expect absent`.

## 6. Acciones remotas pendientes (cada una con su autorización)

1. **Commit** de la rama y fijación de su SHA en `EXPECTED_HEAD` del kit. Después, regenerar `SHA256SUMS` y repetir `selftest.sh`.
2. **Preflight DEV** (`10-preflight.sh`, sólo lectura) y revisión de `observation.json`.
3. **Migración DEV** (`50-migrate-dev.sh`, único intento) con su postcheck.
4. **Lectura de la configuración de Netlify** (sección 3, punto 1) y, si coincide, alta de `CATALOGOS_SINTETICOS=1` y `CATALOGOS_SINTETICOS_HASTA=<fin de la prueba>` sólo en Deploy Previews.
5. **Push y Preview:** abrir el PR genera la Preview. Verificar el log y los centinelas.
6. **Consultas de sólo lectura en DEV** de antes y después: auditoría y limpieza.
7. **Prueba en el navegador** con los clientes centinela, y su limpieza.
8. **Quitar las variables y redeployar la Preview**, o dejar que venza.
