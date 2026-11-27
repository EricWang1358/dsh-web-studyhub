import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { reviewParts } from './helpers/review-render.mjs';
import { loadInteractiveUi, click, withBrowserGlobals } from './helpers/react-harness.mjs';

/* #1073: the tick and cross of an answer, the marks of 对 / 错 and the flag are registry icons, not typed characters. */

const m = await loadUi(`
  export { default as AnswerState } from './ui/review/AnswerState.jsx';
  export { default as OptionMark } from './ui/OptionMark.jsx';
  export { default as QuestionRun } from './ui/review/QuestionRun.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
  export { ICON_PATHS } from './ui/components/icon-paths.js';
`);
const h = React.createElement;
const render = (element) => renderToStaticMarkup(element);
const svgs = (html) => (html.match(/<svg/g) || []).length;
const text = (html) => html.replace(/<[^>]+>/g, '');
const iconPath = (name) => [].concat(m.ICON_PATHS[name])[0];

test('an answered option: a tick before 已选 · 正确, a cross before 你的选择, plain words for the right one you did not pick, nothing for the rest', () => {
  const picked = render(h(m.AnswerState, { correct: true, picked: true }));
  assert.equal(text(picked), '已选 · 正确');
  assert.equal(svgs(picked), 1);
  assert.ok(picked.includes(iconPath('check').slice(0, 40)));
  const wrong = render(h(m.AnswerState, { correct: false, picked: true }));
  assert.equal(text(wrong), '你的选择');
  assert.ok(wrong.includes(iconPath('close').slice(0, 40)));
  const missed = render(h(m.AnswerState, { correct: true, picked: false }));
  assert.equal(text(missed), '正确答案');
  assert.equal(svgs(missed), 0);
  assert.equal(text(render(h(m.AnswerState, { correct: true, picked: false, multiple: true }))), '漏选 · 正确答案');
  assert.equal(text(render(h(m.AnswerState, { correct: false, picked: true, multiple: true }))), '已选 · 错选');
  assert.equal(text(render(h(m.AnswerState, { correct: false, picked: false }))), '');
  for (const html of [picked, wrong, missed]) assert.doesNotMatch(html, /[✓×✕]/);
});

test('English says the same without a typed mark', () => {
  m.setUiLanguage('en');
  try {
    const picked = render(h(m.AnswerState, { correct: true, picked: true }));
    const wrong = render(h(m.AnswerState, { correct: false, picked: true }));
    assert.equal(text(picked), 'Selected · correct');
    assert.equal(text(wrong), 'Your selection');
  } finally { m.setUiLanguage('zh'); }
});

test('a 判断题 option shows its number (the key that picks it) in the circle where the other kinds show a letter, never the tick or cross of the verdict', () => {
  const trueFalse = { kind: 'truefalse' };
  const right = render(h(m.OptionMark, { card: trueFalse, option: { id: 'true' }, index: 0 }));
  const no = render(h(m.OptionMark, { card: trueFalse, option: { id: 'false' }, index: 1 }));
  assert.equal(right, '1');
  assert.equal(no, '2');
  assert.doesNotMatch(right + no, /<svg|[✓✕]/);
  const quiz = { kind: 'quiz' };
  assert.equal(render(h(m.OptionMark, { card: quiz, option: { id: 'b' }, index: 1 })), 'B');
});

