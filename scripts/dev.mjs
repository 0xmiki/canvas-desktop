// Dev loop: Vite serves the renderer with HMR, `tsdown --watch` rebuilds
// main/preload, and Electron restarts whenever those bundles change.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createServer } from "vite";

import { launchElectron, rootDir } from "./electron.mjs";

const outDir = path.join(rootDir, "dist-electron");
const bundles = ["main.cjs", "preload.cjs"].map((file) => path.join(outDir, file));

const vite = await createServer({ root: rootDir, configFile: path.join(rootDir, "vite.config.ts") });
await vite.listen();
const url = (vite.resolvedUrls?.local[0] ?? "http://localhost:5199/").replace(/\/$/, "");
console.log(`[dev] renderer at ${url}`);

const tsdown = spawn(process.execPath, [path.join(rootDir, "node_modules/tsdown/dist/run.mjs"), "--watch"], {
  cwd: rootDir,
  stdio: "inherit",
});

let electron = null;
let restarting = false;
let restartTimer;

function start() {
  electron = launchElectron({ VITE_DEV_SERVER_URL: url }, process.argv.slice(2));
  electron.on("exit", (code) => {
    electron = null;
    if (!restarting) void shutdown(code ?? 0);
  });
}

function restart() {
  if (!electron) return start();
  restarting = true;
  electron.once("exit", () => {
    restarting = false;
    start();
  });
  electron.kill();
}

const mtimes = () => bundles.map((file) => (fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0)).join(",");
let seen = "";
// Poll: tsdown cleans the output dir on rebuild, which breaks fs.watch handles.
const poll = setInterval(() => {
  const current = mtimes();
  if (current === seen || current.includes(",0") || current.startsWith("0")) return;
  seen = current;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    console.log("[dev] main/preload built, (re)starting Electron");
    restart();
  }, 250);
}, 200);

async function shutdown(code) {
  clearInterval(poll);
  tsdown.kill();
  await vite.close();
  process.exit(code);
}

process.on("SIGINT", () => {
  electron?.kill();
  void shutdown(0);
});
process.on("SIGTERM", () => {
  electron?.kill();
  void shutdown(0);
});
