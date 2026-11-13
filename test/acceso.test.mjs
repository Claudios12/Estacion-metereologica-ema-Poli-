// Seam A · Servidor por HTTP — quién puede ver qué.
// Comunidad: página, /api/weather y /healthz (sin clave). Analista: histórico. Administrador: histórico y /api/status.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { fakeWeatherLink, arrancar, entorno, basic, dormir, ANALISTA, ADMIN } from "./helpers.mjs";

const RUTAS_PROTEGIDAS = ["/api/historico", "/api/historico/resumen", "/api/status"];
const CON_BASE = { DB_ENABLED: "true" };

function escenario(extraEnv = {}) {
  const ctx = {};
  before(async () => {
    ctx.wl = await fakeWeatherLink();
    ctx.carpeta = (await import("./helpers.mjs")).carpetaTemporal();
    ctx.app = await arrancar(entorno(ctx.wl, { ...CON_BASE, DB_FILE: ctx.carpeta.dbFile, ...extraEnv }));
  });
  after(async () => { await ctx.app.detener(); await ctx.wl.close(); ctx.carpeta.limpiar(); });
  return ctx;
}

describe("Sin ninguna contraseña configurada, lo restringido queda cerrado", () => {
  const ctx = escenario({ ANALYST_PASSWORD_HASH: "", ADMIN_PASSWORD_HASH: "" });

  for (const ruta of ["/", "/api/weather", "/healthz"]) {
    test(`${ruta} sigue siendo público`, async () => {
      assert.equal((await ctx.app.get(ruta, { rol: null })).status, 200);
    });
  }

  for (const ruta of RUTAS_PROTEGIDAS) {
    test(`${ruta} responde 403 y explica qué falta configurar`, async () => {
      const res = await ctx.app.get(ruta, { rol: null });
      assert.equal(res.status, 403);
      assert.match((await res.json()).error, /no está configurado/);
    });

    test(`${ruta} tampoco se abre con credenciales inventadas`, async () => {
      const res = await ctx.app.get(ruta, { rol: { user: "admin", pass: "cualquiera" } });
      assert.equal(res.status, 403);
    });
  }
});

describe("Con contraseñas configuradas", () => {
  const ctx = escenario();

  describe("la comunidad no necesita clave", () => {
    for (const ruta of ["/", "/api/weather", "/healthz"]) {
      test(`${ruta} responde 200 sin credenciales`, async () => {
        assert.equal((await ctx.app.get(ruta, { rol: null })).status, 200);
      });
    }
  });

  describe("quien no se identifica recibe el desafío del navegador", () => {
    for (const ruta of RUTAS_PROTEGIDAS) {
      test(`${ruta} → 401 con WWW-Authenticate y sin guardarse en caché`, async () => {
        const res = await ctx.app.get(ruta, { rol: null });
        assert.equal(res.status, 401);
        assert.equal(res.headers.get("www-authenticate"), 'Basic realm="Poli Clima", charset="UTF-8"');
        assert.equal(res.headers.get("cache-control"), "no-store");
      });
    }
  });

  describe("cada rol ve solo lo suyo", () => {
    const matriz = [
      ["/api/historico", ANALISTA, 200],
      ["/api/historico", ADMIN, 200],
      ["/api/historico/resumen", ANALISTA, 200],
      ["/api/historico/resumen", ADMIN, 200],
      ["/api/status", ANALISTA, 403],
      ["/api/status", ADMIN, 200]
    ];
    for (const [ruta, rol, esperado] of matriz) {
      test(`${rol.user} en ${ruta} → ${esperado}`, async () => {
        assert.equal((await ctx.app.get(ruta, { rol })).status, esperado);
      });
    }

    test("al analista le dicen que no tiene permiso, no que su clave está mal", async () => {
      const res = await ctx.app.get("/api/status", { rol: ANALISTA });
      assert.equal(res.headers.get("www-authenticate"), null, "no debe volver a pedir la clave");
      assert.match((await res.json()).error, /permiso/);
    });
  });

  describe("credenciales incorrectas", () => {
    test("contraseña errada → 401", async () => {
      assert.equal((await ctx.app.get("/api/historico", { rol: { user: ANALISTA.user, pass: "no-es" } })).status, 401);
    });

    test("usuario inexistente → 401 con la misma respuesta (no revela qué usuarios existen)", async () => {
      const a = await ctx.app.get("/api/historico", { rol: { user: ANALISTA.user, pass: "no-es" } });
      const b = await ctx.app.get("/api/historico", { rol: { user: "fantasma", pass: "no-es" } });
      assert.equal(b.status, 401);
      assert.equal(await b.text(), await a.text());
    });

    test("la clave de un rol no sirve con el usuario de otro", async () => {
      assert.equal((await ctx.app.get("/api/status", { rol: { user: ADMIN.user, pass: ANALISTA.pass } })).status, 401);
    });

    for (const [nombre, valor] of [
      ["esquema que no es Basic", "Bearer abc123"],
      ["base64 inválido", "Basic !!!no-es-base64"],
      ["sin los dos puntos", "Basic " + Buffer.from("soloUsuario").toString("base64")],
      ["vacío", "Basic "]
    ]) {
      test(`encabezado Authorization con ${nombre} → 401`, async () => {
        const res = await ctx.app.get("/api/historico", { rol: null, headers: { Authorization: valor } });
        assert.equal(res.status, 401);
      });
    }
  });

  describe("lo que queda en los logs", () => {
    test("un intento fallido deja una alerta, pero nunca la contraseña ni el encabezado", async () => {
      const secreta = "contraseña-secreta-que-no-debe-aparecer";
      await ctx.app.get("/api/historico", { rol: { user: ANALISTA.user, pass: secreta } });
      const alerta = await ctx.app.esperarLog("auth_failed");
      assert.equal(alerta.level, "warn");
      assert.equal(alerta.path, "/api/historico");
      assert.ok(alerta.ip);
      const todo = JSON.stringify(ctx.app.logs);
      assert.ok(!todo.includes(secreta), "la contraseña no debe estar en los logs");
      assert.ok(!todo.includes(Buffer.from(`${ANALISTA.user}:${secreta}`).toString("base64")), "el encabezado Authorization no debe estar en los logs");
    });
  });
});

