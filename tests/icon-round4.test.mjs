import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { repoRoot, uiSources } from './helpers/icon-stand-ins.mjs';
import { buttonElements } from './helpers/go-on.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';

/* #1073 / #1074, round 4 of the review of PR #1118: what the static code can say about the ten defects. The browser half (the stroke of the answer marks, the
   gap of the skeleton station's arrow, the colour of 再添加资料, the first-run step that was cut, the deck row's title at 420px) is
   tests/icon-round4-browser.test.mjs. */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const ruleOf = (css, selector) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, head]) => head.split(',').some((part) => part.trim() === selector)).map(([, , body]) => body);
const ARROW = /M220\.24,132\.24/; // the path of arrow-right (Phosphor Light)

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { AddSourceButton } from './ui/components/AddSourceButton.jsx';
  export { QaList } from './ui/book/BookQa.jsx';
  export { default as CompactJobCard } from './ui/tasks/CompactJobCard.jsx';
  export { stepSentence } from './ui/first-run/FirstRunLine.jsx';
  export * as copy from './ui/coverage/copy.js';
  export { ui, setUiLanguage } from './ui/i18n.js';
`);
const h = React.createElement;
const inEnglish = (run) => { m.setUiLanguage('en'); try { return run(); } finally { m.setUiLanguage('zh'); } };

/* ---- 4: a stylesheet never takes a Button's flex away ---------------------------------------------------------------------------------------------------------- */

async function* cssFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* cssFiles(path); else if (entry.name.endsWith('.css')) yield path;
  }
}

/** A Button that draws an icon spaces it from its words with the flex `gap` of .sh-btn. A rule that makes it block, inline or inline-block drops that gap: the
    skeleton station's 「学这一站 · 3 题→」 had 0px between the words and the arrow and sat 2.5px high. Listed: the ones whose icon keeps its own margin, and why. */
const DISPLAY_OK = [
  { selector: '.book-file li .book-link', why: 'a link that is the text of a list item runs on like text; its icon carries its own margin (.book-link > svg)' },
  { selector: '.citations .citations__button', why: 'a citation card: the source title and its quote are a block, and the icon heads the card on a line of its own' },
];

test('4: no stylesheet gives a Button that draws an icon display: block / inline / inline-block, which drops the gap between the icon and the words', async () => {
  const classes = new Map();
  for (const { file, source } of await uiSources()) {
    const opens = [...buttonElements(source).map(({ open }) => open), ...[...source.matchAll(/<(?:Button|AddSourceButton)\b[^>]*?\/>/g)].map((match) => match[0])];
    for (const open of opens) {
      if (!/\s(?:icon|iconEnd)=/.test(open) && !/^<AddSourceButton/.test(open)) continue;
      const names = open.match(/\sclassName=(?:"([^"]+)"|\{([^}]*)\})/);
      for (const word of (names?.[1] ?? names?.[2] ?? '').matchAll(/[A-Za-z][\w-]*/g)) if (/[-_]/.test(word[0]) && !word[0].startsWith('sh-')) classes.set(word[0], file);
    }
  }
  const found = [], used = new Set();
  for await (const path of cssFiles(join(repoRoot, 'ui'))) {
    const css = (await readFile(path, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, head, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const display = body.match(/(?:^|[;\s])display:\s*([\w-]+)/)?.[1];
      if (!['block', 'inline', 'inline-block', 'table', 'contents'].includes(display)) continue;
      for (const selector of head.split(',').map((part) => part.trim())) {
        const last = selector.split(/[\s>+~]+/).at(-1) || '';
        const hit = [...last.matchAll(/\.([\w-]+)/g)].map((match) => match[1]).find((name) => classes.has(name));
        if (!hit || last.includes('::')) continue;
        const ok = DISPLAY_OK.find((entry) => entry.selector === selector);
        if (ok) used.add(ok); else found.push(`${relative(repoRoot, path)}: ${selector} { display: ${display} } (a Button of ${classes.get(hit)})`);
      }
    }
  }
  assert.deepEqual(found, [], 'leave display to .sh-btn (inline-flex); place the button with margin or its parent');
  assert.deepEqual(DISPLAY_OK.filter((entry) => !used.has(entry)).map((entry) => entry.selector), [], 'a listed rule that is gone is deleted from the list');
});

/* ---- 5 (#1074): 再添加资料 is one control with one colour ------------------------------------------------------------------------------------------------------------ */

test('5 (#1074): AddSourceButton as a link is a text action, so it is ink, decided in the component; no place paints it (the first-run line\'s grey class is gone)', async () => {
  for (const more of [false, true]) {
    const html = renderToStaticMarkup(h(m.AddSourceButton, { more, variant: 'link' }));
    assert.match(html, /sh-btn--ink/, 'the link variant of 添加资料 is ink');
  }
  assert.doesNotMatch(renderToStaticMarkup(h(m.AddSourceButton, { variant: 'primary' })), /sh-btn--ink/);
  assert.match(ruleOf(await read('ui/components/components.css'), '.sh-btn--link.sh-btn--ink').join(' '), /--sh-link-ink:\s*var\(--text\)/);
  for (const { file, source } of await uiSources()) {
    for (const match of source.matchAll(/<AddSourceButton\b[^>]*?\/>/g)) assert.doesNotMatch(match[0], /first-run__link|\bstyle=/, `${file}: the colour of 添加资料 is the component's`);
  }
});

