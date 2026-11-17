import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import {
  COMMAND_CHANNEL,
  READY_CHANNEL,
  REQUEST_CHANNEL,
  RESPONSE_CHANNEL,
  SELECT_CHANNEL,
  STATE_CHANNEL,
  VIEW_COMMAND_CHANNEL,
  type AppState,
  type CanvasBridge,
  type RendererRequest,
  type ViewCommand,
} from "../shared/ipc.ts";

const mode: CanvasBridge["mode"] = window.location.hash === "#stage" ? "stage" : "editor";

function subscribe<T>(channel: string, listener: (value: T) => void) {
  const wrapped = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

const bridge: CanvasBridge = {
  mode,
  onState: (listener) => subscribe<AppState>(STATE_CHANNEL, listener),
  onViewCommand: (listener) => subscribe<ViewCommand>(VIEW_COMMAND_CHANNEL, listener),
  onRequest: (handler) =>
    subscribe<{ id: number; request: RendererRequest }>(REQUEST_CHANNEL, async ({ id, request }) => {
      try {
        const value = await handler(request);
        ipcRenderer.send(RESPONSE_CHANNEL, { id, ok: true, value });
      } catch (error) {
        ipcRenderer.send(RESPONSE_CHANNEL, {
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  ready: () => ipcRenderer.send(READY_CHANNEL),
  select: (ids) => ipcRenderer.send(SELECT_CHANNEL, ids.filter((id) => typeof id === "string")),
  command: (command) => ipcRenderer.send(COMMAND_CHANNEL, command),
};

contextBridge.exposeInMainWorld("canvasBridge", bridge);
