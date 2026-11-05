# Rol Operador

Permite actualizar fichas existentes y trabajar en los períodos y comprobantes de los clientes asignados, dentro de los módulos habilitados. No permite crear clientes ni gestionar usuarios. Tampoco elimina registros, reabre períodos ni administra la configuración del estudio.

El propietario puede asignar y cambiar este rol desde Usuarios. El alcance de clientes y los módulos siguen configurándose por separado. Sueldos y estados contables no se habilitan con este cambio: requieren sus propios módulos.

## Publicación pendiente

El cambio incluye la migración aditiva `20261104230000_add_operator_role`. Debe aplicarse antes de publicar el código, con respaldo y comprobaciones de compatibilidad. No se aplicó en DEV ni en producción. El runner de homologación conserva el historial real de DEV; habrá que actualizarlo con la huella verificada cuando se migre ese entorno.

No se agrega almacenamiento de Clave Fiscal ni automatización de acceso o presentación en ARCA.
