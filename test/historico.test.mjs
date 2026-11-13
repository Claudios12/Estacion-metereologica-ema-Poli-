// Seam A · Servidor por HTTP — el recolector guarda y /api/historico lo devuelve.
// La base se verifica solo a través de la interfaz pública (/api/historico, /api/status), no leyéndola.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { fakeWeatherLink, arrancar, esperar, carpetaTemporal, payload, LECTURA_FIJA } from "./helpers.mjs";

const MIN = 60_000;
const DIA = "desde=2026-11-10&hasta=2026-11-10";

/** Arranca el servidor sobre una base, espera a que el recolector procese la lectura y ejecuta `fn`. */
async function sesion(wl, dbFile, fn, extraEnv = {}) {
  const app = await arrancar({ WEATHERLINK_BASE_URL: wl.url, DB_FILE: dbFile, ...extraEnv });
  try {
    await esperar(() => app.logs.find((l) => l.msg === "db_lectura_guardada" || l.msg === "db_lectura_duplicada"), 6_000);
    return await fn(app);
  } finally {
    await app.detener();
  }
}

const lecturas = (app, rango = DIA) => app.json(`/api/historico?tipo=lecturas&formato=json&${rango}`);
const pronosticos = (app, rango = DIA) => app.json(`/api/historico?tipo=pronosticos&formato=json&${rango}`);

describe("El recolector guarda lo que la estación reporta", () => {
  let wl, tmp;
  before(async () => { wl = await fakeWeatherLink(); tmp = carpetaTemporal(); });
  after(async () => { await wl.close(); tmp.limpiar(); });

  test("guarda la lectura sin que nadie abra la página, en hora de Bogotá y con el viento en km/h", async () => {
    await sesion(wl, tmp.dbFile, async (app) => {
      assert.equal(wl.estado.hits, 1, "el recolector debió consultar a WeatherLink por su cuenta");
      const h = await lecturas(app);
      assert.equal(h.filas, 1);
      assert.equal(h.zonaHoraria, "America/Bogota");
      assert.deepEqual(h.datos[0], {
        hora_bogota: "2026-11-10 00:21:00",
        temperatura_c: 10.8, sensacion_c: 10.7, max_dia_c: 10.9, min_dia_c: 10.7,
        humedad_pct: 76.4,
        viento_kmh: 6.5, rafaga_kmh: 19.4, viento_dir_grados: 172,
        presion_mmhg: 758.1, tendencia_presion: "Falling Slowly",
        lluvia_dia_mm: 0, lluvia_temporada_mm: 929
      });
    });
  });

  test("/api/historico/resumen entrega lo que necesita la página del analista", async () => {
    await sesion(wl, tmp.dbFile, async (app) => {
      const res = await app.get("/api/historico/resumen");
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        lecturas: 1, pronosticos: 4,
        primera: "2026-11-10T05:21:00.000Z", ultima: "2026-11-10T05:21:00.000Z",
        intervaloS: 300
      });
    });
  });

  test("/api/status cuenta lo guardado", async () => {
    await sesion(wl, tmp.dbFile, async (app) => {
      const { database } = await app.json("/api/status");
      assert.equal(database.enabled, true);
      assert.equal(database.lecturas, 1);
      assert.equal(database.pronosticos, 4);
      assert.equal(database.errors, 0);
    });
  });

  test("la misma lectura vista otra vez no se duplica", async () => {
    await sesion(wl, tmp.dbFile, async (app) => {
      assert.ok(app.logs.some((l) => l.msg === "db_lectura_duplicada"));
      assert.equal((await lecturas(app)).filas, 1);
    });
  });

  test("una lectura nueva se suma al histórico en orden cronológico", async () => {
    wl.estado.body = payload({ lastReceived: LECTURA_FIJA + 5 * MIN, temperature: "11.2" });
    await sesion(wl, tmp.dbFile, async (app) => {
      const h = await lecturas(app);
      assert.deepEqual(h.datos.map((d) => [d.hora_bogota, d.temperatura_c]), [
        ["2026-11-10 00:21:00", 10.8],
        ["2026-11-10 00:26:00", 11.2]
      ]);
    });
  });
});

describe("Los días del histórico son días de Bogotá", () => {
  let wl, tmp;
  before(async () => { wl = await fakeWeatherLink(); tmp = carpetaTemporal(); });
  after(async () => { await wl.close(); tmp.limpiar(); });

  test("23:59 del 9 de noviembre pertenece al día 9 y 00:00 del 10 al día 10", async () => {
    const antes = Date.UTC(2026, 10, 10, 4, 59);   // 23:59 del 9 en Bogotá
    const despues = Date.UTC(2026, 10, 10, 5, 0);  // 00:00 del 10 en Bogotá
    for (const t of [antes, despues]) {
      wl.estado.body = payload({ lastReceived: t });
      await sesion(wl, tmp.dbFile, async () => {});
    }
    await sesion(wl, tmp.dbFile, async (app) => {
      const dia9 = await lecturas(app, "desde=2026-11-09&hasta=2026-11-09");
      const dia10 = await lecturas(app, "desde=2026-11-10&hasta=2026-11-10");
      assert.deepEqual(dia9.datos.map((d) => d.hora_bogota), ["2026-11-09 23:59:00"]);
      assert.deepEqual(dia10.datos.map((d) => d.hora_bogota), ["2026-11-10 00:00:00"]);
    });
  });
});

