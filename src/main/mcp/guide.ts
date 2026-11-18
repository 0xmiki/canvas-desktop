export const SERVER_INSTRUCTIONS = `Canvas is a design canvas you control. The user watches the canvas while you design.
Start with get_state. Call get_guide once per session before your first edit: it is the full node schema.
Designs live in projects (folders of .canvas.json files). When working in a code repo, open_project on a folder like <repo>/design so designs sit next to the code; new_document adds designs to the current project.
Edit with batch (declarative ops) or execute (JavaScript for loops/grids). Every call is one undo step.
Verify visually with screenshot after meaningful changes; fix what looks wrong before moving on.
The user's selection (from get_state) is usually what "this" refers to.`;

export const GUIDE = `# Canvas design guide

## Document model
A document is an infinite canvas of top-level nodes placed by x/y. Screens and boards are top-level
frames (e.g. 1440×900 desktop, 390×844 mobile) laid out side by side with ~120px gaps.
New top-level nodes without x/y are auto-placed to the right of existing ones.

Every node has an \`id\`. You may choose ids yourself ("hero", "nav-cta") so later ops can reference
them in the same batch; ids must be unique and use letters, digits, "_" or "-". Omit to auto-generate.

## Node types
- frame — container. Holds \`children\`. The only type with children.
- text — \`text\` string. Use "\\n" for line breaks.
- rect, ellipse — shapes.
- image — \`src\`: https URL, data: URI, absolute path, or path relative to the document file. \`fit\`: cover|contain|fill.
- icon — \`icon\` name, \`size\` (default 24), \`color\`. Default set is Phosphor (1500+ icons, e.g. "magnifying-glass",
  "house", "gear-six", "arrow-right") with \`weight\`: thin | light | regular (default) | bold | fill | duotone.
  Use one weight consistently (regular or bold for UI, fill for active states, duotone for illustrations).
  \`set: "lucide"\` switches to Lucide (stroke icons; \`strokeWidth\` applies). Find names with list_icons.
- path — \`d\` (SVG path data), optional \`viewBox\` (defaults to "0 0 width height"), \`fillRule\`. Fill/stroke apply.
- svg — \`svg\` raw markup, scaled to the node box. Good for logos and illustrations.
- instance — \`ref\`: id of a frame with \`component: true\`. Renders the component; own props
  (x, y, width, fill, …) override the component root. \`overrides\`: { "<descendant id>": { props } }.

## Common properties (all types)
name, visible, opacity (0–1), rotation (deg, around center), x, y, absolute,
width, height, minWidth, maxWidth, minHeight, maxHeight,
fill, stroke, radius, shadow, blur, backdropBlur, blendMode, notes.

### Sizing
width/height: number (px) | "fill" (take remaining space in the parent, or 100% in free layout) |
"hug" (fit content). Frames with layout row/column/grid default to hug. Free-layout frames
(\`layout\` none) don't grow with content: give them explicit sizes. Text defaults to hug (single line,
no wrapping); give text a width (number or "fill") to make it wrap.

### Paint
fill: CSS color ("#0f172a", "rgb(…)", "transparent") | "$variable" |
{ type: "linear", angle: 135, stops: [{ color, position: 0 }, { color, position: 1 }] } |
{ type: "radial", stops: [...] } | { type: "image", src, fit } | an array of these (first is on top).

stroke: { color, width = 1, style: solid|dashed|dotted, align: inside|center|outside } (or just "#e5e7eb").
Strokes never affect layout.
radius: number or [topLeft, topRight, bottomRight, bottomLeft].
shadow: { x, y, blur, spread, color, inset } or an array of them.

## Frame layout (flexbox)
layout: "none" (default; children placed by x/y) | "row" | "column" | "grid".
gap (px), padding: n | [vertical, horizontal] | [top, right, bottom, left],
justify (main axis): start|center|end|space-between|space-around|space-evenly,
align (cross axis): start|center|end|stretch|baseline, wrap: boolean,
grid: columns: 3 or "200px 1fr 1fr", rows, rowGap, columnGap.
clip: true clips children to the frame (use for screens, cards with images, scroll areas).
A child with \`absolute: true\` ignores the parent's layout and sits at its x/y (badges, overlays).

## Text properties
text, color (paint; gradients work), fontFamily (any Google Font or installed font, default "Inter"),
fontSize (default 16), fontWeight (100–900), fontStyle, lineHeight (number = multiplier, or "24px"),
letterSpacing (px), textAlign, textDecoration, textTransform, maxLines (ellipsis).
On text and icon nodes, \`fill\` is accepted as an alias for \`color\`.

## Variables (design tokens)
Set with the batch op { op: "variables", set: { primary: "#4f46e5", "radius-md": 12 } }.
Use anywhere as a string "$primary", "$radius-md". Updating a variable restyles every use.

## Components
Make a frame with \`component: true\`, then place { type: "instance", ref: "<component id>" }.
Inside an instance, descendants are addressed as "<instance id>/<descendant id>" — use that id with
update to override text, colors, icons, visibility. { op: "detach", id } turns an instance into
plain, editable frames.

## batch ops
{ op: "create", parent?: id (omit for top level), index?: n, node: { …, children: [...] } }
{ op: "update", id, set: { prop: value, prop2: null /* null removes */ } }
{ op: "delete", id }
{ op: "move", id, parent?: id | null (null = top level), index?: n, x?, y? }
{ op: "duplicate", id, parent?, index?, x?, y?, set?: { … } }  → returns the copy's id
{ op: "replace", id, node }   (rebuild a subtree, keeping its id)
{ op: "detach", id }
{ op: "variables", set: { name: value | null } }
A batch is atomic: if any op fails, nothing changes and the error says which op and why.

## execute (JavaScript)
For repetitive or computed work. Synchronous JS with a \`canvas\` object:
canvas.create(node, parentId?, index?) → id      canvas.update(id, set)       canvas.delete(id)
canvas.move(id, parentId, index?)                  canvas.duplicate(id, { parent, index, x, y, set }) → id
canvas.get(id) → node copy | null                 canvas.children(parentId?) → node copies
canvas.find({ type, name, text }) or canvas.find(node => bool) → node copies
canvas.variables → object                          canvas.setVariables({ name: value })
console.log(...) output and the script's last expression are returned. All changes are one undo step.

## Projects and designs
A project is a folder of designs (\`*.canvas.json\`). list_projects shows known projects and the current
project's designs; open_project opens (or creates) a folder; new_document { name } adds a design to it;
open_document accepts a design name from the current project, a project-relative path, or an absolute path.
Use one design per feature or flow (e.g. "Onboarding", "Settings"), with its screens as top-level frames.

## Workflow
1. get_state → see the project, the open design, the user's selection, and existing screens.
2. Build big structures in one batch (a whole screen as one nested create). Prefer auto layout
   (row/column) over absolute x/y inside screens so things stay aligned when content changes.
3. screenshot the frame you changed. Look for overlaps, clipping, misalignment, low contrast.
4. Iterate with small update ops. Reuse with components when something repeats 3+ times.
5. The document autosaves once it has a path; untitled documents are kept as recovery until
   saved with save_document.

## Design quality
- Spacing on a 4/8px scale. Generous padding: 24–32 desktop sections, 16–20 mobile.
- Type scale with clear hierarchy (e.g. 12/14/16/20/24/32/48). Body line-height ~1.5, headings ~1.15.
- Limit palette: one accent, neutrals, semantic colors. Define them as variables first.
- Align to a grid; consistent radii (pick 2–3 values); subtle borders (#e5e7eb-ish) and soft shadows.
- Real-looking content (names, numbers, copy), not lorem ipsum.

## Example: a card
{ op: "create", node: {
  type: "frame", id: "plan-card", name: "Plan card", width: 320, layout: "column", gap: 16,
  padding: 24, fill: "#ffffff", radius: 16, stroke: { color: "#e5e7eb" },
  shadow: { y: 8, blur: 24, color: "rgba(15,23,42,0.08)" },
  children: [
    { type: "text", text: "Pro", fontSize: 14, fontWeight: 600, color: "$primary" },
    { type: "frame", layout: "row", align: "baseline", gap: 4, children: [
      { type: "text", text: "$24", fontSize: 40, fontWeight: 700, color: "#0f172a" },
      { type: "text", text: "/month", fontSize: 14, color: "#64748b" } ] },
    { type: "text", text: "Everything in Starter, plus unlimited projects.", width: "fill",
      fontSize: 14, lineHeight: 1.5, color: "#475569" },
    { type: "frame", layout: "row", justify: "center", align: "center", gap: 8, width: "fill",
      height: 44, radius: 10, fill: "$primary", children: [
      { type: "text", text: "Upgrade", fontWeight: 600, color: "#fff" },
      { type: "icon", icon: "arrow-right", size: 18, color: "#fff" } ] } ] } }
`;
