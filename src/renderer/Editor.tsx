import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { AppState, Bounds, RendererRequest, ViewCommand } from "../shared/ipc.ts";
import { locate } from "../shared/tree.ts";
import { collectFonts, fontsReady, linkFonts } from "./render/fonts.ts";
import { boundsOf, elementFor, measureAll } from "./render/measure.ts";
import { NodeView, RenderContext } from "./render/NodeView.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { fitViewport, isMouseWheel, useViewport, zoomAround, type WheelMode } from "./viewport.ts";

interface ScreenRect {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Overlay {
  selection: ScreenRect[];
  hover: ScreenRect | null;
  labels: (ScreenRect & { name: string })[];
  flash: ScreenRect[];
}

const DRAG_THRESHOLD = 3;
const WHEEL_MODES: WheelMode[] = ["auto", "zoom", "pan"];
const WHEEL_LABELS: Record<WheelMode, string> = {
  auto: "Wheel: auto",
  zoom: "Wheel: zoom",
  pan: "Wheel: pan",
};
const WHEEL_TITLES: Record<WheelMode, string> = {
  auto: "Mouse wheel zooms, trackpad scrolling pans. Click to change.",
  zoom: "Scroll wheel always zooms (Shift+wheel pans sideways). Click to change.",
  pan: "Scroll wheel pans; Ctrl+wheel zooms. Click to change.",
};

function loadSetting<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function saveSetting(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Settings are a convenience.
  }
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

export function Editor() {
  const [state, setState] = useState<AppState | null>(null);
  const { viewport, viewportRef, set: setViewport, animateTo } = useViewport({ x: 80, y: 80, zoom: 1 });
  const [hovered, setHovered] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay>({ selection: [], hover: null, labels: [], flash: [] });
  const [flashIds, setFlashIds] = useState<string[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [wheelMode, setWheelMode] = useState<WheelMode>(() => loadSetting("canvas.wheelMode", "auto", WHEEL_MODES));
  const [sidebarOpen, setSidebarOpen] = useState(() => loadSetting("canvas.sidebar", "open", ["open", "closed"]) === "open");
  const [panning, setPanning] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [fontEpoch, setFontEpoch] = useState(0);

  const hasState = state !== null;
  const stateRef = useRef(state);
  stateRef.current = state;
  const wheelModeRef = useRef(wheelMode);
  wheelModeRef.current = wheelMode;
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

  useEffect(() => saveSetting("canvas.wheelMode", wheelMode), [wheelMode]);
  useEffect(() => saveSetting("canvas.sidebar", sidebarOpen ? "open" : "closed"), [sidebarOpen]);

  // ---- viewport helpers ---------------------------------------------------

  const containerSize = () => {
    const rect = containerRef.current?.getBoundingClientRect();
    return { width: rect?.width ?? 800, height: rect?.height ?? 600, left: rect?.left ?? 0, top: rect?.top ?? 0 };
  };

  const zoomBy = useCallback(
    (factor: number, animate = true) => {
      const { width, height } = containerSize();
      const target = zoomAround(viewportRef.current, factor, width / 2, height / 2);
      if (animate) animateTo(target);
      else setViewport(target);
    },
    [animateTo, setViewport, viewportRef],
  );

  const unionBounds = useCallback(
    (ids: string[] | null): Bounds | null => {
      const world = worldRef.current;
      if (!world) return null;
      const elements = ids
        ? ids.flatMap((id) => elementFor(world, id) ?? [])
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
    },
    [viewportRef],
  );

  const fitTo = useCallback(
    (ids: string[] | null, maxZoom = 1, animate = true) => {
      const bounds = unionBounds(ids);
      if (!bounds) return;
      const { width, height } = containerSize();
      const target = fitViewport(bounds, width, height, maxZoom);
      if (animate) animateTo(target);
      else setViewport(target);
    },
    [unionBounds, animateTo, setViewport],
  );

  // Fit the document when a different file opens.
  useEffect(() => {
    if (!state || lastFilePath.current === state.filePath) return;
    const first = lastFilePath.current === undefined;
    lastFilePath.current = state.filePath;
    requestAnimationFrame(() => fitTo(null, 1, !first));
  }, [state, fitTo]);

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
          fitTo(request.payload.ids, 2);
          return null;
        }
        default:
          throw new Error(`Editor can't handle ${request.type}`);
      }
    });
  }, [fitTo, viewportRef]);

  const runViewCommand = useCallback(
    (command: ViewCommand) => {
      switch (command) {
        case "zoom-in":
          return zoomBy(1.5);
        case "zoom-out":
          return zoomBy(1 / 1.5);
        case "zoom-reset":
          return zoomBy(1 / viewportRef.current.zoom);
        case "zoom-fit":
          return fitTo(null);
        case "zoom-selection": {
          const selection = stateRef.current?.selection ?? [];
          return fitTo(selection.length ? selection : null, 4);
        }
        case "toggle-sidebar":
          return setSidebarOpen((open) => !open);
      }
    },
    [zoomBy, fitTo, viewportRef],
  );

  useEffect(() => window.canvasBridge.onViewCommand(runViewCommand), [runViewCommand]);

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
    const labels: Overlay["labels"] = [];
    for (const node of state.doc.children) {
      if (node.type !== "frame" && node.type !== "instance") continue;
      const rect = rectFor(node.id);
      if (rect) labels.push({ ...rect, name: node.name ?? node.id });
    }
    setOverlay({
      selection: state.selection.flatMap((id) => rectFor(id) ?? []),
      hover: hovered && !state.selection.includes(hovered) && !panning ? rectFor(hovered) : null,
      labels,
      flash: flashIds.flatMap((id) => rectFor(id) ?? []),
    });
  }, [state, viewport, hovered, flashIds, panning, sidebarOpen, fontEpoch]);

  // Fonts change layout after they load; refresh overlays then.
  useEffect(() => {
    const refresh = () => setFontEpoch((n) => n + 1);
    document.fonts.addEventListener("loadingdone", refresh);
    return () => document.fonts.removeEventListener("loadingdone", refresh);
  }, []);

  // ---- wheel: zoom or pan ----------------------------------------------------------

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = container.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const unit = event.deltaMode === 1 ? 33 : event.deltaMode === 2 ? rect.height : 1;
      const dx = event.deltaX * unit;
      const dy = event.deltaY * unit;
      const mode = wheelModeRef.current;
      const zoom =
        event.ctrlKey || event.metaKey || (!event.shiftKey && (mode === "zoom" || (mode === "auto" && isMouseWheel(event))));
      if (zoom) {
        // Pinch gestures send small deltas; wheels send ~100 per notch (≈ 16% per notch).
        const sensitivity = event.ctrlKey && !isMouseWheel(event) ? 0.01 : 0.0015;
        setViewport((v) => zoomAround(v, Math.exp(-dy * sensitivity), px, py));
        return;
      }
      // Shift+wheel on a plain mouse scrolls sideways.
      const horizontal = event.shiftKey && dx === 0;
      setViewport((v) => ({ ...v, x: v.x - (horizontal ? dy : dx), y: v.y - (horizontal ? 0 : dy) }));
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
    // The viewport element only exists once the first state arrives.
  }, [setViewport, hasState]);

  // ---- keyboard ----------------------------------------------------------------

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      const mod = event.ctrlKey || event.metaKey;
      if (event.code === "Space" && !event.repeat) {
        setSpaceHeld(true);
        event.preventDefault();
        return;
      }
      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        window.canvasBridge.command(event.shiftKey ? "redo" : "undo");
        return;
      }
      if (mod && event.key.toLowerCase() === "y") {
        event.preventDefault();
        window.canvasBridge.command("redo");
        return;
      }
      const current = stateRef.current;
      if (!current) return;
      if (event.key === "Escape") {
        window.canvasBridge.select([]);
        return;
      }
      const selected = current.selection[0];
      if (event.key === "Enter" && selected) {
        const location = locate(current.doc, selected);
        if (event.shiftKey && location?.parent) window.canvasBridge.select([location.parent.id]);
        else if (!event.shiftKey && location?.node.type === "frame" && location.node.children[0])
          window.canvasBridge.select([location.node.children[0].id]);
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code === "Space") setSpaceHeld(false);
    };
    const blur = () => setSpaceHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // ---- pointer: click selects, any drag pans ---------------------------------------

  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
    /** The node under the pointer at press time; pointer capture retargets later events. */
    targetId: string | null;
    button: number;
  } | null>(null);

  const onPointerDown = (event: React.PointerEvent) => {
    if (event.button > 2) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-id]");
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      moved: false,
      targetId: target?.dataset.id ?? null,
      button: event.button,
    };
    // Middle button, right button and space+left start panning immediately.
    if (event.button !== 0 || spaceHeld) {
      drag.current.moved = true;
      setPanning(true);
      event.preventDefault();
    }
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const current = drag.current;
    if (current && current.pointerId === event.pointerId) {
      if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > DRAG_THRESHOLD) {
        current.moved = true;
        setPanning(true);
      }
      if (current.moved) {
        const dx = event.clientX - current.lastX;
        const dy = event.clientY - current.lastY;
        current.lastX = event.clientX;
        current.lastY = event.clientY;
        setViewport((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      }
      return;
    }
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-id]");
    setHovered(target?.dataset.id ?? null);
  };

  const endDrag = (event: React.PointerEvent, cancelled: boolean) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    setPanning(false);
    if (cancelled || current.moved || current.button !== 0) return;
    const id = current.targetId;
    const selection = stateRef.current?.selection ?? [];
    if (!id) window.canvasBridge.select([]);
    else if (event.shiftKey)
      window.canvasBridge.select(selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id]);
    else window.canvasBridge.select([id]);
  };

  const onDoubleClick = (event: React.MouseEvent) => {
    // Pointer capture retargets dblclick to the viewport; hit-test the cursor instead.
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const target = hit?.closest<HTMLElement>("[data-id]");
    const world = worldRef.current;
    if (!target?.dataset.id || !world) return fitTo(null);
    // First double-click zooms to the screen (top-level node) under the cursor;
    // once that screen fills the view, double-click drills into the element itself.
    let screen: HTMLElement = target;
    while (screen.parentElement && screen.parentElement !== world) screen = screen.parentElement;
    const bounds = unionBounds([screen.dataset.id!]);
    if (bounds) {
      const { width, height } = containerSize();
      const screenFit = fitViewport(bounds, width, height, 2);
      const current = viewportRef.current;
      const alreadyFitted = Math.abs(current.zoom / screenFit.zoom - 1) < 0.05;
      if (!alreadyFitted || screen === target) return animateTo(screenFit);
    }
    fitTo([target.dataset.id], 4);
  };

  // ---- render ----------------------------------------------------------------

  const context = useMemo(() => (state ? { doc: state.doc, docDir: state.docDir } : null), [state?.doc, state?.docDir]);
  const breadcrumb = useMemo(() => {
    const id = state?.selection.length === 1 ? state.selection[0]! : null;
    if (!state || !id) return null;
    const location = locate(state.doc, id.split("/")[0]!);
    if (!location) return null;
    return location.path
      .map((pathId) => {
        const node = locate(state.doc, pathId)!.node;
        return { id: pathId, label: node.name ?? `${node.type} ${pathId}` };
      })
      .concat(id.includes("/") ? [{ id, label: id.split("/").slice(1).join(" › ") }] : []);
  }, [state]);

  if (!state || !context) return <div className="cv-loading" />;

  const fileName = state.filePath ? state.filePath.split(/[\\/]/).pop()!.replace(/\.canvas\.json$/, "") : "Untitled";
  const setupCommand = `claude mcp add --transport http canvas ${state.mcp.url}`;
  const copySetup = () => {
    void navigator.clipboard.writeText(setupCommand).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();

  return (
    <div className="cv-editor">
      <div className="cv-main">
        {sidebarOpen && <Sidebar state={state} />}
        <div
          ref={containerRef}
          className={`cv-viewport${panning ? " is-panning" : spaceHeld ? " is-grab" : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => endDrag(event, false)}
          onPointerCancel={(event) => endDrag(event, true)}
          onPointerLeave={() => setHovered(null)}
          onDoubleClick={onDoubleClick}
          onContextMenu={(event) => event.preventDefault()}
          onAuxClick={(event) => event.preventDefault()}
          style={{
            backgroundPosition: `${viewport.x}px ${viewport.y}px`,
            backgroundSize: `${24 * viewport.zoom}px ${24 * viewport.zoom}px`,
          }}
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
                onPointerDown={stop}
                onPointerUp={stop}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  fitTo([label.id], 4);
                }}
                onClick={() => window.canvasBridge.select([label.id])}
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
              <button className="cv-command" onClick={copySetup} onPointerDown={stop} onPointerUp={stop}>
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
      </div>

      <footer className="cv-status">
        <button
          className={`cv-sidebar-toggle${sidebarOpen ? " is-on" : ""}`}
          title="Toggle sidebar (Ctrl+\)"
          onClick={() => setSidebarOpen((open) => !open)}
        >
          <SidebarIcon />
        </button>
        <span className="cv-file" title={state.filePath ?? "Untitled (recovered automatically)"}>
          {state.project && <span className="cv-file-project">{state.project.name} / </span>}
          {fileName}
          <span className={`cv-save ${state.dirty ? "is-dirty" : ""}`}>
            {state.dirty ? "saving…" : state.filePath ? "saved" : "unsaved"}
          </span>
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
        <button
          className="cv-wheel"
          title={WHEEL_TITLES[wheelMode]}
          onClick={() => setWheelMode((mode) => WHEEL_MODES[(WHEEL_MODES.indexOf(mode) + 1) % WHEEL_MODES.length]!)}
        >
          <MouseIcon />
          {WHEEL_LABELS[wheelMode]}
        </button>
        <span className="cv-zoom-group">
          <button title="Zoom out (Ctrl+-)" onClick={() => runViewCommand("zoom-out")}>
            −
          </button>
          <button className="cv-zoom" title="Reset to 100% (Ctrl+0)" onClick={() => runViewCommand("zoom-reset")}>
            {Math.round(viewport.zoom * 100)}%
          </button>
          <button title="Zoom in (Ctrl+=)" onClick={() => runViewCommand("zoom-in")}>
            +
          </button>
          <button title="Zoom to fit (Shift+1)" onClick={() => runViewCommand("zoom-fit")}>
            <FitIcon />
          </button>
        </span>
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

const SidebarIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9 3v18" />
  </svg>
);

const MouseIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="6" y="3" width="12" height="18" rx="6" />
    <path d="M12 7v4" />
  </svg>
);

const FitIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
  </svg>
);
