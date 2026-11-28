import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { click, loadInteractiveUi, textOf, withBrowserGlobals } from './helpers/react-harness.mjs';
import { LARGE_DOCUMENT_LIMITS, TOOLS } from '../lib/large-documents.js';
import { MAX_OFFICE_BYTES, MAX_TEXT_DOCUMENT_BYTES, megabytes } from '../lib/office/limits.js';
import { detectConvertedFormat, parseConvertedDocument } from '../lib/converted-document.js';
import {
  EXTERNAL_PDF_GUIDE_TITLE,
  EXTERNAL_PDF_IMPORT_TITLE,
  EXTERNAL_PDF_PRIVACY_NOTICE,
  EXTERNAL_PDF_TOOL_IDS,
  EXTERNAL_PDF_TOOL_URLS,
  EXTERNAL_PDF_TOOLS,
} from '../ui/pdf-external-guide.js';

/* The four addresses the owner approved for #1765 (#1778 review): official pages, plain text, no tracking parameters. A change to this list is a decision, so it is
   pinned here by value; hosts are the allow-list a future edit has to widen on purpose. */
const PINNED_URLS = [
  'https://www.paddleocr.ai',
  'https://mineru.net/OpenSourceTools/Extractor',
  'https://github.com/docling-project/docling',
  'https://mathpix.com',
];
const ALLOWED_HOSTS = ['www.paddleocr.ai', 'mineru.net', 'github.com', 'mathpix.com'];
/* MinerU's web parser is the one mineru.net address the guide may print (#1778, owner 2026-11-28): a link to a web page. Within the guide's own markup nothing
   else may name mineru.net or ask for a key, token or base URL. Only the guide is checked: the PDF panel and Settings around it may offer routes of their own. */
const MINERU_WEB_URL = 'https://mineru.net/OpenSourceTools/Extractor';


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
  export { ui, uiFormat, setUiLanguage } from './ui/i18n.js';
  export { PAGE_MARKER, toolMetaLine } from './ui/converter-lines.jsx';
  export { PaddleOcrOption } from './ui/LargeDocumentCard.jsx';
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

/* PdfDetail sits in the workspace's first load, so its guide arrives with a chunk of its own (ui/pdf-external-guide-lazy.jsx): the first render of a failed job
   draws nothing there and asks for the chunk, as on the page; once it has arrived every render draws the guide at once. */
assert.equal((render(h(mod.PdfDetail, { job: sampleJob })).match(/data-pdf-external-guide=/g) || []).length, 0, 'the guide is not drawn before its chunk arrives');
await new Promise(resolve => setImmediate(resolve));

/** The guide's own markup inside a surface: the element carrying data-pdf-external-guide, with everything nested in it. */
function guideMarkup(html) {
  const at = html.indexOf('data-pdf-external-guide');
  assert.ok(at >= 0, 'the guide is on this surface');
  const start = html.lastIndexOf('<', at);
  const tag = /^<([a-z0-9]+)/i.exec(html.slice(start))[1];
  const pattern = new RegExp(`<${tag}[\\s>]|</${tag}>`, 'gi');
  pattern.lastIndex = start;
  let depth = 0;
  for (let match; (match = pattern.exec(html));) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return html.slice(start, match.index + match[0].length);
  }
  throw new Error(`unclosed <${tag}> around the guide`);
}

const rendered = html => [...html.matchAll(/<code[^>]*class="pdf-ext-guide__url"[^>]*>([^<]*)<\/code>/g)].map(match => match[1]);
/** The page marker as rendered: escaped, inside <code>, kept out of machine translation. */
const MARKER_CODE = `<code translate="no">${mod.PAGE_MARKER.replace('<', '&lt;').replace('>', '&gt;')}</code>`;

