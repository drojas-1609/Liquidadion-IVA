# Pase a producción de #33, #32 y #34: revisión y procedimiento (07/11/2026)

**Estado:** pasos 1 y 2 (respaldo y preflight) ejecutados el 07/11/2026; el resto preparado y **sin ejecutar**.

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
