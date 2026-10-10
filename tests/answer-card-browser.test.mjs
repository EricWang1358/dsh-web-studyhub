/* global window document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { StudyService } from '../lib/service.js';
import { openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';
import { caseLibrary } from './helpers/answer-card-library.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { switchOptions } from './helpers/runtime-switch.mjs';
import { settleJob } from './helpers/wait.mjs';

/* 复习全书 M5 in the real page at 1280 and 420 px (docs/plans/review-book.md): a graded case question shows its reference answer and 「生成答题卡」;
   the visible task writes the card; the card replaces the plain answer with its parts, a 未核实 badge on the definition that could not be checked (its
   material holds HTML), the state badge and the marks map; 「加入复习全书」 puts it into the course's book, where it reads as part of 未归位; nothing
   scrolls sideways. The preview server's fake model answers. Screenshots go to ANSWER_CARD_SHOTS when set. */

/** The library: the course SA with its outline and book, and a case deck of the same course whose one question is graded and revealed in an open run. */
async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root, { complete: createFakeModel() });
  await service.call('snapshot');
  const { sources, decks } = outlineLibrary();
  const cases = caseLibrary();
  cases.deck.course = COURSE;
  // A converted material with an entity in its first sentence: its definitions cannot be checked word for word, so the card marks one 未核实.
  cases.sources[1].text = `Availability &amp; uptime: availability is the share of time a service works. ${cases.sources[1].text}`;
  await service.store.update(state => {
    state.sources.push(...sources, ...cases.sources);
    state.decks.push(...decks, cases.deck);
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
    const lecture = groupSourcesByDocument(state.sources).find(item => item.sourceIds.includes('document-l1-p1')).key;
    const outline = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
      nodes: [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture}#0`] }] }], other: { anchors: [] }, counts: { units: 1, leftover: 0, invalid: 0, repeated: 0 } }),
    createdAt: '2026-10-09T00:00:00.000Z' };
    state.sources.push(outline);
    const page = state.sources.find(source => source.id === 'document-l1-p1');
    state.sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: [{ id: 'what', title: 'What architects do',
      anchors: [`${lecture}#0`], body: { fingerprint: 'f'.repeat(16), points: ['Architects decide [^1].'], explain: 'About architects.', cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 30), start: 0, end: 30 }] } }] }),
    createdAt: '2026-10-09T01:00:00.000Z' });
  });
  await service.call('course.book.open', { course: COURSE });
  const run = await service.call('review.start', { mode: 'path', scope: [{ deckId: 'case1', cardId: 'q1' }], fresh: true });
  await service.call('card.grade', { deckId: 'case1', cardId: 'q1', runId: run.id, answer: 'Two servers in parallel are available far more than one; the target of 99.9% is met.' });
  await service.dispose();
}

const sideways = page => page.evaluate(() => {
  const width = window.innerWidth, wide = [...document.querySelectorAll('.answer-card-section *, .book-page *')].filter(element => element.getBoundingClientRect().right > width + 1
    && !element.closest('.answer-card__table')).map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
});

/** The preview server has no job executor: the page's start of the task is answered by a second service over the same library with the unified runtime
    on (the real Job, the preview's fake model), and its job.status by how that Job ended. */
async function runTasksFor(page, root) {
  const fake = createFakeModel({ latencyMs: 5 });
  const service = new StudyService(root, { complete: fake, ...switchOptions('runtime', { complete: fake, paths: [] }) });
  const ended = new Map();
  await page.route('**/api/call', async route => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch { /* not JSON */ }
    if (body.action === 'generation.answerCard.build') {
      const started = await service.call('generation.answerCard.build', body.args);
      ended.set(started.jobId, (await settleJob(service, started.jobId)).status);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, value: started }) });
    }
    if (body.action === 'job.status' && ended.has(body.args?.jobId)) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, value: { status: ended.get(body.args.jobId) } }) });
    return route.continue();
  });
  return { dispose: () => service.dispose(), ended };
}

