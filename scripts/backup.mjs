// Respaldo de la base de datos de Poli Clima (SQLite).
//
// Hace una copia consistente con VACUUM INTO: es seguro con el servidor encendido (la base usa modo WAL),
// a diferencia de copiar el archivo a mano, que puede dejar una copia corrupta.
//
// Uso:   node scripts/backup.mjs                          → copia a ./backups, conserva las 14 últimas
//        node scripts/backup.mjs --dir D:\respaldos --keep 30
//        DB_FILE=/var/lib/poli-clima/poli-clima.db node scripts/backup.mjs
// Programarlo: cron (Linux) o el Programador de tareas (Windows), una vez al día.
// Requiere Node.js 22.13 o superior (módulo integrado node:sqlite).

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const process_ = globalThis.process;
const emitWarning = process_.emitWarning;
process_.emitWarning = function (warning, ...args) {
  const type = typeof args[0] === "string" ? args[0] : args[0]?.type;
  if (type === "ExperimentalWarning" && /SQLite/i.test(String(warning))) { return; }
  return emitWarning.call(process_, warning, ...args);
};

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function fail(msg) {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "backup_failed", detail: msg }));
  process_.exit(1);
}

function args(argv) {
  const out = { dir: resolve(root, "backups"), keep: 14 };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === "--dir" && v) { out.dir = resolve(v); }
    else if (k === "--keep" && /^\d+$/.test(v ?? "") && Number(v) >= 1) { out.keep = Number(v); }
    else { fail(`Argumento no válido: ${k} ${v ?? ""}. Use --dir <carpeta> y --keep <n≥1>.`); }
  }
  return out;
}

const { dir, keep } = args(process_.argv.slice(2));
const dbFile = resolve(root, (process_.env.DB_FILE ?? "data/poli-clima.db").trim());
if (!existsSync(dbFile)) { fail(`No existe la base de datos: ${dbFile}`); }

let DatabaseSync;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch {
  fail(`node:sqlite no está disponible en Node ${process_.version}. Use Node.js 22.13 o superior.`);
}

mkdirSync(dir, { recursive: true });
const sello = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const destino = join(dir, `poli-clima_${sello}.db`);
if (existsSync(destino)) { fail(`Ya existe un respaldo con ese nombre: ${destino}`); }

let origen;
let copia;
try {
  origen = new DatabaseSync(dbFile, { readOnly: true });
  origen.exec("PRAGMA busy_timeout = 5000");
  origen.exec(`VACUUM INTO '${destino.replace(/'/g, "''")}'`);
  origen.close();

  // Se comprueba que la copia abre y está íntegra antes de dar el respaldo por bueno.
  copia = new DatabaseSync(destino, { readOnly: true });
  const integridad = copia.prepare("PRAGMA integrity_check").get().integrity_check;
  const { lecturas } = copia.prepare("SELECT COUNT(*) AS lecturas FROM lecturas").get();
  const { pronosticos } = copia.prepare("SELECT COUNT(*) AS pronosticos FROM pronosticos").get();
  copia.close();
  if (integridad !== "ok") { throw new Error(`la copia no pasó la verificación de integridad: ${integridad}`); }

  console.log(JSON.stringify({
    ts: new Date().toISOString(), level: "info", msg: "backup_ok",
    archivo: destino, bytes: statSync(destino).size, lecturas, pronosticos
  }));
} catch (e) {
  try { origen?.close(); } catch { /* ya cerrada */ }
  try { copia?.close(); } catch { /* ya cerrada */ }
  rmSync(destino, { force: true }); // nunca se deja un respaldo a medias
  fail(e.message);
}

// Rotación: se conservan solo los `keep` respaldos más recientes (el sello del nombre ordena por fecha).
const viejos = readdirSync(dir)
  .filter((f) => /^poli-clima_\d{8}-\d{6}\.db$/.test(f))
  .sort()
  .slice(0, -keep);
for (const f of viejos) {
  rmSync(join(dir, f), { force: true });
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg: "backup_rotated", eliminado: f }));
}
