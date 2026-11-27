/* global document, NodeFilter, getComputedStyle */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChatPreview } from './helpers/chat-preview.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium, skipMissingChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';

/* #1127 in a real browser: the 先深度定制这本书？ dialog's recommended button (a 160-page converted book of the course 宏经, as tests/icon-round10-browser.test.mjs seeds it) wraps
   in English at the narrow widths; its icon stays beside the first line of words and level with it (it was 59px away at 420px, 8px is the usual gap; then centred between the two lines, 9px below the first line's middle), at 320, 375 and 420px, light and dark,
   and the button stays inside the dialog. ICON_ROUND12_SHOTS=<dir> keeps a picture of each. */

const SHOTS = process.env.ICON_ROUND12_SHOTS || '';
const at = '2026-11-01T08:00:00.000Z', PAGES = 160, COURSE = '宏经';
const fact = (topic, i) => `${topic} fact ${i}: aggregate demand, aggregate supply and the multiplier move output and prices in the short run.`;
const page = (n) => ({ id: `${COURSE}-p${n}`, title: `Macro book · p. ${n}`, text: Array.from({ length: 4 }, (_, i) => fact(`Page${n}`, i)).join(' '), createdAt: at, courses: [COURSE],
  document: { materialId: `document-${COURSE}-book`, page: n, totalPages: PAGES, format: 'pdf', origin: 'converted', converter: 'mineru', filename: `${COURSE}-book.pdf`, extractionVersion: 2 } });
const seed = async (root) => {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update((state) => {
    state.sources.push(...Array.from({ length: PAGES }, (_, index) => page(index + 1)));
    state.decks.push({ id: `deck-${COURSE}`, title: `${COURSE} deck`, course: COURSE, cards: [1, 2, 3].map((n) => ({ id: `q${n}`, kind: 'flashcard', topic: 'Output', prompt: `Question ${n}: what moves output in the short run?`,
      answer: 'Aggregate demand.', explanation: 'See the book.', citations: [{ sourceId: `${COURSE}-p${n}`, quote: fact(`Page${n}`, 1) }] })) });
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
  });
  await service.call('course.save', { name: COURSE });
  await service.dispose();
};

/** Where the icon sits against the lines of words of a button: the gap between the icon and the nearest line start, and how far the icon's middle is from the middle of the first line (0 when the icon is level with it). */
const measure = (button) => button.evaluate((element) => {
  const icon = element.querySelector('svg').getBoundingClientRect(), range = document.createRange(), box = element.getBoundingClientRect();
  range.selectNodeContents(element);
  const lines = [...range.getClientRects()].filter((rect) => rect.width > 4 && rect.height > 4 && rect.left >= icon.right - 1);
  const first = lines.reduce((top, rect) => (rect.top < top.top ? rect : top), lines[0]), middle = (icon.top + icon.bottom) / 2;
  return { gap: Math.round((Math.min(...lines.map((rect) => rect.left)) - icon.right) * 10) / 10, lines: new Set(lines.map((rect) => Math.round(rect.top))).size,
    offFirstLine: Math.round((middle - (first.top + first.bottom) / 2) * 10) / 10, fromCentre: Math.round((middle - (box.top + box.bottom) / 2) * 10) / 10, left: box.left, right: box.right };
});

