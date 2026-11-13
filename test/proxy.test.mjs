// Seam A · Servidor por HTTP — proxy hacia WeatherLink.
// Se arranca server.mjs como lo haría un operador y se le pone un WeatherLink falso delante.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fakeWeatherLink, arrancar, entorno, esperar, payload } from "./helpers.mjs";

/** Prepara un WeatherLink falso y un servidor; devuelve utilidades y se limpia solo. */
function escenario(extraEnv = {}, inicial = {}) {
  const ctx = {};
  before(async () => {
    ctx.wl = await fakeWeatherLink(inicial);
    ctx.app = await arrancar(entorno(ctx.wl, extraEnv));
  });
  after(async () => { await ctx.app.detener(); await ctx.wl.close(); });
  return ctx;
}

describe("GET /api/weather · datos de la estación", () => {
  const ctx = escenario();

  test("entrega la lectura tal como la publica WeatherLink", async () => {
    const res = await ctx.app.get("/api/weather");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^application\/json/);
    const body = await res.json();
    assert.equal(body.temperature, "10.8");
    assert.equal(body.humidity, "76.4");
    assert.equal(body.forecastOverview[0].afternoon.chanceofrain, 44);
  });

  test("la segunda consulta sale de la memoria y no vuelve a molestar a WeatherLink", async () => {
    const res = await ctx.app.get("/api/weather");
    assert.equal(res.headers.get("x-cache"), "HIT");
    assert.equal(ctx.wl.estado.hits, 1);
  });
});

describe("GET /api/weather · consultas simultáneas", () => {
  const ctx = escenario({}, { delayMs: 300 });

  test("cinco visitantes a la vez provocan una sola consulta a WeatherLink", async () => {
    const respuestas = await Promise.all(Array.from({ length: 5 }, () => ctx.app.get("/api/weather")));
    assert.deepEqual(respuestas.map((r) => r.status), [200, 200, 200, 200, 200]);
    assert.equal(ctx.wl.estado.hits, 1);
  });
});

describe("GET /api/weather · cuando WeatherLink falla (sin dato previo)", () => {
  const casos = [
    ["responde con error 500", { status: 500 }],
    ["responde algo que no es JSON", { raw: "esto no es json" }],
    ["responde sin la temperatura", { body: (() => { const p = payload(); delete p.temperature; return p; })() }],
    ["responde con una humedad que no es un número", { body: payload({ humidity: "abc" }) }],
    ["responde sin la hora de la lectura", { body: (() => { const p = payload(); delete p.lastReceived; return p; })() }],
    ["responde con un pronóstico que no es una lista", { body: payload({ forecastOverview: "mañana llueve" }) }]
  ];

  for (const [nombre, inicial] of casos) {
    describe(nombre, () => {
      const ctx = escenario({}, inicial);

      test("el visitante recibe 502 con un identificador y sin detalles internos", async () => {
        const res = await ctx.app.get("/api/weather");
        assert.equal(res.status, 502);
        const body = await res.json();
        assert.equal(typeof body.reqId, "string");
        assert.equal(body.error, "No se pudo obtener datos de la estación.");
        assert.deepEqual(Object.keys(body).sort(), ["error", "reqId"]);
      });

      test("el operador ve el motivo en los logs con el mismo identificador", async () => {
        const res = await ctx.app.get("/api/weather");
        const { reqId } = await res.json();
        const log = ctx.app.logs.find((l) => l.msg === "upstream_error" && l.reqId === reqId);
        assert.ok(log, "debería existir un log upstream_error con el mismo reqId");
        assert.equal(log.level, "error");
      });
    });
  }
});

describe("GET /api/weather · límites de la consulta a WeatherLink", () => {
  describe("respuesta demasiado grande", () => {
    const relleno = JSON.stringify({ ...payload(), relleno: "x".repeat(4000) });
    const ctx = escenario({ UPSTREAM_MAX_BYTES: "1024" }, { raw: relleno });

    test("se rechaza con 502 en lugar de leerla completa", async () => {
      const res = await ctx.app.get("/api/weather");
      assert.equal(res.status, 502);
      assert.ok(ctx.app.logs.some((l) => l.msg === "upstream_error" && l.code === "UPSTREAM_TOO_LARGE"));
    });
  });

  describe("respuesta lenta", () => {
    const ctx = escenario({ UPSTREAM_TIMEOUT_MS: "500" }, { delayMs: 2500 });

    test("se corta a los 500 ms configurados y responde 502", async () => {
      const t0 = Date.now();
      const res = await ctx.app.get("/api/weather");
      const ms = Date.now() - t0;
      assert.equal(res.status, 502);
      assert.ok(ms < 1800, `tardó ${ms} ms; debía cortar cerca de 500 ms`);
    });
  });
});

