import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import { icons as phosphorIcons } from "@phosphor-icons/core";
import lucideTags from "lucide-static/tags.json";

import {
  LEGACY_ICON_SET,
  PHOSPHOR_WEIGHTS,
  type DesignDocument,
  type DesignNode,
  type IconSet,
  type PhosphorWeight,
} from "../shared/schema.ts";
import { expandInstance, walk } from "../shared/tree.ts";

const require = createRequire(__filename);

/** name -> search keywords (tags, categories) */
type Catalog = Map<string, string[]>;
const catalogs = new Map<IconSet, Catalog>();

function catalog(set: IconSet): Catalog {
  let entries = catalogs.get(set);
  if (entries) return entries;
  // Both catalogs are bundled into the main process at build time.
  if (set === "lucide") {
    entries = new Map(Object.entries(lucideTags as Record<string, string[]>));
  } else {
    entries = new Map(
      phosphorIcons.map((icon) => [
        icon.name,
        [...icon.tags.filter((tag) => tag !== "*new*"), ...icon.categories.map(String)],
      ]),
    );
  }
  catalogs.set(set, entries);
  return entries;
}

export function iconExists(name: string, set: IconSet): boolean {
  return catalog(set).has(name);
}

/** Rank icons by how well their name and tags match the query words. */
export function searchIcons(query: string, set: IconSet, limit = 40): string[] {
  const words = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const entries = catalog(set);
  if (!words.length) return [...entries.keys()].slice(0, limit);
  const scored: [string, number][] = [];
  for (const [name, tags] of entries) {
    let score = 0;
    for (const word of words) {
      if (name === word) score += 10;
      else if (name.split("-").includes(word)) score += 6;
      else if (name.includes(word)) score += 4;
      if (tags.some((tag) => tag === word)) score += 3;
      else if (tags.some((tag) => tag.includes(word))) score += 1;
    }
    if (score > 0) scored.push([name, score]);
  }
  scored.sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
  return scored.slice(0, limit).map(([name]) => name);
}

export function suggestIcons(name: string, set: IconSet): string[] {
  const close = [...catalog(set).keys()]
    .map((candidate) => [candidate, editDistance(name, candidate)] as const)
    .filter(([, distance]) => distance <= 2)
    .sort((a, b) => a[1] - b[1])
    .map(([candidate]) => candidate);
  return [...new Set([...close, ...searchIcons(name.replace(/-/g, " "), set, 6)])].slice(0, 6);
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

// ---------------------------------------------------------------------------
// Phosphor glyphs. The renderer gets only the icons a document uses, as SVG
// inner markup keyed "weight:name", so rendering stays synchronous.

let phosphorAssets: string | null = null;
const glyphs = new Map<string, string | null>();

function phosphorGlyph(name: string, weight: PhosphorWeight): string | null {
  const key = `${weight}:${name}`;
  if (glyphs.has(key)) return glyphs.get(key)!;
  let body: string | null = null;
  // Never throw from here: this runs while building renderer state, where an
  // exception would surface as a main-process crash dialog.
  try {
    if (iconExists(name, "phosphor")) {
      phosphorAssets ??= phosphorAssetsDir();
      const file = path.join(phosphorAssets, weight, `${name}${weight === "regular" ? "" : `-${weight}`}.svg`);
      const svg = fs.readFileSync(file, "utf8");
      body = svg.slice(svg.indexOf(">") + 1, svg.lastIndexOf("</svg>"));
    }
  } catch (error) {
    console.error(`[canvas] could not load phosphor icon ${weight}/${name}`, error);
    body = null;
  }
  glyphs.set(key, body);
  return body;
}

/**
 * Phosphor's SVG files. Packaged builds ship them inside the app archive next
 * to dist-electron/; in development they come straight from node_modules.
 */
function phosphorAssetsDir(): string {
  const packaged = path.join(__dirname, "..", "phosphor");
  if (fs.existsSync(packaged)) return packaged;
  // The package's "exports" hide package.json; resolve its main entry (dist/) instead.
  return path.join(path.dirname(require.resolve("@phosphor-icons/core")), "..", "assets");
}

export function glyphKey(name: string, weight: string | undefined): string {
  const w = PHOSPHOR_WEIGHTS.includes(weight as PhosphorWeight) ? weight : "regular";
  return `${w}:${name}`;
}

/** SVG bodies for every Phosphor icon the document renders (including inside instances). */
export function phosphorGlyphsFor(doc: DesignDocument): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (nodes: DesignNode[], depth: number) =>
    walk(nodes, (node) => {
      if (node.type === "instance") {
        const expanded = depth < 12 ? expandInstance(doc, node) : null;
        if (expanded) visit([expanded], depth + 1);
        return;
      }
      if (node.type !== "icon" || (node.set ?? LEGACY_ICON_SET) !== "phosphor") return;
      const key = glyphKey(node.icon, node.weight);
      if (key in out) return;
      const [weight, name] = key.split(":") as [PhosphorWeight, string];
      const body = phosphorGlyph(name, weight);
      if (body !== null) out[key] = body;
    });
  visit(doc.children, 0);
  return out;
}
