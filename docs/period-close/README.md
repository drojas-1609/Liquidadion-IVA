# Cierre y reapertura de períodos

Migración `20261009120000_period_close_reopen` + control en el servidor, API y UI.

## Qué hace el cierre

- Un período **cerrado** se puede **consultar y exportar** igual que antes
  (página del período, listas, liquidación y XLSX).
- El servidor **rechaza con 409 `PERIOD_CLOSED`** toda modificación o
  eliminación del período y de su contenido, sin escribir ni auditar:
  alta, edición y baja de comprobantes; alta, edición y baja de
  retenciones/percepciones; configuración TurIVA; baja del período.
- **No cambian las reglas de cálculo.**

## Limitación explícita: NO es una liquidación fiscal inmutable

El cierre bloquea la edición del **contenido del período**, pero **no congela la
liquidación**: `computeLiquidation` sigue usando la alícuota IIBB **vigente** del
cliente (`Client.defaultIibbRate`). Si se edita el cliente, la liquidación y el
XLSX de un período cerrado pueden cambiar. La alícuota IIBB histórica queda
fuera de alcance de este PR.

## Cómo se garantiza en el servidor

- `lockPeriodForWrite` (`lib/period-lock.ts`) lee `status` en el **mismo**
  `SELECT … FOR UPDATE` del Period y lanza `PeriodClosedError` si no es `OPEN`
  (falla cerrada ante cualquier valor desconocido). Lo usan, como primera
  operación de su transacción, los **8 writers** del contenido.
- Cerrar y reabrir usan `lockPeriodForStatusChange`: el **mismo** `FOR UPDATE`,
  pero sin rechazar el período cerrado. Una escritura y un cambio de estado del
  mismo período nunca se intercalan.
- El analizador estructural (`tests/_period-lock-structure.ts`) exige que sólo
  los 2 handlers de transición usen `lockPeriodForStatusChange`, que sólo
  modifiquen `Period`, que ningún writer modifique la fila `Period` y que
  `PeriodClosedError` se construya únicamente en `lockPeriodForWrite`.

## API

| Ruta | Roles | Cuerpo |
|---|---|---|
| `POST /api/periods/[id]/close` | OWNER, ADMIN, ACCOUNTANT | `{ "expectedUpdatedAt": "<ISO con ms>" }` |
| `POST /api/periods/[id]/reopen` | OWNER, ADMIN | `{ "expectedUpdatedAt": "<ISO con ms>" }` |

Respuesta 200: `{ periodId, status, updatedAt }`. Errores: 400 / 422
(`expectedUpdatedAt`), 401, 403, 404 (otra organización o inexistente, mismo
cuerpo), 409 `CONFLICT` (versión obsoleta), 409 `PERIOD_BUSY`, 500.

### Pantallas viejas (concurrencia optimista)

El token es `Period.updatedAt`: ninguna otra ruta modifica la fila `Period`
(el analizador lo impide), así que su `updatedAt` cambia **sólo** con cada
transición de estado. Bajo el bloqueo, si el token difiere -> 409 antes de
aplicar nada. Cada transición fija `updatedAt = max(ahora, anterior + 1 ms)`,
así un token viejo nunca vuelve a coincidir.

El token versiona el **estado**, no el contenido: cerrar no falla porque otra
persona haya cargado un comprobante después de abrir la pantalla; el cierre se
aplica sobre lo confirmado al momento de tomar el bloqueo.

Mismo estado ya aplicado con el token vigente -> 200 sin escritura ni AuditLog.

## Auditoría

`period.close` y `period.reopen` (targetType `Period`), metadata sólo
`clientId`, `month`, `year`. Sin texto libre.

## Migración (aditiva, **NO aplicada**)

- `enum "PeriodStatus" ('OPEN','CLOSED')`.
- `Period.status` NOT NULL DEFAULT `'OPEN'`: **todos los períodos existentes
  quedan abiertos**, sin backfill ni cierre masivo.
- `Period.closedAt TIMESTAMP(3)` y `Period.closedById UUID` (mismo tipo que
  `Profile.id`), nullable; FK con `ON DELETE SET NULL`.
- `CHECK "Period_closed_state_check"`: `status = 'CLOSED'` ⇔ `closedAt` no NULL.
  La reapertura limpia `closedAt` y `closedById`.

## Prueba en DEV (cuando se autorice)

1. Preflight de `verify.sql` (solo lectura).
2. `npx prisma migrate deploy` contra **DEV** (nunca PROD sin autorización).
3. Post-verificación de `verify.sql`: columnas, enum, FK, CHECK y todos los
   períodos `OPEN`.
4. Deploy Preview y smoke funcional: ver el PR.
