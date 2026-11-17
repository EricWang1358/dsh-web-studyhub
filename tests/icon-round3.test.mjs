import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { uiSources } from './helpers/icon-stand-ins.mjs';
import { IN_PLACE, goOnProblems, iconTags, inPlaceWhy, labelHelpers, labelsOf, playLeads, propOf } from './helpers/go-on.mjs';
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

/* Round 4: the arrow is decided by what the control does, in one place (tests/helpers/go-on.mjs `inPlaceWhy`): a go-on action that takes the learner somewhere
   ends in arrow-right; one that acts where it stands (a job's 继续 / 接着做, a timer, a capture, a form's submit, a confirm that starts a background task) has
   none. The words are read however the Button gets them: ui(), uiFormat(), uiMessage() or a helper of ui/ that returns one (练 {0} 题 of the skeleton was missed). */
test('3 / 7: every "go on" Button (去 / 练 / 继续 / 开始 / 接着, however it gets its words) ends in arrow-right when it takes the learner somewhere, and has none when it acts in place', async () => {
  const sources = await uiSources();
  const helpers = labelHelpers(sources), used = new Set(), found = [];
  for (const { file, source } of sources) for (const { label, open, want } of goOnProblems(source, { file, helpers, used })) found.push(`${file}: ${label} wants ${want}  ${open.slice(0, 80)}`);
  assert.deepEqual(found, [], 'the arrow says where the control takes the learner (ui/DESIGN.md, Icons); a place where a go-on verb acts in place is listed in IN_PLACE with why');
  const stale = IN_PLACE.filter((entry) => !used.has(entry)).map((entry) => `${entry.file} ${entry.handler || ''}`);
  assert.deepEqual(stale, [], 'a listed place no Button needs any more is deleted, so the list only shrinks');
  for (const { why } of IN_PLACE) assert.ok(why.length > 12);
});

/** The play icon leads the words of a control only where it plays something in time: a clock, a sound, a slide lesson. Everything that goes on to practise
    ends in the arrow instead, and an installer or a job control has no icon. `handler` is what the onClick calls (the context, not the words). */
const PLAY_OK = [
  { file: 'ui/board/TodayTimer.jsx', why: 'the focus clock: ▶ runs the countdown again' },
  { file: 'ui/board/Card.jsx', why: 'starts the focus clock of a board card (the clock\'s own ▶)' },
  { file: 'ui/settings/AppearanceSection.jsx', why: 'plays the sound it previews (试听)' },
  { file: '*', handler: /[Cc]ompanion/, why: 'opens a companion lesson, an HTML lesson that plays as slides' },
  { file: 'ui/Sources.jsx', spec: true, why: 'the tab of the companion lessons (the file belongs to PR #1117; its ▶ is the lessons\' play)' },
];

test('2: no Button with words leads with a play icon, whatever its words; ▶ stays only where it plays something in time (listed with why), as an icon-only control or in the deck row\'s slot', async () => {
  const used = new Set(), found = [];
  for (const { file, source } of await uiSources()) {
    for (const { kind, open } of playLeads(source)) {
      const ok = PLAY_OK.find((entry) => (entry.file === '*' || entry.file === file) && !!entry.spec === (kind === 'spec') && (!entry.handler || entry.handler.test(propOf(open, 'onClick'))));
      if (ok) used.add(ok); else found.push(`${file}: ${kind} ${open.slice(0, 90)}`);
    }
  }
  assert.deepEqual(found, [], 'a go-on action ends in iconEnd="arrow-right"; an installer or a job control has no icon');
  assert.deepEqual(PLAY_OK.filter((entry) => !used.has(entry)).map((entry) => entry.file), [], 'a listed play no control needs any more is deleted');
  for (const { why } of PLAY_OK) assert.ok(why.length > 12);
});

test('2: the play guard sees a play-led Button however its icon is written, and an action spec, and leaves an icon-only control alone', () => {
  assert.equal(playLeads('<Button variant="primary" icon="play" onClick={go}>{run ? uiFormat("继续 {0}/{1}", [1, 2]) : ui("学习所选内容")}</Button>').length, 1);
  assert.equal(playLeads('<Button icon={busy ? "clock" : "play"} onClick={go}>{label}</Button>').length, 1);
  assert.equal(playLeads("const fix = { id: 'continue', label: ui('继续安装'), icon: 'play' };").length, 1);
  assert.equal(playLeads('<Button icon="play" aria-label={ui("播放")} />').length, 0);
  assert.equal(playLeads('<Button iconEnd="arrow-right" onClick={go}>{ui("学习所选内容")}</Button>').length, 0);
});

