// READ-ONLY script for the Figma MCP `use_figma` tool (Plugin API context).
// Paste it as the `code` argument unchanged. It returns the file's local variables in the
// tokens.json shape that sync.mjs expects. It must never create, edit or delete anything.
//
// Notes: top-level await/return are allowed in use_figma. Output is guarded at ~60 KB; if the
// file is large it returns only collection ids and counts, then call again per collection by
// setting ONLY_COLLECTION_ID below.
const ONLY_COLLECTION_ID = null; // e.g. 'VariableCollectionId:1:2' for a per-collection read

const hex = (c) => '#' + [c.r, c.g, c.b].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('') + (c.a !== undefined && c.a < 1 ? Math.round(c.a * 255).toString(16).padStart(2, '0') : '');
const all = await figma.variables.getLocalVariableCollectionsAsync();
const collNameById = Object.fromEntries(all.map((c) => [c.id, c.name]));
const collections = ONLY_COLLECTION_ID ? all.filter((c) => c.id === ONLY_COLLECTION_ID) : all;
const out = [];
for (const c of collections) {
	const modeName = Object.fromEntries(c.modes.map((m) => [m.modeId, m.name]));
	const variables = [];
	for (const id of c.variableIds) {
		const v = await figma.variables.getVariableByIdAsync(id);
		const values = {};
		for (const [modeId, val] of Object.entries(v.valuesByMode)) {
			if (val && typeof val === 'object' && val.type === 'VARIABLE_ALIAS') {
				const t = await figma.variables.getVariableByIdAsync(val.id);
				values[modeName[modeId]] = { alias: `${collNameById[t.variableCollectionId] ?? '?'}/${t.name}` };
			} else if (v.resolvedType === 'COLOR') values[modeName[modeId]] = hex(val);
			else values[modeName[modeId]] = val;
		}
		variables.push({ name: v.name, type: v.resolvedType.toLowerCase(), values });
	}
	out.push({ name: c.name, modes: c.modes.map((m) => m.name), variables });
}
if (JSON.stringify({ collections: out }).length > 60000 && !ONLY_COLLECTION_ID) {
	return { tooLarge: true, collections: all.map((c) => ({ name: c.name, id: c.id, count: c.variableIds.length })) };
}
return { source: { via: 'figma-mcp-use_figma' }, collections: out };
