/* global document, window, MutationObserver, requestAnimationFrame */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { Store } from '../lib/store.js';
import { followupDigest } from '../lib/followup.js';
import { openPage, startLateServer } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { until } from './helpers/wait.mjs';
import { makeTextPdf } from './helpers/text-pdf.mjs';

/* #1013 in the real page: a converted book of 500 pages (25 chapters of 20) and three questions on its first pages. The learning panel opens with 本节题目
   at the top; opening it changes nothing in the drawn text (no DOM mutation in .study-document-body) and leaves the reading place where it was (the
   element at the top of the text stays at the same height). The second question of the list is opened with the keyboard and the round answered with the
   practice page's keys (a number picks an option, Enter goes on); the text does not move meanwhile; 回到题目列表 brings the list back, focus on the row
   the round was opened from, the text still in place, and 错题 1 under the heading (the wrong book the practice page writes). Then 1280 / 420 px in zh and
   en (and 1000 px, where the text column narrows by half as the panel opens: the browser's scroll anchoring keeps the place): the panel fits, and the
   English panel has no Chinese; 做这几页的题 › 在这里做 starts the round here, 去练习页继续 takes it to the practice page. Pictures go to READER_INLINE_SHOTS when set. */

const at = '2026-11-01T08:00:00.000Z';
const PAGES = 500, PER_CHAPTER = 20;
const REFUSED = /Failed to load resource: the server responded with a status of 400/;
const chapterOf = page => Math.floor((page - 1) / PER_CHAPTER);
const pageText = page => [`Heading ${page}`, ...[1, 2, 3, 4].map(n => `Paragraph ${n} of page ${page}: output relates to demand through spending, saving and the multiplier, read slowly.`)].join('\n\n');
const source = page => ({ id: `book-p${page}`, title: `Book · p.${page}`, text: pageText(page), createdAt: at, courses: ['Macro'],
  document: { id: 'inline-book-hash', materialId: 'document-inline-book', page, totalPages: PAGES, format: 'pdf', origin: 'converted', converter: 'mineru', filename: 'inline-book.pdf',
    extractionVersion: 2, chapter: { index: chapterOf(page), title: `Chapter ${chapterOf(page) + 1}`, level: 1 } } });
const question = (id, page) => ({ id, kind: 'quiz', topic: 'Demand', objective: `Objective ${id}`, prompt: `Question ${id} about page ${page}?`, answer: 'Right',
  options: [{ id: 'r', text: 'Right', correct: true, explanation: 'It is.' }, { id: 'w', text: 'Wrong', correct: false, explanation: 'It is not.' }],
  explanation: 'Because.', misconception: 'None.', citations: [{ sourceId: `book-p${page}`, quote: `Paragraph 2 of page ${page}` }] });

const seed = async root => {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const c = question('c', 2);
  // A 追问 kept on c (lib/followup.js: on the question's current wording).
  c.followups = [{ id: 'f1', question: 'Why does saving lower demand here?', answer: 'Because less is spent.', at, digest: followupDigest(c) }];
  await service.store.update(state => {
    state.sources.push(...Array.from({ length: PAGES }, (_, index) => source(index + 1)));
    state.decks.push({ id: 'd1', title: 'Demand', course: 'Macro', cards: [question('a', 1), question('b', 1), c] });
  });
  await service.dispose();
  // An imported PDF of six pages (it has 原始 PDF): two questions on its first page, the first citing page 5 as well.
  const runtime = createStudyRuntime(root);
  const lecture = Array.from({ length: 6 }, (_, i) => [`Lecture page ${i + 1}: the main idea of part ${i + 1}.`, ...[1, 2, 3].map(n => `Line ${n} of page ${i + 1} explains part ${i + 1} of the lecture in plain words.`)]);
  const book = await runtime.call('materials.document.import', { filename: 'Lecture.pdf', dataBase64: (await makeTextPdf(lecture)).toString('base64'), courses: ['Macro'] });
  runtime.dispose();
  const cite = page => ({ sourceId: book.sourceIds[page - 1], quote: `Line 3 of page ${page} explains part ${page}` });
  const lectureCard = (id, cites) => ({ ...question(id, 1), prompt: `Lecture question ${id}?`, citations: cites.map(cite) });
  const again = new StudyService(root);
  await again.store.update(state => {
    state.decks.push({ id: 'dk', title: 'Lecture', course: 'Macro', cards: [lectureCard('p', [1, 5]), lectureCard('q', [1])] });
    // Imported the same day as the book, so both are in the one (open) group of 资料.
    for (const item of state.sources) if (book.sourceIds.includes(item.id)) item.createdAt = at;
  });
  await again.dispose();
};

