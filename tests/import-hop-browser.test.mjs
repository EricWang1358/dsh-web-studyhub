/* global document, window -- page.evaluate callbacks run in the browser */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { frames, openPage, settleAnimations, until } from '../scripts/qa/layout-late.mjs';
import { StudyService } from '../lib/service.js';
import { makePdf } from './helpers/pdf.mjs';

/* Importing material in fewer steps, in the browser preview on a seeded temporary library: the course line and its reason, a new material that is not hidden
   by the page's course filter, the first import landing on 创建题组 with the file ticked, a PDF with no text and a PDF over 8 MB led into the converter with
   the file staged (and back from Settings with the file), the folded converter, and the audio form: files carried over from the Files tab, one start button that says
   what it will do, a subtitle that waits for its estimate. Each at 1280 and 420 px with no sideways scroll. IMPORT_HOP_SHOTS=<folder> writes the screenshots. */

const SHOTS = process.env.IMPORT_HOP_SHOTS || '';
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }); };
const overflow = page => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const MB = 1024 * 1024;

/** A WAV that plays for `seconds` at a rate so low that an hour is a few megabytes: real audio to the pre-flight, nothing a provider would transcribe. */
function wav(seconds, rate = 1000) {
  const data = Buffer.alloc(seconds * rate, 128), header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1'); header.writeUInt32LE(36 + data.length, 4); header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate, 28); header.writeUInt16LE(1, 32); header.writeUInt16LE(8, 34);
  header.write('data', 36, 'latin1'); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function seed(root, { empty = false } = {}) {
  await mkdir(root, { recursive: true });
  const service = new StudyService(root);
  await service.call('snapshot');
  if (!empty) await service.store.update(state => {
    const at = new Date().toISOString();
    state.sources.push({ id: 'os-1', title: '操作系统 第一讲', text: '进程与线程。'.repeat(40), createdAt: at, courses: ['操作系统'] },
      { id: 'net-1', title: '网络 第一讲', text: '传输层。'.repeat(40), createdAt: at, courses: ['CS2105'] });
    state.courses = [{ id: 'course-os', name: '操作系统', aliases: ['OS'], guidanceSourceIds: [], focusTopics: [] }];
  });
  service.dispose?.();
}

async function start(distDir, options) {
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-import-hop-'));
  const root = join(base, 'library'), home = join(base, 'home');
  await seed(root, options);
  // A transcription key that is only a name for the pre-flight: nothing in these tests sends audio to a provider.
  await mkdir(join(home, 'study'), { recursive: true });
  await writeFile(join(home, 'study', 'audio.json'), JSON.stringify({ version: 1, siliconflowKey: 'sk-import-hop-test-key-0000000000' }));
  const server = await createPreviewServer({ libraryRoot: root, home, port: 0, model: createFakeModel({ latencyMs: 20 }), distDir });
  return { server, base, close: async () => { await server.close(); await rm(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }); } };
}

async function openApp(browser, running, { width = 1280, height = 900, lang = 'zh' } = {}) {
  const opened = await openPage(browser, running, { lang, theme: 'dark', width, height });
  await opened.page.goto(running.server.url);
  await opened.page.locator('aside, nav').first().waitFor({ timeout: 30000 });
  return opened;
}

const dialog = page => page.locator('dialog[open], [role="dialog"]').first();
async function openSources(page) {
  await page.locator('[data-tour="nav-sources"]').first().dispatchEvent('click');
  await page.locator('.sources-page').waitFor({ timeout: 30000 });
}
async function openAdd(page) {
  await page.locator('[data-tour="sources-add"]').first().click();
  await dialog(page).waitFor({ timeout: 30000 });
}
const pick = (page, ...files) => dialog(page).locator('.sh-drop input[type="file"]').first().setInputFiles(files);
const text = locator => locator.innerText();

