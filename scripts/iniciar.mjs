// Lanzador de Poli Clima: encuentra un Node.js compatible (22.13 o superior), arranca el servidor,
// abre la página en el navegador y explica en español qué hacer si algo falla.
//
// Corre con cualquier Node 18+, incluso uno viejo: su trabajo es justamente encontrar uno nuevo.
//
// Uso:   node scripts/iniciar.mjs [--no-abrir]        (en Windows: doble clic en iniciar.cmd)
// Variables: POLI_NODE=<ruta a node.exe>  fuerza qué Node usar · NO_ABRIR=1  no abre el navegador
//
// Es una comodidad para equipos de escritorio. En un servidor (systemd, Docker, NSSM) se ejecuta
// directamente `node server.mjs`, como indica docs/OPERACION.md.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MINIMO = [22, 13, 0];
const raiz = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const windows = process.platform === "win32";
const abrirNavegador = !process.argv.includes("--no-abrir") && !process.env.NO_ABRIR;

const dice = (texto = "") => console.log(texto);
const parseVersion = (v) => String(v).trim().replace(/^v/, "").split(".").map((n) => Number.parseInt(n, 10) || 0);
const comparar = (a, b) => { for (let i = 0; i < 3; i += 1) { if ((a[i] ?? 0) !== (b[i] ?? 0)) { return (a[i] ?? 0) - (b[i] ?? 0); } } return 0; };
const esSuficiente = (v) => v && comparar(v, MINIMO) >= 0;

function versionDe(exe) {
  try {
    const r = spawnSync(exe, ["-p", "process.versions.node"], { encoding: "utf8", timeout: 8_000, windowsHide: true });
    return r.status === 0 ? parseVersion(r.stdout) : null;
  } catch { return null; }
}

function subcarpetas(dir, filtro) {
  try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && filtro.test(e.name)).map((e) => join(dir, e.name)); } catch { return []; }
}

/** Rutas donde suele haber instalaciones de Node, además del Node que ejecuta este lanzador. */
function candidatos() {
  const lista = [];
  if (process.env.POLI_NODE) { lista.push(process.env.POLI_NODE); }
  lista.push(process.execPath);
  const e = process.env;
  if (windows) {
    const nvm = [e.NVM_HOME, e.LOCALAPPDATA && join(e.LOCALAPPDATA, "nvm"), e.APPDATA && join(e.APPDATA, "nvm"), "C:\\nvm4w"].filter(Boolean);
    for (const base of nvm) { for (const d of subcarpetas(base, /^v\d/)) { lista.push(join(d, "node.exe")); } }
    for (const base of [e.ProgramFiles, e["ProgramFiles(x86)"], e.LOCALAPPDATA && join(e.LOCALAPPDATA, "Programs")].filter(Boolean)) {
      lista.push(join(base, "nodejs", "node.exe"));
    }
  } else {
    const casa = homedir();
    for (const base of [join(casa, ".nvm", "versions", "node"), join(casa, ".local", "share", "fnm", "node-versions")]) {
      for (const d of subcarpetas(base, /^v\d/)) { lista.push(join(d, "bin", "node"), join(d, "installation", "bin", "node")); }
    }
    lista.push("/usr/local/bin/node", "/usr/bin/node", "/opt/homebrew/bin/node");
  }
  return [...new Set(lista)].filter((p) => existsSync(p));
}

function elegirNode() {
  let mejor = null;
  for (const exe of candidatos()) {
    const v = exe === process.execPath ? parseVersion(process.versions.node) : versionDe(exe);
    if (esSuficiente(v) && (!mejor || comparar(v, mejor.version) > 0)) { mejor = { exe, version: v }; }
  }
  return mejor;
}

const node = elegirNode();
dice("");
dice("  Poli Clima");
dice("  ----------");

if (!node) {
  dice(`  No encontré un Node.js compatible. Poli Clima necesita Node ${MINIMO[0]}.${MINIMO[1]} o superior`);
  dice(`  y esta computadora tiene Node ${process.versions.node}.`);
  dice("");
  dice("  Cómo arreglarlo (elija una):");
  dice("    - Con nvm:   nvm install 24      y luego      nvm use 24");
  dice("    - Sin nvm:   instale Node.js 24 LTS desde https://nodejs.org");
  dice("  Después vuelva a abrir este lanzador.");
  dice("");
  process.exit(1);
}

const versionTexto = node.version.join(".");
dice(`  Usando Node ${versionTexto}${node.exe === process.execPath ? "" : `  (${node.exe})`}`);

// ---------- Arranque del servidor ----------

const archivoEnv = join(raiz, ".env");
const textoEnv = existsSync(archivoEnv) ? readFileSync(archivoEnv, "utf8") : "";
const args = [...(textoEnv ? ["--env-file=.env"] : []), "server.mjs"];

// Si la persona fijó el puerto a propósito (variable PORT o línea PORT= en .env), se respeta: no se busca otro.
const puertoElegido = process.env.PORT || /^\s*PORT\s*=\s*(\d+)/m.exec(textoEnv)?.[1];
const PUERTO_BASE = Number(puertoElegido) || 8080;
const MAX_PUERTOS_EXTRA = 10;

