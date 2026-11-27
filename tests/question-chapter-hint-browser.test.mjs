/* Browser integration test for chapter-basics proactive hint (#1191, #1193).
   Registered in tests/slow-tests.json. Pass CHAPTER_HINT_SHOTS=<dir> to save screenshots. */
/* global document, NodeFilter */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { followupDigest } from '../lib/followup.js';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { openPage, settleAnimations, startLateServer, until } from '../scripts/qa/layout-late.mjs';

const SHOTS = process.env.CHAPTER_HINT_SHOTS || '';
const COURSE = 'Systems';
const REFUSED = /Failed to load resource: the server responded with a status of 400/;

function libraryFixtures(lang) {
  const en = lang === 'en';
  const chapter1 = en ? 'Chapter 1 Storage Primitives' : '第 1 章 底层存储';
  const chapter2 = en ? 'Chapter 2 Consistency Models' : '第 2 章 一致性模型';
  const quote1 = 'Storage primitives define page layout, write-ahead logs, and durable checkpoints.';
  const quote2 = 'Consistency models trade off latency and synchronization guarantees.';
  const sources = [
    {
      id: 'pdf-sys-p1',
      title: en ? 'Systems Guide · p. 1' : '系统指南 · 第 1 页',
      createdAt: '2026-10-01T00:00:00.000Z',
      courses: [COURSE],
      text: `${quote1} Every higher layer depends on binary framing and checksum verification.`,
      document: {
        materialId: 'doc-sys',
        page: 1,
        totalPages: 2,
        format: 'pdf',
        origin: 'converted',
        converter: 'marker',
        filename: 'Systems Guide.pdf',
        chapter: { index: 0, title: chapter1, level: 1 },
        extractionVersion: 2,
      },
    },
    {
      id: 'pdf-sys-p2',
      title: en ? 'Systems Guide · p. 2' : '系统指南 · 第 2 页',
      createdAt: '2026-10-01T01:00:00.000Z',
      courses: [COURSE],
      text: `${quote2} Optimistic concurrency checks versions at commit while mutex locks block earlier.`,
      document: {
        materialId: 'doc-sys',
        page: 2,
        totalPages: 2,
        format: 'pdf',
        origin: 'converted',
        converter: 'marker',
        filename: 'Systems Guide.pdf',
        chapter: { index: 1, title: chapter2, level: 1 },
        extractionVersion: 2,
      },
    },
  ];
  const cards = en
    ? [
        {
          id: 'c1',
          kind: 'flashcard',
          topic: 'Layered Storage',
          objective: 'Understand durable page framing',
          prompt: 'Explain how higher storage layers rely on lower page primitives.',
          answer: 'Higher layers depend on primitive framing and write-ahead log durability.',
          hint: 'Think about page framing.',
          explanation: 'Page framing and write-ahead logging form the foundation before buffer pools.',
          misconception: 'Assuming the cache replaces durable logs.',
          citations: [{ sourceId: 'pdf-sys-p1', quote: quote1 }],
        },
        {
          id: 'c2',
          kind: 'quiz',
          topic: 'Concurrency Control',
          objective: 'Compare optimistic and mutex strategies',
          prompt: 'Which mechanism avoids read locks by checking versions at commit?',
          options: [
            { id: 'a', text: 'Optimistic validation checks commit versions', correct: true, explanation: 'Reads proceed without locks.' },
            { id: 'b', text: 'Acquire a mutex before every read', correct: false, explanation: 'That blocks concurrent readers.' },
          ],
          hint: 'Consider commit validation.',
          explanation: 'Optimistic concurrency avoids blocking reads and detects conflicts at commit.',
          misconception: 'Equating optimistic validation with mutex locking.',
          citations: [{ sourceId: 'pdf-sys-p2', quote: quote2 }],
        },
      ]
    : [
        {
          id: 'c1',
          kind: 'flashcard',
          topic: '分层存储基础',
          objective: '理解持久化页帧与预写日志',
          prompt: '说明上层存储引擎为什么依赖更底层的结构约束。',
          answer: '上层索引与缓存依赖 底层前置 页帧布局与预写日志校验。',
          hint: '想一想页帧与持久化。',
          explanation: '底层页帧布局与预写日志共同保证了崩溃恢复与持久性。',
          misconception: '以为内存缓存能替代磁盘预写日志。',
          citations: [{ sourceId: 'pdf-sys-p1', quote: quote1 }],
        },
        {
          id: 'c2',
          kind: 'quiz',
          topic: '并发控制机制',
          objective: '区分乐观并发与互斥锁',
          prompt: '下列哪种机制不在读阶段加锁、只在提交时校验冲突？',
          options: [
            { id: 'a', text: '乐观锁 机制只在提交时校验版本号', correct: true, explanation: '读取阶段不加阻塞锁。' },
            { id: 'b', text: '每次读取都必须先持有 互斥锁 再继续', correct: false, explanation: '互斥锁属于悲观阻塞策略。' },
          ],
          hint: '注意检查冲突的时机。',
          explanation: '乐观并发控制假设冲突稀少，只在提交时核对版本。',
          misconception: '把乐观校验和互斥阻塞混为一谈。',
          citations: [{ sourceId: 'pdf-sys-p2', quote: quote2 }],
        },
      ];
  return { chapter1, chapter2, sources, cards };
}

