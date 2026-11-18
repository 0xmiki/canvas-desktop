// Pure document operations. Every mutation an agent makes goes through
// applyOperations(), which works on a copy and either applies the whole batch
// or nothing, so a failed batch never leaves a half-built design behind.

import {
  DEFAULT_ICON_SET,
  ICON_SETS,
  LEGACY_ICON_SET,
  NODE_PROPS,
  PHOSPHOR_WEIGHTS,
  NODE_TYPES,
  PROP_HINTS,
  type DesignDocument,
  type DesignNode,
  type FrameNode,
  type IconSet,
  type NodeType,
  type VariableValue,
} from "../shared/schema.ts";
import { collectIds, expandInstance, locate, walk } from "../shared/tree.ts";

export type Operation =
  | { op: "create"; parent?: string | null; index?: number; node: Record<string, unknown> }
  | { op: "update"; id: string; set: Record<string, unknown> }
  | { op: "delete"; id: string }
  | {
      op: "move";
      id: string;
      parent?: string | null;
      index?: number;
      x?: number;
      y?: number;
    }
  | {
      op: "duplicate";
      id: string;
      parent?: string | null;
      index?: number;
      x?: number;
      y?: number;
      set?: Record<string, unknown>;
    }
  | { op: "replace"; id: string; node: Record<string, unknown> }
  | { op: "detach"; id: string }
  | { op: "variables"; set: Record<string, VariableValue | null> };

export interface OperationResult {
  op: Operation["op"];
  id?: string;
  /** Compact outline of the nodes an op created. */
  created?: string;
}

export interface ValidationContext {
  iconExists?: (name: string, set: IconSet) => boolean;
  suggestIcons?: (name: string, set: IconSet) => string[];
}

export class OperationError extends Error {}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// Property validation

const NUMBER_PROPS = new Set([
  "opacity",
  "rotation",
  "x",
  "y",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "blur",
  "backdropBlur",
  "gap",
  "rowGap",
  "columnGap",
  "fontSize",
  "letterSpacing",
  "maxLines",
  "size",
  "strokeWidth",
]);
const BOOLEAN_PROPS = new Set(["visible", "absolute", "wrap", "clip", "component"]);
const STRING_PROPS = new Set([
  "name",
  "notes",
  "text",
  "fontFamily",
  "src",
  "icon",
  "d",
  "viewBox",
  "svg",
  "ref",
  "blendMode",
]);
const ENUM_PROPS: Record<string, readonly string[]> = {
  layout: ["none", "row", "column", "grid"],
  justify: ["start", "center", "end", "space-between", "space-around", "space-evenly"],
  align: ["start", "center", "end", "stretch", "baseline"],
  textAlign: ["left", "center", "right", "justify"],
  textDecoration: ["none", "underline", "line-through"],
  textTransform: ["none", "uppercase", "lowercase", "capitalize"],
  fontStyle: ["normal", "italic"],
  fit: ["cover", "contain", "fill"],
  fillRule: ["nonzero", "evenodd"],
  set: ICON_SETS,
  weight: PHOSPHOR_WEIGHTS,
};

const isVariableRef = (value: unknown) => typeof value === "string" && value.startsWith("$");
const isNumberish = (value: unknown) =>
  (typeof value === "number" && Number.isFinite(value)) || isVariableRef(value);

function checkPaint(value: unknown, key: string): string | null {
  if (typeof value === "string") return null;
  if (typeof value !== "object" || value === null) return `${key} must be a color string or paint object`;
  const paint = value as Record<string, unknown>;
  if (paint.type === "linear" || paint.type === "radial") {
    if (!Array.isArray(paint.stops) || paint.stops.length < 2)
      return `${key}: a gradient needs at least 2 stops like {color:"#000", position:0}`;
    for (const stop of paint.stops as unknown[]) {
      const s = stop as Record<string, unknown>;
      if (typeof s?.color !== "string" || typeof s?.position !== "number")
        return `${key}: each gradient stop needs {color: string, position: 0..1}`;
    }
    return null;
  }
  if (paint.type === "image") {
    return typeof paint.src === "string" ? null : `${key}: image paint needs a "src" string`;
  }
  return `${key}: paint objects need type "linear", "radial" or "image"`;
}

