import * as http from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { SERVER_INSTRUCTIONS } from "./guide.ts";
import { registerTools, type CanvasHost } from "./tools.ts";

export const DEFAULT_MCP_PORT = 4590;
const MAX_BODY_BYTES = 20 * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/**
 * Streamable HTTP MCP endpoint on localhost. Stateless: each request gets a
 * fresh server/transport pair over the shared canvas host, so any number of
 * agents can connect at once and reconnects are free.
 */
export function startMcpServer(
  host: CanvasHost,
  port: number,
  version: string,
): Promise<{ url: string; close: () => void }> {
  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Only accept local browser-less clients: reject cross-site browser requests (DNS rebinding / CSRF).
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      sendJson(res, 403, { error: "Forbidden origin" });
      return;
    }
    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true, name: "canvas", version });
      return;
    }
    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "Not found. The MCP endpoint is /mcp" });
      return;
    }
    if (req.method !== "POST") {
      // Stateless server: no standalone SSE stream or session teardown.
      sendJson(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
      return;
    }
    try {
      const body = await readBody(req);
      const server = new McpServer({ name: "canvas", version }, { instructions: SERVER_INSTRUCTIONS });
      registerTools(server, host);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error("[canvas] MCP request failed", error);
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: error instanceof Error ? error.message : "Internal error" },
          id: null,
        });
      }
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve({ url: `http://127.0.0.1:${port}/mcp`, close: () => httpServer.close() });
    });
  });
}
