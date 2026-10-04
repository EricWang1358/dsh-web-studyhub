import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanStateClasses, readStateBaseline, BARE_STATES } from '../scripts/qa/css-state-classes.mjs';

// #159: states are attributes ([aria-pressed], [aria-selected], [aria-current], [data-state]) or `is-*` classes, never a bare .on/.active/.selected/...
const now = scanStateClasses();
const baseline = readStateBaseline();

test('no stylesheet gains a bare state class selector', () => {
  const worse = [];
  for (const [file, names] of Object.entries(now)) for (const [name, n] of Object.entries(names)) {
    const allowed = baseline[file]?.[name] ?? 0;
    if (n > allowed) worse.push(`${file} .${name}: ${n} (allowed ${allowed})`);
  }
  assert.deepEqual(worse, [], 'write [aria-pressed="true"], [aria-selected="true"], [aria-current], [data-state="done"] or an is-* class instead');
});

test('the recorded counts are tight: fixing one lowers the baseline', () => {
  const loose = [];
  for (const [file, names] of Object.entries(baseline)) for (const [name, allowed] of Object.entries(names)) {
    const n = now[file]?.[name] ?? 0;
    if (n < allowed) loose.push(`${file} .${name}: ${n}, recorded ${allowed}`);
  }
  assert.deepEqual(loose, [], 'node scripts/qa/css-state-classes.mjs --update');
});

test('the scanner finds bare states in any selector position and leaves is-* alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'state-css-'));
  try {
    mkdirSync(join(root, 'ui'), { recursive: true });
    writeFileSync(join(root, 'ui', 'a.css'), '.tab.active { color: red; }\n.row:not(.done) .on, .is-active { color: red; }\n@media (min-width: 1px) { .x.selected { color: red; } }\n.is-current, .opened { color: red; }\n');
    assert.deepEqual(scanStateClasses(root), { 'ui/a.css': { active: 1, done: 1, on: 1, selected: 1 } });
    assert.ok(BARE_STATES.includes('picked') && BARE_STATES.includes('current') && BARE_STATES.includes('open'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
