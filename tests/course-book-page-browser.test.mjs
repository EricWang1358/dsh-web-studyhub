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
import { openCourseBook } from '../lib/course-book-files.js';
import { COURSE, outlineLibrary } from './helpers/course-outline-library.mjs';

/* 复习全书 M1 in the real page at 1280 and 420 px (docs/plans/review-book.md): from the home to the 总纲 and 打开书页; the 目录 beside the book at 1280,
   folded at 420; 你在这里; 逐节读 draws one point (ui/book/BookStep.jsx); a question link goes to the practice page with 回到复习全书 and comes back at the same heading
   and scroll, the heading focused; the result page of a round started here has 回到复习全书 as its main button (the point left in a second line); 本节问答 opens in place; a link to a deleted question says so; nothing scrolls sideways. Screenshots go to COURSE_BOOK_PAGE_SHOTS when set. */

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const { sources, decks } = outlineLibrary();
  await service.store.update(state => {
    state.sources.push(...sources);
    state.decks.push(...decks);
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
    const lecture = key => groupSourcesByDocument(state.sources).find(item => item.sourceIds.includes(`document-l${key}-p1`)).key;
    const outline = { ...courseOutlineMaterial({ title: '总纲 · SA', course: COURSE, orderBasis: { codes: ['numbering'] }, fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
      nodes: [{ id: 'c1', title: 'Introduction', children: [{ id: 'what', title: 'What architects do', anchors: [`${lecture(1)}#0`] }, { id: 'who', title: 'Stakeholders and concerns', anchors: [`${lecture(1)}#1`] },
        { id: 'views', title: 'Views and viewpoints', anchors: [`${lecture(1)}#2`] }] },
      { id: 'c2', title: 'Requirements', children: [{ id: 'fr', title: 'Functional requirements', anchors: [`${lecture(2)}#0`] }, { id: 'qa', title: 'Quality attribute scenarios with a rather long title that has to wrap on a phone', anchors: [`${lecture(2)}#1`] }] }],
      other: { anchors: [] }, counts: { units: 5, leftover: 0, invalid: 0, repeated: 0 } }), createdAt: '2026-10-09T00:00:00.000Z' };
    state.sources.push(outline);
    const page = state.sources.find(source => source.id === 'document-l1-p1'), leaves = outline.courseOutline.nodes.flatMap(node => node.children);
    const long = Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}: an architect writes down each decision and the reasons for it, so the team can see later why the system is shaped as it is.`).join('\n\n');
    state.sources.push({ ...courseNotesMaterial({ title: '复习全书 · SA', course: COURSE, outlineId: outline.id, language: 'zh', papers: [], counts: {}, leaves: leaves.map(leaf => ({ id: leaf.id, title: leaf.title, anchors: leaf.anchors,
      body: { fingerprint: 'f'.repeat(16), points: [`${leaf.title} in one line [^1].`], explain: `${long}\n\nIn short: ${leaf.title} [^1].`, cites: [{ n: 1, sourceId: page.id, quote: page.text.slice(0, 40), start: 0, end: 40 }] } })) }),
      createdAt: '2026-10-09T01:00:00.000Z' });
    openCourseBook(state, {});
    // The learner's own file of the first point links a question that was deleted since.
    const record = state.sources.find(source => source.provenance === 'course-book-doc');
    record.bookDoc.files[`${leaves[0].id}.mine.md`].text = 'My note: see also [练习：an old question](studyhub://card/deck-l1/deleted-long-ago).';
  });
  await service.dispose();
}

const sideways = page => page.evaluate(() => {
  const width = window.innerWidth, wide = [...document.querySelectorAll('.book-page *')].filter(element => element.getBoundingClientRect().right > width + 1)
    .map(element => `${element.tagName.toLowerCase()}.${element.className}`).slice(0, 5);
  return { doc: document.documentElement.scrollWidth - width, wide };
});
const topOf = (page, hid) => page.evaluate(id => Math.round(document.getElementById(`book-${id}`).getBoundingClientRect().top), hid);
const focusedId = page => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
// A flashcard round is finished the way a learner does: flip, grade, next, until the result page.
async function finishRound(page) {
  for (let guard = 0; guard < 12; guard += 1) {
    if (await page.locator('.result-page').count()) return;
    if (!(await page.locator('.next-due').count())) { await page.locator('[data-usage="review.flip"]').click(); await page.locator('.grade.high').first().click(); }
    await page.locator('[data-usage="review.next"]:not([disabled])').waitFor({ timeout: 10000 });
    await page.locator('[data-usage="review.next"]').click();
    await page.waitForTimeout(400);
  }
  await page.locator('.result-page').waitFor({ timeout: 5000 });
}

test('复习全书: 打开书页 from the 总纲, 目录 and 你在这里, a question link goes to practice and back to the same place, 本节问答, a deleted question (1280 and 420 px)', { timeout: 420000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-book-page-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed });
  const shots = process.env.COURSE_BOOK_PAGE_SHOTS;
  if (shots) await mkdir(shots, { recursive: true });
  try {
    // The pictures are made in both themes; the checks run once.
    for (const [theme, width] of (shots ? [['dark', 1280], ['dark', 420], ['light', 1280], ['light', 420]] : [['dark', 1280], ['dark', 420]])) {
      const tag = `${width}${theme === 'light' ? '-light' : ''}`;
      await running.api('focus.set', { course: COURSE });
      const { page, errors, context } = await openPage(browser, running, { width, height: 900, theme });
      await page.goto(running.server.url);
      await page.locator('.course-header .outline-entry').first().click({ timeout: 30000 });
      await page.locator('.outline-tree--book').waitFor({ timeout: 30000 });
      await page.locator('.outline-book-line__open').click();
      await page.locator('.book-step').waitFor({ timeout: 30000 });
      assert.match(await page.locator('.book-page h1').innerText(), /复习全书 · SA/);
      // 逐节读 (the default): the first point alone; nothing of the others is drawn.
      assert.match((await page.locator('.book-step__heading').innerText()).replace(/\s+/g, ' '), /1\.1 What architects do/);
      assert.equal(await page.locator('[data-book-point]').count(), 1, `${width}px: one point drawn`);
      assert.equal(await page.locator('.book-step .book-file').count() > 0, true);
      if (width === 420) {
        assert.equal(await page.locator('.book-toc').count(), 0, '420px: the 目录 is folded');
        await page.locator('.book-header__toc').click();
      }
      await page.locator('.book-toc').waitFor();
      assert.ok(await page.locator('.book-toc__go').count() >= 7, `${width}px: every heading in the 目录`);
      assert.equal(await page.locator('.book-link-gone').innerText(), '这道题已被删除', `${width}px: a link to a deleted question says so`);
      let overflow = await sideways(page);
      assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px: nothing scrolls sideways: ${JSON.stringify(overflow)}`);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `book-${tag}.png`), fullPage: true });

      // The 目录 goes to a point of another chapter: it is shown, and 你在这里 follows.
      await page.locator('.book-toc__go', { hasText: '2.2 Quality attribute scenarios' }).click();
      await page.locator('.book-step__heading', { hasText: 'Quality attribute scenarios' }).waitFor();
      await page.waitForTimeout(300);
      const point = await page.locator('.book-step__heading').evaluate(element => Math.round(element.getBoundingClientRect().top));
      assert.ok(point >= 0 && point < 300, `${width}px: the 目录 brought the point to the top of the window: ${point}`);
      overflow = await sideways(page);
      assert.equal(overflow.doc <= 0 && overflow.wide.length === 0, true, `${width}px: nothing scrolls sideways with the long title: ${JSON.stringify(overflow)}`);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `book-point-${tag}.png`) });
      if (width === 420) {
        assert.equal(await page.locator('.book-toc').count(), 0, '420px: the 目录 folds again after a jump');
        await page.locator('.book-header__toc').click();
      }
      // 你在这里 is the heading on screen; at 420 px the reopened 目录 sits above the text and pushes it down, so only that it is shown is checked there.
      await (width === 1280 ? page.locator('.book-toc__item', { hasText: '2.2 Quality attribute scenarios' }).locator('.book-toc__here') : page.locator('.book-toc__here')).waitFor();
      if (width === 420) await page.locator('.book-header__toc').click();

      // 本节问答 of the point opens in place (this library keeps none: it says so).
      await page.locator('.book-point [data-book-link="qa"]').first().click();
      await page.locator('.book-qa__none, .book-qa').first().waitFor({ timeout: 30000 });

      // A question link of 1.2 (under 本节的题, folded) goes to the practice page with 回到复习全书, and comes back at the same heading and scroll.
      if (width === 420) await page.locator('.book-header__toc').click();
      await page.locator('.book-toc__go', { hasText: '1.2 Stakeholders' }).click();
      await page.locator('.book-step__heading', { hasText: 'Stakeholders' }).waitFor();
      const hid = await page.locator('.book-step').getAttribute('data-book-step');
      await page.locator('.book-questions > summary').click();
      const link = page.locator('.book-questions [data-book-link="card"]').first();
      await link.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      const before = await topOf(page, hid);
      const started = page.waitForRequest(request => request.url().includes('/api/call') && /"action":"review\.start"/.test(request.postData() || ''));
      await link.click();
      const args = JSON.parse((await started).postData()).args;
      assert.equal(args.scope.length, 1, `${width}px: the round is the linked question`);
      const back = page.locator('.review-return', { hasText: '回到复习全书' });
      await back.waitFor({ timeout: 30000 });
      // During the round the header's return button names the book, and that is the only way back on the page: the card has no copy of it.
      assert.equal(await page.locator('.review-return').getAttribute('aria-label'), '回到复习全书', `${width}px: the header's return button names the book`);
      assert.equal(await page.locator('.review-return', { hasText: '返回学习库' }).count(), 0, `${width}px: not 返回学习库`);
      if (width === 420) {
        // On its own row the label lines up with the title above it.
        const lines = await page.evaluate(() => { const title = document.querySelector('.review-heading h1').getBoundingClientRect(), label = document.querySelector('.review-return-short').getBoundingClientRect();
          return { own: label.top > title.bottom - 2, title: title.left, label: label.left }; });
        if (lines.own) assert.ok(Math.abs(lines.label - lines.title) <= 2, `420px: the header's return label lines up with the title: ${JSON.stringify(lines)}`);
      }
      assert.equal(await page.locator('.review-detour').count(), 0, `${width}px: no second 回到复习全书 under the card`);
      assert.equal(await page.getByRole('button', { name: '回到复习全书' }).count(), 1, `${width}px: exactly one way back to the book on the page`);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `book-practice-${tag}.png`) });
      await back.click();
      await page.locator(`#book-${hid}`).waitFor({ timeout: 30000 });
      await page.waitForTimeout(300);
      const after = await topOf(page, hid);
      assert.ok(Math.abs(after - before) <= 2, `${width}px: back at the same place: ${before} -> ${after}`);
      await page.waitForFunction(id => document.activeElement?.id === id, `book-${hid}`, { timeout: 5000 });
      assert.equal(await topOf(page, hid), after, `${width}px: the focus did not scroll the page`);

      // 练 5 道 on the next chapter's point (a long title) starts a round of five of its questions; finished, its result page goes back first.
      if (width === 420) await page.locator('.book-header__toc').click();
      await page.locator('.book-toc__go', { hasText: '2.2 Quality attribute scenarios' }).click();
      await page.locator('.book-step__heading', { hasText: 'Quality attribute scenarios' }).waitFor();
      const hid2 = await page.locator('.book-step').getAttribute('data-book-step');
      await page.locator('.book-point__practice').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      const before2 = await topOf(page, hid2);
      const five = page.waitForRequest(request => request.url().includes('/api/call') && /"action":"review\.start"/.test(request.postData() || ''));
      await page.locator('.book-point__practice').click();
      const chunk = JSON.parse((await five).postData()).args;
      assert.equal(chunk.scope.length, 5, `${width}px: 练 5 道 is five questions`);
      await finishRound(page);
      const primary = page.locator('.result-next .sh-btn--primary');
      assert.equal(await page.locator('.result-page .sh-btn--primary').count(), 1, `${width}px: one filled button on the result page`);
      assert.equal((await primary.locator('.reading-result__label').innerText()).trim(), '回到复习全书', `${width}px: the main button goes back to the book`);
      // The second button, when there is one, goes on (it is never another way back), and at 420 it is as wide as the main button.
      const second = page.locator('.result-next .sh-btn--secondary');
      for (let index = 0; index < await second.count(); index += 1) assert.doesNotMatch(await second.nth(index).innerText(), /回到|返回/, `${width}px: a second button is a step on, not another way back`);
      assert.equal(await page.getByRole('button', { name: /回到学习路径/ }).count(), 0, `${width}px: no 回到学习路径 beside the way back to the book`);
      const box = await primary.boundingBox();
      if (width === 1280) assert.ok(box.width <= 364, `${width}px: the main button is capped (${box.width}px)`);
      const place = (await primary.locator('small').innerText()).replace(/\s+/g, ' ');
      assert.match(place, /^回到 2\.2 Quality attribute scenarios/, `${width}px: the second line says the point left`);
      assert.equal(await page.locator('.review-return').count(), 0, `${width}px: the header does not say the same thing twice on the result page`);
      const tip = await page.locator('.result-next [role="tooltip"]').first().textContent();
      const cut = await primary.locator('small').evaluate(element => element.scrollWidth > element.clientWidth + 1);
      assert.equal(cut, tip.includes('Quality attribute scenarios with a rather long title'), `${width}px: the whole title is in the tooltip exactly when the second line is cut (cut: ${cut})`);
      if (width === 420) assert.equal(cut, true, '420px: the long title is cut');
      overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - window.innerWidth }));
      assert.equal(overflow.doc <= 0, true, `${width}px: the result page does not scroll sideways: ${JSON.stringify(overflow)}`);
      await settleAnimations(page);
      if (shots) {
        await page.screenshot({ path: join(shots, `book-result-${tag}.png`), fullPage: true });
        await page.locator('.coach-debrief h2').waitFor({ timeout: 10000 });
        await page.locator('.coach-debrief').screenshot({ path: join(shots, `book-result-debrief-${tag}.png`) });
      }
      // The seed has no step on to offer (the scope is done): a second button as the page draws one (a plain Button in the row) shows the layout. Side by side when wide;
      // in one stack, the same width as the main button, when narrow.
      // It is drawn the way the page draws it: start-aligned, the label without a text arrow and the arrow icon at its end.
      await page.evaluate(() => { const row = document.querySelector('.result-next'), button = document.createElement('button'), arrow = row.querySelector('svg').cloneNode(true);
        arrow.style.transform = 'scaleX(-1)';
        button.type = 'button'; button.className = 'sh-btn sh-btn--secondary sh-btn--md sh-btn--start'; button.dataset.probe = 'next'; button.append('继续这个范围', arrow); row.append(button); });
      const probe = await page.locator('[data-probe="next"]').boundingBox(), main = await primary.boundingBox();
      if (width === 420) assert.ok(Math.abs(probe.width - main.width) <= 1 && Math.abs(probe.x - main.x) <= 1 && probe.y > main.y, `${width}px: one stack, the same width: ${JSON.stringify({ main, probe })}`);
      else assert.ok(probe.y < main.y + main.height && probe.x > main.x + main.width && probe.x - (main.x + main.width) <= 16, `${width}px: side by side, close: ${JSON.stringify({ main, probe })}`);
      if (shots) await page.screenshot({ path: join(shots, `book-result-next-${tag}.png`), clip: { x: 0, y: Math.max(0, main.y - 80), width: width, height: 260 } });
      await page.evaluate(() => document.querySelector('[data-probe="next"]').remove());
      await primary.click();
      await page.locator(`.book-step[data-book-step="${hid2}"]`).waitFor({ timeout: 30000 });
      await page.waitForTimeout(300);
      const after2 = await topOf(page, hid2);
      assert.ok(Math.abs(after2 - before2) <= 2, `${width}px: back at the same place from the result page: ${before2} -> ${after2}`);
      await page.waitForFunction(id => document.activeElement?.id === id, `book-${hid2}`, { timeout: 5000 });
      assert.equal(await focusedId(page), `book-${hid2}`, `${width}px: the focus is on the point's heading`);
      await settleAnimations(page);
      if (shots) await page.screenshot({ path: join(shots, `book-back-${tag}.png`) });

      // book -> 看这题的原文 -> reader -> 练这几页: the round carries the reader's context (the request is given one here, the reader itself is not under test) and the book's trail is still
      // there. The reader's way back is the one filled button on the page; the book adds none, and nothing else on the row goes back.
      await page.route('**/api/call', async (route) => {
        const body = route.request().postData() || '';
        if (!/"action":"review\.start"/.test(body)) return route.continue();
        const call = JSON.parse(body);
        call.args.reading = { documentId: 'doc-l2', sourceId: 'document-l2-p2', page: 2, sectionTitle: 'Quality attribute scenarios', scope: { kind: 'chapter', count: 4, label: '这一章' } };
        await route.continue({ postData: JSON.stringify(call) });
      });
      await page.locator('.book-point__practice').scrollIntoViewIfNeeded();
      await page.locator('.book-point__practice').click();
      await finishRound(page);
      await page.unroute('**/api/call');
      await page.locator('.reading-result').waitFor({ timeout: 10000 });
      assert.equal(await page.locator('.result-page .sh-btn--primary').count(), 1, `${width}px: a reader round has exactly one filled button`);
      assert.equal((await page.locator('.reading-result .sh-btn--primary .reading-result__label').innerText()).trim(), '回到阅读', `${width}px: and it is the reader's way back`);
      assert.equal(await page.getByRole('button', { name: /回到复习全书|回到学习路径|返回学习库首页/ }).count(), 0, `${width}px: no second way back beside it`);
      assert.equal(await page.locator('.result-next .sh-btn--primary').count(), 0, `${width}px: the page's own next step is a plain button`);
      overflow = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - window.innerWidth }));
      assert.equal(overflow.doc <= 0, true, `${width}px: the reader round's result page does not scroll sideways`);
      await settleAnimations(page);
      if (shots) {
        await page.screenshot({ path: join(shots, `reader-result-${tag}.png`), fullPage: true });
        await page.locator('.coach-debrief h2').waitFor({ timeout: 10000 });
        await page.locator('.coach-debrief').screenshot({ path: join(shots, `reader-result-debrief-${tag}.png`) });
      }
      await page.getByRole('button', { name: '返回学习库' }).first().click();
      await page.locator('.course-header .outline-entry').first().click({ timeout: 30000 });
      await page.locator('.outline-book-line__open').click();
      await page.locator('.book-step').waitFor({ timeout: 30000 });

      // The focus belongs to the return itself: leaving the book for the 总纲 and opening it again later puts nothing on the heading.
      await page.locator('.book-header').getByText('回到总纲').first().click();
      await page.locator('.outline-book-line__open').click();
      await page.locator('.book-step').waitFor({ timeout: 30000 });
      await page.waitForTimeout(500);
      assert.notEqual(await focusedId(page), `book-${hid2}`, `${width}px: a later visit does not focus the heading`);
      assert.deepEqual(errors, [], `${width}px: no page errors`);
      await context.close();
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
