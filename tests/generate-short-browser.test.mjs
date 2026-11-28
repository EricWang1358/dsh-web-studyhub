/* global document, window, getComputedStyle -- page.evaluate callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { drainLayoutStability, judgeLayoutStability } from '../scripts/qa/layout-stability.mjs';
import { frames, openPage, settleAnimations, until } from '../scripts/qa/layout-late.mjs';
import { StudyService } from '../lib/service.js';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';

/* 创建题组 in the browser preview on a seeded library: the page opens with the current course's documents that have no question ticked and says why, the main path is the question types,
   出题方式 (three presets 快问 / 情境题 / 逐题精出 with their rough costs, lib/contexts/generation/presets.js) and one line for the course (更改 opens the one field of it, #665) with 前往设置, the plan
   (rounds, tokens) is said once under the form, everything optional is in 更多选项 (with 覆盖强度: 精简 / 标准 / 完整 / 自定义, one on at a time, #664; 出题深度; the matrix of rough costs)
   and the page is at most about one and a half screens before it is opened (#667), and 前往设置 lands on 出题偏好.
   At 1280 and 420 px, no sideways scroll, no layout shift. EXAM_PREP_SHOTS-style switch: GENERATE_SHOTS=<dir> writes screenshots. */

const SHOTS = process.env.GENERATE_SHOTS || '';
const STAMP = '2026-10-01T08:00:00.000Z';
const body = n => `## 第 ${n} 节\n\n${`数据库索引加快查找，事务保证一致性，范式减少冗余。第 ${n} 节的内容。`.repeat(60)}`;
const note = (id, title, courses, n) => ({ id, title, text: body(n), createdAt: STAMP, courses, chars: body(n).length, excerpt: body(n).slice(0, 160) });

async function seed(root, { staged = false } = {}) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  // 逐题精出 chosen under 高级生成控制 (one pass, the default, says a range).
  if (staged) await service.call('settings', { generation: { strategy: 'staged' } });
  await service.store.update(state => {
    state.sources.push(note('n1', '索引与查询.md', ['数据库'], 1), note('n2', '事务与并发.md', ['数据库'], 2), note('n3', '范式.md', ['数据库'], 3), note('n4', '路由.md', ['网络'], 4));
    // 范式.md already has questions: a published deck cites it.
    state.decks.push({ id: 'd1', title: '范式小测', course: '数据库', cards: [{ id: 'c1', kind: 'flashcard', topic: '范式', prompt: '什么是第三范式？', answer: '消除传递依赖', explanation: '范式减少冗余。',
      citations: [{ sourceId: 'n3', quote: '范式减少冗余' }] }] });
    state.focus = { ...(state.focus || {}), course: '数据库', mode: 'class' };
  });
  service.dispose?.();
}

async function start(distDir, options) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-generate-short-'));
  const root = join(base, 'library');
  await seed(root, options);
  const server = await createPreviewServer({ libraryRoot: root, home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 20 }), distDir });
  return { server, base, close: async () => { await server.close(); await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } };
}

async function openApp(browser, running, { lang = 'zh', width = 1280, height = 900 } = {}) {
  const opened = await openPage(browser, running, { lang, theme: 'dark', width, height });
  await opened.page.goto(running.server.url);
  await opened.page.locator('aside, nav').first().waitFor({ timeout: 30000 });
  return opened;
}

const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }); };
// The whole page, however tall: the viewport is made tall for the shot (the shell scrolls inside it) and put back.
const shotForm = async (page, name) => {
  if (!SHOTS) return;
  const size = page.viewportSize();
  await page.setViewportSize({ width: size.width, height: 2400 });
  await frames(page, 3);
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
  await page.setViewportSize(size);
};
const goGenerate = async page => {
  await (await revealNavRow(page, 'generate')).dispatchEvent('click');
  await page.locator('.generate-page form').waitFor({ timeout: 30000 });
};

