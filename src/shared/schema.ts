// The design document model. Everything the AI creates through MCP and
// everything the canvas renders is described here. Keep it CSS-shaped:
// agents already think in flexbox, colors and pixels.

export const DOCUMENT_FORMAT = "canvas/1";
export const DOCUMENT_EXTENSION = ".canvas.json";

/** A pixel size, or a sizing mode relative to the parent / content. */
export type Size = number | "fill" | "hug";

export interface GradientStop {
  color: string;
  /** 0..1 along the gradient. */
  position: number;
}

export interface LinearGradient {
  type: "linear";
  /** Degrees, CSS convention: 0 = to top, 90 = to right, 180 = to bottom. */
  angle?: number;
  stops: GradientStop[];
}

export interface RadialGradient {
  type: "radial";
  stops: GradientStop[];
}

export interface ImagePaint {
  type: "image";
  src: string;
  fit?: "cover" | "contain" | "fill" | "tile";
}

/** A CSS color string, a `$variable`, a gradient or an image. */
export type Paint = string | LinearGradient | RadialGradient | ImagePaint;

export interface Stroke {
  color: string;
  width?: number;
  style?: "solid" | "dashed" | "dotted";
  /** Where the stroke sits relative to the node's edge. Strokes never affect layout. */
  align?: "inside" | "center" | "outside";
}

export interface Shadow {
  x?: number;
  y?: number;
  blur?: number;
  spread?: number;
  color?: string;
  inset?: boolean;
}

export type Corners = number | [number, number, number, number];
export type Padding = number | [number, number] | [number, number, number, number];

export interface BaseNode {
  id: string;
  type: NodeType;
  name?: string;
  visible?: boolean;
  opacity?: number;
  /** Degrees, clockwise, around the node's center. */
  rotation?: number;
  /** Position inside a free-layout parent (or the canvas), or when `absolute` is set. */
  x?: number;
  y?: number;
  /** Take this node out of its parent's auto layout and place it at x/y. */
  absolute?: boolean;
  width?: Size | string;
  height?: Size | string;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  fill?: Paint | Paint[];
  stroke?: Stroke;
  radius?: Corners;
  shadow?: Shadow | Shadow[];
  /** Layer blur in px. */
  blur?: number;
  /** Background blur in px (frosted glass). */
  backdropBlur?: number;
  blendMode?: string;
  /** Free-form notes for agents (intent, specs). Not rendered. */
  notes?: string;
}

export interface FrameNode extends BaseNode {
  type: "frame";
  children: DesignNode[];
  /** `none` = children placed by x/y. `row`/`column` = flexbox. `grid` = CSS grid. */
  layout?: "none" | "row" | "column" | "grid";
  gap?: number;
  rowGap?: number;
  columnGap?: number;
  padding?: Padding;
  /** Main-axis distribution. */
  justify?: "start" | "center" | "end" | "space-between" | "space-around" | "space-evenly";
  /** Cross-axis alignment. */
  align?: "start" | "center" | "end" | "stretch" | "baseline";
  wrap?: boolean;
  /** Grid: column count or a CSS grid-template-columns value. */
  columns?: number | string;
  rows?: number | string;
  /** Clip children to the frame bounds. */
  clip?: boolean;
  /** Mark this frame as a reusable component that `instance` nodes can reference. */
  component?: boolean;
}

export interface TextNode extends BaseNode {
  type: "text";
  text: string;
  color?: Paint;
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number | string;
  fontStyle?: "normal" | "italic";
  /** Number = multiple of font size; string = any CSS line-height (e.g. "24px"). */
  lineHeight?: number | string;
  /** px */
  letterSpacing?: number;
  textAlign?: "left" | "center" | "right" | "justify";
  textDecoration?: "none" | "underline" | "line-through";
  textTransform?: "none" | "uppercase" | "lowercase" | "capitalize";
  /** Truncate with an ellipsis after this many lines. */
  maxLines?: number;
}

export interface RectNode extends BaseNode {
  type: "rect";
}

export interface EllipseNode extends BaseNode {
  type: "ellipse";
}

export interface ImageNode extends BaseNode {
  type: "image";
  /** http(s) URL, data: URI, absolute file path, or a path relative to the document. */
  src: string;
  fit?: "cover" | "contain" | "fill";
}

