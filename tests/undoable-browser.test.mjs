/* global document, window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';

/* ui/use-undoable.js in a real page, wired as App wires it: the app's one notice slot (useNotice + ActionFeedback + createToastApi). 删除 hides at once; the
   notice is a polite status with a 撤销 button reached by keyboard that never takes the focus; the host is asked only when the notice leaves (closed, timed
   out, replaced) or the page is hidden; a failure puts the item back and says why. */
test('删除 with 撤销 in the page: hide, keyboard 撤销, commit on close / timeout / pagehide, overlap, failure', { timeout: 90000 }, async (t) => {
  const bundle = await build({ stdin: { contents: `
    import React, { useMemo, useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import ActionFeedback, { useNotice } from './ui/ActionFeedback.jsx';
    import { ToastContext, createToastApi } from './ui/components/Feedback.jsx';
    import { useUndoable } from './ui/use-undoable.js';
    window.calls = [];
    function List() {
      const undoable = useUndoable();
      const items = ['A', 'B', 'C', 'D', 'E', 'F'].filter((item) => !undoable.hidden(item));
      return <ul>{items.map((item) => <li key={item}><button data-item={item} onClick={() => undoable.commitLater({ keys: [item], message: '已删除 ' + item,
        commit: async () => { window.calls.push(item); if (item === 'E') throw new Error('磁盘已满'); return true; } })}>删除 {item}</button></li>)}</ul>;
    }
    function Harness() {
      const [notice, setNotice] = useNotice('scope');
      const [error, setError] = useState('');
      const toast = useMemo(() => createToastApi({ setNotice, setError }), [setNotice]);
      return <ToastContext.Provider value={toast}><div className="study-app"><List />
        <ActionFeedback notice={notice} error={error} placement="inline" onCloseNotice={() => setNotice('')} onCloseError={() => setError('')} /></div></ToastContext.Provider>;
    }
    createRoot(document.getElementById('root')).render(<Harness />);
  `, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'text' }, logLevel: 'silent' });
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium: ${String(error.message).split('\n')[0]}`); return; }
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'zh-CN' });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const calls = () => page.evaluate(() => window.calls.slice());
  const shown = (item) => page.locator(`button[data-item="${item}"]`).count();
  const notice = page.locator('[role="status"] .sh-toast');

  // 删除 A: hidden at once, a polite notice with 撤销, nothing sent, the focus not taken by the notice
  await page.locator('button[data-item="A"]').focus();
  await page.keyboard.press('Enter');
  await notice.waitFor();
  assert.equal(await shown('A'), 0);
  assert.match(await notice.innerText(), /已删除 A/);
  assert.deepEqual(await calls(), []);
  assert.notEqual(await page.evaluate(() => document.activeElement?.textContent), '撤销', 'the notice does not take the focus');
  // 撤销 by keyboard
  await notice.getByRole('button', { name: '撤销' }).focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !!document.querySelector('button[data-item="A"]'));
  assert.match(await notice.innerText(), /已撤销/);
  assert.deepEqual(await calls(), [], '撤销 sends nothing');

  // 删除 A again and close the notice: sent once
  await page.locator('button[data-item="A"]').click();
  await notice.filter({ hasText: '已删除 A' }).waitFor();
  await notice.getByRole('button', { name: '关闭提示' }).click();
  await page.waitForFunction(() => window.calls.length === 1);
  assert.deepEqual(await calls(), ['A']);
  assert.equal(await shown('A'), 0, 'a deleted item stays out');

  // two overlapping deletes: B is sent the moment C's notice takes its place; C keeps its 撤销
  await page.locator('button[data-item="B"]').click();
  await notice.filter({ hasText: '已删除 B' }).waitFor();
  await page.locator('button[data-item="C"]').click();
  await notice.filter({ hasText: '已删除 C' }).waitFor();
  await page.waitForFunction(() => window.calls.includes('B'));
  await notice.getByRole('button', { name: '撤销' }).click();
  await page.waitForFunction(() => !!document.querySelector('button[data-item="C"]'));
  assert.deepEqual(await calls(), ['A', 'B']);

  // the page goes away (pagehide): what waits is sent, and the dead 撤销 leaves with it
  await page.locator('button[data-item="D"]').click();
  await notice.filter({ hasText: '已删除 D' }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.waitForFunction(() => window.calls.includes('D'));
  await page.waitForFunction(() => !document.querySelector('[role="status"] .sh-toast'));

  // a failure puts the item back and says why
  await page.locator('button[data-item="E"]').click();
  await notice.filter({ hasText: '已删除 E' }).waitFor();
  await notice.getByRole('button', { name: '关闭提示' }).click();
  await page.waitForFunction(() => !!document.querySelector('button[data-item="E"]'));
  assert.match(await page.locator('[role="alert"] .sh-toast').innerText(), /磁盘已满/);

  // the notice's own time (8 s) runs out: sent
  await page.locator('button[data-item="F"]').click();
  await notice.filter({ hasText: '已删除 F' }).waitFor();
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => window.calls.includes('F'), null, { timeout: 15000 });
  assert.deepEqual(await calls(), ['A', 'B', 'D', 'E', 'F']);
  assert.deepEqual(errors, []);
});