test('创建题组 opens ticked with a reason, the main path is one line, the plan is said once, and 前往设置 lands on 出题偏好, at 1280 and 420 px', { timeout: 900000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-generate-short-dist-'));
  await buildPreview({ outdir: dist });
  const running = await start(dist);
  try {
    for (const width of [1280, 420]) {
      const { page, errors, context } = await openApp(browser, running, { width });
      await goGenerate(page);
      await settleAnimations(page);
      await frames(page, 4);
      await drainLayoutStability(page);
      assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll`);

      // opened ticked: the two notes of the current course that have no question; the one with a deck and the other course are not
      const ticked = page.locator('.source-picker__item.is-selected');
      await until(async () => (await ticked.count()) === 2, 'the two documents without questions are ticked');
      const names = await ticked.locator('strong').allInnerTexts();
      assert.deepEqual(names.sort(), ['事务与并发', '索引与查询'], 'the course\'s documents without questions');
      const reason = page.locator('[data-opening-reason]');
      assert.match(await reason.innerText(), /已选中「数据库」里还没出过题的 2 份资料。\s*没选：已出过题的 1 份。/, 'and the line says why, and what it left out');

      // the main path: 出题方式 is one choice of three presets, the course is one line with a link, nothing else to fill in
      const plan = page.locator('[data-generate-plan]');
      assert.match(await plan.innerText(), /新题组放进的课程\s+数据库/);
      assert.equal(await plan.locator('input, select, textarea').count(), 0, 'nothing to fill in on the plan line');
      assert.equal(await page.locator('.generate-page .course-field').count(), 0, 'the field of the deck\'s course waits for 更改: the page has one course field (课程范围)');
      const pressedOf = items => async () => (await items.evaluateAll(list => list.filter(item => item.getAttribute('aria-pressed') === 'true').map(item => item.textContent.trim())));
      const presets = page.locator('[data-presets] .sh-seg__item'), presetOn = pressedOf(presets), presetNote = page.locator('[data-preset-note]');
      assert.deepEqual(await presets.allInnerTexts(), ['快问', '情境题', '逐题精出']);
      assert.deepEqual(await presetOn(), ['情境题'], 'the default preset');
      assert.match(await presetNote.innerText(), /^情境题（默认）：标准题量/);
      // each preset with its rough cost, read from the estimate of each for these materials; the chosen one's count is said once, by the summary beside the button
      const cost = page.locator('[data-preset-cost]');
      await until(async () => (await cost.getAttribute('data-status')) === 'ready', 'the rough costs of the presets', { timeoutMs: 60000 });
      assert.match(await cost.innerText(), /^大致花费\s*快问 约 ×\d+(?:\.\d)?（\d+(?:–\d+)? 题） · 情境题 ×1 · 逐题精出 约 ×\d+(?:\.\d)?（\d+ 题）$/);
      assert.equal(await cost.locator('[title]').count(), 0, 'its explanation is a hover card, not title=');
      for (const choice of ['快问', '逐题精出', '情境题']) {
        await presets.filter({ hasText: choice }).first().click();
        await until(async () => (await presetOn()).join() === choice, `${choice} is the one preset that is on`);
        assert.match(await presetNote.innerText(), new RegExp(`^${choice}`), `the line under the presets says what ${choice} does`);
      }
      // another question type: the depth means nothing, so the presets are off and say why; back to 单选测验 alone, they are on again
      const openKind = page.locator('[data-tour="generate-kinds"]').getByRole('checkbox', { name: '开放问答' });
      await openKind.click();
      await until(async () => (await page.locator('[data-presets]').getAttribute('data-preset')) === 'off', 'the presets are off for 开放问答');
      assert.match(await presetNote.innerText(), /快问和情境题只用于单选题/);
      assert.equal(await page.locator('[data-presets] .sh-seg__item:disabled').count(), 3);
      await openKind.click();
      await until(async () => (await presetOn()).join() === '情境题', 'the presets are back with 情境题 on');
      await plan.getByRole('button', { name: '更改' }).click();
      await page.locator('.generate-page .course-field').waitFor({ timeout: 10000 });
      assert.equal(await page.locator('.generate-page .course-field').count(), 1);
      await plan.getByRole('button', { name: '收起' }).click();
      assert.equal(await page.locator('.generate-more').evaluate(element => element.open), false, '更多选项 is closed');
      assert.equal(await page.locator('#generate-focus').isVisible(), false, 'the topic box is not on the main path');
      if (width === 1280) {
        // #667: the main path (to the end of the button) is about one and a half screens before 更多选项 is opened (was 1312 px for less, with the types and the strength behind the fold)
        const reach = await page.evaluate(() => { const section = document.querySelector('.generate-page'), button = document.querySelector('[data-tour="generate-submit"]');
          return Math.round(button.getBoundingClientRect().bottom - section.getBoundingClientRect().top); });
        assert.ok(reach <= 900 * 1.3, `the generate button ends ${reach}px down the page (the page, the three ways in and the ticked materials come first: about a screen and a quarter)`);
      }
      // #1076: the header's quiet button hangs its padding: its words stand on the title's edge and its hover box stays inside the page gutter
      const coach = page.getByRole('button', { name: '去教练先校准考法' });
      if (await coach.count()) {
        const edges = await page.evaluate(() => { const button = [...document.querySelectorAll('button')].find(element => element.textContent.includes('去教练先校准考法')), range = document.createRange(); range.selectNodeContents(button);
          const title = document.querySelector('.generate-page h1').getBoundingClientRect(), box = button.getBoundingClientRect(), text = range.getBoundingClientRect(), pane = (document.querySelector('.source-picker__list') || document.querySelector('.generate-page')).getBoundingClientRect();
          return { box: box.left, text: text.left, title: title.left, right: box.right, textRight: text.right, pane: pane.left, paneRight: pane.right }; });
        if (width < 600) { assert.ok(Math.abs(edges.text - edges.title) <= 1.5, `${width}px: the coach link's words start on the title's edge (${edges.text} vs ${edges.title})`); assert.ok(edges.box >= 8, `${width}px: its hover box starts at ${edges.box}, inside the page gutter`); }
        else assert.ok(Math.abs(edges.textRight - edges.paneRight) <= 1.5, `${width}px: the coach link's words end on the list's right edge (${edges.textRight} vs ${edges.paneRight})`);
      }
      // #1082: 更多选项 is one line at both widths
      const summaryHeight = await page.locator('.generate-more > summary').evaluate(element => element.getBoundingClientRect().height);
      assert.ok(summaryHeight <= 50, `${width}px: 更多选项 is one line (${summaryHeight}px)`);
      // the note under the form: what is checked leads (not smaller, not lighter) what it means
      const note = await page.evaluate(() => { const lead = getComputedStyle(document.querySelector('.generate-quality__lead')), detail = getComputedStyle(document.querySelector('.generate-quality small'));
        return { lead: parseFloat(lead.fontSize), detail: parseFloat(detail.fontSize), leadWeight: Number(lead.fontWeight), detailWeight: Number(detail.fontWeight) }; });
      assert.ok(note.lead >= note.detail && note.leadWeight > note.detailWeight, `the headline leads the note: ${JSON.stringify(note)}`);
      assert.equal(await page.getByText('难度', { exact: true }).first().isVisible(), false, 'nor the difficulty');
      // 找功能 keeps every folded control: its anchor is in the page (with a size, so the finder opens the folds around it) while 更多选项 is shut
      for (const anchor of ['generate-kinds', 'generate-preset', 'generate-coverage', 'generate-depth', 'generate-auto', 'generate-course', 'generate-budget', 'generate-difficulty', 'generate-language', 'generate-notation', 'generate-focus', 'generate-reference', 'generate-role', 'generate-extra']) {
        const box = await page.locator(`[data-tour="${anchor}"]`).first().boundingBox();
        assert.ok(box && box.width > 0 && box.height > 0, `the anchor ${anchor} is there for 找功能`);
      }

      // the plan, said once: the estimate and the count under the form, not in the fold
      await until(async () => (await page.locator('[data-generate-estimate] [data-token-estimate][data-status="ready"]').count()) > 0, 'the estimate', { timeoutMs: 60000 });
      const summary = await page.locator('.generate-summary').innerText();
      // One pass (the default) keeps most of what it plans, not all: the count is a range whose upper end is the plan (lib/one-pass/route.js questionRange).
      const said = /出 (\d+)–(\d+) 题/.exec(summary);
      assert.ok(said && Number(said[1]) < Number(said[2]), `the summary line says how many questions, as a range: ${summary}`);
      const count = `${said[1]}–${said[2]}`;
      const formText = await page.locator('.generate-page form').innerText();
      assert.equal((formText.match(new RegExp(`(?<![\\d.])${count} (?:题|道题)`, 'g')) || []).length, 1, `the planned ${count} questions are said once on the page`);
      // the tokens in the bar beside the count, the rest of the plan under it (#1082)
      assert.match(await page.locator('[data-generate-bar] [data-generate-estimate]').innerText(), /^预计 \S+ tok/);
      assert.match(await page.locator('[data-generate-coverage]').innerText(), /覆盖 \d+\/\d+ 个(?:小节|片段)，(?:分 \d+ 轮|一轮出完)，\d+(?:–\d+)? 次模型调用/);
      assert.doesNotMatch(await page.locator('.quality-note').innerText(), /发布时/, 'no promise of a check at publish');
      await shot(page, `main-${width}`);
      await shotForm(page, `main-form-${width}`);
      const mainVerdict = judgeLayoutStability(await drainLayoutStability(page), { maxCls: 0.1 });
      assert.ok(mainVerdict.ok, `${width}px main path: ${mainVerdict.message}`);

      // everything optional is one click away, inside the fold
      await page.locator('.generate-more > summary').click();
      await page.locator('#generate-focus').waitFor({ state: 'visible', timeout: 10000 });
      // room under the summary before the first group, like between the groups
      const room = await page.evaluate(() => { const summary = document.querySelector('.generate-more > summary').getBoundingClientRect(), title = document.querySelector('.generate-more .generate-group__title').getBoundingClientRect();
        const groups = [...document.querySelectorAll('.generate-more .generate-group')].map(group => group.getBoundingClientRect()); return { first: title.top - summary.bottom, between: groups[1].top - groups[0].bottom }; });
      assert.ok(room.first >= 12, `${width}px: the first group starts ${room.first}px under 更多选项 (between groups ${room.between}px)`);
      for (const label of ['难度', '语言', '公式写法', '题组名称（可选）']) assert.ok(await page.locator('.generate-more').getByText(label, { exact: false }).first().isVisible(), `${label} is in the fold`);
      assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll with the fold open`);
      assert.equal(await page.locator('[data-coverage-consequence]').count(), 0, 'the fold repeats no estimate line');
      // 出题方式与题量: the two axes of the presets, and the rough cost of every combination (the form's own cell marked, its count said once by the summary)
      const matrix = page.locator('[data-preset-matrix]');
      await until(async () => (await matrix.getAttribute('data-status')) === 'ready', 'the matrix of rough costs', { timeoutMs: 60000 });
      assert.equal(await matrix.locator('td[data-cell]').count(), 9);
      assert.equal(await matrix.locator('td[data-current="true"]').getAttribute('data-cell'), 'standard:scenario');
      assert.match(await matrix.locator('td[data-cell="standard:scenario"]').innerText(), /^×1/);
      assert.ok(await matrix.evaluate(table => table.getBoundingClientRect().right <= document.querySelector('.generate-more').getBoundingClientRect().right + 1), `${width}px: the matrix fits the fold`);
      assert.ok(await matrix.evaluate(table => table.querySelector('caption').getBoundingClientRect().bottom <= table.querySelector('thead').getBoundingClientRect().top + 1), `${width}px: the caption stands above the table, not in its first cell`);
      const strength = page.locator('[data-coverage-strength] .sh-seg__item'), pressed = pressedOf(strength);
      assert.deepEqual(await strength.allInnerTexts(), ['精简', '标准', '完整', '自定义']);
      assert.deepEqual(await pressed(), ['标准']);
      // #664: back and forth between the four choices, one is on at every step, and the number field is there only for 自定义
      for (const choice of ['自定义', '完整', '自定义', '精简', '标准']) {
        await strength.filter({ hasText: choice }).first().click();
        await until(async () => (await pressed()).join() === choice, `${choice} is the one choice that is on`);
        assert.equal(await page.locator('#generate-count').count(), choice === '自定义' ? 1 : 0, `the number field is there for 自定义 only (${choice})`);
        if (choice === '自定义') {
          const typed = Number(await page.locator('#generate-count').inputValue());
          assert.ok(typed >= 1, 'and starts from a number');
          // A typed number is no preset: the main path says 自定义 with that number, and no rough cost is said (each is the estimate of a level, not of this run).
          await until(async () => (await page.locator('[data-presets]').getAttribute('data-preset')) === 'custom', 'a typed number reads 自定义');
          assert.match(await presetNote.innerText(), new RegExp(`^自定义：${typed} 题 × 情境题。`));
          assert.equal(await page.locator('[data-preset-cost]').count() + await matrix.count(), 0, 'no ratio and no matrix while a number is typed');
        }
      }
      // a combination that is no preset: the main path says 自定义 and both halves; the depth moves the marked cell
      const depth = page.locator('[data-depth] .sh-seg__item');
      await strength.filter({ hasText: '完整' }).first().click();
      await depth.filter({ hasText: '快问' }).first().click();
      await until(async () => (await page.locator('[data-presets]').getAttribute('data-preset')) === 'custom', 'the form is 自定义');
      assert.match(await presetNote.innerText(), /^自定义：完整 × 快问。/);
      assert.equal(await matrix.locator('td[data-current="true"]').getAttribute('data-cell'), 'full:quick');
      await presets.filter({ hasText: '情境题' }).first().click();
      await until(async () => (await pressed()).join() === '标准' && (await pressedOf(depth)()).join() === '情境题', 'a preset sets both halves');
      await shot(page, `fold-${width}`);
      await shotForm(page, `fold-form-${width}`);

      // 前往设置 lands on 出题偏好 (and the new default is there)
      await page.locator('[data-open-settings="settings-generation"]').click();
      await page.locator('[data-tour="settings-generation"]').waitFor({ state: 'visible', timeout: 30000 });
      assert.equal(await page.locator('select[name="coverageLevel"], [name="coverageLevel"]').count() > 0, true, 'the 覆盖强度 default is on that page');
      assert.equal(await page.locator('[name="depth"]').count() > 0, true, 'and the 出题深度 default (高级生成控制)');
      assert.equal(await page.locator('[name="strategy"]').count(), 0, 'one control for the depth, not a second one for the strategy');
      await shot(page, `settings-${width}`);

      // back on the page: the choices stand, the line is still true
      await goGenerate(page);
      assert.equal(await page.locator('.source-picker__item.is-selected').count(), 2, 'the ticks survived the detour');
      assert.deepEqual(errors, []);
      await context.close();
    }
    // 逐题精出 (staged) keeps what it plans: the same line says one number.
    const staged = await start(dist, { staged: true });
    try {
      const { page, context } = await openApp(browser, staged, { width: 1280 });
      await goGenerate(page);
      assert.deepEqual(await page.locator('[data-presets] .sh-seg__item[aria-pressed="true"]').allInnerTexts(), ['逐题精出'], 'a library saved on staged reads as the preset 逐题精出');
      await until(async () => (await page.locator('[data-generate-estimate] [data-token-estimate][data-status="ready"]').count()) > 0, 'the staged estimate', { timeoutMs: 60000 });
      const line = await page.locator('.generate-summary').innerText();
      assert.match(line, /出 \d+ 题/, `a staged run says one number: ${line}`);
      assert.doesNotMatch(line, /出 \d+–\d+ 题/, 'not a range');
      await context.close();
    } finally { await staged.close(); }
  } finally { await running.close(); await browser.close(); await rm(dist, { recursive: true, force: true }); }
});
