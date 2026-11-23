# figma-theme-json-sync

A [Claude Code](https://claude.com/claude-code) skill that syncs the **variables of a Figma file** into a
**WordPress block theme's `theme.json`**, and optionally into **GenerateBlocks Pro design tokens**.

- No Figma export plugin.
- No Enterprise plan: Claude reads the variables through the Figma MCP (works on Professional with a Full or Dev seat).
- Non-destructive: only the token collections are edited. The rest of `theme.json` (styles, blocks, template parts,
  formatting, key order) stays byte-for-byte identical.
- Re-sync whenever the Figma variables change. Hand edits in `theme.json` are respected; real conflicts are reported.
- Fluid values: give a collection a **Desktop** and a **Mobile** mode and font sizes, spacing, radius, etc. become fluid.

Direction: Figma -> theme.json only.

## How it works

1. **Claude reads Figma** (`use_figma` with a read-only script, see `scripts/read-figma-variables.js`) and writes a
   small `tokens.json`: collections, modes, variables, aliases.
2. **`scripts/sync.mjs` merges** the tokens into `theme.json` (plain Node, no dependencies). It is deterministic and
   does surgical text edits, so nothing else in the file moves.
3. You review the dry-run report, then Claude applies it.

## Requirements

- [Claude Code](https://claude.com/claude-code)
- Node.js 18+
- The [Figma MCP server](https://developers.figma.com/docs/figma-mcp-server/) connected to Claude Code
  (`claude mcp add --transport http figma https://mcp.figma.com/mcp`, then authenticate), with edit access to the
  Figma file (a Full or Dev seat).

## Install

Clone it into your personal skills folder:

```bash
git clone https://github.com/<your-user>/figma-theme-json-sync.git ~/.claude/skills/figma-theme-json-sync
```

Or install it for one project only, in `<project>/.claude/skills/figma-theme-json-sync`.

## Use

In Claude Code, say something like:

> Sync the variables from https://www.figma.com/design/ABC123/My-Design-System into `wp-content/themes/my-theme/theme.json`

or invoke it with `/figma-theme-json-sync`. Claude will read the file, show a **dry run** (nothing written), and ask
before applying.

To run the merge by hand from a `tokens.json`:

```bash
node scripts/sync.mjs --theme path/to/theme.json --tokens tokens.json            # dry run
node scripts/sync.mjs --theme path/to/theme.json --tokens tokens.json --apply    # write
```

Without `--apply` nothing is written (theme.json, state file and GenerateBlocks files alike).

### Options

| Option | Effect |
|---|---|
| `--theme <file>` | Target `theme.json` (required) |
| `--tokens <file>` | Figma variables as `tokens.json` (required unless `--inspect`) |
| `--inspect` | Only report which token collections exist |
| `--apply` | Write changes |
| `--prune` | Also remove managed entries that are no longer in Figma |
| `--force` | Figma wins even where `theme.json` was edited since the last sync |
| `--gb-out <dir>` | Also generate GenerateBlocks Pro tokens into `<dir>` (timestamped files) |
| `--gb-mode values\|alias` | Literal values (default) or `var(--wp--preset--...)` references |
| `--config <file>` | Config file (default: `figma-sync.config.json` next to `theme.json`) |
| `--state <file>` | State file (default: `.figma-sync-state.json` next to `theme.json`) |

## What gets mapped

| Figma | theme.json |
|---|---|
| color variables (primitive collections excluded) | `settings.color.palette` |
| `font-size/*` | `settings.typography.fontSizes` (px -> rem) |
| `spacing/*` | `settings.spacing.spacingSizes` |
| `radius/*` | `settings.border.radiusSizes` |
| `font-family/*` | `settings.typography.fontFamilies` |
| `font-weight/*`, `line-height/*` | `settings.custom.fontWeight`, `settings.custom.lineHeight` |
| `layout/contentSize`, `layout/wideSize` | `settings.layout` |

Naming conventions, report symbols (`+ ~ - ? = !`), first-sync behaviour and the fluid maths are documented in
[SKILL.md](SKILL.md).

## Fluid values

When a collection has modes named **Mobile** and **Desktop**:

- font sizes get theme.json's native `fluid: { min, max }`;
- everything else becomes `clamp(min, calc(intercept + slope vw), max)` between 320px and 1200px (configurable).

Fluid font sizes need `settings.typography.fluid` enabled in the theme; the report warns if it is not.

## GenerateBlocks Pro design tokens (optional)

Add `--gb-out <dir>` (or `generateblocks.outDir` in the config) to also generate a GenerateBlocks design-system import
file and a CSS Mode snippet, both timestamped so earlier exports are never overwritten. You import the file by hand in
the GenerateBlocks Design dashboard. See [references/generateblocks-tokens.md](references/generateblocks-tokens.md).

## Configuration

Optional `figma-sync.config.json` next to `theme.json`:

```json
{
  "fluid": { "minMode": "Mobile", "maxMode": "Desktop", "minViewport": 320, "maxViewport": 1200 },
  "rootFontSize": 16,
  "rules": { "fontSizes": { "unit": "rem" }, "palette": { "collections": ["Colors"] } },
  "generateblocks": { "outDir": "../../gb-tokens", "mode": "alias" }
}
```

All options are listed in [SKILL.md](SKILL.md#config-optional).

## Repository layout

```
SKILL.md                         skill instructions Claude follows
scripts/sync.mjs                 deterministic mapper/merger (Node, no deps)
scripts/read-figma-variables.js  read-only Figma Plugin API script
references/                      how to read Figma; GenerateBlocks details
examples/                        sample tokens.json and a GenerateBlocks export
tests/smoke.mjs                  `npm test`
```

## Limitations

- Figma -> theme.json only (not the reverse).
- Light/dark modes, extra breakpoints beyond Mobile/Desktop, shadows and text styles are not supported.
- Aliases are resolved to final values.
- The GenerateBlocks import format is version specific (written against Pro 2.8). Importing only adds missing tokens;
  updating existing values via CSS Mode has not been verified on a live site. Font size and radius token scopes are inferred.
- `use_figma` can write to a Figma file; this skill only ever runs the read-only reader script.

## Development

```bash
npm test
```

## License

[MIT](LICENSE)
