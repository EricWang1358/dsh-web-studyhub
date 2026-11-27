/* global document, window, localStorage */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { LATEST_VERSION, normalizeState } from '../lib/store.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import {
  FOLDERS_FIELD,
  MAX_FOLDERS,
  UNASSIGNED_COURSE,
  UNFILED_FOLDER,
  groupMaterialsByCourse,
  groupMaterialsByFolder,
  groupMaterialsFlat,
  normalizeFolderName,
  readMaterialFolders,
} from '../lib/contexts/materials/material-folders.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { withStudy } from './helpers/study-services.mjs';
import { nativeSelects } from './helpers/native-selects.mjs';

const compiled = await build({
  stdin: {
    contents: `
      export { default as Sources, RowMenuItems, MoveFolderDialog } from './ui/Sources.jsx';
      export { StudyServicesContext } from './ui/study-context.jsx';
      export { setUiLanguage } from './ui/i18n.js';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  platform: 'node',
  format: 'cjs',
  external: ['react'],
  plugins: [nativeSelects],
  loader: { '.css': 'text' },
  logLevel: 'silent',
});
const uiMod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), uiMod, uiMod.exports);
const { Sources, RowMenuItems, MoveFolderDialog, StudyServicesContext, setUiLanguage } = uiMod.exports;

const noop = () => {};
const han = /[\u3400-\u9fff]/;

/* ---------- 1. Pure grouping & defensive storage helpers ---------- */

test('readMaterialFolders sanitizes malformed settings and caps folder count', () => {
  assert.deepEqual(readMaterialFolders(undefined), { folders: [], items: {} });
  assert.deepEqual(readMaterialFolders({ materialFolders: 'bad' }), { folders: [], items: {} });
  assert.deepEqual(readMaterialFolders({ materialFolders: ['bad'] }), { folders: [], items: {} });

  const normalized = readMaterialFolders({
    materialFolders: {
      folders: ['  Week   1 ', '', 'Week 1', 42, 'x'.repeat(100)],
      items: { 'source:a': '  Week 1  ', 'source:b': 'Inferred Folder', '': 'Week 1', 'source:c': '' },
    },
  });
  assert.deepEqual(normalized, {
    folders: ['Week 1', 'Inferred Folder'],
    items: { 'source:a': 'Week 1', 'source:b': 'Inferred Folder' },
  });

  const many = Array.from({ length: MAX_FOLDERS + 20 }, (_, i) => `Folder ${i}`);
  assert.equal(readMaterialFolders({ materialFolders: { folders: many, items: {} } }).folders.length, MAX_FOLDERS);
  assert.equal(normalizeFolderName('  Midterm   Notes  '), 'Midterm Notes');
});

test('groupMaterialsByCourse places multi-course documents ONCE under primary course and unassigned last', () => {
  const items = [
    { key: 'doc-multi', title: 'Distributed Locking', courses: ['Systems', 'Databases'], createdAt: '2026-10-02T00:00:00.000Z', chars: 120 },
    { key: 'doc-db', title: 'B-Tree', courses: ['Databases'], createdAt: '2026-10-03T00:00:00.000Z', chars: 80 },
    { key: 'doc-loose', title: 'Misc Note', courses: [], createdAt: '2026-10-04T00:00:00.000Z', chars: 40 },
  ];
  const groups = groupMaterialsByCourse(items, { locale: 'en-US' });
  assert.deepEqual(groups.map(g => g.key), ['Databases', 'Systems', UNASSIGNED_COURSE]);
  assert.deepEqual(groups[0].rows.map(r => r.key), ['doc-db']);
  assert.deepEqual(groups[1].rows.map(r => r.key), ['doc-multi'], 'appears once under primary course Systems');
  assert.deepEqual(groups[2].rows.map(r => r.key), ['doc-loose'], 'unassigned goes last');

  const flat = groupMaterialsFlat(items, { sort: 'title', locale: 'en-US' });
  assert.equal(flat.length, 1);
  assert.deepEqual(flat[0].rows.map(r => r.key), ['doc-db', 'doc-multi', 'doc-loose']);
});

test('groupMaterialsByFolder keeps empty folders only when includeEmpty is true and unfiled last', () => {
  const items = [
    { key: 'a', title: 'Alpha', createdAt: '2026-10-01T00:00:00.000Z', chars: 10 },
    { key: 'b', title: 'Beta', createdAt: '2026-10-02T00:00:00.000Z', chars: 20 },
  ];
  const folders = { folders: ['Slides', 'Empty Folder'], items: { a: 'Slides' } };

  const withEmpty = groupMaterialsByFolder(items, folders, { includeEmpty: true });
  assert.deepEqual(withEmpty.map(g => [g.key, g.rows.map(r => r.key)]), [
    ['Slides', ['a']],
    ['Empty Folder', []],
    [UNFILED_FOLDER, ['b']],
  ]);

  const withoutEmpty = groupMaterialsByFolder(items, folders, { includeEmpty: false });
  assert.deepEqual(withoutEmpty.map(g => [g.key, g.rows.map(r => r.key)]), [
    ['Slides', ['a']],
    [UNFILED_FOLDER, ['b']],
  ]);
});

/* ---------- 2. Backend folder actions & zero schema migration ---------- */

test('source.folder.* lifecycle, snapshot exposure, key stability across rename/reimport/archive, and zero schema bump', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-folders-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const service = new StudyService(root, {});
  t.after(() => service.dispose());

  const sha = 'b'.repeat(64);
  await service.call('source.add', { id: 's1', title: 'Note 1', text: 'text 1', courses: ['OS'] });
  await service.call('source.add', { id: 's2', title: 'Note 2', text: 'text 2', courses: ['DB'] });
  await service.store.update(s => {
    s.sources.push({
      id: `pdf-${sha}-p1`,
      title: 'OS Slides · p.1',
      text: 'page 1',
      createdAt: '2026-10-02T08:00:00.000Z',
      courses: ['OS'],
      document: { id: sha, filename: 'os.pdf', bookTitle: 'OS Slides', page: 1, totalPages: 2, extractionVersion: 2, materialId: `document-${sha}-pdf`, format: 'pdf' },
    });
  });

  assert.deepEqual(writesFor('materials', 'source.folder.create'), ['settings']);
  assert.deepEqual(writesFor('materials', 'source.folder.set'), ['settings']);
  assert.deepEqual(writesFor('materials', 'source.folder.rename'), ['settings']);
  assert.deepEqual(writesFor('materials', 'source.folder.delete'), ['settings']);

  const beforeDisk = JSON.parse(await readFile(join(root, 'study-workspace.json'), 'utf8'));
  assert.equal(beforeDisk.version, LATEST_VERSION);

  await service.call('source.folder.create', { name: '  Lecture   Slides  ' });
  await assert.rejects(service.call('source.folder.create', { name: 'Lecture Slides' }), /already exists/i);

  const itemsBefore = groupSourcesByDocument((await service.call('snapshot')).sources);
  const pdfItem = itemsBefore.find(i => i.format === 'pdf');
  assert.equal(pdfItem.key, `pdf:${sha}`);

  // Batch assign PDF + s1 to folder
  await service.call('source.folder.set', { keys: [pdfItem.key, 'source:s1'], folder: 'Lecture Slides' });
  let snap = await service.call('snapshot');
  assert.deepEqual(snap.materialFolders, {
    folders: ['Lecture Slides'],
    items: { [pdfItem.key]: 'Lecture Slides', 'source:s1': 'Lecture Slides' },
  });

  // Rename note, add page 2 to PDF, archive & restore: folder membership stays intact!
  await service.call('materials.document.rename', { sourceId: 's1', title: 'Renamed Note 1' });
  await service.store.update(s => {
    s.sources.push({
      id: `pdf-${sha}-p2`,
      title: 'Renamed OS Slides · p.2',
      text: 'page 2',
      createdAt: '2026-10-02T09:00:00.000Z',
      courses: ['OS'],
      document: { id: sha, filename: 'os.pdf', bookTitle: 'Renamed OS Slides', page: 2, totalPages: 2, extractionVersion: 2, materialId: `document-${sha}-pdf`, format: 'pdf' },
    });
  });
  await service.call('source.archive', { sourceIds: ['s1'], archived: true });
  await service.call('source.archive', { sourceIds: ['s1'], archived: false });

  // Rename folder
  await service.call('source.folder.rename', { from: 'Lecture Slides', to: 'Week 1' });
  snap = await service.call('snapshot');
  assert.deepEqual(snap.materialFolders, {
    folders: ['Week 1'],
    items: { [`pdf:${sha}`]: 'Week 1', 'source:s1': 'Week 1' },
  });

  // Deleting non-empty folder without unfile:true fails; unfile:true moves materials out without deleting them
  await assert.rejects(service.call('source.folder.delete', { folder: 'Week 1' }), /not empty/i);
  await service.call('source.folder.set', { key: 'source:s1', folder: null });
  await service.call('source.folder.delete', { folder: 'Week 1', unfile: true });
  snap = await service.call('snapshot');
  assert.deepEqual(snap.materialFolders, { folders: [], items: {} });
  assert.ok(snap.sources.some(s => s.id === 's1') && snap.sources.some(s => s.id === `pdf-${sha}-p2`));

  // Permanently deleting a filed material leaves a dangling key that does not block deleting an empty folder
  await service.call('source.folder.set', { key: 'source:s2', folder: 'Temp' });
  await service.call('source.archive', { sourceIds: ['s2'], archived: true });
  await service.call('source.remove', { sourceIds: ['s2'], confirm: true });
  await service.call('source.folder.delete', { folder: 'Temp' });
  snap = await service.call('snapshot');
  assert.deepEqual(snap.materialFolders, { folders: [], items: {} });

  // Zero schema migration on disk
  const afterDisk = JSON.parse(await readFile(join(root, 'study-workspace.json'), 'utf8'));
  assert.equal(afterDisk.version, LATEST_VERSION);
  assert.ok(FOLDERS_FIELD in afterDisk.settings);
  const migrated = normalizeState(structuredClone(afterDisk));
  assert.deepEqual(migrated.settings.materialFolders, { folders: [], items: {} });
});

/* ---------- 3. Frontend SSR: course grouping, multi-course badges, English zero-Han ---------- */

test('Sources defaults to course grouping, shows multi-course badges once, hides expand/collapse when <= 1 group, and has zero Han in English', () => {
  const data = {
    root: 'lib-ssr',
    decks: [],
    drafts: [],
    jobs: [],
    modelReady: true,
    focus: { course: '*', courses: [{ name: 'OS' }, { name: 'DB' }] },
    settings: { materialFolders: { folders: ['Slides'], items: { 'source:m1': 'Slides' } } },
    sources: [
      { id: 'm1', title: 'Concurrency & Transactions', text: 'locks and 2PL', createdAt: '2026-10-01T09:00:00.000Z', courses: ['OS', 'DB'], usedBy: [] },
      { id: 'm2', title: 'Index Structures', text: 'B+ trees', createdAt: '2026-10-02T09:00:00.000Z', courses: ['DB'], usedBy: [] },
    ],
  };

  const zh = renderToStaticMarkup(withStudy(StudyServicesContext, React.createElement(Sources, { data, setModal: noop, onGenerate: noop }), { act: noop, call: noop }));
  assert.match(zh, /共 2 份资料，按课程分为 2 组/);
  assert.match(zh, /全部收起/, 'two groups offer 全部收起');
  assert.equal((zh.match(/data-document-key="source:m1"/g) || []).length, 1, 'multi-course material renders only once');
  assert.match(zh, /source-course-extra"[^>]*>DB</, 'extra course DB renders as badge');

  // Single group hides 全部展开 / 全部收起
  const oneCourseData = { ...data, focus: { course: 'DB', courses: [{ name: 'OS' }, { name: 'DB' }] } };
  const oneZh = renderToStaticMarkup(withStudy(StudyServicesContext, React.createElement(Sources, { data: oneCourseData, setModal: noop, onGenerate: noop }), { act: noop, call: noop }));
  assert.doesNotMatch(oneZh, /全部收起|全部展开/, 'hides 全部展开 / 全部收起 when groups <= 1');

  // English UI zero Han across Sources, RowMenuItems, and MoveFolderDialog
  try {
    setUiLanguage('en');
    const en = renderToStaticMarkup(withStudy(StudyServicesContext, React.createElement(Sources, { data, setModal: noop, onGenerate: noop }), { act: noop, call: noop }));
    assert.match(en, /By course/);
    assert.match(en, /By folder/);
    assert.match(en, /By import date/);
    assert.match(en, /Flat/);
    assert.match(en, /2 sources, grouped by course \(2 groups\)/);
    assert.doesNotMatch(en.replace(/<[^>]+>/g, ' '), han, 'English Sources page has zero Han characters');

    const menuEn = renderToStaticMarkup(withStudy(StudyServicesContext, React.createElement(RowMenuItems, {
      item: { key: 'source:m1', sourceIds: ['m1'], title: 'Concurrency & Transactions', courses: ['OS', 'DB'], usedBy: [], pages: [] },
      onChangeCourse: noop,
      onMoveFolder: noop,
    }), { busy: false, call: undefined }));
    assert.match(menuEn, /Move to folder…/);
    assert.doesNotMatch(menuEn, han);

    const dialogEn = renderToStaticMarkup(withStudy(StudyServicesContext, React.createElement(MoveFolderDialog, {
      item: { key: 'source:m1', sourceIds: ['m1'], title: 'Concurrency & Transactions', courses: ['OS'], usedBy: [], pages: [] },
      folders: ['Slides'],
      currentFolder: 'Slides',
      onClose: noop,
    }), { act: noop, busy: false }));
    assert.doesNotMatch(dialogEn.replace(/<[^>]+>/g, ' '), han);
  } finally {
    setUiLanguage('zh');
  }
});

/* ---------- 4. Playwright end-to-end: persistence, folders, B6, 0ms click, menu dismiss, 390px/420px/1280px ---------- */

test('Browser E2E: course/folder grouping, persisted fold state, B6 visible-only batch, 0ms title click, outside/Esc menu dismiss, and zero overflow', { timeout: 180000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-sources-e2e-'));
  const service = new StudyService(join(root, 'library'));
  await service.call('source.add', { id: 'os1', title: 'Kernel Scheduling', text: 'CPU scheduling algorithms', courses: ['OS'] });
  await service.call('source.add', { id: 'os2', title: 'Virtual Memory', text: 'Page tables and TLB', courses: ['OS', 'Systems'] });
  await service.call('source.add', { id: 'db1', title: 'Relational Algebra', text: 'Joins and projections', courses: ['DB'] });
  await service.call('course.save', { name: 'OS' });
  await service.call('course.save', { name: 'DB' });
  await service.call('focus.set', { course: null });

  const distDir = join(root, 'dist');
  await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: service.store.root, home: join(root, 'home'), port: 0, model: null, distDir });
  let browser;
  t.after(async () => {
    await browser?.close();
    await server.close();
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/Executable doesn't exist/.test(error.message)) throw error;
    t.skip('Chromium unavailable');
    return;
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.route('**/*', route => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));
  await page.addInitScript(() => {
    localStorage.setItem('study-ui-language', 'zh');
    localStorage.setItem('study-autopilot', 'off');
  });

  await page.goto(server.url);
  await page.locator('[data-tour="nav-sources"]').first().click();
  await page.locator('.source-doc').first().waitFor();
  await page.locator('.page-scope__select').click();
  await page.locator('[role="option"]', { hasText: '全部课程' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.source-group-head[aria-expanded="true"]').length === 2);

  // Default course grouping: DB and OS groups both expanded; no horizontal overflow at 1280px
  assert.equal(await page.locator('.source-group-head[aria-expanded="true"]').count(), 2);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no 1280px horizontal overflow');

  // 0ms title click opens reader immediately without 260ms delay
  const t0 = Date.now();
  await page.locator('[data-document-key="source:os1"] .source-title').click();
  await page.locator('dialog[open]').waitFor({ timeout: 2000 });
  assert.ok(Date.now() - t0 < 1500, 'reader opens without artificial delay');
  await page.keyboard.press('Escape');
  await page.locator('dialog[open]').waitFor({ state: 'detached' });

  // Row 更多 menu dismisses on outside pointerdown AND Escape while keeping <details class="source-row-actions">
  const details = page.locator('[data-document-key="source:os1"] details.source-row-actions');
  await details.locator('summary').click();
  assert.equal(await details.getAttribute('open'), '');
  await page.locator('.sources-page__header h1').click();
  assert.equal(await details.getAttribute('open'), null, 'outside click closes row 更多 menu');

  await details.locator('summary').click();
  assert.equal(await details.getAttribute('open'), '');
  await page.keyboard.press('Escape');
  assert.equal(await details.getAttribute('open'), null, 'Escape closes row 更多 menu');

  // Collapse DB group, switch to folder mode, create empty folder, move os1 into it, collapse it, reload and verify persistence!
  await page.locator('.source-group-head', { hasText: 'DB' }).click();
  assert.equal(await page.locator('.source-group-head', { hasText: 'DB' }).getAttribute('aria-expanded'), 'false');

  await page.locator('.sources-view-bar .sh-seg__item', { hasText: '按文件夹' }).click();
  await page.locator('.sources-view-bar button', { hasText: '新建文件夹' }).click();
  await page.locator('dialog[open] input').fill('Week 1');
  await page.locator('dialog[open] button', { hasText: '创建文件夹' }).click();
  await page.locator('.source-group-head', { hasText: 'Week 1' }).waitFor();

  // Move os1 via row menu -> 移入文件夹…
  await page.locator('[data-document-key="source:os1"] details.source-row-actions summary').click();
  await page.locator('[data-document-key="source:os1"] .source-row-menu__btn', { hasText: '移入文件夹…' }).click();
  await page.locator('dialog[open] button', { hasText: 'Week 1' }).click();
  await page.locator('dialog[open] button.sh-btn--primary', { hasText: '移入文件夹' }).click();
  await page.locator('dialog[open]').waitFor({ state: 'detached' });
  await page.locator('[data-folder-key="Week 1"] [data-document-key="source:os1"]').waitFor();
  assert.equal(await page.locator('[data-folder-key="Week 1"] [data-document-key="source:os1"]').count(), 1);

  // Collapse Week 1 and reload: folder mode + collapsed Week 1 both persist
  await page.locator('.source-group-head', { hasText: 'Week 1' }).click();
  assert.equal(await page.locator('.source-group-head', { hasText: 'Week 1' }).getAttribute('aria-expanded'), 'false');

  await page.reload();
  await page.locator('[data-tour="nav-sources"]').first().click();
  await page.locator('.source-group-head', { hasText: 'Week 1' }).waitFor();
  assert.equal(await page.locator('.sources-view-bar .sh-seg__item.is-active').innerText(), '按文件夹');
  assert.equal(await page.locator('.source-group-head', { hasText: 'Week 1' }).getAttribute('aria-expanded'), 'false');

  // Switch back to course mode: DB stays collapsed as remembered
  await page.locator('.sources-view-bar .sh-seg__item', { hasText: '按课程' }).click();
  assert.equal(await page.locator('.source-group-head', { hasText: 'DB' }).getAttribute('aria-expanded'), 'false');
  await page.locator('.source-group-head', { hasText: 'DB' }).click();

  // B6: checking db1 in DB, switching scope to OS, checking os2, applying course 'OS' must NEVER mutate hidden db1!
  await page.locator('details.source-organize > summary').click();
  await page.locator('[data-document-key="source:db1"] .source-doc__check').check();
  await page.locator('.page-scope__select').click();
  await page.locator('[role="option"]', { hasText: 'OS' }).click();
  // Hidden db1 must NOT count toward visible selection
  assert.match(await page.locator('details.source-organize').innerText(), /已选择 0 份资料/);
  await page.locator('[data-document-key="source:os2"] .source-doc__check').check();
  assert.match(await page.locator('details.source-organize').innerText(), /已选择 1 份资料/);
  await page.locator('details.source-organize .course-field__input').fill('Networks');
  const saved = page.waitForResponse(response =>
    response.url().endsWith('/api/call') && response.request().postDataJSON()?.action === 'source.courses.set');
  await page.locator('details.source-organize button', { hasText: '应用课程归属' }).click();
  const reply = await saved;
  assert.ok(reply.ok(), 'course assignments were accepted');
  await reply.finished();

  const snapAfterB6 = await service.call('snapshot');
  assert.deepEqual(snapAfterB6.sources.find(s => s.id === 'db1').courses, ['DB'], 'B6: hidden checked material db1 was not mutated');
  assert.deepEqual(snapAfterB6.sources.find(s => s.id === 'os2').courses, ['Networks'], 'visible checked material os2 updated cleanly');

  // Narrow viewports (420px & 390px) have zero horizontal overflow
  await page.locator('.page-scope__select').click();
  await page.locator('[role="option"]', { hasText: '全部课程' }).click();
  for (const width of [420, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `expected zero horizontal overflow at ${width}px, got ${overflow}`);
  }
  assert.deepEqual(errors, []);
});
