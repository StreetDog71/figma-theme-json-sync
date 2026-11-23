---
name: figma-theme-json-sync
description: Sync a Figma file's variables (design tokens) into a WordPress block theme's theme.json (color palette, font sizes, font families, spacing, border radius, layout, font weight, line height) without touching the rest of the file. Use when the user gives a Figma file URL and a theme.json, asks to import or update design tokens/variables from Figma into theme.json, wants to know which tokens theme.json already has, or wants to re-sync after changing Figma variables. No Figma plugin and no Enterprise plan needed.
---

# Figma variables -> theme.json

One-way sync (Figma -> theme.json). Two separate jobs:

1. **Reading Figma (you, the agent).** Read the file's variables and write them to a small
   `tokens.json`. How: `references/reading-figma-variables.md`. Preferred: the Figma MCP `use_figma`
   tool running the read-only `scripts/read-figma-variables.js` (complete, with collections, modes
   and aliases). Fallback when the MCP is not connected: Claude in Chrome reading the Variables
   panel. Do not use `get_variable_defs` as the source: it is incomplete.
2. **Mapping and merging (the script, deterministic).** `scripts/sync.mjs` maps tokens onto
   theme.json presets and edits only those collections. Everything else in theme.json (styles,
   blocks, templateParts, formatting, key order) stays byte-for-byte. Never hand-edit theme.json
   JSON for this task.

It works on a Figma Professional plan: the Variables REST API is Enterprise only, so it is not used, and
no export plugin is needed. The Figma MCP (remote server, Full seat) is the way in. `use_figma` can also write to the file: for this skill only ever run the
read-only reader script, never anything that creates, edits or deletes.

## Workflow

Script: `~/.claude/skills/figma-theme-json-sync/scripts/sync.mjs` (Node, no dependencies). Quote
paths; they may contain spaces.

1. Get the Figma file URL and the theme.json path from the user.
2. Read the variables into `tokens.json` (write it to the scratchpad or a temp dir, not into the
   theme). Follow `references/reading-figma-variables.md`, including its verification step.
3. Optional: `node sync.mjs --theme <theme.json> --tokens <tokens.json> --inspect` shows which token
   collections theme.json already has and how many the tokens would provide.
4. **Dry run** (default, writes nothing): `node sync.mjs --theme <theme.json> --tokens <tokens.json>`.
   Show the user the mapping header and the report, and explain them.
5. Ask before applying (suggest a git commit or backup first). Apply with `--apply`. This also writes
   `.figma-sync-state.json` next to theme.json; recommend committing it.
6. Relay "Possibly dangling preset references". Offer to fix references only if asked.

## What goes where (default mapping)

Variables are routed by type, top-level group and collection name:

| Figma | theme.json | Notes |
|---|---|---|
| `color` variables in any collection except primitive ones (`/primitive\|core\|ref/i`) | `settings.color.palette` | slug = full path joined with `-` (`background/canvas` -> `background-canvas`); aliases resolved to hex |
| group `font-size` (number) | `settings.typography.fontSizes` | px -> rem (base 16) |
| group `spacing` | `settings.spacing.spacingSizes` | px |
| group `radius` | `settings.border.radiusSizes` | px. Native radius presets, as Ollie does |
| group `font-family` (string) | `settings.typography.fontFamilies` | adds a fallback (`Outfit` -> `Outfit, sans-serif`); no `fontFace`, add font files by hand |
| group `font-weight` / `line-height` | `settings.custom.fontWeight` / `lineHeight` | raw numbers, like Frost and Ollie |
| group `layout` (`contentSize`, `wideSize`) | `settings.layout` | px |

Primitive color collections are excluded by default because Frost and Ollie both keep only semantic
roles in the palette; the report says how many were excluded. Include them with
`rules.palette.collections`.

Names: `slug` comes from the variable path, `name` is the title-cased slug (numeric slugs become
`Font Size 12`). Rename in Figma and re-sync; the old slug is removed only if it was in the state file.

## Report symbols

