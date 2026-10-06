/* The bundled Inter (WP-2): one variable woff2 for digits and Latin letters, never Chinese, embedded once as a data: URI in a lazily
   loaded chunk, declared by one @font-face under a private family name. The real rendering is checked in the browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { basename } from 'node:path';
import { INTER_FAMILY, INTER_UNICODE_RANGE, INTER_STYLE_MARKER, interFaceCss, installInterFace } from '../ui/fonts/inter-face.js';

const FONT = 'ui/fonts/inter-latin-opsz-normal.woff2';
const BUDGET = 110 * 1024;
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** The code points of a CSS unicode-range value. */
function codePoints(range) {
  const set = new Set();
  for (const part of range.split(',').map(item => item.trim())) {
    const match = /^U\+([0-9A-F]{1,6})(?:-([0-9A-F]{1,6}))?$/i.exec(part);
    assert.ok(match, `a valid unicode-range item: ${part}`);
    const from = parseInt(match[1], 16), to = match[2] ? parseInt(match[2], 16) : from;
    for (let cp = from; cp <= to; cp++) set.add(cp);
  }
  return set;
}

test('the font file is one variable woff2 within the size budget, and its OFL licence travels with it', () => {
  const size = statSync(new URL(`../${FONT}`, import.meta.url)).size;
  assert.ok(size > 20 * 1024 && size <= BUDGET, `${FONT} is ${size} bytes; budget ${BUDGET}`);
  assert.equal(readFileSync(new URL(`../${FONT}`, import.meta.url)).subarray(0, 4).toString('latin1'), 'wOF2', 'a woff2 container');
  const licence = read('ui/fonts/OFL.txt');
  assert.match(licence, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(licence, /The Inter Project Authors/);
  const fonts = readdirSync(new URL('../ui/fonts', import.meta.url)).filter(name => /\.(woff2?|ttf|otf|eot)$/i.test(name));
  assert.deepEqual(fonts, [basename(FONT)], 'exactly one font file is bundled');
});

test('inter-data.js carries exactly the committed woff2 (regenerate with node ui/fonts/build-inter-data.mjs) and needs no bundler loader', () => {
  const source = readFileSync(new URL('../ui/fonts/inter-data.js', import.meta.url), 'utf8');
  const encoded = /export default 'data:font\/woff2;base64,([A-Za-z0-9+/=]+)';/.exec(source);
  assert.ok(encoded, 'a plain JS module with one data: URI');
  assert.ok(Buffer.from(encoded[1], 'base64').equals(readFileSync(new URL(`../${FONT}`, import.meta.url))), 'the module is the woff2, byte for byte');
  assert.doesNotMatch(source, /^import /m, 'no import of the font file, so esbuild needs no .woff2 loader (the tests bundle ui/ with their own options)');
});

test('the unicode-range covers digits, Latin letters and number punctuation and leaves every CJK block to the system fonts', () => {
  const covered = codePoints(INTER_UNICODE_RANGE);
  for (const ch of '0123456789ABCXYZabcxyz.,:;%+-=/()[]$#&@!?"\'_ <>') assert.ok(covered.has(ch.codePointAt(0)), `Basic Latin ${JSON.stringify(ch)}`);
  for (const cp of [0x00A0, 0x00B0, 0x00D7, 0x00E9, 0x2013, 0x2212, 0x20AC, 0x2022, 0x2009]) assert.ok(covered.has(cp), `U+${cp.toString(16)}: a Latin or number-related symbol`);
  const cjk = [[0x2E80, 0x2FDF], [0x3000, 0x303F], [0x3040, 0x30FF], [0x3100, 0x312F], [0x31C0, 0x31EF], [0x3200, 0x33FF], [0x3400, 0x4DBF], [0x4E00, 0x9FFF],
    [0xF900, 0xFAFF], [0xFE30, 0xFE4F], [0xFF00, 0xFFEF], [0x20000, 0x2FA1F]];
  for (const [from, to] of cjk) for (let cp = from; cp <= to; cp++) assert.ok(!covered.has(cp), `U+${cp.toString(16)} (CJK) must stay out of the range`);
  /* Punctuation that Chinese text sets full-width or centred in a CJK font: quotes, em dash, ellipsis, interpunct. */
  for (const cp of [0x00B7, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026]) assert.ok(!covered.has(cp), `U+${cp.toString(16)} stays with the CJK font`);
});

test('the @font-face is one variable face under a private name: swap, the wght range, woff2, the range above', () => {
  const css = interFaceCss('data:font/woff2;base64,AAAA');
  assert.equal(INTER_FAMILY, 'StudyHub Inter');
  assert.equal(css.split('@font-face').length - 1, 1);
  assert.match(css, /font-family:\s*"StudyHub Inter"/);
  assert.match(css, /font-display:\s*swap/);
  assert.match(css, /font-weight:\s*100 900/);
  assert.match(css, /src:\s*url\("data:font\/woff2;base64,AAAA"\)\s*format\("woff2"\)/);
  assert.ok(css.includes(`unicode-range: ${INTER_UNICODE_RANGE}`));
  assert.doesNotMatch(css, /U\+(?:4E00|3000|FF00)/i, 'no CJK start points');
});

test('the stacks put the private face first in the system stacks and nowhere else; the bare "Inter" is gone', () => {
  const tokens = read('ui/tokens.css');
  for (const id of ['system', 'system-display']) {
    const line = tokens.match(new RegExp(`^\\s*--font-stack-${id}:([^;]*);`, 'm'));
    assert.ok(line, id);
    assert.match(line[1].trim(), /^"StudyHub Inter", /, `${id} starts with the bundled face`);
    assert.doesNotMatch(line[1], /"Inter"|"Inter Display"/);
    assert.match(line[1], /"Microsoft YaHei"/, 'Chinese still falls through to the system fonts');
  }
  for (const id of ['serif', 'kai', 'round', 'mono']) assert.doesNotMatch(tokens.match(new RegExp(`^\\s*--font-stack-${id}:([^;]*);`, 'm'))[1], /StudyHub Inter/, `${id} keeps its own look`);
  const stylesheets = readdirSync(new URL('../ui', import.meta.url), { recursive: true }).filter(name => /\.css$/.test(String(name))).map(name => read(`ui/${name}`));
  assert.equal(stylesheets.filter(css => css.includes('StudyHub Inter')).length, 1, 'the family name is written in one stylesheet (tokens.css)');
  assert.ok(!stylesheets.some(css => css.includes('@font-face')), 'the @font-face is injected from the lazy chunk, never written in a stylesheet');
});

test('tabular numerals still work: the face carries tnum and the stylesheets ask for tabular-nums, not a feature string that would drop it', () => {
  const asked = readdirSync(new URL('../ui', import.meta.url), { recursive: true }).filter(name => /\.css$/.test(String(name))).map(name => read(`ui/${name}`));
  assert.ok(asked.some(css => /font-variant-numeric:\s*tabular-nums/.test(css)), 'tabular-nums is used');
  assert.ok(!asked.some(css => /font-feature-settings/.test(css)), 'no font-feature-settings overrides tabular-nums');
});

test('the installer is idempotent and never throws without a browser or with a half document', async () => {
  assert.doesNotThrow(() => installInterFace());
  assert.equal(await installInterFace(), undefined, 'nothing to do without a document');
  const added = [];
  const head = { querySelector: () => null, appendChild: node => added.push(node) };
  const doc = { head, createElement: () => ({ setAttribute(name) { this[name] = ''; }, remove() {} }) };
  const loaded = async () => 'data:font/woff2;base64,AAAA';
  await installInterFace({ document: doc, load: loaded });
  assert.equal(added.length, 1);
  assert.match(added[0].textContent, /@font-face/);
  const present = { textContent: interFaceCss('data:font/woff2;base64,AAAA') };
  const again = [];
  await installInterFace({ document: { head: { querySelector: selector => { assert.ok(selector.includes(INTER_STYLE_MARKER)); return present; }, appendChild: node => again.push(node) }, createElement: doc.createElement }, load: loaded });
  assert.equal(again.length, 0, 'a second call adds nothing');
  await assert.doesNotReject(installInterFace({ document: { head: {} }, load: loaded }), 'a document without querySelector');
  await assert.doesNotReject(installInterFace({ document: doc, load: async () => { throw new Error('chunk failed'); } }), 'a failed chunk leaves the system fonts');
});

test('built for the DSH host: one @font-face in all chunks, the data in its own lazy chunk, none of it in the entry', async () => {
  const { buildHostClient, buildPreview } = await import('../scripts/build.mjs');
  const host = await buildHostClient({ write: false });
  const files = host.outputFiles.map(file => ({ name: basename(file.path), text: file.text }));
  /* Other chunks mention @font-face too (pdf.js registers the fonts of the PDFs it draws; the editor lists CSS at-rules): only ours counts. */
  const ours = text => text.split('U+00B8-00FF').length - 1; // a token only our unicode-range has (the bundle folds the family name into a variable)
  assert.equal(files.reduce((n, file) => n + ours(file.text), 0), 1, 'the @font-face of StudyHub Inter appears once across every client chunk');
  const withData = files.filter(file => file.text.includes('data:font/woff2;base64,'));
  assert.equal(withData.filter(file => ours(file.text) === 1).length, 0, 'the rule (eager, tiny) and the bytes (lazy) are separate chunks');
  assert.equal(withData.length, 1, 'the font bytes are in exactly one chunk');
  assert.notEqual(withData[0].name, 'client.js', 'the entry chunk never carries the font');
  const output = Object.entries(host.metafile.outputs).find(([path]) => basename(path) === withData[0].name)[1];
  assert.deepEqual(Object.keys(output.inputs).filter(path => !/inter-data\.js$/.test(path)), [], 'that chunk holds the font and nothing else');
  const importers = Object.values(host.metafile.outputs).filter(record => record.imports.some(edge => basename(edge.path) === withData[0].name));
  assert.ok(importers.length >= 1 && importers.every(record => record.imports.filter(edge => basename(edge.path) === withData[0].name).every(edge => edge.kind === 'dynamic-import')), 'only ever reached by a dynamic import');
  const base64 = withData[0].text.match(/data:font\/woff2;base64,([A-Za-z0-9+/=]+)/)[1];
  assert.ok(base64.length * 0.75 <= BUDGET + 64, 'the embedded font stays within the budget');
  assert.equal(Buffer.from(base64, 'base64').subarray(0, 4).toString('latin1'), 'wOF2');

  const preview = await buildPreview({ write: false });
  const app = preview.outputFiles.filter(file => /\.(js|css)$/.test(file.path));
  assert.equal(app.reduce((n, file) => n + ours(file.text), 0), 1, 'the preview has the face once as well');
  assert.equal(app.reduce((n, file) => n + file.text.split('data:font/woff2;base64,').length - 1, 0), 1);
});
