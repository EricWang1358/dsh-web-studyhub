/* The font registry (#64): ONE list of typefaces that the interface (设置 › 界面) and the reader (Aa) share, a strict gate for the
   "my installed font" name, and the stylesheet wiring. The real rendering is checked in the browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { FONT_PRESETS, FONT_IDS, TITLE_MODES, FONT_NAME_MAX, READER_FACES, cleanFontName, customFontStack } from '../ui/font-presets.js';
import { FONTS, APPEARANCE_DEFAULTS, APPEARANCE_OPTIONS, normalizeAppearance, appearanceAttrs, appearanceStyle, importAppearance, exportAppearance } from '../ui/appearance-prefs.js';
import { FACES, normalizeReaderSettings, readerVars, readingVars, READER_DEFAULTS } from '../ui/reading-settings/settings.js';

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const dark = { light: false, reducedMotion: false };

test('the registry: system, serif (宋体), kai (楷体), round (圆体) and mono, each with a zh label and a stack that is a CSS variable', () => {
  assert.deepEqual(FONT_IDS, ['system', 'serif', 'kai', 'round', 'mono']);
  for (const id of FONT_IDS) {
    const { label, stack } = FONT_PRESETS[id];
    assert.ok(label && /[㐀-鿿]/.test(label), `${id}: a zh label`);
    assert.equal(stack, `var(--font-stack-${id})`, `${id}: the stack is a reference to the one definition`);
  }
  assert.ok(Object.isFrozen(FONT_PRESETS));
  assert.deepEqual(TITLE_MODES, ['follow', 'system']);
});

test('the interface list is the registry plus the typed name; old stored values keep loading', () => {
  assert.deepEqual([...FONTS], [...FONT_IDS, 'custom']);
  assert.equal(APPEARANCE_OPTIONS.font, FONTS);
  for (const old of ['system', 'serif', 'mono']) assert.equal(normalizeAppearance({ font: old }).font, old);
  for (const added of ['kai', 'round', 'custom']) assert.equal(normalizeAppearance({ font: added }).font, added);
  assert.equal(normalizeAppearance({ font: 'comic' }).font, 'system');
  assert.deepEqual({ fontTitle: APPEARANCE_DEFAULTS.fontTitle, fontCustom: APPEARANCE_DEFAULTS.fontCustom }, { fontTitle: 'follow', fontCustom: '' });
  assert.equal(normalizeAppearance({ fontTitle: 'system' }).fontTitle, 'system');
  assert.equal(normalizeAppearance({ fontTitle: 'wild' }).fontTitle, 'follow');
});

test('a typed font name: letters, digits, spaces, CJK and hyphens only, capped; everything else is rejected, never repaired', () => {
  for (const ok of ['LXGW WenKai', 'Source Han Serif SC', '霞鹜文楷', 'MiSans-Medium', 'Noto Sans SC 3', 'Fira Code', 'Ｍｉｎｃｈｏ'])
    assert.equal(cleanFontName(ok), ok, ok);
  assert.equal(cleanFontName('  LXGW   WenKai  '), 'LXGW WenKai', 'edge and repeated spaces are tidied');
  const hostile = ['x;} body{display:none', 'a"b', "a'b", 'a\\b', 'a;b', 'a}b', 'a{b', 'url(http://x)', '</style><script>', 'Arial, serif', 'a/*c*/b', 'a:b', 'a\nb', 'a\u0000b', 'a@import', '-->', 'a<b', '😀', 'a​b', '--x', ''];
  for (const bad of hostile) assert.equal(cleanFontName(bad), '', JSON.stringify(bad));
  for (const notText of [null, undefined, 7, {}, [], true]) assert.equal(cleanFontName(notText), '');
  assert.equal(cleanFontName('a'.repeat(FONT_NAME_MAX)), 'a'.repeat(FONT_NAME_MAX));
  assert.equal(cleanFontName('a'.repeat(FONT_NAME_MAX + 1)), '', 'too long is rejected, not cut');
  assert.equal(cleanFontName('-leading'), '', 'must start with a letter or digit');
});

test('the custom stack is the quoted name plus the system fallback, nothing else, and empty for no name', () => {
  assert.equal(customFontStack('LXGW WenKai'), '"LXGW WenKai", var(--font-stack-system)');
  assert.equal(customFontStack('x;} body{display:none'), '');
  assert.equal(customFontStack(''), '');
  assert.equal(customFontStack(undefined), '');
});

