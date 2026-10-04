import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, parseTree, walkTree, splitSelectorList, requiredClasses } from '../scripts/qa/css-tools.mjs';
import { GLOBAL_CSS_FILES } from './helpers/global-css.mjs';

// The shape of the stylesheets: what lives where (#154), how rules are scoped and layered (#149), who owns a class (#151).
const read = (file) => readFileSync(join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
const rulesOf = (file) => { const out = []; walkTree(parseTree(read(file)), (node) => { if (node.kind === 'rule') out.push(node); }); return out; };

/* ── #154 ── ui/style.css was a 4,500-line dump: tokens, the element layer, the shell and every feature. */
const GLOBAL_FRAME = ['ui/tokens.css', 'ui/base.css', 'ui/shell.css'];
/* The class prefixes of the features. A selector in the token, base or shell sheet that names one is a feature rule that
   landed in the wrong file: it belongs next to its component (ui/review/, ui/study-map/, ui/draft.css, ...). */
const FEATURE_PREFIXES = new Set([
  'review', 'question', 'card', 'flash', 'flashcard', 'flip', 'option', 'options', 'choice', 'grade', 'grading', 'response', 'explanation', 'hint',
  'teaching', 'prereq', 'next', 'submit', 'answer', 'citation', 'citations', 'publication', 'session', 'summary', 'quality',
  'desk', 'today', 'resume', 'lv', 'map', 'catalog', 'folder', 'chip', 'mastery', 'topic', 'selection', 'section', 'nb', 'stats',
  'draft', 'json', 'sticky', 'source', 'audio', 'binding', 'md', 'note', 'followup', 'explanation-followup', 'generation', 'jobs',
]);

/* The page frame animates and aligns the roots of the pages it hosts, so it names them. */
const FRAME_NAMES = new Set(['review-page', 'board-page', 'section-heading-actions']);

test('ui/style.css is gone: tokens, base and shell are small, the features have their own files', () => {
  assert.equal(existsSync(join(ROOT, 'ui/style.css')), false, 'split into tokens.css, base.css, shell.css and the feature sheets');
  for (const file of GLOBAL_FRAME) assert.ok(read(file).split('\n').length < 600, `${file} stays under 600 lines`);
  for (const file of GLOBAL_CSS_FILES) assert.ok(existsSync(join(ROOT, file)), `${file} is listed in tests/helpers/global-css.mjs and ui/styles.js`);
  const styles = read('ui/styles.js');
  for (const file of GLOBAL_CSS_FILES) assert.ok(styles.includes(`'./${file.slice(3)}'`), `ui/styles.js imports ${file}`);
});

test('no feature selector lands back in tokens.css, base.css or shell.css', () => {
  const offenders = [];
  for (const file of GLOBAL_FRAME) {
    for (const node of rulesOf(file)) {
      for (const entry of splitSelectorList(node.prelude)) {
        for (const name of requiredClasses(entry)) {
          const prefix = name.split(/__|--|-/)[0];
          if (FRAME_NAMES.has(name)) continue;
          if (FEATURE_PREFIXES.has(prefix) || FEATURE_PREFIXES.has(name)) offenders.push(`${file}:${node.line} .${name}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], 'move the rule into the sheet of its feature (see ui/styles.js for the list)');
});

test('the token sheet holds custom properties and theme switches only', () => {
  for (const node of rulesOf('ui/tokens.css')) {
    const plain = node.decls.filter((decl) => !decl.prop.startsWith('--') && !['color-scheme', 'color'].includes(decl.prop));
    assert.deepEqual(plain.map((decl) => decl.prop), [], `${node.prelude.slice(0, 60)} at line ${node.line} sets ${plain.map((d) => d.prop)}`);
  }
});
