import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { loadUi } from './helpers/ui-module.mjs';
import { loadInteractiveUi, click } from './helpers/react-harness.mjs';

// UI wave 2 · WP-F: every sentence the files this work package touched put through ui() has an English line, and the
// shell no longer chooses its copy with language ternaries (#123).
const { uiCatalogue } = await loadUi("export { uiCatalogue } from './ui/i18n.js';");
const catalogue = uiCatalogue();
const han = /[㐀-鿿]/;

const walk = async (dir) => (await readdir(dir, { recursive: true })).map((name) => `${dir}/${name}`.replace(/\\/g, '/')).filter((name) => /\.(js|jsx)$/.test(name));
const FILES = [
  'ui/App.jsx', 'ui/Review.jsx', 'ui/review/QuestionRun.jsx', 'ui/ReviewToolbar.jsx', 'ui/ReviewNavigator.jsx', 'ui/ShortcutHelp.jsx', 'ui/ExplanationFollowup.jsx', 'ui/study-context.jsx',
  'ui/components/Feedback.jsx', 'ui/ActionFeedback.jsx', 'ui/quick-actions.js',
  ...await walk('ui/app'), ...await walk('ui/review'),
];
const CALL = /\b(?:ui|uiFormat|uiRich)\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
const unescape = (text) => text.replace(/\\(n|t|'|"|`|\\)/g, (_, code) => ({ n: '\n', t: '\t' }[code] ?? code));
// Messages chosen by a condition inside the call (uiFormat(cond ? 'a' : 'b', ...)) are listed here.
const CONDITIONAL = ['后台助教正在解答：{0}', '后台助教正在出新题：{0}', '后台助教正在改题：{0}'];
const known = (key) => Object.hasOwn(catalogue, key) || Object.hasOwn(catalogue, key.replace(/\s+/g, ' ').trim());

test('every Chinese sentence the shell, the practice page and their hooks pass through ui() has an English line', async () => {
  const missing = [];
  for (const file of FILES) {
    const source = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n');
    for (const match of source.matchAll(CALL)) {
      const key = unescape(match[2]);
      if (han.test(key) && !known(key)) missing.push(`${file}: ${JSON.stringify(key)}`);
    }
  }
  for (const key of CONDITIONAL) if (!known(key)) missing.push(`conditional: ${JSON.stringify(key)}`);
  assert.deepEqual(missing, []);
});

test('the copy is not chosen with language ternaries or hard-coded English in the shell (#123)', async () => {
  for (const file of FILES) {
    const source = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n');
    assert.doesNotMatch(source, /language\s*===\s*['"]en['"]\s*\?/, `${file}: language === 'en' ?`);
    assert.doesNotMatch(source, /getUiLanguage\(\)\s*===\s*['"]en['"]/, `${file}: getUiLanguage() === 'en'`);
    assert.doesNotMatch(source, /YOUR LEARNING SPACE/, `${file}: the English eyebrow is the catalogue's English`);
  }
  assert.equal(catalogue['你的学习空间'], 'YOUR LEARNING SPACE', 'the English still shows the eyebrow as it did');
});

test('the fold labels of a follow-up come from the catalogue, not from CSS content (#160)', async () => {
  const css = await readFile('ui/followup.css', 'utf8');
  assert.doesNotMatch(css, /followup-item[^{]*::after\s*\{[^}]*content/);
  assert.equal(catalogue['展开'], 'Expand');
  assert.equal(catalogue['收起'], 'Collapse');

  const { exports: ui, React: R, mount } = await loadInteractiveUi(`
    export { default as ExplanationFollowup } from './ui/ExplanationFollowup.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  const run = {
    id: 'run-fold',
    deckId: 'd1',
    card: { id: 'c1', kind: 'quiz', prompt: 'Q?' },
    solution: { followups: [{ id: 'f1', question: '为什么？', answer: '因为边界条件不同。' }] },
  };
  const services = { call: async () => ({}) };
  const prevRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => 0;

  try {
    for (const [language, openLabel, closedLabel] of [['zh', '收起', '展开'], ['en', 'Collapse', 'Expand']]) {
      ui.setUiLanguage(language);
      const mounted = mount(() => R.createElement(
        ui.StudyServicesContext.Provider,
        { value: services },
        R.createElement(ui.ExplanationFollowup, { run }),
      ));
      try {
        const stateBadge = () => mounted.find((n) => n.type === 'span' && n.props?.className === 'followup-state');
        const detailsEl = () => mounted.find((n) => n.type === 'details' && n.props?.className === 'followup-item');
        const foldBtn = () => mounted.find((n) => n.type === 'button' && String(n.props?.className || '').includes('followup-fold'));

        // Newest follow-up starts open with the collapse label.
        assert.equal(detailsEl().props.open, true, `${language}: starts open`);
        assert.equal(mounted.text(stateBadge()), openLabel, `${language}: open state label`);
        assert.equal(mounted.text(foldBtn()), openLabel, `${language}: fold button label`);

        // Clicking the fold button collapses it and switches the summary badge to expand.
        await mounted.act(() => {
          click(foldBtn(), { currentTarget: { closest: () => ({ querySelector: () => null }) } });
        });
        assert.equal(detailsEl().props.open, false, `${language}: collapsed after fold click`);
        assert.equal(mounted.text(stateBadge()), closedLabel, `${language}: collapsed state label`);

        // Toggling the <details> back open restores the collapse label.
        await mounted.act(() => {
          detailsEl().props.onToggle({ currentTarget: { open: true } });
        });
        assert.equal(detailsEl().props.open, true, `${language}: re-opened via details onToggle`);
        assert.equal(mounted.text(stateBadge()), openLabel, `${language}: re-opened state label`);
      } finally {
        mounted.unmount();
      }
    }
  } finally {
    ui.setUiLanguage('zh');
    if (prevRaf === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = prevRaf;
  }
});