test('#1127 in the browser: the recommended button of the gate dialog keeps its icon level with its first line (the middles within 2px) at 320, 375 and 420px (en, light and dark; zh at 420)', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { skipMissingChromium(t, error); return; }
  t.after(() => browser.close());
  const dist = await mkdtemp(join(tmpdir(), 'study-icon-round12-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await buildChatPreview({ outdir: dist });
  if (SHOTS) await mkdir(SHOTS, { recursive: true });
  let wrapped = 0;
  for (const lang of ['en', 'zh']) {
    const running = await startLateServer({ distDir: dist, seed, lang });
    try {
      for (const [theme, width] of lang === 'en' ? [['light', 320], ['dark', 320], ['light', 375], ['dark', 375], ['light', 420], ['dark', 420]] : [['light', 420]]) {
        const { page: view, context } = await openPage(browser, running, { lang, theme, width, height: 900 });
        try {
          const label = `${lang} ${theme} ${width}px`;
          await view.goto(running.server.url);
          await view.locator('.course-header .outline-entry').first().click();
          await view.locator('.outline-organise').waitFor({ timeout: 30000 });
          await view.getByRole('button', { name: lang === 'en' ? /Write the review book/ : '生成复习全书' }).first().click();
          const dialog = view.locator('dialog[data-custom-gate][open]');
          await dialog.waitFor({ timeout: 10000 });
          await settleAnimations(view);
          const button = dialog.locator('[data-custom-gate-action="custom"]'), found = await measure(button), box = await dialog.boundingBox();
          assert.ok(found.gap >= 0 && found.gap <= 12, `${label}: the icon is ${found.gap}px from the words (${JSON.stringify(found)})`);
          assert.ok(Math.abs(found.offFirstLine) <= 2, `${label}: the icon's middle is ${found.offFirstLine}px from the middle of the first line (${JSON.stringify(found)})`);
          assert.ok(found.left >= box.x && found.right <= box.x + box.width, `${label}: the button stays inside the dialog (${JSON.stringify(found)})`);
          if (found.lines > 1) wrapped += 1;
          else {
            const own = (await button.boundingBox()).height, other = (await dialog.locator('[data-custom-gate-action="whole"]').boundingBox()).height;
            assert.ok(Math.abs(own - other) <= 1, `${label}: a one-line recommended button is as tall as the next one (${own}px against ${other}px)`);
            assert.ok(Math.abs(found.fromCentre) <= 1.5, `${label}: the words and the icon of a one-line button sit in its middle (${JSON.stringify(found)})`);
          }
          if (SHOTS) await dialog.screenshot({ path: join(SHOTS, `gate-${lang}-${theme}-${width}.png`) });
        } finally { await context.close(); }
      }
    } finally { await running.close(); }
  }
  assert.ok(wrapped >= 2, `the button wrapped in ${wrapped} of the narrow cases: the measure means something`);
});

/* #1127 round 13: the recommended button keeps its look under the appearance settings. Density changes --space-8 (32px / 48px) but not the button's minimum height (40px), and 精致紧凑
   keeps 40px on a phone, so a padding worked out from a guessed height put the words 3.5px high (紧凑 at 1440), made the button 44px beside a 40px neighbour (精致紧凑 at 420) and
   48px beside 40px (宽松 at 1440). The button now does no height arithmetic: its own minimum height centres the block of words (a grid with align-content: center), the icon stays on the
   first line, the padding is the neighbours' own. A one-line button is as tall as 「整本生成」, its words are in the middle of it, and its padding is the neighbours'; a wrapped one has its
   icon level with its first line. */
const GATE_CASES = [
  { lang: 'zh', width: 1440, iface: { density: 'compact' } }, { lang: 'zh', width: 1440, iface: { density: 'comfortable' } }, { lang: 'zh', width: 420, iface: { craft: 'refined' } },
  { lang: 'en', width: 1440, iface: { density: 'comfortable' } }, { lang: 'en', width: 1440, iface: { density: 'compact' } }, { lang: 'en', width: 420, iface: { density: 'compact' } },
  { lang: 'en', width: 420, iface: { density: 'comfortable' } }, { lang: 'en', width: 420, iface: { craft: 'refined' } }, { lang: 'zh', width: 1440, iface: null }, { lang: 'en', width: 420, iface: null }];
test('#1127 round 13 in the browser: under 紧凑, 宽松 and 精致紧凑 the recommended gate button is as tall as its neighbour with its words in the middle (one line), or has its icon level with its first line (wrapped), with the same padding as the next button', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { skipMissingChromium(t, error); return; }
  t.after(() => browser.close());
  const dist = await mkdtemp(join(tmpdir(), 'study-icon-round13-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await buildChatPreview({ outdir: dist });
  if (SHOTS) await mkdir(SHOTS, { recursive: true });
  let oneLine = 0, wrapped = 0;
  for (const lang of ['en', 'zh']) {
    const running = await startLateServer({ distDir: dist, seed, lang });
    try {
      for (const { width, iface } of GATE_CASES.filter((one) => one.lang === lang)) {
        const { page: view, context } = await openPage(browser, running, { lang, theme: 'light', width, height: 900 });
        try {
          const label = `${lang} ${width}px ${JSON.stringify(iface)}`;
          if (iface) await context.addInitScript((value) => { try { localStorage.setItem('study-interface', value); } catch { /* blocked */ } }, JSON.stringify(iface));
          await view.goto(running.server.url);
          await view.locator('.course-header .outline-entry').first().click();
          await view.locator('.outline-organise').waitFor({ timeout: 30000 });
          await view.getByRole('button', { name: lang === 'en' ? /Write the review book/ : '生成复习全书' }).first().click();
          const dialog = view.locator('dialog[data-custom-gate][open]');
          await dialog.waitFor({ timeout: 10000 });
          await settleAnimations(view);
          const button = dialog.locator('[data-custom-gate-action="custom"]'), found = await measure(button);
          const sizes = await dialog.evaluate((root) => {
            const own = root.querySelector('[data-custom-gate-action="custom"]'), other = root.querySelector('[data-custom-gate-action="whole"]'), range = document.createRange();
            range.selectNodeContents(own);
            const icon = own.querySelector('svg').getBoundingClientRect(), words = [...range.getClientRects()].filter((rect) => rect.width > 4 && rect.height > 4 && rect.left >= icon.right - 1), box = own.getBoundingClientRect();
            const top = Math.min(...words.map((rect) => rect.top)), bottom = Math.max(...words.map((rect) => rect.bottom));
            return { own: box.height, other: other.getBoundingClientRect().height, wordsFromCentre: (top + bottom) / 2 - (box.top + box.bottom) / 2,
              pad: [getComputedStyle(own).paddingTop, getComputedStyle(own).paddingBottom].join('/'), padOther: [getComputedStyle(other).paddingTop, getComputedStyle(other).paddingBottom].join('/') };
          });
          assert.equal(sizes.pad, sizes.padOther, `${label}: the recommended button has its neighbour's padding (${JSON.stringify(sizes)})`);
          assert.ok(Math.abs(found.offFirstLine) <= 2, `${label}: the icon's middle is ${found.offFirstLine}px from the middle of the first line (${JSON.stringify(found)})`);
          if (found.lines > 1) wrapped += 1;
          else {
            oneLine += 1;
            assert.ok(Math.abs(sizes.own - sizes.other) <= 1, `${label}: a one-line recommended button is as tall as the next one (${sizes.own}px against ${sizes.other}px)`);
            assert.ok(Math.abs(sizes.wordsFromCentre) <= 1.5, `${label}: its words sit in the middle of the button, not ${sizes.wordsFromCentre}px off (${JSON.stringify(sizes)})`);
          }
          if (SHOTS) await dialog.screenshot({ path: join(SHOTS, `gate13-${lang}-${width}-${iface ? Object.values(iface)[0] : 'default'}.png`) });
        } finally { await context.close(); }
      }
    } finally { await running.close(); }
  }
  assert.ok(oneLine >= 6 && wrapped >= 1, `${oneLine} one-line and ${wrapped} wrapped cases: the measure means something`);
});

/* #1130 follow-up: the home line about the focus topics ("7 focus topics: 2 mastered · 2 not yet · 2 without questions") breaks only between its pieces, never inside one: the head
   ("7 focus topics:") and each count with its words ("2 without questions") stay whole on one line, at 320, 375 and 420px, light and dark (en), and in zh. At 420px it broke as
   "· 2" / "without questions" and "1 without" / "a question". A piece is looked up by its words in the button's text and measured by the line boxes of its characters. */
const FOCUS_COURSE = 'Operating Systems', DAY = 86400000;
const focusCard = (id, topic, review) => ({ id, kind: 'quiz', topic, objective: `Explain ${topic}`, prompt: `Question ${id} about ${topic}?`, answer: 'a', hint: 'h', explanation: 'e', misconception: 'm', citations: [],
  options: [{ id: 'a', text: 'Right', correct: true }, { id: 'b', text: 'Wrong', correct: false }], review });
const focusSeed = (spec) => async (root) => {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root), topics = [...spec].map((key, index) => `Topic${key}${index}`), day = (n) => new Date(Date.now() + n * DAY).toISOString();
  const fresh = { repetitions: 0, interval_days: 0, ease_factor: 2.5, due_at: null }, learned = (n) => ({ repetitions: 3, interval_days: n, ease_factor: 2.5, due_at: day(n) });
  await service.call('course.save', { name: FOCUS_COURSE, focusTopics: topics });
  await service.store.update((state) => {
    const cards = [], attempts = [];
    [...spec].forEach((key, index) => {
      const topic = topics[index];
      if (key === 'M') { cards.push(focusCard(`${topic}-a`, `${topic} one`, learned(30)), focusCard(`${topic}-b`, `${topic} two`, learned(30))); attempts.push([`${topic}-a`, 5, -4], [`${topic}-b`, 5, -4]); }
      if (key === 'W') { cards.push(focusCard(`${topic}-a`, `${topic} one`, learned(2))); attempts.push([`${topic}-a`, 1, -3]); }
      if (key === 'L') cards.push(focusCard(`${topic}-a`, `${topic} one`, fresh));
    });
    cards.push(focusCard('misc', 'File systems', learned(10)));
    state.decks.push({ id: 'os', title: 'OS fundamentals', course: FOCUS_COURSE, createdAt: '2026-09-01T00:00:00Z', cards });
    state.attempts.push(...attempts.map(([quiz, grade, when]) => ({ id: `a-${quiz}`, deckId: 'os', quiz_id: quiz, grade, assessment: 'graded', timestamp: day(when) })));
    state.focus = { mode: 'class', course: FOCUS_COURSE, role: '', jd: '', targetTopics: [] };
  });
  await service.dispose?.();
};
/** The line boxes each piece of words of the home focus line is drawn in: one entry per piece, the number of lines it spans. */
const focusLines = (summary, pieces) => summary.evaluate((element, wanted) => {
  const nodes = [], walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let all = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) { nodes.push({ node, start: all.length }); all += node.data; }
  const at = (offset) => { const hit = [...nodes].reverse().find((entry) => entry.start <= offset); return { node: hit.node, offset: offset - hit.start }; };
  return wanted.map((words) => {
    const index = all.indexOf(words);
    if (index < 0) return { words, lines: -1 };
    const range = document.createRange(), from = at(index), to = at(index + words.length - 1);
    range.setStart(from.node, from.offset); range.setEnd(to.node, to.offset + 1);
    const tops = [...range.getClientRects()].filter((rect) => rect.width > 1 && rect.height > 4).map((rect) => Math.round(rect.top / 4));
    return { words, lines: new Set(tops).size };
  });
}, pieces);

