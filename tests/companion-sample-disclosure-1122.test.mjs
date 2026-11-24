import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { SEA_BREEZE_SAMPLE_ID, buildSeaBreezePreview } from '../lib/companion/sample-sea-breeze.js';
import { LESSON_TEMPLATE_CSS } from '../lib/companion-template/template-styles.js';
import { loadUi } from './helpers/ui-module.mjs';

const CJK_RE = /[\u4e00-\u9fff]/;

const uiBundle = await loadUi(`
  export { setUiLanguage } from './ui/i18n.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { default as CompanionBuildDialog } from './ui/companions/CompanionBuildDialog.jsx';
  export { default as CourseCompanionsBar } from './ui/companions/CourseCompanionsBar.jsx';
  export { default as CompanionViewer } from './ui/companions/CompanionViewer.jsx';
`);

const {
  setUiLanguage,
  StudyServicesContext,
  AppContext,
  CompanionBuildDialog,
  CourseCompanionsBar,
  CompanionViewer,
} = uiBundle;

test('#1122-1: built-in Geography Sea & Land Breeze sample compiles cleanly in zh & en and never mutates the study library', async () => {
  const zh = buildSeaBreezePreview({ language: 'zh' });
  const en = buildSeaBreezePreview({ language: 'en' });
  assert.equal(zh.preview, true);
  assert.equal(zh.companion.id, SEA_BREEZE_SAMPLE_ID);
  assert.equal(zh.companion.sample, true);
  assert.ok(zh.html.includes('海陆风'), 'zh sample HTML covers sea & land breeze');
  assert.ok(zh.html.includes('比热容'), 'zh sample HTML covers specific heat capacity');
  assert.ok(zh.html.includes('等压面'), 'zh sample HTML covers isobaric surface tilt');
  assert.ok(zh.lesson.slideCount >= 7);
  assert.equal(en.preview, true);
  assert.ok(!CJK_RE.test(en.lesson.title), 'en sample title has zero Han');
  assert.ok(!CJK_RE.test(en.lesson.lead), 'en sample lead has zero Han');

  // Verify backend companion.get & companion.progress stay 100% read-only with zero store pollution
  const root = await mkdtemp(join(tmpdir(), 'study-1122-sample-'));
  try {
    const service = new StudyService(root);
    const before = await service.call('snapshot');
    assert.equal(before.sources.length, 0);
    assert.equal(before.decks.length, 0);
    assert.equal(before.courses.length, 0);

    const got = await service.call('companion.get', { id: SEA_BREEZE_SAMPLE_ID, language: 'zh' });
    assert.equal(got.preview, true);
    assert.equal(got.companion.id, SEA_BREEZE_SAMPLE_ID);
    assert.ok(got.html.length > 5000);

    const prog = await service.call('companion.progress', {
      id: SEA_BREEZE_SAMPLE_ID,
      slide: 7,
      slideTotal: 7,
      completed: true,
    });
    assert.equal(prog.preview, true);
    assert.equal(prog.saved, false);
    assert.equal(prog.firstPassCredited, 0);

    const after = await service.call('snapshot');
    assert.equal(after.sources.length, 0, 'previewing sample must not add sources');
    assert.equal(after.decks.length, 0, 'previewing sample must not add decks');
    assert.equal(after.courses.length, 0, 'previewing sample must not add courses');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('#1122-2: CompanionBuildDialog collapses advanced options by default and surfaces Geography Sea & Land Breeze sample preview in both zh & en', () => {
  const fakeStudy = {
    busy: false,
    call: () => new Promise(() => {}),
    act: async () => ({}),
    notify: () => {},
    openModal: () => {},
    openSettings: () => {},
  };
  const readyApp = {
    data: {
      focus: { course: '自然地理', courses: ['自然地理'] },
      courses: [{ id: 'c1', name: '自然地理', companions: [] }],
      sources: [],
      decks: [],
      settings: { modelReady: true },
      modelStatus: { ready: true, reason: 'ok', label: 'Mock' },
    },
    core: { refresh: () => {} },
  };

  setUiLanguage('zh');
  try {
    const dialogHtml = renderToStaticMarkup(
      React.createElement(StudyServicesContext.Provider, { value: fakeStudy },
        React.createElement(AppContext.Provider, { value: readyApp },
          React.createElement(CompanionBuildDialog, { modal: { course: '自然地理' }, onClose: () => {} }),
        ),
      ),
    );
    assert.ok(dialogHtml.includes('data-companion-sample-card=""'), 'dialog renders one-click sample card');
    assert.ok(dialogHtml.includes('一键预览示例：地理 · 海陆风'), 'dialog names Geography Sea & Land Breeze sample');
    // Advanced disclosure exists and is collapsed (no `open=""` attribute) on default build tab
    const advMatch = /<details[^>]*data-companion-advanced=""[^>]*>/.exec(dialogHtml);
    assert.ok(advMatch, 'dialog includes collapsible advanced options Disclosure');
    assert.ok(!/\bopen(?:="")?/.test(advMatch[0]), `advanced options must be collapsed by default, got: ${advMatch[0]}`);
    assert.ok(dialogHtml.includes('高级选项'));

    // Empty CourseCompanionsBar also surfaces one-click preview sample
    const barHtml = renderToStaticMarkup(
      React.createElement(StudyServicesContext.Provider, { value: fakeStudy },
        React.createElement(AppContext.Provider, { value: readyApp },
          React.createElement(CourseCompanionsBar, { course: '自然地理', data: readyApp.data }),
        ),
      ),
    );
    assert.ok(barHtml.includes('data-companion-sample-btn=""'), 'empty CourseCompanionsBar exposes one-click preview button');
    assert.ok(barHtml.includes('一键预览示例：地理 · 海陆风'));

    // CompanionViewer in preview mode renders read-only badge and keeps Ask Tutor hidden
    const previewState = buildSeaBreezePreview({ language: 'zh' });
    const viewerHtml = renderToStaticMarkup(
      React.createElement(StudyServicesContext.Provider, { value: fakeStudy },
        React.createElement(AppContext.Provider, { value: readyApp },
          React.createElement(CompanionViewer, {
            modal: { id: SEA_BREEZE_SAMPLE_ID, preview: true, openDrawer: true, initialState: previewState },
            onClose: () => {},
          }),
        ),
      ),
    );
    assert.ok(viewerHtml.includes('data-companion-preview-badge=""'), 'CompanionViewer renders preview badge');
    assert.ok(viewerHtml.includes('示例预览 · 不写入学习库'));
    assert.ok(!viewerHtml.includes('就当前页秒问导师'), 'preview drawer does not show library-writing Ask Tutor form');
  } finally {
    setUiLanguage('zh');
  }

  // English localization check: zero Han leaked in sample preview card, disclosure, bar, and viewer
  setUiLanguage('en');
  try {
    const enApp = {
      ...readyApp,
      data: {
        ...readyApp.data,
        focus: { course: 'Physical Geography', courses: ['Physical Geography'] },
        courses: [{ id: 'c1', name: 'Physical Geography', companions: [] }],
      },
    };
    const enDialog = renderToStaticMarkup(
      React.createElement(StudyServicesContext.Provider, { value: fakeStudy },
        React.createElement(AppContext.Provider, { value: enApp },
          React.createElement(CompanionBuildDialog, { modal: { course: 'Physical Geography' }, onClose: () => {} }),
        ),
      ),
    );
    assert.ok(!CJK_RE.test(enDialog), `English CompanionBuildDialog leaked Han: ${enDialog}`);
    assert.ok(enDialog.includes('Preview sample: Geography'));

    const enBar = renderToStaticMarkup(
      React.createElement(StudyServicesContext.Provider, { value: fakeStudy },
        React.createElement(AppContext.Provider, { value: enApp },
          React.createElement(CourseCompanionsBar, { course: 'Physical Geography', data: enApp.data }),
        ),
      ),
    );
    assert.ok(!CJK_RE.test(enBar), `English CourseCompanionsBar leaked Han: ${enBar}`);

    const enPreview = buildSeaBreezePreview({ language: 'en' });
    const enViewer = renderToStaticMarkup(
      React.createElement(StudyServicesContext.Provider, { value: fakeStudy },
        React.createElement(AppContext.Provider, { value: enApp },
          React.createElement(CompanionViewer, {
            modal: { id: SEA_BREEZE_SAMPLE_ID, preview: true, openDrawer: true, initialState: enPreview },
            onClose: () => {},
          }),
        ),
      ),
    );
    assert.ok(!CJK_RE.test(enViewer), `English preview CompanionViewer leaked Han: ${enViewer}`);
  } finally {
    setUiLanguage('zh');
  }
});

test('#1122-3: companion stage .top grid prevents narrow-width beats/tools overlap', () => {
  assert.match(
    LESSON_TEMPLATE_CSS,
    /\.top\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*auto\)\s+minmax\(0,\s*1fr\)\s+auto/,
    '.top uses minmax(0, auto) minmax(0, 1fr) auto so .beats scrolls instead of overlapping .top__tools',
  );
  assert.match(LESSON_TEMPLATE_CSS, /\.top__tools\s*\{[^}]*flex-shrink:\s*0/, '.top__tools never shrinks');
  assert.match(LESSON_TEMPLATE_CSS, /\.beats\s*\{[^}]*min-width:\s*0/, '.beats can shrink and scroll horizontally');
});
