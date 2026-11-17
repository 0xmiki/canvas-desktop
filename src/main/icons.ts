import { createRequire } from "node:module";

const require = createRequire(__filename);

let tags: Record<string, string[]> | null = null;

function catalog(): Record<string, string[]> {
  tags ??= require("lucide-static/tags.json") as Record<string, string[]>;
  return tags;
}

export function iconExists(name: string): boolean {
  return Object.hasOwn(catalog(), name);
}

/** Rank icons by how well their name and tags match the query words. */
export function searchIcons(query: string, limit = 40): string[] {
  const words = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!words.length) return Object.keys(catalog()).slice(0, limit);
  const scored: [string, number][] = [];
  for (const [name, iconTags] of Object.entries(catalog())) {
    let score = 0;
    for (const word of words) {
      if (name === word) score += 10;
      else if (name.split("-").includes(word)) score += 6;
      else if (name.includes(word)) score += 4;
      if (iconTags.some((tag) => tag === word)) score += 3;
      else if (iconTags.some((tag) => tag.includes(word))) score += 1;
    }
    if (score > 0) scored.push([name, score]);
  }
  scored.sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
  return scored.slice(0, limit).map(([name]) => name);
}

export function suggestIcons(name: string): string[] {
  const close = Object.keys(catalog())
    .map((candidate) => [candidate, editDistance(name, candidate)] as const)
    .filter(([, distance]) => distance <= 2)
    .sort((a, b) => a[1] - b[1])
    .map(([candidate]) => candidate);
  return [...new Set([...close, ...searchIcons(name.replace(/-/g, " "), 6)])].slice(0, 6);
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
