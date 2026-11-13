# Poli Clima

El clima del campus del Politécnico Grancolombiano, en español y en lenguaje sencillo: temperatura actual, pronóstico por tramos del día y recomendaciones de qué llevar. Además, **guarda automáticamente un histórico** de las lecturas de la estación para análisis.

- La página lee los datos de la estación `POLITECNICO_CONSOLA1` (Davis WeatherLink).
- Un servidor Node.js sin dependencias actúa de intermediario, guarda el histórico en SQLite y lo exporta en CSV o JSON.
- Los términos del proyecto (lectura, tramo, estación sin reportar…) están definidos en [GLOSSARY.md](GLOSSARY.md).

## Requisitos

- **Node.js 22.13 o superior** (usa `node:sqlite`, integrado). Con una versión anterior el servidor se niega a arrancar y lo explica en el log.
- Salida a Internet hacia `www.weatherlink.com` (HTTPS).

> Con `nvm`, el archivo `.nvmrc` indica la versión recomendada: `nvm use`.

## Arrancar

**En Windows, lo más simple:** doble clic en `iniciar.cmd`. Busca solo un Node.js compatible (aunque el predeterminado de la computadora sea más viejo), arranca el servidor, abre la página en el navegador y, si algo falla, deja la ventana abierta con el mensaje en lugar de cerrarla. Lo mismo hace `npm start` en cualquier sistema. Desde PowerShell, el archivo se invoca con `.\iniciar.cmd`.

```bash
npm start                            # lanzador: elige el Node adecuado y abre http://localhost:8080
node server.mjs                      # directo (requiere Node 22.13+; así se ejecuta en servidores)
node --env-file=.env server.mjs      # con configuración en un archivo .env (copiar de .env.example)
```

> **Puerto ocupado.** El lanzador lo resuelve solo: si en el puerto 8080 ya está Poli Clima, abre esa copia en el navegador; si lo usa otro programa, prueba con el 8081, 8082… Para fijar un puerto, ponga `PORT=8081` en el archivo `.env` (entonces ya no busca otro).

> Si `node server.mjs` se cierra al instante, casi seguro el `node` predeterminado es anterior a 22.13: el servidor lo dice en una línea `"level":"fatal"`. Use `iniciar.cmd`, `npm start` o `nvm use 24`.

El servidor empieza a guardar lecturas de inmediato (cada 5 minutos) aunque nadie abra la página. Al editar `index.html` hay que **reiniciar** el servidor: la página se lee una sola vez al arrancar (para calcular el hash de su script en la política de seguridad).

Para dejarlo corriendo 24/7 (servicio, Docker, HTTPS, respaldos) vea [docs/OPERACION.md](docs/OPERACION.md).

## Configuración

Todo es opcional y se define con variables de entorno o en `.env`. **Si un valor es inválido, el servidor no arranca** y dice cuáles y por qué. Lista completa y comentada en [.env.example](.env.example). Las más usadas:

| Variable | Por defecto | Para qué |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Dónde escucha |
| `STATION_ID` | la estación del Politécnico | Identificador de 32 caracteres de la estación en WeatherLink |
| `COLLECT_INTERVAL_MS` | `300000` (5 min) | Cada cuánto se guarda una lectura (mínimo 1 min) |
| `DB_FILE` | `data/poli-clima.db` | Archivo de la base de datos |
| `DB_ENABLED` | `true` | `false` desactiva histórico y recolector |
| `TRUST_PROXY` | `false` | `true` **solo** si hay un proxy inverso delante (ver operación) |
| `LOG_FILE` | (consola) | Además de la consola, escribe los logs en un archivo |
| `ANALYST_PASSWORD_HASH` / `ADMIN_PASSWORD_HASH` | (sin definir = **cerrado**) | Huella de la contraseña del analista / del administrador. Se crean con `npm run crear-clave` |
| `ANALYST_USER` / `ADMIN_USER` | `analista` / `admin` | Nombres de usuario de cada rol (deben ser distintos) |
| `AUTH_FAIL_MAX` / `AUTH_FAIL_WINDOW_MS` | `10` / `300000` | Intentos fallidos por IP antes de bloquearla durante la ventana (5 min) |
| `SESSION_TTL_MS` | `28800000` (8 h) | Cuánto dura una sesión iniciada desde la página antes de caducar |

