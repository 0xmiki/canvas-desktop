import * as path from "node:path";
import { pathToFileURL } from "node:url";

import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  shell,
  type MenuItemConstructorOptions,
} from "electron";

import {
  COMMAND_CHANNEL,
  PROJECT_CHANNEL,
  READY_CHANNEL,
  SELECT_CHANNEL,
  STATE_CHANNEL,
  VIEW_COMMAND_CHANNEL,
  type AppState,
  type McpStatus,
  type ProjectAction,
  type UserCommand,
  type ViewCommand,
} from "../shared/ipc.ts";
import { DOCUMENT_EXTENSION } from "../shared/schema.ts";
import { DocumentStore } from "./documentStore.ts";
import { Workspace } from "./workspace.ts";
import { iconExists, phosphorGlyphsFor, suggestIcons } from "./icons.ts";
import { DEFAULT_MCP_PORT, startMcpServer } from "./mcp/server.ts";
import type { CanvasHost, MeasureResult } from "./mcp/tools.ts";
import { requestRenderer } from "./rendererRpc.ts";
import { createEditorWindow, Stage } from "./windows.ts";

const ASSET_SCHEME = "canvas-asset";
const ASSET_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".bmp", ".ico",
  ".woff", ".woff2", ".ttf", ".otf",
]);

