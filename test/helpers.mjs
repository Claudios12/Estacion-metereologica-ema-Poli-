// Arnés de pruebas: arranca server.mjs como caja negra y le pone un WeatherLink falso en localhost.
// Las pruebas solo usan lo que un operador o un cliente ve: variables de entorno, HTTP y logs.
import { spawn } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const STATION_ID = "78e4ae1ed0d046f480fe79dc04e7ef23";

// 2026-11-10 05:21:00 UTC = 2026-11-10 00:21:00 en Bogotá.
export const LECTURA_FIJA = Date.UTC(2026, 10, 10, 5, 21, 0);

/**
 * Credenciales de prueba. La contraseña del analista lleva tilde y eñe a propósito (UTF-8 en Basic).
 * El hash se calcula aquí con costo bajo para que las pruebas sean rápidas; el formato es el del servidor:
 * scrypt:N:r:p:sal:hash (base64url).
 */
export const ANALISTA = { user: "analista", pass: "clave-analista-ñandú-2026" };
export const ADMIN = { user: "admin", pass: "clave-admin-2026" };

export function hashClave(pass, { N = 1024, r = 8, p = 1 } = {}) {
  const sal = randomBytes(16);
  const hash = scryptSync(pass, sal, 32, { N, r, p });
  return ["scrypt", N, r, p, sal.toString("base64url"), hash.toString("base64url")].join(":");
}

export const basic = ({ user, pass }) => "Basic " + Buffer.from(`${user}:${pass}`, "utf8").toString("base64");

const HASH_ANALISTA = hashClave(ANALISTA.pass);
const HASH_ADMIN = hashClave(ADMIN.pass);

/** Respuesta de WeatherLink con la forma real (los números llegan como texto). */
export function payload(overrides = {}) {
  return {
    windDirection: 172,
    forecastOverview: [{
      date: "2026-11-10",
      morning: { weatherCode: 14, weatherDesc: "Cloudy", temp: 18, chanceofrain: 21 },
      afternoon: { weatherCode: 31, weatherDesc: "Drizzle", temp: 17, chanceofrain: 44 },
      evening: { weatherCode: 2, weatherDesc: "Mostly Clear", temp: 10, chanceofrain: 0 },
      night: { weatherCode: 31, weatherDesc: "Drizzle", temp: 9, chanceofrain: 28 }
    }],
    temperatureFeelLike: "10.7",
    temperature: "10.8",
    hiTemp: "10.9",
    loTemp: "10.7",
    wind: "1.8",
    gust: "5.4",
    humidity: "76.4",
    rain: "0.0",
    seasonalRain: "929.0",
    barometer: "758.1",
    barometerTrend: "Falling Slowly",
    lastReceived: LECTURA_FIJA,
    ...overrides
  };
}

/** WeatherLink de mentira. `modo` decide qué responde; se puede cambiar en caliente. */
export async function fakeWeatherLink(inicial = {}) {
  const estado = { body: payload(), status: 200, delayMs: 0, raw: null, hits: 0, ...inicial };
  const server = createServer((req, res) => {
    if (req.url !== `/embeddablePage/getData/${STATION_ID}`) { res.writeHead(404); return res.end(); }
    estado.hits += 1;
    setTimeout(() => {
      res.writeHead(estado.status, { "Content-Type": "application/json" });
      res.end(estado.raw ?? JSON.stringify(estado.body));
    }, estado.delayMs);
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    estado,
    close: () => new Promise((ok) => { server.closeAllConnections?.(); server.close(ok); })
  };
}

async function puertoLibre() {
  return new Promise((ok, fail) => {
    const s = createNetServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); });
  });
}

/** Carpeta temporal para la base de datos de una prueba. */
export function carpetaTemporal() {
  const dir = mkdtempSync(join(tmpdir(), "poli-clima-test-"));
  return { dir, dbFile: join(dir, "poli.db"), limpiar: () => rmSync(dir, { recursive: true, force: true }) };
}

function lanzar(env) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, HOST: "127.0.0.1", LOG_LEVEL: "debug", ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const logs = [];
  const salida = { exit: null };
  const alExit = new Promise((ok) => child.once("exit", (code) => { salida.exit = code; ok(code); }));
  for (const flujo of [child.stdout, child.stderr]) {
    let resto = "";
    flujo.on("data", (chunk) => {
      resto += chunk;
      let i;
      while ((i = resto.indexOf("\n")) >= 0) {
        const linea = resto.slice(0, i).trim();
        resto = resto.slice(i + 1);
        if (!linea) { continue; }
        try { logs.push(JSON.parse(linea)); } catch { logs.push({ msg: "linea_no_json", linea }); }
      }
    });
  }
  return { child, logs, salida, alExit };
}

/** Arranca el servidor y espera a que esté escuchando. */
export async function arrancar(env = {}) {
  const port = await puertoLibre();
  const { child, logs, salida, alExit } = lanzar({
    PORT: String(port),
    ANALYST_USER: ANALISTA.user, ANALYST_PASSWORD_HASH: HASH_ANALISTA,
    ADMIN_USER: ADMIN.user, ADMIN_PASSWORD_HASH: HASH_ADMIN,
    ...env
  });
  const base = `http://127.0.0.1:${port}`;

  const listo = await Promise.race([
    esperar(() => logs.some((l) => l.msg === "server_started"), 10_000).then(() => true),
    alExit.then(() => false)
  ]);
  if (!listo) { throw new Error(`El servidor no arrancó. Logs: ${JSON.stringify(logs)}`); }

  // Por comodidad, get/json entran como administrador. Para probar el acceso: { rol: null } (anónimo),
  // { rol: ANALISTA } o { headers: { Authorization: "..." } }.
  const conRol = (opciones = {}) => {
    const { rol = ADMIN, ...resto } = opciones;
    const headers = { ...(rol ? { Authorization: basic(rol) } : {}), ...(resto.headers ?? {}) };
    return { ...resto, headers };
  };

  return {
    base, logs, port,
    get: (ruta, opciones) => fetch(base + ruta, conRol(opciones)),
    json: async (ruta, opciones) => (await fetch(base + ruta, conRol(opciones))).json(),
    esperarLog: (msg, ms = 5_000) => esperar(() => logs.find((l) => l.msg === msg), ms),
    async detener() {
      if (salida.exit === null) { child.kill(); await alExit; }
    }
  };
}

/** Arranca con una configuración que se espera inválida y devuelve cómo terminó. */
export async function arrancarYEsperarFin(env = {}) {
  const port = await puertoLibre();
  const { logs, alExit, child } = lanzar({ PORT: String(port), ...env });
  const timeout = setTimeout(() => child.kill(), 8_000);
  const code = await alExit;
  clearTimeout(timeout);
  return { code, logs };
}

/** Espera hasta que `condicion()` devuelva algo verdadero; devuelve ese valor. */
export async function esperar(condicion, ms = 5_000, cadaMs = 25) {
  const fin = Date.now() + ms;
  for (;;) {
    const v = condicion();
    if (v) { return v; }
    if (Date.now() > fin) { throw new Error(`Tiempo agotado esperando la condición (${ms} ms)`); }
    await new Promise((ok) => setTimeout(ok, cadaMs));
  }
}

export const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** Entorno mínimo para un servidor que habla con el WeatherLink falso. */
export function entorno(wl, extra = {}) {
  return { WEATHERLINK_BASE_URL: wl.url, DB_ENABLED: "false", ...extra };
}
