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
console.log('smoke test passed');
