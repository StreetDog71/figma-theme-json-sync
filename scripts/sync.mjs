#!/usr/bin/env node
// figma-theme-json-sync
// Maps Figma variables (read by Claude into a small tokens.json, see
// references/reading-figma-variables.md) onto WordPress theme.json presets and merges
// them using surgical text edits: only the managed token collections are touched,
// every other byte of the file (key order, indentation, odd spacing) stays.
//
// Usage: node sync.mjs --tokens tokens.json --theme path/to/theme.json [options]
import fs from 'node:fs';
import path from 'node:path';

const HELP = `Usage: node sync.mjs --theme <theme.json> [--tokens <tokens.json>] [options]

  --theme   <file>  Target WordPress theme.json (required)
  --tokens  <file>  Figma variables as read by Claude (required unless --inspect)
  --inspect         Only report which token collections exist in theme.json (and in tokens)
  --apply           Write changes. Without it, nothing is written (dry run)
  --prune           Also remove managed entries that exist in theme.json but not in Figma
  --force           Figma wins even where theme.json was edited since the last sync
  --gb-out  <dir>   Optional: also generate GenerateBlocks Pro design tokens (import JSON + CSS Mode
                    snippet) into <dir>, with a timestamp in the file names (never overwritten).
                    Files are written only together with --apply. Config generateblocks.outDir
                    does the same (relative to the theme folder); --gb-out overrides it
  --gb-mode <mode>  "values" (default, literal values, previews work) or "alias" (tokens point at the
                    theme.json presets, e.g. var(--wp--preset--color--accent))
  --config  <file>  Config file (default: <theme dir>/figma-sync.config.json if present)
  --state   <file>  State file  (default: <theme dir>/.figma-sync-state.json)
`;

const DEFAULT_COLLECTIONS = [
	{ name: 'palette', preset: 'color', path: ['settings', 'color', 'palette'], type: 'array', key: 'slug', fields: ['name', 'color'] },
	{ name: 'fontSizes', preset: 'font-size', path: ['settings', 'typography', 'fontSizes'], type: 'array', key: 'slug', fields: ['name', 'size', 'fluid'] },
	{ name: 'fontFamilies', preset: 'font-family', path: ['settings', 'typography', 'fontFamilies'], type: 'array', key: 'slug', fields: ['name', 'fontFamily'] },
	{ name: 'spacingSizes', preset: 'spacing', path: ['settings', 'spacing', 'spacingSizes'], type: 'array', key: 'slug', fields: ['name', 'size'] },
	// Native radius presets (as used by Ollie). Needs a WordPress version that supports border.radiusSizes.
	{ name: 'radiusSizes', path: ['settings', 'border', 'radiusSizes'], type: 'array', key: 'slug', fields: ['name', 'size'] },
	{ name: 'fontWeight', path: ['settings', 'custom', 'fontWeight'], type: 'map' },
	{ name: 'lineHeight', path: ['settings', 'custom', 'lineHeight'], type: 'map' },
	{ name: 'layout', path: ['settings', 'layout'], type: 'map' },
];

// Presets WordPress itself provides unless the theme switches the defaults off.
const CORE = {
	color: { flag: ['settings', 'color', 'defaultPalette'], slugs: ['black', 'cyan-bluish-gray', 'white', 'pale-pink', 'vivid-red', 'luminous-vivid-orange', 'luminous-vivid-amber', 'light-green-cyan', 'vivid-green-cyan', 'pale-cyan-blue', 'vivid-cyan-blue', 'vivid-purple'] },
	'font-size': { flag: ['settings', 'typography', 'defaultFontSizes'], slugs: ['small', 'medium', 'large', 'x-large', 'xx-large'] },
	spacing: { flag: ['settings', 'spacing', 'defaultSpacingSizes'], slugs: ['20', '30', '40', '50', '60', '70', '80'] },
};

/* ------------------------------------------------------------------ args */
function die(msg) { console.error(`Error: ${msg}`); process.exit(1); }

const opt = {};
{
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (['--apply', '--prune', '--force', '--inspect'].includes(a)) opt[a.slice(2)] = true;
		else if (['--tokens', '--theme', '--config', '--state', '--gb-out', '--gb-mode'].includes(a)) opt[a.slice(2)] = argv[++i] ?? die(`${a} needs a value`);
		else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
		else die(`Unknown argument: ${a}\n\n${HELP}`);
	}
}

/* ------------------------------------------------- JSON AST with offsets */
function parseAst(text) {
	let i = 0;
	const fail = (m) => { throw new Error(`${m} at offset ${i}`); };
	const ws = () => { while (i < text.length && /\s/.test(text[i])) i++; };
	const expect = (c) => { if (text[i] !== c) fail(`Expected "${c}"`); i++; };
	const str = () => {
		const s = i;
		if (text[i] !== '"') fail('Expected string');
		i++;
		while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
		i++;
		return JSON.parse(text.slice(s, i));
	};
	const lit = /-?\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null/y;
	function value() {
		ws();
		const start = i;
		const c = text[i];
		if (c === '{') {
			i++;
			const members = [];
			ws();
			if (text[i] === '}') { i++; return { type: 'object', start, end: i, members }; }
			for (;;) {
				ws();
				const keyStart = i;
				const key = str();
				ws(); expect(':');
				members.push({ key, keyStart, value: value() });
				ws();
				if (text[i] === ',') { i++; continue; }
				expect('}');
				return { type: 'object', start, end: i, members };
			}
		}
		if (c === '[') {
			i++;
			const elements = [];
			ws();
			if (text[i] === ']') { i++; return { type: 'array', start, end: i, elements }; }
			for (;;) {
				elements.push(value());
				ws();
				if (text[i] === ',') { i++; continue; }
				expect(']');
				return { type: 'array', start, end: i, elements };
			}
		}
		if (c === '"') { const v = str(); return { type: 'string', start, end: i, value: v }; }
		lit.lastIndex = i;
		const m = lit.exec(text);
		if (!m) fail('Unexpected token');
		i += m[0].length;
		return { type: 'literal', start, end: i };
	}
	const root = value();
	ws();
	if (i < text.length) fail('Trailing content');
	return root;
}

