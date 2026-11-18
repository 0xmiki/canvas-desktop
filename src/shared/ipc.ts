// Contract between the main process and the renderer. The renderer is a pure
// view: the document lives in main, and main asks the renderer to measure or
// rasterize through a tiny request/response channel.

import type { DesignDocument } from "./schema.ts";

export const STATE_CHANNEL = "canvas:state";
export const REQUEST_CHANNEL = "canvas:request";
export const RESPONSE_CHANNEL = "canvas:response";
export const READY_CHANNEL = "canvas:ready";
export const SELECT_CHANNEL = "canvas:select";
export const COMMAND_CHANNEL = "canvas:command";
export const VIEW_COMMAND_CHANNEL = "canvas:view-command";
export const PROJECT_CHANNEL = "canvas:project";

export interface ProjectRef {
  name: string;
  /** Absolute folder path. */
  path: string;
}

export interface DesignRef {
  /** Path relative to the project, without the extension. */
  name: string;
  path: string;
}

/** Sidebar actions. Omitted paths open a folder picker. */
export type ProjectAction =
  | { type: "open-project"; path?: string }
  | { type: "forget-project"; path: string }
  | { type: "open-design"; path: string }
  | { type: "new-design" }
  | { type: "rename-design"; path: string; name: string }
  | { type: "delete-design"; path: string };

export interface McpStatus {
  url: string;
  listening: boolean;
  error: string | null;
}

export interface Activity {
  /** Short label of the last agent action, e.g. "Add pricing section". */
  label: string;
  /** Node ids the action touched. */
  ids: string[];
  at: number;
}

export interface AppState {
  doc: DesignDocument;
  version: number;
  filePath: string | null;
  /** Directory relative image paths resolve against. */
  docDir: string | null;
  dirty: boolean;
  selection: string[];
  mcp: McpStatus;
  activity: Activity | null;
  project: ProjectRef | null;
  projects: ProjectRef[];
  designs: DesignRef[];
  /** Phosphor SVG bodies used by the document, keyed "weight:name". */
  glyphs: Record<string, string>;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type RendererRequest =
  | { type: "measure"; payload: { ids: string[] | null; minVersion: number } }
  | { type: "focus"; payload: { ids: string[] } }
  | {
      type: "render";
      payload: {
        doc: DesignDocument;
        docDir: string | null;
        glyphs: Record<string, string>;
        ids: string[] | null;
        scale: number;
        maxSize: number;
        background: string | null;
      };
    }
  | { type: "settle"; payload: null }
  | { type: "backdrop"; payload: string | null }
  | { type: "html"; payload: null };

export interface RenderResult {
  width: number;
  height: number;
  scale: number;
  /** Canvas-space bounds of the rendered region. */
  bounds: Bounds;
  warnings: string[];
}

export type UserCommand = "new" | "open" | "save" | "save-as" | "undo" | "redo";
export type ViewCommand =
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "zoom-fit"
  | "zoom-selection"
  | "toggle-sidebar"
  | "connect-agent";

export interface CanvasBridge {
  /** "editor" for the main window, "stage" for the offscreen rasterizer. */
  mode: "editor" | "stage";
  onState(listener: (state: AppState) => void): () => void;
  onRequest(handler: (request: RendererRequest) => Promise<unknown> | unknown): () => void;
  onViewCommand(listener: (command: ViewCommand) => void): () => void;
  ready(): void;
  select(ids: string[]): void;
  command(command: UserCommand): void;
  project(action: ProjectAction): void;
}

declare global {
  interface Window {
    canvasBridge: CanvasBridge;
  }
}