describe("Protección contra adivinar contraseñas", () => {
  const ctx = escenario({ AUTH_FAIL_MAX: "3", TRUST_PROXY: "true", RATE_LIMIT_MAX: "500", RATE_LIMIT_MAX_API: "500" });
  const desde = (ip, rol, ruta = "/api/historico") => ctx.app.get(ruta, { rol, headers: { "X-Forwarded-For": ip } });
  const mala = { user: ANALISTA.user, pass: "incorrecta" };

  test("tras 3 fallos desde una IP, se bloquea esa IP aunque acierte la contraseña", async () => {
    for (let i = 0; i < 3; i += 1) { assert.equal((await desde("203.0.113.1", mala)).status, 401); }
    const res = await desde("203.0.113.1", ANALISTA);
    assert.equal(res.status, 429);
    const espera = Number(res.headers.get("retry-after"));
    assert.ok(Number.isInteger(espera) && espera >= 1 && espera <= 300, `Retry-After inválido: ${espera}`);
  });

  test("el bloqueo es por IP: otra persona entra con normalidad", async () => {
    assert.equal((await desde("203.0.113.2", ANALISTA)).status, 200);
  });

  test("entrar bien reinicia la cuenta de fallos", async () => {
    const ip = "203.0.113.3";
    await desde(ip, mala); await desde(ip, mala);
    assert.equal((await desde(ip, ANALISTA)).status, 200);
    await desde(ip, mala); await desde(ip, mala);
    assert.equal((await desde(ip, ANALISTA)).status, 200, "dos fallos nuevos no deben bloquear: la cuenta se reinició");
  });

  test("pedir sin credenciales (lo normal en un navegador al llegar) no cuenta como fallo", async () => {
    const ip = "203.0.113.4";
    for (let i = 0; i < 6; i += 1) { assert.equal((await desde(ip, null)).status, 401); }
    assert.equal((await desde(ip, ANALISTA)).status, 200);
  });
});

// ---------------------------------------------------------------------------------------------
// Sesión de la página: el navegador no puede "olvidar" una clave HTTP básica, así que la página inicia una
// sesión propia (cookie) y cerrarla la destruye de verdad en el servidor. Las herramientas siguen con Basic.
// ---------------------------------------------------------------------------------------------

const PAGINA = { "X-Requested-With": "poli-clima" };

/** Inicia sesión como lo hace la página. Devuelve la respuesta y la cookie lista para reenviar. */
async function entrar(app, rol, extra = {}) {
  const res = await app.get("/api/acceso", { rol: null, headers: { ...PAGINA, Authorization: basic(rol), ...extra } });
  const setCookie = res.headers.getSetCookie?.()[0] ?? null;
  return { res, setCookie, cookie: setCookie ? setCookie.split(";")[0] : null };
}

const conCookie = (app, ruta, cookie, headers = {}) => app.get(ruta, { rol: null, headers: { Cookie: cookie, ...headers } });

