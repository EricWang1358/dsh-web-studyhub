import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFragment } from 'parse5';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { resolvePosition } from '../lib/contexts/materials/positions.js';
import { readingSections } from '../ui/document-preview/reader/text-sections.js';

const {
  ReadingSections, renderReaderMarkdown, captureSelection, selectionRequest,
  renderedPassageRange, locateGroups, LearningPanel, setUiLanguage,
} = await loadUi(`
  export { default as ReadingSections } from './ui/document-preview/reader/ReadingSections.jsx';
  export { renderReaderMarkdown } from './ui/document-preview/reader/markdown.js';
  export { captureSelection, selectionRequest, renderedPassageRange } from './ui/document-preview/selection.js';
  export { locateGroups } from './ui/document-preview/links/link-ranges.js';
  export { LearningPanel } from './ui/document-preview/DocumentLearning.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const camelData = name => name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());

function matchesSingle(el, token) {
  let rest = token.trim();
  if (!rest) return false;
  const tagMatch = /^[a-zA-Z0-9-]+/.exec(rest);
  if (tagMatch) {
    if (el.tagName !== tagMatch[0].toLowerCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }
  for (const [, cls] of rest.matchAll(/\.([a-zA-Z0-9_-]+)/g)) {
    if (!el.classList.contains(cls)) return false;
  }
  for (const [, attr, val] of rest.matchAll(/\[([a-zA-Z0-9_-]+)(?:=["']?([^\]"']*)["']?)?\]/g)) {
    if (!el.hasAttribute(attr)) return false;
    if (val !== undefined && el.getAttribute(attr) !== val) return false;
  }
  return true;
}

const matchesSelector = (el, selector) => el?.nodeType === 1 && selector.split(',').some(part => matchesSingle(el, part));

/** Minimal faithful DOM over parse5 so captureSelection, locateGroups and renderedPassageRange run against actual rendered HTML in fast tests. */
function buildDom(html) {
  let order = 0;
  const ownerDocument = {
    createRange: () => createRange(),
    createTreeWalker(root, whatToShow = 5, filter = null) {
      const accept = typeof filter === 'function' ? filter : filter?.acceptNode?.bind(filter);
      const list = [];
      const walk = (node, isRoot) => {
        if (!isRoot) {
          const bit = node.nodeType === 1 ? 1 : node.nodeType === 3 ? 4 : 0;
          if (bit & whatToShow) {
            const verdict = accept ? accept(node) : 1;
            if (verdict === 2) return;
            if (verdict === 1) list.push(node);
          } else if (node.nodeType === 1 && accept) {
            // Even when SHOW_ELEMENT is off, standard TreeWalker skips children only when filter runs on shown types.
          }
        }
        for (const child of node.childNodes || []) walk(child, false);
      };
      walk(root, true);
      let index = 0;
      return { nextNode: () => list[index++] ?? null };
    },
  };

  function hydrate(raw, parentElement) {
    if (raw.nodeName === '#text') {
      const textNode = {
        nodeType: 3, nodeName: '#text', data: raw.value, textContent: raw.value,
        parentNode: parentElement, parentElement, childNodes: [], ownerDocument, _order: order++,
      };
      return textNode;
    }
    if (!raw.tagName && raw.nodeName !== '#document-fragment') return null;
    const attrs = new Map((raw.attrs || []).map(a => [a.name, a.value]));
    const classes = new Set((attrs.get('class') || '').split(/\s+/).filter(Boolean));
    const dataset = {};
    for (const [k, v] of attrs) if (k.startsWith('data-')) dataset[camelData(k)] = v;
    const el = {
      nodeType: raw.nodeName === '#document-fragment' ? 11 : 1,
      tagName: (raw.tagName || '').toLowerCase(),
      nodeName: (raw.tagName || raw.nodeName).toUpperCase(),
      parentNode: parentElement,
      parentElement: parentElement?.nodeType === 1 ? parentElement : null,
      attrs, dataset, ownerDocument, _order: order++,
      classList: { contains: name => classes.has(name) },
      hasAttribute: name => attrs.has(name),
      getAttribute: name => attrs.get(name) ?? null,
      contains(target) {
        for (let cur = target; cur; cur = cur.parentNode) if (cur === el) return true;
        return false;
      },
      closest(selector) {
        for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) if (matchesSelector(cur, selector)) return cur;
        return null;
      },
      querySelectorAll(selector) {
        const out = [];
        const visit = n => {
          for (const c of n.childNodes) {
            if (c.nodeType === 1) { if (matchesSelector(c, selector)) out.push(c); visit(c); }
          }
        };
        visit(el);
        return out;
      },
      querySelector(selector) { return el.querySelectorAll(selector)[0] ?? null; },
      childNodes: [],
    };
    el.childNodes = (raw.childNodes || []).map(child => hydrate(child, el)).filter(Boolean);
    Object.defineProperty(el, 'textContent', {
      get: () => el.childNodes.map(c => c.textContent).join(''),
    });
    return el;
  }

  function boundaryPath(node, offset) {
    const chain = [];
    let cur = node, off = offset;
    while (cur.parentNode) {
      const idx = cur.parentNode.childNodes.indexOf(cur);
      chain.push(off);
      off = idx;
      cur = cur.parentNode;
    }
    chain.push(off);
    return chain.reverse();
  }

  function compareBoundaries(aNode, aOff, bNode, bOff) {
    if (aNode === bNode) return Math.sign(aOff - bOff);
    const aPath = boundaryPath(aNode, aOff), bPath = boundaryPath(bNode, bOff);
    const len = Math.min(aPath.length, bPath.length);
    for (let i = 0; i < len; i++) {
      if (aPath[i] !== bPath[i]) return aPath[i] < bPath[i] ? -1 : 1;
    }
    // Equal prefix: the ancestor boundary (container, childIndex) comes BEFORE anything inside childNodes[childIndex].
    return aPath.length < bPath.length ? -1 : 1;
  }

  function commonAncestor(a, b) {
    const seen = new Set();
    for (let cur = a; cur; cur = cur.parentNode) seen.add(cur);
    for (let cur = b; cur; cur = cur.parentNode) if (seen.has(cur)) return cur;
    return root;
  }

  function createRange() {
    const r = {
      startContainer: null, startOffset: 0, endContainer: null, endOffset: 0,
      get commonAncestorContainer() { return commonAncestor(r.startContainer, r.endContainer); },
      setStart(node, offset) { r.startContainer = node; r.startOffset = offset; },
      setEnd(node, offset) { r.endContainer = node; r.endOffset = offset; },
      setStartBefore(node) { r.setStart(node.parentNode, node.parentNode.childNodes.indexOf(node)); },
      setEndAfter(node) { r.setEnd(node.parentNode, node.parentNode.childNodes.indexOf(node) + 1); },
      selectNodeContents(node) { r.setStart(node, 0); r.setEnd(node, node.childNodes.length); },
      comparePoint(node, offset) {
        if (compareBoundaries(node, offset, r.startContainer, r.startOffset) < 0) return -1;
        if (compareBoundaries(node, offset, r.endContainer, r.endOffset) > 0) return 1;
        return 0;
      },
      cloneRange() {
        const copy = createRange();
        copy.setStart(r.startContainer, r.startOffset);
        copy.setEnd(r.endContainer, r.endOffset);
        return copy;
      },
      toString() {
        const walker = ownerDocument.createTreeWalker(root, 4);
        let out = '', n;
        while ((n = walker.nextNode())) {
          if (n === r.startContainer && n === r.endContainer) out += n.data.slice(r.startOffset, r.endOffset);
          else if (n === r.startContainer) out += n.data.slice(r.startOffset);
          else if (n === r.endContainer) out += n.data.slice(0, r.endOffset);
          else if (r.comparePoint(n, 0) === 0) out += n.data;
        }
        return out;
      },
    };
    return r;
  }

  const root = hydrate(parseFragment(`<div class="study-document-body">${html}</div>`), null).childNodes[0];
  const findText = needle => {
    const walker = ownerDocument.createTreeWalker(root, 4);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = n.data.indexOf(needle);
      if (at >= 0) return { node: n, offset: at };
    }
    throw new Error(`Text not found in rendered DOM: ${needle}`);
  };
  const selectBetween = (startNeedle, endNeedle) => {
    const s = findText(startNeedle), e = findText(endNeedle);
    const range = createRange();
    range.setStart(s.node, s.offset);
    range.setEnd(e.node, e.offset + endNeedle.length);
    return makeSelection(range);
  };
  const makeSelection = range => ({
    rangeCount: 1,
    isCollapsed: range.startContainer === range.endContainer && range.startOffset === range.endOffset,
    getRangeAt: () => range,
    removeAllRanges() {},
    addRange(next) { range = next; },
  });
  return { root, ownerDocument, createRange, findText, selectBetween, makeSelection };
}

async function withRuntime(t) {
  const dir = await mkdtemp(join(tmpdir(), 'study-multiline-'));
  const runtime = createStudyRuntime(dir);
  t.after(async () => { runtime.dispose(); await rm(dir, { recursive: true, force: true }); });
  return runtime;
}

const SERVLET_BOOK = [
  { type: 'text', text_level: 1, text: '第3章 Java Web基础', page_idx: 0 },
  { type: 'text', text: '本章介绍 Servlet 开发基础与请求响应生命周期。', page_idx: 0 },
  { type: 'text', text_level: 2, text: '3.3 Servlet方式开发', page_idx: 1 },
  { type: 'text', text_level: 3, text: '代码解析', page_idx: 1 },
  { type: 'text', text: '(1) @SuppressWarnings("serial"): 抑制编译警告，表明该类无需显式定义 serialVersionUID。', page_idx: 1 },
  { type: 'text', text: '(2) @WebServlet("/demo"): 通过注解映射访问路径，无需在 web.xml 中手动配置。', page_idx: 1 },
  { type: 'text', text: '(3) 继承 HttpServlet: 使当前类具备处理 HTTP 请求的能力。', page_idx: 1 },
  { type: 'text', text: '(4) 重写 doGet 方法: 专门接收并处理客户端发送的 GET 请求。', page_idx: 1 },
  { type: 'text', text: '(5) 获取请求参数: 通过 request.getParameter("t\\_name") 读取表单提交字段。', page_idx: 1 },
  { type: 'text', text: '(6) 输出响应内容: 设置文本编码并通过 PrintWriter 向浏览器返回结果。', page_idx: 1 },
  { type: 'text', text_level: 2, text: '3.4 Servlet生命周期', page_idx: 2 },
  { type: 'text', text: '容器加载 Servlet 后依次调用 init、service 与 destroy 方法。', page_idx: 2 },
];

test('converted paged book (MinerU): multi-paragraph selection across heading and (1)-(6) preserves newlines and resolves on its page', async t => {
  const runtime = await withRuntime(t);
  const imported = await runtime.call('materials.document.import', {
    filename: 'JavaWeb教材.json',
    dataBase64: Buffer.from(JSON.stringify(SERVLET_BOOK)).toString('base64'),
  });
  const doc = await runtime.call('materials.document.get', { documentId: imported.documentId });
  const sections = readingSections({ paged: true, sources: doc.sources });
  const html = renderToStaticMarkup(React.createElement(ReadingSections, {
    sections,
    labelOf: section => `第 ${section.page} 页`,
    onPeek: () => {},
  }));
  const dom = buildDom(html);

  // Select from heading "代码解析" on Page 2 through the end of "(6) ... 返回结果。" (exact screenshot scenario).
  const selection = dom.selectBetween('代码解析', '向浏览器返回结果。');
  const capture = captureSelection(dom.root, selection);
  assert.ok(capture);
  assert.equal(capture.page, 2);
  assert.equal(capture.sourceId, doc.sources[1].id, 'captures Page 2 sourceId, never falling back to Page 1');
  assert.equal(capture.crossPage, undefined);
  assert.match(capture.quote, /^代码解析\n\(1\) @SuppressWarnings\("serial"\)/, 'line break preserved between heading and (1)');
  assert.match(capture.quote, /\n\(5\) 获取请求参数: 通过 request\.getParameter\("t\\_name"\)/);
  assert.match(capture.quote, /\n\(6\) 输出响应内容: 设置文本编码并通过 PrintWriter 向浏览器返回结果。$/);

  // Resolve against the material (simulating learningDocument defaulting sourceId to Page 1 while capture carries Page 2).
  const learningDoc = { ...doc, sourceId: doc.sources[0].id };
  const resolved = await runtime.call('materials.selection.resolve', selectionRequest(learningDoc, capture));
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.selection.page, 2);
  assert.equal(resolved.selection.sourceId, doc.sources[1].id);
  assert.ok(resolved.selection.quote.includes('代码解析'));
  assert.ok(resolved.selection.quote.includes('(6) 输出响应内容'));

  // Saving marks (underline & queue) and annotations (explain) on the multi-paragraph selection all succeed.
  const mark = await runtime.call('materials.marks.save', {
    documentId: doc.documentId, revision: doc.revision,
    selection: selectionRequest(learningDoc, capture), style: 'underline',
  });
  assert.equal(mark.status, 'saved');
  const queued = await runtime.call('materials.marks.save', {
    documentId: doc.documentId, revision: doc.revision,
    selection: selectionRequest(learningDoc, capture), style: 'queue',
  });
  assert.equal(queued.status, 'saved');
  const savedNote = await runtime.call('materials.annotation.save', {
    documentId: doc.documentId, revision: doc.revision, selection: resolved.selection,
    nodes: [{ id: 'explain-1', parentId: null, question: '解释这段代码解析', term: '代码解析', label: '词解', answer: '逐条说明注解与方法职责。', kind: 'explain' }],
  });
  assert.equal(savedNote.status, 'saved');
});

test('element-node Range boundaries (triple-click / margin drag) on Page 2 stay scoped to Page 2 without adjacent-page bleed or UI chrome', async t => {
  const runtime = await withRuntime(t);
  const imported = await runtime.call('materials.document.import', {
    filename: 'JavaWeb教材.json',
    dataBase64: Buffer.from(JSON.stringify(SERVLET_BOOK)).toString('base64'),
  });
  const doc = await runtime.call('materials.document.get', { documentId: imported.documentId });
  const sections = readingSections({ paged: true, sources: doc.sources });
  const html = renderToStaticMarkup(React.createElement(ReadingSections, {
    sections,
    labelOf: section => `第 ${section.page} 页`,
    onPeek: () => {},
  }));
  const dom = buildDom(html);
  const pages = dom.root.querySelectorAll('[data-study-page]');
  assert.equal(pages.length, 3);

  // 1. Browser triple-click on the LAST paragraph of Page 2: startContainer is <p> (element node) at offset 0,
  //    endContainer is Page 3's <section> (element node) at offset 0.
  const page2Paragraphs = pages[1].querySelectorAll('.reader-p');
  const lastP = page2Paragraphs.at(-1);
  const tripleRange = dom.createRange();
  tripleRange.setStart(lastP, 0);
  tripleRange.setEnd(pages[2], 0);
  const tripleCapture = captureSelection(dom.root, dom.makeSelection(tripleRange));
  assert.ok(tripleCapture);
  assert.equal(tripleCapture.crossPage, undefined, 'spilling endContainer onto Page 3 offset 0 is not cross-page');
  assert.equal(tripleCapture.page, 2);
  assert.equal(tripleCapture.sourceId, doc.sources[1].id);
  assert.equal(tripleCapture.suffix, '', 'Page 3 text and header do not bleed into suffix');
  assert.doesNotMatch(tripleCapture.prefix, /生命周期|第 2 页|看原页/, 'Page 1 text and Page 2 chrome do not bleed into prefix');
  const tripleResolved = await runtime.call('materials.selection.resolve', selectionRequest({ ...doc, sourceId: doc.sources[0].id }, tripleCapture));
  assert.equal(tripleResolved.status, 'resolved');

  // 2. Drag starting on Page 2's <header data-find-skip="true"> (element node) across Page 2's first two blocks.
  const headDrag = dom.createRange();
  headDrag.setStart(pages[1], 0);
  const secondItem = dom.findText('抑制编译警告');
  headDrag.setEnd(secondItem.node, secondItem.offset + '抑制编译警告'.length);
  const headCapture = captureSelection(dom.root, dom.makeSelection(headDrag));
  assert.ok(headCapture);
  assert.equal(headCapture.page, 2);
  assert.equal(headCapture.sourceId, doc.sources[1].id);
  assert.doesNotMatch(headCapture.quote, /第 2 页|看原页/, 'skipped header chrome never enters quote');
  assert.equal(headCapture.prefix, '', 'Page 1 text never enters Page 2 prefix');
  const headResolved = await runtime.call('materials.selection.resolve', selectionRequest({ ...doc, sourceId: doc.sources[0].id }, headCapture));
  assert.equal(headResolved.status, 'resolved');

  // 3. Selecting ONLY the page header ("第 2 页" / "看原页") yields null rather than a broken quote.
  const headerOnly = dom.createRange();
  headerOnly.setStart(pages[1].querySelector('header'), 0);
  headerOnly.setEnd(pages[1].querySelector('header'), pages[1].querySelector('header').childNodes.length);
  assert.equal(captureSelection(dom.root, dom.makeSelection(headerOnly)), null);
});

test('genuine cross-page selection sets crossPage, withholds resolve request, and renders honest localized warnings', async t => {
  const runtime = await withRuntime(t);
  const imported = await runtime.call('materials.document.import', {
    filename: 'JavaWeb教材.json',
    dataBase64: Buffer.from(JSON.stringify(SERVLET_BOOK)).toString('base64'),
  });
  const doc = await runtime.call('materials.document.get', { documentId: imported.documentId });
  const sections = readingSections({ paged: true, sources: doc.sources });
  const html = renderToStaticMarkup(React.createElement(ReadingSections, {
    sections,
    labelOf: section => `第 ${section.page} 页`,
  }));
  const dom = buildDom(html);
  const cross = captureSelection(dom.root, dom.selectBetween('(6) 输出响应内容', '容器加载 Servlet'));
  assert.ok(cross);
  assert.equal(cross.crossPage, true);
  assert.equal(selectionRequest(doc, cross), null, 'cross-page selection never fires a single-source resolve request');

  setUiLanguage('zh');
  const zhMarkup = renderToStaticMarkup(React.createElement(LearningPanel, {
    capture: cross,
    resolution: { status: 'crossPage' },
  }));
  assert.match(zhMarkup, /选区跨了多页，请在一页内选择。/);
  assert.doesNotMatch(zhMarkup, /无法在已保存的资料中核实/);

  setUiLanguage('en');
  try {
    const enMarkup = renderToStaticMarkup(React.createElement(LearningPanel, {
      capture: { ...cross, quote: 'Page two tail\nPage three head' },
      resolution: { status: 'crossPage' },
    }));
    assert.match(enMarkup, /This selection spans multiple pages\. Select within a single page\./);
    assert.doesNotMatch(enMarkup, /[\u3400-\u9fff]/);
  } finally {
    setUiLanguage('zh');
  }
});

test('multi-line Markdown (soft breaks, lists, formulas, tables) and HTML (<br>, adjacent <p>, <table>) resolve cleanly', async t => {
  const runtime = await withRuntime(t);
  const mdSource = [
    '# 分布式一致性',
    '',
    '第一行说明因果顺序，',
    '第二行紧接软换行并给出公式 $L(a) < L(b)$。',
    '',
    '- 节点甲记录本地逻辑时钟',
    '- 节点乙在收到消息后推进时钟',
    '',
    '| 协议 | 容错模型 |',
    '| --- | --- |',
    '| Raft | 崩溃容错 |',
    '| PBFT | 拜占庭容错 |',
  ].join('\n');
  const mdDoc = await runtime.call('materials.document.import', {
    filename: 'consensus.md',
    dataBase64: Buffer.from(mdSource).toString('base64'),
  });
  const mdDom = buildDom(`<div class="reader-html source-md" data-study-text="true">${renderReaderMarkdown(mdSource)}</div>`);

  // Soft break (<br>\n from markdown-it breaks:true) + formula + list items
  const softCapture = captureSelection(mdDom.root, mdDom.selectBetween('第一行说明因果顺序', '推进时钟'));
  assert.ok(softCapture);
  assert.match(softCapture.quote, /^第一行说明因果顺序，\n第二行紧接软换行并给出公式 \$L\(a\) < L\(b\)\$。/, 'soft <br>\\n emits a single newline');
  assert.match(softCapture.quote, /节点甲记录本地逻辑时钟\n节点乙在收到消息后推进时钟$/);
  const softResolved = await runtime.call('materials.selection.resolve', selectionRequest(mdDoc, softCapture));
  assert.equal(softResolved.status, 'resolved');

  // Markdown table across rows
  const tableCapture = captureSelection(mdDom.root, mdDom.selectBetween('Raft', '拜占庭容错'));
  const tableResolved = await runtime.call('materials.selection.resolve', selectionRequest(mdDoc, tableCapture));
  assert.equal(tableResolved.status, 'resolved');

  // Compact HTML with zero whitespace text nodes between <p>, <br>, and <td> cells
  const htmlSource = '<article><p>段落一介绍事务隔离。</p><p>段落二含换行第一句<br>换行第二句。</p><table><tr><th>级别</th><th>脏读</th></tr><tr><td>读已提交</td><td>禁止</td></tr></table></article>';
  const htmlDoc = await runtime.call('materials.document.import', {
    filename: 'isolation.html',
    dataBase64: Buffer.from(htmlSource).toString('base64'),
  });
  const htmlDom = buildDom(`<div class="reader-html" data-study-text="true">${htmlSource}</div>`);
  const htmlCapture = captureSelection(htmlDom.root, htmlDom.selectBetween('段落一介绍事务隔离。', '禁止'));
  assert.equal(htmlCapture.quote, '段落一介绍事务隔离。\n段落二含换行第一句\n换行第二句。\n级别\t脏读\n读已提交\t禁止');
  const htmlResolved = await runtime.call('materials.selection.resolve', selectionRequest(htmlDoc, htmlCapture));
  assert.equal(htmlResolved.status, 'resolved');
});

test('positions fallback handles whitespace divergence (same-line footnotes, astral Unicode) while keeping ambiguity and offset checks strict', () => {
  const footnoteText = '正文先给出结论🎭。\n\n<small><span class="docvortex-page-footnote">① 第一条脚注说明数据来源。</span></small><small><span class="docvortex-page-footnote">② 第二条脚注补充边界条件𝕏。</span></small>';
  const source = { id: 's-fn', text: footnoteText, document: { page: 5 } };
  const identity = { documentId: 'doc-fn', revision: 'rev-1' };

  // In ReadingSections / Markdown, the two adjacent footnotes on one stored line render as two <p class="reader-footnote"> blocks separated by \n.
  const domSeparatedQuote = '<small><span class="docvortex-page-footnote">① 第一条脚注说明数据来源。</span></small>\n<small><span class="docvortex-page-footnote">② 第二条脚注补充边界条件𝕏。</span></small>';
  const resolved = resolvePosition([source], { quote: domSeparatedQuote, prefix: '正文先给出结论🎭。', suffix: '' }, identity);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.selection.quote, footnoteText.slice(resolved.selection.start, resolved.selection.end));
  assert.ok(resolved.selection.quote.endsWith('边界条件𝕏。</span></small>'));

  // Duplicate multi-line passages stay ambiguous without context, and disambiguate with prefix/suffix.
  const dupSource = { id: 's-dup', text: '甲组：\n第一行\n第二行\n\n乙组：\n第一行\n第二行' };
  assert.equal(resolvePosition([dupSource], { quote: '第一行第二行' }, identity).status, 'ambiguous');
  const second = resolvePosition([dupSource], { quote: '第一行第二行', prefix: '乙组：' }, identity);
  assert.equal(second.status, 'resolved');
  assert.equal(second.selection.start, dupSource.text.lastIndexOf('第一行'));

  // Wrong context still rejects, and forged offsets still fail strict slice check.
  assert.equal(resolvePosition([dupSource], { quote: '第一行第二行', prefix: '丙组：' }, identity).status, 'missing');
  assert.equal(resolvePosition([dupSource], { quote: '第一行\n第二行', start: 0, end: 7 }, identity).status, 'missing');
});

test('long (>4000 char) multi-paragraph annotations reopen cleanly using stored offsets and full source slice', async t => {
  const runtime = await withRuntime(t);
  const paragraphs = Array.from({ length: 50 }, (_, i) => `第 ${i + 1} 段详细阐述多行长选区在超过四千字裁剪上限后仍能通过偏移量精确回读原文内容（段落编号 P-${String(i + 1).padStart(2, '0')}，用于拉长总字符数以跨越四千字限制，确保首尾完备且无重复歧义）。`);
  const fullText = `# 长文测试\n\n${paragraphs.join('\n\n')}\n\n结尾收束段。`;
  const imported = await runtime.call('materials.document.import', {
    filename: 'long.txt',
    dataBase64: Buffer.from(fullText).toString('base64'),
  });
  const doc = await runtime.call('materials.document.get', { documentId: imported.documentId });
  const longPassage = paragraphs.join('\n\n');
  assert.ok(longPassage.length > 4200, `expected >4200 chars, got ${longPassage.length}`);

  const resolved = await runtime.call('materials.selection.resolve', {
    documentId: doc.documentId, revision: doc.revision, quote: longPassage,
  });
  assert.equal(resolved.status, 'resolved');

  const saved = await runtime.call('materials.annotation.save', {
    documentId: doc.documentId, revision: doc.revision, selection: resolved.selection,
    nodes: [{ id: 'long-note-1', parentId: null, question: '概括长段落结构', answer: '共五十段依次展开。' }],
  });
  assert.equal(saved.status, 'saved');

  const listed = await runtime.call('materials.annotation.list', { documentId: doc.documentId, revision: doc.revision });
  const at = listed.items[0].selection;
  assert.equal(at.quote.length, 4000, 'stored annotation clips quote to 4000');
  assert.equal(at.end - at.start, longPassage.length, 'stored offsets retain full span');
  assert.equal((await runtime.call('materials.selection.resolve', { documentId: doc.documentId, revision: doc.revision, ...at })).status, 'missing',
    'clipped 4000-char quote alone mismatches full [start, end] offsets');

  // Reopening as DocumentViewer.openAnnotation now does: slice fullQuote from source text by [start, end].
  const sourceText = doc.sources.find(s => s.id === at.sourceId).text;
  const fullQuote = sourceText.slice(at.start, at.end) || at.quote;
  const reopened = await runtime.call('materials.selection.resolve', {
    documentId: doc.documentId, revision: doc.revision, sourceId: at.sourceId,
    quote: fullQuote, prefix: at.prefix, suffix: at.suffix, start: at.start, end: at.end,
  });
  assert.equal(reopened.status, 'resolved');
  assert.equal(reopened.selection.end - reopened.selection.start, longPassage.length);
});

test('locateGroups and renderedPassageRange ignore page header labels when body text mentions the same words', () => {
  const dom = buildDom(
    '<section class="reader-section reader-section--page" data-study-page="2" data-study-source="src-p2">'
      + '<header class="reader-section__head" data-find-skip="true"><span class="reader-section__label">第 2 页</span><button class="reader-peek">看原页</button></header>'
      + '<div class="reader-prose" data-study-text="true"><p class="reader-p">请翻到第 2 页并点看原页核对插图。</p></div>'
      + '</section>'
  );
  const range = renderedPassageRange(dom.root, { sourceId: 'src-p2', quote: '第 2 页', prefix: '', suffix: '' });
  assert.ok(range, 'renderedPassageRange resolves uniquely in body without colliding with header label');
  assert.equal(range.toString(), '第 2 页');

  const located = locateGroups(dom.root, [{ key: 'm1', selection: { sourceId: 'src-p2', quote: '看原页', prefix: '', suffix: '' } }]);
  assert.equal(located.length, 1);
  assert.equal(located[0].range.toString(), '看原页');
});
