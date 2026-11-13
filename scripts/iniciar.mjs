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
import { existsSync, readdirSync } from "node:fs";
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

const args = [...(existsSync(join(raiz, ".env")) ? ["--env-file=.env"] : []), "server.mjs"];
const hijo = spawn(node.exe, args, { cwd: raiz, stdio: ["inherit", "pipe", "pipe"], windowsHide: false });

// Ctrl+C llega a todo el grupo de procesos: el servidor se apaga solo; este lanzador solo espera a que termine.
process.on("SIGINT", () => {});

let url = null;
let puertoOcupado = null;
let nodeSinSqlite = false;

function abrir(destino) {
  try {
    const [cmd, cmdArgs] = windows ? ["cmd", ["/c", "start", "", destino]]
      : process.platform === "darwin" ? ["open", [destino]] : ["xdg-open", [destino]];
    spawn(cmd, cmdArgs, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch { /* el usuario puede abrir la dirección a mano */ }
}

function procesarLinea(linea) {
  console.log(linea);
  let evento;
  try { evento = JSON.parse(linea); } catch { return; }
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
  if (evento.msg === "server_error" && evento.code === "EADDRINUSE") { puertoOcupado = true; }
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
  dice("");
  dice("  El servidor se detuvo con un error.");
  if (puertoOcupado) {
    dice("  El puerto ya está en uso: probablemente Poli Clima ya está abierto en otra ventana.");
    dice("  Ciérrela, o use otro puerto (en Windows:  set PORT=8081  y vuelva a abrir el lanzador).");
  } else if (nodeSinSqlite) {
    dice("  Este Node no incluye node:sqlite. Instale Node 22.13 o superior.");
  } else {
    dice("  Lea la línea con \"level\":\"fatal\" más arriba: dice qué configuración o recurso falló.");
  }
  dice("");
  process.exit(codigo ?? 1);
});
