import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { uiSources } from './helpers/icon-stand-ins.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { ICON_ONLY_HAND_OFFS, labelHelpers, LOOK_EXCEPTIONS, looksOf } from './helpers/go-on.mjs';

/* #1073, round 11 of the review of PR #1118 (the round-10 review, a30b3073):
     1  the topic rows' hand-off became a lone ↗ (the `external` mark, drawn by the icon-only shape of <HandOff>): at rest a row showed a bar, a percentage and an arrow
        that reads "opens a link", while its meaning (ask the main chat to explain this topic) lived only in the tooltip: the icon-only shape draws the chat glyph, the
        one place where the mark stays out, listed with why;
     2  接着做 was drawn at two more sites than the exception listed (the job card's `actionLabel('continue')`, the draft page's top-up button `actionLabel(action)`): the
        look gate reads a label that a helper returns, so a site it did not know cannot hide;
     3  the receipt toast's 去主会话 lacked the external mark: a toast's primary action passes its `icon` through like a banner's and a message's. */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
let cache;
const all = async () => {
  if (!cache) { const sources = await uiSources(); cache = { sources, helpers: labelHelpers(sources) }; }
  return cache;
};
const fileOf = (sources, file) => sources.find((entry) => entry.file === file)?.source ?? '';

const draw = async () => {
  const m = await loadUi(`
    export { HandOff, HandOffButton } from './ui/hand-off/HandOff.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { ToastRegion, createToastApi } from './ui/components/Feedback.jsx';
    export { noticeToToast, errorToToast } from './ui/ActionFeedback.jsx';
    export { deliverToChat, handOffReceipt } from './ui/hand-off/use-hand-off.js';
    export { ICON_PATHS } from './ui/components/icon-paths.js';
    export { setUiLanguage } from './ui/i18n.js';`);
  m.setUiLanguage('zh');
  const services = { askInChat: async () => 'filled', notify: () => {} };
  return { m, render: (element) => renderToStaticMarkup(React.createElement(m.StudyServicesContext.Provider, { value: services }, element)),
    drawn: (html, name) => html.includes([].concat(m.ICON_PATHS[name])[0].slice(0, 40)) };
};

/* ---- 1: the icon-only hand-off says "ask the main chat" at a glance ----------------------------------------------------------------------------------------- */

test('1: the icon-only HandOff draws the chat glyph (no ↗, no arrow), named by its label; the shapes with words keep the external mark in front', async () => {
  const { m, render, drawn } = await draw();
  const icon = render(React.createElement(m.HandOff, { id: 'topic.explain', input: {}, shape: 'icon' }));
  assert.ok(drawn(icon, 'chat'), 'icon: the chat glyph');
  assert.ok(!drawn(icon, 'external') && !drawn(icon, 'arrow-right'), 'icon: no external mark, no arrow');
  assert.match(icon, /aria-label="发给主会话"/);
  const bare = render(React.createElement(m.HandOffButton, { shape: 'icon', onClick() {} }));
  assert.ok(drawn(bare, 'chat') && !drawn(bare, 'external'), 'the button alone, icon shape');
  for (const shape of ['link', 'quiet', 'secondary']) {
    const html = render(React.createElement(m.HandOff, { id: 'deck.ask', input: {}, shape }));
    assert.ok(drawn(html, 'external') && !drawn(html, 'chat'), `${shape}: external in front, not the chat glyph`);
  }
});

