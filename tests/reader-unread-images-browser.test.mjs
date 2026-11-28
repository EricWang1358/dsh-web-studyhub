/* global document, window, navigator, localStorage */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { frames, openPage, settleAnimations, startLateServer, until } from '../scripts/qa/layout-late.mjs';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { previewCall } from '../scripts/preview-server.mjs';
import { makeTextPdf } from './helpers/text-pdf.mjs';
import { apara, picture, pptxFile, shape } from './helpers/office.mjs';

/* #1457 browser regression:
   1. Converted PDF with imagePages ([1]) + skippedPages ([2]) + attached original PDF in 阅读 mode at 1280px & 420px:
      verifies inline unread-image notice, skipped-page notice in order, zero layout overlap/overflow,
      and Desktop/standalone (capabilities.chat = false) quick handoff renders & stages page image via focus.images.stage
      and copies prompt containing the staged image path for agy CLI.
   2. PPTX document with omittedVisuals: ['image', 'chart'] slide + skipped image-only slide:
      verifies slide-level unread-visuals notice & quick handoff action.
   3. Real DSH host adapter (ui/host/workspace.jsx) when chatTakesPictures returns false:
      verifies upfront vision-unsupported warning before clicking and text-only draft handoff on click (submit never touched). */

const PDF_TITLE = 'Systems Diagrams';
const PPTX_TITLE = 'Architecture Slides';

const chartFrame = () =>
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="11" name="Chart 1"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>'
  + '<p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">'
  + '<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId2"/></a:graphicData></a:graphic></p:graphicFrame>';