// Find the node at `p`. Returns {found, entry, parent, index} or {found:false, container, depth}.
function locate(root, p) {
	let node = root;
	for (let k = 0; k < p.length; k++) {
		const seg = p[k];
		let entry, idx;
		if (node.type === 'object') {
			idx = node.members.findIndex((m) => m.key === seg);
			entry = node.members[idx];
		} else if (node.type === 'array') {
			idx = seg;
			const el = node.elements[seg];
			entry = el ? { keyStart: el.start, value: el } : undefined;
		} else throw new Error(`Cannot descend into a ${node.type} at "${p.slice(0, k).join('.')}"`);
		if (!entry) return { found: false, container: node, depth: k };
		if (k === p.length - 1) return { found: true, entry, parent: node, index: idx };
		node = entry.value;
	}
	throw new Error('Empty path');
}

/* ----------------------------------------- Document with surgical edits */
class Doc {
	constructor(text) {
		this.text = text;
		this.eol = text.includes('\r\n') ? '\r\n' : '\n';
		const m = /^([ \t]+)"/m.exec(text);
		this.unit = m ? (m[1].includes('\t') ? '\t' : m[1]) : '  ';
	}
	value() { return JSON.parse(this.text); }
	indentAt(pos) {
		const ls = this.text.lastIndexOf('\n', pos - 1) + 1;
		return /^[ \t]*/.exec(this.text.slice(ls))[0];
	}
	ser(v, base) { return JSON.stringify(v, null, this.unit).replace(/\n/g, this.eol + base); }
	splice(a, b, s) { this.text = this.text.slice(0, a) + s + this.text.slice(b); }

	set(p, v) {
		const loc = locate(parseAst(this.text), p);
		if (loc.found) {
			const n = loc.entry.value;
			this.splice(n.start, n.end, this.ser(v, this.indentAt(loc.entry.keyStart)));
			return;
		}
		if (loc.container.type !== 'object') throw new Error(`Cannot create ${p.join('.')}: parent is not an object`);
		const rest = p.slice(loc.depth);
		let nested = v;
		for (let j = rest.length - 1; j >= 1; j--) nested = { [rest[j]]: nested };
		const c = loc.container;
		const kv = (ind) => `${JSON.stringify(rest[0])}: ${this.ser(nested, ind)}`;
		if (c.members.length) {
			const last = c.members.at(-1);
			const ind = this.indentAt(last.keyStart);
			this.splice(last.value.end, last.value.end, `,${this.eol}${ind}${kv(ind)}`);
		} else {
			const base = this.indentAt(c.start);
			const ind = base + this.unit;
			this.splice(c.start, c.end, `{${this.eol}${ind}${kv(ind)}${this.eol}${base}}`);
		}
	}
	append(p, v) {
		const loc = locate(parseAst(this.text), p);
		if (!loc.found || loc.entry.value.type !== 'array') throw new Error(`${p.join('.')} is not an array`);
		const a = loc.entry.value;
		if (a.elements.length) {
			const last = a.elements.at(-1);
			const ind = this.indentAt(last.start);
			this.splice(last.end, last.end, `,${this.eol}${ind}${this.ser(v, ind)}`);
		} else {
			const base = this.indentAt(a.start);
			const ind = base + this.unit;
			this.splice(a.start, a.end, `[${this.eol}${ind}${this.ser(v, ind)}${this.eol}${base}]`);
		}
	}
	remove(p) {
		const loc = locate(parseAst(this.text), p);
		if (!loc.found) return;
		const par = loc.parent;
		const isObj = par.type === 'object';
		const items = isObj ? par.members : par.elements;
		const s = (it) => (isObj ? it.keyStart : it.start);
		const e = (it) => (isObj ? it.value.end : it.end);
		const i = loc.index;
		if (items.length === 1) this.splice(par.start, par.end, isObj ? '{}' : '[]');
		else if (i < items.length - 1) this.splice(s(items[i]), s(items[i + 1]), '');
		else this.splice(e(items[i - 1]), e(items[i]), '');
	}
}

