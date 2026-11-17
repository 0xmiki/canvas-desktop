import type { Bounds } from "../../shared/ipc.ts";

export function elementFor(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
}

/** Bounds in canvas coordinates. `world` is the element whose origin is canvas (0,0), scaled by `zoom`. */
export function boundsOf(element: Element, world: HTMLElement, zoom: number): Bounds {
  const origin = world.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return {
    x: (rect.left - origin.left) / zoom,
    y: (rect.top - origin.top) / zoom,
    width: rect.width / zoom,
    height: rect.height / zoom,
  };
}

export function measureAll(world: HTMLElement, zoom: number, ids: string[] | null) {
  const bounds: Record<string, Bounds> = {};
  const elements = ids
    ? ids.flatMap((id) => {
        const element = elementFor(world, id);
        return element ? [element] : [];
      })
    : [...world.querySelectorAll<HTMLElement>("[data-id]")];
  for (const element of elements) {
    bounds[element.dataset.id!] = boundsOf(element, world, zoom);
  }
  return { bounds, issues: ids ? [] : findIssues(world, zoom) };
}

/** Layout problems worth telling an agent about. */
function findIssues(world: HTMLElement, zoom: number) {
  const issues: { id: string; issue: string }[] = [];
  for (const element of world.querySelectorAll<HTMLElement>("[data-id]")) {
    const id = element.dataset.id!;
    if (element.style.display === "none" || element.offsetParent === null) continue;
    const rect = element.getBoundingClientRect();
    const width = rect.width / zoom;
    const height = rect.height / zoom;
    if (width < 0.5 || height < 0.5) {
      issues.push({ id, issue: `collapsed to ${Math.round(width)}×${Math.round(height)} (needs a size or content)` });
      continue;
    }
    const type = element.dataset.type;
    if (type === "text" && element.style.webkitLineClamp === "" && element.scrollHeight > element.clientHeight + 2) {
      issues.push({ id, issue: "text is taller than its fixed height and spills out" });
    }
    const isTopLevel = element.parentElement === world;
    if (type !== "frame" || isTopLevel || element.style.overflow === "hidden") continue;
    let right = 0;
    let bottom = 0;
    for (const child of element.children) {
      if (!(child instanceof HTMLElement) || !child.dataset.id || child.style.display === "none") continue;
      const childRect = child.getBoundingClientRect();
      right = Math.max(right, (childRect.right - rect.right) / zoom);
      bottom = Math.max(bottom, (childRect.bottom - rect.bottom) / zoom);
    }
    if (right > 1 || bottom > 1) {
      const parts = [right > 1 ? `${Math.round(right)}px right` : "", bottom > 1 ? `${Math.round(bottom)}px bottom` : ""];
      issues.push({ id, issue: `children overflow the frame by ${parts.filter(Boolean).join(", ")}` });
    }
  }
  return issues.slice(0, 200);
}

/** Wait for <img> elements and CSS background images under `root` to decode. */
export async function imagesReady(root: HTMLElement, timeoutMs = 8000) {
  const waits: Promise<unknown>[] = [];
  for (const img of root.querySelectorAll("img")) {
    if (!img.complete) waits.push(img.decode().catch(() => undefined));
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-id]")) {
    const background = element.style.backgroundImage;
    for (const match of background.matchAll(/url\("([^"]+)"\)/g)) {
      const image = new Image();
      image.src = match[1]!;
      waits.push(image.decode().catch(() => undefined));
    }
  }
  await Promise.race([Promise.all(waits), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}

export const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
