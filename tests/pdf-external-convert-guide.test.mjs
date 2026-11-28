import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { click, loadInteractiveUi, textOf, withBrowserGlobals } from './helpers/react-harness.mjs';
import {
  EXTERNAL_PDF_GUIDE_TITLE,
  EXTERNAL_PDF_IMPORT_TITLE,
  EXTERNAL_PDF_PRIVACY_NOTICE,
  EXTERNAL_PDF_TOOL_URLS,
  EXTERNAL_PDF_TOOLS,
} from '../ui/pdf-external-guide.js';

/* Behavioral regression tests for #1765:
   - External PDF conversion reference links (plain copyable text, no cloud API / baseUrl / API Key)
   - Explicit privacy & non-guarantee notice
   - 3-step post-conversion import guide (verified formats, import entry, 3 failure modes)
   - Interactive clipboard copy + fallback behavior when clipboard is unavailable or rejects
   - Documentation parity across docs/pdf-workflow.zh-CN.md and docs/pdf-workflow.md */

const mod = await loadUi(`
  export { default as PdfExternalConvertGuide } from './ui/PdfExternalConvertGuide.jsx';
  export { default as PdfConversion } from './ui/PdfConversion.jsx';
  export { PdfDetail } from './ui/PdfConvertJob.jsx';
  export { default as MineruPane } from './ui/settings/MineruPane.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const h = React.createElement;
const HAN = /[\u3400-\u9fff]/;
const noop = () => {};
const services = { call: async () => ({}), act: async () => ({}), busy: false, notify: noop, askInChat: noop, host: { capabilities: { edition: 'dsh', chat: true } }, openSettings: noop, navigate: noop, openModal: noop };

function render(element, language = 'zh') {
  mod.setUiLanguage(language);
  try {
    return renderToStaticMarkup(h(mod.StudyServicesContext.Provider, { value: services }, element));
  } finally {
    mod.setUiLanguage('zh');
  }
}

const sampleJob = {
  id: 'job-ext-1',
  type: 'pdf-convert',
  route: 'local',
  filename: 'Textbook.pdf',
  status: 'failed',
  phase: 'local',
  done: 0,
  total: 120,
  env: { kind: 'local', mineruVersion: '4.0.10', tier: 'basic' },
};

function assertGuideInZh(html, label) {
  assert.match(html, new RegExp(EXTERNAL_PDF_GUIDE_TITLE), `${label}: renders heading`);
  assert.match(html, new RegExp(EXTERNAL_PDF_PRIVACY_NOTICE), `${label}: renders privacy notice`);
  assert.match(html, /不内置调用/, `${label}: states no built-in invocation`);
  assert.match(html, /不代传文件/, `${label}: states no file proxying`);
  assert.match(html, /不承诺/, `${label}: states no availability guarantee`);
  assert.match(html, new RegExp(EXTERNAL_PDF_IMPORT_TITLE), `${label}: renders 3-step import title`);

  // 3-4 legitimate plain copyable URLs inside <code>, NOT anchor links or defunct MinerU cloud.
  assert.ok(EXTERNAL_PDF_TOOLS.length >= 3 && EXTERNAL_PDF_TOOLS.length <= 4, 'canonical list has 3-4 tools');
  for (const url of EXTERNAL_PDF_TOOL_URLS) {
    assert.ok(html.includes(`>${url}</code>`), `${label}: renders ${url} as plain copyable <code>`);
    assert.ok(!html.includes(`href="${url}"`), `${label}: does not render ${url} as an <a> link`);
  }
  assert.doesNotMatch(html, /mineru\.net|type="password"|baseUrl|api[\s_-]?key|云端/i, `${label}: zero cloud/key/baseUrl fields`);

  // Step 1: verified supported formats from lib/contexts/materials/files.js
  for (const ext of ['.md', '.txt', '.tex', '.html', '.docx', '.pptx', '.ppt', '.pdf', '.json']) {
    assert.ok(html.includes(ext), `${label}: step 1 mentions real supported format ${ext}`);
  }
  // Step 2: real import entry labels
  assert.match(html, /资料/, `${label}: step 2 mentions Sources page`);
  assert.match(html, /添加资料/, `${label}: step 2 mentions Add source button`);
  assert.match(html, /选择文件/, `${label}: step 2 mentions Choose files`);
  // Step 3: all 3 common failure cases
  assert.match(html, /公式丢失/, `${label}: step 3 covers missing formulas`);
  assert.match(html, /扫描版仍是图片/, `${label}: step 3 covers image-only scanned PDF`);
  assert.match(html, /编码不是 UTF-8/, `${label}: step 3 covers non-UTF-8 encoding`);
  assert.match(html, /另存为 UTF-8/, `${label}: step 3 gives UTF-8 fix`);
}

function assertGuideInEn(html, label) {
  assert.doesNotMatch(html, HAN, `${label}: zero Chinese characters in English mode`);
  assert.doesNotMatch(html, /\bcloud\b/i, `${label}: zero mention of cloud in English mode`);
  assert.match(html, /Want to convert with an external tool\?/, `${label}: renders English heading`);
  assert.match(html, /Uploading files to a third-party service is strictly between you and that service; StudyHub does not handle or store them\./, `${label}: renders English privacy notice`);
  assert.match(html, /How to import after conversion/, `${label}: renders English 3-step import title`);
  for (const url of EXTERNAL_PDF_TOOL_URLS) {
    assert.ok(html.includes(`>${url}</code>`), `${label}: renders ${url} in English mode`);
    assert.ok(!html.includes(`href="${url}"`), `${label}: no anchor link for ${url} in English mode`);
  }
  assert.match(html, /Missing formulas/, `${label}: English step 3 covers missing formulas`);
  assert.match(html, /Scanned pages remain images/, `${label}: English step 3 covers image-only scans`);
  assert.match(html, /Non-UTF-8 encoding/, `${label}: English step 3 covers non-UTF-8 encoding`);
}

test('PdfConversion, PdfDetail (PdfConvertJob), and MineruPane all render the shared external guide once without cloud inputs (zh + en)', () => {
  const surfaces = [
    ['PdfConversion', h(mod.PdfConversion, { available: true, initialLocal: { state: 'ready', tier: 'basic' } })],
    ['PdfDetail', h(mod.PdfDetail, { job: sampleJob })],
    ['MineruPane (routes on)', h(mod.MineruPane, { capabilities: { audio: true } })],
    ['MineruPane (routes off)', h(mod.MineruPane, { capabilities: { audio: false } })],
  ];
  for (const [label, element] of surfaces) {
    const zh = render(element, 'zh');
    assert.equal((zh.match(/data-pdf-external-guide=/g) || []).length, 1, `${label}: renders guide exactly once`);
    assertGuideInZh(zh, label);

    const en = render(element, 'en');
    assert.equal((en.match(/data-pdf-external-guide=/g) || []).length, 1, `${label} (en): renders guide exactly once`);
    assertGuideInEn(en, label);
  }
});

test('interactive copy button writes the exact URL to clipboard and shows copied feedback (zh + en)', async () => {
  const ui = await loadInteractiveUi(`
    export { default as PdfExternalConvertGuide } from './ui/PdfExternalConvertGuide.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  await withBrowserGlobals(async () => {
    const copied = [];
    const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { clipboard: { writeText: async (text) => { copied.push(text); } } },
    });
    try {
      for (const [lang, idleLabel, doneLabel] of [['zh', '复制链接', '已复制'], ['en', 'Copy link', 'Copied']]) {
        ui.exports.setUiLanguage(lang);
        const mounted = ui.mount(() => ui.React.createElement(ui.exports.PdfExternalConvertGuide, { defaultOpen: true }));
        try {
          for (const tool of EXTERNAL_PDF_TOOLS) {
            const btn = mounted.find(node => node.type === 'button' && node.props?.['data-copy-tool'] === tool.id);
            assert.ok(btn, `${lang}: copy button renders for ${tool.id}`);
            assert.ok(btn.props.className.includes('sh-btn'), `${lang}: uses shared Button primitive for ${tool.id}`);
            assert.equal(textOf(btn).trim(), idleLabel, `${lang}: initial label for ${tool.id}`);

            await mounted.act(async () => { await click(btn); });
            await mounted.flush();

            assert.equal(copied.at(-1), tool.url, `${lang}: clipboard received exact canonical URL for ${tool.id}`);
            const updatedBtn = mounted.find(node => node.type === 'button' && node.props?.['data-copy-tool'] === tool.id);
            assert.equal(textOf(updatedBtn).trim(), doneLabel, `${lang}: shows copied feedback for ${tool.id}`);
          }
        } finally {
          mounted.unmount();
        }
      }
    } finally {
      ui.exports.setUiLanguage('zh');
      if (prevNavigator) Object.defineProperty(globalThis, 'navigator', prevNavigator);
      else delete globalThis.navigator;
    }
  });
});