/* ---- 6 (#1074): the first-run step says what the button says -------------------------------------------------------------------------------------------------- */

test('6 (#1074): with the sample loaded, step 2 asks in the button\'s words (添加 … 资料 / add … source), in one short sentence; no 再加一份, no plural English', () => {
  const step = { id: 'material', status: 'todo', sampleCount: 2 };
  const zh = m.stepSentence(step);
  assert.doesNotMatch(zh, /再加一份/);
  assert.match(zh, /添加/);
  assert.match(zh, /资料/);
  assert.ok([...zh].length <= 16, `short enough for the compact card (${zh})`);
  inEnglish(() => {
    const en = m.stepSentence(step);
    assert.match(en, /\badd\b/i);
    assert.match(en, /\bsource\b/);
    assert.ok(en.length <= 36, `short enough for the compact card (${en})`);
    assert.equal(m.ui('添加资料'), 'Add source');
    assert.equal(m.ui('再添加资料'), 'Add another source', 'one number: a source, another source');
  });
});

/* ---- 7 / 10: in place has no arrow ------------------------------------------------------------------------------------------------------------------------------ */

test('7: a job card\'s button has the arrow only when it takes the learner somewhere: 继续 / 接着做 / 补题 act on the card, 去配置模型 goes to the settings', () => {
  assert.equal(m.copy.actionHere?.('resume'), true);
  assert.equal(m.copy.actionHere?.('continue'), true);
  assert.equal(m.copy.actionHere?.('topup'), true);
  assert.equal(m.copy.actionHere?.('model-settings'), false);
  const job = { id: 'g1', type: 'generate', status: 'failed', stage: 'boom', startedAt: '2026-11-17T10:00:00.000Z' };
  const draw = (primary) => renderToStaticMarkup(inApp(m, h(m.CompactJobCard, { job, primary }), { data: {} }));
  const go = (html) => html.match(/<button[^>]*cjc__go[^>]*>[\s\S]*?<\/button>/)?.[0] || '';
  assert.doesNotMatch(go(draw({ label: '接着做', run: () => {}, here: true })), ARROW, '接着做 acts on the card');
  assert.match(go(draw({ label: '检查草稿', run: () => {} })), ARROW, '检查草稿 opens the draft');
});

test('10: 「在这里做这道题」 starts the question where it stands, so it has no arrow; 「去练这道题」 goes to the practice page and keeps it', () => {
  const items = [{ kind: 'card', question: 'Q', answer: 'A', openRef: { deckId: 'd', cardId: 'c' } }];
  const away = renderToStaticMarkup(h(m.QaList, { items, onCard: () => {} }));
  const here = renderToStaticMarkup(h(m.QaList, { items, onCard: () => {}, here: true }));
  assert.match(away, /去练这道题/);
  assert.match(away, ARROW);
  assert.match(here, /在这里做这道题/);
  assert.doesNotMatch(here, ARROW);
});

test('10: the reader\'s section practice asks QaList for its in-place form, not for a label of its own', async () => {
  const practice = await read('ui/document-preview/practice/SectionPractice.jsx');
  assert.match(practice, /<QaList[^>]*\shere\b/);
  assert.doesNotMatch(practice, /cardLabel=/);
});

/* ---- 8: the deck row's English ---------------------------------------------------------------------------------------------------------------------------------- */

test('8: 继续 (resume a run, a timer, a paused job) is "Resume" in English: the deck row\'s slot is a word shorter, and 接着做 keeps "Continue"', () => {
  inEnglish(() => {
    assert.equal(m.ui('继续'), 'Resume');
    assert.equal(m.ui('继续 {0}/{1}'), 'Resume {0}/{1}');
    assert.equal(m.ui('接着做'), 'Continue');
  });
});

/* ---- 9: the arrow's gap scales with the button ------------------------------------------------------------------------------------------------------------------ */

test('9: the gap before an arrow follows the button\'s size (6px small, 8px standard and a row end), and DESIGN.md says so instead of "8px everywhere"', async () => {
  const [components, desk, design] = await Promise.all([read('ui/components/components.css'), read('ui/study-map/desk.css'), read('ui/DESIGN.md')]);
  assert.match(ruleOf(components, '.sh-btn').join(' '), /gap:\s*var\(--space-2\)/);
  assert.match(ruleOf(components, '.sh-btn--sm').join(' '), /gap:\s*var\(--space-1-5\)/);
  assert.match(ruleOf(desk, '.row-end').join(' '), /gap:\s*var\(--space-2\)/);
  assert.match(design, /6px[^\n]*size="sm"|size="sm"[^\n]*6px/);
  assert.match(design, /8px[^\n]*\.row-end|\.row-end[^\n]*8px/);
});
