# Pase a producción de #33, #32 y #34: revisión y procedimiento (07/11/2026)

**Estado:** pasos 1 a 3 (respaldo, preflight y merge de #33) ejecutados el 07/11/2026; el resto preparado y **sin ejecutar**.

En esta etapa no se hace merge, no se escribe en PROD ni se carga nada en ARCA. Cada paso con escritura requiere la autorización del titular, en el orden de abajo.

## 1. Estado verificado

| PR | Rama · head | Estado en GitHub | Checks de Netlify | Contiene `main` | Migraciones contra `main` |
|---|---|---|---|---|---|
| #33 | `feat/tique-factura-a-081` · `1989e6e` | borrador, MERGEABLE / CLEAN | deploy-preview, header y redirect rules: OK | sí | **ninguna** |
| #32 | `feature/liquidacion-ajustes-credito-fiscal` · `2891b98` | borrador, MERGEABLE / CLEAN | OK | sí; contiene #33 | **14** `20261106120000_vat_credit_adjustments` (sha256 `5093b64d…`) |
| #34 | `feature/iva-exportacion-cierre` · `5c75ed7` | listo para revisión, MERGEABLE / CLEAN | OK | sí; contiene #33 y #32 | 14, **15** `20261107120000_vat_export_close_versions` (`e2f768ad…`) y **16** `20261108120000_invoice_import_deletions` (`c48dc828…`) |

No hay workflows de GitHub: los checks de los PR son sólo los de Netlify. Las pruebas se corrieron en local, sobre el head de cada PR, en worktrees descartables:

| PR | Tipos | Lint | Unitarias | PostgreSQL local | Build |
|---|---|---|---|---|---|
| #33 `1989e6e` | OK | OK | 3292 OK | 135 + 3 OK | OK |
| #32 `2891b98` | OK | OK | 3319 OK | 140 + 3 OK | OK |
| #34 `5c75ed7` | OK | OK | 3433 OK | 163 + 3 OK | OK |

En #33, la primera corrida de PostgreSQL agotó el tiempo del hook de `period-totals-pg` (300 s) mientras la máquina estaba ocupada. Repetida sola, pasó en 42 s.

**Las migraciones son las mismas en todas las ramas:** el checksum de la 14 es igual en #32 y en #34.

**PROD, leído en solo lectura el 07/11/2026:**
- deploy publicado `6aed1d42`, `main@4ebf540` (06/11 00:21 UTC): es el head de `main`, que ya incluye #25, #28, #29, #30 y #31;
- **13 migraciones** terminadas, ninguna revertida ni a medias. La última es `20261104230000_add_operator_role`; huella `9188588e641c…bfbc5314`;
- los checksums de esas 13 son iguales a las de `main`;
- **no existe** ninguno de los objetos que crean la 14, la 15 y la 16 (tipos, tablas y columnas);
- volumen: 39 comprobantes, 1 período, 0 retenciones y percepciones, 0 configuraciones de IVA del período; PostgreSQL 17.6.

**Pendientes en PROD: la 14, la 15 y la 16, verificadas contra el historial.**

**Observación sobre el worktree principal.** El checkout local de `feature/liquidacion-ajustes-credito-fiscal` tiene un commit **sin publicar**, `2fadb1a`. Agrega los cuatro archivos «… 2» que creó la sincronización de la carpeta. **No debe publicarse en #32.** No se tocó.

## 1b. Pasos 1 y 2 ejecutados el 07/11/2026: respaldo y preflight de PROD (solo lectura)

| Momento (UTC) | Qué se verificó | Resultado |
|---|---|---|
| 18:32 | Deploy publicado y heads remotos | Netlify publica `main@4ebf540` (deploy `6aed1d42`). Heads: #33 `1989e6e`, #32 `2891b98`, #34 `ed3e2d3`. El commit local `2fadb1a` queda afuera |
| 18:32 | Migraciones de PROD | 13 terminadas, 0 a medias. Huella `9188588e641c727e3a5e222154a3eb643514f42aafb45463824cce26bfbc5314`. Ninguno de los objetos de la 14, la 15 o la 16 existe |
| 18:32 | Actividad | 0 sesiones activas, 0 transacciones abiertas, 0 bloqueos exclusivos en Invoice, TaxRecord, PeriodVatSettings y Period |
| 18:32 | Estado de los datos | Conteo y huella md5 de las 23 tablas de `public`, guardados fuera del repositorio |
| 19:28 | Respaldo | `pg_dump` 17.11 del esquema `public`, formato custom, hecho por el titular con la contraseña en un prompt oculto. Archivo `prod-public-20261107T192843Z.dump` (101.460 bytes), fuera del repositorio y de carpetas sincronizadas; sha256 `d64a6e55227bac6b8bbe289811aa235953ea36eada4ff23912c72c67cb75c621`, verificado |
| 19:30 | Restauración en PostgreSQL 17 local temporal (`--no-owner --no-privileges`) | Un solo aviso esperado: «schema "public" already exists». **Las 23 tablas coinciden** en conteo y huella con el preflight. 13 migraciones, la misma huella. 23 tablas, 73 índices, 90 restricciones, 16 enums y RLS en las 23 tablas, igual que PROD |
| 19:31 | PROD de nuevo | Las 23 tablas, la huella y los objetos **sin cambios** desde el preflight y el respaldo |

**Pendiente del titular:** confirmar en el panel de Supabase de PROD que el respaldo diario o PITR está activo, y anotar la hora del último.

**Siguen sin autorizar:** los merges, las migraciones en PROD y la carga en el Portal IVA.

## 1c. Paso 3 ejecutado el 07/11/2026: merge de #33 y deploy de producción

- **Verificación previa:**
  - el titular confirmó el respaldo diario de PROD en Supabase;
  - head de #33 `1989e6e`, checks de Netlify en verde, MERGEABLE/CLEAN;
  - `main` y la producción publicada en `4ebf540`.
- **Merge:** #33 pasó de borrador a listo y se unió con merge commit fijando el head (`--match-head-commit`). Merge `cc039dd` a las 19:36:08 UTC.
- **Producción:** Netlify publicó `main@cc039dd` (deploy `6aef7daa`) a las 19:36:59 UTC.
- **Smoke de solo lectura:**
  - **Rutas públicas:** `/` redirige a `/login`; `/login` responde 200; `/clients` sin sesión redirige al login; `/api/clients` sin sesión responde 401. CSP y HSTS presentes.
  - **Con la sesión del titular (Propietario):**
    - la lista de clientes, el panel del cliente y el período 10/2026 (con ventas, compras y posición) cargan;
    - el formulario de venta, sin guardar, no ofrece 081: es lo esperado, porque #33 lo agrega al catálogo y a la importación sin fila en la matriz de carga manual.
  - **PROD:** sin cambios. La huella combinada de las 23 tablas (`0211480d…`) es igual a la del respaldo; 13 migraciones; ninguna entrada de auditoría nueva.

**Siguen sin autorizar:** la migración 14, los merges de #32 y #34 y la carga en el Portal IVA. El commit local `2fadb1a` sigue afuera.

## 1d. Paso 4 ejecutado el 07/11/2026: migración 14 en PROD

- **Verificación previa (19:43 UTC):**
  - producción publicada en `cc039dd`;
  - PROD con 13 migraciones (huella `9188588e…`) y datos iguales al respaldo verificado (`0211480d…`);
  - ningún objeto de la migración 14;
  - ensayo de compatibilidad de `cc039dd` repetido con la 14 sola y con la 14 a la 16 (47 tests OK).
- **Kit de un intento:** `kit-14-20261106120000_vat_credit_adjustments.sql` (sha256 `1af51630…db241cf`).
  - Ensayado sobre el respaldo restaurado: la 1.ª corrida aplica, la 2.ª la rechaza el control previo sin cambios.
  - El titular lo ejecutó una vez desde su terminal por el Session pooler, con la contraseña en un prompt oculto. Terminó con `INSERT 0 1` y `COMMIT`; la fila de la 14 quedó terminada a las 19:58:51 UTC.
- **Postcheck (solo lectura), todo según lo esperado:**
  - 14 migraciones, 0 sin terminar o revertidas; checksum de la 14 `5093b64d…` (igual al sha256 del `migration.sql` en el head revisado de #32); huella posterior `91722b11c8705d43259ab34cc43df682b8f16f8e2ba3675c9355ab9e8a218b30`.
  - Tipo `VatCreditAdjustmentRegime` = `LEY_27541_ANEXO_I`, `LEY_27467_ART_91`.
  - `PeriodVatSettings`: `previousTechnicalBalance numeric(18,2) NOT NULL DEFAULT 0` y `previousTechnicalBalanceReference varchar(120)` nulable; su check, validado.
  - `PeriodVatCreditAdjustment`: 11 columnas, 4 índices (pkey, único período + régimen, período + organización, organización); check de importes, FK a período y organización en cascada, FK de creador y modificador SET NULL, todas validadas.
  - RLS activa, 0 políticas, 0 privilegios para `anon`, `authenticated`, `service_role` y `PUBLIC`; 0 filas.
  - Las 22 tablas preexistentes dan `fd49fa8aba6ede60b945556b41949c6c`, igual al ensayo sobre el respaldo.
  - Producción siguió en `cc039dd` y respondiendo; sin errores en los registros de PostgreSQL.

## 1e. Paso 5 ejecutado el 07/11/2026: merge de #32 y deploy de producción

- **Verificación previa:**
  - head remoto de #32 `2891b98`, checks de Netlify en verde, MERGEABLE/CLEAN;
  - `main` y la producción publicada en `cc039dd`;
  - PROD con el postcheck de la 14 intacto (14 migraciones, huella `91722b11…`, datos `fd49fa8a…`, tabla nueva vacía, sin políticas ni privilegios de API).
- **Merge:** #32 pasó de borrador a listo y se unió con merge commit fijando el head (`--match-head-commit`). Merge `bb868b1` a las 20:08:26 UTC, con padres `cc039dd` y `2891b98`; su árbol es idéntico al de `2891b98`. El commit local `2fadb1a` quedó afuera.
- **Producción:** Netlify publicó `main@bb868b1` (deploy `6aef853c`) a las 20:09:16 UTC.
- **Smoke de solo lectura con la sesión del titular (Propietario):**
  - cargan la lista de clientes, el período 10/2026 (abierto, con ventas, compras y posición) y la liquidación;
  - la posición de IVA muestra la fila del saldo técnico a favor del período anterior y la sección «Ajustes y saldos de la posición de IVA», con el saldo técnico anterior y los conceptos Anexo I Ley 27.541 y Art. 91 Ley 27.467;
  - no se guardó nada.
- **PROD sin cambios después del smoke:** 14 migraciones (`91722b11…`), datos `fd49fa8a…`, 0 ajustes, sin configuración de IVA nueva para el período; sin errores en los registros de PostgreSQL.

**Siguen sin autorizar:** las migraciones 15 y 16, el merge de #34 y la carga en el Portal IVA.

## 1f. Preparación de las migraciones 15 y 16 (07/11/2026, solo lectura y ensayo local)

**Estado verificado:**
- Netlify publica `main@bb868b1` (deploy `6aef853c`).
- #34: head remoto `4b5528a`, checks en verde, MERGEABLE/CLEAN. Desde el código del smoke (`8ac3f48`) sólo cambiaron `PASE-PRODUCCION.md`, `SMOKE-PREVIEW.md` y `VALIDACION-ARCA.md`. `2891b98` es ancestro de #34 y el árbol de `main` es idéntico al suyo; `2fadb1a` no es ancestro.
- PROD: 14 migraciones terminadas, 0 a medias, huella `91722b11…`. No existe ningún objeto de la 15 ni de la 16. Hay 0 sesiones activas.
- Precondiciones de la 15: existen las claves únicas `(id, organizationId)` de `Invoice`, `Period` y `Client`, que usan las FK nuevas; las filas actuales cumplen los checks que la 15 valida.

**Huella de datos invariante a las columnas nuevas.** La 15 agrega columnas a `Invoice`, `TaxRecord` y `PeriodVatSettings`, así que la huella por fila completa de `Invoice` cambia aunque no se modifique ningún dato. Para comparar los datos preexistentes:
- cada fila se toma como `to_jsonb` sin las columnas que agregan la 15 y la 16, en las 23 tablas del estado 14 (sin `_prisma_migrations`);
- se calcula con `TimeZone='UTC'` (hay 11 columnas `timestamptz`) y `COLLATE "C"` en los ordenamientos, porque la base local usa C y PROD `en_US.UTF-8`;
- PROD hoy y el respaldo `192843Z` restaurado más el kit 14 dan el mismo valor: `3c589a4e532f394dc763ce2a38259ac0`.

**Kits de un intento** (mismo patrón que el 14: guarda, cuerpo idéntico a `migration.sql` y fila de Prisma antes del `COMMIT`):

| Migración | sha256 de `migration.sql` = checksum (igual al registrado en DEV) | sha256 del kit | La guarda exige |
|---|---|---|---|
| 15 `20261107120000_vat_export_close_versions` | `e2f768ad2b81ba05e856fed098e48ae5201dee187875d36188875b8692fc5f73` | `8304f125fcb329f0f80b78bc7044f330cdf5e94af00168346865602d1b1d2fc6` | 14 migraciones, huella `91722b11…`, sin fila de la 15, ninguno de sus 4 tipos ni la tabla `PeriodLiquidationVersion` |
| 16 `20261108120000_invoice_import_deletions` | `c48dc828bf60a00e23a4849dd9828682299ce79d17da0494c15777878cdd2a63` | `66d43b6fad337708d40b8d21d67c9d6a5ebe7c3c8930c318c26bfa911d2db49a` | 15 migraciones, huella `41ba625d…` (la que deja el kit 15), sin fila de la 16 ni la tabla `InvoiceImportDeletion` |

**Ensayo sobre el respaldo restaurado más el kit 14 (estado actual de PROD):**

| Paso | Resultado |
|---|---|
| Kit 15, 1.ª corrida | Termina bien (~0,03 s). Cambian sólo `_prisma_migrations` e `Invoice` (por la columna nueva con default; la huella invariante no cambia). Tabla nueva: `PeriodLiquidationVersion`. Huella `41ba625ddb92b180f61fe6a7529cc44b9e8cc661f4c07b6d8141809e3651732b` |
| Kit 15, 2.ª corrida | `KIT15 PREFLIGHT`: se rechaza sin cambios |
| Kit 16, 1.ª corrida | Termina bien. Cambia sólo `_prisma_migrations`. Tabla nueva: `InvoiceImportDeletion`. Huella `3bbca8fc6e6bc96379f5e11567c7d9423a41121fdb86328b7069d1bfdc60db28` |
| Kit 16, 2.ª corrida | `KIT16 PREFLIGHT`: se rechaza sin cambios |
| Esquema final frente a `prisma/schema.prisma` de #34 | `migrate status`: 16 migraciones, «up to date». `migrate diff`: migración vacía, sin deriva |

**Postcheck esperado de la 15:**
- 15 migraciones, 0 sin terminar; checksum `e2f768ad…`; huella `41ba625d…`.
- Tipos: `BuyerType`, `PurchaseCreditConcept`, `SaleOperationType` y `TaxRecordNature`, con sus valores.
- Columnas nuevas:
  - `Invoice`: 5, todas nulas salvo `dationInPayment`, que es obligatoria con default false;
  - `PeriodVatSettings`: `previousFreeBalance numeric(18,2) NOT NULL DEFAULT 0` y su referencia `varchar(120)`;
  - `TaxRecord`: 10, todas nulas.
- Restricciones validadas: `Invoice_activityCode_check`, `Invoice_export_classification_check`, `PeriodVatSettings_previousFreeBalance_check`, `TaxRecord_f2051_detail_check` y la FK `TaxRecord_invoiceId_organizationId_fkey` (RESTRICT).
- 4 índices únicos parciales en `TaxRecord`.
- Sin datos inferidos: 0 comprobantes clasificados, 0 retenciones con detalle y 0 saldos de libre disponibilidad.
- `PeriodLiquidationVersion`:
  - 15 columnas y 5 índices (pkey, vigente por período, por organización, por período y organización, y período más versión);
  - restricciones: pkey, check de estado, FK a período RESTRICT, y FK de quien cierra y de quien reemplaza SET NULL;
  - RLS activa, 0 políticas, 0 privilegios de API y 0 filas.
- Datos invariantes: `3c589a4e…`.

**Postcheck esperado de la 16:**
- 16 migraciones; checksum `c48dc828…`; huella `3bbca8fc…`; los 4 tipos de la 15 siguen y `PeriodLiquidationVersion` sigue vacía.
- `InvoiceImportDeletion`:
  - 11 columnas y 3 índices (pkey, único por organización, cliente y huella, y por cliente y organización);
  - restricciones: pkey, check de estado, FK a cliente CASCADE y FK de quien elimina SET NULL;
  - RLS activa, 0 políticas, 0 privilegios de API y 0 filas.
- Datos invariantes: `3c589a4e…`.

**Compatibilidad** (mismo SQL y fila de Prisma que los kits, sobre el `migrate deploy` de `bb868b1`):

| Código | Esquema | Resultado |
|---|---|---|
| `main@bb868b1` (publicado) | 14 + 15 | **52 OK**, 3 de volumen salteados (6 archivos) |
| `main@bb868b1` (publicado) | 14 + 15 + 16 | **52 OK**, 3 de volumen salteados |
| #34 `4b5528a` | 14 + 15 + 16 | **75 OK**, 4 de volumen salteados (9 archivos: incluye cierre versionado, edición de importados y descargas de ARCA) |

**Respaldo:**
- El respaldo `192843Z` (13 migraciones) más el kit 14 reproducen exactamente el estado actual de PROD: misma huella de migraciones, la misma huella por tabla de las 22 previas y la misma huella invariante.
- Alcanza para ensayar.
- Como la 15 altera tablas con datos (`Invoice`, `TaxRecord`, `PeriodVatSettings`), se recomienda un respaldo nuevo inmediatamente antes de aplicarla. Así el punto de restauración incluye cualquier escritura posterior a este preflight.

**Siguen sin autorizar:** aplicar la 15 y la 16, el merge de #34 y la carga en el Portal IVA.

## 2. Compatibilidad con el deploy publicado

Las tres migraciones son **aditivas**:
- tipos y tablas nuevos;
- columnas nuevas nulas o con default constante (`dationInPayment` false; `previousTechnicalBalance` y `previousFreeBalance` 0);
- CHECK y FK que sólo afectan columnas nuevas, agregados `NOT VALID` y validados después;
- índices únicos parciales sobre columnas nuevas.

No cambian ni borran columnas existentes.

**Ensayo local, con el mismo SQL y la fila de Prisma del kit:**

| Código | Esquema | Resultado |
|---|---|---|
| `main@4ebf540` (publicado en PROD) | 13 de `main` + 14, 15 y 16 | pruebas de integración de `main`: **47 OK** (5 archivos, 1 salteado sin su base) |
| #32 `2891b98` | 14 de #32 + 15 y 16 | **52 OK**: cubre la ventana entre migrar la 15 y la 16 y publicar #34 |

El código publicado sigue funcionando entre la migración y el deploy siguiente.

## 3. Orden exacto de ejecución

Cada fila espera la autorización del titular y la verificación de la anterior. Un merge a `main` **publica en producción**: la migración que necesita un PR va **antes** de su merge.

| # | Paso | Escritura | Verificación antes de seguir |
|---|---|---|---|
| 0 | Revisión final de los tres PR; quitar el borrador de #33 y #32 | GitHub | — |
| 1 | **Respaldo de PROD** (§4.2) | Sólo lectura en PROD | Fecha y hora del respaldo anotadas |
| 2 | **Preflight de PROD** (§4.1) | Sólo lectura | Todo según lo esperado; si algo difiere, **detener** |
| 3 | Merge de **#33** | `main` → deploy de producción | Netlify publica el commit nuevo; smoke de lectura (§5) |
| 4 | **Migración 14** en PROD (§4.3) | PROD | Postcheck §4.4; el deploy de #33 sigue funcionando |
| 5 | Merge de **#32** | `main` → deploy | Smoke §5 + posición de IVA de un período sin datos reales |
| 6 | **Migraciones 15 y 16** en PROD, en ese orden, cada una en su transacción | PROD | Postcheck §4.4 de cada una |
| 7 | Merge de **#34** | `main` → deploy | Smoke §5 + presentación de un período de prueba |
| 8 | Actualizar las constantes del runner de PROD si corresponde y registrar las huellas | Repositorio | — |
| 9 | Prueba de aceptación en el Portal IVA ([VALIDACION-ARCA.md](VALIDACION-ARCA.md)) | ARCA, **sólo con autorización específica** | Sin presentar |

Si un paso falla:
- **en una migración:** la transacción revierte sola y no se hace el merge siguiente;
- **en un deploy:** se vuelve a publicar el deploy anterior desde Netlify. El esquema migrado es compatible con el código anterior (§2).

## 4. Migración de PROD

### 4.1 Preflight (solo lectura)

1. **Deploy publicado:** Netlify debe mostrar el `main@<sha>` esperado para esa etapa (`4ebf540` antes del paso 3).
2. **Migraciones:**

   ```sql
   SELECT migration_name, left(checksum, 8), finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name;
   SELECT encode(sha256(convert_to(string_agg(id||':'||migration_name||':'||checksum,'|' ORDER BY migration_name),'UTF8')),'hex')
     FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL;
   ```

   Antes de la 14 se esperan 13 filas y la huella `9188588e…`. Antes de la 15, las 14 con la huella anotada en el paso 4.
3. **Objetos ausentes:** ninguno de los tipos, tablas o columnas de la migración siguiente existe (consulta a `pg_type`, `pg_class` e `information_schema.columns`, como la del 07/11).
4. **Actividad:** `pg_stat_activity` sin transacciones largas ni bloqueos sobre `Invoice`, `TaxRecord`, `PeriodVatSettings` y `Period`. La ventana se elige sin uso del estudio.
5. **Huellas de datos para comparar:** conteo y `md5(string_agg(...))` de `Invoice` (id, totales, `updatedAt`), `TaxRecord`, `PeriodVatSettings` y `Period`.

### 4.2 Respaldo

- Lo hace el titular con su acceso. La app y esta sesión no manejan la contraseña de la base.
- **Supabase:** confirmar en el panel del proyecto PROD que el respaldo diario o PITR está activo, y anotar la hora del último.
- **Copia lógica previa:** `pg_dump` de las tablas `Invoice`, `InvoiceVatLine`, `TaxRecord`, `Period`, `PeriodVatSettings` y `_prisma_migrations` con la cadena de conexión de PROD. Se guarda fuera del repositorio.

### 4.3 Kit de cada migración

Se usa el mismo kit que en DEV:
- **Contenido:** el `migration.sql` sin cambios (ya trae `BEGIN`, los timeouts locales y `COMMIT`). Antes del `COMMIT` se agrega la fila de `_prisma_migrations` con un id nuevo, el `checksum` sha256 del archivo, `finished_at = now()` y `applied_steps_count = 1`.
- **Ejecución:** con el conector de Supabase o con `psql -v ON_ERROR_STOP=1 -f`, **una migración por vez**.
- **Equivalente:** `prisma migrate deploy` con un directorio que contenga sólo las migraciones hasta la que se aplica. Hace lo mismo.

| Migración | checksum sha256 |
|---|---|
| 14 `20261106120000_vat_credit_adjustments` | `5093b64d9a968a736455a3e03c79ebae1c3e075c3da00c9ebd685e5ade156151` |
| 15 `20261107120000_vat_export_close_versions` | `e2f768ad2b81ba05e856fed098e48ae5201dee187875d36188875b8692fc5f73` |
| 16 `20261108120000_invoice_import_deletions` | `c48dc828bf60a00e23a4849dd9828682299ce79d17da0494c15777878cdd2a63` |

### 4.4 Postcheck de cada migración (solo lectura)

- **Migraciones:** una fila nueva terminada, con el checksum de la tabla anterior. Se anota la huella nueva.
- **Objetos:** existen los tipos, tablas, columnas, índices y CHECK de la migración, y los CHECK quedaron **validados** (`convalidated`).
- **Tablas nuevas:** RLS activa, sin políticas, y 0 privilegios para `anon`, `authenticated` y `service_role`.
- **Datos:**
  - conteos y huellas iguales a los del preflight;
  - las columnas nuevas tienen sus defaults;
  - las filas existentes no cambian.
- **App:** la producción publicada responde: la lista de clientes y un período, en solo lectura.

### 4.5 Vuelta atrás (sólo si las tablas o columnas nuevas siguen vacías o en su default)

- **16:** `DROP TABLE "InvoiceImportDeletion"` y borrar su fila de `_prisma_migrations` (ver [DEV-MIGRACION.md](DEV-MIGRACION.md)).
- **15 y 14:** drop de las tablas, columnas, índices y tipos que crearon, en orden inverso, más su fila de Prisma. Con datos cargados, borra esos datos: requiere autorización explícita.
- **Deploy:** volver a publicar el deploy anterior en Netlify antes de revertir el esquema.

## 5. Smoke de producción después de cada merge

**Solo lectura o datos sintéticos de una organización de prueba:**
- Netlify muestra el commit nuevo publicado;
- iniciar sesión, ver la lista de clientes y abrir un período;
- en #34: la lista de ventas con la columna de exento y otros conceptos, y «Presentación ARCA» con sus controles.

**No se modifica el período real de octubre.** Su par FC A y NC A, todo en exento, queda **con el código de operación pendiente** hasta confirmarlo con respaldo. El «E» usado en los sintéticos no determina el del par real. Mientras falte, la exportación de ese período lo marca como bloqueo y no genera el paquete final.
