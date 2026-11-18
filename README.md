# Canvas

An AI-first design canvas. You tell your agent what you want; the agent designs it on the canvas over MCP while you watch. There are no drawing tools for humans (yet). You can navigate, organize designs into projects, and click things to point at them ("make *this* bigger").

## Navigating

| Mouse | Does |
| --- | --- |
| Scroll wheel | Zoom at the cursor (trackpad two-finger scroll pans; pinch zooms) |
| Shift + wheel | Pan sideways |
| Drag (left on canvas, middle, right, or Space + drag) | Pan |
| Click / Shift + click | Select / add to selection (Esc clears, Enter / Shift+Enter go to child / parent) |
| Double-click | Zoom to the screen under the cursor; again to zoom into the element |
| Double-click empty canvas | Zoom to fit everything |

The "Wheel" button in the status bar switches between auto, always-zoom and always-pan. The zoom controls there (− % + fit) and Ctrl+= / Ctrl+- / Ctrl+0 / Shift+1 / Shift+2 work too.

## Projects

A project is a folder of designs (`*.canvas.json`). It can be a standalone folder (new ones go in `~/Documents/Canvas`) or a `design/` folder inside a code repo, so the agent working on that repo keeps designs next to the code. The sidebar (Ctrl+\) switches projects and creates, opens, renames (double-click) and trashes designs. Files that appear in the folder from elsewhere show up live. Opening a file outside any project adds its folder as a project.

## Run

```sh
bun install
bun run build && bun run start   # built app
bun run dev                      # Vite HMR for the canvas, auto-restart on main-process changes
```

On NixOS the npm Electron binary runs through `nix-ld`. If `node_modules/electron/dist` is missing (Bun skips the postinstall while the download is slow), run `node node_modules/electron/install.js`.

## Connect your agent

The app serves MCP (streamable HTTP) on `http://127.0.0.1:4590/mcp` while it's open.

```sh
claude mcp add --transport http canvas http://127.0.0.1:4590/mcp
```

Claude Code is shown here, but any MCP client works: click the MCP status in the app (or File → Connect an Agent…) for ready-made setup for Codex, Gemini CLI, Cursor, VS Code, Windsurf, OpenCode, and a stdio bridge for anything else. Set `CANVAS_MCP_PORT` to change the port.

## Tools

| Tool | What it does |
| --- | --- |
| `get_state` | Open document, the user's selection, top-level frames with bounds, variables, recent edits |
| `get_guide` | Full node schema, layout rules and design guidance. Agents read it once per session |
| `batch` | Atomic edits: `create` (nested trees), `update`, `delete`, `move`, `duplicate`, `replace`, `detach`, `variables`. Returns ids plus layout warnings |
| `execute` | Synchronous JS against a `canvas` API for loops/grids. One undo step, rolled back on error |
| `read_nodes` / `find_nodes` | Inspect node JSON with rendered bounds; search by name, text, type |
| `screenshot` | Exact offscreen render of nodes (or `editor: true` for the user's view) |
| `export` | PNG (transparent, any scale) or standalone HTML/CSS |
| `list_icons` | Search Phosphor (default; 1500+ icons, 6 weights) or Lucide |
| `focus` | Select nodes and zoom the user's view to them |
| `history` | Undo/redo/list |
| `list_projects` / `open_project` | Projects: folders of designs, optionally inside a code repo |
| `open_document` / `new_document` / `save_document` | Designs: by name within the project, or by path |

## Document model

Designs are JSON (`*.canvas.json`), CSS-shaped so agents already know the vocabulary: frames with `layout: row | column | grid`, `gap`, `padding`, `justify`, `align`; sizes as px, `"fill"` or `"hug"`; `fill` paints (colors, gradients, images), `stroke`, `radius`, `shadow`; `text`, `icon` (Phosphor with thin/light/regular/bold/fill/duotone weights, or Lucide), `image`, `path`, `svg`; components (`component: true`) and `instance` nodes with per-descendant `overrides`; `$variables` as design tokens. The canonical reference is `src/main/mcp/guide.ts`, the same text agents get from `get_guide`.

Documents with a path autosave after every edit. Untitled documents are kept in a recovery file in the app's user data folder until saved.

## Architecture

```
src/shared/     schema (document model), tree helpers, IPC contract
src/main/       Electron main: DocumentStore (state, undo, autosave), operations (pure, validated edits),
                MCP server + tools, offscreen Stage window for screenshots/exports
src/preload/    the narrow, typed bridge exposed to the sandboxed renderer
src/renderer/   React view: nodes render as real DOM/CSS. Editor (pan/zoom/select) and Stage (rasterizer)
```

The main process owns the document. Renderers are sandboxed, context-isolated views. Main asks them to measure layout or rasterize over a small request/response channel. `CANVAS_USER_DATA=<dir>` runs a separate profile, which is handy for testing next to your real one.

```sh
bun test        # operation/unit tests
bun run typecheck
```
