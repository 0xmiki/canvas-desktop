import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vm from "node:vm";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { Bounds } from "../../shared/ipc.ts";
import { DEFAULT_ICON_SET, ICON_SETS, type DesignDocument, type DesignNode } from "../../shared/schema.ts";
import { expandInstance, locate, walk } from "../../shared/tree.ts";
import type { DocumentStore } from "../documentStore.ts";
import type { Workspace } from "../workspace.ts";
import { searchIcons } from "../icons.ts";
import { applyOperations, outline, type Operation, type ValidationContext } from "../operations.ts";
import type { Stage } from "../windows.ts";
import { GUIDE } from "./guide.ts";

export interface MeasureResult {
  bounds: Record<string, Bounds>;
  issues: { id: string; issue: string }[];
}

export interface CanvasHost {
  store: DocumentStore;
  workspace: Workspace;
  stage: Stage;
  validation: ValidationContext;
  docDir(): string | null;
  /** Layout of nodes as currently rendered in the editor (canvas coordinates). */
  measure(ids: string[] | null): Promise<MeasureResult>;
  /** Select and bring nodes into view for the user. */
  focus(ids: string[]): Promise<void>;
  /** PNG of the editor viewport exactly as the user sees it. */
  captureEditor(): Promise<Buffer>;
}

const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] });
const fail = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }], isError: true });

/** One line: "frame#id "Name" (12 nodes inside)". */
function summary(node: DesignNode): string {
  const line = outline([node], 1).split("\n")[0]!;
  let inside = 0;
  if (node.type === "frame") walk(node.children, () => void inside++);
  return inside ? `${line} (${inside} nodes inside)` : line;
}

const fmtBounds = (b: Bounds | undefined) =>
  b ? `(${Math.round(b.x)}, ${Math.round(b.y)}) ${Math.round(b.width)}×${Math.round(b.height)}` : "(not rendered)";

/** Find a node, including nodes inside component instances ("inst/child"). */
function findAnyNode(doc: DesignDocument, id: string): DesignNode | null {
  const direct = locate(doc, id);
  if (direct) return direct.node;
  if (!id.includes("/")) return null;
  const instance = locate(doc, id.split("/")[0]!);
  if (!instance || instance.node.type !== "instance") return null;
  const expanded = expandInstance(doc, instance.node);
  let found: DesignNode | null = null;
  if (expanded) walk([expanded], (node) => {
    if (node.id === id) found = node;
  });
  return found;
}

function truncate(node: DesignNode, depth: number, bounds: Record<string, Bounds> | null): unknown {
  const copy: Record<string, unknown> = { ...node };
  if (bounds?.[node.id]) {
    const b = bounds[node.id]!;
    copy.bounds = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) };
  }
  if (node.type === "frame") {
    copy.children =
      depth > 0
        ? node.children.map((child) => truncate(child, depth - 1, bounds))
        : node.children.length
          ? `${node.children.length} children (raise depth to see)`
          : [];
  }
  return copy;
}

function affectedRoots(doc: DesignDocument, ids: string[]): string[] {
  const roots = new Set<string>();
  for (const id of ids) {
    const location = locate(doc, id.split("/")[0]!);
    if (location) roots.add(location.path[0]!);
  }
  return [...roots];
}

// Keys whose "$..." values are content, not variable references (mirrors the renderer).
const LITERAL_KEYS = new Set(["text", "svg", "d", "notes", "name", "id", "ref", "icon", "src", "viewBox"]);

function unknownVariables(doc: DesignDocument, rootIds: string[]): string[] {
  const missing = new Set<string>();
  const scan = (value: unknown, key: string) => {
    if (typeof value === "string") {
      if (value.startsWith("$") && !LITERAL_KEYS.has(key) && !(value.slice(1) in doc.variables)) missing.add(value.slice(1));
    } else if (Array.isArray(value)) value.forEach((item) => scan(item, key));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) scan(v, k);
  };
  const roots = doc.children.filter((node) => rootIds.includes(node.id));
  walk(roots, (node) => {
    for (const [key, value] of Object.entries(node)) if (key !== "children") scan(value, key);
  });
  return [...missing];
}

