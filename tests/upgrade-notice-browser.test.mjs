/* global window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';

/* <UpdateWatch> (ui/UpdateCenter.jsx) in a real page, wired as App wires it: the app's one notice slot (useNotice + ActionFeedback + createToastApi). It asks
   the host each time StudyHub opens, in a narrow panel too, where the sidebar and its update chip are not mounted; it says 「已升级到 X」 once, even when
   the page moves on while the answer arrives, and DSH opening StudyHub again in the same browser page (its hot reload) does not say it twice.
   Only the code of X says it: the page bundles its own version from package.json. The old code is the same source built as an older version, in pages of
   its own (the page that asked for the install, another StudyHub window): it hears of the upgrade too, and says nothing. */
const HARNESS = `
    import React, { useMemo, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import ActionFeedback, { useNotice, reviewNoticeScope } from './ui/ActionFeedback.jsx';
    import { ToastContext, createToastApi } from './ui/components/Feedback.jsx';
    import { StudyServicesContext } from './ui/study-context.jsx';
    import { UpdateDialog, UpdateWatch } from './ui/UpdateCenter.jsx';
    window.calls = [];
    window.answer = null;
    window.installed = null;
    const call = async (action, args) => {
      window.calls.push([action, args]);
      if (action === 'update.preferences') { window.answer = { ...window.answer, upgraded: null }; return window.answer; }
      if (action === 'update.install') {
        window.answer = window.installed;
        return { status: 'installed', version: args.version, restartRequired: false, application: 'applied' };
      }
      await new Promise((done) => { window.release = done; });
      return window.answer;
    };
    const services = { call };
    function Harness({ offer }) {
      const [pageName, setPage] = useState('library');
      const [notice, setNotice] = useNotice(reviewNoticeScope('/lib', pageName, null));
      const [error, setError] = useState('');
      const toast = useMemo(() => createToastApi({ setNotice, setError }), [setNotice]);
      window.goto = setPage;
      return <StudyServicesContext.Provider value={services}><ToastContext.Provider value={toast}><div className="study-app" data-page={pageName}>
        <UpdateWatch />
        {offer && <UpdateDialog update={offer} onClose={() => {}} />}
        <ActionFeedback notice={notice} error={error} placement="inline" onCloseNotice={() => setNotice('')} onCloseError={() => setError('')} />
      </div></ToastContext.Provider></StudyServicesContext.Provider>;
    }
    let root;
    window.open = (answer, offer) => { window.answer = answer; root = createRoot(document.getElementById('root')); root.render(<Harness offer={offer} />); };
    window.close = () => { root.unmount(); };
  `;
