/* global document, window, localStorage */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { buildOutlineIndex } from '../lib/course-outline-index.js';
import { courseOutlineMaterial, materialsFingerprint } from '../lib/course-outline-book.js';
import { courseNotesMaterial } from '../lib/course-book.js';
import { openCourseBook } from '../lib/course-book-files.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { openPage, settleAnimations } from '../scripts/qa/layout-late.mjs';

const SHOTS = process.env.QUESTION_BOOK_SECTION_SHOTS || '';
const COURSE = 'Arch';

async function seedLibrary(root, { extraCourse = null } = {}) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');

  const pages = [
    {
      id: 'doc-p1',
      title: 'Architecture Guide · p. 1',
      createdAt: '2026-10-01T00:00:00.000Z',
      courses: [COURSE],
      text: 'Architecture overview introduces system structure, components, and key design trade-offs.',
      document: {
        materialId: 'doc-arch',
        page: 1,
        totalPages: 6,
        format: 'pdf',
        origin: 'converted',
        converter: 'marker',
        filename: 'Architecture Guide.pdf',
        chapter: { index: 0, title: 'Architecture Overview', level: 1 },
        extractionVersion: 2,
      },
    },
    {
      id: 'doc-p2',
      title: 'Architecture Guide · p. 2',
      createdAt: '2026-10-01T01:00:00.000Z',
      courses: [COURSE],
      text: 'Layered boundaries isolate core domain business logic from presentation and database frameworks.',
      document: {
        materialId: 'doc-arch',
        page: 2,
        totalPages: 6,
        format: 'pdf',
        origin: 'converted',
        converter: 'marker',
        filename: 'Architecture Guide.pdf',
        chapter: { index: 1, title: 'Layered Architecture', level: 1 },
        extractionVersion: 2,
      },
    },
    {
      id: 'doc-p3',
      title: 'Architecture Guide · p. 3',
      createdAt: '2026-10-01T02:00:00.000Z',
      courses: [COURSE],
      text: 'Stakeholder concerns capture availability, latency, and regulatory compliance constraints early.',
      document: {
        materialId: 'doc-arch',
        page: 3,
        totalPages: 6,
        format: 'pdf',
        origin: 'converted',
        converter: 'marker',
        filename: 'Architecture Guide.pdf',
        chapter: { index: 2, title: 'Stakeholders and Concerns', level: 1 },
        extractionVersion: 2,
      },
    },
  ];

  const cards = [
    {
      id: 'q-built',
      kind: 'quiz',
      topic: 'Layered boundaries',
      prompt: '哪一层负责把核心业务规则与框架细节隔离？',
      answer: 'a',
      explanation: '领域层只承载核心业务规则，不直接依赖数据库或展示层框架。',
      citations: [{ sourceId: 'doc-p2', quote: 'Layered boundaries isolate core domain business logic' }],
      options: [
        { id: 'a', text: '领域层（Domain）', correct: true },
        { id: 'b', text: '展示层（UI）', correct: false },
      ],
    },
    {
      id: 'q-unbuilt',
      kind: 'quiz',
      topic: 'Stakeholder concerns',
      prompt: '谁最关心系统的可用性与合规边界？',
      answer: 'a',
      explanation: '运维与安全干系人直接受系统可用性与合规约束影响。',
      citations: [{ sourceId: 'doc-p3', quote: 'Stakeholder concerns capture availability' }],
      options: [
        { id: 'a', text: '运维与安全干系人', correct: true },
        { id: 'b', text: '临时访客', correct: false },
      ],
    },
  ];

  await service.store.update((state) => {
    state.sources.push(...pages);
    state.decks.push({ id: 'deck-arch', title: 'Architecture Practice', course: COURSE, cards });
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };

    const docKey = groupSourcesByDocument(state.sources)[0].key;
    const nodes = [
      {
        id: 'ch1',
        title: '核心结构与约束',
        children: [
          {
            id: 'ch1-s1',
            title: '分层与干系人',
            children: [
              { id: 'intro', title: 'Architecture overview', anchors: [`${docKey}#0`] },
              { id: 'what', title: 'Layered boundaries', anchors: [`${docKey}#1`] },
              { id: 'who', title: 'Stakeholder concerns', anchors: [`${docKey}#2`] },
            ],
          },
        ],
      },
    ];
    const outline = {
      ...courseOutlineMaterial({
        title: '总纲 · Arch',
        course: COURSE,
        orderBasis: { codes: ['numbering'] },
        fingerprint: materialsFingerprint(buildOutlineIndex(state, { course: COURSE }).allDocuments),
        nodes,
        other: { anchors: [] },
        counts: { units: 3, leftover: 0, invalid: 0, repeated: 0 },
      }),
      createdAt: '2026-10-09T00:00:00.000Z',
    };
    state.sources.push(outline);
    state.sources.push({
      ...courseNotesMaterial({
        title: '复习全书 · Arch',
        course: COURSE,
        outlineId: outline.id,
        language: 'zh',
        papers: [],
        counts: {},
        leaves: [
          {
            id: 'intro',
            title: 'Architecture overview',
            anchors: [`${docKey}#0`],
            body: {
              fingerprint: 'e'.repeat(16),
              points: ['系统架构概览与设计权衡'],
              explain: '先理解整体结构与约束，再进入各层职责划分[^1]。',
              example: '明确读写路径后再细化组件接口。',
              extra: ['概览章节先建立全局图景。'],
              cites: [{ n: 1, sourceId: 'doc-p1', quote: pages[0].text.slice(0, 48), start: 0, end: 48 }],
            },
          },
          {
            id: 'what',
            title: 'Layered boundaries',
            anchors: [`${docKey}#1`],
            body: {
              fingerprint: 'f'.repeat(16),
              points: [
                '分层边界把领域规则与外部框架隔离',
                '上层只能向稳定抽象依赖，不能反向跨越',
              ],
              explain: '分层架构的核心价值在于让业务逻辑脱离 UI 和数据库细节独立演进[^1]。\n\n评审时先检查依赖方向是否单向收口。',
              example: '展示层只调用应用服务，不直接执行 SQL 查询。',
              extra: ['边界清晰后再决定是否拆分为独立服务。'],
              cites: [{ n: 1, sourceId: 'doc-p2', quote: pages[1].text.slice(0, 48), start: 0, end: 48 }],
            },
          },
        ],
      }),
      createdAt: '2026-10-09T01:00:00.000Z',
    });
    openCourseBook(state, { course: COURSE });
    if (extraCourse) {
      state.decks.push({
        id: 'deck-extra',
        title: 'Extra Course Practice',
        course: extraCourse,
        cards: [
          {
            id: 'q-extra',
            kind: 'quiz',
            topic: 'Transport',
            prompt: 'Which mechanism limits unacknowledged segments in TCP?',
            answer: 'a',
            options: [
              { id: 'a', text: '滑动窗口与拥塞控制', correct: true },
              { id: 'b', text: 'ARP 广播', correct: false },
            ],
            citations: [],
          },
        ],
      });
      state.focus = { mode: 'class', course: extraCourse, role: '', jd: '', targetTopics: [] };
    }
  });

  await service.call('card.followup.add', {
    deckId: 'deck-arch',
    cardId: 'q-built',
    question: '为什么展示层不能直接调用数据库？',
    answer: '跨层直连会制造紧耦合，使领域规则难以独立测试与演进。',
    source: 'assistant',
  });

  const builtPlace = await service.call('card.place', { deckId: 'deck-arch', cardId: 'q-built' });
  assert.equal(builtPlace.leaf?.built, true, 'q-built should map to a built review book leaf');
  const unbuiltPlace = await service.call('card.place', { deckId: 'deck-arch', cardId: 'q-unbuilt' });
  assert.equal(unbuiltPlace.leaf?.built, false, 'q-unbuilt should map to an unbuilt outline leaf');

  await service.dispose();
}