describe("Solo lectura y rutas", () => {
  const ctx = escenario();

  for (const metodo of ["POST", "PUT", "PATCH", "DELETE"]) {
    test(`${metodo} se rechaza con 405 y dice qué métodos acepta`, async () => {
      const res = await ctx.app.get("/api/weather", { method: metodo });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "GET, HEAD");
    });
  }

  test("HEAD responde como GET pero sin cuerpo", async () => {
    const res = await ctx.app.get("/api/weather", { method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal((await res.text()).length, 0);
  });

  test("una ruta inexistente da 404 sin revelar nada interno", async () => {
    const res = await ctx.app.get("/.env");
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "No encontrado");
  });

  test("una URL absurdamente larga se rechaza con 414", async () => {
    const res = await ctx.app.get("/" + "a".repeat(3000));
    assert.equal(res.status, 414);
  });

  test("/healthz confirma que el proceso vive", async () => {
    const res = await ctx.app.get("/healthz");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });

  test("cada respuesta lleva un identificador de solicitud único", async () => {
    const [a, b] = await Promise.all([ctx.app.get("/healthz"), ctx.app.get("/healthz")]);
    const idA = a.headers.get("x-request-id");
    assert.match(idA, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
    assert.notEqual(idA, b.headers.get("x-request-id"));
  });
});

describe("GET / · la página y sus protecciones", () => {
  const ctx = escenario();

  test("sirve la página de Poli Clima", async () => {
    const res = await ctx.app.get("/");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/html/);
    assert.match(await res.text(), /<title>Poli Clima<\/title>/);
  });

  test("lleva encabezados de seguridad y nunca se guarda en caché", async () => {
    const h = (await ctx.app.get("/")).headers;
    assert.equal(h.get("x-content-type-options"), "nosniff");
    assert.equal(h.get("x-frame-options"), "DENY");
    assert.equal(h.get("referrer-policy"), "no-referrer");
    assert.equal(h.get("cache-control"), "no-store");
  });

  test("la política de contenido autoriza exactamente el script de la página y nada más", async () => {
    const res = await ctx.app.get("/");
    const csp = res.headers.get("content-security-policy");
    const html = await res.text();
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    assert.equal(scripts.length, 1, "la página debe tener un solo script en línea");
    const hash = createHash("sha256").update(scripts[0].replace(/\r\n?/g, "\n")).digest("base64");
    assert.ok(csp.includes(`'sha256-${hash}'`), "la CSP debe contener el hash del script servido");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-eval'/);
  });

  test("la CSP solo permite conectarse al propio servidor y a WeatherLink", async () => {
    const csp = (await ctx.app.get("/")).headers.get("content-security-policy");
    const connect = csp.split(";").map((s) => s.trim()).find((s) => s.startsWith("connect-src"));
    assert.equal(connect, `connect-src 'self' ${ctx.wl.url}`);
  });
});