async function seedLibrary(root, lang) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  const { sources, cards } = libraryFixtures(lang);
  await service.store.update((state) => {
    state.sources.push(...sources);
    state.decks.push({
      id: 'd',
      title: lang === 'en' ? 'Systems Foundations' : '系统基础题组',
      course: COURSE,
      folder: '',
      publishedAt: '2026-10-01T00:00:00.000Z',
      cards,
    });
    state.focus = { mode: 'class', course: COURSE, role: '', jd: '', targetTopics: [] };
  });
  service.dispose?.();
}

async function dragPhrase(page, rootSelector, phrase, occurrence = 0) {
  const pt = await page.evaluate(
    ([sel, target, occ]) => {
      const root = document.querySelector(sel);
      if (!root) return null;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let node; (node = walker.nextNode()); ) {
        if (node.parentElement?.closest?.('[aria-hidden="true"]')) continue;
        let from = 0;
        while (from <= node.data.length - target.length) {
          const idx = node.data.indexOf(target, from);
          if (idx < 0) break;
          if (seen === occ) {
            node.parentElement?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
            const startRange = document.createRange();
            startRange.setStart(node, idx);
            startRange.setEnd(node, idx + 1);
            const endRange = document.createRange();
            endRange.setStart(node, idx + target.length - 1);
            endRange.setEnd(node, idx + target.length);
            const sRect = startRange.getClientRects()[0] || startRange.getBoundingClientRect();
            const eRect = endRange.getClientRects()[0] || endRange.getBoundingClientRect();
            return {
              startX: sRect.left + 2,
              startY: sRect.top + sRect.height / 2,
              endX: eRect.right - 2,
              endY: eRect.top + eRect.height / 2,
            };
          }
          seen++;
          from = idx + target.length;
        }
      }
      return null;
    },
    [rootSelector, phrase, occurrence],
  );
  if (!pt) throw new Error(`Missing "${phrase}" (occ ${occurrence}) in ${rootSelector}`);
  await page.mouse.move(pt.startX, pt.startY);
  await page.mouse.down();
  await page.mouse.move(pt.endX, pt.endY, { steps: 6 });
  await page.mouse.up();
}