// Ctrl+C llega a todo el grupo de procesos: el servidor se apaga solo; este lanzador solo espera a que termine.
process.on("SIGINT", () => {});

function abrir(destino) {
  try {
    const [cmd, cmdArgs] = windows ? ["cmd", ["/c", "start", "", destino]]
      : process.platform === "darwin" ? ["open", [destino]] : ["xdg-open", [destino]];
    spawn(cmd, cmdArgs, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch { /* el usuario puede abrir la dirección a mano */ }
}

/** ¿Lo que responde en ese puerto es otra copia de Poli Clima? (/api/sesion es pública y propia de esta aplicación) */
async function esPoliClima(puerto) {
  try {
    const r = await fetch(`http://127.0.0.1:${puerto}/api/sesion`, { signal: AbortSignal.timeout(2_000) });
    const cuerpo = await r.json();
    return typeof cuerpo?.autenticado === "boolean";
  } catch { return false; }
}

async function puertoOcupadoEn(puerto, intento) {
  dice("");
  if (await esPoliClima(puerto)) {
    const destino = `http://localhost:${puerto}`;
    dice(`  Poli Clima ya está funcionando en ${destino}. No hace falta abrirlo otra vez.`);
    if (abrirNavegador) { dice("  Abriendo la página en el navegador…"); abrir(destino); }
    dice("  Puede cerrar esta ventana.");
    dice("");
    process.exit(0);
  }
  if (!puertoElegido && intento < MAX_PUERTOS_EXTRA) {
    dice(`  El puerto ${puerto} lo está usando otro programa. Probando con el ${puerto + 1}…`);
    return arrancar(puerto + 1, intento + 1);
  }
  dice(`  El puerto ${puerto} lo está usando otro programa.`);
  dice(puertoElegido
    ? "  Cambie PORT en el archivo .env (o en la variable de entorno) por un puerto libre, por ejemplo 8081."
    : `  No encontré un puerto libre entre ${PUERTO_BASE} y ${PUERTO_BASE + MAX_PUERTOS_EXTRA}. Cierre el programa que usa el ${PUERTO_BASE}.`);
  dice(`  Para ver qué programa lo usa (en cmd):  netstat -ano | findstr :${puerto}`);
  dice("");
  process.exit(1);
}

function arrancar(puerto, intento) {
  let url = null;
  let puertoOcupado = false;
  let nodeSinSqlite = false;

  // En el primer intento el servidor decide su puerto (por defecto 8080 o el de .env); solo los siguientes lo fuerzan.
  const env = intento > 0 ? { ...process.env, PORT: String(puerto) } : process.env;
  const hijo = spawn(node.exe, args, { cwd: raiz, env, stdio: ["inherit", "pipe", "pipe"], windowsHide: false });

  function procesarLinea(linea) {
    let evento;
    try { evento = JSON.parse(linea); } catch { evento = null; }
    // El error "puerto ocupado" se explica abajo en español: no se muestra la línea técnica.
    if (evento?.msg === "server_error" && evento.code === "EADDRINUSE") { puertoOcupado = true; return; }
    console.log(linea);
    if (!evento) { return; }
    if (evento.msg === "server_started" && !url) {
      url = evento.url;
      dice("");
      dice(`  Listo: ${url}`);
      dice("  Para detenerlo, cierre esta ventana o presione Ctrl+C.");
      dice("");
      if (abrirNavegador) { abrir(url); }
    }
    if (evento.msg === "auth_not_configured") {
      dice("  El histórico para analistas está CERRADO porque aún no hay contraseña. Para abrirlo, en otra ventana:");
      dice("      npm run crear-clave -- analista");
      dice("  y vuelva a abrir este lanzador. (El clima de la página funciona igual sin esto.)");
      dice("");
    }
    if (evento.msg === "startup_aborted" && /node:sqlite/.test(String(evento.reason))) { nodeSinSqlite = true; }
  }

  for (const flujo of [hijo.stdout, hijo.stderr]) {
    let resto = "";
    flujo.setEncoding("utf8");
    flujo.on("data", (trozo) => {
      resto += trozo;
      let i;
      while ((i = resto.indexOf("\n")) >= 0) { const l = resto.slice(0, i).trimEnd(); resto = resto.slice(i + 1); if (l) { procesarLinea(l); } }
    });
    flujo.on("end", () => { if (resto.trim()) { procesarLinea(resto.trim()); } });
  }

  hijo.on("error", (e) => { dice(`  No se pudo iniciar el servidor: ${e.message}`); process.exit(1); });

  hijo.on("exit", (codigo, senal) => {
    if (codigo === 0 || senal === "SIGINT" || senal === "SIGTERM") { process.exit(0); }
    if (puertoOcupado) { return puertoOcupadoEn(puerto, intento); }
    dice("");
    dice("  El servidor se detuvo con un error.");
    if (nodeSinSqlite) {
      dice("  Este Node no incluye node:sqlite. Instale Node 22.13 o superior.");
    } else {
      dice("  Lea la línea con \"level\":\"fatal\" más arriba: dice qué configuración o recurso falló.");
    }
    dice("");
    process.exit(codigo ?? 1);
  });
}

arrancar(PUERTO_BASE, 0);
