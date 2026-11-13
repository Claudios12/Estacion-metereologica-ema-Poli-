// Servidor de Poli Clima.
// Sirve index.html y reenvía /api/weather a WeatherLink (que no permite CORS desde el navegador).
//
// Además recolecta las lecturas de la estación cada pocos minutos y las guarda en SQLite
// (data/poli-clima.db) para análisis posterior; el histórico se exporta en /api/historico.
//
// Uso:  node server.mjs                      → http://localhost:8080
//       node --env-file=.env server.mjs      → con configuración en un archivo .env (ver .env.example)
//
// Sin dependencias externas. Requiere Node.js 22.13 o superior (por el módulo integrado node:sqlite).

import { createServer } from "node:http";
import { readFileSync, createWriteStream, mkdirSync, statSync } from "node:fs";
import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// node:sqlite aún se marca como "experimental" en Node 22/23 y escribe un aviso suelto en la consola.
// Se silencia solo ese aviso para no romper el formato JSON de los logs.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const type = typeof args[0] === "string" ? args[0] : args[0]?.type;
  if (type === "ExperimentalWarning" && /SQLite/i.test(String(warning))) { return; }
  return emitWarning.call(process, warning, ...args);
};

const here = dirname(fileURLToPath(import.meta.url));
const startedAt = Date.now();

/* ===================================================================
 * 1. Configuración: se valida toda al arrancar. Si algo está mal, el
 *    proceso no inicia (código de salida 1) y dice exactamente qué falla.
 * =================================================================== */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

const scrypt = promisify(scryptCb);
const B64URL = /^[A-Za-z0-9_-]+$/;

// Formato:  scrypt:N:r:p:sal:hash   (sal y hash en base64url). Lo genera `npm run crear-clave`.
// Se rechazan costos absurdos (muy bajos no protegen; muy altos agotarían la memoria al verificar).
function parsePasswordHash(text) {
  const parts = String(text).split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") { return null; }
  const [N, r, p] = parts.slice(1, 4).map((n) => (/^\d+$/.test(n) ? Number(n) : NaN));
  if (!(Number.isInteger(Math.log2(N)) && N >= 1024 && N <= 131_072) || !(r >= 1 && r <= 16) || !(p >= 1 && p <= 4)) { return null; }
  if (!B64URL.test(parts[4]) || !B64URL.test(parts[5])) { return null; }
  const salt = Buffer.from(parts[4], "base64url");
  const hash = Buffer.from(parts[5], "base64url");
  if (salt.length < 8 || hash.length < 16 || hash.length > 128) { return null; }
  return { N, r, p, salt, hash };
}

function loadConfig(env) {
  const errors = [];

  const int = (name, def, min, max) => {
    const raw = env[name];
    if (raw === undefined || raw === "") { return def; }
    if (!/^\d+$/.test(raw.trim())) { errors.push(`${name} debe ser un entero (recibido: "${raw}")`); return def; }
    const n = Number(raw);
    if (n < min || n > max) { errors.push(`${name} debe estar entre ${min} y ${max} (recibido: ${n})`); }
    return n;
  };

  const bool = (name, def) => {
    const raw = env[name];
    if (raw === undefined || raw === "") { return def; }
    const v = raw.trim().toLowerCase();
    if (["1", "true", "yes", "si", "sí"].includes(v)) { return true; }
    if (["0", "false", "no"].includes(v)) { return false; }
    errors.push(`${name} debe ser true o false (recibido: "${raw}")`);
    return def;
  };

  const stationId = (env.STATION_ID ?? "78e4ae1ed0d046f480fe79dc04e7ef23").trim();
  if (!/^[0-9a-f]{32}$/i.test(stationId)) {
    errors.push(`STATION_ID debe tener 32 caracteres hexadecimales (recibido: "${stationId}")`);
  }

  const base = (env.WEATHERLINK_BASE_URL ?? "https://www.weatherlink.com").trim().replace(/\/+$/, "");
  let baseUrl = null;
  try { baseUrl = new URL(base); } catch { errors.push(`WEATHERLINK_BASE_URL no es una URL válida ("${base}")`); }
  if (baseUrl && baseUrl.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(baseUrl.hostname)) {
    errors.push("WEATHERLINK_BASE_URL debe usar https (solo se permite http contra localhost para pruebas)");
  }

  const logLevel = (env.LOG_LEVEL ?? "info").trim().toLowerCase();
  if (!(logLevel in LEVELS)) { errors.push(`LOG_LEVEL debe ser uno de: ${Object.keys(LEVELS).join(", ")}`); }

  const host = (env.HOST ?? "0.0.0.0").trim();
  if (!/^[0-9a-zA-Z.:-]+$/.test(host)) { errors.push(`HOST no es válido ("${host}")`); }

  // Accesos restringidos: analista (histórico) y administrador (histórico + /api/status). Sin hash, ese rol queda cerrado.
  const userName = (name, def) => {
    const v = (env[name] ?? def).trim();
    if (!/^[A-Za-z0-9._@-]{1,40}$/.test(v)) { errors.push(`${name} solo admite letras, números y . _ @ - (hasta 40 caracteres; sin espacios ni ":")`); }
    return v;
  };
  const passwordHash = (name) => {
    const raw = (env[name] ?? "").trim();
    if (!raw) { return null; }
    const h = parsePasswordHash(raw);
    if (!h) { errors.push(`${name} no es un hash válido (formato scrypt:N:r:p:sal:hash). Cree uno con: npm run crear-clave`); }
    return h;
  };
  const analystUser = userName("ANALYST_USER", "analista");
  const adminUser = userName("ADMIN_USER", "admin");
  if (analystUser === adminUser) { errors.push("ANALYST_USER y ADMIN_USER deben ser distintos"); }
  const analystHash = passwordHash("ANALYST_PASSWORD_HASH");
  const adminHash = passwordHash("ADMIN_PASSWORD_HASH");

  const config = {
    auth: {
      analista: analystHash && { user: analystUser, ...analystHash },
      administrador: adminHash && { user: adminUser, ...adminHash }
    },
    sessionTtlMs: int("SESSION_TTL_MS", 8 * 3_600_000, 1_000, 7 * 86_400_000),
    authFailMax: int("AUTH_FAIL_MAX", 10, 1, 1000),
    authFailWindowMs: int("AUTH_FAIL_WINDOW_MS", 300_000, 1_000, 86_400_000),
    port: int("PORT", 8080, 1, 65535),
    host,
    stationId,
    upstreamUrl: `${base}/embeddablePage/getData/${stationId}`,
    cacheTtlMs: int("CACHE_TTL_MS", 60_000, 10_000, 3_600_000),
    staleMaxMs: int("STALE_MAX_MS", 30 * 60_000, 0, 24 * 3_600_000),
    upstreamTimeoutMs: int("UPSTREAM_TIMEOUT_MS", 5_000, 500, 60_000),
    upstreamMaxBytes: int("UPSTREAM_MAX_BYTES", 256 * 1024, 1024, 5 * 1024 * 1024),
    rateWindowMs: int("RATE_LIMIT_WINDOW_MS", 60_000, 1_000, 3_600_000),
    rateMaxApi: int("RATE_LIMIT_MAX_API", 30, 1, 100_000),
    rateMaxAll: int("RATE_LIMIT_MAX", 120, 1, 100_000),
    rateMaxClients: int("RATE_LIMIT_MAX_CLIENTS", 50_000, 100, 5_000_000),
    trustProxy: bool("TRUST_PROXY", false),
    staleStationMin: int("STATION_STALE_MIN", 30, 1, 1440),
    logLevel,
    logFile: (env.LOG_FILE ?? "").trim() || null,
    dbEnabled: bool("DB_ENABLED", true),
    dbFile: resolve(here, (env.DB_FILE ?? "data/poli-clima.db").trim()),
    collectIntervalMs: int("COLLECT_INTERVAL_MS", 5 * 60_000, 60_000, 24 * 3_600_000),
    historyMaxDays: int("HISTORY_MAX_DAYS", 31, 1, 366)
  };

  return { config, errors };
}