function checkValue(key: string, value: unknown): string | null {
  if (NUMBER_PROPS.has(key)) return isNumberish(value) ? null : `${key} must be a number`;
  if (BOOLEAN_PROPS.has(key)) return typeof value === "boolean" ? null : `${key} must be a boolean`;
  if (STRING_PROPS.has(key)) return typeof value === "string" ? null : `${key} must be a string`;
  const options = ENUM_PROPS[key];
  if (options) {
    return options.includes(value as string)
      ? null
      : `${key} must be one of ${options.map((o) => `"${o}"`).join(", ")}`;
  }
  switch (key) {
    case "width":
    case "height":
      return isNumberish(value) || value === "fill" || value === "hug"
        ? null
        : `${key} must be a number, "fill" or "hug"`;
    case "fontWeight":
      return isNumberish(value) || typeof value === "string" ? null : `fontWeight must be a number`;
    case "lineHeight":
      return isNumberish(value) || typeof value === "string"
        ? null
        : `lineHeight must be a number (multiplier) or CSS string`;
    case "columns":
    case "rows":
      return isNumberish(value) || typeof value === "string"
        ? null
        : `${key} must be a count or a CSS grid template string`;
    case "fill":
      if (Array.isArray(value)) {
        for (const paint of value) {
          const error = checkPaint(paint, key);
          if (error) return error;
        }
        return null;
      }
      return checkPaint(value, key);
    case "color":
      return checkPaint(value, key);
    case "stroke": {
      if (typeof value !== "object" || value === null || Array.isArray(value))
        return `stroke must be an object like {color:"#e5e7eb", width:1}`;
      const stroke = value as Record<string, unknown>;
      if (typeof stroke.color !== "string") return `stroke.color must be a color string`;
      if (stroke.width !== undefined && !isNumberish(stroke.width)) return `stroke.width must be a number`;
      if (stroke.style !== undefined && !["solid", "dashed", "dotted"].includes(stroke.style as string))
        return `stroke.style must be "solid", "dashed" or "dotted"`;
      if (stroke.align !== undefined && !["inside", "center", "outside"].includes(stroke.align as string))
        return `stroke.align must be "inside", "center" or "outside"`;
      return null;
    }
    case "radius":
      if (isNumberish(value)) return null;
      return Array.isArray(value) && value.length === 4 && value.every(isNumberish)
        ? null
        : `radius must be a number or [topLeft, topRight, bottomRight, bottomLeft]`;
    case "padding":
      if (isNumberish(value)) return null;
      return Array.isArray(value) && (value.length === 2 || value.length === 4) && value.every(isNumberish)
        ? null
        : `padding must be a number, [vertical, horizontal] or [top, right, bottom, left]`;
    case "shadow": {
      const shadows = Array.isArray(value) ? value : [value];
      for (const shadow of shadows) {
        if (typeof shadow !== "object" || shadow === null)
          return `shadow must be an object like {x:0, y:4, blur:12, color:"rgba(0,0,0,0.1)"}`;
      }
      return null;
    }
    case "overrides":
      return typeof value === "object" && value !== null && !Array.isArray(value)
        ? null
        : `overrides must be an object keyed by component descendant id`;
    default:
      return null;
  }
}

function unknownPropMessage(type: NodeType, key: string): string {
  const hint = PROP_HINTS[key];
  if (hint) return `Unknown property "${key}" on ${type}. Use "${hint}" instead.`;
  return `Unknown property "${key}" on ${type}. Allowed: ${NODE_PROPS[type]
    .filter((prop) => prop !== "id" && prop !== "type")
    .join(", ")}`;
}

/**
 * Normalize friendly shorthands into canonical properties, then validate.
 * Mutates `props` in place.
 */