function assertGuideInZh(html, label) {
  assert.match(html, new RegExp(EXTERNAL_PDF_GUIDE_TITLE), `${label}: renders heading`);
  assert.match(html, new RegExp(EXTERNAL_PDF_PRIVACY_NOTICE), `${label}: renders privacy notice`);
  assert.match(html, /不内置调用/, `${label}: states no built-in invocation`);
  assert.match(html, /不代传文件/, `${label}: states no file proxying`);
  assert.match(html, /不承诺/, `${label}: states no availability guarantee`);
  assert.match(html, new RegExp(EXTERNAL_PDF_IMPORT_TITLE), `${label}: renders 3-step import title`);

  // The four approved plain copyable URLs inside <code> (exactly these, in this order), NOT anchor links or defunct MinerU cloud.
  assert.deepEqual(rendered(html), PINNED_URLS, `${label}: prints exactly the approved addresses`);
  for (const url of EXTERNAL_PDF_TOOL_URLS) {
    assert.ok(html.includes(`>${url}</code>`), `${label}: renders ${url} as plain copyable <code>`);
    assert.ok(!html.includes(`href="${url}"`), `${label}: does not render ${url} as an <a> link`);
  }
  assert.doesNotMatch(html.split(MINERU_WEB_URL).join(''), /mineru\.net|type="password"|baseUrl|api[\s_-]?key|token|云端/i, `${label}: zero cloud/key/baseUrl fields; mineru.net only as the web parser's address`);

  // Step 1 quotes the limits from their homes, and the page marker sits in <code> (the arrow ligature of `-->` in the UI font).
  assert.ok(html.includes(`PDF 最多 ${LARGE_DOCUMENT_LIMITS.pdfPages} 页，提取出的文字最多 ${LARGE_DOCUMENT_LIMITS.selectionChars.toLocaleString('en-US')} 字符`), `${label}: pages and characters come from LARGE_DOCUMENT_LIMITS`);
  assert.ok(html.includes(`PDF 与文本最大 ${megabytes(MAX_TEXT_DOCUMENT_BYTES)} MB，Word / PPT / 转换 JSON 最大 ${megabytes(MAX_OFFICE_BYTES)} MB`), `${label}: sizes come from lib/office/limits.js`);
  assert.ok(html.includes(MARKER_CODE), `${label}: page marker is inside <code>`);
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
  assert.ok(html.includes(`PDF page limit: ${LARGE_DOCUMENT_LIMITS.pdfPages}; extracted text limit (characters): ${LARGE_DOCUMENT_LIMITS.selectionChars.toLocaleString('en-US')}`), `${label}: English limits come from LARGE_DOCUMENT_LIMITS`);
  assert.ok(html.includes(MARKER_CODE), `${label}: English page marker is inside <code>`);
  assert.deepEqual(rendered(html), PINNED_URLS, `${label}: English mode prints exactly the approved addresses`);
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
    assertGuideInZh(guideMarkup(zh), label);

    const en = render(element, 'en');
    assert.equal((en.match(/data-pdf-external-guide=/g) || []).length, 1, `${label} (en): renders guide exactly once`);
    assertGuideInEn(guideMarkup(en), label);
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
          const copiedHere = copied.length;
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
          assert.deepEqual(copied.slice(copiedHere), PINNED_URLS, `${lang}: copied every pinned address, in order`);
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

  for (const url of PINNED_URLS) {
    assert.ok(zhDoc.includes(`\`${url}\``), `zh doc lists the pinned plain-text address ${url}`);
    assert.ok(enDoc.includes(`\`${url}\``), `en doc lists the pinned plain-text address ${url}`);
  }
  for (const [language, doc] of [['zh', zhDoc], ['en', enDoc]]) {
    mod.setUiLanguage(language);
    try {
      for (const entry of EXTERNAL_PDF_TOOLS) {
        const line = `**${mod.ui(entry.tool.name)}**${language === 'zh' ? '：' : ': '}\`${entry.url}\` — ${mod.toolMetaLine(entry.tool)}`;
        assert.ok(doc.includes(line), `${language} doc says the tool the way the catalogue does: ${line}`);
      }
    } finally { mod.setUiLanguage('zh'); }
  }
  // Step 1's limits read in each doc exactly as the guide says them, with the numbers from their homes.
  const { pdfPages, selectionChars } = LARGE_DOCUMENT_LIMITS;
  for (const [language, doc] of [['zh', zhDoc], ['en', enDoc]]) {
    mod.setUiLanguage(language);
    try {
      const pages = mod.uiFormat('PDF 最多 {0} 页，提取出的文字最多 {1} 字符', [pdfPages, selectionChars.toLocaleString('en-US')]);
      const sizes = mod.uiFormat('PDF 与文本最大 {0} MB，Word / PPT / 转换 JSON 最大 {1} MB', [megabytes(MAX_TEXT_DOCUMENT_BYTES), megabytes(MAX_OFFICE_BYTES)]);
      assert.ok(doc.includes(pages), `${language} doc says the page and character limits as the guide does: ${pages}`);
      assert.ok(doc.includes(sizes), `${language} doc says the size limits as the guide does: ${sizes}`);
    } finally { mod.setUiLanguage('zh'); }
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
  assert.ok(zhDoc.includes('解压后导入名字以 `_content_list.json` 结尾的文件') && enDoc.includes('import the file whose name ends in `_content_list.json`'), 'both docs say which file of the MinerU .zip to import');
});