const { config: CFG, errors: configErrors } = loadConfig(process.env);

/* ===================================================================
 * 2. Logging estructurado: una línea JSON por evento (formato estándar,
 *    fácil de leer con jq, Grafana Loki, CloudWatch, journald, etc.).
 *    info/debug → stdout · warn/error/fatal → stderr · opcional LOG_FILE.
 * =================================================================== */

let fileStream = null;
if (CFG.logFile) {
  fileStream = createWriteStream(CFG.logFile, { flags: "a" });
  fileStream.on("error", (e) => {
    process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "log_file_error", error: e.message }) + "\n");
    fileStream = null;
  });
}

function log(level, msg, fields = {}) {
  if (LEVELS[level] < (LEVELS[CFG.logLevel] ?? LEVELS.info)) { return; }
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }) + "\n";
  (LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout).write(line);
  if (fileStream) { fileStream.write(line); }
}

function errInfo(e) {
  // fetch() envuelve el error real (DNS, conexión rechazada, TLS…) en e.cause.
  const cause = e?.cause ? { cause: e.cause.message ?? String(e.cause), causeCode: e.cause.code } : {};
  return { error: e?.message ?? String(e), code: e?.code, name: e?.name, ...cause };
}

if (configErrors.length) {
  for (const e of configErrors) { log("fatal", "config_invalid", { detail: e }); }
  log("fatal", "startup_aborted", { reason: "configuración inválida", count: configErrors.length });
  process.exit(1);
}

/* ===================================================================
 * 3. Métricas internas para monitoreo (/api/status).
 * =================================================================== */

const metrics = {
  requests: 0,
  byStatus: {},
  rateLimited: 0,
  upstream: { ok: 0, errors: 0, lastOkAt: null, lastErrorAt: null, lastError: null, lastLatencyMs: null },
  cache: { hits: 0, misses: 0, stale: 0 }
};

