import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { DocumentStore } from "./documentStore.ts";
import { sanitizeName, scanDesigns, Workspace } from "./workspace.ts";

let root: string;
let trashed: string[];

function makeWorkspace() {
  const store = new DocumentStore(path.join(root, "recovery.canvas.json"), {});
  const workspace = new Workspace(store, path.join(root, "state.json"), path.join(root, "Canvas"), async (file) => {
    trashed.push(file);
    await fs.rm(file);
  });
  return { store, workspace };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-ws-"));
  trashed = [];
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("Workspace", () => {
  test("opening an empty project folder creates and opens a first design", async () => {
    const { store, workspace } = makeWorkspace();
    await workspace.openProject(path.join(root, "app", "design"));
    expect(workspace.project?.name).toBe("design");
    expect(store.filePath).toBe(path.join(root, "app", "design", "Untitled.canvas.json"));
    expect(workspace.designs.map((d) => d.name)).toEqual(["Untitled"]);
    workspace.dispose();
  });

  test("new designs get unique names and open; names resolve to paths", async () => {
    const { store, workspace } = makeWorkspace();
    await workspace.openProject(path.join(root, "p"));
    await workspace.newDesign();
    await workspace.newDesign("Checkout / flow");
    expect(workspace.designs.map((d) => d.name)).toEqual(["Checkout - flow", "Untitled", "Untitled 2"]);
    expect(path.basename(store.filePath!)).toBe("Checkout - flow.canvas.json");
    expect(workspace.resolveDesign("Untitled 2")).toBe(path.join(root, "p", "Untitled 2.canvas.json"));
    expect(workspace.resolveDesign("sub/New")).toBe(path.join(root, "p", "sub", "New.canvas.json"));
    workspace.dispose();
  });

  test("renaming the open design keeps editing it at the new path", async () => {
    const { store, workspace } = makeWorkspace();
    await workspace.openProject(path.join(root, "p"));
    store.apply([{ op: "create", node: { type: "rect", id: "r" } }], "add");
    const renamed = await workspace.renameDesign(store.filePath!, "Home");
    expect(store.filePath).toBe(renamed);
    expect(JSON.parse(await fs.readFile(renamed, "utf8")).children[0].id).toBe("r");
    await expect(workspace.renameDesign(renamed, "Home")).resolves.toBe(renamed);
    workspace.dispose();
  });

  test("deleting the open design trashes it and opens a neighbour", async () => {
    const { store, workspace } = makeWorkspace();
    await workspace.openProject(path.join(root, "p"));
    const first = store.filePath!;
    await workspace.newDesign("Second");
    const second = store.filePath!;
    await workspace.deleteDesign(second);
    expect(trashed).toEqual([second]);
    expect(store.filePath).toBe(first);
    await workspace.deleteDesign(first);
    // The last design is replaced by a fresh one so the project is never empty-handed.
    expect(store.filePath).toBe(path.join(root, "p", "Untitled.canvas.json"));
    workspace.dispose();
  });

  test("opening a file outside known projects registers its folder; state persists", async () => {
    const { workspace } = makeWorkspace();
    const loose = path.join(root, "loose", "Idea.canvas.json");
    await workspace.openDesign(loose);
    await new Promise((resolve) => setTimeout(resolve, 50)); // persist is fire-and-forget
    expect(workspace.project?.path).toBe(path.join(root, "loose"));
    const saved = JSON.parse(await fs.readFile(path.join(root, "state.json"), "utf8"));
    expect(saved.lastFile).toBe(loose);
    expect(saved.projects[0].path).toBe(path.join(root, "loose"));

    const restored = makeWorkspace();
    await restored.workspace.restore();
    expect(restored.store.filePath).toBe(loose);
    expect(restored.workspace.project?.name).toBe("loose");
    workspace.dispose();
    restored.workspace.dispose();
  });
});

test("scanDesigns skips dependency and hidden folders", async () => {
  for (const file of ["a.canvas.json", "flows/b.canvas.json", "node_modules/x/c.canvas.json", ".git/d.canvas.json", "e.json"]) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), "{}");
  }
  expect((await scanDesigns(root)).map((d) => d.name)).toEqual(["a", "flows/b"]);
});

test("sanitizeName", () => {
  expect(sanitizeName("  ../etc/passwd ")).toBe("-etc-passwd");
  expect(sanitizeName("Home.canvas.json")).toBe("Home");
  expect(sanitizeName("   ")).toBe("Untitled");
});