## Quién puede ver qué

| Quién | Qué ve | ¿Necesita clave? |
|---|---|---|
| **Comunidad** (estudiantes, docentes, administrativos, visitantes) | La página: clima actual, pronóstico por tramos y recomendaciones | No |
| **Analista de datos** | Además, el histórico guardado y su descarga en CSV/JSON | Sí: usuario y contraseña |
| **Administrador técnico** | Lo del analista, más la salud del servicio (`/api/status`) | Sí: usuario y contraseña |

**Sin contraseñas configuradas, el histórico y `/api/status` quedan cerrados para todos** (responden 403): un olvido de configuración nunca los deja abiertos. Para abrirlos:

```bash
npm run crear-clave -- analista          # crea el acceso del analista
npm run crear-clave -- administrador     # crea el del administrador
```

El comando genera una contraseña aleatoria, **la muestra una sola vez** y guarda solo su huella (hash scrypt) en `.env`. Si se pierde, se ejecuta de nuevo y reemplaza la anterior. Después hay que reiniciar el servidor.

Para una demostración también se puede elegir la contraseña: `npm run crear-clave -- analista --clave <texto>` (mínimo 8 caracteres; queda en el historial de la terminal). Para producción, use la generada al azar.

Cómo funciona el acceso:

- **En la página:** la sección **Analistas** (enlace en el encabezado) tiene su propio formulario de usuario y contraseña, y al entrar muestra el botón **Cerrar sesión**. La comunidad nunca ve una ventana de clave del navegador.
- **Con herramientas** (Excel, Power BI, Python, `curl`): usuario y contraseña directos (autenticación HTTP básica), sin sesión.
- **Úselo siempre detrás de HTTPS** en producción: con HTTP sencillo la contraseña viaja sin cifrar (ver [docs/OPERACION.md](docs/OPERACION.md)).
- Tras 10 intentos fallidos desde una IP (configurable), esa IP queda bloqueada 5 minutos, incluso si acierta la contraseña. Pedir sin credenciales no cuenta como intento.
- **Cerrar sesión de verdad.** La página inicia una sesión propia (una cookie aleatoria protegida: `HttpOnly`, `SameSite=Strict`, y `Secure` detrás de HTTPS). Al pulsar **Cerrar sesión** el servidor la destruye: aunque alguien hubiera copiado la cookie, deja de servir. También caduca sola a las 8 horas y se cierra si se reinicia el servidor. (Con HTTP básica solo, esto no era posible: el navegador recuerda la clave y la página no puede borrarla.)
- Los intentos fallidos, bloqueos, entradas y salidas quedan en los logs (`auth_failed`, `auth_blocked`, `auth_forbidden`, `auth_login`, `auth_logout`), **nunca** con la contraseña ni la cookie.

## Rutas

| Ruta | Quién | Qué entrega |
|---|---|---|
| `GET /` | Comunidad | La página |
| `GET /api/weather` | Comunidad | Lectura actual y pronóstico del día (JSON de WeatherLink, validado). Memoria de 60 s; si WeatherLink falla, sirve el último dato bueno hasta 30 min (`X-Cache: STALE`) y luego responde 502 |
| `GET /healthz` | Comunidad (monitoreo) | `{"status":"ok"}` si el proceso vive. Sin límite de tasas ni clave, para que el monitoreo y los balanceadores no se bloqueen |
| `GET /api/sesion`, `/api/acceso`, `/api/salir` | La página | Saber si hay sesión (público, siempre 200), iniciarla y cerrarla. Las dos últimas solo aceptan peticiones que la propia página marca (`X-Requested-With`) |
| `GET /api/historico` | Analista, administrador | Histórico guardado, en CSV (para Excel) o JSON |
| `GET /api/historico/resumen` | Analista, administrador | Cuántas lecturas y pronósticos hay, primera y última |
| `GET /api/status` | Administrador | Salud: `ok`, `degraded` (estación sin reportar o WeatherLink fallando con dato guardado), `down` (503, sin ningún dato), antigüedad del dato, errores y uso de la base |

