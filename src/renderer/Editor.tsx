import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { AppState, Bounds, RendererRequest, ViewCommand } from "../shared/ipc.ts";
import { locate } from "../shared/tree.ts";
import { collectFonts, fontsReady, linkFonts } from "./render/fonts.ts";
import { boundsOf, elementFor, measureAll } from "./render/measure.ts";
import { NodeView, RenderContext } from "./render/NodeView.tsx";

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 64;
const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

interface ScreenRect {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export function Editor() {
  const [state, setState] = useState<AppState | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 80, y: 80, zoom: 1 });
  const [hovered, setHovered] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<{ selection: ScreenRect[]; hover: ScreenRect | null; labels: (ScreenRect & { name: string })[]; flash: ScreenRect[] }>({
    selection: [],
    hover: null,
    labels: [],
    flash: [],
  });
  const [flashIds, setFlashIds] = useState<string[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const stateRef = useRef(state);
  stateRef.current = state;
  const containerRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const renderedVersion = useRef(-1);
  const lastFilePath = useRef<string | null | undefined>(undefined);
  const lastActivityAt = useRef(0);

  useEffect(() => {
    const offState = window.canvasBridge.onState(setState);
    window.canvasBridge.ready();
    return offState;
  }, []);

  useLayoutEffect(() => {
    if (state) renderedVersion.current = state.version;
  }, [state]);

  useEffect(() => {
    if (state) linkFonts(collectFonts(state.doc));
  }, [state?.doc]);

  // ---- viewport helpers ---------------------------------------------------

  const zoomAt = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const cx = (clientX ?? rect.left + rect.width / 2) - rect.left;
    const cy = (clientY ?? rect.top + rect.height / 2) - rect.top;
    setViewport((v) => {
      const zoom = clampZoom(v.zoom * factor);
      const k = zoom / v.zoom;
      return { zoom, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  }, []);

  const fitBounds = useCallback((bounds: Bounds | null, maxZoom = 1) => {
    const container = containerRef.current;
    if (!container || !bounds || bounds.width <= 0 || bounds.height <= 0) return;
    const { width, height } = container.getBoundingClientRect();
    const pad = 80;
    const zoom = clampZoom(Math.min((width - pad * 2) / bounds.width, (height - pad * 2 - 32) / bounds.height, maxZoom));
    setViewport({
      zoom,
      x: (width - bounds.width * zoom) / 2 - bounds.x * zoom,
      y: (height - 32 - bounds.height * zoom) / 2 - bounds.y * zoom,
    });
  }, []);

  const unionBounds = useCallback((ids: string[] | null): Bounds | null => {
    const world = worldRef.current;
    if (!world) return null;
    const elements = ids
      ? ids.flatMap((id) => {
          const el = elementFor(world, id);
          return el ? [el] : [];
        })
      : [...world.children].filter((el): el is HTMLElement => el instanceof HTMLElement && !!el.dataset.id);
    if (!elements.length) return null;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const element of elements) {
      const b = boundsOf(element, world, viewportRef.current.zoom);
      x1 = Math.min(x1, b.x);
      y1 = Math.min(y1, b.y);
      x2 = Math.max(x2, b.x + b.width);
      y2 = Math.max(y2, b.y + b.height);
    }
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
  }, []);

  // Fit the document when a different file opens.
  useEffect(() => {
    if (!state || lastFilePath.current === state.filePath) return;
    lastFilePath.current = state.filePath;
    requestAnimationFrame(() => fitBounds(unionBounds(null)));
  }, [state, fitBounds, unionBounds]);

  // ---- requests from main (agents) ------------------------------------------

  useEffect(() => {
    return window.canvasBridge.onRequest(async (request: RendererRequest) => {
      const world = worldRef.current;
      switch (request.type) {
        case "measure": {
          const deadline = Date.now() + 3000;
          while (renderedVersion.current < request.payload.minVersion && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 16));
          }
          const current = stateRef.current;
          if (current) await fontsReady(collectFonts(current.doc), 3000);
          if (!world) throw new Error("Canvas not mounted");
          return measureAll(world, viewportRef.current.zoom, request.payload.ids);
        }
        case "focus": {
          await new Promise((resolve) => setTimeout(resolve, 30));
          fitBounds(unionBounds(request.payload.ids), 2);
          return null;
        }
        default:
          throw new Error(`Editor can't handle ${request.type}`);
      }
    });
  }, [fitBounds, unionBounds]);

  useEffect(() => {
    return window.canvasBridge.onViewCommand((command: ViewCommand) => {
      switch (command) {
        case "zoom-in":
          return zoomAt(1.25);
        case "zoom-out":
          return zoomAt(0.8);
        case "zoom-reset":
          return zoomAt(1 / viewportRef.current.zoom);
        case "zoom-fit":
          return fitBounds(unionBounds(null));
        case "zoom-selection": {
          const selection = stateRef.current?.selection ?? [];
          return fitBounds(unionBounds(selection.length ? selection : null), 4);
        }
      }
    });
  }, [zoomAt, fitBounds, unionBounds]);

  // ---- agent activity feedback -----------------------------------------------

  useEffect(() => {
    const activity = state?.activity;
    if (!activity || activity.at === lastActivityAt.current) return;
    lastActivityAt.current = activity.at;
    setToast(activity.label);
    setFlashIds(activity.ids);
    const timer = setTimeout(() => {
      setToast(null);
      setFlashIds([]);
    }, 1800);
    return () => clearTimeout(timer);
  }, [state?.activity]);

  // ---- overlays (selection, hover, frame labels) ---------------------------------

  useLayoutEffect(() => {
    const world = worldRef.current;
    const container = containerRef.current;
    if (!world || !container || !state) return;
    const origin = container.getBoundingClientRect();
    const rectFor = (id: string): ScreenRect | null => {
      const element = elementFor(world, id);
      if (!element) return null;
      const r = element.getBoundingClientRect();
      return { id, left: r.left - origin.left, top: r.top - origin.top, width: r.width, height: r.height };
    };
    const labels: (ScreenRect & { name: string })[] = [];
    for (const node of state.doc.children) {
      if (node.type !== "frame" && node.type !== "instance") continue;
      const rect = rectFor(node.id);
      if (rect) labels.push({ ...rect, name: node.name ?? node.id });
    }
    setOverlay({
      selection: state.selection.flatMap((id) => rectFor(id) ?? []),
      hover: hovered && !state.selection.includes(hovered) ? rectFor(hovered) : null,
      labels,
      flash: flashIds.flatMap((id) => rectFor(id) ?? []),
    });
  }, [state, viewport, hovered, flashIds]);

  // Fonts and images change layout after load; refresh overlays then.
  useEffect(() => {
    const onLoad = () => setViewport((v) => ({ ...v }));
    document.fonts.addEventListener("loadingdone", onLoad);
    return () => document.fonts.removeEventListener("loadingdone", onLoad);
  }, []);

  // ---- input -----------------------------------------------------------------

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        zoomAt(Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025)), event.clientX, event.clientY);
      } else {
        const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
        const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
        setViewport((v) => ({ ...v, x: v.x - dx, y: v.y - dy }));
      }
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const spaceDown = useRef(false);
  const [panning, setPanning] = useState(false);
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceDown.current = true;
      const current = stateRef.current;
      if (!current) return;
      const selected = current.selection[0];
      if (event.key === "Enter" && selected) {
        const location = locate(current.doc, selected);
        if (event.shiftKey && location?.parent) window.canvasBridge.select([location.parent.id]);
        else if (!event.shiftKey && location?.node.type === "frame" && location.node.children[0])
          window.canvasBridge.select([location.node.children[0].id]);
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") spaceDown.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const drag = useRef<{ x: number; y: number; moved: boolean; pan: boolean } | null>(null);

  const onPointerDown = (event: React.PointerEvent) => {
    const pan = event.button === 1 || (event.button === 0 && spaceDown.current);
    if (event.button !== 0 && !pan) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, moved: false, pan };
    if (pan) setPanning(true);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const current = drag.current;
    if (current) {
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      if (!current.moved && Math.hypot(dx, dy) > 3) {
        current.moved = true;
        if (!current.pan) {
          current.pan = true; // dragging empty space or nodes pans; nothing here is movable by hand
          setPanning(true);
        }
      }
      if (current.moved) {
        current.x = event.clientX;
        current.y = event.clientY;
        setViewport((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      }
      return;
    }
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-id]");
    setHovered(target?.dataset.id ?? null);
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const current = drag.current;
    drag.current = null;
    setPanning(false);
    if (!current || current.moved || current.pan) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-id]");
    const id = target?.dataset.id;
    const selection = stateRef.current?.selection ?? [];
    if (!id) window.canvasBridge.select([]);
    else if (event.shiftKey)
      window.canvasBridge.select(selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id]);
    else window.canvasBridge.select([id]);
  };

  const onLabelClick = (id: string) => window.canvasBridge.select([id]);

  // ---- render ----------------------------------------------------------------

  const context = useMemo(() => (state ? { doc: state.doc, docDir: state.docDir } : null), [state?.doc, state?.docDir]);
  const breadcrumb = useMemo(() => {
    const id = state?.selection.length === 1 ? state.selection[0]! : null;
    if (!state || !id) return null;
    const location = locate(state.doc, id.split("/")[0]!);
    if (!location) return null;
    return location.path.map((pathId) => {
      const node = locate(state.doc, pathId)!.node;
      return { id: pathId, label: node.name ?? `${node.type} ${pathId}` };
    }).concat(id.includes("/") ? [{ id, label: id.split("/").slice(1).join(" › ") }] : []);
  }, [state]);

  if (!state || !context) return <div className="cv-loading" />;

  const fileName = state.filePath ? state.filePath.split(/[\\/]/).pop() : "Untitled";
  const setupCommand = `claude mcp add --transport http canvas ${state.mcp.url}`;
  const copySetup = () => {
    void navigator.clipboard.writeText(setupCommand).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className="cv-editor">
      <div
        ref={containerRef}
        className={`cv-viewport${panning ? " is-panning" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHovered(null)}
        style={{ backgroundPosition: `${viewport.x}px ${viewport.y}px`, backgroundSize: `${24 * viewport.zoom}px ${24 * viewport.zoom}px` }}
      >
        <div
          ref={worldRef}
          className="cv-world"
          style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})` }}
        >
          <RenderContext.Provider value={context}>
            {state.doc.children.map((node) => (
              <NodeView key={node.id} node={node} parent="canvas" />
            ))}
          </RenderContext.Provider>
        </div>

        <div className="cv-overlay">
          {overlay.labels.map((label) => (
            <button
              key={label.id}
              className={`cv-label${state.selection.includes(label.id) ? " is-selected" : ""}`}
              style={{ left: label.left, top: label.top - 22, maxWidth: Math.max(label.width, 40) }}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={() => onLabelClick(label.id)}
            >
              {label.name}
            </button>
          ))}
          {overlay.flash.map((rect) => (
            <div key={`flash-${rect.id}`} className="cv-flash" style={rect} />
          ))}
          {overlay.hover && <div className="cv-hover" style={overlay.hover} />}
          {overlay.selection.map((rect) => (
            <div key={rect.id} className="cv-selection" style={rect}>
              <span className="cv-size">
                {Math.round(rect.width / viewport.zoom)} × {Math.round(rect.height / viewport.zoom)}
              </span>
            </div>
          ))}
        </div>

        {!state.doc.children.length && (
          <div className="cv-empty">
            <h1>Ask your agent to design something</h1>
            <p>Canvas is driven over MCP. Connect your agent once:</p>
            <button className="cv-command" onClick={copySetup} onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
              <code>{setupCommand}</code>
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
            <p className="cv-hint">Then try: “Design a landing page for a coffee subscription on the canvas.”</p>
          </div>
        )}

        {toast && (
          <div className="cv-toast">
            <span className="cv-dot" />
            {toast}
          </div>
        )}
      </div>

      <footer className="cv-status">
        <span className="cv-file" title={state.filePath ?? "Untitled (recovered automatically)"}>
          {fileName}
          <span className={`cv-save ${state.dirty ? "is-dirty" : ""}`}>{state.dirty ? "saving…" : state.filePath ? "saved" : "unsaved"}</span>
        </span>
        {breadcrumb && (
          <span className="cv-breadcrumb">
            {breadcrumb.map((item, index) => (
              <button key={item.id} onClick={() => window.canvasBridge.select([item.id])}>
                {index > 0 && <span className="cv-sep">›</span>}
                {item.label}
              </button>
            ))}
          </span>
        )}
        <span className="cv-spacer" />
        <button className="cv-zoom" onClick={() => zoomAt(1 / viewport.zoom)} title="Reset zoom (Ctrl+0)">
          {Math.round(viewport.zoom * 100)}%
        </button>
        <button
          className={`cv-mcp ${state.mcp.listening ? "is-on" : "is-off"}`}
          title={state.mcp.error ?? `Click to copy: ${setupCommand}`}
          onClick={copySetup}
        >
          <span className="cv-dot" />
          {state.mcp.listening ? (copied ? "Copied setup command" : `MCP ${state.mcp.url.replace("http://", "")}`) : "MCP offline"}
        </button>
      </footer>
    </div>
  );
}
