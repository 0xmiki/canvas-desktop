import { defineConfig } from "tsdown";

// Main and preload are bundled to CommonJS for Electron. The sandboxed
// preload must be self-contained, so it is built as its own entry.
const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  platform: "node" as const,
  target: "node22",
  sourcemap: true,
  dts: false,
  outExtensions: () => ({ js: ".cjs" }),
};

export default defineConfig([
  {
    ...shared,
    entry: { main: "src/main/main.ts" },
    clean: true,
    deps: { neverBundle: ["electron"] },
  },
  {
    ...shared,
    entry: { preload: "src/preload/preload.ts" },
    deps: { neverBundle: ["electron"] },
  },
]);
