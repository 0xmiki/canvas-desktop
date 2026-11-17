import { EventEmitter } from "node:events";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { DesignRef, ProjectRef } from "../shared/ipc.ts";
import { DOCUMENT_EXTENSION } from "../shared/schema.ts";
import type { DocumentStore } from "./documentStore.ts";

const IGNORED_DIRS = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "coverage"]);
const MAX_SCAN_DEPTH = 4;
const MAX_DESIGNS = 500;

interface PersistedState {
  lastFile?: string | null;
  projects?: ProjectRef[];
}

export function designName(fileName: string): string {
  return fileName.endsWith(DOCUMENT_EXTENSION) ? fileName.slice(0, -DOCUMENT_EXTENSION.length) : fileName;
}

/** Turn user/agent input into a safe file name stem. */
export function sanitizeName(name: string): string {
  const cleaned = designName(name.trim())
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 80);
  return cleaned || "Untitled";
}

const isInside = (dir: string, file: string) => {
  const relative = path.relative(dir, file);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
};

/**
 * Projects are folders of `*.canvas.json` designs: a standalone folder, or a
 * `design/` folder inside a code repo so agents working there find them.
 * The workspace tracks known projects, the current one, and its designs.
 */
export class Workspace extends EventEmitter<{ change: [] }> {
  projects: ProjectRef[] = [];
  project: ProjectRef | null = null;
  designs: DesignRef[] = [];

  private watcher: fsSync.FSWatcher | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private lastFile: string | null = null;

  constructor(
    readonly store: DocumentStore,
    private readonly statePath: string,
    /** Where "New project" creates folders. */
    readonly projectsRoot: string,
    private readonly trash: (file: string) => Promise<void>,
  ) {
    super();
    store.on("change", () => {
      if (store.filePath !== this.lastFile) {
        this.lastFile = store.filePath;
        void this.syncProject().then(() => this.persist());
      }
    });
  }

  async restore(fileArg?: string) {
    let saved: PersistedState = {};
    try {
      saved = JSON.parse(await fs.readFile(this.statePath, "utf8")) as PersistedState;
    } catch {
      // First launch.
    }
    this.projects = (saved.projects ?? []).filter(
      (project) => typeof project?.path === "string" && fsSync.existsSync(project.path),
    );
    const target = fileArg ?? saved.lastFile;
    if (target) {
      try {
        await this.store.open(target);
        return;
      } catch (error) {
        console.error("[canvas] could not reopen", target, error);
      }
    }
    if (!(await this.store.restoreRecovery())) await this.syncProject();
  }

  /** Resolve a design reference: absolute path, path relative to the project, or a design name. */
  resolveDesign(reference: string): string {
    let target = reference.trim();
    if (target.startsWith("~/")) target = path.join(process.env.HOME ?? "", target.slice(2));
    if (!path.isAbsolute(target)) {
      const byName = this.designs.find((design) => design.name === designName(target));
      if (byName) return byName.path;
      if (!this.project) throw new Error(`"${reference}" is not an absolute path and no project is open.`);
      target = path.join(this.project.path, target);
    }
    if (!target.endsWith(".json")) target += DOCUMENT_EXTENSION;
    return path.resolve(target);
  }

  async openDesign(reference: string) {
    await this.store.open(this.resolveDesign(reference));
    // A missing file is created by open(); resync once it exists on disk.
    await this.syncProject();
  }

  /** Open (registering, and creating if needed) a project folder. */
  async openProject(dir: string, name?: string) {
    const absolute = path.resolve(dir.startsWith("~/") ? path.join(process.env.HOME ?? "", dir.slice(2)) : dir);
    await fs.mkdir(absolute, { recursive: true });
    this.register(absolute, name);
    const designs = await scanDesigns(absolute);
    if (designs.length) {
      const newest = await newestFile(designs.map((design) => design.path));
      await this.store.open(newest);
    } else {
      await this.store.open(path.join(absolute, `Untitled${DOCUMENT_EXTENSION}`));
    }
    await this.syncProject();
  }

  async newProject(name: string) {
    const folder = await uniquePath(this.projectsRoot, sanitizeName(name), "");
    await this.openProject(folder);
  }

  forgetProject(dir: string) {
    this.projects = this.projects.filter((project) => project.path !== dir);
    if (this.project?.path === dir) {
      this.project = null;
      this.designs = [];
      this.unwatch();
    }
    this.persist();
    this.emit("change");
  }