Solo se aceptan `GET` y `HEAD`; cualquier otro método recibe 405. Límite por IP: 30 solicitudes por minuto a la API y 120 en total (429 con `Retry-After`).

### Descargar el histórico

```
/api/historico?tipo=lecturas&desde=2026-11-01&hasta=2026-11-10&formato=csv
```

| Parámetro | Valores | Notas |
|---|---|---|
| `tipo` | `lecturas` (por defecto) · `pronosticos` | Los pronósticos se guardan por versiones: sirven para comparar lo pronosticado con lo ocurrido |
| `desde`, `hasta` | `AAAA-MM-DD` | Días de **Bogotá**. Por defecto, hoy. Máximo 31 días por consulta |
| `formato` | `csv` (por defecto) · `json` | El CSV lleva BOM UTF-8: Excel muestra bien las tildes |

Requiere identificarse como analista o administrador. El histórico **empieza el día en que se activó el recolector**; WeatherLink solo entrega el momento actual, no datos pasados.

### Analizarlo

- **Desde la propia página:** la sección **Analistas** (enlace en el encabezado) pide iniciar sesión y luego muestra cuántas lecturas hay, una gráfica de las últimas 24 horas, las últimas lecturas y botones para descargar el CSV.
- **Excel:** Datos → *Obtener datos → Desde la web* y pegue la URL del CSV; cuando pida credenciales, elija **Básica** con el usuario y la contraseña del analista. **Power BI:** *Obtener datos → Web*, igual.
- **Python:**
  ```python
  import io, requests, pandas as pd
  url = "http://localhost:8080/api/historico?tipo=lecturas&desde=2026-11-01&hasta=2026-11-10"
  r = requests.get(url, auth=("analista", "<contraseña>"))
  df = pd.read_csv(io.StringIO(r.content.decode("utf-8-sig")), parse_dates=["hora_bogota"])
  ```
- **SQL directo:** quien tenga acceso al servidor puede abrir `data/poli-clima.db` (solo lectura) y consultar la vista `v_lecturas_bogota`, con hora de Bogotá y viento en km/h. Tablas: `lecturas`, `pronosticos`.

## Pruebas

```bash
npm test
```

Se ejecutan con el ejecutor integrado de Node (`node --test`), sin dependencias. Arrancan `server.mjs` como caja negra contra un WeatherLink falso en localhost y verifican lo que ve un cliente o un operador: datos, errores, límites, estado, histórico, quién puede ver qué y validación de la configuración. Una de las pruebas espera 10 s a que expire la memoria; el conjunto completo tarda unos 18 s (151 pruebas).

## Limitaciones conocidas

- Depende de la nube de WeatherLink y de que la estación esté encendida y conectada. Si lleva más de 30 min sin reportar, la página lo advierte.
- Usa el endpoint de la página pública embebible de la estación. Para un uso formal conviene migrar a la API oficial WeatherLink v2 (clave y secreto, límites de consulta); con una suscripción Pro también permitiría recuperar datos pasados.
- El pronóstico viene del proveedor de WeatherLink; esta aplicación no genera pronósticos propios.
- SQLite basta para un servidor y pocos analistas. Si varias personas o sistemas necesitan consultar la base a la vez desde otros equipos, conviene migrar a PostgreSQL.
- El control de tasas vive en memoria: se reinicia con el servidor.
- `node:sqlite` aún se marca como experimental en Node; el servidor silencia ese aviso para no romper los logs JSON.
