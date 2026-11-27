import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { uiSources } from './helpers/icon-stand-ins.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { actionProblems, buttonElements, clickDoes, externalProblems, goOnProblems, HAND_OFF_LOOK, HAND_OFF_SURFACES, labelHelpers, labelsOf, leadIconProblems, localHandlers, LOOK_EXCEPTIONS, looksOf, propOf, specProblems } from './helpers/go-on.mjs';

/* #1073, round 10 of the review of PR #1118 (the round-9 review, 0d908750):
     1  「总纲」 (list icon in front) and 「翻看全书」 (book icon in front) leave the page with no →: the gate could not read `onShowOutline` / `onFlip` where they are wired
        (a guard `cond ? onShowOutline : undefined`, a rest spread `{…handlers}`), so a leading icon on a control that leaves passed;
     2  the hand-off to the DSH main chat was drawn four ways (深度定制这本书 on the job card →, on the 解析历史 row plain, on the import row plain, in the gate dialog with a
        chat icon; 发给主会话 with no mark): one look, the `external` mark in front like a link to a DSH chat, and the gate resolves a label kept in a constant;
     3  接着做 is two actions that share words (a job's retry on its card, the home plan's resume of a practice run): the exception says which is which, and the gate
        checks where each look is drawn;
     4  the 资料 page's header read 「原文与引用一直保留。 共 2 份资料」 (a stray space in Chinese). */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
let cache;
const all = async () => {
  if (!cache) { const sources = await uiSources(); cache = { sources, helpers: labelHelpers(sources) }; }
  return cache;
};
const fileOf = (sources, file) => sources.find((entry) => entry.file === file)?.source ?? '';

/* ---- 1: a prop is read where it is wired, under its guard and through a rest spread ----------------------------------------------------------------------- */

test('1: a prop handed in under a guard is the prop (`cond ? onShowOutline : undefined`, `cond && onFlip`)', () => {
  const locals = new Map([['openBook', "{ nav.navigate('book'); }"]]);
  assert.equal(clickDoes("home.route?.chapters?.length ? openBook : undefined", locals), 'leave');
  assert.equal(clickDoes('ready && openBook', locals), 'leave');
  assert.equal(clickDoes("ready ? () => nav.navigate('outline') : undefined", locals), 'leave');
  assert.equal(clickDoes('() => setOpen(true)', locals), 'here', 'a closure that is not a guard is read as before');
});

test('1: 总纲 and 翻看全书 are read as leaving (wired to nav.navigate / onOpenBook, through a guard and a rest spread) and end in → with nothing in front', async () => {
  const { sources, helpers } = await all();
  for (const [file, label] of [['ui/study-map/OutlineEntry.jsx', '总纲'], ['ui/book/CrunchDay.jsx', '翻看全书']]) {
    const source = fileOf(sources, file), locals = localHandlers(source);
    const button = buttonElements(source).find(({ children }) => children.includes(`'${label}'`));
    assert.ok(button, `${file} has ${label}`);
    const click = propOf(button.open, 'onClick');
    assert.equal(clickDoes(click, locals, new Set(), { wiring: helpers.wiring, file, at: button.at }), 'leave', `${label}: its click leaves (${click})`);
    assert.deepEqual(leadIconProblems(source, { file, helpers }), [], `${file}: no icon in front of a control that leaves`);
    assert.ok(!/\sicon=/.test(button.open) && /iconEnd="arrow-right"/.test(button.open), `${label}: → at the end, nothing in front`);
    assert.deepEqual(looksOf(source, { file, helpers }).filter((entry) => entry.key === label).map((entry) => entry.look), ['-|→'], label);
  }
});