test('#1130 in the browser: the home focus line breaks only between its pieces, never inside a count and its words (320, 375, 420px; en light and dark, zh)', { timeout: 900000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { skipMissingChromium(t, error); return; }
  t.after(() => browser.close());
  const dist = await mkdtemp(join(tmpdir(), 'study-icon-round12-focus-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await buildPreview({ outdir: dist });
  if (SHOTS) await mkdir(SHOTS, { recursive: true });
  const cases = [
    { lang: 'en', spec: 'MMWWNNL', line: '7 focus topics: 2 mastered · 2 not yet · 2 without questions', pieces: ['7 focus topics:', '2 mastered', '2 not yet', '2 without questions'] },
    { lang: 'en', spec: 'MWN', line: '3 focus topics: 1 mastered · 1 not yet · 1 without a question', pieces: ['3 focus topics:', '1 mastered', '1 not yet', '1 without a question'] },
    { lang: 'zh', spec: 'MMWWNNL', line: '重点 7 条：已掌握 2 · 还不会 2 · 还没有题 2', pieces: ['重点 7 条：', '已掌握 2', '还不会 2', '还没有题 2'] },
  ];
  let wrapped = 0;
  for (const { lang, spec, line, pieces } of cases) {
    const running = await startLateServer({ distDir: dist, seed: focusSeed(spec), lang });
    try {
      for (const [theme, width] of lang === 'en' ? [['light', 320], ['dark', 320], ['light', 375], ['dark', 375], ['light', 420], ['dark', 420]] : [['light', 320], ['light', 375], ['dark', 420]]) {
        const { page: view, context } = await openPage(browser, running, { lang, theme, width, height: 900 });
        try {
          const label = `${lang} ${spec} ${theme} ${width}px`;
          await view.goto(running.server.url);
          const summary = view.locator('.focus-progress button').first();
          await summary.waitFor({ timeout: 30000 });
          await settleAnimations(view);
          assert.equal((await summary.innerText()).replace(/\s+/g, ' ').trim(), line, `${label}: the words of the line`);
          const found = await focusLines(summary, pieces), whole = await summary.evaluate((element) => { const range = document.createRange(); range.selectNodeContents(element); return new Set([...range.getClientRects()].filter((rect) => rect.width > 1 && rect.height > 4).map((rect) => Math.round(rect.top / 4))).size; });
          for (const piece of found) assert.equal(piece.lines, 1, `${label}: "${piece.words}" is drawn on ${piece.lines} lines (${JSON.stringify(found)})`);
          if (whole > 1) wrapped += 1;
          if (SHOTS) await view.locator('.focus-progress').first().screenshot({ path: join(SHOTS, `focus-${lang}-${spec}-${theme}-${width}.png`) });
        } finally { await context.close(); }
      }
    } finally { await running.close(); }
  }
  assert.ok(wrapped >= 3, `the line wrapped in ${wrapped} cases: the measure means something`);
});
