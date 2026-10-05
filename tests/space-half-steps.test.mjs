/* #148 option A: the 4px spacing grid has named half-steps, and no stylesheet writes those values as raw px.
   --space-1-5 = 6px, 2-5 = 10px, 3-5 = 14px, 4-5 = 18px, 5-5 = 22px, 6-5 = 28px, 7-less = 30px. They are calc() of the
   neighbouring --space-* so a density setting moves them together with the rest of the scale. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ROOT, walk, parseCss, stripCssComments } from '../scripts/qa/guardrail-baseline.mjs';

const STEPS = { '--space-1-5': 6, '--space-2-5': 10, '--space-3-5': 14, '--space-4-5': 18, '--space-5-5': 22, '--space-6-5': 28, '--space-7-less': 30 };
const GRID = { '--space-1': 4, '--space-2': 8, '--space-3': 12, '--space-4': 16, '--space-5': 20, '--space-6': 24, '--space-7': 32 };
const SPACING = /^(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left|inline|block)(-(start|end))?)?$/;
const INSET = /^(inset|top|right|bottom|left)(-(inline|block)(-(start|end))?)?$/;

const tokens = readFileSync(join(ROOT, 'ui/tokens.css'), 'utf8');

/* Evaluates the small calc() forms the tokens use: ((a + b) / 2), (a - b). */
function evaluate(expression) {
  const vars = { ...GRID, '--space-half': 2 };
  const text = expression.replace(/var\((--[\w-]+)\)/g, (_, name) => String(vars[name]));
  assert.match(text, /^calc\([\d\s+\-*/().]+\)$|^\d+px$/, `unexpected token value: ${expression}`);
  return text.endsWith('px') ? parseInt(text, 10) : Function(`return ${text.slice(5, -1)}`)();
}

test('the half-step tokens exist in tokens.css and resolve to the identity px values', () => {
  for (const [name, px] of Object.entries(STEPS)) {
    const match = tokens.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
    assert.ok(match, `${name} is not defined in ui/tokens.css`);
    assert.equal(evaluate(match[1].trim()), px, `${name} must equal ${px}px at the default density`);
  }
});

test('ui/DESIGN.md names every half-step and says when to use which', () => {
  const design = readFileSync(join(ROOT, 'ui/DESIGN.md'), 'utf8');
  for (const name of Object.keys(STEPS)) assert.ok(design.includes(`\`${name}\``), `${name} is missing from the spacing section of ui/DESIGN.md`);
});

test('no feature stylesheet writes a half-step value as raw px in padding / margin / gap / inset', () => {
  const hits = [];
  const raw = new RegExp(`(?<![\\w.-])(${Object.values(STEPS).join('|')})px\\b`);
  for (const file of walk(join(ROOT, 'ui'), ['.css'])) {
    const rel = relative(ROOT, file).split('\\').join('/');
    if (['ui/tokens.css', 'ui/appearance-themes.css'].includes(rel)) continue;
    for (const decl of parseCss(readFileSync(file, 'utf8')).declarations) {
      if (!SPACING.test(decl.prop) && !INSET.test(decl.prop)) continue;
      if (raw.test(decl.value.replace(/url\([^)]*\)/g, ''))) hits.push(`${rel}:${decl.line} ${decl.prop}: ${decl.value}`);
    }
  }
  assert.deepEqual(hits, [], `use the --space-* half-step tokens:\n${hits.slice(0, 20).join('\n')}${hits.length > 20 ? `\n... ${hits.length - 20} more` : ''}`);
});

test('the density overrides still only redefine the whole steps, so the half-steps follow them', () => {
  const themes = stripCssComments(readFileSync(join(ROOT, 'ui/appearance-themes.css'), 'utf8'));
  for (const name of Object.keys(STEPS)) assert.ok(!themes.includes(`${name}:`), `${name} must stay derived from --space-1…7, not be overridden per density`);
});
