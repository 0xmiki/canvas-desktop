import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  DOCUMENT_EXTENSION,
  DOCUMENT_FORMAT,
  emptyDocument,
  type DesignDocument,
} from "../shared/schema.ts";
import type { Activity } from "../shared/ipc.ts";
import { locate } from "../shared/tree.ts";
import {
  applyOperations,
  type Operation,
  type OperationResult,
  type ValidationContext,
} from "./operations.ts";

const HISTORY_LIMIT = 200;
const AUTOSAVE_DELAY_MS = 500;

interface HistoryEntry {
  doc: DesignDocument;
  label: string;
}

/**
 * Owns the open document: edits, undo/redo, selection and persistence.
 * Documents with a path autosave; untitled documents autosave to a recovery
 * file so nothing an agent built is lost on quit.
 */
export class DocumentStore extends EventEmitter<{ change: [] }> {
  doc: DesignDocument = emptyDocument();
  version = 0;
  filePath: string | null = null;
  dirty = false;
  selection: string[] = [];
  activity: Activity | null = null;

  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private saveTimer: NodeJS.Timeout | null = null;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly recoveryPath: string,
    private readonly validation: ValidationContext,
  ) {
    super();
  }

  apply(operations: Operation[], label: string): OperationResult[] {
    const { doc, results } = applyOperations(this.doc, operations, this.validation);
    const touched = new Set<string>();
    for (const result of results) if (result.id) touched.add(result.id);
    this.commit(doc, label, [...touched]);
    return results;
  }

  /** Replace the document with an already-validated one as a single undo step. */
  commit(doc: DesignDocument, label: string, touched: string[] = []) {
    this.undoStack.push({ doc: this.doc, label });
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.doc = doc;
    this.activity = { label, ids: touched, at: Date.now() };
    this.afterEdit();
  }

  undo(steps = 1): string[] {
    const labels: string[] = [];
    for (let i = 0; i < steps; i++) {
      const entry = this.undoStack.pop();
      if (!entry) break;
      this.redoStack.push({ doc: this.doc, label: entry.label });
      this.doc = entry.doc;
      labels.push(entry.label);
    }
    if (labels.length) {
      this.activity = { label: `Undo ${labels.join(", ")}`, ids: [], at: Date.now() };
      this.afterEdit();
    }
    return labels;
  }

  redo(steps = 1): string[] {
    const labels: string[] = [];
    for (let i = 0; i < steps; i++) {
      const entry = this.redoStack.pop();
      if (!entry) break;
      this.undoStack.push({ doc: this.doc, label: entry.label });
      this.doc = entry.doc;
      labels.push(entry.label);
    }
    if (labels.length) {
      this.activity = { label: `Redo ${labels.join(", ")}`, ids: [], at: Date.now() };
      this.afterEdit();
    }
    return labels;
  }

  history() {
    return {
      undo: this.undoStack.map((entry) => entry.label).reverse(),
      redo: this.redoStack.map((entry) => entry.label).reverse(),
    };
  }

  setSelection(ids: string[]) {
    const next = ids.filter((id) => locate(this.doc, id) || id.includes("/"));
    if (next.length === this.selection.length && next.every((id, i) => id === this.selection[i])) return;
    this.selection = next;
    this.emit("change");
  }

  async newDocument() {
    await this.flush();
    this.reset(emptyDocument(), null);
  }

  async open(filePath: string) {
    const absolute = path.resolve(filePath);
    let doc: DesignDocument;
    let created = false;
    try {
      doc = parseDocument(await fs.readFile(absolute, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      doc = emptyDocument(); // Opening a path that doesn't exist yet creates it.
      created = true;
    }
    await this.flush();
    this.reset(doc, absolute);
    if (created) await this.writeTo(absolute);
  }

  async restoreRecovery(): Promise<boolean> {
    try {
      const doc = parseDocument(await fs.readFile(this.recoveryPath, "utf8"));
      this.reset(doc, null);
      return true;
    } catch {
      return false;
    }
  }

  async save(filePath?: string): Promise<string> {
    let target = filePath ? path.resolve(filePath) : this.filePath;
    if (!target) throw new Error("This document is untitled. Pass a path to save it.");
    if (!target.endsWith(".json")) target += DOCUMENT_EXTENSION;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.writeTo(target);
    if (target !== this.filePath) {
      this.filePath = target;
      this.emit("change");
    }
    return target;
  }

  /** The open file was moved on disk (e.g. renamed); keep editing it at its new path. */
  relocate(filePath: string) {
    this.filePath = filePath;
    this.emit("change");
  }

  /** Wait for pending writes. Call before switching documents or quitting. */
  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.writeCurrent();
    }
    await this.saving;
  }

  private reset(doc: DesignDocument, filePath: string | null) {
    this.doc = doc;
    this.filePath = filePath;
    this.undoStack = [];
    this.redoStack = [];
    this.selection = [];
    this.activity = null;
    this.dirty = false;
    this.version++;
    this.emit("change");
  }

  private afterEdit() {
    this.version++;
    this.dirty = true;
    this.selection = this.selection.filter((id) => locate(this.doc, id) || id.includes("/"));
    this.emit("change");
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.writeCurrent();
    }, AUTOSAVE_DELAY_MS);
  }

  private writeCurrent() {
    return this.writeTo(this.filePath ?? this.recoveryPath).catch((error) => {
      console.error("[canvas] autosave failed", error);
    });
  }

  private writeTo(target: string): Promise<void> {
    const doc = this.doc;
    const version = this.version;
    this.saving = this.saving.then(async () => {
      await fs.mkdir(path.dirname(target), { recursive: true });
      const temp = `${target}.${process.pid}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify(doc, null, 2)}\n`);
      await fs.rename(temp, target);
      if (target === this.filePath && version === this.version && this.dirty) {
        this.dirty = false;
        this.emit("change");
      }
    });
    return this.saving;
  }
}

export function parseDocument(text: string): DesignDocument {
  const value = JSON.parse(text) as Partial<DesignDocument>;
  if (typeof value !== "object" || value === null || !Array.isArray(value.children)) {
    throw new Error("Not a canvas document (missing children array).");
  }
  return {
    format: DOCUMENT_FORMAT,
    variables: value.variables && typeof value.variables === "object" ? value.variables : {},
    children: value.children,
  };
}