async function startScenarioServer(distDir, options = {}) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-question-book-section-'));
  const libraryRoot = join(base, 'library');
  await seedLibrary(libraryRoot, options);
  const server = await createPreviewServer({ libraryRoot, home: join(base, 'home'), port: 0, model: null, distDir });
  return {
    server,
    close: async () => {
      await server.close();
      await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    },
  };
}

function trackCardPlaceCalls(page) {
  const counts = new Map();
  page.on('request', (request) => {
    if (request.method() !== 'POST' || !request.url().endsWith('/api/call')) return;
    try {
      const payload = JSON.parse(request.postData() || '{}');
      if (payload.action === 'card.place') {
        const cardId = payload.args?.cardId || '';
        counts.set(cardId, (counts.get(cardId) || 0) + 1);
      }
    } catch { /* ignore non-json */ }
  });
  return counts;
}

async function openFirstRound(browser, running, { lang, width, height }) {
  const opened = await openPage(browser, running, { lang, theme: 'light', width, height });
  const { page } = opened;
  const counts = trackCardPlaceCalls(page);
  await page.addInitScript(() => {
    try { localStorage.setItem('study-autopilot', 'off'); } catch { /* blocked */ }
  });
  await page.goto(running.server.url);
  await page.locator('[data-usage="home.start"]').first().click({ timeout: 30000 });
  await page.locator('.question-card').waitFor({ timeout: 30000 });
  await page.locator('[data-review-place=""]').waitFor({ timeout: 15000 });
  return { ...opened, counts };
}

