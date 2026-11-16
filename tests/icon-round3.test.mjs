import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { uiSources } from './helpers/icon-stand-ins.mjs';
import { buttonElements, goOnProblems, iconTags } from './helpers/go-on.mjs';
import { loadUi } from './helpers/ui-module.mjs';

/* #1073 / #1074, round 3 of the review of PR #1115: the rules ui/DESIGN.md (Icons) writes, found by scanning ui/ instead of by a hand list. Each test names the defect of the review it pins. */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const ruleOf = (css, selector) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, head]) => head.split(',').some((part) => part.trim() === selector)).map(([, , body]) => body);
const nameOf = (tag) => tag.match(/name=(?:"([^"]+)"|\{([^}]+)\})/)?.slice(1).find(Boolean) ?? '';
const sizeOf = (tag) => Number(tag.match(/\ssize=\{(\d+)\}/)?.[1] ?? 0);

const m = await loadUi(`
  export { AddSourceButton } from './ui/components/AddSourceButton.jsx';
  export { default as AnswerState } from './ui/review/AnswerState.jsx';
  export { Icon } from './ui/components/index.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const h = React.createElement;

/* ---- 3: "go on" actions, by rule ------------------------------------------------------------------------------------------------------------------------------- */

/** A Button that starts with a go-on verb and has no arrow, and why that is right. Everything else must end in `arrow-right`. */
const GO_ON_EXCEPTIONS = [
  { file: 'ui/LiveClass.jsx', label: '开始实录', why: 'a capture control: it starts the recording on this page' },
  { file: 'ui/LiveClass.jsx', label: '接着录', why: 'a capture control: it resumes the recording on this page' },
  { file: 'ui/LiveClass.jsx', label: '继续', why: 'the pause / resume toggle of a capture' },
  { file: 'ui/tasks/TaskConsole.jsx', label: '继续', why: 'a job control (resume a paused job): it stays on the card' },
  { file: 'ui/tasks/TaskConsole.jsx', label: '继续安装', why: 'the installer step of a job card: a state change on the card' },
  { file: 'ui/UsageSettings.jsx', label: '继续记录', why: 'a switch of the settings page, not a way on' },
  { file: 'ui/ExplanationFollowup.jsx', label: '继续追问', why: 'sends the follow-up question that is typed in the box above it' },
  { file: 'ui/Ingest.jsx', label: '开始录题并发给主会话', why: 'the submit of the paste form: it hands the text over, it does not go to another place' },
  { file: 'ui/companions/CompanionBuildDialog.jsx', label: '开始生成 HTML 伴学课', why: 'the confirm of a dialog that starts a background build' },
  { file: 'ui/document-preview/translation/TranslationMenu.jsx', label: '开始翻译', why: 'the confirm of a menu panel that starts a background translation' },
  { file: 'ui/document-preview/reader/OutlineAssist.jsx', label: '开始', why: 'the confirm of the outline assistant form: it starts a background task' },
];

test('3: every "go on" Button (a label that starts with 去 / 练 / 继续 / 开始 / 接着) ends in arrow-right, unless it is a listed exception with its reason', async () => {
  const exceptions = new Set(GO_ON_EXCEPTIONS.map((entry) => `${entry.file}::${entry.label}`));
  const used = new Set(), found = [];
  for (const { file, source } of await uiSources()) {
    for (const { label, open } of goOnProblems(source)) {
      const key = `${file}::${label}`;
      if (exceptions.has(key)) used.add(key); else found.push(`${file}: ${label}  ${open.slice(0, 80)}`);
    }
  }
  assert.deepEqual(found, [], 'a go-on action ends in iconEnd="arrow-right" (ui/DESIGN.md); a control that goes nowhere is listed in GO_ON_EXCEPTIONS with why');
  const stale = [...exceptions].filter((key) => !used.has(key));
  assert.deepEqual(stale, [], 'an exception that no Button needs any more is deleted, so the list only shrinks');
  for (const { why } of GO_ON_EXCEPTIONS) assert.ok(why.length > 12);
});

/** The play icon that stays: it runs a clock or an installer on the page, it does not go on to practise. */
const PLAY_OK = ['ui/board/TodayTimer.jsx', 'ui/MineruInstallCard.jsx'];

test('3: no go-on Button leads with a play icon: "go practise" has one look, the arrow after the words', async () => {
  const found = [];
  for (const { file, source } of await uiSources()) {
    for (const { open, children } of buttonElements(source)) {
      if (PLAY_OK.includes(file)) continue;
      if (/\sicon=(?:"play"|\{["']play["']\})/.test(open) && /ui\((["'])(?:去|练|继续|开始|接着)/.test(children)) found.push(`${file}: ${open.slice(0, 80)}`);
    }
  }
  assert.deepEqual(found, []);
});

test('3: the go-on rule sees what it should and leaves the rest alone', () => {
  assert.equal(goOnProblems('<Button variant="quiet" onClick={() => go(1)}>{ui("去练")}</Button>').length, 1);
  assert.equal(goOnProblems('<Button iconEnd="arrow-right" onClick={() => go(1)}>{ui("去练")}</Button>').length, 0);
  assert.equal(goOnProblems('<Button icon="sparkle">{ui("开始生成")}</Button>').length, 0);
  assert.equal(goOnProblems('<Button onClick={() => x()}>{ui("删除")}</Button>').length, 0);
  assert.equal(goOnProblems('<Button size="sm">{done ? ui("继续") : ui("开始")}</Button>').length, 2);
});

/* ---- 2: icons beside text -------------------------------------------------------------------------------------------------------------------------------------- */

/** Icons that keep an explicit size 12 - 16 or a stroke weight, and why. Anything else beside text takes `sh-icon--inline` and nothing more. */
const INDICATOR_NAMES = new Set(['caret', 'chevron', 'chevron-down', 'chevron-left', 'search', 'help', 'play']); // a disclosure mark, a field's own glyph, a help trigger or the ▶ of a play slot: it has a slot of its own, not a line of text
const SIZE_ALLOWED = [
  { file: 'ui/IndexBadge.jsx', size: 12, why: 'inside the small index pill, whose text is 12px' },
  { file: 'ui/board/CardEditor.jsx', size: 12, why: 'the × of a label chip, inside its own button' },
  { file: 'ui/board/Card.jsx', size: 14, why: 'the tick of a checklist box (it keeps its stroke too)' },
  { file: 'ui/board/CardEditor.jsx', size: 14, why: 'the tick of a checklist box (it keeps its stroke too)' },
];
const STROKE_ALLOWED = [
  { file: 'ui/board/Card.jsx', why: 'the tick of a checklist box: a mark in a box, not a line of text' },
  { file: 'ui/board/CardEditor.jsx', why: 'the tick of a checklist box: a mark in a box, not a line of text' },
];

test('2: an <Icon> beside text is an inline icon (no size, no stroke weight); only indicators, button-owned icons, listed ones and the registry components keep their own', async () => {
  const found = [];
  let explicit = 0;
  for (const { file, source } of await uiSources()) {
    if (file.startsWith('ui/components/')) continue;
    for (const { tag, prop } of iconTags(source)) {
      const size = sizeOf(tag), name = nameOf(tag);
      if (/\sstrokeWidth=/.test(tag) && !STROKE_ALLOWED.some((entry) => entry.file === file)) found.push(`${file}: stroke weight on ${tag.slice(0, 70)}`);
      if (/sh-icon--inline/.test(tag)) { if (size) found.push(`${file}: inline icon with a size ${tag.slice(0, 70)}`); continue; }
      if (prop || !size) continue;
      if ([12, 13, 14, 15, 16].includes(size)) {
        explicit++;
        if (!INDICATOR_NAMES.has(name) && !SIZE_ALLOWED.some((entry) => entry.file === file && entry.size === size)) found.push(`${file}: ${size}px beside text ${tag.slice(0, 70)}`);
      }
    }
  }
  assert.deepEqual(found, [], 'use className="sh-icon--inline" and no size (ui/base.css --icon-inline), or list the icon with why');
  assert.ok(explicit < 30, `the remaining explicit 12 - 16px icons are indicators (${explicit})`);
});

test('2: the icon guard catches what the review found: 12 / 13 / 16px and a heavy tick beside text, and lets an inline icon and a button icon through', () => {
  const tags = (source) => iconTags(source).map(({ tag, prop }) => ({ size: sizeOf(tag), stroke: /\sstrokeWidth=/.test(tag), inline: /sh-icon--inline/.test(tag), prop }));
  assert.deepEqual(tags('<Icon name="check" size={12} strokeWidth={2.2} />'), [{ size: 12, stroke: true, inline: false, prop: false }]);
  assert.deepEqual(tags('<Icon name="success" size={16} />'), [{ size: 16, stroke: false, inline: false, prop: false }]);
  assert.deepEqual(tags('<Button icon={<Icon name="edit" size={14} />}>x</Button>'), [{ size: 14, stroke: false, inline: false, prop: true }]);
  assert.deepEqual(tags('<Icon name="check" className="sh-icon--inline" />'), [{ size: 0, stroke: false, inline: true, prop: false }]);
});

test('2/9: the one weight exception is the answer mark, written as `weight="regular"` (a state icon beside a medium label), never as a strokeWidth', async () => {
  const [icon, answer, design] = await Promise.all([read('ui/components/Icon.jsx'), read('ui/review/AnswerState.jsx'), read('ui/DESIGN.md')]);
  assert.match(icon, /weight/);
  assert.match(answer, /weight="regular"/);
  assert.doesNotMatch(answer, /strokeWidth/);
  assert.match(design, /weight="regular"/);
  const users = [];
  for (const { file, source } of await uiSources()) if (/<Icon\b[^>]*\sweight=/.test(source)) users.push(file);
  assert.deepEqual(users, ['ui/review/AnswerState.jsx'], 'only a state icon beside its label is Regular');
  const light = renderToStaticMarkup(h(m.Icon, { name: 'check' })), regular = renderToStaticMarkup(h(m.Icon, { name: 'check', weight: 'regular' }));
  assert.doesNotMatch(light, /stroke-width/);
  assert.match(regular, /stroke-width/);
});

test('9: the answer mark and its label share a centre line', async () => {
  const css = await read('ui/review/question.css');
  const rule = ruleOf(css, '.answer-state').join(' ');
  assert.match(rule, /align-items:\s*center/);
  assert.match(ruleOf(css, '.answer-state__mark').join(' '), /margin-block|margin-top|transform|translate/, 'the icon is nudged onto the centre of the glyphs, not of the line box');
  const html = renderToStaticMarkup(h(m.AnswerState, { correct: true, picked: true }));
  assert.match(html, /sh-icon--inline/);
});

/* ---- 5: 再添加资料 / 再加一份 ----------------------------------------------------------------------------------------------------------------------------------- */

test('5 (#1074): "add another material" is one control, AddSourceButton with `more`, with the upload icon and one wording; no screen draws it by hand', async () => {
  const html = renderToStaticMarkup(h(m.AddSourceButton, { more: true, variant: 'link' }));
  assert.match(html, /再添加资料/);
  assert.match(html, /<svg/);
  m.setUiLanguage('en');
  try { assert.match(renderToStaticMarkup(h(m.AddSourceButton, { more: true, variant: 'link' })), /Add more sources/); } finally { m.setUiLanguage('zh'); }
  assert.match(await read('ui/first-run/FirstRunLine.jsx'), /<AddSourceButton more /);
  assert.match(await read('ui/study-map/home-plan.js'), /addSourceAction\(addSource, \{ more: true \}\)/);
});

/* ---- 8: the name of the thumbs-down action, in English --------------------------------------------------------------------------------------------------------- */

test('8: the thumbs-down action has one English name everywhere: "Question needs work"', async () => {
  const dir = new URL('../ui/locales/', import.meta.url);
  const wrong = [], off = [];
  for (const name of (await readdir(dir)).filter((entry) => /^en(?:\..+)?\.json$/.test(entry))) {
    for (const [key, value] of Object.entries(JSON.parse(await readFile(new URL(name, dir), 'utf8')))) {
      if (/Something is wrong (?:with it|with this question|…)/.test(String(value))) wrong.push(`${name}: ${key.slice(0, 40)} = ${String(value).slice(0, 60)}`);
      if (key.includes('这题有问题') && key !== '这题有问题，交给后台修' && !/Question needs work/.test(String(value))) off.push(`${name}: ${key.slice(0, 40)} = ${String(value).slice(0, 60)}`);
    }
  }
  assert.deepEqual(wrong, []);
  assert.deepEqual(off, [], 'every entry about 这题有问题 names it "Question needs work"');
});

/* ---- 10: the dark filled circle -------------------------------------------------------------------------------------------------------------------------------- */

const luminance = (rgb) => { const [r, g, b] = rgb.map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const rgb = (hex) => hex.replace('#', '').match(/../g).slice(0, 3).map((part) => parseInt(part, 16));

test('10: the digit or letter in a filled green circle is text, so it reads at 4.5:1 on the paper in both themes (the fill is darkened, the mark stays the paper colour)', async () => {
  const [question, tokens, paper] = await Promise.all([read('ui/review/question.css'), read('ui/tokens.css'), read('ui/paper.css')]);
  assert.match(ruleOf(question, '.option.correct .option-letter').join(' '), /background:\s*var\(--ok-fill,/);
  const mix = paper.match(/--ok-fill:\s*color-mix\(in srgb,\s*var\(--ok\)\s*(\d+)%,\s*black\)/);
  assert.ok(mix, 'paper.css defines --ok-fill as the paper green mixed with black');
  const green = rgb(paper.match(/--ok:\s*(#[0-9a-f]{6})/i)[1]);
  const fill = green.map((channel) => channel * Number(mix[1]) / 100);
  const papers = [...tokens.matchAll(/--paper:\s*(#[0-9a-f]{6})/gi)].map((match) => rgb(match[1]));
  assert.equal(papers.length, 2);
  for (const sheet of papers) assert.ok(contrast(sheet, fill) >= 4.5, `the mark on the green circle: ${contrast(sheet, fill).toFixed(2)}:1`);
});

/* ---- 6: the resume row's eyebrow -------------------------------------------------------------------------------------------------------------------------------- */

test('6: the eyebrow of a resume row never orphans a character: it breaks at words only, and the title goes under it when the row is narrow', async () => {
  const desk = await read('ui/study-map/desk.css');
  const eyebrow = ruleOf(desk, '.resume .resume__eyebrow').join(' ');
  assert.match(eyebrow, /word-break:\s*keep-all/);
  assert.match(ruleOf(desk, '.resume > span:first-child').join(' '), /flex-wrap:\s*wrap/);
});

/* ---- 1 and 7: the deck row's slot ------------------------------------------------------------------------------------------------------------------------------ */

test('1 / 7: the play slot of a deck row is as wide as its widest face (▶ or 继续 →), not a fixed width, and its arrow keeps the row-end gap', async () => {
  const [css, row] = await Promise.all([read('ui/study-map/catalog.css'), read('ui/study-map/DeckRow.jsx')]);
  for (const rule of ruleOf(css, '.map-play')) assert.doesNotMatch(rule, /(?:^|[\s;])(?:min-)?width:\s*\d+px/, 'no fixed pixel width on the slot');
  assert.doesNotMatch(css, /\.map-play\s*\{[^}]*width:\s*(?:56|72)px/);
  assert.match(ruleOf(css, '.map-play').join(' '), /display:\s*inline-grid/);
  assert.match(row, /map-play__ghost/);
  assert.doesNotMatch(row, /sh-icon--trail/, 'the arrow of 继续 uses .row-end\'s gap, like every row-end arrow');
});

test('4: DESIGN.md, lib/card-kinds.js and the code agree about the circle of a 判断题 option: its number, never an icon', async () => {
  const [design, kinds, label] = await Promise.all([read('ui/DESIGN.md'), read('lib/card-kinds.js'), read('ui/option-label.js')]);
  assert.match(label, /String\(index \+ 1\)/, 'the code shows the number');
  assert.doesNotMatch(design, /fixed option \(对 \/ 错\) shows its registry icon|`lib\/card-kinds\.js` `icon`/);
  assert.doesNotMatch(design, /shows its word, 对 \/ 错/);
  assert.doesNotMatch(kinds, /first character/);
  assert.match(kinds, /number/);
  assert.match(design, /判断题[^\n]*number|number[^\n]*判断题/);
});
