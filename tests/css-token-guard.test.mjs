/* #66 token coverage, in three small guards that only ever tighten.

   1. Raw hex colours. ui/DESIGN.md: "new CSS references tokens, never raw colours". The colours that exist today are allowed per file (HEX_BASELINE
      below); a NEW raw hex in a file that has none, or more of them than its baseline, fails. Colours inside a custom-property declaration
      (`--name: #hex;`, the token blocks) are tokens by definition and are not counted. When you remove raw colours the test also fails until you
      lower the number, so the baseline only goes down. To update it: run `node --test tests/css-token-guard.test.mjs`, the failure message prints the
      file and its real count; put that number in the table (delete the line at 0).
   2. Literals that equal a token. A `border-radius` of 8px / 12px / 16px and a `font-size` of 12 / 13 / 17 / 19 / 23 / 28px mean --radius-sm, --radius, --radius-card and
      --fs-xs ... --fs-3xl, so in the three high-traffic stylesheets they are written as the token (the corner style and a future
      type scale then reach them). Other pixel values are left alone: a bespoke size is not a token. (Not migrated on purpose: 15px, the base reading size, ~170 uses, and 999px pills, which no setting scales; it would only add bytes now.)
   3. Dead colour tokens. A colour token declared in ui/tokens.css that nothing reads is a value nobody can see: the --bg-glass pair and --glass-sheen came with a blur
      the product never painted (ui/DESIGN.md: no glass). Guards 1 and 2 read the 16 global sheets of tests/helpers/global-css.mjs, so this one walks every stylesheet
      under ui/ itself, plus the .js/.jsx sources, because an inline style names a token from JS too (style={{ stroke: 'var(--accent-soft)' }}); the appearance store
      writes --font-custom and the science settings write three more, none of them colours, so the colour set never needs a whitelist for them. PALETTE_ONLY is the
      short list of colour tokens ui/DESIGN.md still promises while no rule paints them yet. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { GLOBAL_CSS_FILES } from './helpers/global-css.mjs';

const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '');

/** Raw hex colours (#rgb, #rgba, #rrggbb, #rrggbbaa) outside custom-property declarations. `#000` inside a mask-image gradient is the mask's opaque
    stop rather than a colour a surface is painted with, and a token cannot be read there (the same exception the #156 raw-colour rule makes), so a fade
    written as a mask is not a raw colour. */
