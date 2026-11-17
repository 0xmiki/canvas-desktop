// Launch Electron on the built main bundle. Shared by `dev` and `start`.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function launchElectron(extraEnv = {}, args = []) {
  const electronPath = require("electron");
  const env = { ...process.env, ...extraEnv };
  // Inherited from some tool runners; it would make Electron behave as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  return spawn(electronPath, [rootDir, ...args], { cwd: rootDir, env, stdio: "inherit" });
}
