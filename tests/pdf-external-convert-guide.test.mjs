import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { click, loadInteractiveUi, textOf, withBrowserGlobals } from './helpers/react-harness.mjs';
import { TOOLS } from '../lib/large-documents.js';
import {
  EXTERNAL_PDF_GUIDE_TITLE,
  EXTERNAL_PDF_IMPORT_TITLE,
  EXTERNAL_PDF_PRIVACY_NOTICE,
  EXTERNAL_PDF_TOOL_URLS,
  EXTERNAL_PDF_TOOLS,
} from '../ui/pdf-external-guide.js';

/* Behavioral regression tests for #1765:
   - External PDF conversion reference links sourced from lib/large-documents.js TOOLS (plain copyable text, no cloud API / baseUrl / API Key)
   - Explicit privacy & non-guarantee notice
   - 3-step post-conversion import guide (verified formats + live limits + <code><!-- page: N --></code>, import entry, 3 failure modes)
   - PdfDetail shows the guide ONLY for failed jobs (never while running or completed/done)
   - Interactive clipboard copy + fallback behavior when clipboard is unavailable or rejects
   - Documentation parity across docs/pdf-workflow.zh-CN.md and docs/pdf-workflow.md */

// Pinned expected URL list (intentionally independent of EXTERNAL_PDF_TOOL_URLS so dropping/changing any tool fails immediately).
const EXPECTED_URLS = Object.freeze([
  'https://www.paddleocr.ai',
  'https://github.com/datalab-to/marker',
  'https://github.com/docling-project/docling',
  'https://mathpix.com',
]);

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

const makeJob = (status = 'failed') => ({
  id: `job-ext-${status}`,
  type: 'pdf-convert',
  route: 'local',
  filename: 'Textbook.pdf',
  status,
  phase: status === 'running' ? 'local' : status === 'failed' ? 'local' : 'done',
  done: status === 'running' ? 40 : status === 'failed' ? 0 : 120,
  total: 120,
  env: { kind: 'local', mineruVersion: '4.0.10', tier: 'basic' },
});

function extractRenderedUrls(html) {
  return [...html.matchAll(/<code[^>]*class="pdf-ext-guide__url"[^>]*>([^<]+)<\/code>/g)].map(match => match[1]);
}

function assertExactPlainUrls(html, label) {
  const renderedUrls = extractRenderedUrls(html);
  assert.deepEqual(renderedUrls, EXPECTED_URLS, `${label}: renders the exact 4 pinned URLs in order`);
  for (const url of renderedUrls) {
    const parsed = new URL(url);
    assert.equal(parsed.protocol, 'https:', `${label}: ${url} uses https:`);
    assert.equal(parsed.search, '', `${label}: ${url} has no query parameters`);
    assert.equal(parsed.hash, '', `${label}: ${url} has no fragment`);
    assert.ok(!html.includes(`href="${url}"`), `${label}: does not render ${url} as an <a> link`);
  }
}

function assertGuideInZh(html, label) {
  assert.match(html, new RegExp(EXTERNAL_PDF_GUIDE_TITLE), `${label}: renders heading`);
  assert.match(html, new RegExp(EXTERNAL_PDF_PRIVACY_NOTICE), `${label}: renders privacy notice`);
  assert.match(html, /不内置调用/, `${label}: states no built-in invocation`);
  assert.match(html, /不代传文件/, `${label}: states no file proxying`);
  assert.match(html, /不承诺/, `${label}: states no availability guarantee`);
  assert.match(html, new RegExp(EXTERNAL_PDF_IMPORT_TITLE), `${label}: renders 3-step import title`);

  assertExactPlainUrls(html, label);
  assert.doesNotMatch(html, /mineru\.net|type="password"|baseUrl|api[\s_-]?key|云端/i, `${label}: zero cloud/key/baseUrl fields`);

  // Step 1: verified supported formats + dynamic limits + <!-- page: N --> inside <code> (no font ligature)
  for (const ext of ['.md', '.txt', '.tex', '.html', '.docx', '.pptx', '.ppt', '.pdf', '.json']) {
    assert.ok(html.includes(ext), `${label}: step 1 mentions real supported format ${ext}`);
  }
  assert.match(html, /<code[^>]*>&lt;!-- page: N --&gt;<\/code>/, `${label}: renders <!-- page: N --> inside <code>`);
  assert.match(html, /8 MB/, `${label}: displays live text/PDF size limit`);
  assert.match(html, /200 页/, `${label}: displays live PDF page limit`);
  assert.match(html, /600,000 字符/, `${label}: displays live selection char limit`);
  assert.match(html, /40 MB/, `${label}: displays live office/JSON size limit`);

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
  assertExactPlainUrls(html, label);
  assert.match(html, /<code[^>]*>&lt;!-- page: N --&gt;<\/code>/, `${label}: renders <!-- page: N --> inside <code> in English mode`);
  assert.match(html, /8 MB/, `${label}: English displays live text/PDF size limit`);
  assert.match(html, /200 pages/, `${label}: English displays live PDF page limit`);
  assert.match(html, /600,000 characters/, `${label}: English displays live selection char limit`);
  assert.match(html, /40 MB/, `${label}: English displays live office/JSON size limit`);
  assert.match(html, /Missing formulas/, `${label}: English step 3 covers missing formulas`);
  assert.match(html, /Scanned pages remain images/, `${label}: English step 3 covers image-only scans`);
  assert.match(html, /Non-UTF-8 encoding/, `${label}: English step 3 covers non-UTF-8 encoding`);
}

