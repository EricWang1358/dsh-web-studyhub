/* The display numerals are the focal objects of their pages (ui/DESIGN.md: "large light numerals for counts"): the
   streak, the today card count, the result headline, rates and scores. The wave-3 token pass once snapped them all to
   --fs-3xl (28px); this keeps each one on the display scale. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = file => readFileSync(new URL(`../ui/${file}`, import.meta.url), 'utf8');

test('the display scale exists above --fs-3xl', () => {
  const tokens = css('tokens.css');
  for (const [name, value] of [['4xl', 34], ['5xl', 44], ['6xl', 52], ['7xl', 72], ['8xl', 96], ['9xl', 104], ['10xl', 156]])
    assert.match(tokens, new RegExp(`--fs-${name}: ${value}px;`), `--fs-${name}`);
});

test('focal numerals use the display scale, not a body size', () => {
  const cases = [
    ['views.css', /\.dash-streak strong \{[^}]*font-size: var\(--fs-10xl\)/s, 'statistics streak'],
    ['views.css', /\.dash-streak strong \{ font-size: var\(--fs-9xl\); \}/, 'statistics streak, narrow'],
    ['views.css', /\.dash-rates strong \{[^}]*font-size: var\(--fs-5xl\)/s, 'statistics rates'],
    ['home-tiers.css', /\.today-count strong \{[^}]*font-size: var\(--fs-8xl\)/s, 'today card count'],
    ['home-tiers.css', /\.today-count strong \{ font-size: var\(--fs-7xl\); \}/, 'today card count, narrow'],
    ['review-results.css', /\.result-headline strong \{[^}]*font-size: clamp\(var\(--fs-6xl\), 8cqi, var\(--fs-7xl\)\)/s, 'result headline'],
    ['study-map/desk.css', /\.desk-mastery-value \{[^}]*font-size: var\(--fs-5xl\)/s, 'desk mastery'],
  ];
  for (const [file, pattern, label] of cases) assert.match(css(file), pattern, label);
});

test('no clamp() collapses to one size', () => {
  for (const file of ['review-results.css', 'oral-exam.css', 'study-map/catalog.css'])
    assert.doesNotMatch(css(file), /clamp\((var\(--fs-[\w-]+\)), [\d.]+cq\w+, \1\)/, `${file}: a clamp with equal bounds`);
});
