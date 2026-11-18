import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { uiSources } from './helpers/icon-stand-ins.mjs';
import { ICON_ONLY_HAND_OFF_LOOK, ICON_ONLY_SUFFIX, labelHelpers, LOOK_EXCEPTIONS, looksOf } from './helpers/go-on.mjs';

/* #1073 follow-ups #1127–#1131 of the release review of 4.11.3 (the round-11 review of PR #1118):
     1127  the gate dialog's recommended button, wrapped at 420px in English, drew its icon far from the first line (the browser measure is tests/icon-round12-browser.test.mjs);
     1128  为没覆盖的部分补题 was drawn two ways (a sparkle on the 资料 row and in the reader, nothing on the draft page, the job card and the console), with an exception whose
           reason did not tell them apart: one look now (no icon, no arrow), the exception is gone;
     1129  the look gate recorded the icon-only hand-off as `external|-` while the screen draws the chat glyph: it records what is drawn;
     1130  the English home line read "Focus topics 1: No questions 1" (tests/focus-progress-ui.test.mjs);
     1131  course-outline-browser failed on some days (tests/course-outline-browser.test.mjs). */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
let cache;
const all = async () => {
  if (!cache) { const sources = await uiSources(); cache = { sources, helpers: labelHelpers(sources) }; }
  return cache;
};
const TOP_UP = '为没覆盖的部分补题';

test('1128: 为没覆盖的部分补题 has one look wherever it is drawn (no icon, no arrow), and it is not an exception any more', async () => {
  const { sources, helpers } = await all(), found = new Map();
  for (const { file, source } of sources) for (const { key, look } of looksOf(source, { file, helpers })) if (key === TOP_UP) found.set(look, [...(found.get(look) || []), file]);
  assert.deepEqual([...found.keys()], ['-|-'], `${TOP_UP}: ${JSON.stringify([...found])}`);
  assert.deepEqual([...new Set(found.get('-|-'))].sort(), ['ui/coverage/CoverageTopUp.jsx', 'ui/coverage/DocumentTopUp.jsx', 'ui/study-map/JobCard.jsx'], 'the sites the gate reads');
  assert.equal(LOOK_EXCEPTIONS.some((entry) => entry.key === TOP_UP), false, 'the exception is deleted');
});

test('1128: the 资料 row\'s and the reader\'s trigger (DocumentTopUp) leads with no icon, like the button of the draft page and the console\'s popover', async () => {
  const source = await read('ui/coverage/DocumentTopUp.jsx'), trigger = /<Button ref=\{ref\}[^>]*>/.exec(source)?.[0] ?? '';
  assert.ok(trigger.includes('data-document-topup-open'), 'found the trigger');
  assert.doesNotMatch(trigger, /\sicon(?:End)?=/, 'no icon, no arrow');
  const css = await read('ui/coverage/coverage.css');
  assert.doesNotMatch(css, /cov-topup-trigger[^}]*16px/, 'the width of the label does not leave room for an icon any more');
});

test('1129: the look gate records the icon-only hand-off as the chat glyph it draws, under its own entry, and the other shapes as the external mark', async () => {
  const icon = looksOf('<HandOff id="topic.explain" shape="icon" what="x" />', { file: 'ui/study-map/DeckRow.jsx' });
  assert.deepEqual(icon.map(({ key, look }) => `${key}=${look}`), [`发给主会话${ICON_ONLY_SUFFIX}=chat|-`]);
  assert.equal(ICON_ONLY_HAND_OFF_LOOK, 'chat|-');
  for (const shape of ['link', 'quiet', 'secondary']) {
    assert.deepEqual(looksOf(`<HandOff id="deck.ask" shape="${shape}" />`, { file: 'ui/X.jsx' }).map(({ key, look }) => `${key}=${look}`), ['发给主会话=external|-'], shape);
  }
  assert.deepEqual(looksOf('<HandOff id="deck.ask" />', { file: 'ui/X.jsx' }).map(({ look }) => look), ['external|-'], 'the default shape');
  assert.deepEqual(looksOf("<HandOff id=\"x\" shape={'icon'} label=\"带着错题回主会话\" />", { file: 'ui/X.jsx' }).map(({ key, look }) => `${key}=${look}`), [`带着错题回主会话${ICON_ONLY_SUFFIX}=chat|-`], 'a label of its own');
});

test('1129: the topic row\'s record matches the screen: the only icon-only hand-off of ui/ reads chat|-, and no words of ui/ read chat', async () => {
  const { sources, helpers } = await all(), chat = [], words = [];
  for (const { file, source } of sources) for (const { key, look } of looksOf(source, { file, helpers })) {
    if (look === 'chat|-') chat.push(`${file}: ${key}`);
    if (key === '发给主会话' && look !== 'external|-') words.push(`${file}: ${look}`);
  }
  assert.deepEqual(chat, [`ui/study-map/DeckRow.jsx: 发给主会话${ICON_ONLY_SUFFIX}`]);
  assert.deepEqual(words, [], 'the words of 发给主会话 keep the external mark');
});

test('1127: the wrapped lines of the gate dialog\'s buttons start beside the icon (not centred in a box as wide as the button)', async () => {
  const css = await read('ui/outline/outline.css');
  assert.match(css, /\.sh-dialog\[data-custom-gate\] \.sh-dialog__footer \[data-custom-gate-action\] \{[^}]*white-space: normal;[^}]*text-align: start;/);
  assert.doesNotMatch(css, /\[data-custom-gate-action\] \{[^}]*text-align: center/);
});