test('the flag of a question is the registry icon, in a quiet icon button that is named and has its tooltip (#1073)', async () => {
  const flagPath = iconPath('flag');
  assert.ok(flagPath, 'the registry draws a flag');
  const han = /\p{Script=Han}/u;
  const baseData = { decks: [{ id: 'd1', course: 'Net' }], sources: [], courses: [], assist: [] };
  const makeRun = (flag = '') => ({
    id: 'run-flag',
    index: 0,
    total: 1,
    deckId: 'd1',
    mode: 'quiz',
    card: {
      id: 'c1',
      kind: 'quiz',
      prompt: 'Which protocol is stateless?',
      options: [{ id: 'a', text: 'HTTP' }, { id: 'b', text: 'TCP' }],
      flag,
    },
    navigation: [{ answered: false }],
  });
  const renderRun = (flag = '') => {
    const { services, props } = reviewParts({ run: makeRun(flag), data: baseData });
    return render(h(m.StudyServicesContext.Provider, { value: services }, h(m.QuestionRun, { ...props, place: null })));
  };
  const extractFlagControl = (html) => {
    assert.doesNotMatch(html, /⚑/, 'never renders a typed flag character');
    const match = /<span class="sh-popover-anchor"><button([^>]*question-meta__action[^>]*)>([\s\S]*?)<\/button><span([^>]*role="tooltip"[^>]*)>([\s\S]*?)<\/span><\/span>/.exec(html);
    assert.ok(match, 'flag button sits inside Tooltip wrapper with sibling role="tooltip"');
    const [, btnAttrs, btnBody, tipAttrs, tipBody] = match;
    const describedBy = /aria-describedby="([^"]+)"/.exec(btnAttrs)?.[1];
    const tipId = /id="([^"]+)"/.exec(tipAttrs)?.[1];
    assert.ok(describedBy && tipId && describedBy.split(/\s+/).includes(tipId), 'flag button aria-describedby links to its Tooltip');
    assert.match(btnAttrs, /class="[^"]*\bsh-btn--quiet\b[^"]*"/, 'quiet button variant');
    assert.match(btnAttrs, /class="[^"]*\bsh-btn--icon\b[^"]*"/, 'icon button modifier');
    assert.match(btnAttrs, /class="[^"]*\bquestion-meta__action\b[^"]*"/, 'question-meta__action class');
    assert.match(tipAttrs, /popover="manual"/, 'Tooltip renders in top layer');
    assert.equal(svgs(btnBody), 1, 'flag button renders one registry SVG icon');
    assert.ok(btnBody.includes(flagPath.slice(0, 40)), 'flag button embeds ICON_PATHS.flag');
    return {
      btnAttrs,
      ariaLabel: /aria-label="([^"]+)"/.exec(btnAttrs)?.[1] || '',
      ariaPressed: /aria-pressed="([^"]+)"/.exec(btnAttrs)?.[1] || '',
      tooltip: text(tipBody),
    };
  };

  m.setUiLanguage('zh');
  try {
    const zhUnflagged = extractFlagControl(renderRun(''));
    assert.equal(zhUnflagged.ariaLabel, '标记题目');
    assert.equal(zhUnflagged.tooltip, '标记题目');
    assert.equal(zhUnflagged.ariaPressed, 'false');
    assert.doesNotMatch(zhUnflagged.btnAttrs, /\bis-active\b/);

    const zhFlagged = extractFlagControl(renderRun('易错'));
    assert.equal(zhFlagged.ariaLabel, '已标记题目，点击查看或修改');
    assert.equal(zhFlagged.tooltip, '已标记：易错');
    assert.equal(zhFlagged.ariaPressed, 'true');
    assert.match(zhFlagged.btnAttrs, /\bis-active\b/);

    m.setUiLanguage('en');
    const enUnflagged = extractFlagControl(renderRun(''));
    assert.equal(enUnflagged.ariaLabel, 'Flag question');
    assert.equal(enUnflagged.tooltip, 'Flag question');
    assert.equal(enUnflagged.ariaPressed, 'false');
    assert.doesNotMatch(enUnflagged.ariaLabel, han, 'English aria-label has zero Han');
    assert.doesNotMatch(enUnflagged.tooltip, han, 'English tooltip has zero Han');
    assert.doesNotMatch(enUnflagged.btnAttrs, /\bis-active\b/);

    const enFlagged = extractFlagControl(renderRun('Review'));
    assert.equal(enFlagged.ariaLabel, 'Flagged question, click to view or edit');
    assert.equal(enFlagged.tooltip, 'Flagged: Review');
    assert.equal(enFlagged.ariaPressed, 'true');
    assert.doesNotMatch(enFlagged.ariaLabel, han, 'English flagged aria-label has zero Han');
    assert.doesNotMatch(enFlagged.tooltip, han, 'English flagged tooltip has zero Han');
    assert.match(enFlagged.btnAttrs, /\bis-active\b/);
  } finally {
    m.setUiLanguage('zh');
  }

  const ui = await loadInteractiveUi(`
    export { default as QuestionRun } from './ui/review/QuestionRun.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  await withBrowserGlobals(async () => {
    ui.exports.setUiLanguage('zh');
    const modals = [];
    const { services, props } = reviewParts({ run: makeRun(''), data: baseData, setModal: (modal) => modals.push(modal) });
    const mounted = ui.mount(() => ui.React.createElement(
      ui.exports.StudyServicesContext.Provider,
      { value: services },
      ui.React.createElement(ui.exports.QuestionRun, { ...props, place: null }),
    ));
    try {
      const flagBtn = mounted.find((n) => n.type === 'button' && typeof n.props?.className === 'string' && n.props.className.includes('question-meta__action'));
      assert.ok(flagBtn, 'interactive QuestionRun renders the flag button');
      await mounted.act(() => click(flagBtn));
      assert.deepEqual(modals, [{ type: 'flag' }], 'clicking the flag button opens the flag modal');
    } finally {
      mounted.unmount();
      ui.exports.setUiLanguage('zh');
    }
  });
});