test('1: the topic row draws the icon-only hand-off, and only listed places may (each with why); `chat` is drawn nowhere else as a hand-off', async () => {
  const { sources } = await all();
  const users = sources.filter(({ source }) => /<HandOff(?:Button)?\b[^>]*\bshape=(?:"icon"|\{\s*['"]icon['"]\s*\})/.test(source)).map(({ file }) => file).sort();
  assert.deepEqual(users, ICON_ONLY_HAND_OFFS.map((entry) => entry.file).sort(), 'a new icon-only hand-off is listed here, with why');
  for (const entry of ICON_ONLY_HAND_OFFS) assert.ok(entry.why.length > 30, `${entry.file}: say why`);
  assert.ok(users.includes('ui/study-map/DeckRow.jsx'));
  const handOff = fileOf(sources, 'ui/hand-off/HandOff.jsx');
  assert.equal([...handOff.matchAll(/icon="chat"/g)].length, 1, 'one chat glyph, in the icon-only shape');
  assert.match(handOff, /shape === 'icon'\s*\r?\n?\s*\? <Button[^\n]*icon="chat"/);
  const others = sources.filter(({ file, source }) => file !== 'ui/hand-off/HandOff.jsx' && /\bicon=(?:"chat"|\{\s*['"]chat['"]\s*\})|\bicon:\s*['"]chat['"]/.test(source)).map(({ file }) => file);
  assert.deepEqual(others, [], 'no other control draws the chat glyph');
});

test('1: DESIGN.md writes the icon-only form of the hand-off look', async () => {
  const design = await read('ui/DESIGN.md');
  assert.match(design, /icon-only[^\n]*hand-off[^\n]*chat glyph|hand-off[^\n]*icon-only[^\n]*chat glyph/i);
});

test('1: the topic row keeps its place: the icon-only control is the same quiet icon button (same box as before), shown on a row and hidden at the narrow width', async () => {
  const css = await read('ui/study-map/catalog.css');
  assert.match(css, /\.map-ask \{\s*\r?\n\s*flex-shrink: 0;\s*\r?\n\s*\}/, 'the anchor only keeps its size');
  assert.match(css, /\.map-ask \{ display: none; \}/, 'the narrow width still hides it');
});

/* ---- 2: the look gate reads a label that a helper returns ---------------------------------------------------------------------------------------------------- */

test('2: looksOf reads `actionLabel(\'continue\')` and `{actionLabel(action)}` (a label a helper returns, by its literal key or for every key of its table), with the arrow the call site draws', async () => {
  const { helpers } = await all();
  const spec = looksOf("const own = { continue: { label: actionLabel('continue'), here: actionHere('continue'), run: () => act('x') }, 'model-settings': { label: actionLabel('model-settings'), run: open } };", { file: 'ui/study-map/JobCard.jsx', helpers });
  assert.deepEqual(spec.map(({ key, look }) => `${key}=${look}`), ['接着做=-|-', '去配置模型=-|→']);
  const button = looksOf("<Button iconEnd={actionHere(action) ? undefined : 'arrow-right'} onClick={run}>{actionLabel(action)}</Button>", { file: 'ui/coverage/CoverageTopUp.jsx', helpers });
  const byKey = Object.fromEntries(button.map(({ key, look }) => [key, look]));
  assert.equal(byKey['接着做'], '-|-');
  assert.equal(byKey['继续'], '-|-');
  assert.equal(byKey['去配置模型'], '-|→');
  const plain = looksOf("<Button iconEnd=\"arrow-right\" onClick={go}>{label(x)}</Button>", { file: 'ui/X.jsx', helpers });
  assert.deepEqual(plain, [], 'a helper the gate does not know is not guessed');
});

test('2: 接着做 is drawn at the sites the exception lists, now including the job card and the draft page\'s top-up button, each in place (no arrow)', async () => {
  const { sources, helpers } = await all();
  const entry = LOOK_EXCEPTIONS.find((item) => item.key === '接着做');
  const where = new Map();
  for (const { file, source } of sources) for (const { key, look } of looksOf(source, { file, helpers })) if (key === '接着做') where.set(look, [...new Set([...(where.get(look) || []), file])].sort());
  assert.deepEqual(Object.fromEntries([...where].sort()), Object.fromEntries(Object.entries(entry.sites).sort().map(([look, files]) => [look, [...files].sort()])));
  assert.ok(entry.sites['-|-'].includes('ui/study-map/JobCard.jsx'));
  assert.ok(entry.sites['-|-'].includes('ui/coverage/CoverageTopUp.jsx'));
  assert.deepEqual(entry.sites['-|→'], ['ui/study-map/home-plan.js'], 'only the home plan\'s resume leaves');
  // the two new sites act on the job where it stands
  const card = fileOf(sources, 'ui/study-map/JobCard.jsx'), topUp = fileOf(sources, 'ui/coverage/CoverageTopUp.jsx');
  assert.match(card, /label: actionLabel\('continue'\), here: actionHere\('continue'\)/);
  assert.match(topUp, /iconEnd=\{actionHere\(action\) \? undefined : 'arrow-right'\}/);
  assert.match(entry.why, /JobCard|job card|任务卡|作业卡/i);
});

/* ---- 3: the receipt toast's 去主会话 carries the external mark ---------------------------------------------------------------------------------------------- */

test('3: a toast\'s primary action draws its `icon` in front (the notice, the error and the toast api pass it through), and the receipt\'s 去主会话 is `external`', async () => {
  const { m, render, drawn } = await draw();
  const html = (toast) => render(React.createElement(m.ToastRegion, { toasts: [toast], placement: 'page' }));
  const notice = m.noticeToToast({ text: '已填进输入框', action: { label: '去主会话', icon: 'external', run() {} } });
  assert.equal(notice.action.icon, 'external');
  assert.ok(drawn(html(notice), 'external'), 'a notice\'s primary action');
  const error = m.errorToToast({ text: '没成', action: { label: '去主会话', icon: 'external', run() {} } });
  assert.ok(drawn(html(error), 'external'), 'an error\'s primary action');
  const plain = html(m.noticeToToast({ text: '已保存', action: { label: '撤销', run() {} } }));
  assert.ok(!drawn(plain, 'external'), 'an action with no icon draws none');
  let shown;
  m.createToastApi({ setNotice: (value) => { shown = value; }, setError() {} }).show({ message: 'x', action: { label: '去主会话', icon: 'external', onClick() {} } });
  assert.equal(shown.action.icon, 'external', 'toast.show keeps the icon');
});

test('3: deliverToChat\'s 去主会话 (filled and kept) is `external`, as the toast draws it; 看看内容 (the card in StudyHub) draws no mark', async () => {
  const { m, render, drawn } = await draw();
  const notices = [];
  await m.deliverToChat({ host: { askInChat: async () => 'filled', showChat() {} }, prompt: 'x', notify: (notice) => notices.push(notice) });
  await m.deliverToChat({ host: { askInChat: async () => 'kept', showChat() {} }, prompt: 'x', notify: (notice) => notices.push(notice), clipboard: { writeText: async () => {} } });
  assert.equal(notices.length, 2);
  for (const notice of notices) {
    assert.equal(notice.action.icon, 'external', `${notice.receipt}: 去主会话`);
    const html = render(React.createElement(m.ToastRegion, { toasts: [m.noticeToToast(notice)], placement: 'page' }));
    assert.ok(drawn(html, 'external'), `${notice.receipt}: the toast draws the mark`);
    assert.match(html, /去主会话/);
  }
  const copied = [];
  await m.deliverToChat({ host: { askInChat: async () => false }, prompt: 'x', notify: (notice) => copied.push(notice), openSheet() {}, clipboard: { writeText: async () => {} } });
  assert.equal(copied[0].action.label, '看看内容');
  assert.equal(copied[0].action.icon, undefined, 'the full-text card is a view in StudyHub');
});

test('3: the drawers keep passing `icon` (the toast\'s primary, the notice and error mapping, the toast api)', async () => {
  const feedback = await read('ui/components/Feedback.jsx'), action = await read('ui/ActionFeedback.jsx'), hand = await read('ui/hand-off/use-hand-off.js');
  assert.match(feedback, /sh-toast__action" icon=\{action\.icon\} iconEnd=\{action\.iconEnd\}/);
  assert.match(action, /iconEnd: value\.action\.iconEnd, icon: value\.action\.icon|icon: value\.action\.icon, iconEnd: value\.action\.iconEnd/);
  assert.match(hand, /label: ui\(HAND_OFF_RECEIPTS\.kept\.action\), icon: 'external', run: \(\) => host\.showChat\(\)/);
});

/* ---- 4 (optional): the 先深度定制这本书？ dialog's recommended button stays inside the footer ---------------------------------------------------------------- */

test('4: the buttons of the gate dialog may take the footer width and wrap, so the recommended button never passes the footer padding (English at 420px)', async () => {
  const css = await read('ui/outline/outline.css');
  assert.match(css, /\.sh-dialog\[data-custom-gate\] \.sh-dialog__footer \[data-custom-gate-action\] \{[^}]*max-width: 100%;[^}]*white-space: normal;/);
  assert.match(css, /\.sh-dialog\[data-custom-gate\] \.sh-dialog__footer > \* \{ max-width: 100%; \}/);
});

void React;