/* ===================================================================
 * 3b. Base de datos SQLite (persistencia para análisis).
 *     - lecturas: una fila por lectura de la estación (sin duplicados).
 *     - pronosticos: cada versión distinta del pronóstico por tramo.
 *     - v_lecturas_bogota: vista con hora de Bogotá y viento en km/h.
 * =================================================================== */

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS meta (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
INSERT OR IGNORE INTO meta (clave, valor) VALUES ('schema_version', '1');

CREATE TABLE IF NOT EXISTS lecturas (
  id                  INTEGER PRIMARY KEY,
  estacion_id         TEXT    NOT NULL,
  recibido_en         TEXT    NOT NULL,  -- hora de la lectura en la estación (UTC, ISO 8601)
  capturado_en        TEXT    NOT NULL,  -- hora en que el servidor la guardó (UTC, ISO 8601)
  temperatura_c       REAL,
  sensacion_c         REAL,
  max_dia_c           REAL,
  min_dia_c           REAL,
  humedad_pct         REAL,
  viento_ms           REAL,
  rafaga_ms           REAL,
  viento_dir_grados   REAL,
  presion_mmhg        REAL,
  tendencia_presion   TEXT,
  lluvia_dia_mm       REAL,
  lluvia_temporada_mm REAL,
  json_original       TEXT    NOT NULL,  -- respuesta completa de WeatherLink, por si luego se necesita otro campo
  UNIQUE (estacion_id, recibido_en)
);
CREATE INDEX IF NOT EXISTS ix_lecturas_recibido ON lecturas (recibido_en);

CREATE TABLE IF NOT EXISTS pronosticos (
  id              INTEGER PRIMARY KEY,
  estacion_id     TEXT    NOT NULL,
  capturado_en    TEXT    NOT NULL,      -- primera vez que se vio esta versión del pronóstico (UTC)
  fecha           TEXT    NOT NULL,      -- día pronosticado (YYYY-MM-DD, hora de Bogotá)
  tramo           TEXT    NOT NULL CHECK (tramo IN ('mañana', 'tarde', 'noche', 'madrugada')),
  temperatura_c   REAL    NOT NULL DEFAULT -999,
  prob_lluvia_pct REAL    NOT NULL DEFAULT -1,
  descripcion     TEXT    NOT NULL DEFAULT '',
  codigo_clima    INTEGER,
  UNIQUE (estacion_id, fecha, tramo, temperatura_c, prob_lluvia_pct, descripcion)
);
CREATE INDEX IF NOT EXISTS ix_pronosticos_fecha ON pronosticos (fecha, tramo);

CREATE VIEW IF NOT EXISTS v_lecturas_bogota AS
SELECT id,
       estacion_id,
       strftime('%Y-%m-%d %H:%M:%S', recibido_en, '-5 hours') AS hora_bogota,
       temperatura_c, sensacion_c, max_dia_c, min_dia_c, humedad_pct,
       round(viento_ms * 3.6, 1)  AS viento_kmh,
       round(rafaga_ms * 3.6, 1)  AS rafaga_kmh,
       viento_dir_grados, presion_mmhg, tendencia_presion,
       lluvia_dia_mm, lluvia_temporada_mm
FROM lecturas;
`;

const TRAMOS = { morning: "mañana", afternoon: "tarde", evening: "noche", night: "madrugada" };
const dbStats = { inserted: 0, duplicates: 0, forecastInserted: 0, errors: 0, lastInsertAt: null, lastErrorAt: null, lastError: null };
let db = null;
let stmt = null;

if (CFG.dbEnabled) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch (e) {
    log("fatal", "startup_aborted", {
      reason: "node:sqlite no está disponible en esta versión de Node",
      node: process.version,
      hint: "Abre iniciar.cmd o ejecuta npm start (buscan solo un Node compatible), o instala Node.js 22.13+ (nvm use 24), o desactiva la base con DB_ENABLED=false",
      ...errInfo(e)
    });
    process.exit(1);
  }
  try {
    mkdirSync(dirname(CFG.dbFile), { recursive: true });
    db = new DatabaseSync(CFG.dbFile);
    db.exec(SCHEMA);
    stmt = {
      lectura: db.prepare(`INSERT OR IGNORE INTO lecturas
        (estacion_id, recibido_en, capturado_en, temperatura_c, sensacion_c, max_dia_c, min_dia_c, humedad_pct,
         viento_ms, rafaga_ms, viento_dir_grados, presion_mmhg, tendencia_presion, lluvia_dia_mm, lluvia_temporada_mm, json_original)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
      pronostico: db.prepare(`INSERT OR IGNORE INTO pronosticos
        (estacion_id, capturado_en, fecha, tramo, temperatura_c, prob_lluvia_pct, descripcion, codigo_clima)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      historicoLecturas: db.prepare(`SELECT
          strftime('%Y-%m-%d %H:%M:%S', recibido_en, '-5 hours') AS hora_bogota,
          temperatura_c, sensacion_c, max_dia_c, min_dia_c, humedad_pct,
          round(viento_ms * 3.6, 1) AS viento_kmh, round(rafaga_ms * 3.6, 1) AS rafaga_kmh, viento_dir_grados,
          presion_mmhg, tendencia_presion, lluvia_dia_mm, lluvia_temporada_mm
        FROM lecturas WHERE estacion_id = ? AND recibido_en >= ? AND recibido_en < ?
        ORDER BY recibido_en LIMIT 100000`),
      historicoPronosticos: db.prepare(`SELECT
          strftime('%Y-%m-%d %H:%M:%S', capturado_en, '-5 hours') AS capturado_bogota,
          fecha, tramo,
          NULLIF(temperatura_c, -999) AS temperatura_c, NULLIF(prob_lluvia_pct, -1) AS prob_lluvia_pct,
          descripcion, codigo_clima
        FROM pronosticos WHERE estacion_id = ? AND fecha >= ? AND fecha <= ?
        ORDER BY fecha, CASE tramo WHEN 'mañana' THEN 1 WHEN 'tarde' THEN 2 WHEN 'noche' THEN 3 ELSE 4 END, capturado_en
        LIMIT 100000`),
      conteo: db.prepare(`SELECT
          (SELECT COUNT(*) FROM lecturas)    AS lecturas,
          (SELECT COUNT(*) FROM pronosticos) AS pronosticos,
          (SELECT MIN(recibido_en) FROM lecturas) AS primera,
          (SELECT MAX(recibido_en) FROM lecturas) AS ultima`)
    };
    const c = stmt.conteo.get();
    log("info", "db_ready", { file: CFG.dbFile, lecturas: c.lecturas, pronosticos: c.pronosticos, ultima: c.ultima });
  } catch (e) {
    log("fatal", "startup_aborted", { reason: "no se pudo abrir la base de datos", file: CFG.dbFile, ...errInfo(e) });
    process.exit(1);
  }
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

// Guarda una respuesta válida de WeatherLink. Nunca lanza: un fallo de la base no debe tumbar la página.
function persist(data, reqId) {
  if (!db) { return; }
  const now = new Date().toISOString();
  try {
    db.exec("BEGIN");
    const r = stmt.lectura.run(
      CFG.stationId, new Date(Number(data.lastReceived)).toISOString(), now,
      num(data.temperature), num(data.temperatureFeelLike), num(data.hiTemp), num(data.loTemp), num(data.humidity),
      num(data.wind), num(data.gust), num(data.windDirection), num(data.barometer),
      data.barometerTrend == null ? null : String(data.barometerTrend).slice(0, 40),
      num(data.rain), num(data.seasonalRain), JSON.stringify(data)
    );
    let forecastNew = 0;
    for (const day of Array.isArray(data.forecastOverview) ? data.forecastOverview : []) {
      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(String(day.date))) { continue; }
      for (const [key, tramo] of Object.entries(TRAMOS)) {
        const p = day[key];
        if (!p || typeof p !== "object") { continue; }
        const f = stmt.pronostico.run(
          CFG.stationId, now, day.date, tramo,
          num(p.temp) ?? -999, num(p.chanceofrain) ?? -1, String(p.weatherDesc ?? "").slice(0, 80),
          Number.isInteger(Number(p.weatherCode)) && p.weatherCode !== "" && p.weatherCode != null ? Number(p.weatherCode) : null
        );
        forecastNew += Number(f.changes);
      }
    }
    db.exec("COMMIT");
    const inserted = Number(r.changes) > 0;
    if (inserted) { dbStats.inserted += 1; dbStats.lastInsertAt = now; } else { dbStats.duplicates += 1; }
    dbStats.forecastInserted += forecastNew;
    log(inserted ? "info" : "debug", inserted ? "db_lectura_guardada" : "db_lectura_duplicada", {
      reqId, recibidoEn: new Date(Number(data.lastReceived)).toISOString(), pronosticosNuevos: forecastNew
    });
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* sin transacción abierta */ }
    Object.assign(dbStats, { errors: dbStats.errors + 1, lastErrorAt: now, lastError: e.message });
    log("error", "db_error", { reqId, op: "persist", ...errInfo(e) });
  }
}

/* ===================================================================
 * 4. Página: se lee una vez al arrancar. Se calcula el hash del script
 *    en línea para permitirlo en la CSP sin usar 'unsafe-inline'.
 * =================================================================== */

let INDEX_HTML;
try {
  INDEX_HTML = readFileSync(join(here, "index.html"));
} catch (e) {
  log("fatal", "startup_aborted", { reason: "no se pudo leer index.html", ...errInfo(e) });
  process.exit(1);
}

const scriptHashes = [...INDEX_HTML.toString("utf8").matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
  // El navegador normaliza los saltos de línea a LF antes de calcular el hash (importante en Windows/CRLF).
  .map((m) => `'sha256-${createHash("sha256").update(m[1].replace(/\r\n?/g, "\n"), "utf8").digest("base64")}'`);

const CSP = [
  "default-src 'none'",
  `script-src ${scriptHashes.join(" ") || "'none'"}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  `connect-src 'self' ${new URL(CFG.upstreamUrl).origin}`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ");

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin"
};

/* ===================================================================
 * 5. Control de tasas por IP (ventana deslizante aproximada, en memoria).
 *    Dos cupos: uno general y uno más estricto para /api/weather.
 * =================================================================== */

class RateLimiter {
  constructor({ windowMs, max, maxClients, name }) {
    Object.assign(this, { windowMs, max, maxClients, name });
    this.clients = new Map(); // ip → { start, count, prev }
  }

  hit(ip, now = Date.now()) {
    let c = this.clients.get(ip);
    if (!c) {
      if (this.clients.size >= this.maxClients) { this.sweep(now, true); }
      c = { start: now, count: 0, prev: 0 };
      this.clients.set(ip, c);
    }
    const elapsed = now - c.start;
    if (elapsed >= this.windowMs) {
      c.prev = elapsed >= 2 * this.windowMs ? 0 : c.count;
      c.start = now - (elapsed % this.windowMs);
      c.count = 0;
    }
    // Ventana deslizante: se pondera la ventana anterior según cuánto queda de ella.
    const weight = 1 - (now - c.start) / this.windowMs;
    const used = c.prev * weight + c.count;
    const resetMs = this.windowMs - (now - c.start);
    if (used + 1 > this.max) {
      return { allowed: false, limit: this.max, remaining: 0, retryAfterS: Math.max(1, Math.ceil(resetMs / 1000)) };
    }
    c.count += 1;
    return { allowed: true, limit: this.max, remaining: Math.max(0, Math.floor(this.max - used - 1)), retryAfterS: Math.ceil(resetMs / 1000) };
  }

  sweep(now = Date.now(), force = false) {
    for (const [ip, c] of this.clients) {
      if (now - c.start >= 2 * this.windowMs) { this.clients.delete(ip); }
    }
    // Protección de memoria ante muchas IP distintas: se descartan las más antiguas.
    if (force && this.clients.size >= this.maxClients) {
      const drop = Math.ceil(this.maxClients * 0.1);
      let i = 0;
      for (const ip of this.clients.keys()) { if (i++ >= drop) { break; } this.clients.delete(ip); }
      log("warn", "rate_limiter_evicted", { limiter: this.name, dropped: drop });
    }
  }
}

// Cuenta solo los intentos de identificación FALLIDOS por IP (ventana fija). Mientras una IP esté bloqueada
// no se verifica ninguna contraseña, ni siquiera la correcta: así no se puede adivinar a velocidad.
class FailureLimiter {
  constructor({ max, windowMs, maxClients }) { Object.assign(this, { max, windowMs, maxClients }); this.clients = new Map(); }

  blocked(ip, now = Date.now()) {
    const c = this.clients.get(ip);
    if (!c || now - c.start >= this.windowMs) { return { blocked: false }; }
    return c.count >= this.max ? { blocked: true, retryAfterS: Math.max(1, Math.ceil((c.start + this.windowMs - now) / 1000)) } : { blocked: false };
  }

  fail(ip, now = Date.now()) {
    let c = this.clients.get(ip);
    if (!c || now - c.start >= this.windowMs) {
      if (!c && this.clients.size >= this.maxClients) { this.sweep(now); }
      if (!c && this.clients.size >= this.maxClients) { return; } // memoria llena: no se registra más (el límite general sigue protegiendo)
      c = { start: now, count: 0 };
      this.clients.set(ip, c);
    }
    c.count += 1;
  }

  reset(ip) { this.clients.delete(ip); }

  sweep(now = Date.now()) {
    for (const [ip, c] of this.clients) { if (now - c.start >= this.windowMs) { this.clients.delete(ip); } }
  }
}

const authFailures = new FailureLimiter({ max: CFG.authFailMax, windowMs: CFG.authFailWindowMs, maxClients: CFG.rateMaxClients });
setInterval(() => authFailures.sweep(), CFG.authFailWindowMs).unref();

const limitAll = new RateLimiter({ windowMs: CFG.rateWindowMs, max: CFG.rateMaxAll, maxClients: CFG.rateMaxClients, name: "all" });
const limitApi = new RateLimiter({ windowMs: CFG.rateWindowMs, max: CFG.rateMaxApi, maxClients: CFG.rateMaxClients, name: "api" });
setInterval(() => { limitAll.sweep(); limitApi.sweep(); }, CFG.rateWindowMs).unref();

function clientIp(req) {
  if (CFG.trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length < 512) {
      // Se toma la IP MÁS A LA DERECHA: es la que agregó nuestro proxy de confianza. Todo lo que hay a su
      // izquierda pudo escribirlo el cliente (un proxy que "agrega" conserva lo que el cliente haya enviado).
      const last = xff.split(",").pop().trim();
      if (/^[0-9a-fA-F.:]{3,45}$/.test(last)) { return last; }
    }
  }
  return (req.socket.remoteAddress || "desconocida").replace(/^::ffff:/, "");
}