  /** New design in the current project, or an untitled document when there is none. */
  async newDesign(name?: string): Promise<string | null> {
    if (!this.project) {
      await this.store.newDocument();
      return null;
    }
    const target = await uniquePath(this.project.path, sanitizeName(name ?? "Untitled"), DOCUMENT_EXTENSION);
    await this.store.open(target);
    await this.syncProject();
    return target;
  }

  async renameDesign(file: string, newName: string): Promise<string> {
    const target = path.join(path.dirname(file), `${sanitizeName(newName)}${DOCUMENT_EXTENSION}`);
    if (target === file) return file;
    if (fsSync.existsSync(target)) throw new Error(`A design named "${sanitizeName(newName)}" already exists.`);
    const isOpen = file === this.store.filePath;
    if (isOpen) await this.store.flush();
    await fs.rename(file, target);
    if (isOpen) this.store.relocate(target);
    await this.rescan();
    return target;
  }

  /** Move a design to the system trash. Opens a neighbour if it was the open one. */
  async deleteDesign(file: string) {
    const isOpen = file === this.store.filePath;
    if (isOpen) await this.store.flush();
    await this.trash(file);
    await this.rescan();
    if (!isOpen) return;
    const next = this.designs.find((design) => design.path !== file);
    if (next) await this.store.open(next.path);
    else await this.newDesign();
  }

  async rescan() {
    this.designs = this.project ? await scanDesigns(this.project.path) : [];
    this.emit("change");
  }

  dispose() {
    this.unwatch();
  }

  private register(dir: string, name?: string) {
    const existing = this.projects.find((project) => project.path === dir);
    const entry = { path: dir, name: name ?? existing?.name ?? path.basename(dir) };
    this.projects = [entry, ...this.projects.filter((project) => project.path !== dir)];
  }

  /** Make the project containing the open file current, registering its folder if it's new. */
  private async syncProject() {
    const file = this.store.filePath;
    let next: ProjectRef | null = null;
    if (file) {
      next =
        this.projects
          .filter((project) => isInside(project.path, file))
          .sort((a, b) => b.path.length - a.path.length)[0] ?? null;
      if (!next) {
        this.register(path.dirname(file));
        next = this.projects[0]!;
      }
    }
    if (next?.path !== this.project?.path) {
      this.project = next;
      this.watch();
    }
    if (next) this.register(next.path, next.name); // most recent first
    await this.rescan();
  }

  private watch() {
    this.unwatch();
    if (!this.project) return;
    try {
      this.watcher = fsSync.watch(this.project.path, { recursive: true }, (_event, file) => {
        if (file && !String(file).endsWith(DOCUMENT_EXTENSION)) return;
        if (this.rescanTimer) clearTimeout(this.rescanTimer);
        this.rescanTimer = setTimeout(() => void this.rescan(), 150);
      });
      this.watcher.on("error", () => this.unwatch());
    } catch {
      // Watching is a convenience; explicit actions rescan anyway.
    }
  }

  private unwatch() {
    this.watcher?.close();
    this.watcher = null;
  }

  private persist() {
    const state: PersistedState = { lastFile: this.store.filePath, projects: this.projects };
    void fs
      .mkdir(path.dirname(this.statePath), { recursive: true })
      .then(() => fs.writeFile(this.statePath, JSON.stringify(state, null, 2)))
      .catch((error) => console.error("[canvas] could not save app state", error));
  }
}

export async function scanDesigns(root: string): Promise<DesignRef[]> {
  const found: DesignRef[] = [];
  const visit = async (dir: string, depth: number) => {
    if (found.length >= MAX_DESIGNS) return;
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_SCAN_DEPTH && !IGNORED_DIRS.has(entry.name)) await visit(full, depth + 1);
      } else if (entry.name.endsWith(DOCUMENT_EXTENSION)) {
        found.push({ name: designName(path.relative(root, full)), path: full });
      }
    }
  };
  await visit(root, 0);
  return found.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

async function newestFile(files: string[]): Promise<string> {
  const stats = await Promise.all(
    files.map(async (file) => ({ file, mtime: (await fs.stat(file).catch(() => null))?.mtimeMs ?? 0 })),
  );
  return stats.sort((a, b) => b.mtime - a.mtime)[0]!.file;
}

async function uniquePath(dir: string, stem: string, extension: string): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, `${n === 1 ? stem : `${stem} ${n}`}${extension}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
}
