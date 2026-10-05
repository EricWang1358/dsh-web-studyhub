import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// UI wave 5A, #95: one chip / badge family. Static labels are <Badge>, the per-feature chip classes are gone, and the number of
// chip / badge / tag base classes can only go down.
const walk = (dir, extensions) => readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? walk(`${dir}/${entry.name}`, extensions) : extensions.some(ext => entry.name.endsWith(ext)) ? [`${dir}/${entry.name}`] : []);
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const sources = walk('ui', ['.jsx', '.js', '.css']).map(file => ({ file, text: read(file) }));
const stripped = ({ file, text }) => ({ file, text: file.endsWith('.css') ? text.replace(/\/\*[\s\S]*?\*\//g, '') : text });

test('the migrated chip classes are gone from markup and styles', () => {
  const names = ['case-chip', 'exam-chip', 'sk-chip', 'sk-badge', 'nb-chip', 'usage-chip', 'audio-chip', 'en-tag', 'origin-tag', 'tr-chip', 'course-parked-chip', 'skc-focus-chip',
    'jev-chip', 'library-chip', 'result-note-badge', 'generate-chips', 'sk-chips', 'reader-badge'];
  const found = sources.map(stripped).filter(({ file }) => !/^ui\/(?:Audio|audio|MinerU|Mineru|mineru)/.test(file)).flatMap(({ file, text }) => names.filter(name => new RegExp(`(?<![\\w-])${name}(?![\\w-])`).test(text)).map(name => `${file}: ${name}`));
  assert.deepEqual(found, []);
});

test('JevDecidedBadge has one definition', () => {
  const defined = sources.filter(({ file }) => /\.jsx$/.test(file) && /export (?:function|const) JevDecidedBadge\b/.test(file && read(file)));
  assert.deepEqual(defined.map(({ file }) => file), ['ui/JevBadge.jsx']);
});

/** The base classes of the chip / badge / tag families that a feature stylesheet defines itself (not parts `__x`, not modifiers `--x`, not the shared sh-*). */
function familyClasses() {
  const found = new Set();
  for (const { text } of sources.filter(({ file }) => file.endsWith('.css')).map(stripped))
    for (const match of text.matchAll(/(?:^|[\s,}{>+~])\.((?:[a-z][a-z0-9]*-)*(?:chip|badge|tag)s?)(?![\w-]|__)/gm)) if (!match[1].startsWith('sh-')) found.add(match[1]);
  return [...found].sort();
}

// Lower only: delete a class from this list when its markup becomes a Badge or Chip. Adding to it fails the test.
// Wave 5C kept six on purpose: board-chip (a label with its own hue, plus choice buttons), board-study-chip (a removable link), nav-badge (the count
// in a sidebar row), setup-chip (the collapsed setup checklist), spine-chip (the current step with its fold) and update-chip (a button that is the update state).
const REMAINING = ['board-chip', 'board-study-chip', 'nav-badge', 'setup-chip', 'spine-chip', 'update-chip'];

test('the chip / badge / tag base classes only shrink', () => {
  const now = familyClasses();
  assert.deepEqual(now.filter(name => !REMAINING.includes(name)), [], 'a new chip-like class: use <Badge> or <Chip>');
});
