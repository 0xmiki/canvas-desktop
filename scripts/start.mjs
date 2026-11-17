import { launchElectron } from "./electron.mjs";

const child = launchElectron({}, process.argv.slice(2));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