test('the guide reads the shared catalogue: the same entries as TOOLS, the pinned address list, https, no query string or fragment, hosts on the allow-list', () => {
  assert.deepEqual(EXTERNAL_PDF_TOOL_URLS, PINNED_URLS, 'the full list of addresses is pinned: removing, adding or changing one is a visible decision');
  assert.deepEqual(EXTERNAL_PDF_TOOLS.map(entry => entry.id), ['paddleocr', 'mineru-web', 'docling', 'mathpix']);
  assert.deepEqual(EXTERNAL_PDF_TOOL_IDS, EXTERNAL_PDF_TOOLS.map(entry => entry.id), 'every id the guide asks for is in the catalogue (none dropped silently)');
  assert.ok(!EXTERNAL_PDF_TOOLS.some(entry => /marker/i.test(entry.id + entry.url)), 'Marker is run by StudyHub (the PDF panel), so it is not an external link');
  for (const entry of EXTERNAL_PDF_TOOLS) {
    assert.equal(entry.tool, TOOLS.find(tool => tool.id === entry.id), `${entry.id} is the catalogue entry itself, not a second copy`);
    assert.ok(entry.tool.channels.some(channel => channel.url === entry.url), `${entry.id}: the address is one of its catalogue channels`);
    const url = new URL(entry.url);
    assert.equal(url.protocol, 'https:', entry.url);
    assert.equal(url.search, '', `${entry.url} has no query string`);
    assert.equal(url.hash, '', `${entry.url} has no fragment`);
    assert.equal(url.username + url.password, '', `${entry.url} carries no credentials`);
    assert.ok(ALLOWED_HOSTS.includes(url.hostname), `${url.hostname} is an allowed host`);
    assert.ok(!entry.url.includes('?') && !entry.url.includes('#'), entry.url);
  }
  assert.equal(new Set(EXTERNAL_PDF_TOOL_URLS).size, EXTERNAL_PDF_TOOL_URLS.length, 'no address twice');
  // The tool cards keep working for catalogue entries added for the guide (licence line, no installed claim).
  for (const id of ['mineru-web', 'mathpix']) {
    const tool = TOOLS.find(entry => entry.id === id);
    assert.equal(tool.recommended, false, `${id} is listed, not recommended`);
    assert.ok(tool.license && tool.platforms.length && tool.channels.length >= 2, id);
  }
});