test('clipboard unavailable or rejecting falls back gracefully without throwing and shows manual-copy hint', async () => {
  const ui = await loadInteractiveUi(`
    export { default as PdfExternalConvertGuide } from './ui/PdfExternalConvertGuide.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  await withBrowserGlobals(async () => {
    const scenarios = [
      ['missing clipboard API', {}],
      ['rejected writeText', { clipboard: { writeText: async () => { throw new Error('permission denied'); } } }],
    ];
    for (const [name, navValue] of scenarios) {
      const prevNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: navValue });
      try {
        ui.exports.setUiLanguage('zh');
        const mounted = ui.mount(() => ui.React.createElement(ui.exports.PdfExternalConvertGuide, { defaultOpen: true }));
        try {
          const first = EXTERNAL_PDF_TOOLS[0];
          const btn = mounted.find(node => node.type === 'button' && node.props?.['data-copy-tool'] === first.id);
          assert.ok(btn, `${name}: button present`);
          await mounted.act(async () => { await click(btn); });
          await mounted.flush();

          const updatedBtn = mounted.find(node => node.type === 'button' && node.props?.['data-copy-tool'] === first.id);
          assert.equal(textOf(updatedBtn).trim(), '复制链接', `${name}: does not falsely claim copied`);
          const hint = mounted.find(node => typeof node.props?.className === 'string' && node.props.className.includes('pdf-ext-guide__copy-error'));
          assert.ok(hint, `${name}: renders inline manual-copy fallback hint`);
          assert.match(textOf(hint), /无法自动复制，请直接选中上方链接手动复制。/);
        } finally {
          mounted.unmount();
        }
      } finally {
        ui.exports.setUiLanguage('zh');
        if (prevNavigator) Object.defineProperty(globalThis, 'navigator', prevNavigator);
        else delete globalThis.navigator;
      }
    }
  });
});

test('docs/pdf-workflow.zh-CN.md and docs/pdf-workflow.md stay in sync with the canonical URLs, privacy notice, and 3-step guide', () => {
  const zhDoc = readFileSync('docs/pdf-workflow.zh-CN.md', 'utf8');
  const enDoc = readFileSync('docs/pdf-workflow.md', 'utf8');

  for (const url of EXTERNAL_PDF_TOOL_URLS) {
    assert.ok(zhDoc.includes(`\`${url}\``), `zh doc lists plain-text URL ${url}`);
    assert.ok(enDoc.includes(`\`${url}\``), `en doc lists plain-text URL ${url}`);
  }
  assert.ok(zhDoc.includes(EXTERNAL_PDF_GUIDE_TITLE), 'zh doc includes guide heading');
  assert.ok(zhDoc.includes(EXTERNAL_PDF_PRIVACY_NOTICE), 'zh doc includes exact privacy notice');
  assert.ok(zhDoc.includes(EXTERNAL_PDF_IMPORT_TITLE), 'zh doc includes 3-step import heading');
  assert.match(zhDoc, /公式丢失/);
  assert.match(zhDoc, /扫描版仍是图片/);
  assert.match(zhDoc, /编码不是 UTF-8/);

  assert.ok(enDoc.includes('Want to convert with an external tool?'), 'en doc includes guide heading');
  assert.ok(enDoc.includes('Uploading files to a third-party service is strictly between you and that service; StudyHub does not handle or store them.'), 'en doc includes privacy notice');
  assert.ok(enDoc.includes('How to import after conversion'), 'en doc includes 3-step import heading');
  assert.match(enDoc, /Missing formulas/);
  assert.match(enDoc, /Scanned pages remain images/);
  assert.match(enDoc, /Non-UTF-8 encoding/);
});