describe("Sesión de la página (iniciar y cerrar sesión)", () => {
  const ctx = escenario();

  describe("estado de la sesión", () => {
    test("/api/sesion es público y dice que no hay sesión, sin provocar ningún error", async () => {
      const res = await ctx.app.get("/api/sesion", { rol: null });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { autenticado: false });
    });

    test("una cookie inventada no sirve", async () => {
      const falsa = "poli_sesion=" + "A".repeat(43);
      assert.deepEqual(await (await conCookie(ctx.app, "/api/sesion", falsa)).json(), { autenticado: false });
      assert.equal((await conCookie(ctx.app, "/api/historico/resumen", falsa)).status, 401);
    });
  });

  describe("iniciar sesión", () => {
    test("solo se acepta si la petición viene de la página (protege contra peticiones de otros sitios)", async () => {
      const res = await ctx.app.get("/api/acceso", { rol: null, headers: { Authorization: basic(ANALISTA) } });
      assert.equal(res.status, 400);
      assert.equal(res.headers.getSetCookie().length, 0);
    });

    test("sin credenciales responde 401 SIN abrir la ventana del navegador", async () => {
      const res = await ctx.app.get("/api/acceso", { rol: null, headers: PAGINA });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("www-authenticate"), null);
    });

    test("credenciales incorrectas → 401, sin ventana del navegador y sin cookie", async () => {
      const { res, setCookie } = await entrar(ctx.app, { user: ANALISTA.user, pass: "no-es" });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("www-authenticate"), null);
      assert.equal(setCookie, null);
      assert.match((await res.json()).error, /incorrectos/);
    });

    test("credenciales correctas → 200 con el rol y una cookie protegida", async () => {
      const { res, setCookie } = await entrar(ctx.app, ANALISTA);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { autenticado: true, rol: "analista", usuario: "analista" });
      assert.match(setCookie, /^poli_sesion=[A-Za-z0-9_-]{40,}; /);
      for (const atributo of ["HttpOnly", "SameSite=Strict", "Path=/"]) { assert.ok(setCookie.includes(atributo), `falta ${atributo} en: ${setCookie}`); }
      assert.match(setCookie, /Max-Age=\d+/);
      assert.ok(!setCookie.includes("Secure"), "sin HTTPS no debe marcarse Secure (el navegador la descartaría)");
      assert.ok(!setCookie.includes(ANALISTA.pass), "la cookie no contiene la contraseña");
    });

    test("cada inicio de sesión recibe una cookie distinta", async () => {
      const a = await entrar(ctx.app, ANALISTA);
      const b = await entrar(ctx.app, ANALISTA);
      assert.notEqual(a.cookie, b.cookie);
    });
  });

  describe("con la sesión abierta", () => {
    test("el analista ve el histórico sin reenviar la contraseña, pero no /api/status", async () => {
      const { cookie } = await entrar(ctx.app, ANALISTA);
      assert.equal((await conCookie(ctx.app, "/api/historico/resumen", cookie)).status, 200);
      assert.equal((await conCookie(ctx.app, "/api/historico?formato=json", cookie)).status, 200);
      assert.equal((await conCookie(ctx.app, "/api/status", cookie)).status, 403);
    });

    test("el administrador ve también /api/status", async () => {
      const { cookie } = await entrar(ctx.app, ADMIN);
      assert.equal((await conCookie(ctx.app, "/api/status", cookie)).status, 200);
    });

    test("/api/sesion dice quién es", async () => {
      const { cookie } = await entrar(ctx.app, ANALISTA);
      assert.deepEqual(await (await conCookie(ctx.app, "/api/sesion", cookie)).json(), { autenticado: true, rol: "analista", usuario: "analista" });
    });

    test("una petición de la página sin sesión recibe 401 sin abrir la ventana del navegador", async () => {
      const res = await ctx.app.get("/api/historico/resumen", { rol: null, headers: PAGINA });
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("www-authenticate"), null);
    });

    test("las herramientas siguen entrando con usuario y contraseña, sin sesión", async () => {
      assert.equal((await ctx.app.get("/api/historico/resumen", { rol: ANALISTA })).status, 200);
    });
  });

  describe("cerrar sesión", () => {
    test("solo se acepta si la petición viene de la página", async () => {
      const { cookie } = await entrar(ctx.app, ANALISTA);
      assert.equal((await conCookie(ctx.app, "/api/salir", cookie)).status, 400);
      assert.equal((await (await conCookie(ctx.app, "/api/sesion", cookie)).json()).autenticado, true, "la sesión no debe cerrarse");
    });

    test("borra la cookie del navegador", async () => {
      const { cookie } = await entrar(ctx.app, ANALISTA);
      const res = await conCookie(ctx.app, "/api/salir", cookie, PAGINA);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { autenticado: false });
      assert.match(res.headers.getSetCookie()[0], /^poli_sesion=; .*Max-Age=0/);
    });

    test("y la destruye en el servidor: la cookie vieja ya no sirve aunque alguien la haya copiado", async () => {
      const { cookie } = await entrar(ctx.app, ADMIN);
      assert.equal((await conCookie(ctx.app, "/api/status", cookie)).status, 200);
      await conCookie(ctx.app, "/api/salir", cookie, PAGINA);
      assert.equal((await conCookie(ctx.app, "/api/status", cookie)).status, 401);
      assert.equal((await conCookie(ctx.app, "/api/historico/resumen", cookie)).status, 401);
      assert.deepEqual(await (await conCookie(ctx.app, "/api/sesion", cookie)).json(), { autenticado: false });
    });

    test("cerrar sesión sin tener sesión no da error", async () => {
      const res = await ctx.app.get("/api/salir", { rol: null, headers: PAGINA });
      assert.equal(res.status, 200);
    });

    test("cerrar una sesión no cierra las de otras personas", async () => {
      const a = await entrar(ctx.app, ANALISTA);
      const b = await entrar(ctx.app, ANALISTA);
      await conCookie(ctx.app, "/api/salir", a.cookie, PAGINA);
      assert.equal((await conCookie(ctx.app, "/api/historico/resumen", b.cookie)).status, 200);
    });
  });

  describe("lo que queda en los logs", () => {
    test("se registra quién entra y sale, pero nunca el valor de la cookie ni la contraseña", async () => {
      const { cookie } = await entrar(ctx.app, ANALISTA);
      await conCookie(ctx.app, "/api/salir", cookie, PAGINA);
      const entrada = await ctx.app.esperarLog("auth_login");
      assert.equal(entrada.rol, "analista");
      await ctx.app.esperarLog("auth_logout");
      const todo = JSON.stringify(ctx.app.logs);
      assert.ok(!todo.includes(cookie.split("=")[1]), "el valor de la cookie no debe estar en los logs");
      assert.ok(!todo.includes(ANALISTA.pass));
    });
  });
});

