# Prueba web local de ARCA (homologación y DEV)

Alternativa autorizada por el usuario al rechazo403 de Netlify: el plan no permite scope functions exclusivo. No se cargaron variables ARCA y no se amplían scopes ni se contrata un plan.

## Inicio por el usuario

Desde el worktree de este PR, sin DATABASE_URL, DIRECT_URL, PG* ni ARCA_* en el entorno:

```sh
node scripts/arca/homologate.mjs /ruta/a/carpeta-del-certificado --web
```

Solicita URL DEV y contraseña LOCAL de la clave privada en prompts ocultos. Reutiliza el certificado y la clave de caché existentes (no crea otra en modo web). Comprueba WSDL HTTPS, certificado/clave, migraciones/huella y permisos de tickets como el runner previo. Obtiene exclusivamente configuración pública de Supabase DEV usando la autorización Netlify CLI ya existente por GET. No modifica Netlify. No solicita Clave Fiscal ni contraseña de TaxLiquidator en la terminal.

Exige `INICIAR-WEB-LOCAL-ARCA-HOMO-DEV`. Inicia Next en127.0.0.1:3217, sólo desarrollo, sin metadatos Netlify y con variables en memoria del proceso; no escribe .env ni credenciales en archivos. Se niega si hay .env locales o puerto ocupado. Los logs internos del hijo se descartan. La sesión dura hasta30min; Ctrl+C termina antes.

Abrir http://127.0.0.1:3217/clients/new e iniciar sesión con OWNER de DEV **en el navegador**. El inicio de sesión puede actualizar metadatos de Auth; no se evita la autenticación. Un aviso distingue la prueba local.

## Prueba

1. Consultar titular: previamente dio NOT_FOUND. El resultado actual debe observarse, no presumirse.
2. Consultar ejemplo oficial20164755100: previamente FOUND. Aplicar la propuesta sólo al borrador y comprobar nombre/domicilio/actividades.
3. Verificar que teléfono/email/IIBB ingresados por el estudio no cambian; probar reemplazo confirmado de valores existentes y cambio de CUIT que descarta propuesta.
4. Guardar está bloqueado por el proxy y por el wrapper de APIs. Sólo POST a lookup puede pasar; siguen vigentes sesión/organización/rol y whitelist titular/ejemplo. GET/HEAD de API se limitan a clientes y catálogos; las exportaciones también se bloquean porque escriben auditoría. Las páginas protegidas sólo admiten lectura. Las rutas públicas de login/logout conservan su autenticación normal.
5. Terminar Ctrl+C y esperar el RESULT antes de cerrar la terminal; un Ctrl+C repetido sólo avisa que el cierre sigue en curso. El runner compara conteos de negocio/AuditLog y marca de cliente; informa RESULT sin datos personales. Sólo los tickets técnicos pueden recibir escrituras de consulta. No borra tickets para forzar autenticaciones.

La UI y consultas reales quedan pendientes hasta que el usuario inicie el servidor e ingrese a DEV. Esta prueba no demuestra ARCA en producción ni habilita su configuración remota.

## Resultado observado en navegador (28/10/2026)

Con el servidor iniciado por el usuario y sesión OWNER DEV: el ejemplo oficial devolvió propuesta; se aplicaron nombre, domicilio y una actividad al borrador. Para reemplazar datos existentes, el botón quedó bloqueado hasta marcar la confirmación. La actividad ya incorporada aparece deshabilitada como duplicada. IIBB permaneció en la selección del borrador (No Inscripto). Cambiar CUIT descartó la propuesta; el titular dio el mensaje de persona no informada. No se pulsó Guardar ni exportar.

Se corrigió una barrera local demasiado restrictiva: el wrapper de API usa Host de la solicitud (como el proxy), porque la URL interna de Next puede normalizarse a localhost. Una regresión prueba este caso sin permitir escrituras.

Límite de evidencia: la herramienta oculta teléfono y email como `<redacted>`; la comparación exacta de sus valores no se acredita como prueba de navegador. Al terminar con Ctrl+C el runner informó `RESULT {"caso":"web_local_homologacion","conteos_y_marca_cliente_sin_cambios":true}`: conteos de negocio/AuditLog y marca de actualización de clientes sin cambios.

## Cierre con Ctrl+C (corregido 31/10/2026)

En el ensayo el RESULT apareció después de que la terminal devolviera el prompt. Causa: Ctrl+C llega a todo el grupo de procesos y el lanzador `homologate.mjs` (que esperaba con `spawnSync` sin manejar señales) terminaba de inmediato, sin limpiar su temporal compilado, mientras el runner seguía cerrando Next y comparando conteos. Ahora el lanzador espera al runner, limpia el temporal y devuelve su código; reenvía SIGTERM/SIGHUP. El runner mantiene SIGINT/SIGTERM atendidos hasta informar RESULT, envía SIGTERM a Next una sola vez y SIGKILL tras10s de gracia. La pregunta de confirmación también acepta Ctrl+C como cancelación. Verificado offline con un servidor sintético (sin DB, ARCA ni secretos): RESULT antes del prompt, con Ctrl+C simple, doble y SIGTERM al lanzador.

## Límites vigentes

- Teléfono y email: sin comparación exacta acreditada en navegador (la herramienta los mostraba como `<redacted>`).
- Sugerencias de alícuotas IIBB: `POST /api/iibb-rates/suggest` queda bloqueado en modo local por la barrera de escrituras; la sugerencia no funciona durante el ensayo.
- Producción: ARCA sigue sin habilitar. Este modo no aplica fuera de desarrollo local con DEV y no configura variables en Netlify.
