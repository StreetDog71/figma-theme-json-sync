# Changelog

## Unreleased
- Presets follow the order of the Figma variables (config `"order": "theme"` keeps the existing order).
- Fix: numbers from Figma are rounded to 4 decimals (no more `1.100000023841858`).
- Fix: the dangling-reference scan ignores generated GenerateBlocks export files.

## 0.1.0
- Figma variables -> theme.json: palette, font sizes, font families, spacing, radius, layout, font weight, line height.
- Non-destructive merge (byte-for-byte outside managed paths), three-way sync state, conflict detection, `--prune`, `--force`.
- Fluid values from Mobile/Desktop modes (`fluid` for font sizes, `clamp()` for everything else).
- Reading Figma through the Figma MCP (`use_figma`, read-only script) with a Chrome fallback; no plugin, no Enterprise plan.
- Optional GenerateBlocks Pro design tokens (timestamped import JSON + CSS Mode snippet), output folder configurable.
  Colors are excluded: GenerateBlocks already reads the theme colors.