test('appearance: the stored name goes through the gate; it only reaches the DOM when the typeface is custom', () => {
  assert.equal(normalizeAppearance({ fontCustom: 'x;} body{display:none' }).fontCustom, '');
  assert.equal(normalizeAppearance({ fontCustom: ' LXGW WenKai ' }).fontCustom, 'LXGW WenKai');
  assert.equal(normalizeAppearance({ fontCustom: 12 }).fontCustom, '');
  const custom = { font: 'custom', fontCustom: 'LXGW WenKai' };
  assert.equal(appearanceAttrs(custom, dark)['data-ui-font'], 'custom');
  assert.deepEqual(appearanceStyle(custom), { '--font-custom': '"LXGW WenKai", var(--font-stack-system)' });
  assert.deepEqual(appearanceStyle({ font: 'serif', fontCustom: 'LXGW WenKai' }), {}, 'a preset ignores the typed name');
  assert.equal(appearanceAttrs({ font: 'custom', fontCustom: '' }, dark)['data-ui-font'], 'system', 'custom with no valid name is the system typeface');
  assert.deepEqual(appearanceStyle({ font: 'custom', fontCustom: 'a;b' }), {});
  assert.equal(appearanceAttrs({ fontTitle: 'system' }, dark)['data-ui-title'], 'system');
  assert.equal(appearanceAttrs({}, dark)['data-ui-title'], 'follow');
  assert.equal(appearanceAttrs({ font: 'kai' }, dark)['data-ui-font'], 'kai');
});

test('an imported look is gated the same way', () => {
  const text = JSON.stringify({ studyhubAppearance: 1, font: 'custom', fontCustom: 'x;} body{display:none', fontTitle: 'follow' });
  assert.deepEqual(importAppearance(text).fontCustom, '');
  const round = importAppearance(exportAppearance({ font: 'custom', fontCustom: '霞鹜文楷', fontTitle: 'system' }));
  assert.equal(round.fontCustom, '霞鹜文楷');
  assert.equal(round.fontTitle, 'system');
});

test('the reader faces are the registry (the system one stays `sans`, following the interface) and stay whitelisted', () => {
  assert.deepEqual(FACES, ['sans', 'serif', 'kai', 'round', 'mono']);
  assert.deepEqual(READER_FACES, FACES);
  for (const face of ['serif', 'kai', 'round', 'mono', 'sans']) assert.equal(normalizeReaderSettings({ face }).face, face);
  for (const bad of ['comic', 'system', 'custom', '', null, 'x;}']) assert.equal(normalizeReaderSettings({ face: bad }).face, 'sans');
});

test('reader weight, leading and paragraph gap are three light steps that only write CSS variables, and only when not standard', () => {
  assert.deepEqual(readerVars(READER_DEFAULTS), { '--reader-size': '16px', '--reader-measure': '44em', '--reader-leading': '1.8' }, 'the defaults add nothing');
  assert.deepEqual({ weight: READER_DEFAULTS.weight, leading: READER_DEFAULTS.leading, gap: READER_DEFAULTS.gap }, { weight: 'normal', leading: 'standard', gap: 'standard' });
  const bold = readerVars({ weight: 'bold', leading: 'loose', gap: 'tight' });
  assert.equal(bold['--reader-weight'], '600');
  assert.equal(bold['--reader-leading'], '2');
  assert.equal(bold['--reader-gap'], '0.45em');
  assert.equal(readerVars({ weight: 'medium' })['--reader-weight'], '500');
  assert.equal(readerVars({ leading: 'tight' })['--reader-leading'], '1.65');
  assert.equal(readerVars({ size: 20, leading: 'loose' })['--reader-leading'], '1.9');
  assert.equal(readerVars({ gap: 'loose' })['--reader-gap'], '1.5em');
  assert.equal(readingVars({ leading: 'loose' })['--reading-leading'], '1.85');
  assert.equal(readingVars({ leading: 'tight' })['--reading-leading'], '1.5');
  for (const key of ['weight', 'leading', 'gap']) for (const bad of ['heavy', '', null, 7, 'x;}', '600'])
    assert.equal(normalizeReaderSettings({ [key]: bad })[key], READER_DEFAULTS[key], `${key}: ${JSON.stringify(bad)}`);
  const noise = readerVars({ weight: 'bold;} body{display:none', gap: '9em', leading: 'url(x)' });
  assert.deepEqual(noise, readerVars(READER_DEFAULTS), 'dirty values are the defaults, never a CSS value');
  for (const value of Object.values(bold)) assert.match(value, /^[0-9.]+(px|em)?$/, 'only numbers and units reach the style');
});

test('the old stored reader settings (no weight, leading or gap) still load as the defaults for those', () => {
  const old = normalizeReaderSettings({ size: 18, width: 'wide', face: 'serif', tone: 'paper', underline: 'hide', outline: false, tools: true });
  assert.deepEqual({ weight: old.weight, leading: old.leading, gap: old.gap }, { weight: 'normal', leading: 'standard', gap: 'standard' });
  assert.equal(old.face, 'serif');
});

