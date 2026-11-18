import { createContext, createElement, useContext, useMemo, type CSSProperties, type ReactNode } from "react";
import iconNodes from "lucide-static/icon-nodes.json";

import {
  LEGACY_ICON_SET,
  PHOSPHOR_WEIGHTS,
  type DesignDocument,
  type DesignNode,
  type Paint,
  type PathNode,
} from "../../shared/schema.ts";
import { expandInstance, missingComponent } from "../../shared/tree.ts";
import { assetUrl, nodeStyle, resolveNode, strokeOverlayStyle, type ParentLayout } from "./style.ts";

type IconNode = [string, Record<string, string>][];
const ICONS = iconNodes as unknown as Record<string, IconNode>;

interface RenderContextValue {
  doc: DesignDocument;
  docDir: string | null;
  /** Phosphor SVG bodies keyed "weight:name", supplied by the main process. */
  glyphs: Record<string, string>;
}

export const RenderContext = createContext<RenderContextValue>({
  doc: { format: "canvas/1", variables: {}, children: [] },
  docDir: null,
  glyphs: {},
});

export function NodeView({ node: raw, parent }: { node: DesignNode; parent: ParentLayout }) {
  const { doc, docDir } = useContext(RenderContext);

  if (raw.type === "instance") {
    const expanded = expandInstance(doc, raw) ?? missingComponent(raw);
    return <NodeView node={expanded} parent={parent} />;
  }

  const node = resolveNode(raw, doc.variables);
  const style = nodeStyle(node, parent, docDir);
  const stroke = strokeOverlayStyle(node);
  const attributes = { "data-id": raw.id, "data-type": raw.type, "data-name": raw.name };

  let content: ReactNode = null;
  switch (node.type) {
    case "frame":
      content = node.children.map((child) => (
        <NodeView key={child.id} node={child} parent={node.layout ?? "none"} />
      ));
      break;
    case "text":
      content = node.text;
      break;
    case "image":
      content = (
        <img
          src={assetUrl(node.src, docDir)}
          alt=""
          draggable={false}
          style={{
            width: "100%",
            height: "100%",
            display: "block",
            objectFit: node.fit ?? "cover",
            borderRadius: "inherit",
          }}
        />
      );
      break;
    case "icon":
      content =
        (node.set ?? LEGACY_ICON_SET) === "phosphor" ? (
          <PhosphorIcon name={node.icon} weight={node.weight} />
        ) : (
          <Icon name={node.icon} strokeWidth={node.strokeWidth} />
        );
      break;
    case "path":
      content = <PathSvg node={node} />;
      break;
    case "svg":
      content = <RawSvg markup={node.svg} />;
      break;
  }

  return (
    <div {...attributes} style={style}>
      {content}
      {stroke && <div className="cv-stroke" style={stroke} />}
    </div>
  );
}

const PHOSPHOR_WEIGHT_SET = new Set<string>(PHOSPHOR_WEIGHTS);

function PhosphorIcon({ name, weight }: { name: string; weight?: string }) {
  const { glyphs } = useContext(RenderContext);
  const body = glyphs[`${weight && PHOSPHOR_WEIGHT_SET.has(weight) ? weight : "regular"}:${name}`];
  if (body === undefined) {
    return <div style={{ width: "100%", height: "100%", border: "1px dashed #ef4444", borderRadius: 4 }} title={`Unknown icon "${name}"`} />;
  }
  return (
    <svg
      viewBox="0 0 256 256"
      width="100%"
      height="100%"
      fill="currentColor"
      style={{ display: "block" }}
      dangerouslySetInnerHTML={{ __html: body }}
    />
  );
}

function Icon({ name, strokeWidth }: { name: string; strokeWidth?: number }) {
  const shapes = ICONS[name];
  if (!shapes) {
    return <div style={{ width: "100%", height: "100%", border: "1px dashed #ef4444", borderRadius: 4 }} title={`Unknown icon "${name}"`} />;
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width="100%"
      height="100%"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth ?? 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: "block" }}
    >
      {shapes.map(([tag, attrs], index) => createElement(tag, { key: index, ...attrs }))}
    </svg>
  );
}