/* --------------------------------------------------------------- helpers */
const getPath = (o, p) => { for (const s of p) { if (o == null) return undefined; o = o[s]; } return o; };
function delPath(o, p) {
	const chain = [o];
	for (let i = 0; i < p.length - 1; i++) {
		o = o?.[p[i]];
		if (o == null || typeof o !== 'object') return;
		chain.push(o);
	}
	delete chain.at(-1)[p.at(-1)];
	for (let i = chain.length - 1; i > 0; i--) {
		if (Object.keys(chain[i]).length === 0) delete chain[i - 1][p[i - 1]]; else break;
	}
}
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
const HEX = /^#[0-9a-f]{3,8}$/i;
const same = (a, b) => (typeof a === 'string' && typeof b === 'string'
	? a === b || (HEX.test(a) && HEX.test(b) && a.toLowerCase() === b.toLowerCase())
	: canon(a) === canon(b));
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const show = (v) => { if (v === undefined) return '(none)'; const s = typeof v === 'string' ? v : canon(v); return s.length > 48 ? s.slice(0, 45) + '...' : s; };
const pick = (e, fields) => Object.fromEntries(fields.filter((f) => f in e).map((f) => [f, e[f]]));
const readText = (p) => fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
function readJson(p, label) {
	try { return JSON.parse(readText(p)); } catch (e) { die(`${label} (${p}) is not valid JSON: ${e.message}`); }
}

function buildCollections(userCfg) {
	const byName = new Map(DEFAULT_COLLECTIONS.map((c) => [c.name, { ...c }]));
	for (const [name, v] of Object.entries(userCfg.collections ?? {})) {
		if (v === false) byName.delete(name);
		else byName.set(name, { ...(byName.get(name) ?? { type: 'array', key: 'slug' }), ...v, name });
	}
	return [...byName.values()];
}

/* ------------------------------------------------------------------ plan */
// Pure: compares source vs target (+ last-synced state) and returns ops, a log and the next state.
function plan(source, target, collections, state, o) {
	const ops = [], log = [], next = {};
	for (const c of collections) {
		const src = getPath(source, c.path);
		const tgt = getPath(target, c.path);
		const prev = state.collections?.[c.name];
		if (src === undefined) { log.push({ sym: '.', coll: c.name, msg: 'not present in source, left alone' }); continue; }
		next[c.name] = c.type === 'map' ? planMap(c, src, tgt, prev, ops, log, o) : planArray(c, src, tgt, prev, ops, log, o);
	}
	return { ops, log, next };
}

function planArray(c, srcArr, tgtVal, prev, ops, log, o) {
	const K = c.key;
	if (!Array.isArray(srcArr)) die(`Source ${c.path.join('.')} is not an array`);
	const project = (e) => Object.fromEntries(Object.entries(e).filter(([k]) => k === K || c.fields.includes(k)));
	const srcMap = new Map(srcArr.filter((e) => e && e[K] !== undefined).map((e) => [e[K], e]));
	const next = {};
	if (!Array.isArray(tgtVal)) {
		ops.push({ t: 'setCollection', path: c.path, value: [...srcMap.values()].map(project) });
		log.push({ sym: '+', coll: c.name, msg: `collection created with ${srcMap.size} entries` });
		for (const [k, e] of srcMap) next[k] = pick(e, c.fields);
		return next;
	}
	const tgtMap = new Map(tgtVal.filter((e) => e && e[K] !== undefined).map((e) => [e[K], e]));
	for (const [k, e] of srcMap) {
		const t = tgtMap.get(k);
		const nk = pick(e, c.fields);
		next[k] = nk;
		if (!t) {
			ops.push({ t: 'append', path: c.path, value: project(e) });
			log.push({ sym: '+', coll: c.name, msg: `${k}` });
			continue;
		}
		for (const f of c.fields) {
			if (!(f in e) || same(t[f], e[f])) continue;
			const base = prev?.[k];
			if (base && f in base && !same(t[f], base[f]) && !o.force) {
				nk[f] = base[f]; // keep the old baseline so the divergence stays visible
				if (same(e[f], base[f])) log.push({ sym: '=', coll: c.name, msg: `${k}.${f} edited in theme.json (${show(t[f])}), Figma unchanged: kept` });
				else log.push({ sym: '!', coll: c.name, msg: `${k}.${f} CONFLICT theme.json=${show(t[f])} Figma=${show(e[f])}: skipped (use --force)` });
				continue;
			}
			ops.push({ t: 'setField', path: c.path, keyName: K, key: k, field: f, value: e[f] });
			log.push({ sym: '~', coll: c.name, msg: `${k}.${f}  ${show(t[f])} -> ${show(e[f])}` });
		}
	}
	const extras = [];
	for (const k of tgtMap.keys()) {
		if (srcMap.has(k)) continue;
		if (prev && k in prev) {
			ops.push({ t: 'removeEntry', path: c.path, keyName: K, key: k });
			log.push({ sym: '-', coll: c.name, msg: `${k} (removed in Figma)` });
		} else if (o.prune) {
			ops.push({ t: 'removeEntry', path: c.path, keyName: K, key: k });
			log.push({ sym: '-', coll: c.name, msg: `${k} (pruned: not in Figma)` });
		} else extras.push(k);
	}
	if (extras.length) log.push({ sym: '?', coll: c.name, msg: `only in theme.json, kept (--prune removes): ${extras.join(', ')}` });
	return next;
}

