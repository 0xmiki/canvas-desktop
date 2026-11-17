import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Production CSP. Dev skips it because Vite's HMR client needs inline scripts and websockets.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com canvas-asset:",
  "img-src * data: blob: canvas-asset:",
  "connect-src 'self' canvas-asset: data:",
].join("; ");

const contentSecurityPolicy = (): Plugin => ({
  name: "canvas-csp",
  apply: "build",
  transformIndexHtml: (html) =>
    html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
});

export default defineConfig({
  base: "./",
  plugins: [react(), contentSecurityPolicy()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome130",
  },
  server: {
    port: 5199,
    strictPort: true,
  },
});