const NEW = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const OLD = '0.9.0';
const pattern = (text) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
/** The harness as the code of `version`: the real build when it is the package's own, else the same source with an older package.json. */
async function bundleOf(version) {
  const older = version === NEW ? [] : [{ name: 'older-build', setup(builder) {
    builder.onLoad({ filter: /[\\/]package\.json$/ }, () => ({ contents: JSON.stringify({ version }), loader: 'json' }));
  } }];
  const built = await build({ stdin: { contents: HARNESS, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife',
    loader: { '.css': 'text' }, plugins: older, logLevel: 'silent' });
  return built.outputFiles[0].text;
}

test('the upgrade notice in the page: asked on open, said once, kept across a page change and a reopen', { timeout: 90000 }, async (t) => {
  const [newCode, oldCode] = await Promise.all([bundleOf(NEW), bundleOf(OLD)]);
  assert.match(newCode, pattern(JSON.stringify(NEW)), 'the new build carries its own version');
  assert.doesNotMatch(oldCode, pattern(JSON.stringify(NEW)), 'the old build does not');
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium: ${String(error.message).split('\n')[0]}`); return; }
  t.after(() => browser.close());
  const errors = [];
  /** One StudyHub window running `code`, with its own fake host. */
  async function windowOf(code) {
    const page = await browser.newPage({ locale: 'zh-CN' });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setContent('<main id="root"></main>');
    await page.addScriptTag({ content: code });
    return {
      page,
      asked: () => page.evaluate(() => window.calls.map(([action]) => action)),
      reported: () => page.evaluate(() => window.calls.filter(([action]) => action === 'update.preferences').map(([, args]) => args)),
      notice: page.locator('[role="status"] .sh-toast'),
      open: async (value, offer) => {
        await page.evaluate(([next, upgrade]) => window.open(next, upgrade), [value, offer ?? null]);
        await page.waitForFunction(() => !!window.release);
      },
      release: () => page.evaluate(() => { const done = window.release; window.release = null; done(); }),
      close: () => page.evaluate(() => window.close()),
    };
  }
  const answer = (upgraded) => ({ current: upgraded || NEW, latest: upgraded || NEW, newer: false, autoCheck: true, pendingRestart: null, upgraded });
  const settle = (view) => view.page.waitForTimeout(300);

  // DSH sometimes answers the install a moment before it closes the page. The page that asked is the old code: its dialog asks again and hears of the upgrade,
  // but anything it showed would be the old code's, so it must leave the news (and the report to the host) to the new code.
  const asking = await windowOf(oldCode);
  await asking.open(answer(null), { current: OLD, latest: NEW, newer: true, autoCheck: true, snoozed: false, pendingRestart: null,
    url: 'https://example.invalid/release', assetUrl: 'https://example.invalid/package.tgz', notes: '', install: { available: true, desktop: false } });
  await asking.release(); await settle(asking);
  await asking.page.evaluate((installed) => { window.installed = installed; }, answer(NEW));
  await asking.page.getByRole('button', { name: `一键升级到 ${NEW}` }).click();
  await asking.page.getByRole('button', { name: '确认升级' }).click();
  await asking.page.waitForFunction(() => !!window.release);
  await asking.release(); await settle(asking);
  assert.deepEqual(await asking.asked(), ['update.check', 'update.install', 'update.check'], 'the dialog did hear of the upgrade while the old page was open');
  assert.equal(await asking.page.locator('.sh-toast').count(), 0, 'the old page says nothing');
  assert.deepEqual(await asking.reported(), [], 'and does not use the notice up');
  // What its dialog says meanwhile is the truth too: DSH answered 'applied', so the new version is running and nothing is waiting for a restart.
  const dialogText = await asking.page.getByRole('dialog').innerText();
  assert.match(dialogText, pattern(`StudyHub ${NEW} 已升级`));
  assert.match(dialogText, /不用重启 DSH/);
  assert.doesNotMatch(dialogText, /等待重启|请重启 DSH 服务|仍在运行旧版本/);
  // DSH closes the page and opens StudyHub again in this very module, still the old code (App's loading state remounts <UpdateWatch> the same way).
  await asking.close();
  await asking.open(answer(NEW));
  await asking.release(); await settle(asking);
  assert.equal(await asking.notice.count(), 0, 'an UpdateWatch mounted again in the old code says nothing either');
  assert.deepEqual(await asking.reported(), []);
  // Another StudyHub window, still on the old code, that never asked for the install.
  const other = await windowOf(oldCode);
  await other.open(answer(NEW));
  await other.release(); await settle(other);
  assert.deepEqual([await other.asked(), await other.notice.count(), await other.reported()], [['update.check'], 0, []], 'another old window says nothing');

  // The new code. An ordinary start: asked once, nothing said, nothing reported.
  const fresh = await windowOf(newCode);
  await fresh.open(answer(null));
  await fresh.release(); await settle(fresh);
  assert.deepEqual(await fresh.asked(), ['update.check']);
  assert.equal(await fresh.notice.count(), 0);
  await fresh.close();

  // The new code opens after the upgrade. The start page moves on to the board while the host is still answering.
  await fresh.page.evaluate(() => { window.calls.length = 0; });
  await fresh.open(answer(NEW));
  await fresh.release();
  await fresh.notice.waitFor();
  await fresh.page.evaluate(() => window.goto('board'));
  await settle(fresh);
  assert.equal(await fresh.notice.count(), 1, 'the notice is still there on the page the learner lands on');
  assert.match(await fresh.notice.innerText(), pattern(`已升级到 ${NEW}`));
  assert.deepEqual(await fresh.reported(), [{ upgradeTold: NEW }]);

  // DSH opens StudyHub again in the same browser page, and the host still answers with the same version (its record of the report was lost).
  await fresh.close();
  await fresh.open(answer(NEW));
  await fresh.release(); await settle(fresh);
  assert.equal((await fresh.asked()).filter((action) => action === 'update.check').length, 2, 'every opening asks again: the page may have outlived the old code');
  assert.equal(await fresh.notice.count(), 0, 'said once');
  assert.deepEqual(await fresh.reported(), [{ upgradeTold: NEW }]);
  assert.deepEqual(errors, []);
});