test('the add-material dialog, the first import, a PDF the importer cannot use, the audio form: fewer steps, at 1280 and 420 px', { timeout: 1500000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to measure with: ${String(error.message).split('\n')[0]}`); return; }
  const dist = await mkdtemp(join(tmpdir(), 'study-import-hop-dist-'));
  await buildPreview({ outdir: dist });
  const scanned = { name: '扫描讲义.pdf', mimeType: 'application/pdf', buffer: await makePdf({ pages: 2, text: false }) };
  const big = { name: 'Textbook.pdf', mimeType: 'application/pdf', buffer: await makePdf({ pages: 3, padBytes: 3 * MB }) };
  try {
    /* ---- a library with two courses ---- */
    const library = await start(dist);
    try {
      for (const width of [1280, 420]) {
        const { page, errors, context } = await openApp(browser, library, { width });
        await openSources(page);
        await openAdd(page);
        const box = dialog(page);

        // the course is one line with its reason; the field and the converter cards are not on the main path
        assert.match(await text(box.locator('.import-hub__chip')), /归入「操作系统」\s*当前课程\s*更改/);
        assert.equal(await box.locator('.course-field').count(), 0, `${width}px: the field is behind 更改`);
        assert.equal(await box.locator('.import-hub__conversion').evaluate(element => element.open), false, `${width}px: the converter fold is closed`);
        assert.equal(await box.getByRole('button', { name: /用 MinerU 解析|用 Marker 解析/ }).count(), 0);
        await settleAnimations(page);
        assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll in the dialog`);
        await shot(page, `dialog-${width}`);
        await box.locator('.import-hub__chip button').click();
        await box.locator('.course-field').waitFor();
        await shot(page, `dialog-field-${width}`);
        await box.locator('.import-hub__chip button').click();

        // add, choose, pick: 3 actions; the dialog closes on 资料 with the row highlighted and 用它出题 in the toast
        await pick(page, { name: 'lecture-notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n\nSome text about processes and threads.\n') });
        await until(async () => (await page.locator('dialog[open]').count()) === 0, 'the dialog closed after the import', { timeoutMs: 60000 });
        await page.locator('.sources-page').waitFor();
        await page.locator('[role="status"], .sh-toast').filter({ hasText: /已导入「lecture-notes\.md」/ }).first().waitFor({ timeout: 30000 });
        assert.ok(await page.getByRole('button', { name: '用它出题' }).count() > 0, `${width}px: 用它出题 is offered in the toast`);
        await shot(page, `landing-${width}`);

        // a blank course and a file named for one course: filled in, said, and the row is not hidden by the page's course filter
        await openAdd(page);
        await box.locator('.import-hub__chip button').click();
        await box.getByRole('button', { name: '清空课程' }).click();
        assert.match(await text(box.locator('.import-hub__chip')), /未分类/);
        await pick(page, { name: 'CS2105 week 3.md', mimeType: 'text/markdown', buffer: Buffer.from('# Week 3\n\nThe transport layer.\n') });
        await until(async () => (await page.locator('dialog[open]').count()) === 0, 'the dialog closed', { timeoutMs: 60000 });
        await page.locator('.sh-toast, [role="status"]').filter({ hasText: /归入「CS2105」（文件名里有课程名）/ }).first().waitFor({ timeout: 30000 });
        await until(async () => (await page.locator('.source-row, .source-doc, [data-source-row]').filter({ hasText: 'CS2105 week 3' }).count()) > 0
          || (await page.locator('.sources-page').getByText('CS2105 week 3').count()) > 0, 'the new material is on the page though its course is not the page scope');
        await shot(page, `landing-other-course-${width}`);
        assert.deepEqual(errors.filter(error => !/favicon/.test(error)), [], `${width}px: no page errors`);
        await context.close();
      }
    } finally { await library.close(); }

    /* ---- PDFs the importer cannot use ---- */
    const converters = await start(dist);
    try {
      for (const width of [1280, 420]) {
        const { page, errors, context } = await openApp(browser, converters, { width });
        await openSources(page);
        await openAdd(page);
        const box = dialog(page);

        // no text: the reason on the row, the converter staged right under it (the start button is its one action)
        await pick(page, scanned);
        await box.locator('.mineru-route-panel').waitFor({ timeout: 60000 });
        assert.match(await text(box.locator('.sh-file--error')), /扫描件/);
        assert.match(await text(box.locator('.mineru-file')), /扫描讲义\.pdf/, `${width}px: the file is staged in the panel`);
        assert.equal(await box.getByText('选择 PDF…').count(), 0, `${width}px: no second picker`);
        await until(async () => (await box.locator('.mineru-plan, .mineru-reading').count()) > 0 || (await box.locator('.sh-inline').count()) > 0, 'the staged plan or the setup note');
        await settleAnimations(page);
        assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll with the converter staged`);
        await shot(page, `scanned-${width}`);

        // the converter is not set up here: 前往设置 closes the dialog, and the way back brings the file with it
        const setup = box.getByRole('button', { name: '前往设置' }).first();
        if (await setup.count()) {
          await setup.click();
          await page.locator('.sh-toast, [role="status"]').filter({ hasText: /设置好之后回来继续解析「扫描讲义\.pdf」/ }).first().waitFor({ timeout: 30000 });
          await shot(page, `settings-notice-${width}`);
          await page.getByRole('button', { name: '继续解析' }).first().click();
          await dialog(page).waitFor();
          await dialog(page).locator('.mineru-file').waitFor({ timeout: 60000 });
          assert.match(await text(dialog(page).locator('.mineru-file')), /扫描讲义\.pdf/, `${width}px: the same file is back in the dialog`);
          await page.keyboard.press('Escape');
          await until(async () => (await page.locator('dialog[open]').count()) === 0, 'the dialog closed');
          await openSources(page);
          await openAdd(page);
        }

        // over 8 MB: the same staged converter; a big text file is only told to split
        await pick(page, big);
        await box.locator('.large-doc .mineru-file').waitFor({ timeout: 90000 });
        assert.match(await text(box.locator('.large-doc .mineru-file')), /Textbook\.pdf/);
        await shot(page, `large-${width}`);
        assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll with the large card`);
        await pick(page, { name: 'huge.md', mimeType: 'text/markdown', buffer: Buffer.alloc(9 * MB, 97) });
        await until(async () => (await box.locator('.sh-file--error').filter({ hasText: /huge\.md/ }).count()) > 0, 'huge.md refused');
        assert.match(await text(box.locator('.sh-file--error').filter({ hasText: /huge\.md/ })), /按章节拆分/);
        assert.equal(await box.locator('.sh-file--error').filter({ hasText: /huge\.md/ }).getByRole('button', { name: '重试' }).count(), 0);
        assert.deepEqual(errors.filter(error => !/favicon|Failed to load resource/.test(error)), [], `${width}px: no page errors`);
        await context.close();
      }
    } finally { await converters.close(); }

    /* ---- the audio form ---- */
    const audio = await start(dist);
    try {
      for (const width of [1280, 420]) {
        const { page, errors, context } = await openApp(browser, audio, { width });
        const calls = [];
        await page.route('**/api/call', route => {
          let action = '';
          try { action = JSON.parse(route.request().postData() || '{}').action; } catch { /* not JSON */ }
          calls.push(action);
          if (action === 'audio.import') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, value: { status: 'running', jobId: 'job-test' } }) });
          return route.continue();
        });
        await openSources(page);
        await openAdd(page);
        const box = dialog(page);

        // recordings dropped on the Files tab are carried to the audio form, not refused; the Files tab keeps no error row for them
        await pick(page, { name: 'week1.wav', mimeType: 'audio/wav', buffer: wav(95 * 60) }, { name: 'week2.wav', mimeType: 'audio/wav', buffer: wav(20 * 60) });
        await until(async () => (await box.locator('.audio-chosen').count()) === 2, `${width}px: both recordings are in the audio form`, { timeoutMs: 60000 });
        await until(async () => /开始（约 \d+ 分钟，分 \d+ 段，\d+ 次请求；2 个录音合成 1 份逐字稿）/.test(await text(box.locator('.audio-submit button[type="submit"]'))), 'the start button says the split and the merge', { timeoutMs: 60000 });
        assert.equal(await box.getByRole('button', { name: '分段并继续' }).count(), 0, `${width}px: no second button for the split`);
        assert.equal(await box.locator('.audio-more').evaluate(element => element.open), false, `${width}px: 更多设置 is closed`);
        assert.equal(await box.locator('.course-field').count(), 0, `${width}px: no second course field`);
        await until(async () => (await box.locator('[data-token-estimate][data-status="ready"]').count()) > 0, 'the estimate', { timeoutMs: 60000 });
        await frames(page, 3);
        assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll in the audio form`);
        await shot(page, `audio-${width}`);
        await box.locator('.audio-more summary').click();
        await settleAnimations(page);
        await box.locator('.audio-more').getByRole('button', { name: '前往设置' }).scrollIntoViewIfNeeded();
        await shot(page, `audio-more-${width}`);

        // one press: the import starts, the dialog closes, and the learner is on 资料 where the job is
        assert.equal(calls.includes('audio.import'), false, 'nothing starts before the press');
        await box.locator('.audio-submit button[type="submit"]').click();
        await until(async () => (await page.locator('dialog[open]').count()) === 0, 'the dialog closed after the start', { timeoutMs: 60000 });
        assert.ok(calls.includes('audio.import'));
        await page.locator('.sources-page').waitFor();

        // a subtitle file waits for the learner: its estimate is shown first, and no model is called by dropping it
        await openAdd(page);
        const before = calls.filter(action => action === 'audio.subtitles.import').length;
        await pick(page, { name: 'talk.srt', mimeType: 'text/plain', buffer: Buffer.from('1\n00:00:01,000 --> 00:00:03,000\nHello everyone\n\n2\n00:00:03,000 --> 00:00:06,000\nToday we talk about paging and virtual memory.\n') });
        await box.locator('.audio-chosen').first().waitFor({ timeout: 60000 });
        await until(async () => (await box.locator('[data-token-estimate][data-status="ready"]').count()) > 0, 'the subtitle estimate', { timeoutMs: 60000 });
        assert.equal(calls.filter(action => action === 'audio.subtitles.import').length, before, `${width}px: dropping a subtitle file does not start it`);
        await shot(page, `subtitle-${width}`);
        assert.deepEqual(errors.filter(error => !/favicon|Failed to load resource/.test(error)), [], `${width}px: no page errors`);
        await context.close();
      }
    } finally { await audio.close(); }

    /* ---- the first import ---- */
    for (const width of [1280, 420]) {
      const fresh = await start(dist, { empty: true });
      try {
        const { page, errors, context } = await openApp(browser, fresh, { width });
        const first = page.getByRole('button', { name: /添加资料|导入我的第一份资料|添加第一份资料/ }).first();
        try { await first.waitFor({ timeout: 30000 }); } catch (error) { await shot(page, `first-run-missing-${width}`); throw new Error(`${error.message}\n${(await page.locator('main').innerText()).slice(0, 600)}`); }
        await shot(page, `first-run-${width}`);
        await first.click();
        await dialog(page).waitFor();
        await pick(page, { name: 'first-lecture.md', mimeType: 'text/markdown', buffer: Buffer.from('# Lecture one\n\nPaging splits memory into frames and pages.\n') });
        // import, then 创建题组 with the new material ticked: the next press is on the generate form
        await page.locator('.generate-page').waitFor({ timeout: 60000 });
        await until(async () => (await page.locator('.generate-page input[type="checkbox"]:checked').count()) > 0, 'the new material is ticked on the generate form');
        await page.locator('.sh-toast, [role="status"]').filter({ hasText: /已勾选，可以直接生成题组/ }).first().waitFor({ timeout: 30000 });
        await settleAnimations(page);
        assert.ok(await overflow(page) <= 0, `${width}px: no sideways scroll on the generate form`);
        await shot(page, `first-import-${width}`);
        assert.deepEqual(errors.filter(error => !/favicon|Failed to load resource/.test(error)), [], `${width}px: no page errors`);
        await context.close();
      } finally { await fresh.close(); }
    }

    /* ---- the home page's first step (after the welcome page was put away) leads the same way ---- */
    const starter = await start(dist, { empty: true });
    try {
      const { page, errors, context } = await openApp(browser, starter, { width: 1280 });
      await page.getByRole('button', { name: '以后再说' }).click();
      const add = page.getByRole('button', { name: '添加第一份资料' }).first();
      await add.waitFor({ timeout: 30000 });
      await shot(page, 'starter-1280');
      await add.click();
      await dialog(page).waitFor();
      await pick(page, { name: 'starter-lecture.md', mimeType: 'text/markdown', buffer: Buffer.from('# Lecture\n\nVirtual memory maps pages to frames.\n') });
      await page.locator('.generate-page').waitFor({ timeout: 60000 });
      await until(async () => (await page.locator('.generate-page input[type="checkbox"]:checked').count()) > 0, 'the new material is ticked on the generate form');
      assert.deepEqual(errors.filter(error => !/favicon|Failed to load resource/.test(error)), [], 'no page errors');
      await context.close();
    } finally { await starter.close(); }
  } finally {
    await browser.close();
    await rm(dist, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  }
});
