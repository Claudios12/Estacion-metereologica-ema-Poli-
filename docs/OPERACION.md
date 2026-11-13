# Operación de Poli Clima

Guía para quien despliega y mantiene el servicio. Para qué es y cómo se usa: [README](../README.md).

> **Estado de verificación.** Lo que se ejecuta con `node` (servidor, pruebas, respaldo) está probado. Las plantillas de `deploy/` y el `Dockerfile` son **puntos de partida sin probar en un servidor real**: se escribieron sin acceso a un Linux, a un servicio de Windows ni a un Docker en ejecución. Pruébelas en un entorno de ensayo antes de producción.

## 1. Qué hay que decidir antes de publicar

| Decisión | Por qué importa |
|---|---|
| **Dónde corre** (servidor o dominio del Politécnico) | El histórico solo crece mientras el servidor esté encendido: debe operar 24/7. |
| **Dominio y certificado HTTPS** | La página y la API deben servirse por HTTPS. El servidor habla HTTP: el HTTPS lo pone un proxy inverso (sección 3). |
| **Quién puede ver el histórico** | Está restringido al analista y al administrador. Hay que crear sus contraseñas (sección 3b) **antes** de publicar, o el histórico y `/api/status` quedan cerrados. |
| **Quién respalda la base** | El histórico no se puede recuperar de WeatherLink: si se pierde el archivo, se pierde para siempre (sección 4). |
| **Cuenta de WeatherLink** | La mantiene el Responsable de la estación. Para el uso formal, solicitar clave y secreto de la API v2. |

## 2. Opciones para dejarlo corriendo

Siempre: Node.js 22.13+ (o la imagen de Docker), los archivos `package.json`, `server.mjs` e `index.html` (más `scripts/` para el respaldo), y una carpeta con permiso de escritura para la base.

### Linux (systemd)

Pasos y plantilla en [deploy/poli-clima.service](../deploy/poli-clima.service); la configuración, en [deploy/poli-clima.env.example](../deploy/poli-clima.env.example). El servicio se reinicia solo y solo puede escribir en su carpeta de datos.

```bash
sudo systemctl enable --now poli-clima
journalctl -u poli-clima -f          # logs
```

### Docker

```bash
docker compose up -d --build
docker compose logs -f
```

La base vive en el volumen `poli-data`. La imagen trae su propia comprobación de salud (`/healthz`).

### Windows

**En un equipo de escritorio** basta `iniciar.cmd` (doble clic): elige un Node compatible, abre el navegador y no cierra la ventana si hay un error. Para un servidor que deba sobrevivir a cierres de sesión y reinicios hay que registrarlo como servicio.