test('1: every Button whose click is an onShow… / onOpen… prop is read through its wiring, or acts where it stands (listed)', async () => {
  const { sources, helpers } = await all(), unread = [];
  let read = 0;
  for (const { file, source } of sources) {
    const locals = localHandlers(source);
    for (const { open, children, at } of buttonElements(source)) {
      const click = propOf(open, 'onClick').replace(/^\(\)\s*=>\s*/, '').replace(/\(.*$/s, '').trim();
      if (!/^on(?:Show|Open)[A-Z]\w*$/.test(click) || !labelsOf(children, helpers).length) continue;
      read++;
      if (!clickDoes(propOf(open, 'onClick'), locals, new Set(), { wiring: helpers.wiring, file, at })) unread.push(`${file}: ${click}`);
    }
  }
  assert.ok(read >= 5, `${read} Buttons read`);
  // onShowInactive of the 资料 page's filter is a switch on the page itself (it hides or shows what is already listed): it acts where it stands.
  assert.deepEqual(unread.filter((row) => !/PageScope\.jsx: onShowInactive$/.test(row)), []);
});

test('1: the whole of ui/ agrees with the rule: no control that leaves leads with an icon of its own, and the unread ones do not grow (a ratchet)', async () => {
  const { sources, helpers } = await all(), found = [], seen = {}, used = new Set();
  for (const { file, source } of sources) {
    for (const { label, open, want } of goOnProblems(source, { file, helpers, used, seen })) found.push(`${file}: ${label} wants ${want}  ${open.slice(0, 80)}`);
    for (const { label, open, want } of actionProblems(source, { file, helpers, used, seen })) found.push(`${file}: action ${label} wants ${want}  ${open.slice(0, 80)}`);
    for (const { label, open, want } of specProblems(source, { file })) found.push(`${file}: spec ${label} wants ${want}  ${open.slice(0, 80)}`);
    for (const { label, icon } of leadIconProblems(source, { file, helpers, used })) found.push(`${file}: ${label} leaves with ${icon} in front`);
    for (const { label, want } of externalProblems(source, { file })) found.push(`${file}: external ${label} wants ${want}`);
  }
  assert.deepEqual(found, []);
  // Round 9 left 230 to their words; reading a guard and a rest spread, 229; held places (data-reserved) are not controls, 228.
  assert.ok(seen.unknown <= 228, `the click decides for most Buttons (${JSON.stringify(seen)})`);
});

/* ---- 2: one look for the hand-off to the main chat ----------------------------------------------------------------------------------------------------------- */

test('2: the main chat is a window outside StudyHub: a hand-off call is `external`, so its control leads with the mark and never ends in →', () => {
  assert.equal(clickDoes("async () => { if (await handOff.send('custom.start', offer) === 'failed') return; }"), 'external');
  assert.equal(clickDoes('() => handOff.action("job.failed", input)'), 'external');
  assert.equal(clickDoes('() => actions.startCustom()'), 'external');
  assert.deepEqual(goOnProblems('<Button variant="primary" icon="chat" onClick={() => handOff.send("custom.start", {})}>{ui("深度定制这本书")}</Button>').map((problem) => problem.want),
    ['icon="external": it opens a window outside StudyHub']);
  assert.deepEqual(goOnProblems('<Button variant="primary" icon="external" onClick={() => handOff.send("custom.start", {})}>{ui("深度定制这本书")}</Button>'), []);
  assert.deepEqual(actionProblems("const a = { label: ui('深度定制这本书'), onClick: () => handOff.send('custom.start', {}) };").map((problem) => problem.want),
    ["icon: 'external' and no arrow: it opens a window outside StudyHub"]);
  assert.deepEqual(actionProblems("const a = { label: ui('深度定制这本书'), icon: 'external', onClick: () => handOff.send('custom.start', {}) };"), []);
  assert.deepEqual(specProblems("const a = { label: ui('深度定制这本书'), run: async () => { await handOff.send('custom.start', {}); } };", { file: 'ui/custom-convert-link.js' }).length, 1);
  assert.deepEqual(specProblems("const a = { label: ui('深度定制这本书'), icon: 'external', run: async () => { await handOff.send('custom.start', {}); } };", { file: 'ui/custom-convert-link.js' }), []);
});

test('2: a label kept in a constant is its words: ui(CUSTOM_BOOK_LABEL) is 深度定制这本书 to every gate', async () => {
  const { sources, helpers } = await all();
  assert.equal(helpers.constants.get('CUSTOM_BOOK_LABEL'), '深度定制这本书');
  assert.equal(helpers.constants.get('HAND_OFF_LABEL'), '发给主会话');
  assert.deepEqual(labelsOf('{ui(CUSTOM_BOOK_LABEL)}', helpers), ['深度定制这本书']);
  const look = (file) => looksOf(fileOf(sources, file), { file, helpers }).filter((entry) => entry.key === '深度定制这本书').map((entry) => entry.look);
  assert.deepEqual(look('ui/custom-convert-link.js'), [HAND_OFF_LOOK], 'the job card\'s link');
  assert.deepEqual(look('ui/ImportHub.jsx'), [HAND_OFF_LOOK], 'the import row');
  assert.deepEqual(look('ui/PdfConvertJob.jsx'), [HAND_OFF_LOOK], 'the 解析历史 row');
});

test('2: the hand-off to the main chat has one look wherever it is drawn: the `external` mark in front, nothing after', async () => {
  const { sources, helpers } = await all(), byKey = new Map();
  for (const { file, source } of sources) {
    for (const { key, look, line } of looksOf(source, { file, helpers })) if (['深度定制这本书', '发给主会话'].includes(key)) byKey.set(key, [...(byKey.get(key) || []), `${look} ${file}:${line}`]);
  }
  for (const key of ['深度定制这本书', '发给主会话']) {
    const rows = byKey.get(key) || [];
    assert.ok(rows.length >= 3, `${key}: ${rows.length} places read`);
    assert.deepEqual(rows.filter((row) => !row.startsWith(`${HAND_OFF_LOOK} `)), [], key);
  }
  const gate = fileOf(sources, 'ui/outline/CustomGate.jsx');
  assert.match(gate, /icon="external"[^>]*data-custom-gate-action="custom"/, 'the gate dialog\'s button leads with external');
  assert.doesNotMatch(gate, /icon="chat"/);
});

test('2: each file the gate trusts to draw a hand-off (HAND_OFF_SURFACES) does draw the external mark, and says why', async () => {
  const { sources } = await all();
  for (const entry of HAND_OFF_SURFACES) {
    assert.match(fileOf(sources, entry.file), /icon(?:=\{?"|: ')external/, `${entry.file}: draws the external mark`);
    assert.ok(entry.why.length > 30, `${entry.file}: say why`);
  }
});

const draw = async () => {
  const m = await loadUi(`
    export { HandOff, HandOffButton, HandOffForm } from './ui/hand-off/HandOff.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { InlineMessage, Banner, ToastRegion } from './ui/components/Feedback.jsx';
    export { default as FileDrop } from './ui/components/FileDrop.jsx';
    export { useHandOff } from './ui/hand-off/use-hand-off.js';
    export { ICON_PATHS } from './ui/components/icon-paths.js';
    export { setUiLanguage } from './ui/i18n.js';`);
  m.setUiLanguage('zh');
  const services = { askInChat: async () => 'filled', notify: () => {} };
  return { m, render: (element) => renderToStaticMarkup(React.createElement(m.StudyServicesContext.Provider, { value: services }, element)),
    drawn: (html, name) => html.includes([].concat(m.ICON_PATHS[name])[0].slice(0, 40)) };
};

test('2: HandOff draws the external mark in front in every shape with words (a link, a quiet line, the submit of the form), and never the chat glyph or an arrow (the icon-only shape: round 11)', async () => {
  const { m, render, drawn } = await draw();
  for (const shape of ['link', 'quiet', 'secondary']) {
    const html = render(React.createElement(m.HandOff, { id: 'deck.ask', input: {}, shape }));
    assert.ok(drawn(html, 'external'), `${shape}: the external mark`);
    assert.ok(!drawn(html, 'chat') && !drawn(html, 'arrow-right'), `${shape}: no chat glyph, no arrow`);
  }
  const labelled = render(React.createElement(m.HandOff, { id: 'custom.start', input: {}, shape: 'link', label: '深度定制这本书' }));
  assert.match(labelled, /深度定制这本书/);
  assert.ok(drawn(labelled, 'external'));
  const form = render(React.createElement(m.HandOffForm, { id: 'skeleton.extend', input: (text) => ({ text }), chips: [], placeholder: 'x' }));
  assert.ok(drawn(form, 'external'), 'the form\'s 发给主会话 submit');
  const button = render(React.createElement(m.HandOffButton, { shape: 'quiet', onClick() {} }));
  assert.ok(drawn(button, 'external'), 'the button alone (the book\'s 问 AI form and selection bar)');
});

test('2: a hand-off handed to a message, a card or a drop zone as an action carries `icon: external`, and each of them draws it', async () => {
  const { m, render, drawn } = await draw();
  const holder = {};
  function Probe() { holder.api = m.useHandOff(); return null; }
  const asked = [];
  const api = (() => {
    // useHandOff is a hook of the study context: read its `action` through a tiny host.
    const services = { askInChat: async (text) => { asked.push(text); return 'filled'; }, notify: () => {} };
    renderToStaticMarkup(React.createElement(m.StudyServicesContext.Provider, { value: services }, React.createElement(Probe)));
    return holder.api;
  })();
  const action = api.action('job.failed', {}, { what: 'x' });
  assert.equal(action.icon, 'external', 'useHandOff().action says what it draws');
  const inline = render(React.createElement(m.InlineMessage, { tone: 'warning', secondary: action }, '没导入'));
  assert.ok(drawn(inline, 'external'), 'an inline message\'s secondary');
  const banner = render(React.createElement(m.Banner, { tone: 'warning', secondary: action }, '没导入'));
  assert.ok(drawn(banner, 'external'), 'a banner\'s secondary');
  const drop = render(React.createElement(m.FileDrop, { label: 'drop', onFiles() {}, items: [{ id: 'a', name: 'a.pdf', status: 'done', action: { label: '深度定制这本书', icon: 'external', onClick() {} } }] }));
  assert.ok(drawn(drop, 'external'), 'a row of the drop zone\'s list');
});

test('2: the job card draws a link\'s `icon` in front and no arrow after it; 深度定制这本书 carries it', async () => {
  const { sources } = await all();
  const card = fileOf(sources, 'ui/tasks/CompactJobCard.jsx');
  const link = card.split('\n').find((line) => line.includes('const button = <Button key={link.label}')) || '';
  assert.match(link, /icon=\{link\.icon\}/, 'the card draws link.icon in front');
  assert.match(link, /iconEnd=\{link\.here \|\| link\.icon \? undefined : 'arrow-right'\}/, 'and no arrow after an icon (a way that acts in place has none either)');
  const custom = fileOf(sources, 'ui/custom-convert-link.js');
  assert.match(custom, /icon: 'external'/);
});

test('2: DESIGN.md writes the one look of a hand-off, and that a menu item shows the rule as its hint instead', async () => {
  const design = await read('ui/DESIGN.md');
  assert.match(design, /hand-off to the main chat[^\n]*`external`[^\n]*in front/i);
  assert.match(design, /menu item[^\n]*hint/i);
});

/* ---- 3: 接着做 names two actions; the gate says where each is drawn --------------------------------------------------------------------------------------- */

test('3: 接着做 is two actions and the exception says which: the retry of a job (acts on its card, no arrow) and the home plan\'s resume of a practice run (goes to the run, →)', async () => {
  const { sources, helpers } = await all();
  const entry = LOOK_EXCEPTIONS.find((item) => item.key === '接着做');
  assert.ok(entry?.sites, '接着做 lists where each look is drawn');
  assert.match(entry.why, /重试|retr/i);
  assert.match(entry.why, /练习|practice/i);
  const where = new Map();
  for (const { file, source } of sources) for (const { key, look } of looksOf(source, { file, helpers })) if (key === '接着做') where.set(look, [...new Set([...(where.get(look) || []), file])].sort());
  assert.deepEqual(Object.fromEntries([...where].sort()), Object.fromEntries(Object.entries(entry.sites).sort().map(([look, files]) => [look, [...files].sort()])));
  // The two really differ: the home plan's run is a resume of a practice run (`resume(…)` leaves for the run); a job's retry is a data action of the card.
  const plan = fileOf(sources, 'ui/study-map/home-plan.js'), pdf = fileOf(sources, 'ui/PdfConvertJob.jsx');
  assert.match(plan, /label: ui\('接着做'\), run: \(\) => resume\(lastOpen\.id\)/);
  assert.match(pdf, /label: ui\('接着做'\), here: true, run: retry/);
});

/* ---- 4: the 资料 page's header ------------------------------------------------------------------------------------------------------------------------------ */

test('4: the 资料 header joins its two parts properly: no space after 。 in Chinese, one space after a full stop in English', async () => {
  const m = await loadUi("export { joinSummary } from './ui/Sources.jsx'; export { setUiLanguage, uiFormat, ui } from './ui/i18n.js';");
  const lead = (language) => { m.setUiLanguage(language); return m.ui('题目从这里生长。原文与引用一直保留。'); };
  const summary = (counts) => m.uiFormat(' 共 {0} 份资料，按课程分为 {1} 组。', counts);
  try {
    assert.equal(m.joinSummary(lead('zh'), summary([2, 1])), '题目从这里生长。原文与引用一直保留。共 2 份资料，按课程分为 1 组。');
    assert.equal(m.joinSummary(lead('en'), summary([1, 1])), 'Questions grow from these sources. Original text and citations are retained. 1 source, grouped by course (1 group).');
    assert.equal(m.joinSummary(lead('en'), summary([2, 3])), 'Questions grow from these sources. Original text and citations are retained. 2 sources, grouped by course (3 groups).');
  } finally { m.setUiLanguage('zh'); }
  const sources = await read('ui/Sources.jsx');
  assert.match(sources, /joinSummary\(ui\("题目从这里生长。原文与引用一直保留。"\), items\.length > 0 \? groupSummaryDescription\(/);
  assert.doesNotMatch(sources, /\{ui\("题目从这里生长。原文与引用一直保留。"\)\}\{items\.length/);
});

/* ---- #1606: a held place is not a control ------------------------------------------------------------------------------------------------------------------- */

test('#1606: a Button that only holds a place (data-reserved, aria-hidden, disabled) is not read as a control; one missing any of the three still is', () => {
  const read = (open) => { const seen = {}; goOnProblems(`const A = () => ${open}{ui('看原页')}</Button>;`, { seen }); return seen; };
  assert.equal(read('<Button data-reserved="" aria-hidden="true" tabIndex={-1} disabled>').reserved, 1);
  assert.equal(read('<Button data-reserved="" aria-hidden="true" tabIndex={-1} disabled>').unknown, undefined);
  for (const open of ['<Button data-reserved="" aria-hidden="true">', '<Button data-reserved="" disabled>', '<Button aria-hidden="true" disabled>']) {
    const seen = read(open);
    assert.equal(seen.reserved, undefined, open);
    assert.equal(seen.unknown, 1, open);
  }
});

void React;