| Symbol | Meaning |
|---|---|
| `+` | added (new array entries are appended at the end) |
| `~` | value updated from Figma |
| `-` | removed: deleted in Figma (it was in the state file), or `--prune` |
| `?` | exists only in theme.json (the theme's own tokens); kept |
| `=` | edited in theme.json since the last sync, Figma unchanged: hand edit kept |
| `!` | CONFLICT, changed on both sides since the last sync: skipped. `--force` makes Figma win |
| `.` | collection not present in the tokens, left alone |

## Behaviour to know about

- **First sync (no state file):** where a slug exists on both sides with a different value, Figma wins
  (e.g. Ollie's `full` radius `100rem` becomes `9999px`). The dry run shows this before anything is written.
- **Theme's own tokens stay** (Frost's `base`, `contrast`...) unless `--prune`. Pruning can orphan
  references in `styles`, templates, parts and patterns; the dangling-reference scan lists them
  (`var:preset|color|x`, `--wp--preset--*--x`, block attributes such as `"backgroundColor":"x"`). It is a
  text scan: treat it as a checklist.
- Hex colors compare case-insensitively. Only listed fields are updated (`name` + the value), so
  hand-written fields such as `fluid` or `fontFace` are never touched.
- Before writing, the script verifies that nothing outside the managed paths changed and that a second
  run would be a no-op. If a check fails it writes nothing.
- **Fluid values.** A collection with a `Mobile` and a `Desktop` mode (matched by name, case-insensitive)
  makes every numeric size variable fluid when its two values differ. Font sizes get theme.json's native
  `fluid: {min, max}` (`size` = Desktop value); equal values get `fluid: false`, so they stay static
  even when the theme has fluid typography on. Spacing, radius and other sizes get a
  `clamp(min, calc(intercept + slope vw), max)` interpolating linearly between the viewport widths
  (default 320-1200px, e.g. 24 -> 48 gives `clamp(24px, calc(15.273px + 2.727vw), 48px)`). Decreasing
  values work too. Font weight and line height are unitless and use the Desktop value; the report notes
  any that differ between modes. Layout sizes are never fluid. Fluid font sizes need
  `settings.typography.fluid` enabled in the theme (the report warns when it is not). Collections
  without those two modes (colors) use their first mode. Light/dark modes and style variations are
  not supported yet.

## Optional: GenerateBlocks design tokens

Only when the user asks (or uses GenerateBlocks Pro 2.8+ and wants it). Add `--gb-out <dir>` to the
same command: it also generates a GenerateBlocks design-system import file and a CSS Mode snippet
from the same Figma tokens. Default `--gb-mode values` (literal values, color previews work);
`--gb-mode alias` points tokens at the theme.json presets instead (single source of truth, but the
swatch preview stays blank in GenerateBlocks). Files are written only with `--apply`, with a timestamp in the name so they never overwrite each other; the folder is `--gb-out` or config `generateblocks.outDir`. Details,
naming, mapping, caveats (import only adds missing tokens; update values via CSS Mode):
`references/generateblocks-tokens.md`.

## Config (optional)

`figma-sync.config.json` next to theme.json (or `--config`):

```json
{
  "mode": "Default",
  "fluid": { "minMode": "Mobile", "maxMode": "Desktop", "minViewport": 320, "maxViewport": 1200 },
  "rootFontSize": 16,
  "rules": {
    "fontSizes": { "unit": "px" },
    "palette": { "collections": ["Colors", "Color primitives"] },
    "fontFamilies": false
  },
  "collections": {
    "fontSizes": { "fields": ["name", "size", "fluid"] },
    "shadows": { "path": ["settings", "shadow", "presets"], "type": "array", "key": "slug", "fields": ["name", "shadow"] }
  }
}
```

`mode` forces one mode everywhere and turns fluid off; `"fluid": false` turns fluid off only. `fluid`
overrides the mode names and viewport range.
`rules` changes how Figma variables are routed (`false` disables a rule; `group`/`collectionNot` are
regex strings). `collections` changes what is merged into theme.json.

## Suggested Figma conventions (for a design system that feeds theme.json)

Name groups as in the table (`font-size/…`, `spacing/…`, `radius/…`, `font-family/…`,
`font-weight/…`, `line-height/…`, `layout/contentSize`, `layout/wideSize`), keep primitives in their
own collection and semantic color roles in another, and use t-shirt or role names instead of pixel
numbers where you can (`font-size/large`, not `font-size/24`): the number stops being true the day the
value changes, and the slug becomes the CSS variable (`--wp--preset--font-size--large`).

## Not supported yet

theme.json -> Figma, light/dark modes, extra breakpoints beyond Mobile/Desktop, shadows and text styles (they are
styles, not variables), alias preservation (aliases are resolved to final values).