/* ===================================================================
 * 6. Consulta a WeatherLink: con timeout, límite de tamaño, validación
 *    del JSON, una sola petición en vuelo y respaldo con dato reciente.
 * =================================================================== */

let cache = { at: 0, body: null, lastReceived: null };
let inflight = null;

const NUMERIC_FIELDS = ["temperature", "temperatureFeelLike", "hiTemp", "loTemp", "wind", "gust", "humidity", "rain", "seasonalRain", "barometer"];

function validatePayload(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) { throw new Error("respuesta no es un objeto JSON"); }
  for (const f of NUMERIC_FIELDS) {
    if (data[f] == null || !Number.isFinite(parseFloat(data[f]))) { throw new Error(`campo inválido o ausente: ${f}`); }
  }
  if (!Number.isFinite(Number(data.lastReceived)) || Number(data.lastReceived) <= 0) {
    throw new Error("campo inválido o ausente: lastReceived");
  }
  if (data.forecastOverview != null && !Array.isArray(data.forecastOverview)) {
    throw new Error("forecastOverview debe ser una lista");
  }
  return data;
}

async function fetchUpstream() {
  const t0 = performance.now();
  const res = await fetch(CFG.upstreamUrl, {
    headers: { Accept: "application/json", "User-Agent": "PoliClima/1.0" },
    signal: AbortSignal.timeout(CFG.upstreamTimeoutMs),
    redirect: "error"
  });
  if (!res.ok) { throw Object.assign(new Error(`WeatherLink respondió ${res.status}`), { code: "UPSTREAM_STATUS" }); }

  const declared = Number(res.headers.get("content-length"));
  if (declared > CFG.upstreamMaxBytes) { throw Object.assign(new Error("respuesta demasiado grande"), { code: "UPSTREAM_TOO_LARGE" }); }

  // Lectura por partes con tope de tamaño, aunque no venga content-length.
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > CFG.upstreamMaxBytes) { throw Object.assign(new Error("respuesta demasiado grande"), { code: "UPSTREAM_TOO_LARGE" }); }
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {
    throw Object.assign(new Error("JSON inválido"), { code: "UPSTREAM_BAD_JSON" });
  }
  try { validatePayload(data); } catch (e) {
    throw Object.assign(e, { code: "UPSTREAM_BAD_PAYLOAD" });
  }
  return { data, body: JSON.stringify(data), lastReceived: Number(data.lastReceived), latencyMs: Math.round(performance.now() - t0), bytes: size };
}

