/* global window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';

/* <UpdateWatch> (ui/UpdateCenter.jsx) in a real page, wired as App wires it: the app's one notice slot (useNotice + ActionFeedback + createToastApi). It asks
   the host each time StudyHub opens, in a narrow panel too, where the sidebar and its update chip are not mounted; it says 「已升级到 X」 once, even when
   the page moves on while the answer arrives, and DSH opening StudyHub again in the same browser page (its hot reload) does not say it twice. */
test('the upgrade notice in the page: asked on open, said once, kept across a page change and a reopen', { timeout: 90000 }, async (t) => {
  const bundle = await build({ stdin: { contents: `
    import React, { useMemo, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import ActionFeedback, { useNotice, reviewNoticeScope } from './ui/ActionFeedback.jsx';
    import { ToastContext, createToastApi } from './ui/components/Feedback.jsx';
    import { StudyServicesContext } from './ui/study-context.jsx';
    import { UpdateWatch } from './ui/UpdateCenter.jsx';
    window.calls = [];
    window.answer = null;
    const call = async (action, args) => {
      window.calls.push([action, args]);
      if (action === 'update.preferences') { window.answer = { ...window.answer, upgraded: null }; return window.answer; }
      await new Promise((done) => { window.release = done; });
      return window.answer;
    };
    const services = { call };
    function Harness() {
      const [pageName, setPage] = useState('library');
      const [notice, setNotice] = useNotice(reviewNoticeScope('/lib', pageName, null));
      const [error, setError] = useState('');
      const toast = useMemo(() => createToastApi({ setNotice, setError }), [setNotice]);
      window.goto = setPage;
      return <StudyServicesContext.Provider value={services}><ToastContext.Provider value={toast}><div className="study-app" data-page={pageName}>
        <UpdateWatch />
        <ActionFeedback notice={notice} error={error} placement="inline" onCloseNotice={() => setNotice('')} onCloseError={() => setError('')} />
      </div></ToastContext.Provider></StudyServicesContext.Provider>;
    }
    let root;
    window.open = (answer) => { window.answer = answer; root = createRoot(document.getElementById('root')); root.render(<Harness />); };
    window.close = () => { root.unmount(); };
  `, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'text' }, logLevel: 'silent' });
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium: ${String(error.message).split('\n')[0]}`); return; }
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'zh-CN' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const asked = () => page.evaluate(() => window.calls.map(([action]) => action));
  const reported = () => page.evaluate(() => window.calls.filter(([action]) => action === 'update.preferences').map(([, args]) => args));
  const notice = page.locator('[role="status"] .sh-toast');
  const answer = (upgraded) => ({ current: upgraded || '5.5.0', latest: upgraded || '5.5.0', newer: false, autoCheck: true, pendingRestart: null, upgraded });
  const open = async (value) => {
    await page.evaluate((next) => window.open(next), value);
    await page.waitForFunction(() => !!window.release);
  };
  const release = () => page.evaluate(() => { const done = window.release; window.release = null; done(); });
  const settle = () => page.waitForTimeout(300);

  // An ordinary start: asked once, nothing said, nothing reported.
  await open(answer(null));
  await release(); await settle();
  assert.deepEqual(await asked(), ['update.check']);
  assert.equal(await notice.count(), 0);
  await page.evaluate(() => window.close());

  // The new code opens after an upgrade. The start page moves on to the board while the host is still answering.
  await page.evaluate(() => { window.calls.length = 0; });
  await open(answer('6.0.0'));
  await release();
  await notice.waitFor();
  await page.evaluate(() => window.goto('board'));
  await settle();
  assert.equal(await notice.count(), 1, 'the notice is still there on the page the learner lands on');
  assert.match(await notice.innerText(), /已升级到 6\.0\.0/);
  assert.deepEqual(await reported(), [{ upgradeTold: '6.0.0' }]);

  // DSH opens StudyHub again in the same browser page, and the host still answers with the same version (its record of the report was lost).
  await page.evaluate(() => window.close());
  await open(answer('6.0.0'));
  await release(); await settle();
  assert.equal((await asked()).filter((action) => action === 'update.check').length, 2, 'every opening asks again: the page may have outlived the old code');
  assert.equal(await notice.count(), 0, 'said once');
  assert.deepEqual(await reported(), [{ upgradeTold: '6.0.0' }]);
  assert.deepEqual(errors, []);
});
