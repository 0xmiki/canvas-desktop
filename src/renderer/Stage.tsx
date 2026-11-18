import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import type { Bounds, RendererRequest, RenderResult } from "../shared/ipc.ts";
import type { DesignDocument, DesignNode } from "../shared/schema.ts";
import { locate } from "../shared/tree.ts";
import { collectFonts, fontsReady, googleFontLinks } from "./render/fonts.ts";
import { boundsOf, elementFor, imagesReady, nextFrame } from "./render/measure.ts";
import { NodeView, RenderContext } from "./render/NodeView.tsx";

interface Job {
  doc: DesignDocument;
  docDir: string | null;
  glyphs: Record<string, string>;
  roots: DesignNode[];
  transform: string;
}

/**
 * Offscreen rasterizer. Renders the top-level ancestors of the requested
 * nodes at their canvas positions, then shifts and scales the world so the
 * requested region starts at the window's (0,0).
 */
export function Stage() {
  const [job, setJob] = useState<Job | null>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const regionRef = useRef<{ bounds: Bounds; ids: string[] | null } | null>(null);
  const docRef = useRef<DesignDocument | null>(null);

  useEffect(() => {
    return window.canvasBridge.onRequest(async (request: RendererRequest) => {
      switch (request.type) {
        case "render": {
          const { doc, docDir, glyphs, ids, scale, maxSize } = request.payload;
          const rootIds = new Set<string>();
          const warnings: string[] = [];
          const targets = ids ?? doc.children.map((node) => node.id);
          for (const id of targets) {
            const location = locate(doc, id.split("/")[0]!);
            if (location) rootIds.add(location.path[0]!);
            else warnings.push(`Not found: ${id}`);
          }
          const roots = doc.children.filter((node) => rootIds.has(node.id));
          if (!roots.length) throw new Error(`Nothing to render${ids ? ` (not found: ${ids.join(", ")})` : ""}`);

          docRef.current = doc;
          flushSync(() => setJob({ doc, docDir, glyphs, roots, transform: "none" }));
          const world = worldRef.current!;
          await fontsReady(collectFonts(doc, roots));
          await imagesReady(world);
          await nextFrame();

          let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
          for (const id of targets) {
            const element = elementFor(world, id);
            if (!element) continue;
            const b = boundsOf(element, world, 1);
            x1 = Math.min(x1, b.x);
            y1 = Math.min(y1, b.y);
            x2 = Math.max(x2, b.x + b.width);
            y2 = Math.max(y2, b.y + b.height);
          }
          if (!Number.isFinite(x1)) throw new Error("Requested nodes are hidden or have no size");
          const bounds = { x: x1, y: y1, width: Math.max(1, x2 - x1), height: Math.max(1, y2 - y1) };
          const effective = Math.min(scale, maxSize / Math.max(bounds.width, bounds.height));
          if (effective < scale) warnings.push(`Downscaled to ${effective.toFixed(3)}x to fit ${maxSize}px.`);
          regionRef.current = { bounds, ids };
          flushSync(() =>
            setJob((current) =>
              current && {
                ...current,
                transform: `translate(${-bounds.x * effective}px, ${-bounds.y * effective}px) scale(${effective})`,
              },
            ),
          );
          const result: RenderResult = {
            width: Math.ceil(bounds.width * effective),
            height: Math.ceil(bounds.height * effective),
            scale: effective,
            bounds,
            warnings,
          };
          return result;
        }
        case "backdrop":
          document.documentElement.style.background = request.payload ?? "transparent";
          document.body.style.background = request.payload ?? "transparent";
          await nextFrame();
          await nextFrame();
          await nextFrame();
          return null;
        case "settle":
          await nextFrame();
          await nextFrame();
          await nextFrame();
          return null;
        case "html":
          if (!worldRef.current || !regionRef.current) throw new Error("Render something first");
          return exportHtml(worldRef.current, regionRef.current, docRef.current);
        default:
          throw new Error(`Stage can't handle ${request.type}`);
      }
    });
  }, []);

  if (!job) return null;
  return (
    <div ref={worldRef} className="cv-world cv-stage" style={{ transform: job.transform }}>
      <RenderContext.Provider value={{ doc: job.doc, docDir: job.docDir, glyphs: job.glyphs }}>
        {job.roots.map((node) => (
          <NodeView key={node.id} node={node} parent="canvas" />
        ))}
      </RenderContext.Provider>
    </div>
  );
}

function exportHtml(world: HTMLElement, region: { bounds: Bounds; ids: string[] | null }, doc: DesignDocument | null) {
  const clone = world.cloneNode(true) as HTMLElement;
  clone.style.transform = `translate(${-region.bounds.x}px, ${-region.bounds.y}px)`;
  clone.removeAttribute("class");
  clone.style.position = "absolute";
  clone.style.left = "0";
  clone.style.top = "0";
  for (const element of clone.querySelectorAll<HTMLElement>("[style]")) {
    element.style.cssText = element.style.cssText.replace(
      /canvas-asset:\/\/file\/([^")]+)/g,
      (_match, encoded: string) => `file://${decodeURIComponent(encoded)}`,
    );
  }
  for (const img of clone.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (src.startsWith("canvas-asset://file/")) img.setAttribute("src", `file://${decodeURIComponent(src.slice(20))}`);
  }
  const fonts = doc ? googleFontLinks(collectFonts(doc)) : [];
  const { width, height } = region.bounds;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Canvas export</title>
${fonts.map((href) => `<link rel="stylesheet" href="${href.replace(/&/g, "&amp;")}">`).join("\n")}
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; }
  .cv-svg > svg { display: block; width: 100%; height: 100%; }
</style>
</head>
<body>
<!-- Generated by Canvas. Absolute positions mirror the design; flex/grid frames carry their layout. -->
<div style="position: relative; width: ${Math.ceil(width)}px; height: ${Math.ceil(height)}px; overflow: hidden;">
${clone.outerHTML}
</div>
</body>
</html>
`;
}