async function weather(reqId) {
  const now = Date.now();
  if (cache.body && now - cache.at < CFG.cacheTtlMs) {
    metrics.cache.hits += 1;
    return { body: cache.body, source: "HIT" };
  }
  metrics.cache.misses += 1;

  if (!inflight) {
    inflight = fetchUpstream()
      .then((r) => {
        cache = { at: Date.now(), body: r.body, lastReceived: r.lastReceived };
        Object.assign(metrics.upstream, { ok: metrics.upstream.ok + 1, lastOkAt: new Date().toISOString(), lastLatencyMs: r.latencyMs });
        const ageMin = Math.round((Date.now() - r.lastReceived) / 60_000);
        log("info", "upstream_ok", { reqId, latencyMs: r.latencyMs, bytes: r.bytes, stationAgeMin: ageMin });
        if (ageMin > CFG.staleStationMin) {
          log("warn", "station_stale", { stationId: CFG.stationId, lastReceived: new Date(r.lastReceived).toISOString(), ageMin });
        }
        persist(r.data, reqId);
        return r;
      })
      .catch((e) => {
        Object.assign(metrics.upstream, { errors: metrics.upstream.errors + 1, lastErrorAt: new Date().toISOString(), lastError: e.message });
        log("error", "upstream_error", { reqId, ...errInfo(e) });
        throw e;
      })
      .finally(() => { inflight = null; });
  }

  try {
    const r = await inflight;
    return { body: r.body, source: "MISS" };
  } catch (e) {
    // Si la nube falla, se sirve el último dato bueno mientras no sea demasiado viejo.
    if (cache.body && Date.now() - cache.at < CFG.staleMaxMs) {
      metrics.cache.stale += 1;
      log("warn", "serving_stale", { reqId, cacheAgeS: Math.round((Date.now() - cache.at) / 1000) });
      return { body: cache.body, source: "STALE" };
    }
    throw e;
  }
}

/* ===================================================================
 * 6b. Quién puede ver qué. Comunidad: página, /api/weather y /healthz (sin clave).
 *     Analista: histórico. Administrador: histórico y /api/status.
 *     Autenticación HTTP Basic con contraseñas guardadas como hash (scrypt). Sin hash configurado,
 *     la ruta queda CERRADA (nunca abierta por olvido). Usar siempre detrás de HTTPS en producción.
 * =================================================================== */

const ACCESO = {
  "/api/historico": ["analista", "administrador"],
  "/api/historico/resumen": ["analista", "administrador"],
  "/api/status": ["administrador"]
};

const CHALLENGE = 'Basic realm="Poli Clima", charset="UTF-8"';
const DUMMY_SALT = randomBytes(16);

function safeEqualText(a, b) {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function decodeBasic(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(String(header));
  if (!m) { return null; }
  const text = Buffer.from(m[1], "base64").toString("utf8");
  const i = text.indexOf(":");
  if (i < 1) { return null; }
  const user = text.slice(0, i);
  const pass = text.slice(i + 1);
  return user.length <= 40 && pass.length <= 256 ? { user, pass } : null;
}

const derive = (pass, h, salt = h.salt) => scrypt(pass, salt, h.hash.length, { N: h.N, r: h.r, p: h.p, maxmem: 256 * h.N * h.r });

/** Devuelve el rol de quien se identifica, o null. Tarda lo mismo exista o no el usuario. */
async function identify(cred) {
  const roles = Object.entries(CFG.auth).filter(([, v]) => v);
  const hit = cred && roles.find(([, v]) => safeEqualText(v.user, cred.user));
  if (!hit) {
    if (roles.length) { await derive(cred?.pass ?? "", roles[0][1], DUMMY_SALT); } // iguala el tiempo de respuesta
    return null;
  }
  const [rol, h] = hit;
  const calculado = await derive(cred.pass, h);
  return timingSafeEqual(calculado, h.hash) ? rol : null;
}

/**
 * Verifica el encabezado Basic respetando el bloqueo por intentos fallidos.
 * Devuelve el rol, o null si ya se respondió (429 por bloqueo, o `rechazar()` por credenciales incorrectas).
 */
async function verifyBasic(req, res, ip, reqId, path, rechazar) {
  const bloqueo = authFailures.blocked(ip);
  if (bloqueo.blocked) {
    metrics.rateLimited += 1;
    log("warn", "auth_blocked", { reqId, ip, path });
    sendJson(res, 429, { error: "Demasiados intentos fallidos. Intenta de nuevo más tarde." }, { "Retry-After": String(bloqueo.retryAfterS) });
    return null;
  }
  const rol = await identify(decodeBasic(req.headers.authorization));
  if (!rol) {
    authFailures.fail(ip);
    log("warn", "auth_failed", { reqId, ip, path });
    rechazar();
    return null;
  }
  authFailures.reset(ip);
  return rol;
}

/** true = puede seguir. false = ya se respondió (401, 403 o 429). */
async function guard(req, res, ip, permitidos, reqId, path) {
  if (!permitidos.some((r) => CFG.auth[r])) {
    sendJson(res, 403, { error: "El acceso a esta ruta no está configurado. El administrador técnico debe definir una contraseña (npm run crear-clave)." });
    return false;
  }
  // La página marca sus peticiones: así un 401 no abre la ventana de usuario y contraseña del navegador
  // (la página tiene su propio formulario). Quien llega con la dirección escrita sí recibe el desafío.
  const desdePagina = req.headers["x-requested-with"] === PAGE_HEADER_VALUE;
  const challenge = () => sendJson(res, 401, { error: "Se requiere identificarse con usuario y contraseña." }, desdePagina ? {} : { "WWW-Authenticate": CHALLENGE });

  let rol = sessionFor(req)?.rol ?? null;      // 1) sesión de la página (cookie)
  if (!rol) {
    if (req.headers.authorization === undefined) { challenge(); return false; } // lo normal al llegar: no cuenta como fallo
    rol = await verifyBasic(req, res, ip, reqId, path, challenge);                // 2) Basic: herramientas, Excel, Python
    if (!rol) { return false; }
  }
  if (!permitidos.includes(rol)) {
    log("warn", "auth_forbidden", { reqId, ip, path, rol });
    sendJson(res, 403, { error: "Su usuario no tiene permiso para esta ruta." });
    return false;
  }
  log("debug", "auth_ok", { reqId, path, rol });
  return true;
}

/* ---------- Sesiones de la página ----------
 * HTTP básica no permite "cerrar sesión" (el navegador recuerda la clave y la página no puede borrarla), así que
 * la página inicia una sesión propia: una cookie aleatoria (HttpOnly, SameSite=Strict) que el servidor puede
 * destruir. Se guardan solo en memoria y solo su huella: reiniciar el servidor las cierra todas. */

const PAGE_HEADER_VALUE = "poli-clima";
const SESSION_COOKIE = "poli_sesion";
const SESSION_MAX = 500;
const sessions = new Map(); // huella del token → { rol, usuario, expires }
const tokenKey = (token) => createHash("sha256").update(token).digest("base64url");

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (typeof header !== "string" || header.length > 4096) { return null; }
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) { return part.slice(i + 1).trim(); }
  }
  return null;
}