test('3: the go-on rule sees what it should and leaves the rest alone', () => {
  assert.equal(goOnProblems('<Button variant="quiet" onClick={() => go(1)}>{ui("去练")}</Button>').length, 1);
  assert.equal(goOnProblems('<Button iconEnd="arrow-right" onClick={() => go(1)}>{ui("去练")}</Button>').length, 0);
  assert.equal(goOnProblems('<Button icon="sparkle">{ui("开始生成")}</Button>').length, 0);
  assert.equal(goOnProblems('<Button onClick={() => x()}>{ui("删除")}</Button>').length, 0);
  assert.equal(goOnProblems('<Button size="sm">{done ? ui("继续") : ui("开始")}</Button>').length, 1);
});

test('1: the rule reads the words however a Button gets them: uiFormat templates, uiMessage, and a helper of ui/ (by its key when it is a table)', () => {
  assert.deepEqual(labelsOf('{uiFormat("练 {0} 题", [n.cards.length])}'), ['练 {0} 题']);
  assert.equal(goOnProblems('<Button size="sm" className="sk-mini" onClick={() => onPractice(n.cards)}>{uiFormat("练 {0} 题", [n.cards.length])}</Button>').length, 1, 'the skeleton\'s 练 3 题 needs its arrow');
  const helpers = labelHelpers([{ source: "export const practiceLabel = resume => (resume ? uiFormat('接着练 {0}/{1}', [1, 2]) : ui('练这一节'));\nexport const actionLabel = (action) => ({ resume: ui('继续'), 'model-settings': ui('去配置模型'), topup: ui('为没覆盖的部分补题') })[action] || '';" }]);
  assert.deepEqual(labelsOf('{practiceLabel(node.resume)}', helpers), ['接着练 {0}/{1}', '练这一节']);
  assert.deepEqual(labelsOf("{actionLabel('model-settings')}", helpers), ['去配置模型']);
  assert.deepEqual(labelsOf("{actionLabel('topup')}", helpers), ['为没覆盖的部分补题']);
  assert.deepEqual(labelsOf('{actionLabel(action)}', helpers), ['继续', '去配置模型', '为没覆盖的部分补题']);
});

test('7: in place or on is decided by what the control does, not by its words: the same 接着做 / 继续 acts in place on a job and goes on elsewhere', () => {
  assert.match(inPlaceWhy("<Button size=\"sm\" onClick={() => act('retry')}>"), /act/);
  assert.match(inPlaceWhy("<Button onClick={() => core.act('generate', args)}>"), /act/);
  assert.equal(inPlaceWhy('<Button type="submit" variant="primary">'), '', 'a submit that starts a round goes on (开始本轮)');
  assert.equal(inPlaceWhy('<Button onClick={() => plan.start(task.id)}>'), '');
  assert.equal(inPlaceWhy('<Button onClick={onPractice}>'), '');
  assert.equal(goOnProblems("<Button iconEnd=\"arrow-right\" size=\"sm\" onClick={() => act('retry')}>{ui(\"接着做\")}</Button>").length, 1, 'a job control on its card has no arrow');
  assert.equal(goOnProblems("<Button size=\"sm\" onClick={() => act('resume')}>{ui(\"继续\")}</Button>").length, 0);
  assert.equal(goOnProblems('<Button onClick={() => plan.start(task.id)}>{ui("继续")}</Button>').length, 1, 'the same word that takes the learner on wants the arrow');
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

test('2/9 (round 4): the one weight exception is the answer mark, written as `weight="state"` (a state icon beside a bold label: the stroke of the label\'s stem), never as a strokeWidth', async () => {
  const [icon, answer, design] = await Promise.all([read('ui/components/Icon.jsx'), read('ui/review/AnswerState.jsx'), read('ui/DESIGN.md')]);
  assert.match(icon, /weight === 'state'/);
  assert.doesNotMatch(icon, /REGULAR_STROKE|'regular'/, 'Regular was too thin beside a bold label (0.9px against 2px) and is gone');
  assert.match(answer, /weight="state"/);
  assert.doesNotMatch(answer, /strokeWidth/);
  assert.match(design, /weight="state"/);
  const users = [];
  for (const { file, source } of await uiSources()) if (/<Icon\b[^>]*\sweight=/.test(source)) users.push(file);
  assert.deepEqual(users, ['ui/review/AnswerState.jsx'], 'only a state icon beside its label has the state weight');
  const light = renderToStaticMarkup(h(m.Icon, { name: 'check' })), state = renderToStaticMarkup(h(m.Icon, { name: 'check', weight: 'state' }));
  assert.doesNotMatch(light, /stroke-width/);
  // Light is 12 units on the 256 grid; the state weight widens it to 38, about 2.0px at the 14px inline size: the stem of the 15px bold label beside it (34 measured 0.85 of the label).
  assert.equal(Number(state.match(/stroke-width="([\d.]+)"/)?.[1]), 26);
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
  try { assert.match(renderToStaticMarkup(h(m.AddSourceButton, { more: true, variant: 'link' })), /Add another source/); } finally { m.setUiLanguage('zh'); }
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
