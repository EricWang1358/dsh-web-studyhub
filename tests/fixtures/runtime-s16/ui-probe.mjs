import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { installLayoutObserver, drainLayoutStability, judgeLayoutStability } from '../../../scripts/qa/layout-stability.mjs';
import { measure } from '../../../scripts/qa/task-console.mjs';

export async function captureAudioConsole(page, out, report) {
  page.setDefaultTimeout(15_000);
  const evidence = report.steps.find(step => step.id === 'S1-6 installed-public-audio').evidence;
  await page.evaluate(installLayoutObserver);
  if (!await page.locator('[data-tour="nav-tasks"]').count()) {
    const create = page.getByRole('button', { name: /^新建会话$|^New session$/ });
    if (await create.count()) {
      await create.first().click();
      await page.getByText(/^选择工作区$|^Select workspace$/).first().click();
      await page.getByRole('button', { name: /^编辑路径$|^Edit path$/ }).click();
      const directory = page.locator('input').last();
      await directory.fill(dirname(evidence.root));
      await directory.press('Enter');
      await page.getByRole('button', { name: /^打开$|^Open$/ }).click();
      const composer = page.locator('[contenteditable="true"]').first();
      await composer.waitFor({ state: 'visible', timeout: 10_000 });
      await composer.click();
      await page.keyboard.type('Open the isolated audio test workspace.');
      await page.keyboard.press('Enter');
      await page.screenshot({ path: join(out, 'audio-session-created.png') });
    }
    const study = page.getByText('StudyHub', { exact: true }).first();
    if (await study.count()) await study.click();
  }
  await page.locator('.study-app').first().waitFor({ timeout: 30_000 });
  const tasks = page.locator('[data-tour="nav-tasks"]').first();
  await tasks.waitFor({ state: 'attached', timeout: 30_000 }); await tasks.dispatchEvent('click');
  const row = page.locator(`.tc-row[data-task-id="${evidence.job.jobId}"]`).first();
  await row.waitFor({ state: 'attached', timeout: 30_000 }); await row.click();
  await page.locator('.tc-detail').first().waitFor({ state: 'attached' });
  const views = [];
  for (const width of [1280, 420]) for (const scale of [1, 1.5]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(value => { globalThis.document.documentElement.style.zoom = String(value); }, scale);
    await page.evaluate(async () => { await globalThis.document.fonts.ready; await new Promise(resolve => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))); });
    await drainLayoutStability(page);
    await page.evaluate(() => new Promise(resolve => globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(resolve))));
    const layout = judgeLayoutStability(await drainLayoutStability(page));
    const dimensions = await measure(page), path = join(out, `audio-console-${width}-${scale === 1 ? 100 : 150}.png`);
    await page.screenshot({ path });
    assert.equal(layout.ok, true, JSON.stringify(layout));
    assert.ok(dimensions.console && dimensions.detail, 'native StudyHub console is missing');
    assert.ok(dimensions.scrollWidth <= width + 2, `horizontal overflow at ${width}/${scale}: ${dimensions.scrollWidth}`);
    views.push({ width, scale, scaleMethod: 'document CSS zoom', path, layout, dimensions });
  }
  return { views, source: 'actual installed StudyHub inside DSH rc.2, public snapshot and unchanged task console' };
}