function normalizeProps(
  type: NodeType,
  props: Record<string, unknown>,
  context: ValidationContext,
  where: string,
  /** The node being updated, so icon names validate against its set. */
  existing?: Record<string, unknown>,
): void {
  // Text and icon glyph color: accept `fill` as the obvious alias.
  if ((type === "text" || type === "icon") && "fill" in props && !("color" in props)) {
    props.color = props.fill;
    delete props.fill;
  }
  // stroke: "#ddd" shorthand.
  if (typeof props.stroke === "string") props.stroke = { color: props.stroke, width: 1 };

  const allowed = NODE_PROPS[type];
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    if (!allowed.includes(key)) throw new OperationError(`${where}: ${unknownPropMessage(type, key)}`);
    if (value === null) continue; // null clears a property on update
    const error = checkValue(key, value);
    if (error) throw new OperationError(`${where}: ${error}`);
  }
  if (type === "icon" && context.iconExists) {
    const name = (props.icon ?? existing?.icon) as unknown;
    const set = ((props.set ?? existing?.set) as IconSet | undefined) ?? LEGACY_ICON_SET;
    const changed = "icon" in props || "set" in props;
    if (changed && typeof name === "string" && !context.iconExists(name, set)) {
      const suggestions = context.suggestIcons?.(name, set) ?? [];
      const other: IconSet = set === "phosphor" ? "lucide" : "phosphor";
      const inOther = context.iconExists(name, other) ? ` "${name}" exists in ${other}: add set: "${other}" to use it.` : "";
      throw new OperationError(
        `${where}: unknown ${set} icon "${name}".` +
          (suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : " Use list_icons to search.") +
          inOther,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Node construction

function inferType(input: Record<string, unknown>): NodeType | null {
  if (Array.isArray(input.children)) return "frame";
  if (typeof input.text === "string") return "text";
  if (typeof input.icon === "string") return "icon";
  if (typeof input.ref === "string") return "instance";
  if (typeof input.src === "string") return "image";
  if (typeof input.d === "string") return "path";
  if (typeof input.svg === "string") return "svg";
  return null;
}

class IdAllocator {
  constructor(private readonly taken: Set<string>) {}

  claim(id: string, where: string): string {
    if (!ID_PATTERN.test(id))
      throw new OperationError(`${where}: id "${id}" may only contain letters, digits, "_" and "-"`);
    if (this.taken.has(id)) throw new OperationError(`${where}: id "${id}" is already in use`);
    this.taken.add(id);
    return id;
  }

  release(id: string) {
    this.taken.delete(id);
  }

  generate(): string {
    for (;;) {
      const id = Math.random().toString(36).slice(2, 7);
      if (!this.taken.has(id) && /^[a-z]/.test(id)) {
        this.taken.add(id);
        return id;
      }
    }
  }
}

function buildNode(
  input: unknown,
  ids: IdAllocator,
  context: ValidationContext,
  where: string,
): DesignNode {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new OperationError(`${where}: node must be an object`);
  const props: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  const type = (props.type as NodeType | undefined) ?? inferType(props);
  if (!type || !NODE_TYPES.includes(type))
    throw new OperationError(
      `${where}: missing or invalid "type". Use one of: ${NODE_TYPES.join(", ")}`,
    );
  props.type = type;
  const label = `${where} (${type}${typeof props.name === "string" ? ` "${props.name}"` : ""})`;

  const rawChildren = props.children;
  delete props.children;
  if (rawChildren !== undefined && type !== "frame")
    throw new OperationError(`${label}: only frames can have children`);
  if (rawChildren !== undefined && !Array.isArray(rawChildren))
    throw new OperationError(`${label}: children must be an array`);

  if (type === "icon" && props.set === undefined) props.set = DEFAULT_ICON_SET;
  normalizeProps(type, props, context, label);
  for (const [key, value] of Object.entries(props)) if (value === null) delete props[key];

  props.id = props.id === undefined ? ids.generate() : ids.claim(String(props.id), label);

  switch (type) {
    case "text":
      if (typeof props.text !== "string") throw new OperationError(`${label}: text nodes need "text"`);
      break;
    case "image":
      if (typeof props.src !== "string") throw new OperationError(`${label}: image nodes need "src"`);
      break;
    case "icon":
      if (typeof props.icon !== "string") throw new OperationError(`${label}: icon nodes need "icon"`);
      break;
    case "path":
      if (typeof props.d !== "string") throw new OperationError(`${label}: path nodes need "d"`);
      break;
    case "svg":
      if (typeof props.svg !== "string") throw new OperationError(`${label}: svg nodes need "svg"`);
      break;
    case "instance":
      if (typeof props.ref !== "string") throw new OperationError(`${label}: instance nodes need "ref"`);
      break;
  }

  if (type === "frame") {
    const children = (rawChildren as unknown[] | undefined) ?? [];
    (props as unknown as FrameNode).children = children.map((child, index) =>
      buildNode(child, ids, context, `${where}.children[${index}]`),
    );
  }
  return props as unknown as DesignNode;
}

function cloneWithNewIds(node: DesignNode, ids: IdAllocator): DesignNode {
  const copy = structuredClone(node);
  walk([copy], (child) => {
    child.id = ids.generate();
  });
  return copy;
}

// ---------------------------------------------------------------------------
// Outline (compact description of nodes for tool results)

export function outline(nodes: DesignNode[], maxLines = 120): string {
  const lines: string[] = [];
  let truncated = 0;
  walk(nodes, (node, _parent, depth) => {
    if (lines.length >= maxLines) {
      truncated++;
      return;
    }
    let label = `${"  ".repeat(depth)}${node.type}#${node.id}`;
    if (node.name) label += ` "${node.name}"`;
    if (node.type === "text") label += ` ${JSON.stringify(node.text.length > 40 ? `${node.text.slice(0, 40)}…` : node.text)}`;
    if (node.type === "icon") label += ` <${node.icon}>`;
    if (node.type === "instance") label += ` -> ${node.ref}`;
    if (node.type === "frame" && node.component) label += " [component]";
    lines.push(label);
  });
  if (truncated) lines.push(`… ${truncated} more nodes`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Apply

function resolveParent(doc: DesignDocument, parentId: string | null | undefined, where: string) {
  if (parentId === undefined || parentId === null || parentId === "" || parentId === "root") {
    return { siblings: doc.children, parent: null as FrameNode | null };
  }
  const location = locate(doc, parentId);
  if (!location) throw new OperationError(`${where}: parent "${parentId}" not found`);
  if (location.node.type !== "frame")
    throw new OperationError(`${where}: parent "${parentId}" is a ${location.node.type}; only frames hold children`);
  return { siblings: location.node.children, parent: location.node };
}

function insertAt<T>(array: T[], item: T, index: number | undefined) {
  if (index === undefined || index < 0 || index >= array.length) array.push(item);
  else array.splice(index, 0, item);
}

function mustLocate(doc: DesignDocument, id: string, where: string) {
  const location = locate(doc, id);
  if (!location) {
    if (id.includes("/"))
      throw new OperationError(
        `${where}: "${id}" is inside a component instance. Use update to override its properties, or detach the instance first.`,
      );
    throw new OperationError(`${where}: node "${id}" not found`);
  }
  return location;
}

/** Place a new top-level node to the right of everything else when it has no position. */
function autoPlace(doc: DesignDocument, node: DesignNode) {
  if (node.x !== undefined || node.y !== undefined) return;
  let right = -Infinity;
  for (const other of doc.children) {
    if (other === node) continue;
    const width = typeof other.width === "number" ? other.width : 400;
    right = Math.max(right, (other.x ?? 0) + width);
  }
  node.x = right === -Infinity ? 0 : right + 120;
  node.y = 0;
}

function applyUpdate(
  doc: DesignDocument,
  id: string,
  set: Record<string, unknown>,
  context: ValidationContext,
  where: string,
) {
  if (typeof set !== "object" || set === null) throw new OperationError(`${where}: "set" must be an object`);
  for (const key of ["id", "type", "children"]) {
    if (key in set)
      throw new OperationError(
        `${where}: "${key}" can't be changed with update. ${key === "children" ? "Use create/move/delete for children." : "Use replace."}`,
      );
  }

  // Overrides inside component instances: "instanceId/descendantId".
  if (id.includes("/") && !locate(doc, id)) {
    const [instanceId, ...rest] = id.split("/");
    const location = mustLocate(doc, instanceId!, where);
    if (location.node.type !== "instance")
      throw new OperationError(`${where}: "${instanceId}" is not an instance`);
    const expanded = expandInstance(doc, location.node);
    const target = expanded && findExpanded(expanded, id);
    if (!target) throw new OperationError(`${where}: "${id}" not found inside instance "${instanceId}"`);
    const patch = { ...set };
    normalizeProps(
      target.type,
      patch,
      context,
      `${where} (${target.type} override)`,
      target as unknown as Record<string, unknown>,
    );
    const key = rest.join("/");
    const overrides = { ...location.node.overrides };
    const merged: Record<string, unknown> = { ...overrides[key] };
    for (const [prop, value] of Object.entries(patch)) {
      if (value === null) delete merged[prop];
      else merged[prop] = value;
    }
    if (Object.keys(merged).length) overrides[key] = merged;
    else delete overrides[key];
    location.node.overrides = overrides;
    return;
  }

  const location = mustLocate(doc, id, where);
  const node = location.node as unknown as Record<string, unknown>;
  const patch = { ...set };
  normalizeProps(location.node.type, patch, context, `${where} (${location.node.type} "${id}")`, node);
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete node[key];
    else node[key] = value;
  }
}

function findExpanded(root: DesignNode, id: string): DesignNode | null {
  let found: DesignNode | null = null;
  walk([root], (node) => {
    if (node.id === id) found = node;
  });
  return found;
}

export function applyOperations(
  source: DesignDocument,
  operations: Operation[],
  context: ValidationContext = {},
): { doc: DesignDocument; results: OperationResult[] } {
  const doc = structuredClone(source);
  const ids = new IdAllocator(collectIds(doc.children));
  const results: OperationResult[] = [];

  operations.forEach((operation, index) => {
    const where = `ops[${index}] ${operation?.op ?? "?"}`;
    if (typeof operation !== "object" || operation === null)
      throw new OperationError(`ops[${index}]: operation must be an object`);
    switch (operation.op) {
      case "create": {
        const { siblings } = resolveParent(doc, operation.parent, where);
        const node = buildNode(operation.node, ids, context, `${where}.node`);
        insertAt(siblings, node, operation.index);
        if (siblings === doc.children) autoPlace(doc, node);
        results.push({ op: "create", id: node.id, created: outline([node]) });
        break;
      }
      case "update": {
        applyUpdate(doc, operation.id, operation.set, context, where);
        results.push({ op: "update", id: operation.id });
        break;
      }
      case "delete": {
        const location = mustLocate(doc, operation.id, where);
        location.siblings.splice(location.index, 1);
        results.push({ op: "delete", id: operation.id });
        break;
      }
      case "move": {
        const location = mustLocate(doc, operation.id, where);
        if (operation.parent !== undefined) {
          const target = resolveParent(doc, operation.parent, where);
          if (target.parent && locate(doc, target.parent.id)?.path.includes(operation.id))
            throw new OperationError(`${where}: can't move a node into itself`);
          location.siblings.splice(location.index, 1);
          insertAt(target.siblings, location.node, operation.index);
        } else if (operation.index !== undefined) {
          location.siblings.splice(location.index, 1);
          insertAt(location.siblings, location.node, operation.index);
        }
        if (operation.x !== undefined) location.node.x = operation.x;
        if (operation.y !== undefined) location.node.y = operation.y;
        results.push({ op: "move", id: operation.id });
        break;
      }
      case "duplicate": {
        const location = mustLocate(doc, operation.id, where);
        const copy = cloneWithNewIds(location.node, ids);
        if (operation.set) {
          const patch = { ...operation.set };
          normalizeProps(copy.type, patch, context, where, copy as unknown as Record<string, unknown>);
          Object.assign(copy, patch);
        }
        if (operation.parent !== undefined) {
          const target = resolveParent(doc, operation.parent, where);
          insertAt(target.siblings, copy, operation.index);
        } else {
          insertAt(location.siblings, copy, operation.index ?? location.index + 1);
          if (location.parent === null && operation.x === undefined && operation.y === undefined) {
            const width = typeof location.node.width === "number" ? location.node.width : 400;
            copy.x = (location.node.x ?? 0) + width + 120;
            copy.y = location.node.y ?? 0;
          }
        }
        if (operation.x !== undefined) copy.x = operation.x;
        if (operation.y !== undefined) copy.y = operation.y;
        results.push({ op: "duplicate", id: copy.id, created: outline([copy]) });
        break;
      }
      case "replace": {
        const location = mustLocate(doc, operation.id, where);
        // The replacement keeps the id so references stay valid.
        const old = collectIds([location.node]);
        for (const id of old) ids.release(id);
        const input = { ...operation.node, id: operation.id };
        const node = buildNode(input, ids, context, `${where}.node`);
        location.siblings[location.index] = node;
        results.push({ op: "replace", id: node.id, created: outline([node]) });
        break;
      }
      case "detach": {
        const location = mustLocate(doc, operation.id, where);
        if (location.node.type !== "instance")
          throw new OperationError(`${where}: "${operation.id}" is not an instance`);
        const expanded = expandInstance(doc, location.node);
        if (!expanded) throw new OperationError(`${where}: component "${location.node.ref}" not found`);
        walk(expanded.children, (child) => {
          child.id = ids.generate();
        });
        location.siblings[location.index] = expanded;
        results.push({ op: "detach", id: expanded.id, created: outline([expanded]) });
        break;
      }
      case "variables": {
        if (typeof operation.set !== "object" || operation.set === null)
          throw new OperationError(`${where}: "set" must be an object of name -> value`);
        const variables = { ...doc.variables };
        for (const [name, value] of Object.entries(operation.set)) {
          const key = name.replace(/^\$/, "");
          if (value === null) delete variables[key];
          else if (typeof value === "string" || typeof value === "number") variables[key] = value;
          else throw new OperationError(`${where}: variable "${key}" must be a string or number`);
        }
        doc.variables = variables;
        results.push({ op: "variables" });
        break;
      }
      default:
        throw new OperationError(
          `ops[${index}]: unknown op "${(operation as { op?: unknown }).op}". Use create, update, delete, move, duplicate, replace, detach or variables.`,
        );
    }
  });

  return { doc, results };
}
