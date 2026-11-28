/* global document, window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { openPage, settleAnimations, startLateServer } from '../scripts/qa/layout-late.mjs';

/* #1678: entering a flashcard round via 回到题目 and flipping the first card used to push all six
   0–5 grade buttons below the viewport at 1440×900, 1536×730, and 1280×720 (and even the second
   card at 1536×730) because .flash-area added up to 128px of top gap and .flip-face hardcoded
   480px/400px min-height regardless of viewport height. Verify both card 1 and a longer card 2
   keep all six rating buttons fully inside the viewport without scrolling. */

const CARDS = [
  {
    id: 'c1',
    kind: 'flashcard',
    topic: 'Bridge',
    objective: 'Recall',
    prompt: '桥接模式（Bridge）把哪两个独立变化的维度拆开？',
    answer: '把抽象层（面向调用方的接口/控制逻辑）与实现层（底层平台或渲染方式）通过组合拆开，让两者可以各自独立扩展，避免 M×N 类爆炸。',
    hint: '',
    explanation: '用组合代替多层继承。',
    misconception: '',
    citations: [],
  },
  {
    id: 'c2',
    kind: 'flashcard',
    topic: 'Observer',
    objective: 'Recall',
    prompt: '为什么在复杂事件流中要警惕观察者模式的级联更新？',
    answer: [
      '当多个观察者相互订阅并修改共享状态时，一次变更会触发多跳隐式通知，难以追踪执行顺序，还可能造成循环通知、重复渲染或脏读。',
      '',
      '常见缓解办法：',
      '1. 单向数据流或事件队列异步批处理；',
      '2. 明确状态拥有者与派生计算边界；',
      '3. 在订阅层加入防重入或版本去重机制，并记录依赖图方便排障。',
    ].join('\n'),
    hint: '',
    explanation: '单向数据流让更新路径可预测。',
    misconception: '',
    citations: [],
  },
];

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update((state) => {
    state.decks.push({ id: 'd1', title: '设计模式示例', course: '示例课程', cards: CARDS });
  });
  await service.dispose();
}

async function measureGrades(page) {
  await page.locator('.grade-scale').waitFor({ timeout: 20000 });
  await settleAnimations(page);
  return page.evaluate(() => {
    const vh = window.innerHeight;
    const buttons = [...document.querySelectorAll('.grade-scale .grade[aria-label*="分："]')];
    const rects = buttons.map((el) => {
      const r = el.getBoundingClientRect();
      return { grade: el.dataset.grade, top: Math.round(r.top), bottom: Math.round(r.bottom) };
    });
    const card = document.querySelector('.question-card')?.getBoundingClientRect();
    return {
      vh,
      count: rects.length,
      fullyVisible: rects.filter((r) => r.top >= 0 && r.bottom <= vh).length,
      minTop: rects.length ? Math.min(...rects.map((r) => r.top)) : 0,
      maxBottom: rects.length ? Math.max(...rects.map((r) => r.bottom)) : 0,
      cardTop: Math.round(card?.top || 0),
    };
  });
}

test('entering a flashcard round keeps all 6 rating buttons inside the viewport on flip (#1678)', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/Executable doesn't exist/.test(error.message)) throw error;
    t.skip('Chromium unavailable');
    return;
  }
  const dist = await mkdtemp(join(tmpdir(), 'study-1678-dist-'));
  await buildPreview({ outdir: dist });
  t.after(async () => {
    await browser.close();
    await rm(dist, { recursive: true, force: true });
  });

  const viewports = [
    { width: 1440, height: 900 },
    { width: 1536, height: 730 },
    { width: 1280, height: 720 },
  ];

  for (const viewport of viewports) {
    // Use an isolated library per viewport so grading card 1 in one viewport never reorders the path queue in the next.
    const running = await startLateServer({ distDir: dist, seed });
    try {
      await running.api('review.start', {
        mode: 'path',
        scope: CARDS.map((card) => ({ deckId: 'd1', cardId: card.id })),
        fresh: true,
      });
      const { page, errors, context } = await openPage(browser, running, {
        lang: 'zh',
        theme: 'light',
        width: viewport.width,
        height: viewport.height,
        selfGradeAdvance: true,
      });
      try {
        await page.goto(running.server.url);
        await page.getByRole('button', { name: '回到题目' }).first().click({ timeout: 20000 });
        await page.waitForFunction(
          () => {
            const prompt = document.querySelector('.flip-front .flash-prompt')?.textContent || '';
            const flipBtn = document.querySelector('[data-usage="review.flip"]');
            return /桥接模式/.test(prompt) && !!flipBtn && !flipBtn.disabled;
          },
          null,
          { timeout: 20000 },
        );
        await settleAnimations(page);

        if (viewport.width === 1440 && viewport.height === 900) {
          const nextBottom = await page.evaluate(() => Math.round(
            document.querySelector('[data-usage="review.next"]')?.getBoundingClientRect().bottom || 0,
          ));
          assert.ok(nextBottom > 0 && nextBottom <= viewport.height,
            `1440x900 front face: 下一题 button bottom (${nextBottom}px) stays inside ${viewport.height}px`);
        }

        // First flashcard: flip with Space and verify all 6 rating buttons fit without scrolling.
        await page.keyboard.press('Space');
        const card1 = await measureGrades(page);
        assert.equal(card1.count, 6, `${viewport.width}x${viewport.height} card 1 renders 6 rating buttons`);
        assert.equal(card1.fullyVisible, 6,
          `${viewport.width}x${viewport.height} card 1: all 6 rating buttons visible without scroll (${JSON.stringify(card1)})`);
        assert.ok(card1.maxBottom <= viewport.height,
          `${viewport.width}x${viewport.height} card 1: rating bottom (${card1.maxBottom}px) <= viewport (${viewport.height}px)`);

        // Grade card 1 to advance to card 2 (longer multi-paragraph answer), wait for card 2 to mount unflipped and idle, then flip.
        await page.keyboard.press('4');
        await page.waitForFunction(
          () => {
            const prompt = document.querySelector('.flip-front .flash-prompt')?.textContent || '';
            const card = document.querySelector('.flashcard');
            const flipBtn = document.querySelector('[data-usage="review.flip"]');
            return /观察者模式|级联更新/.test(prompt)
              && !!card
              && !card.classList.contains('flipped')
              && !document.querySelector('.grade-scale')
              && !!flipBtn
              && !flipBtn.disabled;
          },
          null,
          { timeout: 20000 },
        );
        await page.keyboard.press('Space');
        const card2 = await measureGrades(page);
        assert.equal(card2.count, 6, `${viewport.width}x${viewport.height} card 2 renders 6 rating buttons`);
        assert.equal(card2.fullyVisible, 6,
          `${viewport.width}x${viewport.height} card 2: all 6 rating buttons visible without scroll (${JSON.stringify(card2)})`);
        assert.ok(card2.maxBottom <= viewport.height,
          `${viewport.width}x${viewport.height} card 2: rating bottom (${card2.maxBottom}px) <= viewport (${viewport.height}px)`);

        assert.deepEqual(errors, [], `${viewport.width}x${viewport.height}: zero page errors`);
      } finally {
        await context.close();
      }
    } finally {
      await running.close();
    }
  }
});
