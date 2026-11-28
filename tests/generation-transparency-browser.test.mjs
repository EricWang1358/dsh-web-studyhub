/* global document, window -- page.evaluate callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { openPage, settleAnimations, until } from '../scripts/qa/layout-late.mjs';
import { StudyService } from '../lib/service.js';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';

const STAMP = '2026-10-01T08:00:00.000Z';
const SENTENCES = (n) => Array.from({ length: 12 }, (_, i) => `第 ${n} 节的第 ${i + 1} 个要点说明数据库索引、事务与范式之间的关系。`).join('');
const source = (id, title, text, extra = {}) => ({
  id,
  title,
  text,
  createdAt: STAMP,
  courses: ['数据库'],
  chars: text.length,
  excerpt: text.slice(0, 160),
  ...extra,
});

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update((state) => {
    state.sources.push(
      source('n1', '索引与查询.md', `## 第 1 节\n\n${SENTENCES(1)}`),
      source('n2', '事务与并发.md', `## 第 1 节\n\n${SENTENCES(2)}`),
    );
    state.focus = { ...(state.focus || {}), course: '数据库', mode: 'class' };
  });
  service.dispose?.();
}

async function start(distDir) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-gen-trans-'));
  const root = join(base, 'library');
  await seed(root);
  const server = await createPreviewServer({
    libraryRoot: root,
    home: join(base, 'home'),
    port: 0,
    model: createFakeModel({ latencyMs: 15, generationLatencyMs: 15 }),
    distDir,
  });
  return {
    server,
    base,
    close: async () => {
      await server.close();
      await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
    },
  };
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const nav = async (page, id) => { await (await revealNavRow(page, id)).dispatchEvent('click'); };

test('#852 browser: non-uniform quotas, modular rules, zero-call preview, and TaskConsole request trace with solution-exposure guard', { timeout: 600000 }, async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`);
    return;
  }
  const dist = await mkdtemp(join(tmpdir(), 'study-gen-trans-dist-'));
  await buildPreview({ outdir: dist });
  const running = await start(dist);
  try {
    const opened = await openPage(browser, running, { lang: 'zh', theme: 'dark', width: 1280, height: 900 });
    const { page, errors, context } = opened;
    await page.goto(running.server.url);
    await page.locator('aside, nav').first().waitFor({ timeout: 30000 });

    await nav(page, 'generate');
    await page.locator('.generate-page form').waitFor({ timeout: 30000 });
    await until(async () => (await page.locator('.source-picker__item.is-selected').count()) === 2, 'notes selected');

    // Tick open and flashcard in addition to default quiz
    await page.locator('input[name="kinds-open"]').check();
    await page.locator('input[name="kinds-flashcard"]').check();

    // Open 更多选项 and enable custom non-uniform quotas (including explicit 0)
    await page.locator('.generate-more > summary').click();
    // 额外要求 is shut inside 高级 until it is asked for (#1082)
    assert.equal(await page.locator('.generate-extra').evaluate((element) => element.open), false, '额外要求 is shut by default');
    await page.locator('.generate-extra > summary').click();
    await page.locator('[data-toggle-custom-quota]').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('[data-toggle-custom-quota]').click();

    await page.locator('[data-quota-kind="quiz"]').fill('2');
    await page.locator('[data-quota-kind="open"]').fill('1');
    await page.locator('[data-quota-kind="flashcard"]').fill('0');

    // Fill modular reasoning rule
    await page.locator('[data-module-input="reasoning"]').fill('必须包含边界条件反例判断，避免纯定义背诵');

    // The preview says, in a student's words, what this run will ask for (a local summary: it calls nothing)
    const before = (await previewCall(running.server, 'snapshot'))?.jobs?.length ?? 0;
    await page.locator('[data-preview-effective]').click();
    await page.locator('[data-effective-preview-panel]').waitFor({ state: 'visible', timeout: 10000 });
    const previewText = await page.locator('[data-effective-preview-panel]').innerText();
    assert.match(previewText, /题型与题数\s*单选测验 2 · 闪卡 0 · 开放问答 1（共 3 题）/, `counts per type, in words: ${previewText}`);
    assert.match(previewText, /难度\s*混合/);
    assert.match(previewText, /公式写法\s*自动/, 'the formula style is a word, not the stored value');
    assert.match(previewText, /推理要求：必须包含边界条件反例判断，避免纯定义背诵/, 'the extra requirement just typed, with its label');
    assert.doesNotMatch(previewText, /阶段|蓝图|缓存|协议|模块化|模型调用|规格版本|JSON|mixed|text/, `no engineering text in the preview: ${previewText}`);
    assert.equal(await page.locator('[data-effective-preview-panel]').evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, 'the preview fits its column');
    assert.equal(((await previewCall(running.server, 'snapshot'))?.jobs?.length ?? 0), before, 'a preview starts no run');
    // the rows of 额外要求 are the rows of the form: label | control, one gap
    const layout = await page.locator('.gen-trans-modules > .generate-row').evaluateAll((rows) => rows.map((row) => { const label = row.querySelector('.generate-row__label').getBoundingClientRect(), control = row.querySelector('.generate-row__control').getBoundingClientRect(), box = row.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, twoColumns: label.right <= control.left + 1 }; }));
    assert.ok(layout.length >= 4, 'quota, three requirements, name, preview');
    assert.ok(layout.every((row) => row.twoColumns), 'every row has its label beside its control');
    const gaps = layout.slice(1, -1).map((row, at) => Math.round(row.top - layout[at].bottom)); // (a notice between the name and the preview takes its own room)
    assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1, `one gap between the rows: ${gaps}`);
    assert.equal(await page.locator('[data-locked-protocol]').count(), 0, 'no developer-facing safety row: the note under the form says the questions are checked against the source');
    assert.doesNotMatch(await page.locator('.generate-extra').innerText(), /业务规则模板名称|启用此模块|系统基础安全约束|零模型调用|阶段规则/, 'no engineering words in the fold');

    const stripText = await page.locator('[data-effective-summary]').innerText();
    assert.match(stripText, /各题型题数：/, `effective strip shows non-uniform quota: ${stripText}`);
    assert.match(stripText, /2/, `effective strip includes quiz=2: ${stripText}`);
    assert.match(stripText, /0/, `effective strip includes flashcard=0: ${stripText}`);
    assert.match(stripText, /已加额外要求/);
    assert.ok(await overflow(page) <= 0, 'no sideways scroll on Generate with preview open');

    // Submit generation and wait for job completion
    await until(async () => !(await page.locator('[data-usage="generate.submit"]').isDisabled()), 'submit button enabled');
    await page.locator('[data-usage="generate.submit"]').click();
    const finishedJob = await until(async () => {
      const snap = await previewCall(running.server, 'snapshot');
      const job = (snap?.jobs || [])[0];
      if (!job || ['queued', 'running', 'cancelling'].includes(job.status)) return null;
      return job;
    }, 'generation job finished', { timeoutMs: 120000 });
    assert.equal(finishedJob.status, 'complete', `expected job complete, got ${finishedJob.status}: ${finishedJob.error || finishedJob.stage}`);
    await settleAnimations(page);

    // Open TaskConsole -> select job -> click 发送内容 tab
    await nav(page, 'tasks');
    await page.locator(`.tc-row[data-task-id="${finishedJob.id}"]`).click();

    await page.getByRole('tab', { name: '发送内容' }).click();
    const trace = await previewCall(running.server, 'job.trace', { jobId: finishedJob.id, revealSolutions: false });
    const plan = trace.calls.find(call => call.purpose === 'plan' && !call.mechanical);
    const blueprint = trace.calls.find(call => call.purpose === 'blueprint');
    assert.ok(plan?.prompt && blueprint?.redacted, 'the job recorded a readable plan and a protected blueprint');
    const planButton = page.locator(`[data-trace-call="${plan.callId}"]`);
    await planButton.click();
    await page.locator('[data-trace-prompt]').waitFor({ state: 'visible' });
    assert.equal(await planButton.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-trace-prompt]').textContent(), plan.prompt, 'selecting the plan shows its actual prompt');
    const solutionCallBtn = page.locator(`[data-trace-call="${blueprint.callId}"]`);
    assert.match(await solutionCallBtn.innerText(), /含解法/);
    await solutionCallBtn.click();
    await page.locator('[data-solution-guard]').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.locator('[data-trace-prompt]').count(), 0, 'solution-bearing prompt is collapsed by default');

    // Reveal solution-bearing stage -> records irreversible exposure and shows full prompt with modular rule
    await page.locator('[data-reveal-solution-trace]').click();
    await page.locator('[data-trace-prompt]').waitFor({ state: 'visible', timeout: 10000 });
    const revealedPrompt = await page.locator('[data-trace-prompt]').innerText();
    assert.match(revealedPrompt, /必须包含边界条件反例判断，避免纯定义背诵/, 'actual prompt reflects custom reasoning module');
    assert.match(await page.locator('[data-request-trace]').innerText(), /已记录解法暴露/, 'exposure receipt notice displayed');

    // Delete in-memory trace -> clears prompt text while preserving exposure record
    await page.locator('[data-delete-trace]').click();
    await until(async () => /已手动清理/.test(await page.locator('[data-request-trace]').innerText()), 'trace cleared notice shown');
    assert.equal(await page.locator('[data-trace-prompt]').count(), 0, 'prompt text removed after delete');

    assert.ok(await overflow(page) <= 0, 'no sideways scroll on TaskConsole trace tab');
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await running.close();
    await browser.close();
    await rm(dist, { recursive: true, force: true });
  }
});