function planMap(c, srcObj, tgtVal, prev, ops, log, o) {
	if (!isObj(srcObj)) die(`Source ${c.path.join('.')} is not an object`);
	const next = { ...srcObj };
	if (!isObj(tgtVal)) {
		ops.push({ t: 'setCollection', path: c.path, value: srcObj });
		log.push({ sym: '+', coll: c.name, msg: `collection created with ${Object.keys(srcObj).length} entries` });
		return next;
	}
	for (const [k, v] of Object.entries(srcObj)) {
		if (!(k in tgtVal)) { ops.push({ t: 'setMapKey', path: c.path, key: k, value: v }); log.push({ sym: '+', coll: c.name, msg: k }); continue; }
		if (same(tgtVal[k], v)) continue;
		if (prev && k in prev && !same(tgtVal[k], prev[k]) && !o.force) {
			next[k] = prev[k];
			if (same(v, prev[k])) log.push({ sym: '=', coll: c.name, msg: `${k} edited in theme.json (${show(tgtVal[k])}), Figma unchanged: kept` });
			else log.push({ sym: '!', coll: c.name, msg: `${k} CONFLICT theme.json=${show(tgtVal[k])} Figma=${show(v)}: skipped (use --force)` });
			continue;
		}
		ops.push({ t: 'setMapKey', path: c.path, key: k, value: v });
		log.push({ sym: '~', coll: c.name, msg: `${k}  ${show(tgtVal[k])} -> ${show(v)}` });
	}
	const extras = [];
	for (const k of Object.keys(tgtVal)) {
		if (k in srcObj) continue;
		if (prev && k in prev) { ops.push({ t: 'removeMapKey', path: c.path, key: k }); log.push({ sym: '-', coll: c.name, msg: `${k} (removed in Figma)` }); }
		else if (o.prune) { ops.push({ t: 'removeMapKey', path: c.path, key: k }); log.push({ sym: '-', coll: c.name, msg: `${k} (pruned: not in Figma)` }); }
		else extras.push(k);
	}
	if (extras.length) log.push({ sym: '?', coll: c.name, msg: `only in theme.json, kept (--prune removes): ${extras.join(', ')}` });
	return next;
}

function applyOp(doc, op) {
	const cur = getPath(doc.value(), op.path);
	const idx = () => cur.findIndex((e) => e && e[op.keyName] === op.key);
	switch (op.t) {
		case 'setCollection': doc.set(op.path, op.value); break;
		case 'append': doc.append(op.path, op.value); break;
		case 'setField': doc.set([...op.path, idx(), op.field], op.value); break;
		case 'removeEntry': doc.remove([...op.path, idx()]); break;
		case 'setMapKey': doc.set([...op.path, op.key], op.value); break;
		case 'removeMapKey': doc.remove([...op.path, op.key]); break;
	}
}

/* ---------------------------------------------- dangling reference scan */
function scanRefs(dir, themePath, mergedText, merged, collections) {
	const managed = {}; // preset -> Set(slug)
	for (const c of collections) {
		if (!c.preset || c.type !== 'array') continue;
		const arr = getPath(merged, c.path);
		if (!Array.isArray(arr)) continue;
		managed[c.preset] = new Set(arr.map((e) => e?.[c.key]));
		const core = CORE[c.preset];
		if (core && getPath(merged, core.flag) !== false) core.slugs.forEach((s) => managed[c.preset].add(s));
	}
	const attr = { backgroundColor: 'color', textColor: 'color', borderColor: 'color', overlayColor: 'color', iconColor: 'color', fontSize: 'font-size', fontFamily: 'font-family' };
	const missing = new Map();
	const note = (preset, slug, file) => {
		if (!managed[preset] || managed[preset].has(slug)) return;
		const k = `${preset}\u0000${slug}`;
		if (!missing.has(k)) missing.set(k, new Set());
		missing.get(k).add(path.relative(dir, file));
	};
	const skip = new Set(['node_modules', 'vendor', '.git', 'build', 'dist']);
	(function walk(d) {
		for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
			const fp = path.join(d, ent.name);
			if (ent.isDirectory()) { if (!skip.has(ent.name)) walk(fp); continue; }
			const ext = path.extname(ent.name);
			if (!['.json', '.html', '.php', '.css'].includes(ext) || ent.name.startsWith('.')) continue;
			if (fs.statSync(fp).size > 2e6) continue;
			const text = fp === themePath ? mergedText : fs.readFileSync(fp, 'utf8');
			for (const m of text.matchAll(/var:preset\|(color|spacing|font-size|font-family)\|([\w-]+)/g)) note(m[1], m[2], fp);
			for (const m of text.matchAll(/--wp--preset--(color|spacing|font-size|font-family)--([\w-]+)/g)) note(m[1], m[2], fp);
			if (ext === '.html' || ext === '.php') {
				for (const m of text.matchAll(/"(backgroundColor|textColor|borderColor|overlayColor|iconColor|fontSize|fontFamily)"\s*:\s*"([\w-]+)"/g)) note(attr[m[1]], m[2], fp);
			}
		}
	})(dir);
	return [...missing].map(([k, files]) => { const [preset, slug] = k.split('\u0000'); return { preset, slug, files: [...files] }; });
}