describe("Control de tasas por IP", () => {
  describe("cupo de /api/weather (3 por ventana)", () => {
    const ctx = escenario({ RATE_LIMIT_MAX_API: "3", RATE_LIMIT_MAX: "50" });

    test("la cuarta consulta recibe 429 con el tiempo de espera", async () => {
      for (let i = 0; i < 3; i += 1) { assert.equal((await ctx.app.get("/api/weather")).status, 200); }
      const res = await ctx.app.get("/api/weather");
      assert.equal(res.status, 429);
      const espera = Number(res.headers.get("retry-after"));
      assert.ok(Number.isInteger(espera) && espera >= 1 && espera <= 60, `Retry-After inválido: ${espera}`);
      assert.match((await res.json()).error, /Demasiadas solicitudes/);
    });

    test("el monitoreo nunca se bloquea: /healthz sigue respondiendo", async () => {
      for (let i = 0; i < 5; i += 1) { assert.equal((await ctx.app.get("/healthz")).status, 200); }
    });
  });

  describe("detrás de un proxy de confianza (TRUST_PROXY=true)", () => {
    const ctx = escenario({ TRUST_PROXY: "true", RATE_LIMIT_MAX_API: "3", RATE_LIMIT_MAX: "50" });
    const consulta = (xff) => ctx.app.get("/api/weather", { headers: { "X-Forwarded-For": xff } });

    test("un cliente no puede saltarse el límite escribiendo IP falsas en X-Forwarded-For", async () => {
      // El proxy de confianza AGREGA la IP real al final; lo que hay a la izquierda lo escribió el cliente.
      const estados = [];
      for (let i = 1; i <= 5; i += 1) { estados.push((await consulta(`10.0.0.${i}, 203.0.113.9`)).status); }
      assert.deepEqual(estados, [200, 200, 200, 429, 429]);
    });

    test("cada cliente real tiene su propio cupo", async () => {
      assert.equal((await consulta("198.51.100.7")).status, 200, "otro cliente real no debe heredar el bloqueo");
    });

    test("los logs registran la IP que puso el proxy, no la que escribió el cliente", async () => {
      await consulta("1.2.3.4, 198.51.100.22");
      // El log de la solicitud se escribe cuando termina de enviarse la respuesta: se espera a que aparezca.
      await esperar(() => ctx.app.logs.some((l) => l.msg === "http_request" && l.ip === "198.51.100.22"));
      assert.ok(!ctx.app.logs.some((l) => l.msg === "http_request" && l.ip === "1.2.3.4"));
    });

    test("si el proxy sobrescribe con una sola IP (como deploy/nginx.conf), también funciona", async () => {
      assert.equal((await consulta("192.0.2.50")).status, 200);
      await esperar(() => ctx.app.logs.some((l) => l.msg === "http_request" && l.ip === "192.0.2.50"));
    });
  });

  describe("cupo general (4 por ventana)", () => {
    const ctx = escenario({ RATE_LIMIT_MAX: "4", RATE_LIMIT_MAX_API: "50" });

    test("también se limita la página, no solo la API", async () => {
      const estados = [];
      for (let i = 0; i < 6; i += 1) { estados.push((await ctx.app.get("/")).status); }
      assert.deepEqual(estados, [200, 200, 200, 200, 429, 429]);
    });
  });
});

describe("GET /api/status · salud del servicio", () => {
  describe("estación al día", () => {
    const ctx = escenario({}, { body: payload({ lastReceived: Date.now() - 60_000 }) });

    test("informa ok, la antigüedad del dato y las consultas a WeatherLink", async () => {
      await ctx.app.get("/api/weather");
      const res = await ctx.app.get("/api/status");
      assert.equal(res.status, 200);
      const s = await res.json();
      assert.equal(s.status, "ok");
      assert.equal(s.station.dataAgeMin, 1);
      assert.equal(s.upstream.ok, 1);
      assert.equal(s.upstream.errors, 0);
    });
  });

  describe("estación sin reportar hace 3 horas", () => {
    const ctx = escenario({}, { body: payload({ lastReceived: Date.now() - 3 * 3_600_000 }) });

    test("informa degradado y deja una alerta en los logs", async () => {
      await ctx.app.get("/api/weather");
      const s = await ctx.app.json("/api/status");
      assert.equal(s.status, "degraded");
      assert.equal(s.station.dataAgeMin, 180);
      const alerta = ctx.app.logs.find((l) => l.msg === "station_stale");
      assert.ok(alerta, "debería registrarse station_stale");
      assert.equal(alerta.level, "warn");
      assert.equal(alerta.ageMin, 180);
    });
  });

  describe("WeatherLink caído y sin ningún dato", () => {
    const ctx = escenario({}, { status: 500 });

    test("informa caído con código 503", async () => {
      await ctx.app.get("/api/weather");
      const res = await ctx.app.get("/api/status");
      assert.equal(res.status, 503);
      const s = await res.json();
      assert.equal(s.status, "down");
      assert.equal(s.upstream.errors, 1);
    });
  });
});
