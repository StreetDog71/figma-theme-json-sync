// Smoke test: no dependencies. Run with `npm test` or `node tests/smoke.mjs`.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sync = path.join(root, 'scripts/sync.mjs');
const tokens = path.join(root, 'examples/basic-design-system.tokens.json');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsync-'));
const theme = path.join(dir, 'theme.json');
const original = '{\n\t"$schema": "x",\n\t"version": 3,\n\t"settings": {\n\t\t"layout": { "contentSize": "700px" }\n\t},\n\t"styles": { "color": { "text": "var(--wp--preset--color--text-primary)" } }\n}\n';
fs.writeFileSync(theme, original);
const run = (...a) => execFileSync('node', [sync, '--theme', theme, '--tokens', tokens, ...a], { encoding: 'utf8' });

// dry run writes nothing
run();
assert.equal(fs.readFileSync(theme, 'utf8'), original, 'dry run must not write');

// apply writes presets and keeps unmanaged content
run('--apply');
const t = JSON.parse(fs.readFileSync(theme, 'utf8'));
assert.equal(t.styles.color.text, 'var(--wp--preset--color--text-primary)');
assert.ok(t.settings.color.palette.length > 0, 'palette');
assert.ok(t.settings.typography.fontSizes.length > 0, 'font sizes');
assert.ok(t.settings.spacing.spacingSizes.some((s) => String(s.size).includes('clamp(')), 'fluid spacing');

// second run is a no-op
const after = fs.readFileSync(theme, 'utf8');
run('--apply');
assert.equal(fs.readFileSync(theme, 'utf8'), after, 'idempotent');

// GenerateBlocks output is timestamped
const out = path.join(dir, 'gb');
run('--apply', '--gb-out', out);
const files = fs.readdirSync(out);
assert.ok(files.some((f) => /^generateblocks-design-system-\d{8}-\d{6}\.json$/.test(f)), 'gb json');
assert.ok(files.some((f) => /^generateblocks-tokens-\d{8}-\d{6}\.css$/.test(f)), 'gb css');
// float noise from Figma is rounded
const noisy = path.join(dir, 'noisy.tokens.json');
fs.writeFileSync(noisy, JSON.stringify({ collections: [{ name: 'Type', modes: ['Default'], variables: [{ name: 'line-height/heading', type: 'float', values: { Default: 1.100000023841858 } }] }] }));
const other = path.join(dir, 'other');
fs.mkdirSync(other);
const theme2 = path.join(other, 'theme.json');
fs.writeFileSync(theme2, '{ "settings": { "color": { "palette": [] } } }\n');
// generated GenerateBlocks exports are not reported as references; real files are
fs.writeFileSync(path.join(other, 'generateblocks-tokens-20260101-000000.css'), 'a { color: var(--wp--preset--color--from-export); }');
fs.writeFileSync(path.join(other, 'style.css'), 'a { color: var(--wp--preset--color--from-theme); }');
const report = execFileSync('node', [sync, '--theme', theme2, '--tokens', noisy, '--apply'], { encoding: 'utf8' });
assert.equal(JSON.parse(fs.readFileSync(theme2, 'utf8')).settings.custom.lineHeight.heading, 1.1, 'rounded');
assert.ok(report.includes('from-theme'), 'real reference reported');
assert.ok(!report.includes('from-export'), 'export ignored');
// order follows Figma; theme-only entries go last; "order": "theme" opts out
const ordDir = path.join(dir, 'order');
fs.mkdirSync(ordDir);
const theme3 = path.join(ordDir, 'theme.json');
const before = '{\n  "settings": {\n    "color": {\n      "palette": [\n        { "slug": "mine", "name": "Mine", "color": "#000000" },\n        { "slug": "b", "name": "B", "color": "#222222" }\n      ]\n    },\n    "custom": { "lineHeight": { "two": 2, "one": 1 } }\n  }\n}\n';
const ordTokens = path.join(ordDir, 't.json');
const col = (n, v) => ({ name: n, type: 'color', values: { Default: v } });
const num = (n, v) => ({ name: n, type: 'float', values: { Default: v } });
fs.writeFileSync(ordTokens, JSON.stringify({ collections: [{ name: 'Colors', modes: ['Default'], variables: [col('a', '#111111'), col('b', '#222222'), col('c', '#333333'), num('line-height/one', 1), num('line-height/two', 2)] }] }));
const sync3 = () => execFileSync('node', [sync, '--theme', theme3, '--tokens', ordTokens, '--apply'], { encoding: 'utf8' });
const read3 = () => JSON.parse(fs.readFileSync(theme3, 'utf8')).settings;
fs.writeFileSync(theme3, before);
sync3();
assert.deepEqual(read3().color.palette.map((e) => e.slug), ['a', 'b', 'c', 'mine'], 'figma order');
assert.deepEqual(Object.keys(read3().custom.lineHeight), ['one', 'two'], 'map order');
assert.ok(fs.readFileSync(theme3, 'utf8').includes('{ "slug": "mine", "name": "Mine", "color": "#000000" }'), 'entry text moves intact');
const ordered = fs.readFileSync(theme3, 'utf8');
assert.ok(!sync3().includes('reordered'), 'order is stable');
assert.equal(fs.readFileSync(theme3, 'utf8'), ordered);
fs.rmSync(path.join(ordDir, '.figma-sync-state.json'));
fs.writeFileSync(theme3, before);
fs.writeFileSync(path.join(ordDir, 'figma-sync.config.json'), '{ "order": "theme" }');
sync3();
assert.deepEqual(read3().color.palette.map((e) => e.slug), ['mine', 'b', 'a', 'c'], 'theme order');
console.log('smoke test passed');