/* --------------------------------------------- Figma tokens -> theme.json */
// Each rule routes Figma variables to one managed collection (`to`) by variable type,
// top-level group name and collection name. Override per rule in figma-sync.config.json
// ("rules": { "fontSizes": { "unit": "px" }, "palette": { "collections": ["Colors", "Color primitives"] } }).
const RULES = [
	{ to: 'palette', type: 'color', collectionNot: /primitive|^core$|^ref(erence)?s?$/i },
	{ to: 'fontSizes', type: 'float', group: /^font[-_ ]?sizes?$/i, unit: 'rem' },
	{ to: 'spacingSizes', type: 'float', group: /^(spacing|space|gap)s?$/i, unit: 'px' },
	{ to: 'radiusSizes', type: 'float', group: /^(radius|radii|rounded|border[-_ ]?radius)$/i, unit: 'px' },
	{ to: 'fontFamilies', type: 'string', group: /^font[-_ ]?famil(y|ies)$/i, fallback: 'sans-serif' },
	{ to: 'fontWeight', type: 'float', group: /^font[-_ ]?weights?$/i },
	{ to: 'lineHeight', type: 'float', group: /^line[-_ ]?heights?$/i },
	{ to: 'layout', type: 'float', group: /^layout$/i, unit: 'px', keys: 'raw', fluid: false },
];