function countRawHex(source) {
  let count = 0;
  for (const declaration of stripComments(source).split(/[;{}]/)) {
    if (/^\s*--[\w-]+\s*:/.test(declaration)) continue;
    const text = /^\s*(-webkit-)?mask(-image)?\s*:/.test(declaration) ? declaration.replace(/#000(000)?\b/g, '') : declaration;
    count += (text.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length;
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

const COLOUR_VALUE = /^(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(|hwb\(|lab\(|lch\(|oklab\(|oklch\(|color\(|color-mix\(|light-dark\(|transparent$|currentcolor$)/i;

/** The `--name: value` pairs a stylesheet declares, comments dropped. */
function declarations(source) {
  return [...stripComments(source).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;{}]+)/gi)].map((match) => ({ name: match[1], value: match[2].trim() }));
}

/** The colour tokens a token block declares: a colour literal or function, or an alias of one (--warn-text: var(--warn-ink)). */
function colourTokens(source) {
  const own = declarations(source);
  const colours = new Set(own.filter((token) => COLOUR_VALUE.test(token.value)).map((token) => token.name));
  for (let pass = 0; pass < 3; pass++)
    for (const token of own) {
      const alias = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(token.value);
      if (alias && colours.has(alias[1])) colours.add(token.name);
    }
  return colours;
}

/** Every token a source reads through var(--name) / var(--name, fallback). */
function readTokens(source) {
  return new Set([...source.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((match) => match[1]));
}
/** Files (relative to ui/) that still hold raw hex colours, and how many. Only lower these. */
// Empty: once mask stops stopped counting, no stylesheet paints a colour of its own. A file that needs one gets a number here (never lower than its real count).
const HEX_BASELINE = {};

/* Colour tokens ui/DESIGN.md still promises as a palette while no rule paints them yet. The reason names what the doc says the token is for; the test also fails
   when one of these is no longer declared in ui/tokens.css, so the list cannot rot. A token that stops being promised goes with its line. */
const PALETTE_ONLY = {
  '--scrim-strong': 'page dimming behind a full-surface dialog (DESIGN.md, semantic tokens), when the 60% --scrim is too light; both themes define it',
  '--warn-halo': 'a strength of the ochre tone (DESIGN.md: the halo/mid/mark/tint/solid family, "and the same for warn, bad, info"): a ring or glow',
  '--bad-mid': 'a strength of the berry tone (the same family): a stroke or tick',
  '--info-halo': 'a strength of the blue tone (the same family): a ring or glow',
  '--info-mid': 'a strength of the blue tone (the same family): a stroke or tick',
};
test('the counters understand the shapes they guard (fixtures)', () => {
  assert.equal(countRawHex('a { color: #fff; background: #a1b2c3; border: 1px solid #12345678; }'), 3);
  assert.equal(countRawHex('.x {\n  --accent: #c93d22;\n  --bg: #161412;\n}'), 0, 'a token definition is the token block');
  assert.equal(countRawHex('/* #ff0000 in a comment */\n.x { color: var(--text, #8885); }'), 1, 'a fallback is a raw colour');
  assert.equal(countRawHex('a { href: url(#anchor); content: "#"; }'), 0, '#anchor is not a colour here');
  assert.equal(countRawHex('.a { mask-image: linear-gradient(#000, transparent); color: #111; }'), 1, 'a mask\'s #000 is not a colour, a painted #111 is');
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

test('radius and font-size literals that equal a token are written as the token in the global sheets, views.css and components.css', async () => {
  const offenders = [];
  for (const name of [...GLOBAL_CSS_FILES, 'ui/views.css', 'ui/components/components.css']) {
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

test('the dead-token counters read colour values, aliases and var() references (fixtures)', () => {
  assert.deepEqual([...colourTokens('.a { --bg: #161412; --alias: var(--bg); --shadow: inset 0 0 0 1px #00000026; --space: 4px; }')], ['--bg', '--alias']);
  assert.deepEqual([...readTokens('.a { color: var(--text); border: 1px solid var(--line, #fff); }')], ['--text', '--line']);
});

test('every colour token ui/tokens.css declares is read somewhere in ui/, and an appearance override only re-themes a token that exists', async () => {
  const files = (await readdir('ui', { recursive: true })).map((name) => name.replace(/\\/g, '/'))
    .filter((name) => /\.(css|jsx?)$/.test(name)).sort();
  const reads = new Set();
  for (const name of files) for (const token of readTokens(await readFile('ui/' + name, 'utf8'))) reads.add(token);
  const source = await readFile('ui/tokens.css', 'utf8');
  const declared = new Set(declarations(source).map((token) => token.name));
  const dead = [...colourTokens(source)].filter((name) => !reads.has(name) && !(name in PALETTE_ONLY)).sort();
  assert.deepEqual(dead, [], 'a colour token nothing reads is a value nobody can see: delete it and every override of it, or paint something with it');
  for (const name of Object.keys(PALETTE_ONLY))
    assert.ok(declared.has(name), name + ' is kept for the palette but ui/tokens.css no longer declares it: remove the line');
  // An appearance sheet may only re-theme a token that exists, so deleting one cannot leave its override behind. ui/paper.css is not here: it declares the
  // card's own padding and radius vocabulary, which ui/tokens.css does not define.
  const orphans = [];
  for (const file of ['ui/accent.css', 'ui/appearance-themes.css'])
    for (const token of declarations(await readFile(file, 'utf8'))) if (!declared.has(token.name)) orphans.push(file + ': ' + token.name);
  assert.deepEqual(orphans, []);
});