test('the guide has no second copy of a limit: no hard-coded 8 MB / 40 MB / 200 pages / 600 000 characters in its two files, and no address (they live in the catalogue)', () => {
  for (const file of ['ui/pdf-external-guide.js', 'ui/PdfExternalConvertGuide.jsx']) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /\b(?:8|40) ?MB\b|200 ?页|60 ?万|600[,_ ]?000/, `${file} quotes limits from their homes`);
    assert.doesNotMatch(source, /(?<![\w.#-])(?:8|40|200|600[,_]?000)(?![\w.%-])/, `${file} writes no limit as a bare number`);
    assert.doesNotMatch(source, /https?:\/\//, `${file} holds no address: they live in the catalogue (lib/large-documents.js)`);
  }
});

test('PaddleOCR option (LargeDocumentCard) and guide step 1 say the same download line, and the option takes its address from the catalogue', () => {
  const option = render(h(mod.PaddleOcrOption), 'zh');
  const guide = render(h(mod.PdfExternalConvertGuide, { defaultOpen: true }), 'zh');
  const line = `解析完成后，下载 JSON 结果文件（或带 ${MARKER_CODE} 页码标记的 Markdown）`;
  assert.ok(option.includes(line), 'option says it');
  assert.ok(guide.includes(line), 'guide step 1 says it the same way');
  assert.ok(option.includes(`href="${TOOLS.find(tool => tool.id === 'paddleocr').channels[0].url}"`), 'the option links the catalogue address');
});

test('the compact PDF panel inside another card (LargeDocumentCard ConverterMain) leaves the guide out; the full panel has it once', () => {
  const count = props => (render(h(mod.PdfConversion, { available: true, initialLocal: { state: 'ready', tier: 'basic' }, ...props })).match(/data-pdf-external-guide=/g) || []).length;
  assert.equal(count({ compact: true }), 0, 'compact: no guide');
  assert.equal(count({}), 1, 'full panel: one guide');
});

test('PdfDetail shows the external guide only for a failed conversion, never while running, stopped or complete', () => {
  const guideOf = status => (render(h(mod.PdfDetail, { job: { ...sampleJob, status } })).match(/data-pdf-external-guide=/g) || []).length;
  assert.equal(guideOf('failed'), 1);
  for (const status of ['running', 'queued', 'paused', 'stopped', 'cancelled', 'complete', 'done']) assert.equal(guideOf(status), 0, `no guide for a ${status} conversion`);
  assert.equal((render(h(mod.PdfDetail, { job: { ...sampleJob, status: undefined } })).match(/data-pdf-external-guide=/g) || []).length, 0, 'no guide without a status');
});

test('MinerU web parser: its own catalogue entry (not the local install, not the desktop client, nothing to call), sign-in said, and the file the guide names imports page by page', () => {
  const web = TOOLS.find(tool => tool.id === 'mineru-web');
  assert.ok(web, 'mineru-web is in the catalogue');
  assert.deepEqual(web.channels.map(channel => channel.url), [MINERU_WEB_URL, 'https://github.com/opendatalab/MinerU'], 'the official web parser and its source: no API endpoint');
  assert.equal(web.needs, 'online');
  assert.equal(web.recommended, false);
  assert.equal(web.verifiedAt, '2026-11-28');
  assert.equal(web.license, TOOLS.find(tool => tool.id === 'mineru-local').license, 'the same MinerU licence wording as the local install');
  assert.deepEqual(web.outputs, TOOLS.find(tool => tool.id === 'mineru-local').outputs, 'the same MinerU output wording as the local install');
  assert.notEqual(web.name, TOOLS.find(tool => tool.id === 'mineru-local').name);
  assert.notEqual(web.name, TOOLS.find(tool => tool.id === 'mineru').name);
  assert.match(web.platforms.join(' '), /需登录 OpenXLab 账号/, 'says a sign-in is needed');
  assert.doesNotMatch(JSON.stringify(web), /token|api[\s_-]?key|baseUrl|\/api\//i, 'a link only: nothing to call');

  const zh = render(h(mod.PdfExternalConvertGuide, { defaultOpen: true }), 'zh');
  const en = render(h(mod.PdfExternalConvertGuide, { defaultOpen: true }), 'en');
  assert.match(zh, /需登录 OpenXLab 账号/);
  assert.match(en, /OpenXLab sign-in required/);
  assert.match(zh, /解压后导入名字以 _content_list\.json 结尾的文件/);
  assert.match(en, /import the file whose name ends in _content_list\.json/);

  // What the guide says matches the importer: the zip's content_list.json is MinerU output with pages; full.md has no page markers.
  const contentList = JSON.stringify([
    { type: 'text', text: '第一章 绪论：本章介绍课程的基本概念与学习方法。', text_level: 1, page_idx: 0 },
    { type: 'text', text: '第二页的正文，讲解第一个定理以及它的证明思路。', page_idx: 1 },
  ]);
  assert.equal(detectConvertedFormat(contentList), 'mineru-content-list');
  const book = parseConvertedDocument(contentList, { filename: 'abc_content_list.json' });
  assert.equal(book.converter, 'mineru');
  assert.deepEqual(book.pages.map(page => page.page), [1, 2]);
  assert.equal(detectConvertedFormat('# 第一章 绪论\n\n本章介绍课程的基本概念与学习方法。\n'), null, 'full.md carries no page markers');
});
