import type { DesignDocument, DesignNode } from "../../shared/schema.ts";
import { expandInstance, walk } from "../../shared/tree.ts";

const GENERIC = new Set([
  "system-ui", "sans-serif", "serif", "monospace", "cursive", "fantasy", "ui-sans-serif",
  "ui-serif", "ui-monospace", "-apple-system", "arial", "helvetica", "times new roman",
  "georgia", "courier new", "verdana",
]);

const linked = new Set<string>();

interface FontUse {
  family: string;
  weight: string;
  style: string;
}

function resolveFamily(value: unknown, variables: DesignDocument["variables"]): string {
  let family = typeof value === "string" && value.trim() ? value.trim() : "Inter";
  if (family.startsWith("$")) family = String(variables[family.slice(1)] ?? "Inter");
  return family;
}

export function collectFonts(doc: DesignDocument, roots: DesignNode[] = doc.children): FontUse[] {
  const uses = new Map<string, FontUse>();
  const visit = (nodes: DesignNode[]) =>
    walk(nodes, (node) => {
      if (node.type === "instance") {
        const expanded = expandInstance(doc, node);
        if (expanded) visit([expanded]);
        return;
      }
      if (node.type !== "text") return;
      const family = resolveFamily(node.fontFamily, doc.variables);
      const weightValue = typeof node.fontWeight === "string" && node.fontWeight.startsWith("$")
        ? doc.variables[node.fontWeight.slice(1)]
        : node.fontWeight;
      const weight = String(weightValue ?? 400);
      const style = node.fontStyle === "italic" ? "italic" : "normal";
      uses.set(`${family}|${weight}|${style}`, { family, weight, style });
    });
  visit(roots);
  return [...uses.values()];
}

/** Link Google Fonts stylesheets for families we haven't seen. Unknown families fall back to local fonts. */
export function linkFonts(uses: FontUse[]) {
  for (const { family } of uses) {
    if (GENERIC.has(family.toLowerCase()) || linked.has(family)) continue;
    linked.add(family);
    const variants = [100, 200, 300, 400, 500, 600, 700, 800, 900].flatMap((w) => [`${w}`, `${w}italic`]).join(",");
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = `https://fonts.googleapis.com/css?family=${encodeURIComponent(family)}:${variants}&display=block`;
    link.dataset.family = family;
    document.head.appendChild(link);
  }
}

export function googleFontLinks(uses: FontUse[]): string[] {
  return [...new Set(uses.map((u) => u.family))]
    .filter((family) => !GENERIC.has(family.toLowerCase()))
    .map(
      (family) =>
        `https://fonts.googleapis.com/css?family=${encodeURIComponent(family)}:100,200,300,400,500,600,700,800,900,400italic,700italic&display=swap`,
    );
}

/** Resolve once the fonts this document uses are loaded (or the timeout passes). */
export async function fontsReady(uses: FontUse[], timeoutMs = 4000) {
  linkFonts(uses);
  const stylesheets = [...document.querySelectorAll<HTMLLinkElement>("link[data-family]")].map(
    (link) =>
      link.sheet
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            link.addEventListener("load", () => resolve(), { once: true });
            link.addEventListener("error", () => resolve(), { once: true });
          }),
  );
  const work = Promise.all(stylesheets).then(() =>
    Promise.all(
      uses.map((use) =>
        document.fonts.load(`${use.style} ${use.weight} 16px "${use.family.replace(/"/g, "")}"`).catch(() => []),
      ),
    ),
  );
  // The timeout bounds everything, including fonts.ready: a slow or offline
  // network must degrade to fallback fonts, never hang a render.
  await Promise.race([
    work.then(() => document.fonts.ready),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
