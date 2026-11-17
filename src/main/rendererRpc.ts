import { ipcMain, type IpcMainEvent, type WebContents } from "electron";

import { REQUEST_CHANNEL, RESPONSE_CHANNEL, type RendererRequest } from "../shared/ipc.ts";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

let nextId = 1;
const pending = new Map<number, Pending>();

ipcMain.on(RESPONSE_CHANNEL, (_event: IpcMainEvent, message: unknown) => {
  const { id, ok, value, error } = (message ?? {}) as {
    id?: number;
    ok?: boolean;
    value?: unknown;
    error?: string;
  };
  if (typeof id !== "number") return;
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  if (ok) entry.resolve(value);
  else entry.reject(new Error(error ?? "Renderer request failed"));
});

/** Ask a renderer to do something (measure, rasterize) and wait for its answer. */
export function requestRenderer<T>(
  contents: WebContents,
  request: RendererRequest,
  timeoutMs = 15_000,
): Promise<T> {
  if (contents.isDestroyed()) return Promise.reject(new Error("Canvas window is closed"));
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Renderer did not answer "${request.type}" within ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    contents.send(REQUEST_CHANNEL, { id, request });
  });
}