test('分析题答案卡: 生成答题卡 → the card with its badges → 加入复习全书 → in the book (1280 and 420 px)', { timeout: 480000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-answer-card-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.ANSWER_CARD_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openPage(browser, running, { width, height: 900 });
      await context.addInitScript(() => { try { localStorage.setItem('study-autopilot', 'off'); } catch { /* blocked */ } });
      const tasks = await runTasksFor(page, join(running.base, 'library'));
      t.after(() => tasks.dispose());
      await page.goto(running.server.url);
      await page.getByRole('button', { name: '接着做' }).first().click({ timeout: 30000 });
      const section = page.locator('.answer-card-section');
      await section.waitFor({ timeout: 30000 });
      if (width === 1280) {
        // The first time: the reference answer as before, and the offer.
        assert.match(await section.innerText(), /参考答案（批改后揭晓）/);
        if (shots) await page.screenshot({ path: join(shots, `answer-card-offer-${width}.png`) });
        await section.locator('[data-answer-card-generate="new"]').click();
      }
      const card = page.locator('[data-answer-card]');
      await card.waitFor({ timeout: 60000 });
      if (width === 1280) assert.deepEqual([...tasks.ended.values()], ['complete'], 'one task, run to the end');
      assert.equal(await card.getAttribute('data-answer-card'), 'partial', `${width}px: 部分未核对 (one definition could not be checked)`);
      const text = await card.innerText();
      for (const label of ['识别信号', '题干事实', '概念', '假设', '推理链', '结论', '为什么满足目标', '代价与失败处理', '如何验证', '易错检查', '评分点对照'])
        assert.ok(text.includes(label), `${width}px: ${label}`);
      assert.match(text, /部分未核对/);
      assert.match(text, /已核对 ≠ 答案正确/);
      assert.equal(await card.locator('.answer-card__unverified').count(), 1, `${width}px: one 未核实 badge, on the definition`);
      assert.ok(await card.locator('[data-answer-part="concepts"] .answer-card__unverified').count() === 1);
      assert.match(await section.innerText(), /原来的参考答案/, 'the old answer folded under it');
      await settleAnimations(page);
      let overflow = await sideways(page);
      assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px: the card fits: ${JSON.stringify(overflow)}`);
      if (shots) { await card.evaluate(element => element.scrollIntoView({ block: 'start' })); await page.screenshot({ path: join(shots, `answer-card-${width}.png`) });
        await card.locator('[data-answer-part="marks"]').evaluate(element => element.scrollIntoView({ block: 'center' })); await page.screenshot({ path: join(shots, `answer-card-marks-${width}.png`) }); }

      // 加入复习全书 → 已加入 · 撤回; the block is in the course's book (未归位: a case question is placed in no point).
      const add = card.locator('[data-answer-card-book]');
      if (await add.getAttribute('data-answer-card-book') === 'added') { await add.click(); await card.locator('[data-answer-card-book="add"]').waitFor({ timeout: 30000 }); }
      await card.locator('[data-answer-card-book="add"]').click();
      await card.locator('[data-answer-card-book="added"]').waitFor({ timeout: 30000 });
      const book = await running.api('course.book.open', { course: COURSE });
      assert.match(book.unplaced.text, /<!-- sh:card card=q1 -->\n\*\*Answer card\*\*/, `${width}px: in the book`);
      assert.deepEqual((await running.api('book.qa.list', {})).answerCardIds, ['q1']);

      // And it reads as part of the book page.
      await page.goto(running.server.url);
      await page.locator('.course-header .outline-entry').first().click({ timeout: 30000 });
      await page.locator('.outline-book-line__open').click({ timeout: 30000 });
      const unplaced = page.locator('[data-chapter="unplaced"]');
      await unplaced.waitFor({ timeout: 30000 });
      const toggle = unplaced.locator('.book-chapter__toggle');
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      await unplaced.getByText('Answer card', { exact: true }).waitFor({ timeout: 30000 });
      const shown = await unplaced.innerText();
      assert.match(shown, /Question type: Availability/);
      assert.doesNotMatch(shown, /\*\*/, 'the Markdown is rendered, no stray asterisks');
      assert.doesNotMatch(shown, /sh:card/, 'no marker shown');
      overflow = await sideways(page);
      assert.equal(overflow.doc <= 0, true, `${width}px: the book page does not scroll sideways: ${JSON.stringify(overflow)}`);
      if (shots) { await unplaced.evaluate(element => element.scrollIntoView({ block: 'start' })); await page.screenshot({ path: join(shots, `answer-card-book-${width}.png`) }); }
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
