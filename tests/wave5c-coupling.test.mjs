import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Wave 5C (tracker #161): features must not borrow another feature's class names or stylesheets.
const root = fileURLToPath(new URL('../', import.meta.url));
const walk = (dir, exts, out = []) => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.some((ext) => name.endsWith(ext))) out.push(full);
  }
  return out;
};
const files = (exts) => walk(join(root, 'ui'), exts).map((abs) => relative(root, abs).split(sep).join('/'));
const read = (file) => readFileSync(join(root, file), 'utf8');
const isAudio = (file) => /^ui\/(audio\/|Audio[\w-]*\.jsx$)/.test(file);

test('only the audio components write audio-* class names (#141)', () => {
  const offenders = files(['.jsx']).filter((file) => !isAudio(file)).flatMap((file) => {
    const hits = [...read(file).matchAll(/className=(?:"([^"]*)"|\{[^}]*?[`'"]([^`'"]*)[`'"])/g)].filter((m) => /(?<![\w-])audio-[a-z]/.test(m[1] ?? m[2] ?? ''));
    return hits.map((m) => `${file}: ${m[0].slice(0, 80)}`);
  });
  assert.deepEqual(offenders, [], 'a PDF, Jev or settings component that needs a provider card, a hint or a chip uses the primitive from ui/components, not the audio-* class');
});

test('audio-settings.css is injected by the audio components only (#141)', () => {
  const offenders = files(['.jsx', '.js']).filter((file) => !isAudio(file) && /study-audio-settings|audio-settings\.css/.test(read(file)));
  assert.deepEqual(offenders, [], 'the sheet belongs to AudioSettings and AudioImport');
});

test('every fold arrow is the DisclosureToggle: no hand-made *-caret classes or glyph carets remain (#146)', () => {
  const offenders = [];
  for (const file of files(['.jsx', '.js', '.css']).filter((f) => !f.startsWith('ui/components/') && !f.startsWith('ui/locales/'))) {
    const text = read(file).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of text.matchAll(/(?<![\w-])(?:map|course|sk|source-group)-caret\b|(["'`])[▾▸▼▶]\1/g)) offenders.push(`${file}: ${m[0]}`);
  }
  assert.deepEqual(offenders, [], 'use <DisclosureToggle label={foldLabel(open, name)}> (an accessible name, aria-expanded, the caret icon turned in CSS)');
});

test('no stylesheet outside the audio sheets defines a .audio-* rule except the host overrides of the embedded import (#141)', () => {
  const allowed = new Set(['ui/import-hub.css', 'ui/settings.css']);
  const offenders = files(['.css']).filter((file) => !/^ui\/(audio[\w-]*\.css|audio\/)/.test(file) && !allowed.has(file) && /(?<![\w-])\.audio-[a-z]/.test(read(file)));
  assert.deepEqual(offenders, [], 'move the rule next to the class its component owns');
});