const dshHostBundle = await build({
  stdin: {
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import * as workspace from './ui/host/workspace.jsx';
      import { setUiLanguage } from './ui/i18n.js';
      setUiLanguage(window.uiLanguage || 'zh');
      const seats = {}, roots = {}, log = window.dshLog = [];
      const rpc = { call: async (_route, _path, payload) => {
        if (payload.action === 'chat.model.images') {
          return { ok: true, value: { takes: window.dshModelTakesImages } };
        }
        const reply = await window.invokeStudy(payload.action, payload.args);
        return reply.ok ? { ok: true, value: reply.value } : { ok: false, error: { message: reply.error, code: reply.code } };
      } };
      const shell = {
        get projection() { return { detectText: window.composerText }; },
        state: { getSnapshot: () => ({ draft: window.composerText, attachmentIds: window.composerAttachments || [] }) },
        setDraft: (text) => { log.push('setDraft'); window.composerText = text; },
        addAttachments: (ids) => { log.push('addAttachments:' + ids.length); window.composerAttachments = ids; return true; },
        removeAttachment: () => true,
        notify: (tone, text) => { log.push('notify:' + tone + ':' + text); },
        submit: () => { log.push('submit'); },
        actions: { submit: () => { log.push('actions.submit'); } },
      };
      const guarded = (target, path) => new Proxy(target, { get(object, key) {
        if (key === 'submit') { log.push('submit-touched:' + path); throw new Error(path + '.submit must never be called'); }
        const value = object[key];
        return value && typeof value === 'object' ? guarded(value, path + '.' + String(key)) : value;
      } });
      const conversation = {
        input: { for: () => guarded(shell, 'input') },
        createDrafts: async (_sessionId, files) => files.map((file, index) => ({ id: 'att-' + index, name: file.name })),
      };
      const modelSnapshot = { current: { provider: 'mock', model: 'text-only' } };
      const modelDirectoryStore = { getSnapshot: () => modelSnapshot, subscribe: () => () => {} };
      const modelDirectories = {
        directoryFor: () => ({ store: modelDirectoryStore }),
      };
      const services = {
        connection: { rpc },
        modelDirectories,
        layout: { selectPanel: (id) => { if (window.dshReady) log.push('selectPanel:' + id); } },
        sessions: { scope: () => ({ get: (name) => (name === 'conversation' ? conversation : undefined) }) },
      };
      const ctx = {
        get: (name) => services[name],
        effect(fn) { fn(); },
        inject: (_n, fn) => fn(ctx),
        locale: { register: () => () => {}, bind: () => (key) => key },
        slots: { inject: (_n, fn) => fn(), register: (descriptor, component) => { seats[descriptor.name + ':' + (descriptor.key || descriptor.id)] = component; return () => {}; } },
        sidebarRightTabs: { register: () => () => {} },
      };
      window.installDsh = () => workspace.apply(ctx, () => {});
      window.mountPage = () => {
        roots.page ||= createRoot(document.getElementById('main'));
        roots.page.render(React.createElement(seats['study-workspace.page:undefined'], { sessionId: 's1' }));
      };
    `,
    resolveDir: process.cwd(),
    loader: 'jsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'iife',
  loader: { '.css': 'text' },
  logLevel: 'silent',
});

function rectsOverlap(a, b) {
  return a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
}

async function seedCoursewareLibrary(root) {
  const runtime = createStudyRuntime(root);
  try {
    // 1. Converted PDF (MinerU v1 JSON): page 1 has text + image, page 2 is image-only (skipped), page 3 is text-only.
    const mineruContent = [
      { type: 'text', text: 'Page one explains the replication pipeline and leader election state machine.', page_idx: 0 },
      { type: 'image', img_path: 'images/fig1.jpg', page_idx: 0 },
      { type: 'image', img_path: 'images/fig2.jpg', page_idx: 1 },
      { type: 'text', text: 'Page three summarizes quorum intersection invariants without figures.', page_idx: 2 },
    ];
    const pdfImport = await runtime.call('materials.document.import', {
      filename: `${PDF_TITLE}.json`,
      title: PDF_TITLE,
      dataBase64: Buffer.from(JSON.stringify(mineruContent), 'utf8').toString('base64'),
      courses: ['Distributed Systems'],
    });
    assert.deepEqual(pdfImport.imagePages, [1]);
    assert.deepEqual(pdfImport.skippedPages, [2]);

    // Attach a real 3-page PDF original so renderPageImages can draw page 1 in Chromium and stage it via focus.images.stage.
    const originalPdfBytes = await makeTextPdf([
      'Page one explains the replication pipeline and leader election state machine.',
      'Diagram only page.',
      'Page three summarizes quorum intersection invariants without figures.',
    ]);
    const attached = await runtime.call('materials.original.attach', {
      documentId: pdfImport.documentId,
      mode: 'copy',
      filename: `${PDF_TITLE}.pdf`,
      dataBase64: originalPdfBytes.toString('base64'),
      confirm: true,
    });
    assert.equal(attached.status, 'attached');

    // 2. PPTX deck: slide 1 has text + picture + chart, slide 2 is image-only (skipped), slide 3 is text-only.
    const pptxBytes = pptxFile([
      { shapes: [shape([apara('Consensus Metrics')], { ph: 'title' }), picture(), chartFrame()] },
      { shapes: [picture()] },
      { shapes: [shape([apara('Summary Only')], { ph: 'title' })] },
    ], { title: PPTX_TITLE });
    const pptxImport = await runtime.call('materials.document.import', {
      filename: `${PPTX_TITLE}.pptx`,
      dataBase64: pptxBytes.toString('base64'),
      courses: ['Distributed Systems'],
    });
    assert.deepEqual(pptxImport.imagePages, [1]);
    assert.deepEqual(pptxImport.skippedPages, [2]);
    assert.deepEqual(pptxImport.omittedVisuals, ['image', 'chart']);

    return { libraryRoot: root, pdfId: pdfImport.documentId, pptxId: pptxImport.documentId };
  } finally {
    runtime.dispose();
  }
}

async function installClipboardSpy(context) {
  await context.addInitScript(() => {
    window.copiedPrompts = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => { window.copiedPrompts.push(text); },
      },
    });
  });
}

async function openMaterialFromSources(page, title) {
  await (await revealNavRow(page, 'sources')).click().catch(() => { /* already active */ });
  const row = page.locator('.source-doc', { hasText: title }).first();
  await row.waitFor({ timeout: 30000 });
  const rowText = await row.innerText();
  assert.match(rowText, /含未识别图片/, `${title}: Sources row shows unread-image badge`);
  assert.match(rowText, /跳过 1/, `${title}: Sources row shows skipped-page count via snapshotSources`);
  await row.locator('.source-main').click();
  const viewer = page.locator('.study-document-viewer');
  await viewer.waitFor({ timeout: 30000 });
  await until(async () => (await viewer.locator('.reader-loading').count()) === 0, `${title}: reader to finish opening`, { timeoutMs: 30000 });
  await settleAnimations(page);
  await frames(page, 2);
  return viewer;
}

async function assertNoticeLayoutClean(page, selector, label) {
  const layout = await page.evaluate((sel) => {
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const notice = document.querySelector(sel);
    const section = notice?.closest('.reader-section');
    const scroller = notice?.closest('.reader-scroll');
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      notice: rect(notice),
      scroller: rect(scroller),
      prose: rect(section?.querySelector('.reader-prose')),
      head: rect(notice?.querySelector('.reader-unread__head')),
      controls: rect(notice?.querySelector('.reader-unread__controls')),
      input: rect(notice?.querySelector('.reader-unread__input')),
      button: rect(notice?.querySelector('[data-hand-off="reader.page"]')),
    };
  }, selector);
  assert.ok(layout.overflow <= 0, `${label}: horizontal overflow ${layout.overflow}px`);
  assert.ok(layout.notice && layout.notice.width > 0 && layout.notice.height > 0, `${label}: notice visible with non-zero box`);
  assert.ok(layout.head && layout.controls && layout.input && layout.button, `${label}: head, controls, input, button all rendered`);
  assert.ok(layout.notice.left >= layout.scroller.left - 1 && layout.notice.right <= layout.scroller.right + 1, `${label}: notice stays within .reader-scroll`);
  assert.equal(rectsOverlap(layout.head, layout.controls), false, `${label}: notice head and controls must not overlap`);
  assert.equal(rectsOverlap(layout.input, layout.button), false, `${label}: input and handoff button must not overlap`);
  if (layout.prose) {
    assert.equal(rectsOverlap(layout.prose, layout.notice), false, `${label}: notice must not overlap page prose`);
  }
}

test('reader unread-images notices & handoff: converted PDF (1280px & 420px + Desktop staging), PPTX omittedVisuals, and DSH vision-unsupported warning (#1457)', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium available: ${String(error.message).split('\n')[0]}`); return; }
  t.after(() => browser.close());

  const dist = await mkdtemp(join(tmpdir(), 'study-unread-images-dist-'));
  t.after(() => rm(dist, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  await buildPreview({ outdir: dist });

  const running = await startLateServer({ distDir: dist, seed: seedCoursewareLibrary });
  t.after(() => running.close?.());

  // 1. Converted PDF at 1280px & 420px in standalone/Desktop mode (capabilities.chat = false)
  for (const width of [1280, 420]) {
    await t.test(`converted PDF in 阅读 mode at ${width}px (Desktop/standalone image staging)`, async () => {
      const { context, page, errors } = await openPage(browser, running, { width, height: 900 });
      try {
        await installClipboardSpy(context);
        await page.goto(running.server.url);
        await page.evaluate(() => localStorage.removeItem('studyhub-last-read:v1'));

        const viewer = await openMaterialFromSources(page, PDF_TITLE);
        const notice1 = viewer.locator('.reader-section[data-study-page="1"] .reader-unread[data-unread-page="1"]');
        const skipped2 = viewer.locator('.reader-section--skipped[data-skipped-page="2"] .reader-unread[data-unread-page="2"]');
        const page3Notices = viewer.locator('.reader-section[data-study-page="3"] .reader-unread');

        await notice1.waitFor({ state: 'visible', timeout: 15000 });
        await skipped2.waitFor({ state: 'visible', timeout: 15000 });
        assert.equal(await page3Notices.count(), 0, `${width}px: text-only page 3 has no unread-image notice`);

        // Verify skipped page 2 is interleaved strictly between page 1 and page 3 in DOM order
        const order = await viewer.evaluate(() => {
          const nodes = [...document.querySelectorAll('.study-document-viewer .reader-section')];
          return nodes.map((el) => el.dataset.studyPage || `skipped:${el.dataset.skippedPage}`);
        });
        assert.deepEqual(order, ['1', 'skipped:2', '3'], `${width}px: skipped page 2 sits between page 1 and page 3`);

        assert.match(await notice1.innerText(), /这一页里的图片或图表没有读进来/);
        assert.match(await skipped2.innerText(), /第 2 页仅含图片或没有可读文字，已跳过/);
        assert.match(await notice1.locator('[data-hand-off="reader.page"]').innerText(), /复制给 agy CLI/);

        await assertNoticeLayoutClean(page, '.reader-section[data-study-page="1"] .reader-unread', `${width}px PDF p1`);
        await assertNoticeLayoutClean(page, '.reader-section--skipped[data-skipped-page="2"] .reader-unread', `${width}px PDF skipped p2`);

        // Type a question and click quick handoff -> renders PDF page 1 image, stages via focus.images.stage, copies prompt for agy CLI
        await notice1.locator('.reader-unread__input').fill('请结合图讲一下状态转换');
        await notice1.locator('[data-hand-off="reader.page"]').click();
        await until(async () => (await page.evaluate(() => window.copiedPrompts.length)) >= 1, `${width}px: prompt copied to clipboard`, { timeoutMs: 30000 });

        const copied = await page.evaluate(() => window.copiedPrompts.at(-1));
        assert.match(copied, /第 1 页/, `${width}px: prompt names page 1`);
        assert.match(copied, /请结合图讲一下状态转换/, `${width}px: prompt includes learner question`);
        assert.match(copied, /```data 页码截图路径\nstudyhub-work\/focus-intake\/.+\.jpg\n```/, `${width}px: prompt includes staged page image path`);

        const pathMatch = copied.match(/```data 页码截图路径\n([^\n]+)\n```/);
        assert.ok(pathMatch, `${width}px: extracted staged relative path`);
        const fileStat = await stat(join(running.seeded.libraryRoot, pathMatch[1]));
        assert.ok(fileStat.size > 500, `${width}px: staged JPEG exists on disk (${fileStat.size} bytes)`);

        assert.deepEqual(errors.filter((text) => !/favicon/.test(text)), [], `${width}px: no unexpected errors`);
      } finally {
        await context.close();
      }
    });
  }

  // 2. PPTX document with omittedVisuals: ['image', 'chart'] + skipped image-only slide
  await t.test('PPTX slide-level omittedVisuals notice & quick handoff', async () => {
    const { context, page, errors } = await openPage(browser, running, { width: 1280, height: 900 });
    try {
      await installClipboardSpy(context);
      await page.goto(running.server.url);
      await page.evaluate(() => localStorage.removeItem('studyhub-last-read:v1'));

      const viewer = await openMaterialFromSources(page, PPTX_TITLE);
      const slide1Notice = viewer.locator('.reader-section[data-study-page="1"] .reader-unread[data-unread-page="1"]');
      const slide2Skipped = viewer.locator('.reader-section--skipped[data-skipped-page="2"] .reader-unread[data-unread-page="2"]');
      const slide3Notices = viewer.locator('.reader-section[data-study-page="3"] .reader-unread');

      await slide1Notice.waitFor({ state: 'visible', timeout: 15000 });
      await slide2Skipped.waitFor({ state: 'visible', timeout: 15000 });
      assert.equal(await slide3Notices.count(), 0, 'PPTX text-only slide 3 has no unread notice');

      const slide1Text = await slide1Notice.innerText();
      assert.match(slide1Text, /这一张幻灯片里的图片、图表没有读进来/, 'PPTX slide 1 names omitted image + chart');
      assert.match(await slide2Skipped.innerText(), /第 2 张幻灯片仅含图片或没有可读文字，已跳过/);
      await assertNoticeLayoutClean(page, '.reader-section[data-study-page="1"] .reader-unread', 'PPTX slide 1');

      await slide1Notice.locator('.reader-unread__input').fill('帮我读懂柱状图里的吞吐变化');
      await slide1Notice.locator('[data-hand-off="reader.page"]').click();
      await until(async () => (await page.evaluate(() => window.copiedPrompts.length)) >= 1, 'PPTX prompt copied', { timeoutMs: 15000 });

      const copied = await page.evaluate(() => window.copiedPrompts.at(-1));
      assert.match(copied, /幻灯片/);
      assert.match(copied, /第 1 张/);
      assert.match(copied, /图片、图表/);
      assert.match(copied, /帮我读懂柱状图里的吞吐变化/);
      assert.deepEqual(errors.filter((text) => !/favicon/.test(text)), [], 'PPTX: no unexpected errors');
    } finally {
      await context.close();
    }
  });

  // 3. DSH host adapter when chatTakesPictures returns false: upfront vision-unsupported warning before clicking
  await t.test('DSH host with chatTakesPictures() === false shows upfront vision-unsupported warning before clicking', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.exposeFunction('invokeStudy', async (action, args) => {
        try { return { ok: true, value: await previewCall(running.server, action, args) }; }
        catch (error) { return { ok: false, error: error.message, code: error.code }; }
      });
      await context.addInitScript(() => {
        try { localStorage.setItem('study-ui-language', 'zh'); localStorage.removeItem('studyhub-last-read:v1'); } catch { /* blocked */ }
        window.uiLanguage = 'zh';
        window.dshModelTakesImages = false;
        window.composerText = '';
        window.composerAttachments = [];
        window.copied = [];
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: { writeText: async (text) => { window.copied.push(text); } },
        });
      });
      await page.route('**/*', (route) => (route.request().url() === 'http://dsh-unread.test/'
        ? route.fulfill({ contentType: 'text/html', body: '<div id="main"></div>' })
        : route.abort()));
      await page.goto('http://dsh-unread.test/');
      await page.addScriptTag({ content: dshHostBundle.outputFiles[0].text });
      await page.evaluate(() => { window.installDsh(); window.mountPage(); window.dshReady = true; });

      await (await revealNavRow(page, 'sources', { timeout: 60000 })).click();
      const row = page.locator('.source-doc', { hasText: PDF_TITLE }).first();
      await row.waitFor({ timeout: 30000 });
      await row.locator('.source-main').click();

      const viewer = page.locator('.study-document-viewer');
      await viewer.waitFor({ timeout: 30000 });
      const notice1 = viewer.locator('.reader-section[data-study-page="1"] .reader-unread[data-unread-page="1"]');
      await notice1.waitFor({ state: 'visible', timeout: 15000 });

      // Vision-unsupported warning MUST be visible BEFORE any click on the handoff button
      const warn = notice1.locator('.reader-unread__warn[data-vision-unsupported="true"]');
      await warn.waitFor({ state: 'visible', timeout: 10000 });
      assert.match(await warn.innerText(), /当前主会话模型不支持看图/);

      const btn = notice1.locator('[data-hand-off="reader.page"]');
      assert.match(await btn.innerText(), /发给主会话/);

      // Clicking fills DSH composer text-only (no image attachments, submit never touched)
      await btn.click();
      await until(async () => (await page.evaluate(() => window.composerText.length)) > 0, 'DSH composer draft filled', { timeoutMs: 15000 });

      const dshState = await page.evaluate(() => ({
        text: window.composerText,
        attachments: window.composerAttachments,
        log: window.dshLog.slice(),
      }));
      assert.match(dshState.text, /第 1 页/);
      assert.deepEqual(dshState.attachments, [], 'DSH text-only model receives no image attachments');
      assert.equal(dshState.log.some((entry) => /submit/.test(entry)), false, 'DSH submit must never be touched');
      assert.ok(dshState.log.includes('setDraft'), 'DSH composer setDraft was called');
      assert.deepEqual(errors, [], 'DSH: no page errors');
    } finally {
      await context.close();
    }
  });
});
