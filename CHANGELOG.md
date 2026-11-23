# Changelog

## 0.1.0
- Figma variables -> theme.json: palette, font sizes, font families, spacing, radius, layout, font weight, line height.
- Non-destructive merge (byte-for-byte outside managed paths), three-way sync state, conflict detection, `--prune`, `--force`.
- Fluid values from Mobile/Desktop modes (`fluid` for font sizes, `clamp()` for everything else).
- Reading Figma through the Figma MCP (`use_figma`, read-only script) with a Chrome fallback; no plugin, no Enterprise plan.
- Optional GenerateBlocks Pro design tokens (timestamped import JSON + CSS Mode snippet), output folder configurable.