test('external tool list is derived from lib/large-documents.js TOOLS and matches the pinned canonical HTTPS URLs', () => {
  assert.deepEqual(EXTERNAL_PDF_TOOL_URLS, EXPECTED_URLS);
  for (const tool of EXTERNAL_PDF_TOOLS) {
    const canonical = TOOLS.find(entry => entry.id === tool.id);
    assert.ok(canonical, `${tool.id} exists in lib/large-documents.js TOOLS`);
    assert.equal(tool.name, canonical.name, `${tool.id} reuses canonical name from TOOLS`);
    assert.ok(canonical.channels.some(ch => ch.url === tool.url), `${tool.id} URL comes from TOOLS.channels`);
  }
});

test('PdfConversion, failed PdfDetail (PdfConvertJob), and MineruPane render the shared external guide once without cloud inputs (zh + en)', () => {
  const surfaces = [
    ['PdfConversion', h(mod.PdfConversion, { available: true, initialLocal: { state: 'ready', tier: 'basic' } })],
    ['PdfDetail (failed)', h(mod.PdfDetail, { job: makeJob('failed') })],
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

test('PdfDetail hides the external guide when job status is running, complete, or done', () => {
  for (const status of ['running', 'complete', 'done']) {
    const zh = render(h(mod.PdfDetail, { job: makeJob(status) }), 'zh');
    assert.doesNotMatch(zh, /data-pdf-external-guide/, `PdfDetail (${status}): does not render external guide`);
    assert.doesNotMatch(zh, new RegExp(EXTERNAL_PDF_GUIDE_TITLE), `PdfDetail (${status}): does not render guide title`);

    const en = render(h(mod.PdfDetail, { job: makeJob(status) }), 'en');
    assert.doesNotMatch(en, /data-pdf-external-guide/, `PdfDetail (${status}, en): does not render external guide`);
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
          const langCopied = [];
          for (const tool of EXTERNAL_PDF_TOOLS) {
            const btn = mounted.find(node => node.type === 'button' && node.props?.['data-copy-tool'] === tool.id);
            assert.ok(btn, `${lang}: copy button renders for ${tool.id}`);
            assert.ok(btn.props.className.includes('sh-btn'), `${lang}: uses shared Button primitive for ${tool.id}`);
            assert.equal(textOf(btn).trim(), idleLabel, `${lang}: initial label for ${tool.id}`);

            await mounted.act(async () => { await click(btn); });
            await mounted.flush();

            langCopied.push(copied.at(-1));
            assert.equal(copied.at(-1), tool.url, `${lang}: clipboard received exact canonical URL for ${tool.id}`);
            const updatedBtn = mounted.find(node => node.type === 'button' && node.props?.['data-copy-tool'] === tool.id);
            assert.equal(textOf(updatedBtn).trim(), doneLabel, `${lang}: shows copied feedback for ${tool.id}`);
          }
          assert.deepEqual(langCopied, EXPECTED_URLS, `${lang}: copied every pinned URL in order`);
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

test('docs/pdf-workflow.zh-CN.md and docs/pdf-workflow.md stay in sync with the pinned URLs, privacy notice, and 3-step guide', () => {
  const zhDoc = readFileSync('docs/pdf-workflow.zh-CN.md', 'utf8');
  const enDoc = readFileSync('docs/pdf-workflow.md', 'utf8');

  for (const url of EXPECTED_URLS) {
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
