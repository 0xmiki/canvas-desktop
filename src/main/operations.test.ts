import { describe, expect, test } from "bun:test";

import { emptyDocument, type FrameNode, type InstanceNode } from "../shared/schema.ts";
import { expandInstance, locate } from "../shared/tree.ts";
import { applyOperations, OperationError } from "./operations.ts";

const card = {
  type: "frame",
  id: "card",
  name: "Card",
  width: 320,
  layout: "column",
  gap: 8,
  padding: 16,
  fill: "#fff",
  component: true,
  children: [
    { type: "text", id: "title", text: "Title", fontSize: 20 },
    { type: "text", id: "body", text: "Body copy", fill: "#666" },
  ],
};

describe("applyOperations", () => {
  test("creates a nested tree with given and generated ids", () => {
    const { doc, results } = applyOperations(emptyDocument(), [{ op: "create", node: card }]);
    expect(results[0]!.id).toBe("card");
    expect(results[0]!.created).toContain('text#title "Title"'.replace(' "Title"', ""));
    const body = locate(doc, "body")!.node;
    // `fill` on text is the glyph color.
    expect(body).toMatchObject({ type: "text", color: "#666" });
    expect((body as unknown as Record<string, unknown>).fill).toBeUndefined();
  });

  test("infers types and generates ids", () => {
    const { doc } = applyOperations(emptyDocument(), [
      { op: "create", node: { children: [{ text: "hi" }, { icon: "search" }] } },
    ]);
    const root = doc.children[0] as FrameNode;
    expect(root.type).toBe("frame");
    expect(root.children.map((child) => child.type)).toEqual(["text", "icon"]);
    expect(root.id).toMatch(/^[a-z][a-z0-9]+$/);
  });

  test("is atomic: a failing op leaves the source untouched", () => {
    const source = emptyDocument();
    expect(() =>
      applyOperations(source, [
        { op: "create", node: { type: "rect", id: "a" } },
        { op: "update", id: "missing", set: { x: 1 } },
      ]),
    ).toThrow(OperationError);
    expect(source.children).toHaveLength(0);
  });

  test("rejects unknown props with a hint", () => {
    expect(() =>
      applyOperations(emptyDocument(), [
        { op: "create", node: { type: "frame", backgroundColor: "red", children: [] } },
      ]),
    ).toThrow(/Use "fill"/);
  });

  test("rejects duplicate ids and children on non-frames", () => {
    expect(() =>
      applyOperations(emptyDocument(), [
        { op: "create", node: { type: "rect", id: "a" } },
        { op: "create", node: { type: "rect", id: "a" } },
      ]),
    ).toThrow(/already in use/);
    expect(() =>
      applyOperations(emptyDocument(), [
        { op: "create", node: { type: "text", text: "x", children: [] } },
      ]),
    ).toThrow(/only frames/);
  });

  test("update sets and clears props; move, duplicate, delete", () => {
    let { doc } = applyOperations(emptyDocument(), [
      { op: "create", node: card },
      { op: "create", node: { type: "frame", id: "page", width: 800, height: 600, children: [] } },
    ]);
    ({ doc } = applyOperations(doc, [
      { op: "update", id: "title", set: { text: "Hello", fontSize: null } },
      { op: "move", id: "body", parent: "page", x: 10, y: 20 },
      { op: "duplicate", id: "page" },
      { op: "delete", id: "card" },
    ]));
    expect(locate(doc, "title")).toBeNull();
    expect(locate(doc, "body")!.parent!.id).toBe("page");
    expect(doc.children).toHaveLength(2);
    const copy = doc.children[1] as FrameNode;
    expect(copy.x).toBe(440 + 800 + 120); // page was auto-placed right of the card
    expect(copy.children[0]!.id).not.toBe("body");
  });

  test("refuses to move a node into its own descendant", () => {
    const { doc } = applyOperations(emptyDocument(), [{ op: "create", node: card }]);
    expect(() =>
      applyOperations(doc, [
        { op: "create", parent: "card", node: { type: "frame", id: "inner", children: [] } },
        { op: "move", id: "card", parent: "inner" },
      ]),
    ).toThrow(/into itself/);
  });

  test("instances expand with prefixed ids and accept overrides", () => {
    let { doc } = applyOperations(emptyDocument(), [
      { op: "create", node: card },
      { op: "create", node: { type: "instance", id: "c1", ref: "card", x: 400 } },
    ]);
    ({ doc } = applyOperations(doc, [{ op: "update", id: "c1/title", set: { text: "Overridden" } }]));
    const instance = locate(doc, "c1")!.node as InstanceNode;
    expect(instance.overrides).toEqual({ title: { text: "Overridden" } });
    const expanded = expandInstance(doc, instance)!;
    expect(expanded.x).toBe(400);
    expect(expanded.children[0]).toMatchObject({ id: "c1/title", text: "Overridden" });

    ({ doc } = applyOperations(doc, [{ op: "detach", id: "c1" }]));
    const detached = locate(doc, "c1")!.node as FrameNode;
    expect(detached.type).toBe("frame");
    expect(detached.component).toBeUndefined();
    expect(detached.children[0]).toMatchObject({ type: "text", text: "Overridden" });
  });

  test("variables merge and delete", () => {
    let { doc } = applyOperations(emptyDocument(), [
      { op: "variables", set: { primary: "#4f46e5", $radius: 12 } },
    ]);
    expect(doc.variables).toEqual({ primary: "#4f46e5", radius: 12 });
    ({ doc } = applyOperations(doc, [{ op: "variables", set: { primary: null } }]));
    expect(doc.variables).toEqual({ radius: 12 });
  });

  test("validates icon names when a catalog is available", () => {
    expect(() =>
      applyOperations(
        emptyDocument(),
        [{ op: "create", node: { type: "icon", icon: "serch" } }],
        { iconExists: (name) => name === "search", suggestIcons: () => ["search"] },
      ),
    ).toThrow(/Did you mean: search/);
  });
});
