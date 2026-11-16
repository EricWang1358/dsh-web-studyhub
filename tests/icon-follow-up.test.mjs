import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { uiSources } from './helpers/icon-stand-ins.mjs';
import { loadUi } from './helpers/ui-module.mjs';

/* #1073, the follow-up of the review of PR #1096: the rules ui/DESIGN.md (Icons) writes about size, gap, the verdict marks and the ink of a filled circle,
   pinned where a static check can see them. The pixels (a row that does not grow, a counter that does not wrap) are the browser tests'. */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const ruleOf = (css, selector) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, head]) => head.split(',').some((part) => part.trim() === selector)).map(([, , body]) => body);
const iconTags = (source) => [...source.matchAll(/<Icon\b[^>]*?\/>/g)].map((match) => match[0]);
const luminance = (hex) => {
  const channels = hex.replace('#', '').match(/../g).slice(0, 3).map((part) => parseInt(part, 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

const m = await loadUi(`
  export { default as OptionMark } from './ui/OptionMark.jsx';
  export { default as AnswerState } from './ui/review/AnswerState.jsx';
  export { default as NextDue } from './ui/NextDue.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);
const h = React.createElement;
const text = (html) => html.replace(/<[^>]+>/g, '');

test('an icon in running text is one size, set once by .sh-icon--inline, and never carries its own size or weight', async () => {
  const base = await read('ui/base.css');
  const [rule] = ruleOf(base, '& .sh-icon--inline');
  assert.match(rule, /width:\s*var\(--icon-inline\)/);
  assert.match(rule, /height:\s*var\(--icon-inline\)/);
  assert.match(base, /--icon-inline:\s*14px/, 'the one size: 14px, the floor of Phosphor Light');
  const found = [];
  for (const { file, source } of await uiSources()) for (const tag of iconTags(source)) if (/sh-icon--inline/.test(tag) && /\s(?:size|strokeWidth)=/.test(tag)) found.push(`${file}: ${tag.slice(0, 90)}`);
  assert.deepEqual(found, [], 'an inline icon takes its size from the class: drop size= / strokeWidth=');
});

test('the icons that sit next to body text are inline icons: the answer marks, the next-due line, the applied note, the wrong-book marks, the focus tick, the external marks', async () => {
  const want = [
    ['ui/review/AnswerState.jsx', /name=\{mark\}/], ['ui/NextDue.jsx', /name=\{nextDueIcon/], ['ui/tasks/ControlRow.jsx', /name="check"/], ['ui/AudioDashboard.jsx', /name="external"/],
    ['ui/study-map/FocusProgressLine.jsx', /name="check"/], ['ui/WrongBook.jsx', /name=\{kind === "graded"/], ['ui/WrongBook.jsx', /name="diamond"/], ['ui/ArchifyCard.jsx', /name="external"/],
    ['ui/guided-study/StudyProgressPanel.jsx', /name=\{goalCompleted/],
  ];
  for (const [file, pattern] of want) {
    const tags = iconTags(await read(file)).filter((tag) => pattern.test(tag));
    assert.ok(tags.length, `${file}: the icon ${pattern} is there`);
    for (const tag of tags) assert.match(tag, /sh-icon--inline/, `${file}: ${tag.slice(0, 80)}`);
  }
});

test('the applied note of the task console draws its tick on the line: no inline icon taller than the text', async () => {
  const [source, css] = await Promise.all([read('ui/tasks/ControlRow.jsx'), read('ui/tasks/task-console.css')]);
  assert.match(source, /<Icon name="check" className="sh-icon--inline sh-icon--lead" \/>/);
  const [rule] = ruleOf(css, '.tc-controls__applied');
  assert.match(rule, /min-height:\s*1\.4em/);
  assert.match(rule, /display:\s*flex/, 'a flex row: the icon is an item, not a box in the text line');
});

test('the mark before an option is decided in one place (optionMark): a 判断题 option is its number, no screen spells it again, and the fixed options carry no tick or cross', async () => {
  const trueFalse = { kind: 'truefalse' };
  const circle = (id, index) => text(renderToStaticMarkup(h(m.OptionMark, { card: trueFalse, option: { id }, index })));
  assert.equal(circle('true', 0), '1');
  assert.equal(circle('false', 1), '2');
  m.setUiLanguage('en');
  try { assert.equal(circle('true', 0), '1'); } finally { m.setUiLanguage('zh'); }
  assert.doesNotMatch(await read('lib/card-kinds.js'), /icon:\s*'(?:check|close)'/, 'the fixed options carry no icon');
  const found = [];
  for (const { file, source } of await uiSources()) if (/verdict \? String\(/.test(source)) found.push(file);
  assert.deepEqual(found, [], 'a screen asks optionMark, it does not number the options itself');
});

test('a filled option circle reads in both themes: its mark takes the raised (paper) colour, not the canvas, which is dark on the dark ink and the green in the dark theme', async () => {
  const [question, views, tokens, paper] = await Promise.all([read('ui/review/question.css'), read('ui/views.css'), read('ui/tokens.css'), read('ui/paper.css')]);
  for (const selector of ['.option--selected .option-letter', '.option.correct .option-letter']) assert.match(ruleOf(question, selector).join(' '), /color:\s*var\(--bg-raised\)/, selector);
  assert.match(ruleOf(views, '.exam-option[aria-pressed="true"] .exam-option-letter').join(' '), /color:\s*var\(--bg-raised\)/);
  // The review card is paper in every theme: its ink and its green are the paper's, and the mark is the paper colour on them.
  const papers = [...tokens.matchAll(/--paper:\s*(#[0-9a-f]{6})/gi)].map((match) => match[1]);
  const inks = [...tokens.matchAll(/--paper-ink:\s*(#[0-9a-f]{6})/gi)].map((match) => match[1]);
  const green = paper.match(/--ok:\s*(#[0-9a-f]{6})/i)[1];
  assert.equal(papers.length, 2);
  for (const sheet of papers) {
    for (const ink of inks) assert.ok(contrast(sheet, ink) >= 7, `the mark on the dark circle: ${sheet} on ${ink}`);
    assert.ok(contrast(sheet, green) >= 3, `the mark on the green circle: ${sheet} on ${green}`);
  }
});

test('the counter of a resume row never wraps, and a row-ending arrow keeps one gap on every row', async () => {
  const [desk, intro, activity] = await Promise.all([read('ui/study-map/desk.css'), read('ui/study-map/DeskIntro.jsx'), read('ui/study-map/HomeActivity.jsx')]);
  assert.equal(ruleOf(desk, '.resume > span:last-child').length, 1, 'one rule for the counter, not two');
  const counter = ruleOf(desk, '.resume > span:last-child')[0];
  assert.doesNotMatch(counter, /\bgap:/, 'the gap is the row-end rule\'s');
  const [rowEnd] = ruleOf(desk, '.row-end');
  assert.match(rowEnd, /gap:\s*var\(--space-2\)/, 'the gap of a Button\'s iconEnd');
  for (const pattern of [/white-space:\s*nowrap/, /flex:\s*none/, /display:\s*inline-flex/]) assert.match(rowEnd, pattern);
  assert.match(intro, /className="row-end"/);
  assert.match(activity, /className="row-end"/);
  assert.equal(ruleOf(desk, '.draft-open > span:last-child').length, 0, 'the draft row\'s 打开 uses .row-end');
});

test('a "go on" action carries the arrow: the wrong book\'s 练 and the deck row\'s 继续', async () => {
  const [wrong, deck] = await Promise.all([read('ui/WrongBook.jsx'), read('ui/study-map/DeckRow.jsx')]);
  const practice = wrong.split('<Button').slice(1).map((chunk) => chunk.split('</Button>')[0]).filter((chunk) => chunk.endsWith('{ui("练")}'));
  assert.equal(practice.length, 3);
  for (const button of practice) assert.match(button, /iconEnd="arrow-right"/);
  assert.equal([...deck.matchAll(/ui\('继续'\)\}<Icon name="arrow-right"/g)].length, 2);
});

test('NextDue: a lead line that wraps starts its second line under the words, not under the icon', async () => {
  const css = await read('ui/review/question.css');
  assert.match(ruleOf(css, '.next-due__lead').join(' '), /display:\s*(?:flex|grid)/);
  const html = renderToStaticMarkup(h(m.NextDue, { feedback: { correct: true, level: 'learning', nextDue: '2099-01-01T00:00:00.000Z', retryQueued: true } }));
  assert.match(html, /next-due__lead[^>]*>(?:<svg[^>]*>.*?<\/svg>)?<span class="next-due__words">/s);
});

test('the answer mark is an inline icon too: 14px, the default weight', () => {
  const html = renderToStaticMarkup(h(m.AnswerState, { correct: true, picked: true }));
  assert.match(html, /class="sh-icon sh-icon--inline"/);
  assert.doesNotMatch(html, /stroke-width/);
});

test('ui/DESIGN.md says the rules once: inline size, row-end gap, the arrow on a "go on" action, verdict marks', async () => {
  const design = await read('ui/DESIGN.md');
  for (const needle of ['sh-icon--inline', '--icon-inline', 'row-end', '练', '继续', '接着做', '对 / 错']) assert.ok(design.includes(needle), `DESIGN.md names ${needle}`);
});

test('no browser script names a control by a typed arrow or plus: the accessible name has only the words (controlName, #1088)', async () => {
  const { readdir } = await import('node:fs/promises');
  const found = [];
  for (const dir of ['scripts/qa', 'tests']) {
    for (const name of (await readdir(new URL(`../${dir}/`, import.meta.url))).filter((entry) => /(?:browser\.test|^[\w-]+)\.mjs$/.test(entry))) {
      const source = await read(`${dir}/${name}`);
      // The one file that spells the glyphs on purpose, to accept them either way.
      if (name === 'control-name.mjs' || name === 'icon-follow-up.test.mjs') continue;
      for (const match of source.matchAll(/\{\s*name:\s*[^}]*["'`][^"'`]*(?:\s→|＋ )["'`]/g)) found.push(`${dir}/${name}: ${match[0].slice(0, 80)}`);
    }
  }
  assert.deepEqual(found, []);
});
