import type { CSSProperties } from "react";

import type {
  DesignNode,
  FrameNode,
  Paint,
  Shadow,
  Size,
  VariableValue,
} from "../../shared/schema.ts";

export type ParentLayout = "canvas" | "none" | "row" | "column" | "grid";

type Variables = Record<string, VariableValue>;

// Keys whose string values are content, never variable references ("$24" is a price).
const LITERAL_KEYS = new Set(["text", "svg", "d", "notes", "name", "id", "ref", "icon", "src", "viewBox"]);

/** Resolve "$token" strings anywhere in a node's own props (not its children). */
export function resolveNode<T extends DesignNode>(node: T, variables: Variables): T {
  if (!Object.keys(variables).length) return node;
  const resolve = (value: unknown, key: string, depth: number): unknown => {
    if (typeof value === "string")
      return value.startsWith("$") && !LITERAL_KEYS.has(key) ? (variables[value.slice(1)] ?? value) : value;
    if (depth > 4 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => resolve(item, key, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolve(v, k, depth + 1);
    return out;
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = key === "children" || key === "overrides" ? value : resolve(value, key, 0);
  }
  return out as T;
}

const px = (value: unknown) => (typeof value === "number" ? `${value}px` : (value as string | undefined));
const num = (value: unknown, fallback: number) => {
  const n = typeof value === "string" ? Number.parseFloat(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
};

export function assetUrl(src: string, docDir: string | null): string {
  if (/^(https?:|data:|blob:|canvas-asset:)/i.test(src)) return src;
  let absolute = src;
  if (src.startsWith("file://")) absolute = decodeURIComponent(new URL(src).pathname);
  else if (!src.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(src)) {
    if (!docDir) return src;
    absolute = `${docDir.replace(/[\\/]$/, "")}/${src.replace(/^\.\//, "")}`;
  }
  return `canvas-asset://file/${encodeURIComponent(absolute)}`;
}

function gradientCss(paint: Exclude<Paint, string>): string | null {
  if (paint.type === "image") return null;
  const stops = paint.stops.map((stop) => `${stop.color} ${Math.round(stop.position * 1000) / 10}%`).join(", ");
  if (paint.type === "radial") return `radial-gradient(circle at center, ${stops})`;
  return `linear-gradient(${paint.angle ?? 180}deg, ${stops})`;
}

/** CSS background layers for a fill (top layer first). */
export function backgroundCss(fill: Paint | Paint[] | undefined, docDir: string | null): CSSProperties {
  if (fill === undefined) return {};
  const paints = Array.isArray(fill) ? fill : [fill];
  if (paints.length === 1 && typeof paints[0] === "string") return { background: paints[0] };
  const images: string[] = [];
  const sizes: string[] = [];
  const repeats: string[] = [];
  for (const paint of paints) {
    if (typeof paint === "string") {
      images.push(`linear-gradient(${paint}, ${paint})`);
      sizes.push("auto");
      repeats.push("no-repeat");
    } else if (paint.type === "image") {
      images.push(`url("${assetUrl(paint.src, docDir)}")`);
      const fit = paint.fit ?? "cover";
      sizes.push(fit === "fill" ? "100% 100%" : fit === "tile" ? "auto" : fit);
      repeats.push(fit === "tile" ? "repeat" : "no-repeat");
    } else {
      images.push(gradientCss(paint)!);
      sizes.push("auto");
      repeats.push("no-repeat");
    }
  }
  return {
    backgroundImage: images.join(", "),
    backgroundSize: sizes.join(", "),
    backgroundRepeat: repeats.join(", "),
    backgroundPosition: "center",
  };
}

function shadowList(shadow: Shadow | Shadow[] | undefined): Shadow[] {
  if (!shadow) return [];
  return Array.isArray(shadow) ? shadow : [shadow];
}

const shadowColor = (s: Shadow) => s.color ?? "rgba(0,0,0,0.25)";

function cornerCss(radius: DesignNode["radius"]): string | undefined {
  if (radius === undefined) return undefined;
  if (Array.isArray(radius)) return radius.map((r) => `${num(r, 0)}px`).join(" ");
  return `${num(radius, 0)}px`;
}

function paddingCss(padding: FrameNode["padding"]): string | undefined {
  if (padding === undefined) return undefined;
  if (Array.isArray(padding)) return padding.map((p) => `${num(p, 0)}px`).join(" ");
  return `${num(padding, 0)}px`;
}

const JUSTIFY: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  "space-between": "space-between",
  "space-around": "space-around",
  "space-evenly": "space-evenly",
};
const ALIGN: Record<string, string> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  stretch: "stretch",
  baseline: "baseline",
};

function defaultSize(node: DesignNode): Size {
  switch (node.type) {
    case "frame":
      return node.layout && node.layout !== "none" ? "hug" : 100;
    case "text":
      return "hug";
    case "icon":
      return num(node.size, 24);
    default:
      return 100;
  }
}

function sizeCss(
  node: DesignNode,
  axis: "width" | "height",
  parent: ParentLayout,
  style: CSSProperties,
) {
  const raw = node[axis];
  const value: Size = raw === undefined ? defaultSize(node) : typeof raw === "string" && raw !== "fill" && raw !== "hug" ? num(raw, 100) : (raw as Size);
  const flex = parent === "row" || parent === "column";
  const isMain = (parent === "row" && axis === "width") || (parent === "column" && axis === "height");
  const inFlow = flex && !node.absolute;

  if (typeof value === "number") {
    style[axis] = `${value}px`;
    if (inFlow && isMain) style.flexShrink = 0;
    return;
  }
  if (value === "hug") {
    style[axis] = "fit-content";
    if (inFlow && isMain) style.flexShrink = 0;
    return;
  }
  // fill
  if (inFlow) {
    if (isMain) {
      style.flex = "1 1 0";
      style[axis === "width" ? "minWidth" : "minHeight"] = 0;
    } else {
      style.alignSelf = "stretch";
    }
    return;
  }
  if (parent === "grid" && !node.absolute) {
    style[axis === "width" ? "justifySelf" : "alignSelf"] = "stretch";
    return;
  }
  style[axis] = "100%";
}

/** The CSS box for a node. Content (text, svg, image) is styled by the view. */
export function nodeStyle(node: DesignNode, parent: ParentLayout, docDir: string | null): CSSProperties {
  const style: CSSProperties = {};
  const positioned = parent === "canvas" || parent === "none" || node.absolute;
  if (positioned) {
    style.position = "absolute";
    style.left = num(node.x, 0);
    style.top = num(node.y, 0);
  } else {
    style.position = "relative";
  }

  sizeCss(node, "width", parent, style);
  sizeCss(node, "height", parent, style);
  if (node.minWidth !== undefined) style.minWidth = num(node.minWidth, 0);
  if (node.maxWidth !== undefined) style.maxWidth = num(node.maxWidth, 0);
  if (node.minHeight !== undefined) style.minHeight = num(node.minHeight, 0);
  if (node.maxHeight !== undefined) style.maxHeight = num(node.maxHeight, 0);

  if (node.visible === false) style.display = "none";
  if (node.opacity !== undefined) style.opacity = num(node.opacity, 1);
  if (node.rotation) style.transform = `rotate(${num(node.rotation, 0)}deg)`;
  if (node.blendMode) style.mixBlendMode = node.blendMode as CSSProperties["mixBlendMode"];

  const filters: string[] = [];
  if (node.blur) filters.push(`blur(${num(node.blur, 0)}px)`);
  const shadows = shadowList(node.shadow);
  const vector = node.type === "icon" || node.type === "path" || node.type === "svg";
  if (node.type === "text") {
    if (shadows.length)
      style.textShadow = shadows.map((s) => `${num(s.x, 0)}px ${num(s.y, 0)}px ${num(s.blur, 0)}px ${shadowColor(s)}`).join(", ");
  } else if (vector) {
    for (const s of shadows) filters.push(`drop-shadow(${num(s.x, 0)}px ${num(s.y, 0)}px ${num(s.blur, 0)}px ${shadowColor(s)})`);
  } else if (shadows.length) {
    style.boxShadow = shadows
      .map((s) => `${s.inset ? "inset " : ""}${num(s.x, 0)}px ${num(s.y, 0)}px ${num(s.blur, 0)}px ${num(s.spread, 0)}px ${shadowColor(s)}`)
      .join(", ");
  }
  if (filters.length) style.filter = filters.join(" ");
  if (node.backdropBlur) style.backdropFilter = `blur(${num(node.backdropBlur, 0)}px)`;

  style.borderRadius = node.type === "ellipse" ? "50%" : cornerCss(node.radius);
  if (node.type !== "path") Object.assign(style, backgroundCss(node.fill, docDir));

  if (node.type === "frame") {
    const layout = node.layout ?? "none";
    if (layout === "row" || layout === "column") {
      style.display = node.visible === false ? "none" : "flex";
      style.flexDirection = layout;
      if (node.justify) style.justifyContent = JUSTIFY[node.justify];
      if (node.align) style.alignItems = ALIGN[node.align];
      if (node.wrap) style.flexWrap = "wrap";
    } else if (layout === "grid") {
      style.display = node.visible === false ? "none" : "grid";
      if (node.columns !== undefined)
        style.gridTemplateColumns =
          typeof node.columns === "number" ? `repeat(${node.columns}, minmax(0, 1fr))` : node.columns;
      if (node.rows !== undefined)
        style.gridTemplateRows = typeof node.rows === "number" ? `repeat(${node.rows}, minmax(0, 1fr))` : node.rows;
      if (node.align) style.alignItems = ALIGN[node.align];
      if (node.justify) style.justifyContent = JUSTIFY[node.justify];
    }
    if (node.gap !== undefined) style.gap = num(node.gap, 0);
    if (node.rowGap !== undefined) style.rowGap = num(node.rowGap, 0);
    if (node.columnGap !== undefined) style.columnGap = num(node.columnGap, 0);
    style.padding = paddingCss(node.padding);
    if (node.clip) style.overflow = "hidden";
  }

  if (node.type === "text") {
    const fixedWidth = node.width !== undefined && node.width !== "hug";
    style.whiteSpace = fixedWidth ? "pre-wrap" : "pre";
    style.overflowWrap = "break-word";
    style.fontFamily = fontStack(node.fontFamily);
    style.fontSize = num(node.fontSize, 16);
    if (node.fontWeight !== undefined) style.fontWeight = node.fontWeight as CSSProperties["fontWeight"];
    if (node.fontStyle) style.fontStyle = node.fontStyle;
    if (node.lineHeight !== undefined) style.lineHeight = typeof node.lineHeight === "number" ? node.lineHeight : node.lineHeight;
    if (node.letterSpacing !== undefined) style.letterSpacing = px(num(node.letterSpacing, 0));
    if (node.textAlign) style.textAlign = node.textAlign;
    if (node.textDecoration) style.textDecoration = node.textDecoration;
    if (node.textTransform) style.textTransform = node.textTransform;
    const color = node.color ?? "#000000";
    if (typeof color === "string") style.color = color;
    else {
      Object.assign(style, backgroundCss(color, docDir));
      style.backgroundClip = "text";
      style.WebkitBackgroundClip = "text";
      style.color = "transparent";
    }
    if (node.maxLines) {
      style.display = node.visible === false ? "none" : "-webkit-box";
      style.WebkitLineClamp = num(node.maxLines, 1);
      style.WebkitBoxOrient = "vertical";
      style.overflow = "hidden";
      style.whiteSpace = "pre-wrap";
    }
  }

  if (node.type === "icon") style.color = node.color ?? "currentColor";
  return style;
}

export function fontStack(family: string | undefined): string {
  const name = family?.trim() || "Inter";
  return `"${name.replace(/"/g, "")}", system-ui, sans-serif`;
}

export function strokeOverlayStyle(node: DesignNode): CSSProperties | null {
  const stroke = node.stroke;
  if (!stroke || node.type === "path") return null;
  const width = num(stroke.width, 1);
  const offset = stroke.align === "outside" ? -width : stroke.align === "center" ? -width / 2 : 0;
  return {
    position: "absolute",
    inset: offset,
    border: `${width}px ${stroke.style ?? "solid"} ${stroke.color}`,
    borderRadius: node.type === "ellipse" ? "50%" : "inherit",
    pointerEvents: "none",
  };
}
