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

/** The base classes of the chip / badge / tag families that a feature stylesheet defines itself (not parts `__x`, not modifiers `--x`, not the shared sh-*).
 *  `chipbtn` is a chip drawn as a button (tr-chipbtn). */
function familyClasses() {
  const found = new Set();
  for (const { text } of sources.filter(({ file }) => file.endsWith('.css')).map(stripped))
    for (const match of text.matchAll(/(?:^|[\s,}{>+~])\.((?:[a-z][a-z0-9]*-)*(?:chip|chipbtn|badge|tag)s?)(?![\w-]|__)/gm)) if (!match[1].startsWith('sh-')) found.add(match[1]);
  return [...found].sort();
}

// Lower only: delete a class from this list when its markup becomes a Badge or Chip. Adding to it fails the test.
// Each stays because it is not a status label or a toggle (Badge, Chip) but something with behaviour they lack:
//   board-chip    a card label whose colour is one of six hues chosen by the label (Badge and Chip have six tones that mean a state, three hues are no tone),
//                 and it shares one rule with board-due and board-progress, which sit in the same row and are not Badges either (#95: needs a decision on hue)
//   nav-badge     the count in a sidebar row (NavItem's hint slot), which folds into a dot on the collapsed rail
//   setup-chip    a section: the collapsed setup checklist, a toggle that opens the list of steps under it
//   spine-chip    a group of three controls (previous station, the station's name with its tooltip, next station)
//   tr-chipbtn    a button that floats against the selected text and is placed by useRangeAnchor; it is the control itself, with no label
//   update-chip   a button that opens the update dialog; the state it shows inside is already a <Badge>
const REMAINING = ['board-chip', 'nav-badge', 'setup-chip', 'spine-chip', 'tr-chipbtn', 'update-chip'];

test('the chip / badge / tag base classes only shrink', () => {
  const now = familyClasses();
  assert.deepEqual(now.filter(name => !REMAINING.includes(name)), [], 'a new chip-like class: use <Badge> or <Chip>');
  assert.deepEqual(REMAINING.filter(name => !now.includes(name)), [], 'this class is gone: delete it from REMAINING so the count cannot grow back');
});
