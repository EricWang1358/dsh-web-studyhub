/* global window */
/* #938: the ⋯ menu beside the one fix of a failed MinerU, in a real browser: it opens from its button (named by aria-label, explained in a Tooltip, never
   a title), lists the other ways, and 卸载后重装 is one confirmed step: uninstall, then install again at the same place and tier. An uninstall that fails
   says why inside the dialog and starts nothing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';

test('the ⋯ menu of a failed MinerU, and 卸载后重装 (uninstall, then install at the same place and tier; nothing starts after a failed uninstall)', { timeout: 60000 }, async t => {
  const bundle = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import MineruInstallCard from './ui/MineruInstallCard.jsx';
    const FOLDER = 'D:\\\\StudyHub\\\\MinerU';
    const stages = ['tools', 'python', 'package', 'models', 'enable', 'check'];
    const install = { status: 'complete', stage: 'done', stages, done: stages, step: 6, of: 6, folder: FOLDER, installedFolder: FOLDER, installed: true,
      tier: 'standard', installedTier: 'standard', source: { id: 'mainland' }, log: ['== check ==', 'mineru server status: ready (standard)'], error: null };
    const status = { state: 'server-stopped', origin: 'installed', folder: FOLDER, install, external: null,
      lastError: { code: 'service-failed', message: '本机服务没能启动：它一启动就退出了。', at: '2026-11-10T00:00:00Z' } };
    window.calls = [];
    let refuse = true;
    const call = async (action, args) => {
      window.calls.push({ action, args });
      if (action === 'mineru.local.status') return status;
      if (action === 'mineru.install.status') return install;
      if (action === 'mineru.install.plan') return { ok: true, problems: [], warnings: [], folder: FOLDER, defaultFolder: FOLDER, platform: 'win32', drives: [], disk: { freeMb: 100000, neededMb: 4000, drive: 'D:' }, estimate: { downloadMb: 2500, minutes: [10, 30] }, tier: 'standard', source: { id: 'mainland' }, pythons: [], commands: [] };
      if (action === 'mineru.install.uninstall') {
        if (refuse) { refuse = false; throw new Error('有一份 PDF 正在用本机 MinerU 解析，请等它完成或先停止它。'); }
        return { ...install, status: 'idle', installed: false, removedFolders: [FOLDER] };
      }
      if (action === 'mineru.install.start') return { ...install, status: 'running', stage: 'tools', done: [], installed: false };
      return {};
    };
    createRoot(document.getElementById('root')).render(<div className="study-app"><MineruInstallCard call={call} initialLocal={status} /></div>);`,
  resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'text', '.json': 'json' }, logLevel: 'silent' });
  let browser;
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(String(error.message))) throw error;
    t.skip('Chromium unavailable'); return;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  const more = page.getByRole('button', { name: '其他办法' });
  await more.waitFor();
  assert.equal(await more.getAttribute('title'), null, 'explained in a Tooltip, never a title');
  await more.click();
  const items = page.getByRole('menuitem');
  await items.first().waitFor();
  assert.deepEqual(await items.allTextContents(), ['换成 basic 档', '卸载后重装', '安装到其他位置…', '查看安装日志']);

  await page.getByRole('menuitem', { name: '卸载后重装' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.match(await dialog.textContent(), /再在同一个位置用 standard 档重新安装/);
  // The first uninstall is refused: the dialog says why and nothing is started.
  await dialog.getByRole('button', { name: '卸载后重装' }).click();
  await dialog.getByText('有一份 PDF 正在用本机 MinerU 解析').waitFor();
  const acted = () => page.evaluate(() => window.calls.filter(item => ['mineru.install.uninstall', 'mineru.install.start'].includes(item.action)));
  assert.deepEqual((await acted()).map(item => item.action), ['mineru.install.uninstall'], 'no start after a failed uninstall');
  // Again: the uninstall goes through, then the install starts at the same place and tier, and the dialog closes.
  await dialog.getByRole('button', { name: '卸载后重装' }).click();
  await page.waitForFunction(() => window.calls.some(item => item.action === 'mineru.install.start'));
  assert.deepEqual(await acted(), [
    { action: 'mineru.install.uninstall', args: { confirm: true } },
    { action: 'mineru.install.uninstall', args: { confirm: true } },
    { action: 'mineru.install.start', args: { confirm: true, location: 'D:\\StudyHub\\MinerU', tier: 'standard' } },
  ]);
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
});
