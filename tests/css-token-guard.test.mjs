/* #66 token coverage, in two small guards that only ever tighten.

   1. Raw hex colours. ui/DESIGN.md: "new CSS references tokens, never raw colours". The colours that exist today are allowed per file (HEX_BASELINE
      below); a NEW raw hex in a file that has none, or more of them than its baseline, fails. Colours inside a custom-property declaration
      (`--name: #hex;`, the token blocks) are tokens by definition and are not counted. When you remove raw colours the test also fails until you
      lower the number, so the baseline only goes down. To update it: run `node --test tests/css-token-guard.test.mjs`, the failure message prints the
      file and its real count; put that number in the table (delete the line at 0).
   2. Literals that equal a token. A `border-radius` of 8px / 12px / 16px and a `font-size` of 12 / 13 / 17 / 19 / 23 / 28px mean --radius-sm, --radius, --radius-card and
      --fs-xs ... --fs-3xl, so in the three high-traffic stylesheets they are written as the token (the corner style and a future
      type scale then reach them). Other pixel values are left alone: a bespoke size is not a token. (Not migrated on purpose: 15px, the base reading size, ~170 uses, and 999px pills, which no setting scales; it would only add bytes now.) */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '');

/** Raw hex colours (#rgb, #rgba, #rrggbb, #rrggbbaa) outside custom-property declarations. */
function countRawHex(source) {
  let count = 0;
  for (const declaration of stripComments(source).split(/[;{}]/)) {
    if (/^\s*--[\w-]+\s*:/.test(declaration)) continue;
    count += (declaration.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length;
  }
  return count;
}

const RADIUS_TOKENS = { 8: '--radius-sm', 12: '--radius', 16: '--radius-card' };
const FONT_TOKENS = { 12: '--fs-xs', 13: '--fs-sm', 17: '--fs-lg', 19: '--fs-xl', 23: '--fs-2xl', 28: '--fs-3xl' };

/** `border-radius` / `font-size` literals that have a token of exactly the same value. */
function literalsEqualToTokens(source) {
  const found = [];
  const text = stripComments(source);
  for (const match of text.matchAll(/border-radius\s*:\s*([^;{}]*)/g))
    for (const px of match[1].matchAll(/(?<![\w.-])(\d+)px\b/g)) if (RADIUS_TOKENS[px[1]]) found.push(`border-radius ${px[1]}px -> var(${RADIUS_TOKENS[px[1]]})`);
  for (const match of text.matchAll(/font-size\s*:\s*(\d+)px\b/g)) if (FONT_TOKENS[match[1]]) found.push(`font-size ${match[1]}px -> var(${FONT_TOKENS[match[1]]})`);
  return found;
}

/** Files (relative to ui/) that still hold raw hex colours, and how many. Only lower these. */
const HEX_BASELINE = {
  'board/board.css': 2,
  'components/components.css': 4,
  'components/scroll-window.css': 4,
  'document-preview/document-preview.css': 4,
  'document-preview/peek/peek.css': 1,
  'review-results.css': 5,
  'side-groups.css': 1,
  'skeleton.css': 4,
  'style.css': 4,
};

test('the counters understand the shapes they guard (fixtures)', () => {
  assert.equal(countRawHex('a { color: #fff; background: #a1b2c3; border: 1px solid #12345678; }'), 3);
  assert.equal(countRawHex('.x {\n  --accent: #c93d22;\n  --bg: #161412;\n}'), 0, 'a token definition is the token block');
  assert.equal(countRawHex('/* #ff0000 in a comment */\n.x { color: var(--text, #8885); }'), 1, 'a fallback is a raw colour');
  assert.equal(countRawHex('a { href: url(#anchor); content: "#"; }'), 0, '#anchor is not a colour here');
  assert.deepEqual(literalsEqualToTokens('a { border-radius: 12px; font-size: 13px; } b { border-radius: 12px 12px 0 0; }'), [
    'border-radius 12px -> var(--radius)', 'border-radius 12px -> var(--radius)', 'border-radius 12px -> var(--radius)', 'font-size 13px -> var(--fs-sm)']);
  assert.deepEqual(literalsEqualToTokens('a { border-radius: var(--radius); font-size: var(--fs-sm); font-size: 14px; border-radius: 10px; font-size: 1.12px; }'), []);
  assert.deepEqual(literalsEqualToTokens('a { border-radius: 999px; border-radius: 8px 0 0 8px; }'), ['border-radius 8px -> var(--radius-sm)', 'border-radius 8px -> var(--radius-sm)'], 'pills are not touched');
});

test('no new raw hex colours in ui CSS: counts stay at or below the baseline per file, and the baseline is tight', async () => {
  const files = (await readdir('ui', { recursive: true })).map(name => name.replace(/\\/g, '/')).filter(name => name.endsWith('.css')).sort();
  const problems = [];
  const seen = new Set();
  for (const name of files) {
    const count = countRawHex(await readFile(`ui/${name}`, 'utf8'));
    const allowed = HEX_BASELINE[name] ?? 0;
    seen.add(name);
    if (count > allowed) problems.push(`${name}: ${count} raw hex colours, ${allowed} allowed. Use a token (var(--...)) instead.`);
    if (count < allowed) problems.push(`${name}: ${count} raw hex colours but the baseline says ${allowed}. Lower HEX_BASELINE (${count === 0 ? 'remove the line' : `set it to ${count}`}).`);
  }
  for (const name of Object.keys(HEX_BASELINE)) if (!seen.has(name)) problems.push(`${name} is in HEX_BASELINE but the file is gone. Remove the line.`);
  assert.deepEqual(problems, []);
});

test('the new stylesheet is entirely tokens and system colours: no raw hex at all', async () => {
  assert.equal(countRawHex(await readFile('ui/appearance-themes.css', 'utf8')), 0);
});

test('radius and font-size literals that equal a token are written as the token in style.css, views.css and components.css', async () => {
  const offenders = [];
  for (const name of ['ui/style.css', 'ui/views.css', 'ui/components/components.css']) {
    const found = literalsEqualToTokens(await readFile(name, 'utf8'));
    if (found.length) offenders.push(`${name}: ${found.length} (${[...new Set(found)].join('; ')})`);
  }
  assert.deepEqual(offenders, []);
});

test('the blue-violet fallback colour is gone from the document preview, and the learning panel needs no accent fallback (its dialog carries the tokens)', async () => {
  const source = await readFile('ui/document-preview/document-preview.css', 'utf8');
  assert.doesNotMatch(source, /#7284ef/i);
  assert.doesNotMatch(source, /var\(--accent\s*,/);
});
