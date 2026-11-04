import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { stageFocusImages } from '../lib/focus-image-stage.js';
import { PDFDocument } from 'pdf-lib';
import { StudyService } from '../lib/service.js';

const ui = await loadUi(`
  export {
    default as FocusIntakeDialog,
    prepareFocusImageHandOff,
    saveFocusIntake,
    buildPdfFileFromImages,
  } from './ui/FocusIntakeDialog.jsx';
  export { buildHomePlan } from './ui/study-map/home-plan.js';
  export { NextDue } from './ui/NextDue.jsx';
  export { default as ReviewToolbar } from './ui/ReviewToolbar.jsx';
  export { deliverToChat } from './ui/hand-off/use-hand-off.js';
  export { handOffText } from './ui/agent-prompts/index.js';
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const h = React.createElement;
const noop = () => {};
const han = /[\u3400-\u9fff]/;

// Valid 1x1 transparent PNG
const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const ONE_PIXEL_PNG_BYTES = Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64');
const ONE_PIXEL_DATA_URL = `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`;

function makePngFile(name = 'wechat-exam-scope.png') {
  const file = new File([ONE_PIXEL_PNG_BYTES], name, { type: 'image/png' });
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

const render = (element, language = 'zh', opts = {}) => {
  ui.setUiLanguage(language);
  try {
    return renderToStaticMarkup(inApp(ui, element, {
      call: async () => ({}),
      ...opts,
    }));
  } finally {
    ui.setUiLanguage('zh');
  }
};

const stripHtml = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('image-only intake with text-only model (e.g. DeepSeek): stages PNG in workspace, fills course.focus prompt, and NEVER attaches image to composer', async () => {
  await withTempDir('study-focus-deepseek-', async (workspaceDir) => {
    const pngFile = makePngFile('qq-focus-slide.png');
    const asked = [];
    const attached = [];
    const notices = [];

    const host = {
      chatTakesPictures: async () => false,
      askInChat: (text) => { asked.push(text); return 'filled'; },
      attachToChat: (files) => { attached.push(files); return true; },
      showChat: noop,
    };

    const call = async (method, payload) => {
      if (method === 'focus.images.stage') {
        return stageFocusImages(workspaceDir, payload);
      }
      throw new Error(`Unexpected RPC: ${method}`);
    };

    const input = await ui.prepareFocusImageHandOff({
      rawFiles: [pngFile],
      course: 'Operating Systems',
      notes: 'Red-boxed items are guaranteed; Chapter 9 is excluded',
      existingTopics: ['Page Table'],
      generateAfter: true,
      host,
      call,
    });

    assert.equal(input.attached, false);
    assert.equal(input.picture, undefined, 'must not pass picture payload when chat model is text-only');
    assert.equal(input.files.length, 1);
    assert.match(input.files[0], /^studyhub-work\/focus-intake\/.+\.png$/);

    const stagedBytes = await readFile(join(workspaceDir, input.files[0]));
    assert.deepEqual(stagedBytes, ONE_PIXEL_PNG_BYTES);

    const prompt = ui.handOffText('course.focus', input);
    assert.match(prompt, /Operating Systems/);
    assert.match(prompt, /studyhub-work\/focus-intake\//);
    assert.match(prompt, /MinerU|OCR|文字识别/);
    assert.match(prompt, /focusTopics/);
    assert.match(prompt, /generate/);

    const outcome = await ui.deliverToChat({
      host,
      prompt,
      said: '重点图片已存到工作区。',
      picture: input.picture,
      notify: (toast) => notices.push(toast),
      openSheet: noop,
      clipboard: { writeText: async () => {} },
    });

    assert.equal(outcome, 'filled');
    assert.equal(asked.length, 1);
    assert.deepEqual(attached, [], 'attachToChat must never be called for text-only models like DeepSeek');
    assert.match(notices[0].text, /重点图片已存到工作区/);
  });
});

test('image-only intake with vision model: stages PNG in workspace AND attaches File[] to composer', async () => {
  await withTempDir('study-focus-vision-', async (workspaceDir) => {
    const pngFile = makePngFile('whiteboard-focus.png');
    const order = [];
    const notices = [];

    const host = {
      chatTakesPictures: async () => true,
      stageFocusImages: async (rawFiles) => {
        const files = rawFiles.map((f) => ({ name: f.name, dataUrl: f.dataUrl }));
        return stageFocusImages(workspaceDir, { files });
      },
      askInChat: () => { order.push('text'); return 'filled'; },
      attachToChat: (files) => { order.push(['attach', files.length]); return true; },
      showChat: noop,
      noteInChat: noop,
    };

    const input = await ui.prepareFocusImageHandOff({
      rawFiles: [pngFile],
      course: 'Databases',
      notes: '',
      existingTopics: [],
      generateAfter: false,
      host,
      call: async () => { throw new Error('host.stageFocusImages should handle staging'); },
    });

    assert.equal(input.attached, true);
    assert.equal(input.picture?.wanted, 1);
    assert.equal(input.picture?.images?.length, 1);
    assert.match(input.files[0], /^studyhub-work\/focus-intake\/.+\.png$/);

    const prompt = ui.handOffText('course.focus', input);
    const outcome = await ui.deliverToChat({
      host,
      prompt,
      said: '',
      picture: input.picture,
      notify: (toast) => notices.push(toast),
      openSheet: noop,
      clipboard: { writeText: async () => {} },
    });

    assert.equal(outcome, 'filled');
    assert.deepEqual(order, ['text', ['attach', 1]]);
    assert.match(notices[0].text, /这一页的图也附上了/);
  });
});

test('buildPdfFileFromImages bundles focus screenshots into a valid multi-page PDF for local parsers', async () => {
  const f1 = makePngFile('slide-1.png');
  const f2 = makePngFile('slide-2.png');
  const pdfFile = await ui.buildPdfFileFromImages([f1, f2], 'Computer Networks');
  assert.equal(pdfFile.type, 'application/pdf');
  assert.match(pdfFile.name, /^Computer Networks-.*\.pdf$/);
  const rawBytes = new Uint8Array(await pdfFile.arrayBuffer());
  assert.match(Buffer.from(rawBytes.subarray(0, 8)).toString('latin1'), /^%PDF-1\./);
  const loadedPdf = await PDFDocument.load(rawBytes);
  assert.equal(loadedPdf.getPageCount(), 2);
});

test('text / AI focus extraction and saveFocusIntake persist focusTopics + guidance material into course', async () => {
  await withTempDir('study-focus-save-', async (rootDir) => {
    const service = new StudyService(rootDir);
    try {
    const rawScope = [
      '期末复习重点：',
      '1. MVCC 与快照隔离（必考大题）',
      '2. B+ 树分裂与合并边界条件',
      '3. WAL 崩溃恢复 ARIES 三阶段',
    ].join('\n');

    const extracted = await service.call('focus.extract', {
      course: 'Databases',
      text: rawScope,
    });
    assert.equal(extracted.source, 'local');
    assert.deepEqual(extracted.topics, [
      'MVCC 与快照隔离（必考大题）',
      'B+ 树分裂与合并边界条件',
      'WAL 崩溃恢复 ARIES 三阶段',
    ]);

    let savedOutcome = null;
    await ui.saveFocusIntake({
      course: 'Databases',
      topics: extracted.topics,
      rawText: rawScope,
      saveAsMaterial: true,
      courseRecord: null,
      call: (method, payload) => service.call(method, payload),
      act: async (method, payload, onDone) => {
        const res = await service.call(method, payload);
        onDone?.(res);
        return res;
      },
      onSaved: (outcome) => { savedOutcome = outcome; },
    });

    assert.ok(savedOutcome);
    assert.equal(savedOutcome.course, 'Databases');
    assert.equal(savedOutcome.count, 3);

    const coursesRes = await service.call('course.list', {});
    const dbCourse = coursesRes.courses.find((c) => c.name === 'Databases');
    assert.ok(dbCourse, 'Databases course created');
    assert.deepEqual(dbCourse.focusTopics, extracted.topics);
    assert.equal(dbCourse.guidanceSourceIds.length, 1, 'raw highlight notes saved as guidance material');
    } finally {
      service.dispose();
    }
  });
});

test('buildHomePlan offers 只练重点 when today.focusTotal > 0 and omits it when 0', () => {
  const started = [];
  const baseData = {
    decks: [{ id: 'd1', title: 'OS Deck', course: 'Operating Systems' }],
    sources: [{ id: 's1', title: 'OS Notes' }],
    drafts: [],
    focus: { mode: 'class', course: 'Operating Systems', fresh: [], route: null },
  };
  const actions = {
    start: (args) => started.push(args),
    resume: noop,
    openDraft: noop,
    addSource: noop,
    importLibrary: noop,
    generateFromSources: noop,
  };

  const withFocus = ui.buildHomePlan({
    data: baseData,
    today: { course: 'Operating Systems', scope: [], total: 8, due: 4, weak: 2, new: 2, focusTotal: 5, more: 0, elsewhere: 0, ahead: false },
    runs: [],
    runFor: () => null,
    activeJobs: [],
    inFocus: true,
    actions,
    revealActivity: noop,
  });

  const focusEntry = withFocus.plan.also.find(([label]) => String(label).includes('只练重点'));
  assert.ok(focusEntry, 'expected 只练重点 link in plan.also');
  assert.equal(focusEntry[0], '只练重点 · 5 题');
  focusEntry[1]();
  assert.deepEqual(started.at(-1), {
    mode: 'path',
    course: 'Operating Systems',
    focusOnly: true,
    fresh: true,
  });

  const withoutFocus = ui.buildHomePlan({
    data: baseData,
    today: { course: 'Operating Systems', scope: [], total: 4, due: 2, weak: 0, new: 2, focusTotal: 0, more: 0, elsewhere: 0, ahead: false },
    runs: [],
    runFor: () => null,
    activeJobs: [],
    inFocus: true,
    actions,
    revealActivity: noop,
  });
  assert.equal(
    withoutFocus.plan.also.some(([label]) => String(label).includes('只练重点')),
    false,
    'must omit 只练重点 when focusTotal is 0',
  );
});

test('FocusIntakeDialog, NextDue, and ReviewToolbar render cleanly in Chinese and English with zero leaked Han in English', () => {
  const data = {
    courses: [{ id: 'c-os', name: 'Operating Systems', focusTopics: ['Virtual Memory', 'Page Faults'] }],
    focus: { course: 'Operating Systems', courses: [{ id: 'c-os', name: 'Operating Systems', count: 2, active: true }] },
    sources: [{ id: 's-1', title: 'Lecture 07 Slides', text: 'Virtual memory and page replacement', courses: ['Operating Systems'] }],
  };

  const zhImageHtml = render(h(ui.FocusIntakeDialog, { data, initialCourse: 'Operating Systems', initialTab: 'image', onClose: noop }), 'zh');
  assert.match(stripHtml(zhImageHtml), /录入课程重点/);
  assert.match(stripHtml(zhImageHtml), /已有 2 个重点知识点/);
  assert.match(stripHtml(zhImageHtml), /合成 PDF 用本机解析/);

  const zhTextHtml = render(h(ui.FocusIntakeDialog, { data, initialCourse: 'Operating Systems', initialTab: 'text', onClose: noop }), 'zh');
  assert.match(stripHtml(zhTextHtml), /识别为重点条目/);
  assert.match(stripHtml(zhTextHtml), /AI 提炼重点/);
  assert.match(stripHtml(zhTextHtml), /Virtual Memory/);

  const enImageHtml = render(h(ui.FocusIntakeDialog, { data, initialCourse: 'Operating Systems', initialTab: 'image', onClose: noop }), 'en');
  assert.match(stripHtml(enImageHtml), /Add course exam focus/);
  assert.match(stripHtml(enImageHtml), /Combine into PDF for local parser/);
  assert.doesNotMatch(enImageHtml, han, 'English image tab must contain zero Han characters');

  const enTextHtml = render(h(ui.FocusIntakeDialog, { data, initialCourse: 'Operating Systems', initialTab: 'text', onClose: noop }), 'en');
  assert.match(stripHtml(enTextHtml), /Extract focus with AI/);
  assert.match(stripHtml(enTextHtml), /Save focus/);
  assert.doesNotMatch(enTextHtml, han, 'English text tab must contain zero Han characters');

  const zhDue = render(h(ui.NextDue, { feedback: { correct: true, level: 'learning', nextDue: '2026-11-06T00:00:00Z', focusScheduled: true } }), 'zh');
  assert.match(stripHtml(zhDue), /重点加密复习/);
  const enDue = render(h(ui.NextDue, { feedback: { correct: true, level: 'learning', nextDue: '2026-11-06T00:00:00Z', focusScheduled: true } }), 'en');
  assert.match(stripHtml(enDue), /High-frequency focus review/);
  assert.doesNotMatch(enDue, han);

  const zhToolbar = render(h(ui.ReviewToolbar, {
    run: { index: 0, total: 3, mode: 'review', card: { id: 'k1', focus: true }, feedback: { correct: true } },
    onToggleFocus: noop,
    onNote: noop,
    onImprove: noop,
    onSlay: noop,
    onReviewAction: noop,
    moreDefaultOpen: true,
  }), 'zh');
  assert.match(zhToolbar, /取消重点标记|标为重点|question-toolbar/);

  const enToolbar = render(h(ui.ReviewToolbar, {
    run: { index: 0, total: 3, mode: 'review', card: { id: 'k1', focus: false }, feedback: { correct: true } },
    onToggleFocus: noop,
    onNote: noop,
    onImprove: noop,
    onSlay: noop,
    onReviewAction: noop,
  }), 'en');
  assert.doesNotMatch(enToolbar, han);
});
