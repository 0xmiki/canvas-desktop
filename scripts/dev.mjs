// Dev loop: Vite serves the renderer with HMR, tsdown rebuilds main/preload,
// and Electron restarts whenever the main bundle changes.
import { build } from "tsdown";
import { createServer } from "vite";

import { launchElectron, rootDir } from "./electron.mjs";

const vite = await createServer({ root: rootDir, configFile: `${rootDir}/vite.config.ts` });
await vite.listen();
const url = vite.resolvedUrls?.local[0] ?? "http://localhost:5199/";
console.log(`[dev] renderer at ${url}`);

let electron = null;
let restarting = false;
let restartTimer;

function start() {
  electron = launchElectron({ VITE_DEV_SERVER_URL: url.replace(/\/$/, "") }, process.argv.slice(2));
  electron.on("exit", (code) => {
    electron = null;
    if (!restarting) shutdown(code ?? 0);
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

async function shutdown(code) {
  await vite.close();
  process.exit(code);
}

process.on("SIGINT", () => {
  electron?.kill();
  void shutdown(0);
});

await build({
  config: `${rootDir}/tsdown.config.ts`,
  watch: true,
  logLevel: "warn",
  // Fires once per bundle (main, preload); debounce into a single restart.
  onSuccess: () => {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      console.log("[dev] main/preload built");
      restart();
    }, 200);
  },
});
