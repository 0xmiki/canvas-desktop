import type { DesignDocument, DesignNode, FrameNode, InstanceNode } from "./schema.ts";

export interface NodeLocation {
  node: DesignNode;
  /** The containing frame, or null for top-level nodes. */
  parent: FrameNode | null;
  /** The array that holds the node (parent.children or doc.children). */
  siblings: DesignNode[];
  index: number;
  /** Ids from the top level down to the node, inclusive. */
  path: string[];
}

export function locate(doc: DesignDocument, id: string): NodeLocation | null {
  const visit = (
    siblings: DesignNode[],
    parent: FrameNode | null,
    path: string[],
  ): NodeLocation | null => {
    for (let index = 0; index < siblings.length; index++) {
      const node = siblings[index]!;
      const nodePath = [...path, node.id];
      if (node.id === id) return { node, parent, siblings, index, path: nodePath };
      if (node.type === "frame") {
        const found = visit(node.children, node, nodePath);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(doc.children, null, []);
}

/** Depth-first walk. Return false from the callback to skip a node's children. */
export function walk(
  nodes: DesignNode[],
  callback: (node: DesignNode, parent: FrameNode | null, depth: number) => boolean | void,
  parent: FrameNode | null = null,
  depth = 0,
): void {
  for (const node of nodes) {
    if (callback(node, parent, depth) === false) continue;
    if (node.type === "frame") walk(node.children, callback, node, depth + 1);
  }
}

export function collectIds(nodes: DesignNode[], into = new Set<string>()): Set<string> {
  walk(nodes, (node) => {
    into.add(node.id);
  });
  return into;
}

export function findComponent(doc: DesignDocument, id: string): FrameNode | null {
  const location = locate(doc, id);
  if (!location || location.node.type !== "frame" || !location.node.component) return null;
  return location.node;
}

const INSTANCE_OWN_KEYS = new Set(["id", "type", "ref", "overrides", "name"]);
const MAX_INSTANCE_DEPTH = 12;

/**
 * Expand an instance into the frame tree it renders as. Descendant ids are
 * prefixed with the instance id ("card/title"), which is also how agents
 * address them for overrides. Returns null when the component is missing.
 */
export function expandInstance(
  doc: DesignDocument,
  instance: InstanceNode,
  inheritedOverrides: Record<string, Record<string, unknown>> = {},
  depth = 0,
): FrameNode | null {
  if (depth > MAX_INSTANCE_DEPTH) return null;
  const component = findComponent(doc, instance.ref);
  if (!component) return null;
  const overrides = { ...instance.overrides, ...inheritedOverrides };

  const rootOverrides: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(instance)) {
    if (!INSTANCE_OWN_KEYS.has(key) && value !== undefined) rootOverrides[key] = value;
  }

  const cloneChild = (node: DesignNode): DesignNode => {
    const prefixedId = `${instance.id}/${node.id}`;
    const patch = overrides[node.id] ?? {};
    if (node.type === "instance") {
      const nested: Record<string, Record<string, unknown>> = {};
      const prefix = `${node.id}/`;
      for (const [key, value] of Object.entries(overrides)) {
        if (key.startsWith(prefix)) nested[key.slice(prefix.length)] = value;
      }
      const nestedInstance = { ...node, ...patch, id: prefixedId } as InstanceNode;
      return (
        expandInstance(doc, nestedInstance, nested, depth + 1) ?? {
          ...missingComponent(nestedInstance),
        }
      );
    }
    const copy = { ...node, ...patch, id: prefixedId } as DesignNode;
    if (copy.type === "frame") {
      copy.component = undefined;
      copy.children = (node as FrameNode).children.map(cloneChild);
    }
    return copy;
  };

  const root: FrameNode = {
    ...component,
    ...rootOverrides,
    ...(overrides[component.id] ?? {}),
    id: instance.id,
    type: "frame",
    name: instance.name ?? component.name,
    component: undefined,
    children: component.children.map(cloneChild),
  } as FrameNode;
  return root;
}

export function missingComponent(instance: InstanceNode): FrameNode {
  return {
    id: instance.id,
    type: "frame",
    name: instance.name ?? "Missing component",
    x: instance.x,
    y: instance.y,
    width: typeof instance.width === "number" ? instance.width : 120,
    height: typeof instance.height === "number" ? instance.height : 48,
    stroke: { color: "#ef4444", width: 1, style: "dashed" },
    fill: "rgba(239,68,68,0.08)",
    children: [],
  };
}

/** Replace every `$name` string with its variable value (one level, no recursion). */
export function resolveValue<T>(value: T, variables: Record<string, string | number>): T {
  if (typeof value === "string" && value.startsWith("$")) {
    const resolved = variables[value.slice(1)];
    return (resolved === undefined ? value : resolved) as T;
  }
  return value;
}
