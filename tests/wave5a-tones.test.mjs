import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// UI wave 5A, #96: one tone vocabulary (neutral | info | success | warning | error | accent), every var(--x) defined, and the
// tone colours are written once (tokens.css), not hand-mixed per feature.
const walk = (dir, extensions) => readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(`${dir}/${entry.name}`, extensions) : extensions.some(ext => entry.name.endsWith(ext)) ? [`${dir}/${entry.name}`] : []);
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const sources = [...walk('ui', ['.js', '.jsx', '.css']), ...walk('lib', ['.js']).filter(file => !/^lib\/client\./.test(file))].map(file => ({ file, text: read(file) }));

test('no source names a tone ok / warn / bad / good: the vocabulary is success / warning / error', () => {
  const pattern = /\btone["']?\s*[:=]\s*\{?\s*["'](?:ok|warn|bad|good)["']|data-tone=["'](?:ok|warn|bad|good)["']|data-tone=\{?["'](?:ok|warn|bad|good)["']\}?|\[data-tone=["'](?:ok|warn|bad|good)["']\]/;
  const ternary = /\?\s*['"](?:ok|warn|bad|good)['"]\s*:\s*['"](?:ok|warn|bad|good)['"]/;
  assert.deepEqual(sources.filter(({ text }) => pattern.test(text) || ternary.test(text)).map(({ file }) => file), []);
});

test('--warn-text is defined once and every other tone token resolves', () => {
  const tokens = read('ui/tokens.css');
  assert.match(tokens, /--warn-text:\s*var\(--warn-ink\)/);
  for (const tone of ['ok', 'warn', 'bad', 'info']) for (const part of ['ink', 'bg', 'line']) assert.match(tokens, new RegExp(`--${tone}-${part}:`), `--${tone}-${part}`);
});

test('feature stylesheets do not hand-mix the status colours', () => {
  const allowed = new Set(['ui/tokens.css', 'ui/paper.css']);
  const found = sources.filter(({ file }) => file.endsWith('.css') && !allowed.has(file)).flatMap(({ file, text }) =>
    [...text.matchAll(/color-mix\(in srgb, var\(--(?:warn|bad|ok|info)\)/g)].map(() => file));
  assert.deepEqual(found, []);
});