/** La sesión vigente de esta petición, o null. */
function sessionFor(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || !/^[A-Za-z0-9_-]{20,64}$/.test(token)) { return null; }
  const key = tokenKey(token);
  const found = sessions.get(key);
  if (!found) { return null; }
  if (found.expires <= Date.now()) { sessions.delete(key); return null; }
  return { key, ...found };
}

function sweepSessions(now = Date.now()) {
  for (const [key, v] of sessions) { if (v.expires <= now) { sessions.delete(key); } }
}
setInterval(sweepSessions, 10 * 60_000).unref();

function createSession(rol, usuario) {
  if (sessions.size >= SESSION_MAX) {
    sweepSessions();
    while (sessions.size >= SESSION_MAX) { sessions.delete(sessions.keys().next().value); } // se descarta la más antigua
  }
  const token = randomBytes(32).toString("base64url");
  sessions.set(tokenKey(token), { rol, usuario, expires: Date.now() + CFG.sessionTtlMs });
  return token;
}

// Secure solo si la conexión original era HTTPS (lo dice el proxy de confianza); con HTTP el navegador descartaría la cookie.
function cookieIsSecure(req) {
  if (!CFG.trustProxy) { return false; }
  const proto = req.headers["x-forwarded-proto"];
  return typeof proto === "string" && proto.split(",").pop().trim().toLowerCase() === "https";
}

