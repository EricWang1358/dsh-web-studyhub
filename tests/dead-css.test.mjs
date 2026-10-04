import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanDead, collectUsage, isAlive, deleteDead, pruneEmpty, NEVER_SET, ONLY_COMPOUND } from '../scripts/qa/dead-css.mjs';
import { ROOT, FROZEN_FILES, cssFiles, parseTree } from '../scripts/qa/css-tools.mjs';

// Dead CSS (#155): a class selector that no ui source can put on an element is a rule nobody can see.

test('no stylesheet carries a rule for a class that nothing renders', () => {
  const { report } = scanDead();
  const dead = report.filter((hit) => !FROZEN_FILES.includes(hit.file));
  assert.deepEqual(dead.map((hit) => `${hit.file}:${hit.line} ${hit.selector.slice(0, 80)} -> ${hit.dead.join(', ')}`), [],
    'delete the rule (node scripts/qa/dead-css.mjs --delete), or, if the class is built outside the source, list it in ALLOW_CLASSES in scripts/qa/dead-css.mjs with the reason');
});

test('every @keyframes is used by an animation', () => {
  const referenced = new Set();
  const defined = [];
  for (const file of cssFiles()) {
    const walk = (node) => {
      for (const decl of node.decls) if (/^(-webkit-)?animation(-name)?$/.test(decl.prop)) for (const m of decl.value.matchAll(/[A-Za-z_][\w-]*/g)) referenced.add(m[0]);
      for (const child of node.children) { const m = /^@(?:-webkit-)?keyframes\s+([\w-]+)$/.exec(child.prelude); if (m) defined.push({ file, name: m[1] }); walk(child); }
    };
    walk(parseTree(readFileSync(join(ROOT, file), 'utf8')));
  }
  const usage = collectUsage();
  assert.deepEqual(defined.filter((k) => !referenced.has(k.name) && !usage.words.has(k.name)).map((k) => `${k.file} ${k.name}`), []);
});

test('the checker understands dynamic and third-party class names', () => {
  const root = mkdtempSync(join(tmpdir(), 'dead-css-'));
  try {
    mkdirSync(join(root, 'ui'), { recursive: true });
    writeFileSync(join(root, 'ui', 'A.jsx'), [
      'export const A = ({ kind, id }) => <div className="used-class a__title"><b className={`tone-${kind}`} /><i className={"cell l" + id} />',
      '<u className={`${id}__icon`} /><s className="mastery-bar empty" role="alert" /></div>;',
      '// a comment that mentions .only-in-comment',
      '',
    ].join('\n'));
    writeFileSync(join(root, 'ui', 'x.css'), [
      '.used-class { color: red; }', '.a__title { color: red; }', '.tone-ok, .tone-bad { color: red; }', '.cell.l3 { color: red; }', '.k__icon { color: red; }',
      '.cm-editor .cm-line { color: red; }', '.mastery-bar.empty { color: red; }', '.empty { color: red; }', '.empty h2 { color: red; }',
      '.never-rendered { color: red; }', '.never-rendered:hover { color: red; }', '.only-in-comment { color: red; }', '.job > span { color: red; }',
      '.used-class .never-rendered { color: red; }', '.used-class, .gone-class { color: red; }', ':is(.used-class, .not-needed) { color: red; }',
      '@media (min-width: 1px) { .never-rendered { color: red; } }', '@keyframes unused-spin { to { opacity: 1; } }', '',
    ].join('\n'));
    const { report } = scanDead(root);
    const keyed = report.map((hit) => `${hit.line}:${hit.dead.join(',')}${hit.partial ? ':partial' : ''}`);
    assert.deepEqual(keyed, ['8:empty', '9:empty', '10:never-rendered', '11:never-rendered', '12:only-in-comment', '13:job', '14:never-rendered', '15:gone-class:partial', '17:never-rendered']);
    deleteDead(root);
    const after = readFileSync(join(root, 'ui', 'x.css'), 'utf8');
    assert.doesNotMatch(after, /never-rendered|gone-class|unused-spin|@media|only-in-comment|\.job/, 'dead rules, emptied @media and the unused @keyframes are removed');
    assert.match(after, /\.used-class \{/);
    assert.match(after, /:is\(\.used-class, \.not-needed\)/, 'a class inside :is() is an option, not a requirement');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hand-checked lists stay meaningful', () => {
  const usage = collectUsage();
  for (const name of Object.keys(NEVER_SET)) assert.equal(isAlive(name, usage), false, `${name} is listed as never set`);
  for (const name of Object.keys(ONLY_COMPOUND)) assert.equal(isAlive(name, usage, true), false);
  assert.equal(pruneEmpty('.a { }\n.b { color: red; }\n@media (x) { .c { } }\n'), '.b { color: red; }\n');
});
