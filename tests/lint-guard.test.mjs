import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ESLint } from 'eslint';
import { walk, countLintDisables, ROOT } from '../scripts/qa/guardrail-baseline.mjs';

/* The lint rules switched on by the 2026-11 code audit stay on, and nobody steps around them (eslint.config.js, `cheapRules`).
   Two ways round a rule are closed here: switching it off in a comment, and lowering it in the config. The third place, ui/, has old
   disable comments of its own (react-hooks/exhaustive-deps): they are the lintDisable ratchet of tests/ui-guardrails.test.mjs, which may only fall. */
const rel = (abs) => abs.slice(ROOT.length).replace(/\\/g, '/').replace(/^\/+/, '');
// Built by `npm run build`, never written by hand.
const generated = (file) => /^lib\/client(\.|$)/.test(file);

test('no lint rule is switched off in a comment outside ui/', () => {
  const hits = [];
  for (const dir of ['lib', 'scripts', 'tests', 'packages']) {
    for (const abs of walk(join(ROOT, dir), ['.js', '.mjs', '.jsx'])) {
      const file = rel(abs);
      if (generated(file)) continue;
      const count = countLintDisables(readFileSync(abs, 'utf8'));
      if (count) hits.push(`${file} (${count})`);
    }
  }
  assert.deepEqual(hits, [], 'fix what the rule points at; an exception that is really needed is a line in eslint.config.js with its reason, where a reviewer sees it');
});

const MUST_BE_ERRORS = ['no-unused-vars', 'no-undef', 'no-dupe-keys', 'no-empty', 'prefer-const', 'no-var', 'eqeqeq', 'no-useless-escape', 'no-useless-catch', 'no-unreachable',
  'no-unused-expressions', 'no-constant-condition', 'no-fallthrough', 'no-case-declarations', 'no-prototype-builtins', 'no-async-promise-executor', 'no-self-assign',
  'no-unsafe-optional-chaining', 'no-cond-assign', 'no-loss-of-precision', 'no-sparse-arrays', 'no-misleading-character-class'];
const UI_ERRORS = ['react-hooks/rules-of-hooks', 'react/jsx-key', 'react/no-unstable-nested-components', 'react/jsx-no-useless-fragment'];
const ERROR = 2;
const severityOf = (entry) => { const level = Array.isArray(entry) ? entry[0] : entry; return level === 'error' ? ERROR : level; };

test('the cheap correctness rules are errors for every kind of source file, and a leftover disable comment is one too', async () => {
  const eslint = new ESLint({ cwd: ROOT });
  const files = { 'lib/store.js': [], 'scripts/build.mjs': [], 'tests/lint-guard.test.mjs': [], 'ui/App.jsx': UI_ERRORS, 'ui/i18n.js': UI_ERRORS };
  for (const [file, extra] of Object.entries(files)) {
    const config = await eslint.calculateConfigForFile(join(ROOT, file));
    const lowered = [...MUST_BE_ERRORS, ...extra].filter((rule) => severityOf(config.rules?.[rule]) !== ERROR);
    assert.deepEqual(lowered, [], `${file}: these rules are no longer errors. They cost nothing to keep (the tree is clean), so fix the code, not the config`);
    assert.equal(severityOf(config.linterOptions?.reportUnusedDisableDirectives), ERROR, `${file}: a disable comment that silences nothing must be reported`);
  }
});

test('the scan counts the line, next-line and block forms, and nothing else', () => {
  const off = 'eslint-' + 'disable';
  assert.equal(countLintDisables(`a(); // ${off}-line no-empty\n// ${off}-next-line no-undef -- why\nb();\n/* ${off} no-var */\n/* eslint-enable no-var */`), 3);
  assert.equal(countLintDisables(`const text = '${off}'; assert.doesNotMatch(source, /${off}/); // the word ${off} inside a sentence`), 0);
});
