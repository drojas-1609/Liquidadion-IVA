# Rol Operador

Permite actualizar fichas existentes y trabajar en los períodos y comprobantes de los clientes asignados, dentro de los módulos habilitados. No permite crear clientes ni gestionar usuarios. Tampoco elimina registros, reabre períodos ni administra la configuración del estudio.

El propietario puede asignar y cambiar este rol desde Usuarios. El alcance de clientes y los módulos siguen configurándose por separado. Sueldos y estados contables no se habilitan con este cambio: requieren sus propios módulos.

No se agrega almacenamiento de Clave Fiscal ni automatización de acceso o presentación en ARCA.

## Matriz

| Acción | Constante | Operador |
|---|---|---|
| Ver clientes, períodos, exportar | `ROLES_READ` / `ROLES_EXPORT` | sí, dentro de su alcance |
| Editar la ficha de un cliente existente (incluye CUIT, condición y perfil IIBB) | `ROLES_CLIENT_MANAGE` | sí, dentro de su alcance |
| Crear clientes | `ROLES_CLIENT_CREATE` | **no** (403) |
| Crear períodos, comprobantes y retenciones; sugerencia de alícuotas | `ROLES_CREATE` | sí |
| Consulta al padrón ARCA (consume cupo) | `ROLES_CREATE` + módulo `ARCA_PADRON` | sí, sólo con el módulo |
| Editar comprobantes, retenciones y TurIVA | `ROLES_UPDATE` | sí, con el período abierto |
| Cerrar un período | `ROLES_PERIOD_CLOSE` | sí |
| Reabrir un período | `ROLES_PERIOD_REOPEN` | **no** (403) |
| Eliminar clientes, períodos, comprobantes o retenciones | `ROLES_DELETE` | **no** (403) |
| Usuarios del estudio | `ROLES_USER_MANAGE` | **no** (403) |

Con el PR #25 (Libro IVA), la importación usa `ROLES_CREATE`: el Operador también podrá importar.

## Migración

`20261104230000_add_operator_role`, una sola línea: `ALTER TYPE "Role" ADD VALUE 'OPERATOR' BEFORE 'VIEWER'`. Es aditiva y no cambia filas, privilegios ni la Data API. En PostgreSQL 17 corre dentro de la transacción de Prisma porque el valor nuevo no se usa en la misma transacción.

El orden es siempre **migrar → publicar código**. El código nuevo con la base vieja fallaría al guardar un `OPERATOR`.

## Compatibilidad con código anterior (comprobado)

Un cliente de Prisma generado **sin** `OPERATOR` lee bien las filas de otros roles, pero **falla** con `Value 'OPERATOR' not found in enum 'Role'` en cuanto una consulta devuelve una fila con ese rol. Por ejemplo, el listado de membresías de Configuración → Usuarios. Mientras no exista ninguna fila `OPERATOR`, el código anterior funciona igual sobre la base migrada.

Consecuencias:
- **Deploy Previews de otras ramas en DEV** (#25, #29, o cualquiera sin este cambio): mientras haya una membresía o invitación `OPERATOR` en el estudio, la página de Usuarios del OWNER falla en esas Previews. Para la prueba de la Preview, invitar con otro rol y **cambiar** a Operador desde Usuarios, así ninguna invitación queda con `OPERATOR`. Al terminar, volver la membresía a Consulta.
- **Rollback en producción** a un deploy anterior: antes, cambiar a otro rol todas las membresías `OPERATOR` y revocar las invitaciones pendientes con ese rol.

## Estado

El procedimiento de DEV está en `~/operator-role-dev-kit` (preflight, migración única, postcheck, huella y ajuste del runner). No se aplicó en DEV ni en producción. El runner de homologación conserva el historial real de DEV: se actualiza con la huella verificada recién después de migrar ese entorno.