test('built review book links from wrong feedback and Q&A jump to the section and return in place to the same question (#1196)', async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium available: ${String(error.message).split('\n')[0]}`); return; }

  const distDir = await mkdtemp(join(tmpdir(), 'study-question-book-dist-'));
  const cleanups = [];
  if (SHOTS) await mkdir(SHOTS, { recursive: true });

  try {
    await buildPreview({ outdir: distDir });

    // 1. Desktop 1280px Chinese full round-trip + built/unbuilt + single card.place request check
    {
      const running = await startScenarioServer(distDir);
      cleanups.push(() => running.close());
      const { context, page, errors, counts } = await openFirstRound(browser, running, { lang: 'zh', width: 1280, height: 900 });
      try {
        assert.equal(counts.get('q-built'), 1, 'card.place is requested once per entry even with header and body consumers');

        await page.locator('.options .option', { hasText: '展示层（UI）' }).click();
        await page.locator('.next-due--verdict.retry').waitFor({ timeout: 15000 });
        await page.locator('[data-book-section-link="feedback"]').waitFor({ timeout: 15000 });
        await page.locator('[data-book-section-link="followup"]').waitFor({ timeout: 15000 });
        await settleAnimations(page);

        const overflow1280 = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        assert.equal(overflow1280, false, 'no horizontal overflow on 1280px question view');
        if (SHOTS) {
          await page.screenshot({ path: join(SHOTS, 'zh-1280-wrong-question.png') });
          await page.locator('[data-book-section-link="followup"]').scrollIntoViewIfNeeded();
          await page.screenshot({ path: join(SHOTS, 'zh-1280-followup-link.png') });
        }

        await page.locator('[data-book-section-link="feedback"]').scrollIntoViewIfNeeded();
        await page.locator('[data-book-section-link="feedback"]').click();
        await page.locator('.book-header').waitFor({ timeout: 30000 });
        await page.locator('[data-book-heading]', { hasText: 'Layered boundaries' }).waitFor({ timeout: 15000 });
        const landedTop = await page.locator('[data-book-heading]', { hasText: 'Layered boundaries' }).evaluate((el) => el.getBoundingClientRect().top);
        assert.ok(landedTop >= 0 && landedTop < 600, `expected targeted section heading in view, got top=${landedTop}`);
        assert.equal(await page.locator('.context-return').count(), 0, 'book page from review hides duplicate .context-return banner');
        const backBtn = page.locator('.book-header .sh-page-header__back');
        assert.match(await backBtn.innerText(), /回到之前的第 1 题/);
        assert.doesNotMatch(await backBtn.innerText(), /回到这道题/);
        assert.equal(await page.getByRole('button', { name: /回到之前的第 1 题|回到这道题/ }).count(), 1, 'only one return-to-question control is rendered');
        await settleAnimations(page);
        if (SHOTS) await page.screenshot({ path: join(SHOTS, 'zh-1280-book-section.png') });

        await backBtn.click();
        await page.locator('.question-card').waitFor({ timeout: 30000 });
        assert.match(await page.locator('.question').innerText(), /哪一层负责把核心业务规则与框架细节隔离？/);
        await page.locator('.next-due--verdict.retry').waitFor({ timeout: 15000 });
        assert.equal(await page.locator('.options .option.incorrect', { hasText: '展示层（UI）' }).count(), 1, 'wrong answer styling remains after returning');
        assert.equal(await page.locator('[data-book-section-link="feedback"]').count(), 1, 'feedback book link remains after returning');

        await page.locator('[data-usage="review.next"]').click();
        await page.locator('.question', { hasText: '谁最关心系统的可用性与合规边界？' }).waitFor({ timeout: 15000 });
        await page.locator('.options .option', { hasText: '临时访客' }).click();
        await page.locator('.next-due--verdict.retry').waitFor({ timeout: 15000 });
        await page.waitForTimeout(300);
        assert.equal(await page.locator('[data-book-section-link]').count(), 0, 'unbuilt outline leaf hides 「读全书这一节」');
        assert.equal(counts.get('q-unbuilt'), 1, 'card.place is requested once for the second question');

        // Entering the book from the library (not from a question) keeps the normal 回到总纲 back button and no .context-return banner.
        await (await revealNavRow(page, 'library')).click();
        await page.locator('[data-usage="home.start"]').first().waitFor({ state: 'visible', timeout: 30000 });
        await (await revealNavRow(page, 'book')).click();
        await page.locator('.book-header').waitFor({ timeout: 30000 });
        assert.equal(await page.locator('.context-return').count(), 0, 'normal book entry from library has no .context-return banner');
        assert.match(await page.locator('.book-header .sh-page-header__back').innerText(), /回到总纲/);

        assert.deepEqual(errors, [], `unexpected browser errors (zh 1280): ${errors.join('\n')}`);
      } finally {
        await context.close();
      }
    }

    // 2. Narrow 420px Chinese layout + clicking Q&A followup link
    {
      const running = await startScenarioServer(distDir);
      cleanups.push(() => running.close());
      const { context, page, errors } = await openFirstRound(browser, running, { lang: 'zh', width: 420, height: 844 });
      try {
        await page.locator('.options .option', { hasText: '展示层（UI）' }).click();
        await page.locator('.next-due--verdict.retry').waitFor({ timeout: 15000 });
        await page.locator('[data-book-section-link="feedback"]').waitFor({ timeout: 15000 });
        await settleAnimations(page);

        const overflow420Question = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        assert.equal(overflow420Question, false, 'no horizontal overflow on 420px question view');
        if (SHOTS) {
          await page.locator('[data-book-section-link="feedback"]').evaluate((el) => el.scrollIntoView({ block: 'center' }));
          await page.screenshot({ path: join(SHOTS, 'zh-420-wrong-question.png') });
        }

        const qaLink = page.locator('[data-book-section-link="followup"]');
        await qaLink.scrollIntoViewIfNeeded();
        await qaLink.click();
        await page.locator('.book-header').waitFor({ timeout: 30000 });
        await page.locator('[data-book-heading]', { hasText: 'Layered boundaries' }).waitFor({ timeout: 15000 });
        assert.equal(await page.locator('.context-return').count(), 0, '420px book page from review hides duplicate .context-return banner');
        assert.match(await page.locator('.book-header .sh-page-header__back').innerText(), /回到之前的第 1 题/);
        assert.equal(await page.getByRole('button', { name: /回到之前的第 1 题|回到这道题/ }).count(), 1, '420px book page renders only one return-to-question control');
        await settleAnimations(page);
        const overflow420Book = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        assert.equal(overflow420Book, false, 'no horizontal overflow on 420px book view');
        if (SHOTS) await page.screenshot({ path: join(SHOTS, 'zh-420-book-section.png') });
        assert.deepEqual(errors, [], `unexpected browser errors (zh 420): ${errors.join('\n')}`);
      } finally {
        await context.close();
      }
    }

    // 3. Desktop 1280px English localization + return trip
    {
      const running = await startScenarioServer(distDir);
      cleanups.push(() => running.close());
      const { context, page, errors } = await openFirstRound(browser, running, { lang: 'en', width: 1280, height: 900 });
      try {
        await page.locator('.options .option', { hasText: '展示层（UI）' }).click();
        await page.locator('.next-due--verdict.retry').waitFor({ timeout: 15000 });
        const enFeedbackLink = page.locator('[data-book-section-link="feedback"]');
        await enFeedbackLink.waitFor({ timeout: 15000 });
        assert.match(await enFeedbackLink.innerText(), /Read this section in the book/);
        assert.match(await page.locator('[data-book-section-link="followup"]').innerText(), /Read this section in the book/);
        await settleAnimations(page);
        if (SHOTS) await page.screenshot({ path: join(SHOTS, 'en-1280-wrong-question.png') });

        await enFeedbackLink.click();
        await page.locator('.book-header').waitFor({ timeout: 30000 });
        await page.locator('[data-book-heading]', { hasText: 'Layered boundaries' }).waitFor({ timeout: 15000 });
        assert.equal(await page.locator('.context-return').count(), 0, 'en book page from review hides duplicate .context-return banner');
        const enBackBtn = page.locator('.book-header .sh-page-header__back');
        assert.match(await enBackBtn.innerText(), /Return to previous question \(1\)/);
        assert.doesNotMatch(await enBackBtn.innerText(), /Back to this question/);
        assert.equal(await page.getByRole('button', { name: /Return to previous question|Back to this question/ }).count(), 1, 'en book page renders only one return-to-question control');
        await settleAnimations(page);
        if (SHOTS) await page.screenshot({ path: join(SHOTS, 'en-1280-book-section.png') });

        await enBackBtn.click();
        await page.locator('.next-due--verdict.retry').waitFor({ timeout: 15000 });
        assert.equal(await page.locator('.options .option.incorrect').count(), 1);
        assert.deepEqual(errors, [], `unexpected browser errors (en 1280): ${errors.join('\n')}`);
      } finally {
        await context.close();
      }
    }

    // 4. Cross-course 「读全书这一节」: Course A (Networks, no book) -> mixed run card from Course B (Arch) -> book -> back restores Course A (#1223)
    {
      const EXTRA_COURSE = 'Networks';
      const running = await startScenarioServer(distDir, { extraCourse: EXTRA_COURSE });
      cleanups.push(() => running.close());
      const mixedRun = await previewCall(running.server, 'review.start', {
        mode: 'path',
        scope: [{ deckId: 'deck-arch', cardId: 'q-built' }, { deckId: 'deck-extra', cardId: 'q-extra' }],
        ordered: true,
        fresh: true,
      });
      assert.equal((await previewCall(running.server, 'snapshot', {})).focus.course, EXTRA_COURSE);

      const opened = await openPage(browser, running, { lang: 'zh', theme: 'light', width: 1280, height: 900 });
      const { page, errors, context } = opened;
      try {
        await page.addInitScript(() => {
          try { localStorage.setItem('study-autopilot', 'off'); } catch { /* blocked */ }
        });
        await page.goto(running.server.url);
        await page.locator('.course-heading', { hasText: EXTRA_COURSE }).waitFor({ state: 'visible', timeout: 30000 });

        await page.locator('[data-usage="nav.resume"]').click();
        await page.locator('.question-card').waitFor({ timeout: 30000 });
        await page.locator('.options .option', { hasText: '展示层（UI）' }).click();
        await page.locator('.next-due--verdict.retry').waitFor({ timeout: 15000 });
        const feedbackLink = page.locator('[data-book-section-link="feedback"]');
        await feedbackLink.waitFor({ state: 'visible', timeout: 15000 });

        await feedbackLink.click();
        await page.locator('.book-header').waitFor({ timeout: 30000 });
        assert.equal(await page.locator('.context-return').count(), 0, 'cross-course book page from review hides duplicate .context-return banner');
        assert.match(await page.locator('.book-header .sh-page-header__back').innerText(), /回到之前的第 1 题/);
        assert.match(await page.locator('.book-header h1').innerText(), new RegExp(`复习全书\\s*·\\s*${COURSE}`));
        await page.locator('[data-book-heading]', { hasText: 'Layered boundaries' }).waitFor({ timeout: 15000 });
        assert.equal((await previewCall(running.server, 'snapshot', {})).focus.course, COURSE, 'book link switched focus course to card course');

        await page.locator('.book-header .sh-page-header__back').click();
        await page.locator('.question-card').waitFor({ timeout: 30000 });
        await page.locator('.next-due--verdict.retry').waitFor({ timeout: 15000 });
        assert.match(await page.locator('.question').innerText(), /哪一层负责把核心业务规则与框架细节隔离？/);
        assert.equal((await previewCall(running.server, 'snapshot', {})).focus.course, EXTRA_COURSE, 'returning from book restored focus course back to Networks');
        assert.equal((await previewCall(running.server, 'snapshot', {})).lastRun?.id, mixedRun.id, 'resumed exact mixed review run');

        await (await revealNavRow(page, 'library')).click();
        await page.locator('.course-heading', { hasText: EXTRA_COURSE }).waitFor({ state: 'visible', timeout: 30000 });

        // Failure fallback when restoring focus course fails / returns falsy
        for (const mode of ['throw', 'falsy']) {
          await page.locator('[data-usage="nav.resume"]').click();
          await page.locator('[data-book-section-link="feedback"]').waitFor({ state: 'visible', timeout: 15000 });
          await page.locator('[data-book-section-link="feedback"]').click();
          await page.locator('.book-header').waitFor({ timeout: 30000 });

          const failRestore = async (route) => {
            const request = route.request();
            if (request.method() === 'POST' && request.url().endsWith('/api/call')) {
              const body = JSON.parse(request.postData() || '{}');
              if (body.action === 'focus.set' && body.args?.course === EXTRA_COURSE) {
                if (mode === 'throw') {
                  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: '请选择已有课程' }) });
                } else {
                  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, value: null }) });
                }
                return;
              }
            }
            await route.continue();
          };
          await page.route('**/api/call', failRestore);
          await page.locator('.book-header .sh-page-header__back').click();
          await page.locator('.next-due--verdict.retry').waitFor({ timeout: 15000 });
          assert.match(await page.locator('.question').innerText(), /哪一层负责把核心业务规则与框架细节隔离？/);
          const expectedError = mode === 'throw'
            ? '已回到原位置，但没能切回之前的课程：请选择已有课程'
            : '已回到原位置，但没能切回之前的课程。可以在学习库重新切换当前课程。';
          await page.locator('.sh-toasts .sh-toast--error', { hasText: expectedError }).waitFor({ state: 'visible', timeout: 15000 });
          await page.unroute('**/api/call', failRestore);

          await previewCall(running.server, 'focus.set', { course: EXTRA_COURSE });
          await (await revealNavRow(page, 'library')).click();
          await page.locator('.course-heading', { hasText: EXTRA_COURSE }).waitFor({ state: 'visible', timeout: 30000 });
        }

        assert.deepEqual(errors, [], `unexpected browser errors (cross-course): ${errors.join('\n')}`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    for (const close of cleanups.reverse()) await close();
    await rm(distDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});