describe("El pronóstico se archiva por versiones", () => {
  let wl, tmp;
  before(async () => { wl = await fakeWeatherLink(); tmp = carpetaTemporal(); });
  after(async () => { await wl.close(); tmp.limpiar(); });

  test("guarda los cuatro tramos con nombres en español", async () => {
    await sesion(wl, tmp.dbFile, async (app) => {
      const { datos } = await pronosticos(app);
      assert.deepEqual(datos.map((d) => [d.tramo, d.temperatura_c, d.prob_lluvia_pct, d.descripcion]), [
        ["mañana", 18, 21, "Cloudy"],
        ["tarde", 17, 44, "Drizzle"],
        ["noche", 10, 0, "Mostly Clear"],
        ["madrugada", 9, 28, "Drizzle"]
      ]);
      assert.ok(datos.every((d) => d.fecha === "2026-11-10"));
    });
  });

  test("el mismo pronóstico visto otra vez no crea versiones nuevas", async () => {
    await sesion(wl, tmp.dbFile, async (app) => {
      assert.equal((await pronosticos(app)).filas, 4);
    });
  });

  test("si cambia un tramo, se conserva la versión anterior y se suma la nueva", async () => {
    const p = payload({ lastReceived: LECTURA_FIJA + 5 * MIN });
    p.forecastOverview[0].afternoon.chanceofrain = 60;
    wl.estado.body = p;
    await sesion(wl, tmp.dbFile, async (app) => {
      const { datos } = await pronosticos(app);
      assert.equal(datos.length, 5);
      assert.deepEqual(datos.filter((d) => d.tramo === "tarde").map((d) => d.prob_lluvia_pct).sort(), [44, 60]);
    });
  });
});

describe("Exportación en CSV para Excel", () => {
  let wl, tmp;
  before(async () => { wl = await fakeWeatherLink(); tmp = carpetaTemporal(); });
  after(async () => { await wl.close(); tmp.limpiar(); });

  test("lecturas: UTF-8 con BOM, filas separadas por CRLF y nombre de archivo descriptivo", async () => {
    await sesion(wl, tmp.dbFile, async (app) => {
      const res = await app.get(`/api/historico?tipo=lecturas&${DIA}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
      assert.equal(res.headers.get("content-disposition"), 'attachment; filename="poli-clima_lecturas_2026-11-10_a_2026-11-10.csv"');
      const bytes = new Uint8Array(await res.arrayBuffer());
      assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "debe empezar con BOM UTF-8");
      const lineas = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes).replace(/^﻿/, "").split("\r\n");
      assert.equal(lineas[0], "hora_bogota,temperatura_c,sensacion_c,max_dia_c,min_dia_c,humedad_pct,viento_kmh,rafaga_kmh,viento_dir_grados,presion_mmhg,tendencia_presion,lluvia_dia_mm,lluvia_temporada_mm");
      assert.equal(lineas[1], "2026-11-10 00:21:00,10.8,10.7,10.9,10.7,76.4,6.5,19.4,172,758.1,Falling Slowly,0,929");
      assert.equal(lineas[2], "", "el archivo termina con salto de línea");
    });
  });

  test("un texto que empieza por = se neutraliza para que Excel no lo ejecute como fórmula", async () => {
    const p = payload({ lastReceived: LECTURA_FIJA + 10 * MIN });
    p.forecastOverview[0].morning.weatherDesc = "=1+1";
    wl.estado.body = p;
    await sesion(wl, tmp.dbFile, async (app) => {
      const csv = await (await app.get(`/api/historico?tipo=pronosticos&${DIA}`)).text();
      assert.ok(csv.includes(",'=1+1,"), "la celda debe llevar un apóstrofo delante");
      assert.ok(!csv.includes(",=1+1,"), "no debe quedar la fórmula sin neutralizar");
    });
  });
});

describe("GET /api/historico · peticiones inválidas", () => {
  let wl, tmp, app;
  before(async () => {
    wl = await fakeWeatherLink();
    tmp = carpetaTemporal();
    app = await arrancar({ WEATHERLINK_BASE_URL: wl.url, DB_FILE: tmp.dbFile });
  });
  after(async () => { await app.detener(); await wl.close(); tmp.limpiar(); });

  const malas = [
    ["una fecha que no es AAAA-MM-DD", "desde=10-11-2026", /AAAA-MM-DD/],
    ["un día que no existe", "desde=2026-02-30&hasta=2026-02-30", /AAAA-MM-DD/],
    ["un rango al revés", "desde=2026-11-10&hasta=2026-11-09", /anterior/],
    ["un rango de 32 días", "desde=2026-10-01&hasta=2026-11-01", /31 días/],
    ["un parámetro desconocido", "desde=2026-11-10&usuario=admin", /usuario/],
    ["un tipo desconocido", "tipo=usuarios", /tipo/],
    ["un formato desconocido", "formato=xml", /formato/]
  ];
  for (const [nombre, consulta, mensaje] of malas) {
    test(`rechaza con 400 ${nombre}`, async () => {
      const res = await app.get(`/api/historico?${consulta}`);
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, mensaje);
    });
  }

  test("acepta justo 31 días", async () => {
    const res = await app.get("/api/historico?desde=2026-10-01&hasta=2026-10-31&formato=json");
    assert.equal(res.status, 200);
  });

  test("sin parámetros entrega el día de hoy en CSV", async () => {
    const res = await app.get("/api/historico");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/csv/);
  });
});

describe("GET /api/historico · base de datos desactivada", () => {
  let wl, app;
  before(async () => {
    wl = await fakeWeatherLink();
    app = await arrancar({ WEATHERLINK_BASE_URL: wl.url, DB_ENABLED: "false" });
  });
  after(async () => { await app.detener(); await wl.close(); });

  test("avisa con 503 en lugar de fingir que no hay datos", async () => {
    const res = await app.get("/api/historico");
    assert.equal(res.status, 503);
  });
});