function sessionCookie(req, token, maxAgeS) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${cookieIsSecure(req) ? "; Secure" : ""}`;
}

const fromPage = (req) => req.headers["x-requested-with"] === PAGE_HEADER_VALUE;

/** GET /api/acceso: la página envía el usuario y la contraseña (Basic) y recibe una sesión. */
async function login(req, res, ip, reqId) {
  const path = "/api/acceso";
  if (!fromPage(req)) { return sendJson(res, 400, { error: "Solicitud no válida." }); }
  if (!Object.values(CFG.auth).some(Boolean)) {
    return sendJson(res, 403, { error: "El acceso no está configurado. El administrador técnico debe definir una contraseña (npm run crear-clave)." });
  }
  if (req.headers.authorization === undefined) { return sendJson(res, 401, { error: "Escriba su usuario y contraseña." }); }
  const rol = await verifyBasic(req, res, ip, reqId, path, () => sendJson(res, 401, { error: "Usuario o contraseña incorrectos." }));
  if (!rol) { return; }

  const previa = sessionFor(req);
  if (previa) { sessions.delete(previa.key); } // un inicio de sesión nuevo reemplaza el anterior
  const usuario = CFG.auth[rol].user;
  const token = createSession(rol, usuario);
  log("info", "auth_login", { reqId, ip, rol });
  return sendJson(res, 200, { autenticado: true, rol, usuario }, { "Set-Cookie": sessionCookie(req, token, Math.floor(CFG.sessionTtlMs / 1000)) });
}

/** GET /api/salir: destruye la sesión en el servidor y borra la cookie. */
function logout(req, res, ip, reqId) {
  if (!fromPage(req)) { return sendJson(res, 400, { error: "Solicitud no válida." }); }
  const actual = sessionFor(req);
  if (actual) {
    sessions.delete(actual.key);
    log("info", "auth_logout", { reqId, ip, rol: actual.rol });
  }
  return sendJson(res, 200, { autenticado: false }, { "Set-Cookie": sessionCookie(req, "", 0) });
}

/** GET /api/sesion: público. Responde 200 siempre, para que la comunidad no vea errores en la consola. */
function sessionInfo(req, res) {
  const actual = sessionFor(req);
  return sendJson(res, 200, actual ? { autenticado: true, rol: actual.rol, usuario: actual.usuario } : { autenticado: false });
}

/* ===================================================================
 * 7. Servidor HTTP.
 * =================================================================== */

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Cache-Control": "no-store", ...headers });
  res.end(res.req.method === "HEAD" ? undefined : body);
}

function sendJson(res, status, obj, headers = {}) {
  send(res, status, { "Content-Type": "application/json; charset=utf-8", ...headers }, JSON.stringify(obj));
}

function rateHeaders(r) {
  return { "RateLimit-Limit": String(r.limit), "RateLimit-Remaining": String(r.remaining), "RateLimit-Reset": String(r.retryAfterS) };
}

function status() {
  const dataAgeMin = cache.lastReceived ? Math.round((Date.now() - cache.lastReceived) / 60_000) : null;
  const upstreamDown = metrics.upstream.lastErrorAt && (!metrics.upstream.lastOkAt || metrics.upstream.lastErrorAt > metrics.upstream.lastOkAt);
  const state = !cache.body ? (upstreamDown ? "down" : "starting")
    : upstreamDown || dataAgeMin > CFG.staleStationMin ? "degraded" : "ok";
  return {
    status: state,
    uptimeS: Math.round((Date.now() - startedAt) / 1000),
    station: { id: CFG.stationId, lastReceived: cache.lastReceived ? new Date(cache.lastReceived).toISOString() : null, dataAgeMin },
    upstream: metrics.upstream,
    cache: { ...metrics.cache, ageS: cache.at ? Math.round((Date.now() - cache.at) / 1000) : null },
    requests: { total: metrics.requests, byStatus: metrics.byStatus, rateLimited: metrics.rateLimited },
    database: dbStatus()
  };
}

function dbStatus() {
  if (!db) { return { enabled: false }; }
  try {
    const c = stmt.conteo.get();
    let sizeBytes = null;
    try { sizeBytes = statSync(CFG.dbFile).size; } catch { /* aún no existe en disco */ }
    return {
      enabled: true, sizeBytes, collectIntervalS: Math.round(CFG.collectIntervalMs / 1000),
      lecturas: c.lecturas, pronosticos: c.pronosticos, primera: c.primera, ultima: c.ultima, ...dbStats
    };
  } catch (e) {
    return { enabled: true, error: e.message, ...dbStats };
  }
}

/* ---------- /api/historico: exporta lo guardado, en CSV o JSON ---------- */

const DAY_MS = 86_400_000;
const BOGOTA_OFFSET_MS = 5 * 3_600_000; // Colombia no tiene horario de verano: UTC−5 todo el año.

function parseDay(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) { return null; }
  const ms = Date.parse(s + "T00:00:00Z");
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(s) ? ms : null;
}

function todayBogota() {
  return new Date(Date.now() - BOGOTA_OFFSET_MS).toISOString().slice(0, 10);
}

function csvCell(v) {
  if (v == null) { return ""; }
  const s = String(v);
  // Evita inyección de fórmulas al abrir el CSV en Excel (=, +, -, @ al inicio de un texto).
  const safe = typeof v === "string" && /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function toCsv(rows, columns) {
  const lines = [columns.join(",")];
  for (const r of rows) { lines.push(columns.map((c) => csvCell(r[c])).join(",")); }
  return "﻿" + lines.join("\r\n") + "\r\n"; // BOM para que Excel reconozca UTF-8 (tildes, ñ)
}

const LECTURA_COLS = ["hora_bogota", "temperatura_c", "sensacion_c", "max_dia_c", "min_dia_c", "humedad_pct", "viento_kmh", "rafaga_kmh",
  "viento_dir_grados", "presion_mmhg", "tendencia_presion", "lluvia_dia_mm", "lluvia_temporada_mm"];
const PRONOSTICO_COLS = ["capturado_bogota", "fecha", "tramo", "temperatura_c", "prob_lluvia_pct", "descripcion", "codigo_clima"];

function historico(res, searchParams, reqId) {
  if (!db) { return sendJson(res, 503, { error: "La base de datos está desactivada en este servidor." }); }

  const allowed = new Set(["desde", "hasta", "tipo", "formato"]);
  for (const k of searchParams.keys()) {
    if (!allowed.has(k)) { return sendJson(res, 400, { error: `Parámetro no reconocido: ${k}. Use desde, hasta, tipo, formato.` }); }
  }
  const desdeStr = searchParams.get("desde") ?? todayBogota();
  const hastaStr = searchParams.get("hasta") ?? desdeStr;
  const tipo = searchParams.get("tipo") ?? "lecturas";
  const formato = searchParams.get("formato") ?? "csv";
  const desde = parseDay(desdeStr);
  const hasta = parseDay(hastaStr);

  if (desde == null || hasta == null) { return sendJson(res, 400, { error: "desde y hasta deben tener el formato AAAA-MM-DD." }); }
  if (hasta < desde) { return sendJson(res, 400, { error: "hasta no puede ser anterior a desde." }); }
  const days = (hasta - desde) / DAY_MS + 1;
  if (days > CFG.historyMaxDays) { return sendJson(res, 400, { error: `El rango máximo por consulta es de ${CFG.historyMaxDays} días.` }); }
  if (!["lecturas", "pronosticos"].includes(tipo)) { return sendJson(res, 400, { error: "tipo debe ser lecturas o pronosticos." }); }
  if (!["csv", "json"].includes(formato)) { return sendJson(res, 400, { error: "formato debe ser csv o json." }); }

  let rows;
  try {
    rows = tipo === "lecturas"
      // Los días se interpretan en hora de Bogotá: 00:00 local = 05:00 UTC.
      ? stmt.historicoLecturas.all(CFG.stationId, new Date(desde + BOGOTA_OFFSET_MS).toISOString(), new Date(hasta + DAY_MS + BOGOTA_OFFSET_MS).toISOString())
      : stmt.historicoPronosticos.all(CFG.stationId, desdeStr, hastaStr);
  } catch (e) {
    log("error", "db_error", { reqId, op: "historico", ...errInfo(e) });
    return sendJson(res, 500, { error: "No se pudo consultar el histórico.", reqId });
  }

  log("info", "historico_export", { reqId, tipo, formato, desde: desdeStr, hasta: hastaStr, filas: rows.length });
  if (formato === "json") {
    return sendJson(res, 200, { estacion: CFG.stationId, tipo, desde: desdeStr, hasta: hastaStr, zonaHoraria: "America/Bogota", filas: rows.length, datos: rows });
  }
  const name = `poli-clima_${tipo}_${desdeStr}_a_${hastaStr}.csv`;
  return send(res, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${name}"`
  }, toCsv(rows, tipo === "lecturas" ? LECTURA_COLS : PRONOSTICO_COLS));
}