describe("Sesión: caducidad", () => {
  const ctx = escenario({ SESSION_TTL_MS: "1000" });

  test("la sesión caduca sola pasado el tiempo configurado", async () => {
    const { cookie, setCookie } = await entrar(ctx.app, ANALISTA);
    assert.match(setCookie, /Max-Age=1(;|$)/);
    assert.equal((await conCookie(ctx.app, "/api/historico/resumen", cookie)).status, 200);
    await dormir(1300);
    assert.equal((await conCookie(ctx.app, "/api/historico/resumen", cookie)).status, 401);
  });
});

describe("Sesión: detrás de un proxy con HTTPS", () => {
  const ctx = escenario({ TRUST_PROXY: "true" });

  test("la cookie se marca Secure cuando el proxy dice que la conexión era HTTPS", async () => {
    const { setCookie } = await entrar(ctx.app, ANALISTA, { "X-Forwarded-For": "198.51.100.5", "X-Forwarded-Proto": "https" });
    assert.ok(setCookie.includes("Secure"));
  });

  test("y no se marca Secure cuando era HTTP", async () => {
    const { setCookie } = await entrar(ctx.app, ANALISTA, { "X-Forwarded-For": "198.51.100.6", "X-Forwarded-Proto": "http" });
    assert.ok(!setCookie.includes("Secure"));
  });
});

describe("Sesión: sin contraseñas configuradas", () => {
  const ctx = escenario({ ANALYST_PASSWORD_HASH: "", ADMIN_PASSWORD_HASH: "" });

  test("no se puede iniciar sesión: 403 y sin cookie", async () => {
    const { res, setCookie } = await entrar(ctx.app, ANALISTA);
    assert.equal(res.status, 403);
    assert.equal(setCookie, null);
  });

  test("/api/sesion sigue siendo público", async () => {
    assert.equal((await ctx.app.get("/api/sesion", { rol: null })).status, 200);
  });
});

describe("Sesión: protección contra adivinar contraseñas", () => {
  const ctx = escenario({ AUTH_FAIL_MAX: "3", TRUST_PROXY: "true", RATE_LIMIT_MAX: "500", RATE_LIMIT_MAX_API: "500" });

  test("el formulario de la página también bloquea tras varios fallos, aunque luego acierte", async () => {
    const ip = { "X-Forwarded-For": "203.0.113.50" };
    for (let i = 0; i < 3; i += 1) { assert.equal((await entrar(ctx.app, { user: ANALISTA.user, pass: "no-es" }, ip)).res.status, 401); }
    const { res, setCookie } = await entrar(ctx.app, ANALISTA, ip);
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get("retry-after")) >= 1);
    assert.equal(setCookie, null);
  });
});
