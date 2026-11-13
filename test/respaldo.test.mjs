// Seam A · Servidor por HTTP — qué se sirve cuando WeatherLink deja de responder.
// La memoria dura al menos 10 s (CACHE_TTL_MS mínimo), así que estas pruebas son lentas; corren en paralelo.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { fakeWeatherLink, arrancar, entorno, dormir } from "./helpers.mjs";

function escenario(extraEnv) {
  const ctx = {};
  before(async () => {
    ctx.wl = await fakeWeatherLink();
    ctx.app = await arrancar(entorno(ctx.wl, { CACHE_TTL_MS: "10000", ...extraEnv }));
    ctx.primera = await (await ctx.app.get("/api/weather")).text();
    ctx.wl.estado.status = 500; // WeatherLink se cae
    await dormir(10_300);       // la memoria expira
  });
  after(async () => { await ctx.app.detener(); await ctx.wl.close(); });
  return ctx;
}

describe("Cuando WeatherLink se cae después de haber dado datos", { concurrency: true }, () => {
  describe("el último dato bueno todavía es reciente", () => {
    const ctx = escenario({ STALE_MAX_MS: "120000" });

    test("se sigue sirviendo el último dato bueno, marcado como STALE", async () => {
      const res = await ctx.app.get("/api/weather");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-cache"), "STALE");
      assert.equal(await res.text(), ctx.primera);
      assert.ok(ctx.app.logs.some((l) => l.msg === "serving_stale" && l.level === "warn"));
    });

    test("el servicio se declara degradado", async () => {
      await ctx.app.get("/api/weather");
      assert.equal((await ctx.app.json("/api/status")).status, "degraded");
    });
  });

  describe("el último dato bueno ya es demasiado viejo", () => {
    const ctx = escenario({ STALE_MAX_MS: "5000" });

    test("se prefiere decir 502 antes que mostrar un dato demasiado viejo como si sirviera", async () => {
      const res = await ctx.app.get("/api/weather");
      assert.equal(res.status, 502);
    });
  });
});
