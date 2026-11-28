import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';
import { stageFocusImages } from '../lib/focus-image-stage.js';

const h = React.createElement;
const noop = () => {};
const han = /[\u3400-\u9fff]/;

const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const ONE_PIXEL_PNG_BYTES = Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64');
const ONE_PIXEL_DATA_URL = `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`;

function makeImageFile(name = 'page-3.png', type = 'image/png') {
  const file = new File([ONE_PIXEL_PNG_BYTES], name, { type });
  Object.defineProperty(file, 'dataUrl', { value: ONE_PIXEL_DATA_URL, enumerable: false });
  return file;
}

async function withTempDir(prefix, fn) {
  const parent = resolve(tmpdir());
  const dir = await mkdtemp(join(parent, prefix));
  try {
    return await fn(dir);
  } finally {
    if (!resolve(dir).startsWith(parent + sep)) {
      throw new Error(`Refusing to remove outside tmpdir: ${dir}`);
    }
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

const stripHtml = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const ui = await loadUi(`
  export { readFileAsDataUrl, stageImageFiles } from './ui/hand-off/stage-images.js';
  export { handOffOriginal } from './ui/document-preview/original-file.js';
  export { pageQuestionPrompt } from './ui/agent-prompts/reader.js';
  export { handOffText } from './ui/agent-prompts/index.js';
  export { deliverToChat } from './ui/hand-off/use-hand-off.js';
  export { default as PageAsk, pagePicture, visionStateOf } from './ui/document-preview/PageAsk.jsx';
  export { default as ReadingSections } from './ui/document-preview/reader/ReadingSections.jsx';
  export { readingSections } from './ui/document-preview/reader/text-sections.js';
  export { runImport, itemDetail, importDoneMessage } from './ui/ImportHub.jsx';
  export { PdfDetail } from './ui/PdfConvertJob.jsx';
  export { documentNotes } from './ui/SourcePicker.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { ToastContext } from './ui/components/Feedback.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const interactive = await loadInteractiveUi(`
  export { default as PageAsk } from './ui/document-preview/PageAsk.jsx';
  export { default as DocumentViewer } from './ui/document-preview/DocumentViewer.jsx';
  export { default as ReadingSections } from './ui/document-preview/reader/ReadingSections.jsx';
  export { readingSections } from './ui/document-preview/reader/text-sections.js';
  export { deliverToChat } from './ui/hand-off/use-hand-off.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { ToastContext } from './ui/components/Feedback.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

test('stageImageFiles uses host.stageFocusImages when available, else falls back to call(focus.images.stage), and catches errors cleanly', async () => {
  await withTempDir('study-stage-images-', async (workspaceDir) => {
    const img = makeImageFile('page-2.png');

    // 1. Uses host.stageFocusImages when present
    const viaHost = await ui.stageImageFiles({
      files: [img],
      host: {
        stageFocusImages: async (rawFiles) => stageFocusImages(workspaceDir, {
          files: rawFiles.map((f) => ({ name: f.name, dataUrl: f.dataUrl })),
        }),
      },
      call: async () => { throw new Error('should not invoke RPC when host.stageFocusImages exists'); },
    });
    assert.equal(viaHost.error, undefined);
    assert.equal(viaHost.files.length, 1);
    assert.match(viaHost.files[0], /^studyhub-work\/focus-intake\/.+\.png$/);
    assert.deepEqual(await readFile(join(workspaceDir, viaHost.files[0])), ONE_PIXEL_PNG_BYTES);

    // 2. Falls back to call('focus.images.stage') when host.stageFocusImages is absent
    const calls = [];
    const viaRpc = await ui.stageImageFiles({
      files: [img],
      host: { capabilities: { chat: false } },
      call: async (method, payload) => {
        calls.push(method);
        return stageFocusImages(workspaceDir, payload);
      },
    });
    assert.deepEqual(calls, ['focus.images.stage']);
    assert.equal(viaRpc.error, undefined);
    assert.equal(viaRpc.files.length, 1);
    assert.match(viaRpc.files[0], /^studyhub-work\/focus-intake\/.+\.png$/);

    // 3. Returns { files: [], error } on failure
    const failed = await ui.stageImageFiles({
      files: [img],
      host: null,
      call: async () => { throw new Error('disk full'); },
    });
    assert.deepEqual(failed.files, []);
    assert.match(String(failed.error?.message || failed.error), /disk full/);
  });
});

test('handOffOriginal returns { path } for PPTX and PPT originals when status is ok', () => {
  assert.deepEqual(
    ui.handOffOriginal({ format: 'pptx', original: { mode: 'reference', status: 'ok', path: 'D:\\Slides\\week3.pptx' } }),
    { path: 'D:\\Slides\\week3.pptx' },
  );
  assert.deepEqual(
    ui.handOffOriginal({
      format: 'ppt',
      original: { mode: 'copy', status: 'ok' },
      preview: { kind: 'file', absolutePath: 'D:\\lib\\attachments\\week3.ppt' },
    }),
    { path: 'D:\\lib\\attachments\\week3.ppt' },
  );
  assert.equal(
    ui.handOffOriginal({ format: 'pptx', original: { mode: 'reference', status: 'missing', path: 'D:\\Slides\\week3.pptx' } }),
    undefined,
  );
  assert.equal(
    ui.handOffOriginal({ format: 'txt', original: { mode: 'reference', status: 'ok', path: 'D:\\notes.txt' } }),
    undefined,
  );
});

test('pageQuestionPrompt handles stagedImages, PPTX omittedVisuals, and unreadImages in zh and en', () => {
  const stagedPath = 'studyhub-work/focus-intake/batch-1/page-3.jpg';

  // 1. Staged page image for agy CLI / external agent (zh & en)
  const zhStaged = ui.handOffText('reader.page', {
    title: 'Operating Systems',
    page: 3,
    text: 'Process state diagram',
    question: 'Explain the transitions in the figure.',
    stagedImages: [stagedPath],
    unreadImages: true,
  }, 'zh');
  assert.match(zhStaged, /```data 页码截图路径\nstudyhub-work\/focus-intake\/batch-1\/page-3\.jpg\n```/);
  assert.match(zhStaged, /没有读入|未读入/);
  assert.doesNotMatch(zhStaged, /这一页的截图（主会话能看图片时，粘贴在这里）：/, 'staged image omits paste-screenshot tail');

  const enStaged = ui.handOffText('reader.page', {
    title: 'Operating Systems',
    page: 3,
    text: 'Process state diagram',
    question: 'Explain the transitions in the figure.',
    stagedImages: [stagedPath],
    unreadImages: true,
  }, 'en');
  assert.match(enStaged, /```data Page image path\nstudyhub-work\/focus-intake\/batch-1\/page-3\.jpg\n```/);
  assert.match(enStaged, /did not read/i);
  assert.doesNotMatch(enStaged, han, 'English staged prompt has zero Han characters');

  // 2. PPTX slide with omittedVisuals & original file path (zh & en)
  const zhPptx = ui.handOffText('reader.page', {
    title: 'Distributed Systems Week 4',
    page: 7,
    format: 'pptx',
    text: 'Raft Consensus Overview',
    question: 'Walk me through the architecture diagram.',
    omittedVisuals: ['image', 'chart', 'smartart'],
    unreadImages: true,
    original: { path: 'D:\\Slides\\week4.pptx' },
  }, 'zh');
  assert.match(zhPptx, /幻灯片/);
  assert.match(zhPptx, /第 7 张/);
  assert.match(zhPptx, /图片/);
  assert.match(zhPptx, /图表/);
  assert.match(zhPptx, /SmartArt/);
  assert.match(zhPptx, /D:\\Slides\\week4\.pptx/);

  const enPptx = ui.handOffText('reader.page', {
    title: 'Distributed Systems Week 4',
    page: 7,
    format: 'pptx',
    text: 'Raft Consensus Overview',
    question: 'Walk me through the architecture diagram.',
    omittedVisuals: ['image', 'chart', 'smartart'],
    unreadImages: true,
    original: { path: 'D:\\Slides\\week4.pptx' },
  }, 'en');
  assert.match(enPptx, /slide 7/i);
  assert.match(enPptx, /pictures|images/i);
  assert.match(enPptx, /charts/i);
  assert.match(enPptx, /SmartArt/i);
  assert.doesNotMatch(enPptx, han, 'English PPTX prompt has zero Han characters');
});

test('Desktop pagePicture renders page image and stages it via focus.images.stage for agy CLI', async () => {
  await withTempDir('study-desktop-page-pic-', async (workspaceDir) => {
    const drawingStates = [];
    const desktopHost = { capabilities: { edition: 'desktop', chat: false } };
    const handOff = {
      pages: 1,
      loadImages: async () => [makeImageFile('page-5.png')],
    };
    const call = async (method, payload) => {
      if (method === 'focus.images.stage') return stageFocusImages(workspaceDir, payload);
      throw new Error(`Unexpected RPC: ${method}`);
    };

    const result = await ui.pagePicture(desktopHost, handOff, (on) => drawingStates.push(on), { call });
    assert.deepEqual(drawingStates, [true, false]);
    assert.equal(result.picture, undefined, 'desktop host does not return DSH composer attachment picture');
    assert.equal(result.stagedImages?.length, 1);
    assert.match(result.stagedImages[0], /^studyhub-work\/focus-intake\/.+\.png$/);

    // Combined with reader.page prompt + deliverToChat external CLI note
    const prompt = ui.handOffText('reader.page', {
      title: 'Networks',
      page: 5,
      text: 'TCP congestion window',
      question: 'Read the graph on this page.',
      unreadImages: true,
      ...result,
    }, 'zh');
    const copied = [];
    const outcome = await ui.deliverToChat({
      host: { ...desktopHost, studyCliPath: '/opt/studyhub/study-cli.mjs' },
      prompt,
      libraryRoot: workspaceDir,
      notify: noop,
      clipboard: { writeText: async (text) => copied.push(text) },
    });
    assert.equal(outcome, 'copied');
    assert.ok(copied[0].includes(result.stagedImages[0]), 'copied prompt includes staged image path');
    assert.ok(copied[0].includes('study-cli.mjs'), 'copied prompt includes external CLI fallback');
  });
});

test('visionStateOf maps 4 vision states and PageAsk shows upfront warning in DSH when chatTakesPictures() is false', async () => {
  assert.equal(ui.visionStateOf(true), 'supported');
  assert.equal(ui.visionStateOf(false), 'unsupported');
  assert.equal(ui.visionStateOf(undefined), 'unknown');
  assert.equal(ui.visionStateOf(null), 'none');

  const { React: R, mount, exports: m } = interactive;
  await withBrowserGlobals(async () => {
    for (const lang of ['zh', 'en']) {
      m.setUiLanguage(lang);
      const services = {
        call: async () => ({}),
        act: async () => undefined,
        busy: false,
        notify: noop,
        askInChat: async () => 'filled',
        host: { capabilities: { chat: true }, chatTakesPictures: async () => false },
        openSettings: noop,
        navigate: noop,
        openModal: noop,
      };
      const mounted = mount(() => R.createElement(
        m.StudyServicesContext.Provider,
        { value: services },
        R.createElement(m.PageAsk, {
          scope: { kind: 'page', page: 2, empty: false, chars: 42 },
          handOff: { title: 'OS', page: 2, text: 'Some text', pages: 1, loadImages: async () => [] },
          thread: { nodes: [] },
          total: 10,
        }),
      ));
      try {
        await mounted.flush(6);
        const text = mounted.text();
        if (lang === 'zh') {
          assert.match(text, /当前主会话模型不支持看图/);
        } else {
          assert.match(text, /cannot read images|does not support images/i);
          assert.doesNotMatch(text, han);
        }
      } finally {
        mounted.unmount();
        m.setUiLanguage('zh');
      }
    }
  });
});

test('ImportHub propagates imagePages/omittedVisuals and reports them in itemDetail, importDoneMessage, SourcePicker.documentNotes, and PdfDetail', async () => {
  ui.setUiLanguage('zh');
  const fake = (name) => ({ name, size: 12, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, text: async () => '' });
  const call = async (action, args) => {
    if (action === 'materials.document.import' && args.filename === 'slides.pptx') {
      return {
        documentId: 'doc-ppt',
        sourceIds: ['s1', 's2'],
        skippedPages: [3],
        imagePages: [1, 2],
        omittedVisuals: ['image', 'chart'],
        document: { title: 'Week 2 Slides', format: 'pptx' },
      };
    }
    return {
      documentId: 'doc-pdf',
      sourceIds: ['p1', 'p2'],
      skippedPages: [4],
      imagePages: [2],
      document: { title: 'Lecture Notes', format: 'pdf' },
    };
  };

  const results = await ui.runImport([fake('slides.pptx'), fake('notes.pdf')], { call });
  assert.deepEqual(results[0].result.imagePages, [1, 2]);
  assert.deepEqual(results[0].result.omittedVisuals, ['image', 'chart']);
  assert.deepEqual(results[1].result.imagePages, [2]);

  const pptDetail = ui.itemDetail(results[0]);
  assert.match(pptDetail, /第 1、2/);
  assert.match(pptDetail, /未识别/);
  assert.match(pptDetail, /第 3/);

  const pdfDetail = ui.itemDetail(results[1]);
  assert.match(pdfDetail, /第 2 页含未识别图片/);
  assert.match(pdfDetail, /第 4 页没有文字，已跳过/);

  const doneSinglePpt = ui.importDoneMessage({ documents: [results[0].result] });
  assert.match(doneSinglePpt, /Week 2 Slides/);
  assert.match(doneSinglePpt, /第 3/);
  assert.match(doneSinglePpt, /第 1、2/);
  assert.match(doneSinglePpt, /主会话|agy CLI/);

  const doneMulti = ui.importDoneMessage({ documents: [results[0].result, results[1].result] });
  assert.match(doneMulti, /2 份/);
  assert.match(doneMulti, /未识别图片|仅图片/);

  const notes = ui.documentNotes({ warnings: [], hasImages: true, imagePages: [1, 2], skippedPages: [3] });
  assert.ok(notes.some((n) => /未识别图片/.test(n)), `expected unread image note, got ${JSON.stringify(notes)}`);

  const pdfDetailHtml = renderToStaticMarkup(h(
    ui.StudyServicesContext.Provider,
    { value: { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop } },
    h(ui.PdfDetail, { job: { id: 'j1', status: 'complete', imagePages: [2, 5], skippedPages: [3] } }),
  ));
  assert.match(stripHtml(pdfDetailHtml), /第 2、5 页含未识别图片/);
  assert.match(stripHtml(pdfDetailHtml), /第 3 页仅含图片/);

  // English translations: zero Han characters
  ui.setUiLanguage('en');
  try {
    assert.doesNotMatch(ui.itemDetail(results[0]), han);
    assert.doesNotMatch(ui.itemDetail(results[1]), han);
    assert.doesNotMatch(ui.importDoneMessage({ documents: [results[0].result] }), han);
    assert.doesNotMatch(ui.importDoneMessage({ documents: [results[0].result, results[1].result] }), han);
    for (const note of ui.documentNotes({ warnings: [], hasImages: true, imagePages: [1, 2], skippedPages: [3] })) {
      assert.doesNotMatch(note, han);
    }
    const enPdfDetail = renderToStaticMarkup(h(
      ui.StudyServicesContext.Provider,
      { value: { call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop } },
      h(ui.PdfDetail, { job: { id: 'j1', status: 'complete', imagePages: [2, 5], skippedPages: [3] } }),
    ));
    assert.doesNotMatch(stripHtml(enPdfDetail), han);
  } finally {
    ui.setUiLanguage('zh');
  }
});

test('ReadingSections renders inline unread-image notice, legacy [Figure] fallback, skipped-page notice in order, and Desktop agy CLI handoff', async () => {
  const sources = [
    { id: 'p1', title: 'Doc · p.1', text: 'Intro paragraph.\n\n[Figure]', document: { page: 1 } },
    { id: 'p3', title: 'Doc · p.3', text: 'Chart summary paragraph.', document: { page: 3, hasImages: true, omittedVisuals: ['chart', 'smartart'] } },
  ];
  const sections = ui.readingSections({ paged: true, sources });
  const bySourceId = new Map(sources.map((s) => [s.id, { hasImages: s.document?.hasImages, omittedVisuals: s.document?.omittedVisuals, text: s.text }]));
  const desktopServices = {
    call: async () => ({}),
    act: async () => undefined,
    busy: false,
    notify: noop,
    askInChat: async () => 'copied',
    host: { capabilities: { edition: 'desktop', chat: false } },
    openSettings: noop,
    navigate: noop,
    openModal: noop,
  };

  for (const lang of ['zh', 'en']) {
    ui.setUiLanguage(lang);
    try {
      const html = renderToStaticMarkup(h(
        ui.StudyServicesContext.Provider,
        { value: desktopServices },
        h(ui.ReadingSections, {
          sections,
          labelOf: (s) => (lang === 'zh' ? `第 ${s.page} 页` : `Page ${s.page}`),
          unreadImages: {
            title: 'Course Slides',
            format: 'pptx',
            canRenderImage: false,
            bySourceId,
            skippedPages: [2],
          },
        }),
      ));

      // Skipped page 2 sits between page 1 and page 3
      const idx1 = html.indexOf('data-study-page="1"');
      const idx2 = html.indexOf('data-skipped-page="2"');
      const idx3 = html.indexOf('data-study-page="3"');
      assert.ok(idx1 >= 0 && idx2 > idx1 && idx3 > idx2, 'skipped page 2 is interleaved between page 1 and page 3');

      // All 3 affected pages (legacy [Figure] p1, skipped p2, omittedVisuals p3) have quick reader.page handoff buttons
      const handOffMatches = html.match(/data-hand-off="reader\.page"/g) || [];
      assert.equal(handOffMatches.length, 3, 'every unread-image / skipped page has a quick reader.page handoff button');

      // Inline notices are marked data-study-marker and data-find-skip so offsets/find are untouched
      assert.match(html, /data-skipped-page="2"[^>]*data-study-marker="true"/);

      const text = stripHtml(html);
      if (lang === 'zh') {
        assert.match(text, /复制给 agy CLI/);
        assert.match(text, /第 2 张幻灯片仅含图片或没有可读文字，已跳过/);
        assert.match(text, /图表/);
        assert.match(text, /SmartArt/);
      } else {
        assert.match(text, /Copy for agy CLI/);
        assert.match(text, /Slide 2/);
        assert.doesNotMatch(text, han, 'English ReadingSections unread-image notices have zero Han characters');
      }
    } finally {
      ui.setUiLanguage('zh');
    }
  }
});

test('DocumentViewer wires unread-image & skipped-page notices and stages PDF page image on Desktop click', async () => {
  const { React: R, mount, exports: m } = interactive;
  await withTempDir('study-viewer-unread-', async (workspaceDir) => {
    await withBrowserGlobals(async () => {
      m.setUiLanguage('zh');
      const sent = [];
      const doc = {
        documentId: 'doc-1',
        id: 'doc-1',
        revision: 'r1',
        format: 'pdf',
        title: 'Algorithms',
        filename: 'Algorithms.pdf',
        originalAvailable: false,
        original: { mode: null, status: 'none' },
        skippedPages: [2],
        imagePages: [1],
        sources: [
          { id: 's1', title: 'Algorithms · p.1', text: 'Sorting tree diagram.', document: { page: 1, totalPages: 3, hasImages: true } },
          { id: 's3', title: 'Algorithms · p.3', text: 'Conclusion text only.', document: { page: 3, totalPages: 3 } },
        ],
      };
      const call = async (action, payload) => {
        if (action === 'materials.document.get') return doc;
        if (action === 'materials.links.list') return { links: [] };
        if (action === 'materials.annotation.list') return { items: [], stale: [] };
        if (action === 'runtime.capabilities') return [];
        if (action === 'snapshot') return { decks: [], settings: {} };
        if (action === 'focus.images.stage') return stageFocusImages(workspaceDir, payload);
        return {};
      };
      const dshUnsupportedHost = { capabilities: { chat: true }, chatTakesPictures: async () => false };
      const services = {
        call,
        act: async () => undefined,
        busy: false,
        notify: noop,
        askInChat: async (prompt, options) => { sent.push({ prompt, options }); return 'filled'; },
        host: dshUnsupportedHost,
        openSettings: noop,
        navigate: noop,
        openModal: noop,
      };
      const toast = { show: noop, error: noop, dismiss: noop };
      const mounted = mount(() => R.createElement(
        m.ToastContext.Provider,
        { value: toast },
        R.createElement(
          m.StudyServicesContext.Provider,
          { value: services },
          R.createElement(m.DocumentViewer, {
            source: doc.sources[0],
            call,
            data: { sources: doc.sources, decks: [], settings: {} },
            host: dshUnsupportedHost,
          }),
        ),
      ));
      try {
        await mounted.flush(10);
        const text = mounted.text();
        assert.match(text, /这一页里的图片或图表没有读进来/, 'page 1 shows unread-image inline notice');
        assert.match(text, /第 2 页仅含图片或没有可读文字，已跳过/, 'skipped page 2 shows inline notice');
        assert.match(text, /当前主会话模型不支持看图/, 'DSH vision-unsupported warning shown upfront before click');
        const handOffBtns = mounted.findAll((node) => node.type === 'button' && node.props?.['data-hand-off'] === 'reader.page');
        assert.equal(handOffBtns.length, 2, 'page 1 and skipped page 2 each have a quick reader.page handoff button');
        await mounted.act(() => click(handOffBtns[1]));
        assert.equal(sent.length, 1);
        assert.match(sent[0].prompt, /第 2 页/);
        assert.match(sent[0].prompt, /没有保存的文字/);
      } finally {
        mounted.unmount();
      }
    });
  });
});