No hay plantilla probada de servicio. Opción habitual: registrar `node.exe server.mjs` como servicio con [NSSM](https://nssm.cc/) (`nssm install PoliClima`), fijando la carpeta de la aplicación y las variables de entorno (`DB_FILE`, `LOG_FILE`…) en su pestaña de entorno, y con reinicio automático ante fallos. Verifique que `node --version` sea 22.13 o superior **para la cuenta que ejecuta el servicio**.

## 3. HTTPS con un proxy inverso

Ponga Nginx, IIS (con ARR) o el balanceador del Politécnico delante. Plantilla de Nginx: [deploy/nginx.conf](../deploy/nginx.conf).

Con proxy delante, en la configuración de Poli Clima:

- `HOST=127.0.0.1`, para que solo el proxy pueda llegar al servidor.
- `TRUST_PROXY=true`, para que el control de tasas vea la IP real del visitante y no la del proxy.

**Cuidado:** active `TRUST_PROXY=true` **solo** si hay **exactamente un** proxy delante. Poli Clima toma la IP **más a la derecha** de `X-Forwarded-For` (la que agregó su proxy); lo que haya a la izquierda lo puede escribir el visitante y se ignora. Funciona igual si el proxy agrega a la cabecera o la sobrescribe. Tres casos a evitar:

- `TRUST_PROXY=true` con el servidor expuesto directamente a Internet: cualquiera se inventa su IP y se salta el límite. (Por eso `HOST=127.0.0.1` junto al proxy.)
- `TRUST_PROXY=false` detrás de un proxy: todos los visitantes cuentan como una sola IP y se bloquean entre sí.
- **Dos proxies en cadena** (por ejemplo una CDN y luego Nginx): la IP de más a la derecha es la del primer proxy, no la del visitante, y todos compartirían un cupo. Esa topología no está soportada todavía; avise para agregar un número de saltos configurable.

## 3b. Accesos restringidos (analista y administrador)

La comunidad solo ve el clima y no necesita clave. El **histórico** es del analista de datos y la **salud del servicio** (`/api/status`) es del administrador técnico; ambos se identifican con usuario y contraseña. Desde la página se inicia una **sesión** (con botón **Cerrar sesión**); las herramientas (Excel, Python, `curl`) usan usuario y contraseña directos (autenticación HTTP básica).

**Crear o cambiar una contraseña** (en la carpeta del proyecto, con Node 22.13+):

```bash
npm run crear-clave -- analista
npm run crear-clave -- administrador
```

Muestra la contraseña **una sola vez** y guarda solo su huella en `.env`. (`--clave <texto>` permite elegir una, solo para demostraciones; en producción use la generada al azar.) Reinicie el servidor. Para quitar el acceso a alguien, genere una contraseña nueva (reemplaza la anterior). En un servidor que no usa `.env` (systemd, Docker), agregue `--sin-archivo`: imprime las líneas `ANALYST_USER`/`ANALYST_PASSWORD_HASH` (o `ADMIN_*`) para ponerlas en el `EnvironmentFile` o en las variables del contenedor.

**Qué esperar:**

| Situación | Respuesta |
|---|---|
| Sin contraseña configurada para ese rol | **403** "no está configurado" (cerrado, nunca abierto) |
| Sin credenciales | 401: el navegador pide usuario y contraseña |
| Credenciales incorrectas | 401, igual para usuario o contraseña errados |
| Analista pide `/api/status` | 403 "no tiene permiso" |
| 10 fallos desde una IP en 5 min | 429: esa IP queda bloqueada, aunque acierte (`AUTH_FAIL_MAX`, `AUTH_FAIL_WINDOW_MS`) |
| Sesión de la página | Cookie `poli_sesion` (aleatoria de 256 bits, `HttpOnly`, `SameSite=Strict`, `Secure` si el proxy indica HTTPS). Caduca a las 8 h (`SESSION_TTL_MS`). Solo vive en la memoria del servidor: **reiniciarlo cierra todas las sesiones** |

**Requisitos para que sea seguro:**

- **HTTPS obligatorio en producción.** La autenticación básica envía la contraseña en cada petición: sin HTTPS viaja sin cifrar. Nginx con TLS (sección 3) lo resuelve.
- Con `TRUST_PROXY` mal configurado, el bloqueo por IP no funciona bien (ver sección 3).
- Las contraseñas son aleatorias de 16 caracteres. Entréguelas por un canal seguro (gestor de contraseñas), no por correo ni chat abierto.
- **Cerrar sesión:** el botón de la página destruye la sesión en el servidor. Si alguien entró escribiendo la dirección en el navegador (ventana de clave del navegador) en vez de usar la página, el navegador recuerda esa clave hasta cerrarse; en equipos compartidos, usar el formulario de la página y cerrar sesión.
- **La cookie `Secure` depende del proxy:** Nginx debe enviar `X-Forwarded-Proto` (ya está en `deploy/nginx.conf`) y Poli Clima debe tener `TRUST_PROXY=true`. Sin eso la cookie no se marca `Secure` y el navegador podría enviarla también por HTTP.
- **Monitoreo:** `/healthz` es público y no necesita clave. `/api/status` exige las credenciales del administrador; configure su herramienta de monitoreo con autenticación básica, o use solo `/healthz`.
- Capa extra opcional: además de la clave, puede limitar `/api/historico` y `/api/status` a la red del Politécnico en Nginx (bloque comentado en [deploy/nginx.conf](../deploy/nginx.conf)).

## 4. Respaldo de la base de datos

No copie el archivo `.db` a mano con el servidor encendido: puede quedar corrupto (la base usa modo WAL). Use el script, que hace una copia consistente, comprueba su integridad y rota las antiguas:

```bash
node scripts/backup.mjs                                # → ./backups, conserva las 14 últimas
node scripts/backup.mjs --dir /mnt/respaldos --keep 30
DB_FILE=/var/lib/poli-clima/poli-clima.db node scripts/backup.mjs
```

Prográmelo **una vez al día**, y copie la carpeta de respaldos a otro equipo o a un almacenamiento distinto del servidor.

- Linux (cron): `15 3 * * *  cd /opt/poli-clima && DB_FILE=/var/lib/poli-clima/poli-clima.db /usr/bin/node scripts/backup.mjs --dir /var/backups/poli-clima`
- Windows: Programador de tareas, acción `node.exe scripts\backup.mjs`, diaria.
- Docker: `docker compose exec poli-clima node scripts/backup.mjs --dir /data/backups` (la imagen incluye el script y ya trae `DB_FILE`). Eso deja el respaldo **en el mismo volumen**: cópielo después fuera del servidor (`docker cp`) o monte otro volumen para `--dir`.

**Restaurar:** detenga el servicio, reemplace el archivo de la base (y borre sus acompañantes `*.db-wal` y `*.db-shm` si existen) por el respaldo, y arranque de nuevo.

## 5. Monitoreo

| Qué | Cómo |
|---|---|
| ¿Vive el proceso? | `GET /healthz` → 200. Sin límite de tasas; úselo en el monitoreo externo y en el balanceador. |
| ¿Está sano el servicio? | `GET /api/status` → `ok`, `degraded` o `down` (503). Incluye antigüedad del dato, errores de WeatherLink y estado de la base. |
| ¿Qué pasó? | Logs: una línea JSON por evento, con un identificador por solicitud (`reqId`). `info`/`debug` salen por stdout; `warn`/`error`/`fatal`, por stderr; `LOG_FILE` los copia a un archivo. |

Eventos que conviene vigilar:

| Evento (`msg`) | Nivel | Significa |
|---|---|---|
| `station_stale` | warn | La estación lleva más de 30 min sin reportar. Revisar la estación, la consola o la conexión. |
| `upstream_error` | error | Falló la consulta a WeatherLink (el motivo va en el mismo log). |
| `serving_stale` | warn | WeatherLink falla y se está sirviendo el último dato bueno. |
| `db_error` | error | Falló una escritura o lectura de la base. La página sigue funcionando, pero se pierde histórico. |
| `rate_limiter_evicted` | warn | Demasiadas IP distintas: posible abuso. |
| `auth_failed` | warn | Alguien se identificó mal para entrar a una ruta restringida (IP y ruta; nunca la contraseña). Muchos seguidos desde una IP = intento de adivinar. |
| `auth_blocked` | warn | Una IP agotó sus intentos y quedó bloqueada unos minutos. |
| `auth_login` / `auth_logout` | info | Alguien inició o cerró sesión desde la página (rol e IP; nunca la cookie ni la contraseña). |
| `auth_forbidden` | warn | Un usuario válido pidió algo que su rol no permite (p. ej. el analista pidió `/api/status`). |
| `auth_not_configured` | warn | Se arrancó sin contraseñas: el histórico y `/api/status` están cerrados. Ejecute `npm run crear-clave`. |
| `config_invalid` / `startup_aborted` | fatal | El servidor no arrancó: el log dice qué variable es inválida. |

## 6. Cuando algo falla

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| El servidor no arranca y dice `node:sqlite no está disponible` | Node anterior a 22.13 | Instalar Node 22.13+; `node --version`. |
| El servidor no arranca y dice `config_invalid` | Una variable de entorno inválida | Leer el `detail` del log y corregir esa variable. |
| La página dice "La estación no reporta desde…" | La estación o su conexión dejó de enviar datos a WeatherLink | Avisar al Responsable de la estación; revisar [WeatherLink](https://www.weatherlink.com/embeddablePage/show/78e4ae1ed0d046f480fe79dc04e7ef23/summary). No es un fallo de Poli Clima. |
| La página muestra datos pero `/api/weather` da 502 | WeatherLink no responde y el último dato bueno ya tiene más de 30 min | Ver `upstream_error` en los logs. |
| Todos los visitantes reciben 429 | `TRUST_PROXY=false` detrás de un proxy: todos cuentan como una IP | Activar `TRUST_PROXY=true` (ver sección 3). |
| La página dice "el acceso al histórico todavía no está configurado" | No se creó ninguna contraseña | `npm run crear-clave -- analista` y reiniciar (sección 3b). |
| El analista olvidó su contraseña | No se puede recuperar: solo se guarda su huella | `npm run crear-clave -- analista` genera otra y reemplaza la anterior; reiniciar. |
| Alguien legítimo recibe 429 al entrar | Falló 10 veces seguidas desde su IP | Esperar 5 minutos. Si pasa siempre, revisar `TRUST_PROXY` (todos compartirían IP). |
| El histórico tiene huecos | El servidor estuvo apagado | El histórico no se puede reconstruir; mantener el servicio 24/7. |
| `EADDRINUSE`: el puerto 8080 ya está en uso | Poli Clima ya está abierto en otra ventana, o lo usa otro programa | Con `iniciar.cmd`/`npm start` se resuelve solo (abre la copia existente o prueba otro puerto). Con `node server.mjs` directo: cierre la otra copia o cambie `PORT`. Para ver quién lo usa: `netstat -ano \| findstr :8080` y luego `tasklist /FI "PID eq <número>"`. |
| Cambié `index.html` y no se nota | La página se lee una sola vez al arrancar | Reiniciar el servicio. |

## 7. Cuándo crecer

- **API oficial WeatherLink v2:** al pasar a producción formal. Requiere clave y secreto de la cuenta del Politécnico y respetar sus límites; con suscripción Pro también permite recuperar datos pasados.
- **PostgreSQL:** si varias personas o sistemas deben consultar la base a la vez desde otros equipos.
- **Varias instancias del servidor:** hoy el control de tasas es por proceso (en memoria); con varias réplicas cada una lleva su propia cuenta.