const operationSchema = z
  .object({
    op: z.enum(["create", "update", "delete", "move", "duplicate", "replace", "detach", "variables"]),
    id: z.string().optional().describe("Target node id (update, delete, move, duplicate, replace, detach)"),
    parent: z.string().nullable().optional().describe("Parent frame id; omit or null for top level"),
    index: z.number().int().optional().describe("Position among siblings; default appends"),
    node: z.record(z.string(), z.unknown()).optional().describe("Node tree for create/replace"),
    set: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Properties to set (update, duplicate) or variables to set; null removes"),
    x: z.number().optional(),
    y: z.number().optional(),
  })
  .passthrough();

export function registerTools(server: McpServer, host: CanvasHost) {
  const { store } = host;

  // Agents see screenshots flattened; a light neutral keeps white frames' edges visible.
  async function screenshotContent(ids: string[] | null, scale = 1, maxSize = 1568, background: string | null = "#f4f4f5") {
    const { png, result } = await host.stage.capture({
      doc: store.doc,
      docDir: host.docDir(),
      ids,
      scale,
      maxSize,
      background,
    });
    const notes = [
      `${result.width}×${result.height}px at ${Number(result.scale.toFixed(3))}x of canvas region ${fmtBounds(result.bounds)}`,
      ...result.warnings,
    ];
    return [
      { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
      { type: "text" as const, text: notes.join("\n") },
    ];
  }

  async function issuesFor(ids: string[]): Promise<string> {
    if (!ids.length) return "";
    const missing = unknownVariables(store.doc, affectedRoots(store.doc, ids));
    const variableWarning = missing.length
      ? `\nUnknown variables (rendered as nothing): ${missing.map((name) => `${name}`).join(", ")}. Define them with { op: "variables" }.`
      : "";
    return variableWarning + (await layoutIssues(ids));
  }

  async function layoutIssues(ids: string[]): Promise<string> {
    try {
      const { issues } = await host.measure(null);
      const roots = new Set(affectedRoots(store.doc, ids));
      const relevant = issues.filter((issue) => {
        const location = locate(store.doc, issue.id.split("/")[0]!);
        return location && roots.has(location.path[0]!);
      });
      if (!relevant.length) return "";
      return `\nLayout warnings:\n${relevant
        .slice(0, 20)
        .map((issue) => `- ${issue.id}: ${issue.issue}`)
        .join("\n")}`;
    } catch {
      return "";
    }
  }

  server.registerTool(
    "get_state",
    {
      title: "Get canvas state",
      description:
        "The open document, the user's current selection, top-level frames with their bounds, variables and recent history. Call this first.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const doc = store.doc;
      let bounds: Record<string, Bounds> = {};
      try {
        bounds = (await host.measure([...doc.children.map((n) => n.id), ...store.selection])).bounds;
      } catch {
        // The editor window may still be loading; bounds are best effort.
      }
      const lines: string[] = [];
      const { project, designs } = host.workspace;
      if (project) {
        const others = designs.filter((design) => design.path !== store.filePath).map((design) => design.name);
        lines.push(`Project: ${project.name} (${project.path})`);
        if (others.length) lines.push(`Other designs in project: ${others.slice(0, 30).join(", ")}${others.length > 30 ? ", …" : ""}`);
      } else {
        lines.push("Project: none (open_project to work in a folder of designs)");
      }
      lines.push(
        store.filePath
          ? `Document: ${store.filePath}${store.dirty ? " (saving…)" : " (saved)"}`
          : "Document: Untitled (kept in a recovery file; call save_document with a path to keep it)",
      );
      const variables = Object.entries(doc.variables);
      lines.push(
        variables.length
          ? `Variables: ${variables.map(([k, v]) => `$${k}=${JSON.stringify(v)}`).join(", ")}`
          : "Variables: none",
      );
      if (store.selection.length) {
        lines.push("", "User selection:");
        for (const id of store.selection) {
          const node = findAnyNode(doc, id);
          if (node) lines.push(`- ${summary(node)} ${fmtBounds(bounds[id])}`);
        }
      } else {
        lines.push("", "User selection: nothing selected");
      }
      lines.push("", `Top-level nodes (${doc.children.length}):`);
      for (const node of doc.children.slice(0, 100)) {
        lines.push(`- ${summary(node)} ${fmtBounds(bounds[node.id])}`);
      }
      if (!doc.children.length) lines.push("- (empty canvas)");
      const recent = store.history().undo.slice(0, 5);
      if (recent.length) lines.push("", `Recent edits (newest first): ${recent.join(" | ")}`);
      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "get_guide",
    {
      title: "Get design guide",
      description: "The full node schema, layout rules, batch/execute reference and design guidance. Read once per session before editing.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => text(GUIDE),
  );

  server.registerTool(
    "read_nodes",
    {
      title: "Read nodes",
      description:
        "Full properties of nodes as JSON, with rendered bounds in canvas coordinates. Defaults to the user's selection, or all top-level nodes.",
      inputSchema: {
        ids: z.array(z.string()).optional().describe("Node ids; ids inside instances look like 'inst/child'"),
        depth: z.number().int().min(0).max(20).optional().describe("Child levels to include (default 3)"),
        layout: z.boolean().optional().describe("Include rendered bounds (default true)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ids, depth = 3, layout = true }) => {
      const doc = store.doc;
      const targets = ids?.length ? ids : store.selection.length ? store.selection : doc.children.map((n) => n.id);
      const nodes: DesignNode[] = [];
      const missing: string[] = [];
      for (const id of targets) {
        const node = findAnyNode(doc, id);
        if (node) nodes.push(node);
        else missing.push(id);
      }
      let bounds: Record<string, Bounds> | null = null;
      if (layout) {
        try {
          bounds = (await host.measure(null)).bounds;
        } catch {
          bounds = null;
        }
      }
      const output = JSON.stringify(nodes.map((node) => truncate(node, depth, bounds)), null, 1);
      return text((missing.length ? `Not found: ${missing.join(", ")}\n` : "") + output);
    },
  );

  server.registerTool(
    "find_nodes",
    {
      title: "Find nodes",
      description: "Search nodes by name, text content, type, or icon. Returns an outline with ids.",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive match against name, text, icon and id"),
        type: z.string().optional().describe("Node type filter, e.g. 'text' or 'frame'"),
        within: z.string().optional().describe("Only search inside this node"),
        components: z.boolean().optional().describe("Only list component frames"),
        limit: z.number().int().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, type, within, components, limit = 60 }) => {
      const doc = store.doc;
      let roots = doc.children;
      if (within) {
        const location = locate(doc, within);
        if (!location) return fail(`Node "${within}" not found`);
        roots = [location.node];
      }
      const needle = query?.toLowerCase();
      const lines: string[] = [];
      let total = 0;
      walk(roots, (node) => {
        if (type && node.type !== type) return;
        if (components && !(node.type === "frame" && node.component)) return;
        if (needle) {
          const hay = [node.id, node.name, node.type === "text" ? node.text : "", node.type === "icon" ? node.icon : ""]
            .join(" ")
            .toLowerCase();
          if (!hay.includes(needle)) return;
        }
        total++;
        if (lines.length < limit) {
          const trail = locate(doc, node.id)!.path.slice(0, -1).join(" > ");
          lines.push(`${summary(node)}${trail ? `   in ${trail}` : ""}`);
        }
      });
      if (!total) return text("No matches.");
      return text(`${total} match${total === 1 ? "" : "es"}${total > lines.length ? ` (showing ${lines.length})` : ""}:\n${lines.join("\n")}`);
    },
  );

  server.registerTool(
    "batch",
    {
      title: "Edit design",
      description:
        "Apply design operations atomically as one undo step: create (nested node trees), update, delete, move, duplicate, replace, detach, variables. See get_guide for node properties. Returns created ids and layout warnings.",
      inputSchema: {
        description: z.string().describe("Short imperative label shown to the user, e.g. 'Add pricing section'"),
        ops: z.array(operationSchema).min(1),
        screenshot: z.boolean().optional().describe("Also return a screenshot of the affected top-level frames"),
      },
    },
    async ({ description, ops, screenshot }) => {
      let results;
      try {
        results = store.apply(ops as unknown as Operation[], description);
      } catch (error) {
        return fail(`Nothing was changed. ${error instanceof Error ? error.message : String(error)}`);
      }
      const touched = results.flatMap((result) => (result.id ? [result.id] : []));
      const summary = results
        .map((result, i) => {
          if (result.created) return `ops[${i}] ${result.op} →\n${result.created}`;
          return `ops[${i}] ${result.op}${result.id ? ` ${result.id}` : ""} ✓`;
        })
        .join("\n");
      const warnings = await issuesFor(touched);
      const content: CallToolResult["content"] = [{ type: "text", text: summary + warnings }];
      if (screenshot) {
        const roots = affectedRoots(store.doc, touched);
        if (roots.length) content.push(...(await screenshotContent(roots)));
      }
      return { content };
    },
  );

  server.registerTool(
    "execute",
    {
      title: "Run design script",
      description:
        "Run synchronous JavaScript against the document via a `canvas` API (create/update/delete/move/duplicate/get/find/children/setVariables). Use for loops, grids and computed layouts. All changes commit as one undo step; an exception discards them. See get_guide.",
      inputSchema: {
        description: z.string().describe("Short imperative label shown to the user"),
        code: z.string().describe("JavaScript. The last expression's value is returned."),
      },
    },
    async ({ description, code }) => {
      let working = store.doc;
      const touched: string[] = [];
      const logs: string[] = [];
      const run = (operation: Operation) => {
        const { doc, results } = applyOperations(working, [operation], host.validation);
        working = doc;
        const id = results[0]?.id;
        if (id) touched.push(id);
        return id;
      };
      const copy = <T>(value: T): T => (value === undefined ? value : structuredClone(value));
      const api = {
        create: (node: Record<string, unknown>, parent?: string | null, index?: number) =>
          run({ op: "create", node, parent, index }),
        update: (id: string, set: Record<string, unknown>) => void run({ op: "update", id, set }),
        delete: (id: string) => void run({ op: "delete", id }),
        move: (id: string, parent?: string | null, index?: number) => void run({ op: "move", id, parent, index }),
        duplicate: (id: string, options: Record<string, unknown> = {}) =>
          run({ op: "duplicate", id, ...options } as Operation),
        replace: (id: string, node: Record<string, unknown>) => run({ op: "replace", id, node }),
        detach: (id: string) => run({ op: "detach", id }),
        setVariables: (set: Record<string, string | number | null>) => void run({ op: "variables", set }),
        get: (id: string) => copy(findAnyNode(working, id)),
        children: (parent?: string | null) => {
          if (!parent) return copy(working.children);
          const node = locate(working, parent)?.node;
          return copy(node?.type === "frame" ? node.children : []);
        },
        find: (filter: ((node: DesignNode) => boolean) | { type?: string; name?: string; text?: string }) => {
          const matches: DesignNode[] = [];
          walk(working.children, (node) => {
            const ok =
              typeof filter === "function"
                ? filter(structuredClone(node))
                : (!filter.type || node.type === filter.type) &&
                  (!filter.name || (node.name ?? "").toLowerCase().includes(filter.name.toLowerCase())) &&
                  (!filter.text || (node.type === "text" && node.text.toLowerCase().includes(filter.text.toLowerCase())));
            if (ok) matches.push(structuredClone(node));
          });
          return matches;
        },
        get variables() {
          return copy(working.variables);
        },
      };
      const format = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 1));
      const sandbox = {
        canvas: api,
        console: {
          log: (...args: unknown[]) => logs.push(args.map(format).join(" ")),
          warn: (...args: unknown[]) => logs.push(`warn: ${args.map(format).join(" ")}`),
          error: (...args: unknown[]) => logs.push(`error: ${args.map(format).join(" ")}`),
        },
      };
      let value: unknown;
      try {
        value = vm.runInNewContext(code, sandbox, { timeout: 5_000, filename: "design-script.js" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`Script failed; nothing was changed.\n${message}${logs.length ? `\n\nLogs:\n${logs.join("\n")}` : ""}`);
      }
      if (working !== store.doc) store.commit(working, description, touched);
      const parts: string[] = [];
      if (touched.length) parts.push(`Changed ${touched.length} node${touched.length === 1 ? "" : "s"}.`);
      else if (working === store.doc) parts.push("No changes.");
      if (logs.length) parts.push(`Logs:\n${logs.join("\n")}`);
      if (value !== undefined) parts.push(`Result:\n${format(value)?.slice(0, 20_000)}`);
      return text(parts.join("\n\n") + (await issuesFor(touched)));
    },
  );

  server.registerTool(
    "screenshot",
    {
      title: "Screenshot",
      description:
        "Render nodes to a PNG so you can check your work. Defaults to the user's selection, or the whole canvas. Renders offscreen at exact size regardless of the user's viewport.",
      inputSchema: {
        ids: z.array(z.string()).optional().describe("Nodes to render together (their combined bounds)"),
        scale: z.number().min(0.05).max(4).optional().describe("Pixel ratio (default 1)"),
        maxSize: z.number().int().min(64).max(4096).optional().describe("Max pixels on the long edge (default 1568)"),
        background: z.string().optional().describe('Backdrop behind transparent areas (default "#f4f4f5")'),
        editor: z
          .boolean()
          .optional()
          .describe("Capture the user's editor view instead (their zoom, scroll and selection); ignores other options"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ ids, scale, maxSize, background, editor }) => {
      if (editor) {
        try {
          const png = await host.captureEditor();
          return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      }
      const targets = ids?.length ? ids : store.selection.length ? store.selection : null;
      if (!store.doc.children.length) return fail("The canvas is empty.");
      try {
        return { content: await screenshotContent(targets, scale, maxSize, background) };
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "export",
    {
      title: "Export",
      description:
        "Write nodes to a file: png (raster, default scale 2) or html (standalone HTML/CSS of the rendered design — useful as a reference when implementing it in code).",
      inputSchema: {
        ids: z.array(z.string()).optional().describe("Nodes to export; defaults to selection, then whole canvas"),
        format: z.enum(["png", "html"]),
        path: z.string().describe("Output file path (relative paths resolve against the document's folder)"),
        scale: z.number().min(0.1).max(4).optional(),
      },
    },
    async ({ ids, format, path: outPath, scale = 2 }) => {
      const targets = ids?.length ? ids : store.selection.length ? store.selection : null;
      const base = host.docDir() ?? process.cwd();
      const target = path.resolve(base, outPath);
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        if (format === "png") {
          const { png, result } = await host.stage.capture({
            doc: store.doc,
            docDir: host.docDir(),
            ids: targets,
            scale,
            maxSize: 8192,
            background: null,
          });
          await fs.writeFile(target, png);
          return text(`Wrote ${target} (${result.width}×${result.height}px)`);
        }
        const { html } = await host.stage.html({ doc: store.doc, docDir: host.docDir(), ids: targets });
        await fs.writeFile(target, html);
        return text(`Wrote ${target}`);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "list_icons",
    {
      title: "List icons",
      description:
        "Search icons by keyword. Phosphor (default, 1500+ icons in 6 weights) or Lucide. Returns names for icon nodes' `icon`; pass the same `set` on the node.",
      inputSchema: {
        query: z.string().describe("Keywords, e.g. 'settings gear' or 'arrow'"),
        set: z.enum(ICON_SETS).optional().describe('Icon set (default "phosphor")'),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, set = DEFAULT_ICON_SET, limit = 40 }) => {
      const names = searchIcons(query, set, limit);
      return text(names.length ? `${set}: ${names.join(", ")}` : "No icons matched. Try a broader word.");
    },
  );

  server.registerTool(
    "focus",
    {
      title: "Show nodes to the user",
      description: "Select nodes in the editor and zoom the user's view to them.",
      inputSchema: { ids: z.array(z.string()).min(1) },
    },
    async ({ ids }) => {
      const missing = ids.filter((id) => !findAnyNode(store.doc, id));
      if (missing.length) return fail(`Not found: ${missing.join(", ")}`);
      store.setSelection(ids);
      await host.focus(ids);
      return text(`Showing ${ids.join(", ")}`);
    },
  );

  server.registerTool(
    "history",
    {
      title: "Undo / redo",
      description: "Undo or redo edits (yours or the user's), or list the history.",
      inputSchema: {
        action: z.enum(["undo", "redo", "list"]),
        steps: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ action, steps = 1 }) => {
      if (action === "list") {
        const { undo, redo } = store.history();
        return text(
          `Undo stack (newest first):\n${undo.slice(0, 30).join("\n") || "(empty)"}\n\nRedo stack:\n${redo.slice(0, 30).join("\n") || "(empty)"}`,
        );
      }
      const labels = action === "undo" ? store.undo(steps) : store.redo(steps);
      return labels.length ? text(`${action === "undo" ? "Undid" : "Redid"}: ${labels.join(" | ")}`) : fail(`Nothing to ${action}.`);
    },
  );

  const errorText = (error: unknown) => fail(error instanceof Error ? error.message : String(error));

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "Known projects (folders of .canvas.json designs) and the designs in the current one. A project can be a standalone folder or a design folder inside a code repo.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const { workspace } = host;
      const lines: string[] = [];
      if (!workspace.projects.length) lines.push("No projects yet. Create one with open_project.");
      for (const project of workspace.projects) {
        const current = project.path === workspace.project?.path;
        lines.push(`${current ? "* " : "- "}${project.name}  ${project.path}${current ? "  (current)" : ""}`);
      }
      if (workspace.project) {
        lines.push("", `Designs in ${workspace.project.name}:`);
        for (const design of workspace.designs) {
          lines.push(`${design.path === store.filePath ? "* " : "- "}${design.name}`);
        }
        if (!workspace.designs.length) lines.push("- (none)");
      }
      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "open_project",
    {
      title: "Open project",
      description:
        "Open a project folder in the editor, creating the folder if needed, and open its most recently edited design (or a new one). For a code repo, a folder like <repo>/design works well.",
      inputSchema: {
        path: z.string().describe("Absolute folder path (~/ allowed)"),
        name: z.string().optional().describe("Display name; defaults to the folder name"),
      },
    },
    async ({ path: dir, name }) => {
      try {
        await host.workspace.openProject(dir, name);
        const { project, designs } = host.workspace;
        return text(
          `Opened project ${project?.name} (${project?.path}) with ${designs.length} design${designs.length === 1 ? "" : "s"}. Editing ${store.filePath}.`,
        );
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "open_document",
    {
      title: "Open design",
      description:
        "Open a design: a name from the current project (e.g. 'Onboarding'), a path relative to the project, or an absolute .canvas.json path. Missing files are created. The current design is saved first.",
      inputSchema: { path: z.string().describe("Design name or path") },
    },
    async ({ path: reference }) => {
      try {
        await host.workspace.openDesign(reference);
        return text(`Opened ${store.filePath} (${store.doc.children.length} top-level nodes)`);
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "new_document",
    {
      title: "New design",
      description:
        "Create and open a new empty design in the current project (or an untitled document when no project is open). The current one is saved first.",
      inputSchema: { name: z.string().optional().describe("Design name, e.g. 'Checkout flow'") },
    },
    async ({ name }) => {
      try {
        const file = await host.workspace.newDesign(name);
        return text(file ? `Created and opened ${file}` : "New untitled document. Call save_document with a path to keep it.");
      } catch (error) {
        return errorText(error);
      }
    },
  );

  server.registerTool(
    "save_document",
    {
      title: "Save document",
      description:
        "Save to disk. Documents with a path also autosave after every edit; pass a path to save an untitled document or save a copy elsewhere (subsequent edits go to the new path).",
      inputSchema: { path: z.string().optional().describe("Absolute path; '.canvas.json' is appended if missing") },
    },
    async ({ path: filePath }) => {
      try {
        return text(`Saved ${await store.save(filePath)}`);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  );
}
