import { useCallback, useEffect, useRef, useState } from "react";

import type { Bounds } from "../shared/ipc.ts";

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 64;
export const clampZoom = (zoom: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

const ANIMATION_MS = 240;
const ease = (t: number) => 1 - (1 - t) ** 3;

/**
 * Viewport state with animated transitions. Direct manipulation (wheel, drag)
 * uses `set`, which cancels any running animation; programmatic moves
 * (fit, focus, zoom buttons) use `animateTo`.
 */
export function useViewport(initial: Viewport) {
  const [viewport, setViewport] = useState(initial);
  const ref = useRef(viewport);
  ref.current = viewport;
  const frame = useRef<number | null>(null);

  const cancel = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);

  const set = useCallback(
    (update: Viewport | ((current: Viewport) => Viewport)) => {
      cancel();
      setViewport(update);
    },
    [cancel],
  );

  const animateTo = useCallback(
    (target: Viewport) => {
      cancel();
      // Hidden or minimized windows throttle animation frames; just jump.
      if (document.visibilityState === "hidden") {
        setViewport(target);
        return;
      }
      const from = ref.current;
      const start = performance.now();
      // Interpolate zoom in log space so zooming feels uniform.
      const logFrom = Math.log(from.zoom);
      const logTo = Math.log(target.zoom);
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / ANIMATION_MS);
        const k = ease(t);
        const zoom = Math.exp(logFrom + (logTo - logFrom) * k);
        // Keep the motion straight in screen space by blending the canvas point at the screen origin.
        const fromCanvasX = -from.x / from.zoom;
        const fromCanvasY = -from.y / from.zoom;
        const toCanvasX = -target.x / target.zoom;
        const toCanvasY = -target.y / target.zoom;
        const cx = fromCanvasX + (toCanvasX - fromCanvasX) * k;
        const cy = fromCanvasY + (toCanvasY - fromCanvasY) * k;
        setViewport({ zoom, x: -cx * zoom, y: -cy * zoom });
        frame.current = t < 1 ? requestAnimationFrame(step) : null;
      };
      frame.current = requestAnimationFrame(step);
    },
    [cancel],
  );

  useEffect(() => cancel, [cancel]);

  return { viewport, viewportRef: ref, set, animateTo };
}

/** The viewport that fits `bounds` into a `width`×`height` area with padding. */
export function fitViewport(bounds: Bounds, width: number, height: number, maxZoom: number, pad = 64): Viewport {
  const zoom = clampZoom(
    Math.min((width - pad * 2) / Math.max(bounds.width, 1), (height - pad * 2) / Math.max(bounds.height, 1), maxZoom),
  );
  return {
    zoom,
    x: (width - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: (height - bounds.height * zoom) / 2 - bounds.y * zoom,
  };
}

/** Zoom by `factor` keeping the screen point (px, py) fixed. */
export function zoomAround(v: Viewport, factor: number, px: number, py: number): Viewport {
  const zoom = clampZoom(v.zoom * factor);
  const k = zoom / v.zoom;
  return { zoom, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
}

export type WheelMode = "auto" | "zoom" | "pan";

/**
 * Mouse wheels send coarse, integer, vertical-only steps; trackpads send
 * fine-grained or two-axis deltas. In auto mode the wheel zooms and the
 * trackpad pans (pinch arrives as ctrl+wheel and always zooms).
 */
export function isMouseWheel(event: WheelEvent): boolean {
  if (event.deltaMode !== 0) return true; // line/page units only come from wheels
  return event.deltaX === 0 && Number.isInteger(event.deltaY) && Math.abs(event.deltaY) >= 50;
}
