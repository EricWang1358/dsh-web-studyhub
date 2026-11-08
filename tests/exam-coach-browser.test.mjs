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

function makeSource(id, title, text, extra = {}) {
  return {
    id,
    title,
    text,
    course: '数据库系统',
    courses: ['数据库系统'],
    createdAt: STAMP,
    chars: text.length,
    excerpt: text.slice(0, 160),
    ...extra,
  };
}

async function seed(root) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  await service.store.update((state) => {
    state.sources.push(
      makeSource(
        'mat-db',
        '索引与恢复讲义.md',
        '# B+树索引边界\n联合索引最左前缀匹配推导公式与范围扫描边界条件。\n# 并发锁权衡\n两阶段封锁与意向锁冲突排查方案权衡。\n# 崩溃恢复日志\nARIES 预写日志重做与回滚幂等性条件。',
      ),
      makeSource(
        'ref-paper',
        '2025往年真题样卷.md',
        '一、单选题：B+树索引边界条件判断。\n二、计算推导题：并发锁权衡与死锁检测推导。',
      ),
    );
    state.decks.push({
      id: 'deck-surface',
      title: '基础概念题组',
      course: '数据库系统',
      createdAt: STAMP,
      cards: [
        {
          id: 'card-surface-1',
          kind: 'quiz',
          topic: 'B+树索引边界',
          objective: '识别术语定义',
          prompt: '在某公司的订单系统中，WAL 的全称是什么？',
          options: [
            { id: 'a', text: 'Write-Ahead Logging', correct: true, explanation: '预写日志标准全称。' },
            { id: 'b', text: 'Wide-Area Locking', correct: false, explanation: '干扰项。' },
            { id: 'c', text: 'Weighted Access List', correct: false, explanation: '干扰项。' },
          ],
          answer: 'Write-Ahead Logging',
          hint: '日志先行持久化。',
          misconception: '混淆锁与日志缩写',
          explanation: '基础缩写识别。',
          citations: [{ sourceId: 'mat-db', quote: 'ARIES 预写日志重做与回滚幂等性条件。' }],
          review: { reps: 5, interval: 14, stability: 14 },
        },
      ],
    });
    state.focus = { ...(state.focus || {}), course: '数据库系统', mode: 'class' };
  });
  service.dispose?.();
}

async function start(distDir) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-exam-coach-'));
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