let gradientCounter = 0;

function svgPaint(paint: Paint | Paint[] | undefined, id: string): { value: string; defs: ReactNode } {
  const first = Array.isArray(paint) ? paint[0] : paint;
  if (first === undefined) return { value: "none", defs: null };
  if (typeof first === "string") return { value: first, defs: null };
  if (first.type === "image") return { value: "#cccccc", defs: null };
  const stops = first.stops.map((stop, index) => (
    <stop key={index} offset={stop.position} stopColor={stop.color} />
  ));
  if (first.type === "radial") {
    return { value: `url(#${id})`, defs: <radialGradient id={id}>{stops}</radialGradient> };
  }
  // CSS angle convention: 0deg points up, 90deg points right.
  const radians = (((first.angle ?? 180) - 90) * Math.PI) / 180;
  const dx = Math.cos(radians) / 2;
  const dy = Math.sin(radians) / 2;
  return {
    value: `url(#${id})`,
    defs: (
      <linearGradient id={id} x1={0.5 - dx} y1={0.5 - dy} x2={0.5 + dx} y2={0.5 + dy}>
        {stops}
      </linearGradient>
    ),
  };
}

function PathSvg({ node }: { node: PathNode }) {
  const gradientId = useMemo(() => `cv-grad-${++gradientCounter}`, []);
  const width = typeof node.width === "number" ? node.width : 100;
  const height = typeof node.height === "number" ? node.height : 100;
  const fill = svgPaint(node.fill, gradientId);
  const stroke = node.stroke;
  return (
    <svg
      viewBox={node.viewBox ?? `0 0 ${width} ${height}`}
      width="100%"
      height="100%"
      preserveAspectRatio="xMidYMid meet"
      style={{ display: "block", overflow: "visible" }}
    >
      {fill.defs && <defs>{fill.defs}</defs>}
      <path
        d={node.d}
        fill={fill.value}
        fillRule={node.fillRule}
        stroke={stroke?.color ?? "none"}
        strokeWidth={stroke?.width ?? (stroke ? 1 : undefined)}
        strokeDasharray={stroke?.style === "dashed" ? "6 4" : stroke?.style === "dotted" ? "1 3" : undefined}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

const svgCache = new Map<string, string>();

/** Strip scripts/handlers and make the markup scale to its box. */
function sanitizeSvg(markup: string): string {
  const cached = svgCache.get(markup);
  if (cached !== undefined) return cached;
  const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
  const svg = parsed.documentElement;
  let result = "";
  if (svg.nodeName.toLowerCase() === "svg" && !parsed.querySelector("parsererror")) {
    for (const element of [svg, ...svg.querySelectorAll("*")]) {
      if (["script", "foreignobject"].includes(element.nodeName.toLowerCase())) {
        element.remove();
        continue;
      }
      for (const attribute of [...element.attributes]) {
        if (/^on/i.test(attribute.name) || /javascript:/i.test(attribute.value)) element.removeAttribute(attribute.name);
      }
    }
    if (!svg.getAttribute("viewBox")) {
      const w = Number.parseFloat(svg.getAttribute("width") ?? "");
      const h = Number.parseFloat(svg.getAttribute("height") ?? "");
      if (w && h) svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    }
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    result = new XMLSerializer().serializeToString(svg);
  }
  svgCache.set(markup, result);
  return result;
}

function RawSvg({ markup }: { markup: string }) {
  const html = useMemo(() => sanitizeSvg(markup), [markup]);
  const style: CSSProperties = { width: "100%", height: "100%", display: "block" };
  if (!html) return <div style={{ ...style, border: "1px dashed #ef4444" }} title="Invalid SVG markup" />;
  return <div className="cv-svg" style={style} dangerouslySetInnerHTML={{ __html: html }} />;
}