/** One build and one library for the tests of this file, closed once all of them ran. */
let shared = null;
const cleanups = [];
after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });
const setup = () => (shared ??= (async () => {
  const browser = await launchChromium();
  cleanups.push(() => browser.close());
  const dist = await mkdtemp(join(tmpdir(), 'study-reader-inline-dist-'));
  cleanups.push(() => rm(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  cleanups.push(() => running.close?.());
  return { browser, running };
})());

/** 更多 › an item (tests/helpers/reader-more.mjs, in either language). */
const chooseMore = async (page, viewer, more, text) => {
  await viewer.getByRole('button', { name: more, exact: true }).click();
  await page.locator('.sh-menu [role^="menuitem"]', { hasText: text }).first().click();
};

const WORDS = {
  zh: { more: '更多', tools: '学习工具', sources: 'inline-book', heading: '本节题目', chapter: /^本章/, back: '回到题目列表', here: '在这里做', continue: '去练习页继续', done: /答对 2 \/ 3/, wrong1: /错题 1/, follow1: /追问 1/ },
  en: { more: 'More', tools: 'Study tools', sources: 'inline-book', heading: 'This section\'s questions', chapter: /^This chapter/, back: 'Back to the question list', here: 'Answer here', continue: 'Continue on the practice page', done: /2 \/ 3 right/,
    wrong1: /Mistakes 1/, follow1: /Follow-up 1/ },
};

test('本节题目: answered beside the text with the practice page\'s keys; the text never moves; 错题 n follows (#1013)', { timeout: 600000 }, async t => {
  let browser, running;
  try { ({ browser, running } = await setup()); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const attempts = async () => (await new Store(join(running.base, 'library')).read()).attempts.length;
  const shots = process.env.READER_INLINE_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });

  for (const [lang, width] of [['zh', 1280], ['zh', 1000], ['zh', 420], ['en', 1280], ['en', 420]]) {
    const words = WORDS[lang], full = lang === 'zh' && width === 1280;
    const { page, errors, context } = await openPage(browser, running, { lang, width, height: 900 });
    await context.addInitScript(() => { try { window.localStorage.setItem('study-autopilot', 'off'); } catch { /* blocked */ } });
    const shot = async name => { if (shots) await page.screenshot({ path: join(shots, `inline-${lang}-${width}-${name}.png`) }); };
    const viewer = page.locator('.study-document-viewer'), tools = viewer.locator('[data-tour="source-tools"]'), panel = viewer.locator('[data-tour="reader-section-practice"]');
    const scroller = viewer.locator('.reader-scroll');
    await page.goto(running.server.url);
    await (await revealNavRow(page, 'sources')).dispatchEvent('click');
    const row = page.locator('.source-doc', { hasText: words.sources }).first();
    await row.waitFor({ timeout: 60000 });
    await row.locator('.source-main').click();
    await viewer.locator('.reader-section[data-study-page]').first().waitFor({ timeout: 60000 });
    await until(async () => (await viewer.locator('.reader-section[data-study-page]').count()) === PER_CHAPTER, 'one chapter of the 500 pages drawn', { timeoutMs: 30000 });
    if (await tools.isVisible()) { await chooseMore(page, viewer, words.more, words.tools); await until(async () => !(await tools.isVisible()), 'the panel to close'); }

    // Read into page 3 (the pages before it reflow when the column narrows), then watch the drawn text and the reading place while the panel opens.
    await scroller.evaluate(node => { const first = node.querySelector('.reader-section[data-study-page="3"]'); node.scrollTop = first.offsetTop + first.offsetHeight * 0.35; });
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    const place = () => scroller.evaluate(node => {
      const area = node.getBoundingClientRect(), hit = document.elementFromPoint(area.left + area.width * 0.5, area.top + 8);
      window.__inlineAnchor = window.__inlineAnchor && window.__inlineAnchor.isConnected ? window.__inlineAnchor : hit;
      return { scrollTop: node.scrollTop, top: window.__inlineAnchor.getBoundingClientRect().top - area.top };
    });
    const before = await place();
    await page.evaluate(() => {
      window.__inlineMutations = 0;
      new MutationObserver(records => { window.__inlineMutations += records.filter(record => record.type !== 'attributes').length; })
        .observe(document.querySelector('.study-document-viewer .study-document-body'), { childList: true, characterData: true, subtree: true });
    });
    const mutations = () => page.evaluate(() => window.__inlineMutations);
    await chooseMore(page, viewer, words.more, words.tools);
    await panel.waitFor({ timeout: 30000 });
    assert.equal(await panel.getByRole('heading', { name: words.heading }).count(), 1);
    await panel.locator('[data-testid="section-stats"]').waitFor();
    await page.waitForTimeout(400); // the 追问 read settles after 250 ms
    const opened = await place();
    t.diagnostic(`${lang} ${width}px: opening the panel: ${await mutations()} mutations in the text, top element ${before.top.toFixed(1)} → ${opened.top.toFixed(1)} px, scrollTop ${before.scrollTop} → ${opened.scrollTop}`);
    assert.equal(await mutations(), 0, `${lang} ${width}px: opening the panel changes nothing in the drawn text`);
    assert.ok(Math.abs(opened.top - before.top) < 2, `${lang} ${width}px: the reading place stays (${before.top} → ${opened.top})`);

    // 本章: the chapter's three questions, in the order of the text, and 追问 1 (kept on c).
    const chapterChoice = panel.getByRole('button', { name: words.chapter });
    if (await chapterChoice.count()) await chapterChoice.click();
    await until(async () => (await panel.locator('[data-section-card]').count()) === 3, 'the three questions of the chapter');
    assert.deepEqual(await panel.locator('[data-section-card]').evaluateAll(nodes => nodes.map(node => node.dataset.sectionCard)), ['d1|a', 'd1|b', 'd1|c']);
    await until(async () => words.follow1.test(await panel.locator('[data-testid="section-stats"]').innerText()), '追问 1');
    if (lang === 'zh' && width === 1000) {
      // 错题 n is read once per library version: the panel closed and opened again reads nothing again.
      let reads = 0;
      page.on('request', request => {
        try { if (request.url().endsWith('/api/call') && JSON.parse(request.postData() || '{}').action === 'wrongbook') reads++; } catch { /* not JSON */ }
      });
      for (let round = 0; round < 2; round++) {
        await chooseMore(page, viewer, words.more, words.tools);
        await until(async () => !(await tools.isVisible()), 'the panel to close');
        await chooseMore(page, viewer, words.more, words.tools);
        await panel.locator('[data-testid="section-stats"]').waitFor();
      }
      await page.waitForTimeout(600);
      assert.equal(reads, 0, `${lang} ${width}px: the 错题 of the panel are not read again while nothing changed`);
    }
    if (width === 420) {
      const fits = await tools.evaluate(node => node.scrollWidth <= node.clientWidth + 1);
      assert.ok(fits, `${lang} ${width}px: the panel does not scroll sideways`);
    }
    if (lang === 'en') {
      const text = await panel.innerText();
      assert.doesNotMatch(text.replace(/Question [a-c] about page \d+\?/g, ''), /[一-鿿]/, `${lang} ${width}px: the English panel has no Chinese: ${text}`);
    }
    await shot('list');
    if (full) {
      // 追问 1 lists the follow-up kept on c, with the way to answer c here.
      const follow = panel.locator('[data-testid="section-stats"]').getByRole('button', { name: words.follow1 });
      await follow.click();
      const asked = page.locator('.section-practice__qa-panel');
      await asked.getByText('Why does saving lower demand here?').waitFor({ timeout: 15000 });
      assert.equal(await asked.getByRole('button', { name: '在这里做这道题' }).count(), 0, 'the answer is folded until opened');
      await shot('followups');
      await follow.click();
      await until(async () => !(await asked.isVisible()), 'the follow-ups to close');
    }

    const round = panel.locator('[data-inline-run]');
    if (lang === 'en' && width === 1280) {
      // 做这几页的题 (P) › 在这里做: the range chosen there, answered in the panel.
      await scroller.focus();
      await page.keyboard.press('p');
      await page.locator('.reader-practice__panel').getByRole('button', { name: words.here, exact: true }).click();
      await round.locator('.options button.option').first().waitFor({ timeout: 30000 });
    } else {
      // The keyboard: the row of b, Enter; the round opens at b inside the panel.
      await panel.locator('[data-section-card="d1|b"]').focus();
      await page.keyboard.press('Enter');
      await round.locator('.options button.option').first().waitFor({ timeout: 30000 });
      assert.match(await round.innerText(), /Question b about page 1\?/);
    }
    const placeInRound = await place();
    assert.equal(placeInRound.scrollTop, opened.scrollTop, `${lang} ${width}px: starting the round does not move the text`);
    await shot('round');
    if (lang === 'en' && width === 420) {
      // ? shows the round's keys; Esc closes that sheet first, then the panel (one press, one layer).
      await page.keyboard.press('?');
      const sheet = page.locator('.shortcut-sheet');
      await sheet.waitFor({ timeout: 10000 });
      await page.keyboard.press('Escape');
      await until(async () => !(await sheet.count()), 'Esc to close the key sheet first');
      assert.ok(await tools.isVisible(), `${lang} ${width}px: the first Esc closed the key sheet, not the panel`);
      // The panel hidden, the round in it takes no key: a number, Enter, K and Space do nothing to it.
      const hiddenFrom = await attempts();
      await round.focus();
      await page.keyboard.press('Escape');
      await until(async () => !(await tools.isVisible()), 'the panel to hide');
      for (const key of ['1', 'Enter', 'k', ' ']) await page.keyboard.press(key);
      await page.waitForTimeout(800);
      await chooseMore(page, viewer, words.more, words.tools);
      await round.locator('.options button.option').first().waitFor({ timeout: 15000 });
      assert.equal(await round.locator('.options button.option.correct, .options button.option.incorrect').count(), 0, `${lang} ${width}px: the hidden round was not answered`);
      assert.match(await round.innerText(), /Question b about page 1\?/, `${lang} ${width}px: the hidden round did not move on`);
      assert.equal(await attempts(), hiddenFrom, `${lang} ${width}px: nothing was recorded while hidden`);
    }
    if (lang === 'zh' && width === 420) {
      // Answered, the question's learning actions (#1026: 逐步理解 · 用自己的话讲一遍 · 试一道同类题) are under it in the narrow panel, which still fits.
      const wrongIndex = await round.locator('.options button.option').evaluateAll(nodes => nodes.findIndex(node => node.innerText.includes('Wrong')));
      await until(async () => { await page.keyboard.press(String(wrongIndex + 1)); return (await round.locator('.options button.option.incorrect').count()) > 0; }, 'b answered');
      const actions = round.locator('.assist-actions');
      await actions.waitFor({ timeout: 15000 });
      await actions.getByRole('button', { name: '用自己的话讲一遍' }).click();
      await page.waitForTimeout(400);
      const overflow = await tools.evaluate(node => [node.scrollWidth - node.clientWidth,
        ...[...node.querySelectorAll('.assist-actions, .assist-actions > *, [data-inline-run] textarea')].map(item => Math.round(item.getBoundingClientRect().right - node.getBoundingClientRect().right))]);
      t.diagnostic(`${lang} ${width}px: learning actions in the round: overflow ${JSON.stringify(overflow)}`);
      assert.ok(overflow.every(value => value <= 1), `${lang} ${width}px: the learning actions fit the panel (${overflow})`);
      await shot('learning-actions');
      // 去练习页继续 while the round cannot be opened there: the reader and its round stay (the reader gives way only to an opened round).
      const refuse = route => { try { if (JSON.parse(route.request().postData() || '{}').action === 'review.get') return route.abort(); } catch { /* not JSON */ } return route.continue(); };
      await page.route('**/api/call', refuse);
      await round.getByRole('button', { name: words.continue }).click();
      await page.waitForTimeout(1500);
      assert.equal(await viewer.count(), 1, `${lang} ${width}px: the reader stays when the round could not be opened on the practice page`);
      assert.equal(await round.count(), 1, `${lang} ${width}px: with its round`);
      await page.unroute('**/api/call', refuse);
      // 去练习页继续: the same round on the practice page (the reader gives way).
      await round.getByRole('button', { name: words.continue }).click();
      await until(async () => !(await viewer.count()), 'the reader to give way', { timeoutMs: 30000 });
      await page.locator('.question-card').waitFor({ timeout: 30000 });
      assert.match(await page.locator('.question-card .question').first().innerText(), /Question b about page 1\?/);
      await shot('practice-page');
      await context.close();
      continue;
    }
    if (!full) {
      await round.getByRole('button', { name: words.back }).click();
      await panel.locator('[data-section-card]').first().waitFor();
      assert.equal(await mutations(), 0, `${lang} ${width}px: nothing in the drawn text changed`);
      await context.close();
      continue;
    }

    // Answer as on the practice page: b wrong (a number), Enter on; the rest right; b comes back once at the end.
    const pressOption = async text => {
      const index = await round.locator('.options button.option').evaluateAll((nodes, wanted) => nodes.findIndex(node => node.innerText.includes(wanted)), text);
      assert.ok(index >= 0, `the option ${text}`);
      await page.keyboard.press(String(index + 1));
    };
    // The keys work once the start has settled (the app is busy until its refresh, as on the practice page).
    await until(async () => { await pressOption('Wrong'); return (await round.locator('.options button.option.incorrect').count()) > 0; }, 'b answered wrong');
    let savedQa = false;
    for (let step = 0; step < 8; step++) {
      if (await round.locator('.inline-run__done').count()) break;
      if (await round.locator('.options button.option:not([disabled])').count()) await pressOption('Right');
      else {
        // c answered: its 追问 has 存进笔记 (#1017), as on the practice page; saved, it reads 已存进笔记.
        if (!savedQa && await round.locator('[data-note-qa="save"]').count()) {
          await round.locator('[data-note-qa="save"]').first().click();
          await round.locator('[data-note-qa="saved"]').first().waitFor({ timeout: 15000 });
          savedQa = true;
          await round.focus();
        }
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(250);
    }
    assert.ok(savedQa, 'the 追问 of c could be kept in its note from the reader');
    await round.locator('.inline-run__done').waitFor({ timeout: 30000 });
    assert.match(await round.innerText(), words.done);
    const answered = await place();
    assert.equal(answered.scrollTop, placeInRound.scrollTop, 'the text did not scroll while answering');
    assert.equal(await mutations(), 0, 'nothing in the drawn text changed while answering');
    await shot('done');

    // The records are the practice page's: b is in the wrong book.
    const wrong = await running.api('wrongbook', { course: '*', includeInactive: true, view: 'weak', offset: 0, limit: 100 });
    assert.ok(wrong.items.some(item => item.cardId === 'b'), 'b is in the wrong book');

    // 回到题目列表 with the keyboard: the list again, focus on b's row, the text where it was, 错题 1.
    await round.getByRole('button', { name: words.back }).first().focus();
    await page.keyboard.press('Enter');
    await until(async () => (await page.evaluate(() => document.activeElement?.dataset?.sectionCard)) === 'd1|b', 'focus back on the row of b');
    await until(async () => words.wrong1.test(await panel.locator('[data-testid="section-stats"]').innerText()), '错题 1', { timeoutMs: 30000 });
    assert.equal((await place()).scrollTop, placeInRound.scrollTop, 'closing the round leaves the text where it was');

    // 错题 1 opens the 错题 panel of the toolbar.
    await panel.locator('[data-testid="section-stats"]').getByRole('button', { name: words.wrong1 }).click();
    await page.locator('.reader-wrong__panel').waitFor({ timeout: 15000 });
    await shot('wrong-panel');
    assert.deepEqual(errors.filter(error => !REFUSED.test(error)), [], 'no console or page errors');
    await context.close();
  }
});

test('本节题目 on an imported PDF: a source link shows its own place; 在这里做 is used once; an open round is taken up (#1013)', { timeout: 300000 }, async t => {
  let browser, running;
  try { ({ browser, running } = await setup()); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const library = new Store(join(running.base, 'library'));
  // The open rounds of the lecture's questions (the first test leaves rounds of the book open).
  const openRuns = async () => (await library.read()).runs.filter(run => !run.closedAt && run.index < run.entries.length && run.entries.some(entry => (entry.deckId ?? run.deckId) === 'dk'))
    .map(run => run.id);
  const { page, errors, context } = await openPage(browser, running, { lang: 'zh', width: 1280, height: 900 });
  t.after(() => context.close());
  await context.addInitScript(() => { try { window.localStorage.setItem('study-autopilot', 'off'); } catch { /* blocked */ } });
  const viewer = page.locator('.study-document-viewer'), views = viewer.locator('.reader-view-switch'), scroller = viewer.locator('.reader-scroll');
  const panel = viewer.locator('[data-tour="reader-section-practice"]'), round = panel.locator('[data-inline-run]');
  await page.goto(running.server.url);
  await (await revealNavRow(page, 'sources')).dispatchEvent('click');
  await page.locator('.source-doc', { hasText: 'Lecture' }).first().locator('.source-main').click();
  await viewer.locator('.reader-section[data-study-page="6"]').waitFor({ timeout: 60000 });
  await views.waitFor({ timeout: 30000 });
  const answerHere = async () => {
    await scroller.focus();
    await page.keyboard.press('p');
    await page.locator('.reader-practice__panel').getByRole('button', { name: '在这里做', exact: true }).click();
    await round.locator('.options button.option').first().waitFor({ timeout: 30000 });
  };
  await answerHere();
  const first = await openRuns();
  assert.equal(first.length, 1, 'one round open');

  // A citation of the round shows its own passage (page 5), marked, in this reader; the round stays.
  assert.match(await round.innerText(), /Lecture question p\?/);
  const index = await round.locator('.options button.option').evaluateAll(nodes => nodes.findIndex(node => node.innerText.includes('Right')));
  // The keys work once the start has settled (the app is busy until then, as on the practice page).
  await until(async () => { await page.keyboard.press(String(index + 1)); return (await round.locator('.options button.option.correct').count()) > 0; }, 'the answer taken');
  await round.locator('.citation-disclosure summary').click();
  await round.locator('.citations__button').nth(1).click();
  const marked = () => page.evaluate(() => { const mark = window.CSS?.highlights?.get('study-source-quote'); return mark ? [...mark].map(range => range.toString()).join(' ') : ''; });
  await until(async () => /Line 3 of page 5/.test(await marked()), 'the passage of page 5 marked');
  const onScreen = await scroller.evaluate(node => {
    const mark = [...window.CSS.highlights.get('study-source-quote')][0].getBoundingClientRect(), area = node.getBoundingClientRect();
    return mark.top >= area.top && mark.bottom <= area.bottom;
  });
  assert.ok(onScreen, 'the passage is on screen');
  assert.equal(await round.count(), 1, 'the round stays in the reader');
  const underneath = await page.evaluate(() => [...document.querySelectorAll('.question-card')].filter(node => !node.closest('.study-document-viewer')).length);
  assert.equal(underneath, 0, 'the practice page did not open under the reader');

  // 回到题目列表, then 原始 PDF and back to the text: the panel comes back with its list; no round starts by itself, the open one is not closed.
  await round.getByRole('button', { name: '回到题目列表' }).first().click();
  await panel.locator('[data-testid="section-stats"]').waitFor({ timeout: 15000 });
  await views.getByRole('button', { name: '原始 PDF' }).click();
  await until(async () => !(await panel.count()), 'the panel to give way to 原始 PDF');
  await views.getByRole('button', { name: '文字' }).click();
  await panel.locator('[data-testid="section-stats"]').waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  assert.equal(await round.count(), 0, 'no round started again by itself');
  assert.deepEqual(await openRuns(), first, 'the open round is still the one open');

  // 在这里做 again, on page 1 (the text came back at the PDF's page): the open round of the same questions is taken up, not replaced.
  await scroller.evaluate(node => { node.scrollTop = 0; });
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  await answerHere();
  assert.deepEqual(await openRuns(), first, 'the same round, still open');
  assert.match(await round.innerText(), /Lecture question p\?/, 'it is where it was left: p, answered');
  assert.equal(await round.locator('.options button.option.correct').count(), 1, 'with its answer');
  assert.deepEqual(errors.filter(error => !REFUSED.test(error)), [], 'no console or page errors');
});