protocol.registerSchemesAsPrivileged([
  { scheme: ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

app.setName("Canvas");
// Separate profile for tests and side-by-side instances. Must precede the
// single-instance lock, which is scoped to the userData directory.
if (process.env.CANVAS_USER_DATA) app.setPath("userData", path.resolve(process.env.CANVAS_USER_DATA));

// Test hook: drive the renderer over the Chrome DevTools Protocol.
if (process.env.CANVAS_DEBUG_PORT) app.commandLine.appendSwitch("remote-debugging-port", process.env.CANVAS_DEBUG_PORT);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void boot();
}

async function boot() {
  await app.whenReady();

  // Images and fonts referenced by local path: canvas-asset://file/<encoded absolute path>.
  protocol.handle(ASSET_SCHEME, (request) => {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname.slice(1));
    if (!path.isAbsolute(filePath) || !ASSET_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(filePath).toString());
  });

  const userData = app.getPath("userData");
  const statePath = path.join(userData, "canvas-state.json");
  const store = new DocumentStore(path.join(userData, `recovery${DOCUMENT_EXTENSION}`), {
    iconExists,
    suggestIcons,
  });
  const stage = new Stage();
  const port = Number(process.env.CANVAS_MCP_PORT) || DEFAULT_MCP_PORT;
  const mcp: McpStatus = { url: `http://127.0.0.1:${port}/mcp`, listening: false, error: null };

  const workspace = new Workspace(
    store,
    statePath,
    path.join(app.getPath("documents"), "Canvas"),
    (file) => shell.trashItem(file),
  );

  // Reopen the last document (and its project), or the untitled recovery copy.
  const fileArg = process.argv.slice(1).find((arg) => arg.endsWith(".json") && !arg.startsWith("-"));
  await workspace.restore(fileArg);

  // Glyphs only change with the document; recompute per document version.
  let glyphCache: { doc: unknown; glyphs: Record<string, string> } = { doc: null, glyphs: {} };
  const glyphsFor = (doc: typeof store.doc) => {
    if (glyphCache.doc !== doc) glyphCache = { doc, glyphs: phosphorGlyphsFor(doc) };
    return glyphCache.glyphs;
  };

  let editor: BrowserWindow | null = null;
  let rendererReady = false;

  const snapshot = (): AppState => ({
    doc: store.doc,
    version: store.version,
    filePath: store.filePath,
    docDir: store.filePath ? path.dirname(store.filePath) : null,
    dirty: store.dirty,
    selection: store.selection,
    mcp,
    activity: store.activity,
    project: workspace.project,
    projects: workspace.projects,
    designs: workspace.designs,
    glyphs: glyphsFor(store.doc),
  });

  let broadcastQueued = false;
  const broadcast = () => {
    if (broadcastQueued) return;
    broadcastQueued = true;
    queueMicrotask(() => {
      broadcastQueued = false;
      if (!editor || editor.isDestroyed() || !rendererReady) return;
      const state = snapshot();
      editor.webContents.send(STATE_CHANNEL, state);
      const name = store.filePath ? path.basename(store.filePath) : "Untitled";
      editor.setTitle(`${name}${store.dirty ? " •" : ""} — Canvas`);
    });
  };

  store.on("change", broadcast);
  workspace.on("change", broadcast);

  const waitForEditor = async () => {
    for (let i = 0; i < 100 && !rendererReady; i++) await new Promise((r) => setTimeout(r, 100));
    if (!editor || editor.isDestroyed() || !rendererReady) throw new Error("The canvas window is not open");
    return editor.webContents;
  };

  const host: CanvasHost = {
    store,
    workspace,
    stage,
    validation: { iconExists, suggestIcons },
    docDir: () => (store.filePath ? path.dirname(store.filePath) : null),
    measure: async (ids) =>
      requestRenderer<MeasureResult>(await waitForEditor(), {
        type: "measure",
        payload: { ids, minVersion: store.version },
      }),
    focus: async (ids) => {
      await requestRenderer(await waitForEditor(), { type: "focus", payload: { ids } });
    },
    captureEditor: async () => {
      const contents = await waitForEditor();
      const image = await contents.capturePage();
      const { width } = image.getSize();
      return (width > 1568 ? image.resize({ width: 1568, quality: "best" }) : image).toPNG();
    },
  };

  try {
    const server = await startMcpServer(host, port, app.getVersion());
    mcp.url = server.url;
    mcp.listening = true;
    app.on("will-quit", server.close);
    console.log(`[canvas] MCP server listening on ${server.url}`);
  } catch (error) {
    mcp.error =
      (error as NodeJS.ErrnoException).code === "EADDRINUSE"
        ? `Port ${port} is in use. Set CANVAS_MCP_PORT to use another.`
        : String(error);
    console.error("[canvas] MCP server failed to start:", mcp.error);
  }

  ipcMain.on(READY_CHANNEL, (event) => {
    if (event.sender !== editor?.webContents) return;
    rendererReady = true;
    broadcast();
  });
  ipcMain.on(SELECT_CHANNEL, (event, ids: unknown) => {
    if (event.sender !== editor?.webContents || !Array.isArray(ids)) return;
    store.setSelection(ids.filter((id): id is string => typeof id === "string"));
  });
  ipcMain.on(COMMAND_CHANNEL, (event, command: UserCommand) => {
    if (event.sender !== editor?.webContents) return;
    void runCommand(command);
  });

  ipcMain.on(PROJECT_CHANNEL, (event, action: ProjectAction) => {
    if (event.sender !== editor?.webContents || typeof action?.type !== "string") return;
    void runProjectAction(action);
  });

  const sendView = (command: ViewCommand) => editor?.webContents.send(VIEW_COMMAND_CHANNEL, command);

  async function pickProjectFolder(): Promise<string | null> {
    const result = await dialog.showOpenDialog(editor!, {
      title: "Choose or create a project folder",
      buttonLabel: "Use as project",
      defaultPath: workspace.projectsRoot,
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  }

  const knownDesign = (file: unknown): file is string =>
    typeof file === "string" && workspace.designs.some((design) => design.path === file);

  async function runProjectAction(action: ProjectAction) {
    try {
      switch (action.type) {
        case "open-project": {
          const folder = action.path ?? (await pickProjectFolder());
          if (folder) await workspace.openProject(folder);
          break;
        }
        case "forget-project":
          workspace.forgetProject(action.path);
          break;
        case "open-design":
          if (knownDesign(action.path)) await store.open(action.path);
          break;
        case "new-design":
          await workspace.newDesign();
          break;
        case "rename-design":
          if (knownDesign(action.path) && typeof action.name === "string")
            await workspace.renameDesign(action.path, action.name);
          break;
        case "delete-design": {
          if (!knownDesign(action.path)) break;
          const { response } = await dialog.showMessageBox(editor!, {
            type: "warning",
            message: `Move "${path.basename(action.path)}" to the trash?`,
            buttons: ["Move to Trash", "Cancel"],
            defaultId: 1,
            cancelId: 1,
          });
          if (response === 0) await workspace.deleteDesign(action.path);
          break;
        }
      }
    } catch (error) {
      dialog.showErrorBox("Canvas", error instanceof Error ? error.message : String(error));
    }
  }

  async function runCommand(command: UserCommand) {
    try {
      switch (command) {
        case "undo":
          store.undo();
          break;
        case "redo":
          store.redo();
          break;
        case "new":
          await workspace.newDesign();
          break;
        case "open": {
          const result = await dialog.showOpenDialog(editor!, {
            title: "Open design",
            filters: [{ name: "Canvas designs", extensions: ["json"] }],
            properties: ["openFile"],
          });
          if (!result.canceled && result.filePaths[0]) await workspace.openDesign(result.filePaths[0]);
          break;
        }
        case "save":
          if (store.filePath) {
            await store.save();
            break;
          }
        // fall through: untitled documents need a path
        case "save-as": {
          const result = await dialog.showSaveDialog(editor!, {
            title: "Save design",
            defaultPath: store.filePath ?? path.join(app.getPath("documents"), `Untitled${DOCUMENT_EXTENSION}`),
            filters: [{ name: "Canvas designs", extensions: ["json"] }],
          });
          if (!result.canceled && result.filePath) await store.save(result.filePath);
          break;
        }
      }
    } catch (error) {
      dialog.showErrorBox("Canvas", error instanceof Error ? error.message : String(error));
    }
  }

  const isMac = process.platform === "darwin";
  const menu: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" as const }] : []),
    {
      label: "File",
      submenu: [
        { label: "New Design", accelerator: "CmdOrCtrl+N", click: () => void runCommand("new") },
        { label: "Open Design…", accelerator: "CmdOrCtrl+O", click: () => void runCommand("open") },
        {
          label: "Open Project…",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => void runProjectAction({ type: "open-project" }),
        },
        { label: "Save", accelerator: "CmdOrCtrl+S", click: () => void runCommand("save") },
        { label: "Save As…", accelerator: "CmdOrCtrl+Shift+S", click: () => void runCommand("save-as") },
        { type: "separator" },
        {
          label: "Copy MCP Setup Command",
          click: () => clipboard.writeText(`claude mcp add --transport http canvas ${mcp.url}`),
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        // Shortcuts are handled by the renderer so they don't fire while typing in a text field.
        { label: "Undo", accelerator: "CmdOrCtrl+Z", registerAccelerator: false, click: () => void runCommand("undo") },
        {
          label: "Redo",
          accelerator: "CmdOrCtrl+Shift+Z",
          registerAccelerator: false,
          click: () => void runCommand("redo"),
        },
        { type: "separator" },
        { label: "Deselect", accelerator: "Escape", registerAccelerator: false, click: () => store.setSelection([]) },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Zoom In", accelerator: "CmdOrCtrl+=", click: () => sendView("zoom-in") },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", click: () => sendView("zoom-out") },
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", click: () => sendView("zoom-reset") },
        { label: "Zoom to Fit", accelerator: "Shift+1", click: () => sendView("zoom-fit") },
        { label: "Zoom to Selection", accelerator: "Shift+2", click: () => sendView("zoom-selection") },
        { label: "Toggle Sidebar", accelerator: "CmdOrCtrl+\\", click: () => sendView("toggle-sidebar") },
        { type: "separator" },
        { role: "toggleDevTools" },
        { role: "togglefullscreen" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));

  const openEditor = () => {
    rendererReady = false;
    editor = createEditorWindow();
    editor.on("closed", () => {
      editor = null;
      rendererReady = false;
      // The offscreen stage window would otherwise keep the app alive.
      if (!isMac) app.quit();
    });
  };
  openEditor();

  app.on("second-instance", (_event, argv) => {
    const file = argv.slice(1).find((arg) => arg.endsWith(".json") && !arg.startsWith("-"));
    if (file) void workspace.openDesign(path.resolve(file));
    if (editor) {
      if (editor.isMinimized()) editor.restore();
      editor.focus();
    }
  });
  app.on("activate", () => {
    if (!editor) openEditor();
  });
  app.on("window-all-closed", () => {
    if (!isMac) app.quit();
  });

  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    stage.destroy();
    workspace.dispose();
    void store.flush().finally(() => app.quit());
  });
}
