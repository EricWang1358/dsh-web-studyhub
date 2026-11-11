/* global localStorage */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const uiMod = await loadUi(`
  export { default as Sources, removeDocuments, BatchRemoveDialog } from './ui/Sources.jsx';
  export { documentSearchText } from './ui/SourcePicker.jsx';
  export { filterItems } from './ui/components/index.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const { Sources, removeDocuments, BatchRemoveDialog, documentSearchText, filterItems, setUiLanguage } = uiMod;

test('removeDocuments submits deduplicated sourceIds in a single confirmed transaction and rolls back on failure', async () => {
  const items = [
    { key: 'doc-1', sourceIds: ['p1', 'p2'] },
    { key: 'doc-2', sourceIds: ['p2', 'p3'] },
  ];
  const calls = [];
  const ok = await removeDocuments(items, {
    act: async (action, args) => { calls.push({ action, args }); return { ok: true }; },
  });
  assert.deepEqual(calls, [{ action: 'source.remove', args: { sourceIds: ['p1', 'p2', 'p3'], confirm: true } }]);
  assert.deepEqual(ok, { removed: ['p1', 'p2', 'p3'], failed: [] });

  const failed = await removeDocuments(items, {
    act: async () => { throw new Error('Source is referenced'); },
  });
  assert.deepEqual(failed.removed, []);
  assert.equal(failed.failed.length, 3);
});

test('BatchRemoveDialog blocks deletion when any selected material is cited or unarchived, in both zh and en', () => {
  const citedBatch = [
    { key: 'a', title: 'Lecture A', archived: true, usedBy: [{ id: 'd1', title: 'OS Midterm' }], pages: [{ sourceId: 's1' }], sourceIds: ['s1'] },
    { key: 'b', title: 'Lecture B', archived: true, usedBy: [], pages: [{ sourceId: 's2' }], sourceIds: ['s2'] },
  ];
  setUiLanguage('zh');
  const zhHtml = renderToStaticMarkup(React.createElement(BatchRemoveDialog, { items: citedBatch, onClose() {}, onRemoved() {} }));
  assert.match(zhHtml, /永久删除这 2 份资料？/);
  assert.match(zhHtml, /其中 1 份资料有题组引用，不能永久删除/);
  assert.match(zhHtml, /Lecture A/);
  assert.match(zhHtml, /disabled=""[^>]*>确认永久删除/);

  setUiLanguage('en');
  try {
    const enHtml = renderToStaticMarkup(React.createElement(BatchRemoveDialog, { items: citedBatch, onClose() {}, onRemoved() {} }));
    assert.match(enHtml, /Permanently delete these 2 sources\?/);
    assert.match(enHtml, /1 selected source\(s\) are cited by decks/);
    assert.doesNotMatch(enHtml.replace(/Lecture [AB]|OS Midterm/g, ''), /[\u3400-\u9fff]/);
  } finally {
    setUiLanguage('zh');
  }
});

test('documentSearchText + filterItems match NFKC case-insensitively across title, renamedFrom, filename, course, and format', () => {
  const items = [
    { key: '1', title: '虚拟内存讲义', renamedFrom: 'LEC05_VM.pdf', filename: 'lec05_vm.pdf', courses: ['操作系统'], format: 'pdf', pages: [{}, {}], sourceIds: ['1a', '1b'] },
    { key: '2', title: '进程调度笔记', filename: 'sched.md', courses: ['操作系统'], format: 'md', pages: [{}], sourceIds: ['2a'] },
  ];
  assert.deepEqual(filterItems(items, 'ＬＥＣ０５ pdf', documentSearchText).map(i => i.key), ['1']);
  assert.deepEqual(filterItems(items, 'markdown 操作系统', documentSearchText).map(i => i.key), ['2']);
  assert.deepEqual(filterItems(items, '不存在的关键词', documentSearchText), []);

  const data = {
    root: 'lib',
    sources: [{ id: 's1', title: '虚拟内存讲义', text: '分页', createdAt: new Date().toISOString(), courses: ['操作系统'], usedBy: [] }],
    decks: [], drafts: [], jobs: [], focus: { course: '*', courses: [{ name: '操作系统' }] }, modelReady: true,
  };
  setUiLanguage('zh');
  assert.match(renderToStaticMarkup(React.createElement(Sources, { data, setModal() {} })), /筛选资料…/);
});

test('Sources filter bar, collapsed-day auto-open, and archived batch restore + permanent delete work end-to-end in browser', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'sources-filter-batch-'));
  const service = new StudyService(join(root, 'library'));
  await service.store.update(s => {
    s.sources.push(
      { id: 's-today', title: 'Today Kernel Notes', text: 'Kernel evidence', createdAt: new Date(Date.UTC(2026, 9, 25, 10, 0)).toISOString(), courses: ['OS'] },
      { id: 's-old', title: 'Older Virtual Memory', text: 'Paging evidence', createdAt: new Date(Date.UTC(2026, 8, 10, 10, 0)).toISOString(), courses: ['OS'] },
      { id: 's-arch-1', title: 'Archived Draft Alpha', text: 'Old Alpha', archived: true, createdAt: new Date(Date.UTC(2026, 7, 1, 10, 0)).toISOString(), courses: ['OS'] },
      { id: 's-arch-2', title: 'Archived Draft Beta', text: 'Old Beta', archived: true, createdAt: new Date(Date.UTC(2026, 7, 2, 10, 0)).toISOString(), courses: ['OS'] },
      { id: 's-arch-cited', title: 'Archived Cited C', text: 'Cited C evidence', archived: true, createdAt: new Date(Date.UTC(2026, 7, 3, 10, 0)).toISOString(), courses: ['OS'] },
    );
    s.decks.push({
      id: 'deck-os',
      title: 'OS Deck',
      course: 'OS',
      cards: [{
        id: 'c1', kind: 'flashcard', topic: 'T', objective: 'O', prompt: 'Q', answer: 'A',
        hint: '', explanation: '', misconception: '',
        citations: [{ sourceId: 's-arch-cited', quote: 'Cited C evidence' }],
      }],
    });
  });
  const distDir = join(root, 'dist');
  await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: service.store.root, home: join(root, 'home'), port: 0, model: null, distDir });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); await service.dispose(); await rm(root, { recursive: true, force: true }); });
  try { browser = await launchChromium(); }
  catch (error) { if (!/Executable doesn't exist/.test(error.message)) throw error; t.skip('Chromium unavailable'); return; }

  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.addInitScript(() => { localStorage.setItem('study-ui-language', 'en'); localStorage.setItem('study-autopilot', 'off'); });
  await page.goto(server.url);
  await page.locator('[data-tour="nav-sources"]').click();

  // Older day starts collapsed; typing a filter auto-expands matching older groups and hides non-matches.
  assert.equal(await page.locator('.source-doc', { hasText: 'Older Virtual Memory' }).count(), 0);
  const filter = page.getByRole('searchbox', { name: 'Filter materials…' });
  await filter.fill('virtual');
  await page.locator('.source-doc', { hasText: 'Older Virtual Memory' }).waitFor();
  assert.equal(await page.locator('.source-doc', { hasText: 'Today Kernel Notes' }).count(), 0);

  // Empty filter match shows clear empty state; Clear filters restores normal view.
  await filter.fill('nonexistent-xyz');
  await page.getByText('No materials match “nonexistent-xyz”').waitFor();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.locator('.source-doc', { hasText: 'Today Kernel Notes' }).waitFor();

  // Switch to Archived view (3 archived materials).
  await page.locator('[data-archive-toggle]').click();
  await page.locator('.source-organize > summary').click();

  // Select all 3 -> Permanent delete dialog is blocked because Archived Cited C is referenced by OS Deck.
  await page.getByRole('button', { name: 'Select this scope' }).click();
  const deleteSelected = page.locator('[data-delete-selected]');
  assert.match(await deleteSelected.innerText(), /Permanently delete selected \(3\)/);
  await deleteSelected.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /Archived Cited C/);
  assert.equal(await dialog.getByRole('button', { name: 'Confirm permanent deletion', exact: true }).isDisabled(), true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });

  // Uncheck Archived Cited C, filter to Alpha so Beta is hidden by filter -> Restore selected only restores visible Alpha!
  await page.getByRole('checkbox', { name: 'Select source: Archived Cited C' }).uncheck();
  await filter.fill('Alpha');
  const restoreSelected = page.locator('[data-restore-selected]');
  assert.match(await restoreSelected.innerText(), /Restore selected \(1\)/);
  await restoreSelected.click();
  await page.locator('.sh-toast', { hasText: 'Unarchived “Archived Draft Alpha”' }).waitFor();
  await page.getByRole('button', { name: 'Clear filters' }).click();

  let exported = await service.call('export');
  assert.equal(exported.sources.find(s => s.id === 's-arch-1')?.archived, false, 'Draft Alpha restored');
  assert.equal(exported.sources.find(s => s.id === 's-arch-2')?.archived, true, 'hidden Draft Beta untouched');

  // Re-archive Draft Alpha, then permanently delete Draft Alpha + Draft Beta together in one batch!
  await service.call('source.archive', { sourceIds: ['s-arch-1'], archived: true });
  await page.reload();
  await page.locator('[data-tour="nav-sources"]').click();
  await page.locator('[data-archive-toggle]').click();
  await page.getByRole('button', { name: 'Expand all' }).click();
  await page.locator('.source-organize > summary').click();
  await page.getByRole('checkbox', { name: 'Select source: Archived Draft Alpha' }).check();
  await page.getByRole('checkbox', { name: 'Select source: Archived Draft Beta' }).check();
  assert.match(await deleteSelected.innerText(), /Permanently delete selected \(2\)/);
  await deleteSelected.click();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Confirm permanent deletion', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.locator('.sh-toast', { hasText: 'Permanently deleted 2 sources' }).waitFor();

  exported = await service.call('export');
  assert.deepEqual(exported.sources.filter(s => s.archived).map(s => s.id), ['s-arch-cited']);
  assert.equal(exported.sources.some(s => s.id === 's-arch-1' || s.id === 's-arch-2'), false);
  assert.deepEqual(errors, []);
});