test('one definition of each stack: the stylesheet defines every --font-stack-* once and reader.css / reading.css only refer to them', () => {
  const style = read('ui/style.css'), reader = read('ui/document-preview/reader/reader.css'), reading = read('ui/reading-settings/reading.css');
  for (const id of FONT_IDS) {
    const definitions = style.match(new RegExp(`^\\s*--font-stack-${id}:`, 'gm')) || [];
    assert.equal(definitions.length, 1, `--font-stack-${id} is defined exactly once`);
    for (const [name, css] of [['reader.css', reader], ['reading.css', reading]]) assert.doesNotMatch(css, new RegExp(`^\\s*--font-stack-${id}:`, 'm'), name);
  }
  for (const needle of ['Source Serif 4', 'Songti SC', 'Cascadia Mono']) {
    const total = [style, reader, reading].reduce((n, css) => n + css.split(needle).length - 1, 0);
    assert.equal(total, 1, `${needle} appears once across the three stylesheets`);
  }
  assert.match(style, /--font-stack-kai:[^;]*"?KaiTi"?[^;]*"?(?:Kaiti SC|STKaiti)"?[^;]*;/);
  assert.match(style, /--font-stack-round:[^;]*Yuanti SC[^;]*HarmonyOS Sans SC[^;]*MiSans[^;]*sans-serif;/);
  assert.doesNotMatch(reader, /--reader-serif|--reader-mono:\s*ui-monospace/);
});

test('the interface typeface sets the body AND the headings; 保持系统 puts the headings back; every preset has its rule', () => {
  const style = read('ui/style.css');
  for (const id of ['serif', 'kai', 'round', 'mono']) {
    const rule = style.match(new RegExp(`\\.study-app\\[data-ui-font='${id}'\\][^{]*\\{([^}]*)\\}`));
    assert.ok(rule, `${id}: a rule`);
    assert.match(rule[1], /--font-ui:\s*var\(--font-stack-/, `${id}: body`);
    assert.match(rule[1], /--font-display:\s*var\(--font-stack-/, `${id}: headings follow`);
    assert.match(style, new RegExp(`\\.study-seat:has\\(> \\.study-app\\[data-ui-font='${id}'\\]\\)`), `${id}: dialogs in the seat too`);
  }
  assert.match(style, /\.study-app\[data-ui-font='custom'\][^{]*\{[^}]*--font-ui:\s*var\(--font-custom/);
  assert.match(style, /\.study-app\[data-ui-title='system'\][^{]*\{[^}]*--font-display:\s*var\(--font-stack-system-display\)/);
  const title = style.indexOf("[data-ui-title='system']"), last = style.lastIndexOf("[data-ui-font='mono']");
  assert.ok(title > last, 'the 保持系统 rule comes after the preset rules so it wins at equal specificity');
  assert.doesNotMatch(style, /--font-ui:\s*"Inter"/, 'the default is defined through the system stack, not copied');
  for (const face of ['kai', 'round', 'mono', 'serif']) assert.match(style, new RegExp(`\\[data-face='${face}'\\][^{]*\\{[^}]*--reader-face:\\s*var\\(--font-stack-${face}\\)`), `reader face ${face}`);
});

test('the paragraph gap is read by the reader and the reading blocks, with today\'s spacing as the fallback', () => {
  assert.match(read('ui/document-preview/reader/reader.css'), /\.reader-p\s*\{[^}]*margin:\s*0 0 var\(--reader-gap,\s*1em\)/);
  assert.match(read('ui/reading-settings/reading.css'), /\.md p[^{]*\{[^}]*margin-bottom:\s*var\(--reader-gap,\s*0\.7em\)/);
});

test('no font file is bundled and the labels exist in English', () => {
  const files = readdirSync(new URL('../ui', import.meta.url), { recursive: true });
  assert.deepEqual(files.filter(name => /\.(woff2?|ttf|otf|eot)$/i.test(String(name))), [], 'a typeface is a system stack or an installed name, never a file');
  const english = Object.assign({}, ...readdirSync(new URL('../ui/locales', import.meta.url)).filter(name => /^en(\..+)?\.json$/.test(name)).map(name => JSON.parse(read(`ui/locales/${name}`))));
  for (const zh of [...FONT_IDS.map(id => FONT_PRESETS[id].label), '本机字体', '标题字体', '跟随正文', '保持系统', '字重', '行距', '段间距', '紧凑', '宽松', '稍粗', '加粗', '跟随界面', '排版微调'])
    assert.ok(english[zh] && !/[㐀-鿿]/.test(english[zh]), `${zh} has an English text`);
});