export interface IconNode extends BaseNode {
  type: "icon";
  /** A Lucide icon name, e.g. "search", "arrow-right". Use list_icons to discover names. */
  icon: string;
  color?: string;
  /** Shorthand for width = height. Default 24. */
  size?: number;
  strokeWidth?: number;
}

export interface PathNode extends BaseNode {
  type: "path";
  /** SVG path data. */
  d: string;
  /** SVG viewBox of the path data; defaults to "0 0 width height". */
  viewBox?: string;
  fillRule?: "nonzero" | "evenodd";
}

export interface SvgNode extends BaseNode {
  type: "svg";
  /** Raw SVG markup; scaled to the node's box. */
  svg: string;
}

export interface InstanceNode extends BaseNode {
  type: "instance";
  /** Id of a frame with `component: true`. */
  ref: string;
  /** Per-descendant property overrides, keyed by the component descendant's id. */
  overrides?: Record<string, Record<string, unknown>>;
}

export type DesignNode =
  | FrameNode
  | TextNode
  | RectNode
  | EllipseNode
  | ImageNode
  | IconNode
  | PathNode
  | SvgNode
  | InstanceNode;

export type NodeType = DesignNode["type"];

export const NODE_TYPES: readonly NodeType[] = [
  "frame",
  "text",
  "rect",
  "ellipse",
  "image",
  "icon",
  "path",
  "svg",
  "instance",
];

export type VariableValue = string | number;

export interface DesignDocument {
  format: typeof DOCUMENT_FORMAT;
  /** Design tokens. Any string property value "$name" resolves to variables[name]. */
  variables: Record<string, VariableValue>;
  /** Top-level nodes, placed on the infinite canvas by x/y. */
  children: DesignNode[];
}

export function emptyDocument(): DesignDocument {
  return { format: DOCUMENT_FORMAT, variables: {}, children: [] };
}

export function hasChildren(node: DesignNode): node is FrameNode {
  return node.type === "frame";
}

/** Properties every node type accepts. */
const BASE_PROPS = [
  "id",
  "type",
  "name",
  "visible",
  "opacity",
  "rotation",
  "x",
  "y",
  "absolute",
  "width",
  "height",
  "minWidth",
  "maxWidth",
  "minHeight",
  "maxHeight",
  "fill",
  "stroke",
  "radius",
  "shadow",
  "blur",
  "backdropBlur",
  "blendMode",
  "notes",
] as const;

export const NODE_PROPS: Record<NodeType, readonly string[]> = {
  frame: [
    ...BASE_PROPS,
    "children",
    "layout",
    "gap",
    "rowGap",
    "columnGap",
    "padding",
    "justify",
    "align",
    "wrap",
    "columns",
    "rows",
    "clip",
    "component",
  ],
  text: [
    ...BASE_PROPS,
    "text",
    "color",
    "fontFamily",
    "fontSize",
    "fontWeight",
    "fontStyle",
    "lineHeight",
    "letterSpacing",
    "textAlign",
    "textDecoration",
    "textTransform",
    "maxLines",
  ],
  rect: BASE_PROPS,
  ellipse: BASE_PROPS,
  image: [...BASE_PROPS, "src", "fit"],
  icon: [...BASE_PROPS, "icon", "color", "size", "strokeWidth"],
  path: [...BASE_PROPS, "d", "viewBox", "fillRule"],
  svg: [...BASE_PROPS, "svg"],
  instance: [...BASE_PROPS, "ref", "overrides"],
};

/** Common CSS/Figma-isms agents reach for, mapped to our property names. */
export const PROP_HINTS: Record<string, string> = {
  backgroundColor: "fill",
  background: "fill",
  bg: "fill",
  borderRadius: "radius",
  cornerRadius: "radius",
  border: "stroke",
  borderColor: "stroke.color",
  boxShadow: "shadow",
  shadows: "shadow",
  content: "text",
  characters: "text",
  label: "text",
  flexDirection: "layout",
  direction: "layout",
  justifyContent: "justify",
  alignItems: "align",
  overflow: "clip",
  itemSpacing: "gap",
  fontColor: "color",
  textColor: "color",
  w: "width",
  h: "height",
  left: "x",
  top: "y",
  componentId: "ref",
  url: "src",
  iconName: "icon",
};
