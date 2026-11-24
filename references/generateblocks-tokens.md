# GenerateBlocks Pro design tokens (optional output)

Optional second output of `sync.mjs`: `--gb-out <dir>` generates GenerateBlocks Pro design tokens
from the same Figma tokens. Only for sites with GenerateBlocks Pro 2.8+ (Design Tokens). Files are
written only with `--apply`; the script never touches a WordPress site.

## Outputs

- `generateblocks-design-system-<YYYYMMDD-HHMMSS>.json`: import file (`kind: generateblocks/design-system`). Import it
  in the GenerateBlocks Design dashboard. Import **adds missing tokens only**; it does not update
  values of tokens that already exist.
- `generateblocks-tokens-<YYYYMMDD-HHMMSS>.css`: the same variables as plain declarations. Paste into GenerateBlocks
  **CSS Mode** to set values (this is the format GenerateBlocks CSS Mode shows). Pasting here is the
  expected way to update existing values, but this has not been verified on a live site: say so, and
  ask the user to confirm it the first time.

Files always carry a timestamp, so earlier exports are never overwritten. Output folder: `--gb-out <dir>`,
or `generateblocks.outDir` in the config (relative paths resolve against the theme folder; setting it
turns the GenerateBlocks output on without the flag). The flag overrides the config.

## Modes (`--gb-mode`)

| Mode | Token value | Notes |
|---|---|---|
| `values` (default) | literal: `0.75rem`, `8px` | |
| `alias` | `var(--wp--preset--spacing--8)` | theme.json stays the single source of truth, so value changes in Figma reach GenerateBlocks through theme.json without touching the tokens. Radius has no verified preset variable, so radius stays literal |

## Naming and mapping

**Colors are not generated:** GenerateBlocks already offers the theme.json colors in its color picker.

Variable name: `--<prefix><kind>-<slug>`, for example `--font-size-16`,
`--spacing-8`, `--radius-full`, `--font-family-heading`.

| Collection | kind | type | control | default category | scope |
|---|---|---|---|---|---|
| fontSizes | `font-size` | `unit` | `unitControl` | Typography | `fontSize` (inferred) |
| spacingSizes | `spacing` | `unit` | `unitControl` | Spacing | margins, paddings, `columnGap`, `rowGap` (seen in a real export) |
| radiusSizes | `radius` | `unit` | `unitControl` | Radius | 4 `border*Radius` corners (inferred) |
| fontFamilies | `font-family` | `text` | none (`display` omitted) | Typography | `fontFamily` (seen in a real export) |

Not generated: font weight, line height, layout (no verified token convention; `--gb-container-width`
is a special GenerateBlocks token that takes over the container width, not wired up yet).

## Fluid values

Variables that are fluid in Figma (Mobile and Desktop modes differ) become one `clamp()` in the
GenerateBlocks token, including font sizes (built from the theme.json `fluid` min and max), using the
same viewport range as the theme.json output. In `alias` mode the token points at the theme.json
preset, which already carries the fluid value.

## Config (`figma-sync.config.json`)

```json
{
  "generateblocks": {
    "outDir": "../../gb-tokens",
    "mode": "values",
    "prefix": "",
    "include": ["fontSizes", "spacingSizes"],
    "categories": { "spacingSizes": "Theme Variables" },
    "scopes": { "fontSizes": ["fontSize", "lineHeight"] }
  }
}
```

## Format reference

A real GenerateBlocks Pro export is in
`examples/generateblocks-design-tokens.export.json`. Fields per token: `name`, `type`
(`color` | `unit` | `text`), `label`, `scope` (camel-case CSS properties), `category` (may be empty),
`display.control` (`colorPicker` | `unitControl`; absent for text). Values live in
`globalStyles[0].styles` under selector `:root`. Responsive values would be extra keys such as
`"@media (max-width:767px)"` inside `styles` (seen in a third-party example, not generated yet).

Caveat: the import format is version-specific; if GenerateBlocks rejects a file, ask for a fresh
export and compare the structure with the generated file.