test('#853 browser: Exam Coach 4-stage calibration, sample exposure guard, rule versioning, 3-layer evidence, strict mock check, and English UI', { timeout: 600000 }, async (t) => {
  let browser;
  try {
    browser = await launchChromium();
  } catch (error) {
    t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`);
    return;
  }

  const dist = await mkdtemp(join(tmpdir(), 'study-exam-coach-dist-'));
  await buildPreview({ outdir: dist });
  const running = await start(dist);
  try {
    const opened = await openPage(browser, running, { lang: 'zh', theme: 'dark', width: 1280, height: 900 });
    const { page, errors, context } = opened;
    await page.goto(running.server.url);
    await page.locator('aside, nav').first().waitFor({ timeout: 30000 });

    // Open 更多 › 考试与统计 › 教练
    await nav(page, 'examcoach');
    await page.locator('[data-page="examcoach"]').waitFor({ state: 'visible', timeout: 30000 });
    assert.ok(await overflow(page) <= 0, 'no sideways scroll on initial Exam Coach page');

    // Stage 1: Click 分析考察方式 -> automatically advances to Stage 2 (confirm)
    await page.getByRole('button', { name: '分析考察方式' }).click();
    await page.locator('[data-family-id]').first().waitFor({ state: 'visible', timeout: 15000 });

    // Switch back to Stage 1 briefly to verify uncovered material section honesty ("崩溃恢复日志")
    await page.getByRole('button', { name: '1. 分析考法' }).click();
    const stage1Text = await page.locator('[data-page="examcoach"]').innerText();
    assert.match(stage1Text, /样卷未覆盖的资料章节：.*崩溃恢复日志/, 'uncovered material chapter surfaced honestly');

    // Return to Stage 2: Confirm representative sample, exposure guard, 3 independent checkboxes, and rule-edit invalidation
    await page.getByRole('button', { name: '2. 确认代表题与错因' }).click();
    const firstFamily = page.locator('[data-family-id]').first();
    await firstFamily.waitFor({ state: 'visible', timeout: 10000 });

    // Sample answer is redacted before explicit reveal
    assert.equal(await firstFamily.getByText('参考答案：').count(), 0, 'sample answer hidden by default');
    await firstFamily.getByRole('button', { name: '展开答案与评分解析（记录解法暴露）' }).click();
    await until(async () => (await firstFamily.getByText('参考答案：').count()) > 0, 'sample answer revealed');

    // Verify backend recorded immutable `sample-calibration` solution exposure
    const calAfterReveal = await previewCall(running.server, 'coach.calibration.get', { course: '数据库系统' });
    assert.ok(
      (calAfterReveal?.solutionExposures || []).some((e) => e.source === 'sample-calibration'),
      'sample-calibration exposure receipt persisted in learner state',
    );

    // Check the 3 independent confirmation flags on family 0
    await firstFamily.locator('label.sh-check', { hasText: '外观满意' }).click();
    await firstFamily.locator('label.sh-check', { hasText: '考察意图满意' }).click();
    await firstFamily.locator('label.sh-check', { hasText: '答案已核实' }).click();
    await until(async () => /三项校准已就绪/.test(await firstFamily.innerText()), 'all 3 confirmations calibrate family 0');

    const versionBadgeBefore = await page.locator('.exam-coach-badge--info').first().innerText();

    // Edit reasoning steps -> specVersion advances and confirmations reset to `规则已变更，需重新确认`
    await firstFamily.getByRole('button', { name: '编辑推理步骤与评分规则' }).click();
    const reasoningBox = firstFamily.locator('textarea').first();
    await reasoningBox.fill('识别题干限定条件\n排除前提不符的干扰项\n补充核对极端边界值');
    await firstFamily.getByRole('button', { name: '保存规则修改' }).click();
    await until(async () => /规则已变更，需重新确认/.test(await firstFamily.innerText()), 'rule edit invalidates prior intent/answer confirmation');
    const versionBadgeAfter = await page.locator('.exam-coach-badge--info').first().innerText();
    assert.notEqual(versionBadgeAfter, versionBadgeBefore, 'specVersion bumped on substantive rule edit');

    // Stage 3: Configure non-uniform quota (set second family quota = 0) & crunch mode
    await page.getByRole('button', { name: '3. 调整训练配置' }).click();
    const quotaInputs = page.locator('[data-page="examcoach"] input[type="number"]');
    await until(async () => (await quotaInputs.count()) >= 4, 'quota and timing number inputs rendered');
    // Family 1's first number input is its quota (index 2: family0 quota=0, family0 time=1, family1 quota=2)
    await quotaInputs.nth(2).fill('0');
    await page.locator('label.sh-check', { hasText: '开启考前压缩模式' }).click();
    await page.getByRole('button', { name: '保存配置并查看生成与能力证据' }).click();

    // Stage 4: Evidence & compiled generation preview & strict mock-paper shortfall check
    const evidenceGrid = page.locator('[data-testid="coach-three-layer-evidence"]');
    await evidenceGrid.waitFor({ state: 'visible', timeout: 15000 });
    const evidenceText = await evidenceGrid.innerText();
    assert.match(evidenceText, /1\. 资料覆盖/);
    assert.match(evidenceText, /2\. 训练覆盖/);
    assert.match(evidenceText, /3\. 独立能力证据/);
    assert.match(evidenceText, /仅表面场景词包装/);

    await page.getByRole('button', { name: '预览生效要求与配额' }).click();
    const compiledBox = page.locator('[data-testid="coach-compiled-preview"]');
    await compiledBox.waitFor({ state: 'visible', timeout: 15000 });
    const compiledText = await compiledBox.innerText();
    assert.match(compiledText, /本轮配额为 0（不出题）：/, 'zero-quota family explicitly listed');

    await page.getByRole('button', { name: '核对同型组卷缺口' }).click();
    const mockBox = page.locator('[data-testid="coach-strict-mock-report"]');
    await mockBox.waitFor({ state: 'visible', timeout: 15000 });
    assert.match(await mockBox.innerText(), /存在 .* 处结构缺口（未凑数）/, 'strict mock composer reports shortfall honestly');

    assert.ok(await overflow(page) <= 0, 'no sideways scroll at 1280px');
    await page.setViewportSize({ width: 420, height: 800 });
    await settleAnimations(page);
    assert.ok(await overflow(page) <= 0, 'no sideways scroll at narrow 420px viewport');
    assert.deepEqual(errors, []);
    await context.close();

    // Verify English locale rendering
    const openedEn = await openPage(browser, running, { lang: 'en', theme: 'light', width: 1280, height: 900 });
    await openedEn.page.goto(running.server.url);
    await openedEn.page.locator('aside, nav').first().waitFor({ timeout: 30000 });
    await nav(openedEn.page, 'examcoach');
    await openedEn.page.locator('[data-page="examcoach"]').waitFor({ state: 'visible', timeout: 30000 });
    const enText = await openedEn.page.locator('[data-page="examcoach"]').innerText();
    assert.match(enText, /Exam coach/i);
    assert.match(enText, /1\. Material coverage/);
    assert.match(enText, /2\. Training coverage/);
    assert.match(enText, /3\. Independent capability evidence/);
    assert.deepEqual(openedEn.errors, []);
    await openedEn.context.close();
  } finally {
    await running.close();
    await browser.close();
    await rm(dist, { recursive: true, force: true });
  }
});
