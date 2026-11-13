// Seam B · Configuración al arrancar: un valor inválido impide el inicio y dice cuál y por qué.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { arrancar, arrancarYEsperarFin, carpetaTemporal, hashClave } from "./helpers.mjs";

const invalidos = [
  ["PORT", "abc"],
  ["PORT", "0"],
  ["PORT", "70000"],
  ["STATION_ID", "xyz"],
  ["STATION_ID", "78e4ae1ed0d046f480fe79dc04e7ef2"], // 31 caracteres
  ["LOG_LEVEL", "loud"],
  ["WEATHERLINK_BASE_URL", "no es una url"],
  ["WEATHERLINK_BASE_URL", "http://example.com"],     // http solo se permite hacia localhost
  ["CACHE_TTL_MS", "5"],                              // mínimo 10 000
  ["COLLECT_INTERVAL_MS", "1000"],                    // mínimo 1 minuto
  ["RATE_LIMIT_MAX_API", "0"],
  ["HISTORY_MAX_DAYS", "0"],
  ["DB_ENABLED", "quizas"],
  ["TRUST_PROXY", "tal vez"],
  ["HOST", "host malo!"],
  ["ANALYST_PASSWORD_HASH", "no-es-un-hash"],
  ["ADMIN_PASSWORD_HASH", "scrypt:16384:8:1:soloSal"],            // faltan partes
  ["ADMIN_PASSWORD_HASH", "scrypt:1:8:1:c2Fs:aGFzaA"],           // costo demasiado bajo (N=1)
  ["ANALYST_USER", "con:dospuntos"],                             // ':' rompe la autenticación Basic
  ["ADMIN_USER", "con espacio"],
  ["AUTH_FAIL_MAX", "0"],
  ["AUTH_FAIL_WINDOW_MS", "10"],
  ["SESSION_TTL_MS", "5"]                                         // mínimo 1000 (1 s)
];

describe("Configuración inválida", () => {
  for (const [variable, valor] of invalidos) {
    test(`${variable}="${valor}" impide arrancar y nombra la variable`, async () => {
      const { code, logs } = await arrancarYEsperarFin({ [variable]: valor });
      assert.equal(code, 1);
      const errores = logs.filter((l) => l.msg === "config_invalid");
      assert.ok(errores.some((l) => l.level === "fatal" && l.detail.includes(variable)),
        `ningún config_invalid menciona ${variable}: ${JSON.stringify(errores)}`);
      assert.ok(logs.some((l) => l.msg === "startup_aborted"));
      assert.ok(!logs.some((l) => l.msg === "server_started"), "no debe llegar a escuchar");
    });
  }

  test("informa todos los errores de una vez, no solo el primero", async () => {
    const { code, logs } = await arrancarYEsperarFin({ PORT: "abc", LOG_LEVEL: "loud", STATION_ID: "zz" });
    assert.equal(code, 1);
    const detalles = logs.filter((l) => l.msg === "config_invalid").map((l) => l.detail).join(" | ");
    for (const v of ["PORT", "LOG_LEVEL", "STATION_ID"]) { assert.ok(detalles.includes(v), `falta ${v} en: ${detalles}`); }
  });

  test("si la base de datos no se puede abrir, no arranca a medias", async () => {
    const tmp = carpetaTemporal();
    try {
      const { code, logs } = await arrancarYEsperarFin({ DB_FILE: tmp.dir }); // una carpeta, no un archivo
      assert.equal(code, 1);
      assert.ok(logs.some((l) => l.msg === "startup_aborted" && /base de datos/.test(l.reason)));
    } finally { tmp.limpiar(); }
  });
});

describe("Configuración válida", () => {
  test("sin ninguna variable, arranca con los valores por defecto", async () => {
    const tmp = carpetaTemporal();
    const app = await arrancar({ DB_FILE: tmp.dbFile, DB_ENABLED: "false" });
    try {
      const inicio = app.logs.find((l) => l.msg === "server_started");
      assert.equal(inicio.stationId, "78e4ae1ed0d046f480fe79dc04e7ef23");
      assert.equal(inicio.cacheTtlMs, 60_000);
      assert.equal(inicio.rateLimit.max, 120);
      assert.equal(inicio.rateLimit.maxApi, 30);
      assert.equal(inicio.rateLimit.trustProxy, false);
      assert.equal(inicio.database, false);
    } finally { await app.detener(); tmp.limpiar(); }
  });

  test("el analista y el administrador no pueden compartir usuario", async () => {
    const hash = hashClave("x");
    const { code, logs } = await arrancarYEsperarFin({ ANALYST_USER: "mismo", ANALYST_PASSWORD_HASH: hash, ADMIN_USER: "mismo", ADMIN_PASSWORD_HASH: hash });
    assert.equal(code, 1);
    assert.ok(logs.some((l) => l.msg === "config_invalid" && /distintos/.test(l.detail)));
  });

  test("con solo el rol de analista configurado, arranca", async () => {
    const app = await arrancar({ DB_ENABLED: "false", ADMIN_PASSWORD_HASH: "" });
    await app.detener();
  });

  test("permite http solo hacia localhost (para pruebas)", async () => {
    const app = await arrancar({ WEATHERLINK_BASE_URL: "http://127.0.0.1:9", DB_ENABLED: "false" });
    await app.detener();
  });
});