async function takeShot(page, name) {
  if (!SHOTS) return;
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** 开始今日学习 on the home page. If it does not come within the same 30 s, the failure says what the page showed and logged instead
    (CI run 45918312676 gave only the locator, so nothing told whether the page was blank, still loading or in another state). */
async function startToday(page, errors) {
  try {
    await page.locator('[data-usage="home.start"]').first().click({ timeout: 30000 });
  } catch (error) {
    const shown = await page.locator('body').innerText({ timeout: 2000 }).catch(() => '(unreadable)');
    error.message += `
  the page showed: ${shown.replace(/\s+/g, ' ').slice(0, 600)}
  the page logged: ${errors.join(' | ') || '(nothing)'}`;
    throw error;
  }
}

async function chooseMore(page, item) {
  await page.locator('.review-more-trigger').click();
  await page.getByRole('menuitem', { name: item }).click();
}

async function triggerTermsFill(page, { rootSelector, phrase, expectedFollowups = 1 }) {
  const termsBtn = page.locator('[data-usage="review.terms"]');
  await termsBtn.waitFor({ timeout: 15000 });
  if ((await termsBtn.getAttribute('aria-pressed')) !== 'true') await termsBtn.click();
  await settleAnimations(page);
  await dragPhrase(page, rootSelector, phrase, 0);
  await page.locator('.term-strip__fill').waitFor({ timeout: 10000 });
  await page.keyboard.press('Escape');
  await page.locator('.term-strip__fill').click();
  await page.waitForFunction(
    (count) => document.querySelectorAll('.explanation-followup .followup-item').length >= count
      && !document.querySelector('.assist-status .assist-status__spinner'),
    expectedFollowups,
    { timeout: 30000 },
  );
}

test('chapter basics hint (#1191, #1193): deeper trigger, source dock/dialog, hand-off, mute in settings, close, refill, exam, en', { timeout: 600000 }, async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`);
    return;
  }
  scrubProcessEnv();
  const dist = await mkdtemp(join(tmpdir(), 'study-chapter-hint-dist-'));
  await buildPreview({ outdir: dist });
  t.after(async () => {
    await browser.close();
    await rm(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // 1. ZH @ 1280: deeper -> hint below TermChips -> dock reader -> close dock -> hand-off receipt -> mute -> Settings switch off
  {
    const running = await startLateServer({ distDir: dist, lang: 'zh', seed: (root) => seedLibrary(root, 'zh') });
    const { context, page, errors } = await openPage(browser, running, { lang: 'zh', theme: 'light', width: 1280, height: 900 });
    try {
      await page.goto(running.server.url);
      await startToday(page, errors);
      await page.locator('.question-toolbar').waitFor({ timeout: 30000 });
      await page.locator('[data-usage="review.flip"]').click();
      await page.locator('.flip-back[aria-hidden="false"]').waitFor({ timeout: 10000 });
      await settleAnimations(page);

      await triggerTermsFill(page, { rootSelector: '.flip-back[aria-hidden="false"] .flash-prompt', phrase: '底层前置', expectedFollowups: 1 });
      const hint = page.locator('[data-chapter-hint]');
      await hint.waitFor({ timeout: 15000 });
      await settleAnimations(page);

      const layout = await page.evaluate(() => {
        const chips = document.querySelector('.term-strip')?.getBoundingClientRect();
        const block = document.querySelector('[data-chapter-hint]')?.getBoundingClientRect();
        const primaries = document.querySelectorAll('[data-chapter-hint] .sh-btn--primary').length;
        const disabledGrades = [...document.querySelectorAll('.grade-scale .grade')].filter((el) => el.disabled).length;
        return {
          chipsBottom: chips?.bottom ?? 0,
          hintTop: block?.top ?? 0,
          primaries,
          disabledGrades,
          gradeCount: document.querySelectorAll('.grade-scale .grade').length,
        };
      });
      assert.ok(layout.hintTop >= layout.chipsBottom - 1, 'chapter hint sits below TermChips');
      assert.equal(layout.primaries, 0, 'chapter hint never uses a filled primary button');
      assert.equal(layout.disabledGrades, 0, 'grading buttons stay enabled while hint shows');
      assert.equal(layout.gradeCount, 6);
      assert.match(await hint.innerText(), /第 1 章 底层存储/);
      await hint.scrollIntoViewIfNeeded();
      await settleAnimations(page);
      await takeShot(page, 'chapter-hint-zh-1280');

      // Open source alongside -> docks into .source-column at 1280px, question stays on left
      await hint.locator('.chapter-hint__source').click();
      await page.locator('.source-column').waitFor({ timeout: 15000 });
      await settleAnimations(page);
      const dockBoxes = await page.evaluate(() => {
        const q = document.querySelector('.question-card')?.getBoundingClientRect();
        const col = document.querySelector('.source-column')?.getBoundingClientRect();
        return { qRight: q?.right ?? 0, colLeft: col?.left ?? 0, qVisible: !!q && q.width > 200 };
      });
      assert.ok(dockBoxes.qVisible && dockBoxes.qRight <= dockBoxes.colLeft + 2, 'source docks to right while question remains on left');
      await takeShot(page, 'chapter-hint-dock-zh-1280');

      // Closing dock leaves us on the same question with hint still present
      await page.locator('.source-column button[aria-label="关闭资料栏"]').click();
      await page.locator('.source-column').waitFor({ state: 'detached', timeout: 10000 });
      assert.match(await page.locator('.flip-back[aria-hidden="false"]').innerText(), /底层前置/);
      assert.equal(await hint.count(), 1);

      // Hand-off to main chat shows receipt or preview sheet
      await hint.locator('[data-hand-off="question.basics"]').click();
      const sheet = page.locator('dialog.sh-handoff-sheet[open]');
      const toast = page.locator('[role="status"], .sh-toast').filter({ hasText: /已复制|主会话|问法/ });
      await until(async () => (await sheet.count()) > 0 || (await toast.count()) > 0, 'hand-off receipt');
      if ((await sheet.count()) > 0) {
        assert.match(await sheet.locator('.sh-handoff-sheet__ask').innerText(), /第 1 章 底层存储/);
        await sheet.locator('button[aria-label*="关闭"], button:has-text("关闭")').first().click().catch(() => page.keyboard.press('Escape'));
        await sheet.waitFor({ state: 'detached', timeout: 10000 });
      }

      // Clicking "这类不再提示" closes the hint AND disables the switch in Settings › 引导
      await hint.locator('.chapter-hint__mute').click();
      await hint.waitFor({ state: 'detached', timeout: 10000 });
      const navSettings = await revealNavRow(page, 'settings');
      await navSettings.dispatchEvent('click');
      await page.locator('[data-category="guidance"]').click();
      const itemSwitch = page.locator('[data-guidance-item="practice.chapter-basics"] input[role="switch"]');
      await itemSwitch.waitFor({ timeout: 15000 });
      assert.equal(await itemSwitch.isChecked(), false, 'Settings › 引导 switch is off after mute');
      assert.deepEqual(errors.filter((e) => !REFUSED.test(e)), [], `zh@1280 errors: ${errors.join(' | ')}`);
    } finally {
      await context.close();
      await running.close();
    }
  }

  // 2. ZH @ 420: SourceReaderDialog with 回到这道题 + close button + grading/options/next stay enabled + refill (b) on Card 2
  {
    const running = await startLateServer({ distDir: dist, lang: 'zh', seed: (root) => seedLibrary(root, 'zh') });
    const { context, page, errors } = await openPage(browser, running, { lang: 'zh', theme: 'light', width: 420, height: 900 });
    try {
      await page.goto(running.server.url);
      await startToday(page, errors);
      await page.locator('.question-toolbar').waitFor({ timeout: 30000 });
      await page.locator('[data-usage="review.flip"]').click();
      await page.locator('.flip-back[aria-hidden="false"]').waitFor({ timeout: 10000 });

      await triggerTermsFill(page, { rootSelector: '.flip-back[aria-hidden="false"] .flash-prompt', phrase: '底层前置', expectedFollowups: 1 });
      const hint = page.locator('[data-chapter-hint]');
      await hint.waitFor({ timeout: 15000 });
      await settleAnimations(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      assert.ok(overflow, '420px: no horizontal overflow when chapter hint shows');
      await hint.scrollIntoViewIfNeeded();
      await settleAnimations(page);
      await takeShot(page, 'chapter-hint-zh-420');

      // At 420px, clicking 在旁边读原文 opens SourceReaderDialog with 「回到这道题」
      await hint.locator('.chapter-hint__source').click();
      const dialog = page.locator('dialog[open], [role="dialog"]').last();
      await dialog.waitFor({ timeout: 15000 });
      assert.equal(await page.locator('.source-column').count(), 0, '420px: uses dialog rather than side column');
      const backBtn = dialog.getByRole('button', { name: '回到这道题' });
      await backBtn.waitFor({ timeout: 10000 });
      await backBtn.click();
      await dialog.waitFor({ state: 'detached', timeout: 10000 });
      assert.equal(await hint.count(), 1, 'returning from narrow dialog stays on the same question');

      // Top-right close hides the hint; grading buttons stay enabled while hint was shown
      const gradesDisabled = await page.evaluate(() => [...document.querySelectorAll('.grade-scale .grade')].some((el) => el.disabled));
      assert.equal(gradesDisabled, false, '420px: flashcard grading buttons stay enabled while hint is visible');
      await hint.locator('.chapter-hint__close').click();
      await hint.waitFor({ state: 'detached', timeout: 10000 });
      await page.locator('.grade-scale .grade').nth(4).click();

      // Advance to Card 2 (Chapter 2): 1st fill (no deeper) -> no hint; 2nd fill -> (b) shows hint; answering enables next button while hint stays visible
      await page.locator('.options .option:not([disabled])').first().waitFor({ timeout: 15000 });
      await triggerTermsFill(page, { rootSelector: '.options', phrase: '乐观锁', expectedFollowups: 1 });
      assert.equal(await hint.count(), 0, 'first fill within 2 layers shows no chapter hint');
      await triggerTermsFill(page, { rootSelector: '.options', phrase: '互斥锁', expectedFollowups: 2 });
      await hint.waitFor({ timeout: 15000 });
      assert.match(await hint.innerText(), /第 2 章 一致性模型/, 'second fill triggers hint with Chapter 2 name');
      await page.locator('.options .option').first().click();
      await page.locator('.next-due').waitFor({ timeout: 15000 });
      const nextBtn = page.locator('[data-usage="review.next"]');
      await until(async () => !(await nextBtn.isDisabled()), 'next button stays enabled after answering with hint open');
      assert.equal(await hint.count(), 1, 'chapter hint remains visible and never disables navigation');
      assert.deepEqual(errors.filter((e) => !REFUSED.test(e)), [], `zh@420 errors: ${errors.join(' | ')}`);
    } finally {
      await context.close();
      await running.close();
    }
  }

  // 3. Exam mode @ 1280: never appears during mock exam even if card carries deeper followups
  {
    const base = await mkdtemp(join(tmpdir(), 'study-chapter-hint-exam-'));
    let server = null;
    try {
      const root = join(base, 'library');
      await mkdir(root, { recursive: true });
      const service = new StudyService(root);
      await service.call('snapshot');
      const { sources, cards } = libraryFixtures('zh');
      cards[0].followups = [{ id: 'f-terms', kind: 'terms', source: 'assistant', terms: ['底层前置'], deeper: ['二进制与底层前置'], question: '补词：底层前置', answer: '说明' }];
      await service.store.update((state) => {
        state.sources.push(...sources);
        state.decks.push({ id: 'd', title: '系统基础题组', course: COURSE, publishedAt: '2026-10-01T00:00:00.000Z', cards });
      });
      service.dispose?.();
      server = await createPreviewServer({ libraryRoot: root, home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir: dist });
      const snapshot = await previewCall(server, 'snapshot', {});
      const { context, page, errors } = await openPage(browser, { server }, { lang: 'zh', theme: 'light', width: 1280, height: 900 });
      try {
        await context.addInitScript(([key, value]) => { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* blocked */ } },
          [`study-page-scope:v1:${JSON.stringify([snapshot.root, 'exam'])}`, COURSE]);
        await page.goto(server.url);
        await page.locator('aside, nav').first().waitFor({ timeout: 30000 });
        const examEntry = await revealNavRow(page, 'exam');
        await examEntry.dispatchEvent('click');
        await page.locator('.es-sheet').waitFor({ timeout: 30000 });
        await page.getByRole('button', { name: '开始考试' }).click();
        await page.locator('.exam-card').waitFor({ timeout: 30000 });
        assert.equal(await page.locator('[data-chapter-hint]').count(), 0, 'never appears in mock exam');
        assert.deepEqual(errors.filter((e) => !REFUSED.test(e)), [], `exam errors: ${errors.join(' | ')}`);
      } finally {
        await context.close();
      }
    } finally {
      if (server) await server.close();
      await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }

  // 4. EN @ 1280: triggers in English with zero Han characters
  {
    const running = await startLateServer({ distDir: dist, lang: 'en', seed: (root) => seedLibrary(root, 'en') });
    const { context, page, errors } = await openPage(browser, running, { lang: 'en', theme: 'light', width: 1280, height: 900 });
    try {
      await page.goto(running.server.url);
      await startToday(page, errors);
      await page.locator('.question-toolbar').waitFor({ timeout: 30000 });
      await page.locator('[data-usage="review.flip"]').click();
      await page.locator('.flip-back[aria-hidden="false"]').waitFor({ timeout: 10000 });

      await triggerTermsFill(page, { rootSelector: '.flip-back[aria-hidden="false"] .flash-prompt', phrase: 'primitive', expectedFollowups: 1 });
      const hint = page.locator('[data-chapter-hint]');
      await hint.waitFor({ timeout: 15000 });
      await settleAnimations(page);
      const hintText = await hint.innerText();
      assert.match(hintText, /Chapter 1 Storage Primitives/);
      assert.match(hintText, /Read source alongside/);
      // This standalone preview has no DSH chat. Capture its clipboard write without changing the user's clipboard.
      let copied = '';
      await page.exposeFunction('captureChapterPrompt', text => { copied = text; });
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
        configurable: true, value: { writeText: globalThis.captureChapterPrompt },
      }));
      assert.equal(await hint.getByRole('button', { name: 'Ask main chat to teach' }).count(), 0);
      await hint.getByRole('button', { name: 'Copy explanation prompt', exact: true }).click();
      await until(() => copied.includes('Chapter 1 Storage Primitives'), 'the copied prompt includes the source chapter');
      assert.match(hintText, /Don't show this tip again/);
      assert.doesNotMatch(hintText, /[㐀-鿿]/, 'English hint contains no Chinese characters');
      await hint.scrollIntoViewIfNeeded();
      await settleAnimations(page);
      await takeShot(page, 'chapter-hint-en-1280');
      assert.deepEqual(errors.filter((e) => !REFUSED.test(e)), [], `en@1280 errors: ${errors.join(' | ')}`);
    } finally {
      await context.close();
      await running.close();
    }
  }

  // 5. ZH @ 1280 (#1216): fresh completion shows hint; leaving & returning in same round does NOT re-show; ending round & starting a new round on same card does NOT show historical deeper
  {
    const running = await startLateServer({ distDir: dist, lang: 'zh', seed: (root) => seedLibrary(root, 'zh') });
    const { context, page, errors } = await openPage(browser, running, { lang: 'zh', theme: 'light', width: 1280, height: 900 });
    try {
      await page.goto(running.server.url);
      await startToday(page, errors);
      await page.locator('.question-toolbar').waitFor({ timeout: 30000 });
      await page.locator('[data-usage="review.flip"]').click();
      await page.locator('.flip-back[aria-hidden="false"]').waitFor({ timeout: 10000 });
      await settleAnimations(page);

      // Fresh fill with deeper shows hint.
      await triggerTermsFill(page, { rootSelector: '.flip-back[aria-hidden="false"] .flash-prompt', phrase: '底层前置', expectedFollowups: 1 });
      const hint = page.locator('[data-chapter-hint]');
      await hint.waitFor({ timeout: 15000 });

      // Leave Card 1 via 先跳过 and come back via 上一题 in the same round -> must NOT show hint.
      await chooseMore(page, /先跳过/);
      await page.locator('.options .option:not([disabled])').first().waitFor({ timeout: 15000 });
      await page.locator('[data-usage="review.prev"]').click();
      await page.locator('.flip-back[aria-hidden="false"]').waitFor({ timeout: 15000 });
      await settleAnimations(page);
      assert.match(await page.locator('.flip-back[aria-hidden="false"]').innerText(), /底层前置/);
      assert.equal(await hint.count(), 0, 'leaving and returning in the same round does not re-show chapter hint');

      // End Round 1 via 到此为止 and start Round 2 in the same session -> historical deeper does NOT show on open.
      await chooseMore(page, /到此为止…/);
      await page.locator('.round-end-confirm').waitFor({ timeout: 10000 });
      await page.getByRole('button', { name: '到此为止，看结果' }).click();
      await page.locator('.result-page').waitFor({ timeout: 15000 });
      const navLibrary = await revealNavRow(page, 'library');
      await navLibrary.dispatchEvent('click');
      await startToday(page, errors);
      await page.locator('.question-toolbar').waitFor({ timeout: 30000 });
      const topicTicks = page.locator('.review-navigator .review-tick[aria-label*="分层存储基础"]');
      const tickCount = await topicTicks.count();
      for (let i = tickCount - 1; i >= 0; i -= 1) {
        if (await page.evaluate(() => /上层存储引擎/.test(document.querySelector('.question-card')?.textContent || ''))) break;
        const tick = topicTicks.nth(i);
        if ((await tick.getAttribute('aria-current')) !== 'step') {
          await tick.click();
          await settleAnimations(page);
        }
      }
      await page.waitForFunction(() => /上层存储引擎/.test(document.querySelector('.question-card')?.textContent || ''), null, { timeout: 15000 });
      await page.locator('[data-usage="review.flip"]').click();
      await page.locator('.flip-back[aria-hidden="false"]').waitFor({ timeout: 10000 });
      await settleAnimations(page);
      await page.locator('[data-tour="review-hint"]').click();
      await page.locator('.explanation-followup .followup-item').first().waitFor({ timeout: 15000 });
      await settleAnimations(page);
      assert.equal(await hint.count(), 0, 'starting a new round on the same card does not re-show historical deeper hint');
      assert.deepEqual(errors.filter((e) => !REFUSED.test(e)), [], `zh@1280 revisit/new-round errors: ${errors.join(' | ')}`);
    } finally {
      await context.close();
      await running.close();
    }
  }

  // 6. ZH @ 1280 (#1216): pre-existing historical deeper followup (at < enteredAt) never triggers on open, while a fresh 补齐 completion on that card does
  {
    const running = await startLateServer({
      distDir: dist,
      lang: 'zh',
      seed: async (root) => {
        await seedLibrary(root, 'zh');
        const service = new StudyService(root);
        await service.call('snapshot');
        await service.store.update((state) => {
          const card = state.decks.find((d) => d.id === 'd')?.cards?.[0];
          if (!card) return;
          card.followups = [{
            id: 'f-old-terms',
            at: '2026-10-01T00:00:00.000Z',
            digest: followupDigest(card),
            kind: 'terms',
            source: 'assistant',
            terms: ['页帧布局'],
            deeper: ['二进制与底层前置'],
            question: '补词：页帧布局',
            answer: '### **页帧布局**\n- 问题：历史补词记录',
          }];
        });
        service.dispose?.();
      },
    });
    const { context, page, errors } = await openPage(browser, running, { lang: 'zh', theme: 'light', width: 1280, height: 900 });
    try {
      await page.goto(running.server.url);
      await startToday(page, errors);
      await page.locator('.question-toolbar').waitFor({ timeout: 30000 });
      await page.locator('[data-usage="review.flip"]').click();
      await page.locator('.flip-back[aria-hidden="false"]').waitFor({ timeout: 10000 });
      await settleAnimations(page);
      await page.locator('[data-tour="review-hint"]').click();
      await page.locator('.explanation-followup .followup-item').first().waitFor({ timeout: 15000 });
      assert.match(await page.locator('.explanation-followup .followup-item').first().innerText(), /页帧布局/);
      await settleAnimations(page);

      const hint = page.locator('[data-chapter-hint]');
      assert.equal(await hint.count(), 0, 'opening a card with pre-existing historical deeper followup does not show hint');

      await triggerTermsFill(page, { rootSelector: '.flip-back[aria-hidden="false"] .flash-prompt', phrase: '底层前置', expectedFollowups: 2 });
      await hint.waitFor({ timeout: 15000 });
      assert.match(await hint.innerText(), /第 1 章 底层存储/, 'fresh completion on the card shows chapter hint');
      assert.deepEqual(errors.filter((e) => !REFUSED.test(e)), [], `zh@1280 historical+fresh errors: ${errors.join(' | ')}`);
    } finally {
      await context.close();
      await running.close();
    }
  }
});
