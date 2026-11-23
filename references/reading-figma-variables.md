# Reading Figma variables into tokens.json

Goal: produce a `tokens.json` that lists every collection and variable of the Figma file. Reading
only: never modify the Figma file.

## tokens.json format

```json
{
  "source": { "via": "figma-mcp-use_figma", "fileKey": "<key from the URL>" },
  "collections": [
    {
      "name": "Colors",
      "modes": ["Default"],
      "variables": [
        { "name": "background/canvas", "type": "color", "values": { "Default": { "alias": "Color primitives/neutral/50" } } },
        { "name": "font-size/12", "type": "float", "values": { "Default": 12 } }
      ]
    }
  ]
}
```

- `name` is the full variable name including groups (`group/sub/name`).
- `type`: `color`, `float` (numbers), `string`.
- `values`: one entry per mode. A color is a hex string or `{r,g,b,a}` with 0-1 floats. An alias is
  `{ "alias": "Collection/group/name" }`; a bare `group/name` also works if it is unambiguous.
- A complete real example: `examples/basic-design-system.tokens.json`.

## Method A (preferred): Figma MCP `use_figma` with the read-only script

Verified on a Professional plan (Full seat): it returned all variables of a test file with
exact collections, modes and aliases, identical to the Variables panel.

1. Extract the `fileKey` from the URL (`figma.com/design/<fileKey>/...`; for a branch URL use the
   branch key).
2. Call `create_session` with the `fileKey` and a short description. Pass the returned `sessionId` to
   every following Figma call.
3. `use_figma`'s own description requires loading Figma's `figma-use` guidance first. Use the `/figma-use`
   skill if the Figma plugin is installed, otherwise read the MCP resource
   `skill://figma/figma-use/SKILL.md` (ReadMcpResourceTool, server `figma`). Pass
   `skillNames: "resource:figma-use"` (or `"figma-use"` if loaded as a skill). Read-only calls need no
   companion skills.
4. Call `use_figma` with `code` = the contents of `scripts/read-figma-variables.js`, unchanged. Do not
   add anything that creates, edits or deletes nodes or variables; this tool can write to the file.
5. The result is the `tokens.json` content. Save it to a file in the scratchpad (not in the theme).
6. If the result says `tooLarge`, call again once per collection by setting `ONLY_COLLECTION_ID` and
   merge the `collections` arrays.

Requirements: a Dev or Full seat and edit access to the file (the script runs through the Plugin API).
If the call is refused or rate limited, run `whoami` to see the seat and plan, and report it.

### Do not use `get_variable_defs` as the source

It only works on a selected layer (it errors for a page id), returns only variables **used by that
layer's subtree**, resolves aliases, and drops collection and mode information. On the test file it
returned 42 of 44 variables (missing `font-size/64` and `spacing/0`), plus a stray `var(--text-3xl)`.
Without collection names the sync cannot tell primitive colors from semantic ones. Use it only to
double check a single frame.

## Method B (fallback): Claude in Chrome reading the Variables panel

Use when the Figma MCP is not connected. Read `anthropic-skills:chrome-browser` first and follow its
tab rules (new tab, close it at the end).

1. Open the file URL in a new tab and wait a few seconds. If a sign-in page appears, ask the user to
   sign in in Chrome, then continue.
2. Click empty canvas (selection only), press `cmd+/`, type `variables`, press Enter ("Toggle
   variables"). A floating Variables panel opens; click its expand icon (top right of the panel) for
   the full view.
3. The left list shows the collections with their variable counts. For each collection: click its name,
   then `get_page_text`. The text has group headers, variable names, numeric and string values and
   aliases as `group/name`. With several modes the values are grouped by column.
4. Color values are input fields, not page text. Read them in row order with `javascript_tool`:
   `[...document.querySelectorAll('input')].map(i=>i.value).filter(v=>/^[0-9A-Fa-f]{6,8}$/.test(v)).join(',')`
5. Cross-check each collection's variable count with the left list; scroll and re-read if rows are
   missing (the table can be virtualized).
6. Write `tokens.json` and close the tab you opened. You only selected a frame and opened a panel; the
   file stays unchanged.
