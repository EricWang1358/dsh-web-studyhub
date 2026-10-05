import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { pickerScenario, seedPickerLibrary, startLateServer } from '../scripts/qa/layout-late.mjs';
import { loadUi } from './helpers/ui-module.mjs';

/* #205: the picker of 创建题组 › 01 / 选择资料 with 132 materials. The index coverage arrives after the rows are drawn; no row may change height
   (the 5th row stays where it is), only the badges change, and the 120 drawn rows must not all be rebuilt for it. */

test('the picker\'s row memo only follows a row\'s own data', async () => {
  const { documentRowPropsEqual } = await loadUi(`export { documentRowPropsEqual } from './ui/SourcePicker.jsx';`);
  const item = { key: 'a', sourceIds: ['a1', 'a2'] }, other = { key: 'b', sourceIds: ['b1'] };
  const base = { item, selected: ['b1'], disabled: false, defaultOpen: false, indexInfo: { state: 'indexed', indexed: 2, stale: 0, total: 2 }, canIndex: true, apply: () => {}, slot: true };
  assert.equal(documentRowPropsEqual(base, { ...base }), true);
  assert.equal(documentRowPropsEqual(base, { ...base, selected: ['b1', 'c9'], indexInfo: { ...base.indexInfo } }), true, 'another row\'s selection or a new coverage object of equal content re-renders nothing');
  assert.equal(documentRowPropsEqual(base, { ...base, selected: ['b1', 'a1'] }), false, 'its own selection changes it');
  assert.equal(documentRowPropsEqual(base, { ...base, indexInfo: { state: 'partial', indexed: 1, stale: 0, total: 2 } }), false, 'its own coverage changes it');
  assert.equal(documentRowPropsEqual({ ...base, indexInfo: null }, { ...base, indexInfo: { state: 'indexed', indexed: 2, stale: 0, total: 2 } }), false, 'a badge arriving changes it');
  assert.equal(documentRowPropsEqual(base, { ...base, item: other }), false);
  assert.equal(documentRowPropsEqual(base, { ...base, disabled: true }), false);
  assert.equal(documentRowPropsEqual(base, { ...base, slot: false }), false);
});

test('index coverage arriving late changes no row height, and re-renders only badges (132 materials)', { timeout: 300000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-late-dist-'));
  await buildPreview({ outdir: dist });
  const running = await startLateServer({ distDir: dist, seed: (root) => seedPickerLibrary(root, { documents: 132 }) });
  try {
    for (const width of [1280, 420]) {
      const result = await pickerScenario({ browser, running, width });
      t.diagnostic(`picker ${width}px: ${result.documents} rows drawn, longest task ${result.longestTaskMs} ms, CLS ${result.cls}, row 5 y ${result.before[4].y} → ${result.after[4].y}`);
      assert.ok(result.documents >= 100, 'a long list');
      assert.ok(result.badges > 0, 'the badges arrived');
      assert.deepEqual(result.errors, []);
      assert.ok(Math.abs(result.after[4].y - result.before[4].y) <= 1, `${width}px: the 5th row moved from ${result.before[4].y} to ${result.after[4].y}`);
      for (let i = 0; i < result.before.length; i++) assert.ok(Math.abs(result.after[i].height - result.before[i].height) <= 0.5, `${width}px: row ${i + 1} changed height ${result.before[i].height} → ${result.after[i].height}`);
      assert.equal(result.rowResizes, 0, `${width}px: no row changes height when coverage arrives`);
      assert.ok(result.cls <= 0.05, `${width}px: CLS ${result.cls}`);
    }
  } finally { await browser.close(); await running.close(); await rm(dist, { recursive: true, force: true }); }
});