function buildRules(userCfg) {
	const re = (v) => (typeof v === 'string' ? new RegExp(v, 'i') : v);
	return RULES.map((r) => {
		const u = userCfg.rules?.[r.to];
		if (u === false) return null;
		const m = { ...r, ...(u ?? {}) };
		if (m.group) m.group = re(m.group);
		if (m.collectionNot) m.collectionNot = re(m.collectionNot);
		return m;
	}).filter(Boolean);
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const titleCase = (s) => s.split(/[-_ ]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const num = (n) => +Number(n).toFixed(4);
function toSize(n, unit, base) {
	if (typeof n !== 'number') die(`Expected a number, got ${JSON.stringify(n)}`);
	return unit === 'rem' ? `${num(n / base)}rem` : `${num(n)}${unit ?? 'px'}`;
}
function toHex(v) {
	if (typeof v === 'string') {
		let s = v.trim().replace(/^#/, '');
		if (/^[0-9a-f]{3}$/i.test(s)) s = [...s].map((c) => c + c).join('');
		if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s)) die(`Unsupported color value "${v}"`);
		s = s.toLowerCase();
		return '#' + (s.length === 8 && s.endsWith('ff') ? s.slice(0, 6) : s);
	}
	if (v && typeof v === 'object' && 'r' in v) {
		const h = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
		const a = v.a ?? 1;
		return '#' + h(v.r) + h(v.g) + h(v.b) + (a < 1 ? h(a) : '');
	}
	return die(`Unsupported color value ${JSON.stringify(v)}`);
}
/* Fluid values. A collection with a Mobile and a Desktop mode makes every numeric size variable
   fluid when its two values differ. Font sizes use theme.json's native `fluid: {min, max}`;
   everything else gets a clamp() that interpolates linearly between the two viewport widths. */
const num3 = (n) => +Number(n).toFixed(3);
const fluidVp = (userCfg) => ({ min: userCfg.fluid?.minViewport ?? 320, max: userCfg.fluid?.maxViewport ?? 1200 });
function parseSize(s, base) {
	const m = /^(-?[\d.]+)(px|rem)$/.exec(String(s));
	return m ? (m[2] === 'rem' ? +m[1] * base : +m[1]) : null;
}
// `mob` = px value at the min viewport, `desk` = px value at the max viewport.
function clampSize(mob, desk, unit, base, vp) {
	const slope = ((desk - mob) / (vp.max - vp.min)) * 100; // in vw
	const interceptPx = mob - (slope * vp.min) / 100;
	const f = (px) => (unit === 'rem' ? `${num3(px / base)}rem` : `${num3(px)}px`);
	return `clamp(${f(Math.min(mob, desk))}, calc(${f(interceptPx)} ${slope < 0 ? '-' : '+'} ${num3(Math.abs(slope))}vw), ${f(Math.max(mob, desk))})`;
}
function toFamily(v, r) {
	if (typeof v !== 'string') die(`Expected a font family string, got ${JSON.stringify(v)}`);
	if (v.includes(',')) return v;
	return `${/\s/.test(v) ? `"${v}"` : v}, ${r.fallback ?? 'sans-serif'}`;
}

// tokens.json -> an object shaped like theme.json (only managed paths), plus a readable report.
function tokensToSource(tokens, rules, collections, userCfg) {
	const cols = tokens.collections;
	if (!Array.isArray(cols)) die('tokens file needs a "collections" array');
	const base = userCfg.rootFontSize ?? 16;
	const vp = fluidVp(userCfg);
	// Mode names are matched by /mobile/ and /desktop/; override with fluid.minMode / fluid.maxMode, disable with "fluid": false.
	const fluidModes = (c) => {
		if (userCfg.fluid === false || userCfg.mode) return null;
		const min = userCfg.fluid?.minMode ?? c.modes?.find((m) => /mobile/i.test(m));
		const max = userCfg.fluid?.maxMode ?? c.modes?.find((m) => /desktop/i.test(m));
		return min && max && min !== max && c.modes?.includes(min) && c.modes?.includes(max) ? { min, max } : null;
	};
	const modeDiffers = [];
	const norm = (t) => ({ float: 'float', number: 'float', color: 'color', string: 'string', boolean: 'boolean' })[String(t).toLowerCase()] ?? String(t).toLowerCase();

	const index = new Map(), byName = new Map();
	for (const c of cols) for (const v of c.variables ?? []) {
		const e = { coll: c, v };
		index.set(`${c.name}/${v.name}`, e);
		if (!byName.has(v.name)) byName.set(v.name, []);
		byName.get(v.name).push(e);
	}
	const resolve = (e, wanted, seen = new Set()) => {
		const vals = e.v.values ?? {};
		let val = vals[e.coll.modes?.includes(wanted) ? wanted : e.coll.modes?.[0]];
		if (val === undefined) val = Object.values(vals)[0];
		if (val && typeof val === 'object' && 'alias' in val) {
			let t = index.get(val.alias);
			if (!t) {
				const cand = (byName.get(val.alias) ?? []).filter((x) => x !== e);
				if (cand.length !== 1) die(`${e.coll.name}/${e.v.name}: alias "${val.alias}" ${cand.length ? 'is ambiguous, write it as "Collection/name"' : 'was not found'}`);
				t = cand[0];
			}
			if (seen.has(t)) die(`alias loop at ${val.alias}`);
			seen.add(e);
			return resolve(t, wanted, seen);
		}
		return val;
	};

	const source = {}, stats = new Map(), excluded = new Map(), unmapped = [];
	for (const c of cols) for (const v of c.variables ?? []) {
		const type = norm(v.type), seg = v.name.split('/');
		let hit = null, blockedBy = null;
		for (const r of rules) {
			if (r.type !== type) continue;
			if (r.group && !r.group.test(seg.length > 1 ? seg[0] : '')) continue;
			if (r.collections ? !r.collections.includes(c.name) : r.collectionNot?.test(c.name)) { blockedBy ??= r; continue; }
			hit = r;
			break;
		}
		if (!hit) {
			if (blockedBy) excluded.set(c.name, (excluded.get(c.name) ?? 0) + 1);
			else unmapped.push(`${c.name}/${v.name} (${type})`);
			continue;
		}
		const col = collections.find((x) => x.name === hit.to);
		if (!col) continue;
		const parts = hit.group ? seg.slice(1) : seg;
		const key = hit.keys === 'raw' ? parts.join('-') : slugify(parts.join('-'));
		const fm = fluidModes(c);
		const raw = resolve({ coll: c, v }, userCfg.mode ?? fm?.max);
		let value, fluidInfo, extra;
		if (hit.to === 'palette') value = toHex(raw);
		else if (hit.to === 'fontFamilies') value = toFamily(raw, hit);
		else if (hit.unit) {
			value = toSize(raw, hit.unit, base);
			if (fm && hit.fluid !== false) {
				const mob = resolve({ coll: c, v }, fm.min);
				if (typeof mob === 'number' && mob !== raw) {
					fluidInfo = { mob };
					if (hit.to !== 'fontSizes') value = clampSize(mob, raw, hit.unit, base, vp);
				}
				// Font sizes: native theme.json fluid. Equal values explicitly opt out of fluid typography.
				if (hit.to === 'fontSizes') extra = fluidInfo ? { min: toSize(mob, hit.unit, base), max: value } : false;
			}
		} else {
			value = raw;
			if (fm && typeof raw === 'number' && resolve({ coll: c, v }, fm.min) !== raw) modeDiffers.push(`${c.name}/${v.name}`);
		}

		const from = `${c.name}${hit.group ? '/' + seg[0] : ''}`;
		const st = stats.get(hit.to) ?? { n: 0, from: new Set(), unit: hit.unit, fluid: 0 };
		st.n++; if (fluidInfo) st.fluid++; st.from.add(from); stats.set(hit.to, st);

		let target = getPath(source, col.path);
		if (col.type === 'map') {
			if (!target) { target = {}; setIn(source, col.path, target); }
			target[key] = value;
		} else {
			if (!target) { target = []; setIn(source, col.path, target); }
			if (target.some((e) => e[col.key] === key)) { console.error(`Warning: duplicate slug "${key}" in ${hit.to}, skipped ${c.name}/${v.name}`); continue; }
			const name = /^\d+$/.test(key) ? `${titleCase(seg[0])} ${key}` : titleCase(key);
			const entry = { name, [col.key]: key, [col.fields.find((f) => f !== 'name')]: value };
			if (extra !== undefined && col.fields.includes('fluid')) entry.fluid = extra;
			target.push(entry);
		}
	}

	const fluidSeen = cols.some((c) => fluidModes(c));
	const lines = [`Figma -> theme.json mapping (${userCfg.mode ? `mode "${userCfg.mode}"` : fluidSeen ? `fluid: Mobile -> Desktop, viewport ${vp.min}-${vp.max}px` : 'first mode of each collection'})`];
	for (const [to, st] of stats) lines.push(`  ${to.padEnd(13)} ${String(st.n).padStart(3)}  from ${[...st.from].join(', ')}${st.unit ? ` (${st.unit})` : ''}${to === 'palette' ? ' (aliases resolved to hex)' : ''}${st.fluid ? `, ${st.fluid} fluid` : ''}`);
	if (modeDiffers.length) lines.push(`  note: ${modeDiffers.length} unitless variable(s) differ between modes and cannot be fluid, Desktop value used: ${modeDiffers.join(', ')}`);
	for (const [name, n] of excluded) lines.push(`  excluded: ${n} variable(s) from "${name}" (primitive collection; the palette gets semantic roles only. Include with rules.palette.collections)`);
	lines.push(unmapped.length ? `  not mapped (no rule): ${unmapped.join(', ')}` : '  not mapped: none');
	return { source, report: lines.join('\n') + '\n' };
}
function setIn(o, p, v) { p.forEach((k, i) => { if (i === p.length - 1) o[k] = v; else o = (o[k] ??= {}); }); }

/* ------------------------------------- GenerateBlocks Pro design tokens */
// Optional output. Format taken from a real GenerateBlocks Pro export (kind
// "generateblocks/design-system"): a :root global style holding the CSS variables plus a
// designTokens list with type/label/scope/category/display. `scope` lists camel-case CSS
// properties. Color and spacing scopes and the controls were seen in a real export; the
// fontSize and radius scopes follow the same convention but have not been seen in one.
const GB_COLOR_SCOPE = ['color', 'backgroundColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor'];
const GB_SPACING_SCOPE = ['marginTop', 'marginRight', 'marginBottom', 'marginLeft', 'columnGap', 'rowGap', 'paddingLeft', 'paddingBottom', 'paddingRight', 'paddingTop'];
const GB_RADIUS_SCOPE = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'];
const GB_KINDS = [
	{ coll: 'palette', kind: 'color', type: 'color', value: 'color', preset: 'color', category: 'Colors', scope: GB_COLOR_SCOPE, control: 'colorPicker' },
	{ coll: 'fontSizes', kind: 'font-size', type: 'unit', value: 'size', preset: 'font-size', category: 'Typography', scope: ['fontSize'], control: 'unitControl' },
	{ coll: 'spacingSizes', kind: 'spacing', type: 'unit', value: 'size', preset: 'spacing', category: 'Spacing', scope: GB_SPACING_SCOPE, control: 'unitControl' },
	{ coll: 'radiusSizes', kind: 'radius', type: 'unit', value: 'size', preset: null, category: 'Radius', scope: GB_RADIUS_SCOPE, control: 'unitControl' },
	{ coll: 'fontFamilies', kind: 'font-family', type: 'text', value: 'fontFamily', preset: 'font-family', category: 'Typography', scope: ['fontFamily'], control: null },
];

// Fluid font sizes keep `size` = desktop value plus fluid {min,max}; GenerateBlocks tokens need one value, so build the clamp().
function gbValue(k, e, vp, base) {
	if (k.coll === 'fontSizes' && isObj(e.fluid)) {
		const a = parseSize(e.fluid.min, base), b = parseSize(e.fluid.max, base);
		if (a !== null && b !== null) return clampSize(a, b, /rem$/.test(e.fluid.max) ? 'rem' : 'px', base, vp);
	}
	return e[k.value];
}

function buildGenerateBlocks(source, gbCfg, mode, vp, base) {
	if (!['values', 'alias'].includes(mode)) die(`--gb-mode must be "values" or "alias", got "${mode}"`);
	const prefix = gbCfg.prefix ?? '';
	const styles = {}, designTokens = [], lines = [`GenerateBlocks design tokens (mode "${mode}")`];
	for (const k of GB_KINDS) {
		if (gbCfg.include && !gbCfg.include.includes(k.coll)) continue;
		const entries = getPath(source, collections_path(k.coll));
		if (!Array.isArray(entries) || !entries.length) continue;
		const literal = mode === 'alias' && !k.preset;
		for (const e of entries) {
			const name = `--${prefix}${k.kind}-${e.slug}`;
			styles[name] = mode === 'alias' && k.preset ? `var(--wp--preset--${k.preset}--${e.slug})` : gbValue(k, e, vp, base);
			const t = { name, type: k.type, label: e.name, scope: gbCfg.scopes?.[k.coll] ?? k.scope, category: gbCfg.categories?.[k.coll] ?? k.category };
			if (k.control) t.display = { control: k.control };
			designTokens.push(t);
		}
		lines.push(`  ${k.coll.padEnd(13)} ${String(entries.length).padStart(3)} tokens${literal ? ' (literal values: no verified preset variable)' : ''}`);
	}
	if (!designTokens.length) lines.push('  nothing to generate');
	const json = { kind: 'generateblocks/design-system', version: 1, globalStyles: [{ kind: 'generateblocks/global-style', version: 1, selector: ':root', isPartial: false, styles }], designTokens };
	const css = Object.entries(styles).map(([n, v]) => `${n}: ${v};`).join('\n') + '\n';
	lines.push('  Import the JSON in the GenerateBlocks Design dashboard (adds missing tokens only). To update values of existing tokens, paste the CSS file into CSS Mode.');
	return { json, css, report: '\n' + lines.join('\n') };
}
const collections_path = (name) => DEFAULT_COLLECTIONS.find((c) => c.name === name).path;

/* ------------------------------------------------------------------ main */
if (!opt.theme) die(`--theme is required\n\n${HELP}`);
const themePath = path.resolve(opt.theme);
const themeDir = path.dirname(themePath);
if (!fs.existsSync(themePath)) die(`theme.json not found: ${themePath}`);
const targetText = readText(themePath);
const target = readJson(themePath, 'theme.json');

const cfgPath = opt.config ? path.resolve(opt.config) : path.join(themeDir, 'figma-sync.config.json');
const userCfg = fs.existsSync(cfgPath) ? readJson(cfgPath, 'config') : {};
const collections = buildCollections(userCfg);
const statePath = opt.state ? path.resolve(opt.state) : path.join(themeDir, '.figma-sync-state.json');
const state = fs.existsSync(statePath) ? readJson(statePath, 'state file') : { version: 1, collections: {} };

const count = (v) => (Array.isArray(v) ? v.length : isObj(v) ? Object.keys(v).length : null);

if (opt.inspect) {
	const source = opt.tokens ? tokensToSource(readJson(path.resolve(opt.tokens), 'tokens file'), buildRules(userCfg), collections, userCfg).source : null;
	console.log(`Token collections in ${themePath}${source ? ' (and source)' : ''}:`);
	for (const c of collections) {
		const t = count(getPath(target, c.path));
		const s = source ? count(getPath(source, c.path)) : null;
		console.log(`  ${c.name.padEnd(14)} theme.json: ${t === null ? 'absent' : t + ' entries'}${source ? `   source: ${s === null ? 'absent' : s + ' entries'}` : ''}`);
	}
	console.log(`State file: ${fs.existsSync(statePath) ? statePath : 'none (first sync: Figma wins on differing values)'}`);
	process.exit(0);
}

if (!opt.tokens) die(`--tokens is required\n\n${HELP}`);
const { source, report: mapReport } = tokensToSource(readJson(path.resolve(opt.tokens), 'tokens file'), buildRules(userCfg), collections, userCfg);
console.log(mapReport);
if (getPath(source, ['settings', 'typography', 'fontSizes'])?.some((e) => isObj(e.fluid)) && !getPath(target, ['settings', 'typography', 'fluid'])) {
	console.log('Note: theme.json has no settings.typography.fluid, so WordPress ignores fluid font sizes. Set it to true or {"minViewportWidth","maxViewportWidth"}.\n');
}

const { ops, log, next } = plan(source, target, collections, state, opt);

// Apply in memory, then verify before anything touches disk.
const doc = new Doc(targetText);
try { for (const op of ops) applyOp(doc, op); } catch (e) { die(`internal error while editing, nothing written: ${e.message}`); }
let merged;
try { merged = JSON.parse(doc.text); } catch (e) { die(`internal error, result is not valid JSON, nothing written: ${e.message}`); }
const stripManaged = (obj) => { const c = structuredClone(obj); collections.forEach((x) => delPath(c, x.path)); return JSON.stringify(c); };
if (stripManaged(target) !== stripManaged(merged)) die('safety check failed: content outside the managed collections would change. Nothing written.');
if (plan(source, merged, collections, state, opt).ops.length) die('safety check failed: result does not converge on the source. Nothing written.');

// Report
const sym = { '+': 'add', '~': 'change', '-': 'remove', '!': 'conflict', '=': 'local edit', '?': 'unmanaged', '.': 'skip' };
for (const c of collections) {
	const lines = log.filter((l) => l.coll === c.name);
	if (!lines.length) continue;
	console.log(`\n${c.name}`);
	for (const l of lines) console.log(`  ${l.sym} ${l.msg}`);
}
const tally = {};
log.forEach((l) => { tally[l.sym] = (tally[l.sym] ?? 0) + 1; });
console.log(`\nSummary: ${Object.entries(tally).map(([s, n]) => `${n} ${sym[s]}`).join(', ') || 'nothing to do, theme.json already matches Figma'}`);
console.log(`Everything outside ${collections.map((c) => c.path.join('.')).join(', ')} is unchanged (verified).`);

const dangling = scanRefs(themeDir, themePath, doc.text, merged, collections);
if (dangling.length) {
	console.log('\nPossibly dangling preset references (slug not defined after this sync):');
	for (const d of dangling) console.log(`  ${d.preset}: ${d.slug}   in ${d.files.slice(0, 3).join(', ')}${d.files.length > 3 ? ` +${d.files.length - 3} more` : ''}`);
}

if (opt['gb-out'] || userCfg.generateblocks?.outDir) {
	const gbCfg = userCfg.generateblocks ?? {};
	const gb = buildGenerateBlocks(source, gbCfg, opt['gb-mode'] ?? gbCfg.mode ?? 'values', fluidVp(userCfg), userCfg.rootFontSize ?? 16);
	console.log(gb.report);
	if (opt.apply) {
		// --gb-out wins over config generateblocks.outDir; relative config paths resolve against the theme folder
		const dir = opt['gb-out'] ? path.resolve(opt['gb-out']) : path.resolve(themeDir, gbCfg.outDir);
		const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
		const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
		const fJson = path.join(dir, `generateblocks-design-system-${stamp}.json`), fCss = path.join(dir, `generateblocks-tokens-${stamp}.css`);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(fJson, JSON.stringify(gb.json, null, 2) + '\n', { flag: 'wx' });
		fs.writeFileSync(fCss, gb.css, { flag: 'wx' });
		console.log(`Wrote ${fJson}\n   and ${fCss}`);
	}
}

if (!opt.apply) { console.log('\nDry run: nothing written. Re-run with --apply to write.'); process.exit(0); }
if (doc.text !== targetText) fs.writeFileSync(themePath, doc.text);
fs.writeFileSync(statePath, JSON.stringify({ version: 1, source: path.basename(opt.tokens), collections: next }, null, '\t') + '\n');
console.log(`\nWrote ${themePath}\nWrote ${statePath}`);