const server = createServer({ maxHeaderSize: 8 * 1024 }, async (req, res) => {
  const reqId = randomUUID();
  const t0 = performance.now();
  const ip = clientIp(req);
  let path = "-";
  let cacheState;
  res.setHeader("X-Request-Id", reqId);

  res.on("finish", () => {
    metrics.requests += 1;
    metrics.byStatus[res.statusCode] = (metrics.byStatus[res.statusCode] || 0) + 1;
    const level = res.statusCode >= 500 ? "error" : res.statusCode === 429 || res.statusCode >= 400 ? "warn" : "info";
    log(level, "http_request", {
      reqId, ip, method: req.method, path, status: res.statusCode,
      ms: Math.round((performance.now() - t0) * 10) / 10,
      cache: cacheState,
      ua: String(req.headers["user-agent"] || "").slice(0, 160)
    });
  });

  try {
    // Solo lectura: cualquier otro método se rechaza.
    if (req.method !== "GET" && req.method !== "HEAD") {
      return send(res, 405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" }, "Método no permitido");
    }
    if (!req.url || req.url.length > 2048) {
      return send(res, 414, { "Content-Type": "text/plain; charset=utf-8" }, "URL demasiado larga");
    }
    let url;
    try { url = new URL(req.url, "http://localhost"); path = url.pathname; } catch {
      return send(res, 400, { "Content-Type": "text/plain; charset=utf-8" }, "Solicitud inválida");
    }

    // Salud del proceso: sin límite de tasa, para que el monitoreo externo no se bloquee.
    if (path === "/healthz") {
      return sendJson(res, 200, { status: "ok" });
    }

    const all = limitAll.hit(ip);
    if (!all.allowed) {
      metrics.rateLimited += 1;
      return sendJson(res, 429, { error: "Demasiadas solicitudes. Intenta de nuevo en un momento." }, { "Retry-After": String(all.retryAfterS), ...rateHeaders(all) });
    }

    if (path === "/api/sesion") { return sessionInfo(req, res); }
    if (path === "/api/salir") { return logout(req, res, ip, reqId); }
    if (path === "/api/acceso") { return await login(req, res, ip, reqId); }

    const permitidos = ACCESO[path];
    if (permitidos && !(await guard(req, res, ip, permitidos, reqId, path))) { return; }

    if (path === "/api/weather") {
      const api = limitApi.hit(ip);
      if (!api.allowed) {
        metrics.rateLimited += 1;
        return sendJson(res, 429, { error: "Demasiadas solicitudes. Intenta de nuevo en un momento." }, { "Retry-After": String(api.retryAfterS), ...rateHeaders(api) });
      }
      try {
        const w = await weather(reqId);
        cacheState = w.source;
        return send(res, 200, { "Content-Type": "application/json; charset=utf-8", "X-Cache": w.source, ...rateHeaders(api) }, w.body);
      } catch {
        // No se exponen detalles internos al cliente; quedan en el log con el mismo reqId.
        return sendJson(res, 502, { error: "No se pudo obtener datos de la estación.", reqId });
      }
    }

    if (path === "/api/historico/resumen") {
      const api = limitApi.hit(ip);
      if (!api.allowed) {
        metrics.rateLimited += 1;
        return sendJson(res, 429, { error: "Demasiadas solicitudes. Intenta de nuevo en un momento." }, { "Retry-After": String(api.retryAfterS), ...rateHeaders(api) });
      }
      if (!db) { return sendJson(res, 503, { error: "La base de datos está desactivada en este servidor." }); }
      try {
        const c = stmt.conteo.get();
        return sendJson(res, 200, { lecturas: c.lecturas, pronosticos: c.pronosticos, primera: c.primera, ultima: c.ultima, intervaloS: Math.round(CFG.collectIntervalMs / 1000) }, rateHeaders(api));
      } catch (e) {
        log("error", "db_error", { reqId, op: "resumen", ...errInfo(e) });
        return sendJson(res, 500, { error: "No se pudo consultar el histórico.", reqId });
      }
    }

    if (path === "/api/historico") {
      const api = limitApi.hit(ip);
      if (!api.allowed) {
        metrics.rateLimited += 1;
        return sendJson(res, 429, { error: "Demasiadas solicitudes. Intenta de nuevo en un momento." }, { "Retry-After": String(api.retryAfterS), ...rateHeaders(api) });
      }
      return historico(res, url.searchParams, reqId);
    }

    if (path === "/api/status") {
      const s = status();
      return sendJson(res, s.status === "down" ? 503 : 200, s);
    }

    if (path === "/" || path === "/index.html") {
      return send(res, 200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP }, INDEX_HTML);
    }

    return send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "No encontrado");
  } catch (e) {
    log("error", "unhandled_request_error", { reqId, path, ...errInfo(e), stack: e?.stack });
    if (!res.headersSent) { sendJson(res, 500, { error: "Error interno.", reqId }); } else { res.destroy(); }
  }
});

// Límites de conexión para mitigar clientes lentos (slowloris) y conexiones abusivas.
server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 100;
server.on("clientError", (e, socket) => {
  log("warn", "client_error", { ...errInfo(e), ip: (socket.remoteAddress || "").replace(/^::ffff:/, "") });
  if (socket.writable) { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); }
});
server.on("error", (e) => {
  log("fatal", "server_error", errInfo(e));
  process.exit(1);
});

server.listen(CFG.port, CFG.host, () => {
  log("info", "server_started", {
    url: `http://${CFG.host === "0.0.0.0" ? "localhost" : CFG.host}:${CFG.port}`,
    stationId: CFG.stationId,
    cacheTtlMs: CFG.cacheTtlMs,
    rateLimit: { windowMs: CFG.rateWindowMs, max: CFG.rateMaxAll, maxApi: CFG.rateMaxApi, trustProxy: CFG.trustProxy },
    acceso: { analista: Boolean(CFG.auth.analista), administrador: Boolean(CFG.auth.administrador) },
    logLevel: CFG.logLevel,
    logFile: CFG.logFile,
    database: db ? { file: CFG.dbFile, collectIntervalS: Math.round(CFG.collectIntervalMs / 1000) } : false,
    node: process.version
  });
  if (!CFG.auth.analista && !CFG.auth.administrador) {
    log("warn", "auth_not_configured", { detail: "El histórico y /api/status están cerrados hasta que se configure una contraseña. Cree una con: npm run crear-clave" });
  }
  if (db) { startCollector(); }
});

/* ===================================================================
 * 7b. Recolector: consulta la estación cada COLLECT_INTERVAL_MS aunque
 *     nadie tenga la página abierta. Usa la misma caché y la misma
 *     consulta única que /api/weather, así que no duplica tráfico.
 * =================================================================== */

let collectorTimer = null;
function startCollector() {
  if (CFG.collectIntervalMs < CFG.cacheTtlMs) {
    log("warn", "collector_interval_below_cache", { collectIntervalMs: CFG.collectIntervalMs, cacheTtlMs: CFG.cacheTtlMs });
  }
  const tick = async () => {
    const reqId = "collector-" + randomUUID().slice(0, 8);
    try {
      const w = await weather(reqId);
      log("debug", "collector_tick", { reqId, source: w.source });
    } catch {
      // El error ya quedó registrado como upstream_error; se reintenta en el siguiente ciclo.
    }
  };
  setTimeout(tick, 1_000).unref();
  collectorTimer = setInterval(tick, CFG.collectIntervalMs);
  collectorTimer.unref();
}

/* ===================================================================
 * 8. Errores no controlados y apagado ordenado.
 * =================================================================== */

process.on("unhandledRejection", (e) => log("error", "unhandled_rejection", { ...errInfo(e), stack: e?.stack }));
process.on("uncaughtException", (e) => {
  log("fatal", "uncaught_exception", { ...errInfo(e), stack: e?.stack });
  shutdown("uncaughtException", 1);
});

let closing = false;
function shutdown(signal, code = 0) {
  if (closing) { return; }
  closing = true;
  log("info", "shutdown_started", { signal });
  if (collectorTimer) { clearInterval(collectorTimer); }
  server.close(() => {
    if (db) {
      try { db.close(); } catch (e) { log("error", "db_error", { op: "close", ...errInfo(e) }); }
    }
    log("info", "shutdown_complete", { signal });
    if (fileStream) { fileStream.end(() => process.exit(code)); } else { process.exit(code); }
  });
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(code), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
