import * as path from "node:path";

import { BrowserWindow, nativeImage, shell, type WebContents } from "electron";

import type { DesignDocument } from "../shared/schema.ts";
import type { RenderResult } from "../shared/ipc.ts";
import { requestRenderer } from "./rendererRpc.ts";

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const rendererDir = path.join(__dirname, "..", "dist");
const preloadPath = path.join(__dirname, "preload.cjs");

function load(window: BrowserWindow, hash: string) {
  if (devServerUrl) return window.loadURL(`${devServerUrl}#${hash}`);
  return window.loadFile(path.join(rendererDir, "index.html"), { hash });
}

/** Keep renderers on our own pages; send everything else to the system browser. */
function lockNavigation(contents: WebContents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (devServerUrl && url.startsWith(devServerUrl)) return;
    event.preventDefault();
  });
}

const secureWebPreferences = {
  preload: preloadPath,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webviewTag: false,
  spellcheck: false,
} as const;

export function createEditorWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 640,
    minHeight: 420,
    show: false,
    title: "Canvas",
    backgroundColor: "#1e1e1e",
    autoHideMenuBar: true,
    webPreferences: {
      ...secureWebPreferences,
      // Agents edit while the user looks elsewhere; keep the view live so
      // measurements and the visible canvas never lag behind the document.
      backgroundThrottling: false,
    },
  });
  lockNavigation(window.webContents);
  // CANVAS_HIDDEN keeps automated test runs off the user's screen.
  if (!process.env.CANVAS_HIDDEN) window.once("ready-to-show", () => window.show());
  void load(window, "editor");
  return window;
}

const MAX_STAGE_SIZE = 8192;

/**
 * An invisible, offscreen renderer that rasterizes nodes at exact size for
 * screenshots and exports, independent of where the user has scrolled.
 */
export class Stage {
  private window: BrowserWindow | null = null;
  private loading: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  private ensure(): Promise<BrowserWindow> {
    if (this.window && !this.window.isDestroyed() && this.loading) {
      const window = this.window;
      return this.loading.then(() => window);
    }
    const window = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      frame: false,
      backgroundColor: "#ffffff",
      enableLargerThanScreen: true,
      webPreferences: { ...secureWebPreferences, offscreen: true, backgroundThrottling: false },
    });
    window.webContents.setFrameRate(60);
    lockNavigation(window.webContents);
    this.window = window;
    this.loading = load(window, "stage").then(() => undefined);
    window.on("closed", () => {
      this.window = null;
      this.loading = null;
    });
    return this.loading.then(() => window);
  }

  /** Serialize jobs: the stage renders one thing at a time. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  capture(options: {
    doc: DesignDocument;
    docDir: string | null;
    ids: string[] | null;
    scale: number;
    maxSize: number;
    background: string | null;
  }): Promise<{ png: Buffer; result: RenderResult }> {
    return this.enqueue(async () => {
      const window = await this.ensure();
      const contents = window.webContents;
      const result = await requestRenderer<RenderResult>(
        contents,
        {
          type: "render",
          payload: { ...options, maxSize: Math.min(options.maxSize, MAX_STAGE_SIZE) },
        },
        30_000,
      );
      const width = Math.max(1, Math.ceil(result.width));
      const height = Math.max(1, Math.ceil(result.height));
      window.setContentSize(width, height);

      const grab = async (backdrop: string) => {
        await requestRenderer(contents, { type: "backdrop", payload: backdrop });
        const image = await contents.capturePage({ x: 0, y: 0, width, height });
        const size = image.getSize();
        return size.width === width && size.height === height
          ? image
          : image.resize({ width, height, quality: "best" });
      };

      if (options.background) {
        return { png: (await grab(options.background)).toPNG(), result };
      }
      // capturePage flattens alpha. Capture over black and over white and solve
      // for each pixel's alpha: white - black = 255 - alpha.
      const black = (await grab("#000000")).toBitmap();
      const white = (await grab("#ffffff")).toBitmap();
      const out = Buffer.alloc(black.length);
      for (let i = 0; i < black.length; i += 4) {
        const diff = (white[i]! - black[i]! + white[i + 1]! - black[i + 1]! + white[i + 2]! - black[i + 2]!) / 3;
        const alpha = Math.max(0, Math.min(255, Math.round(255 - diff)));
        out[i + 3] = alpha;
        if (alpha === 0) continue;
        for (let c = 0; c < 3; c++) out[i + c] = Math.min(255, Math.round((black[i + c]! * 255) / alpha));
      }
      const png = nativeImage.createFromBitmap(out, { width, height }).toPNG();
      return { png, result };
    });
  }

  html(options: {
    doc: DesignDocument;
    docDir: string | null;
    ids: string[] | null;
  }): Promise<{ html: string; result: RenderResult }> {
    return this.enqueue(async () => {
      const window = await this.ensure();
      const result = await requestRenderer<RenderResult>(window.webContents, {
        type: "render",
        payload: { ...options, scale: 1, maxSize: MAX_STAGE_SIZE, background: null },
      });
      const html = await requestRenderer<string>(window.webContents, { type: "html", payload: null });
      return { html, result };
    });
  }

  destroy() {
    this.window?.destroy();
    this.window = null;
  }
}
