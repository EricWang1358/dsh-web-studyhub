/* Wave 3 integration & unit tests:
   1. Zero-download local hybrid retrieval wiring in lib/retrieval.js + lib/contexts/generation/retrieval-operations.js
   2. Strict OOXML Namespace URI normalization in lib/office/xml.js, docx.js, pptx.js
   3. Pure JS OMML -> LaTeX conversion & mc:AlternateContent Choice/Fallback handling in DOCX & PPTX
   4. Zustand fine-grained selector hardening (useAppSelector / useOptionalAppSelector) in Sources, Banners, Sidebar, Views */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  BUILTIN_RETRIEVAL_MODES,
  createBuiltinRetriever,
  narrowSources,
  retrieveBuiltin,
  retrieveFromPort,
} from '../lib/retrieval.js';
import { narrowSelection } from '../lib/contexts/generation/retrieval-operations.js';
import { StudyService } from '../lib/service.js';
import { extractOffice } from '../lib/office/index.js';
import { parseXml, attr, canonicalTag, isRelationshipType } from '../lib/office/xml.js';
import { formatOmml, ommlToLatex } from '../lib/office/omml.js';
import { docxFile, pptxFile, shape, apara, zipFiles, coreXml } from './helpers/office.mjs';
import { loadUi } from './helpers/ui-module.mjs';

/* ---------- 1. Wave 2 Retrieval Wiring (MiniSearch + PageIndex in builtin) ---------- */

function makeStemTextbook() {
  const sources = [
    {
      id: 'os-p1',
      title: '操作系统 · p.1',
      text: '# 第 1 章 进程与线程\n\n进程控制块 PCB 保存进程状态、程序计数器与寄存器上下文。',
      courses: ['OS'],
      document: { id: 'doc-os', materialId: 'doc-os', page: 1, totalPages: 6, bookTitle: '操作系统', filename: 'os.pdf', format: 'pdf' },
    },
    {
      id: 'os-p2',
      title: '操作系统 · p.2',
      text: '## 1.2 线程调度模型\n\n用户级线程与内核级线程的多对一、一对一与多对多映射比较。',
      courses: ['OS'],
      document: { id: 'doc-os', materialId: 'doc-os', page: 2, totalPages: 6, bookTitle: '操作系统', filename: 'os.pdf', format: 'pdf' },
    },
    {
      id: 'os-p3',
      title: '操作系统 · p.3',
      text: '# 第 2 章 死锁处理\n\n死锁四个必要条件：互斥、持有并等待、不可抢占、循环等待。',
      courses: ['OS'],
      document: { id: 'doc-os', materialId: 'doc-os', page: 3, totalPages: 6, bookTitle: '操作系统', filename: 'os.pdf', format: 'pdf' },
    },
    {
      id: 'os-p4',
      title: '操作系统 · p.4',
      text: '## 2.2 银行家算法\n\nBanker 算法利用 Need 矩阵与 Work 向量检测安全序列以实现死锁避免。',
      courses: ['OS'],
      document: { id: 'doc-os', materialId: 'doc-os', page: 4, totalPages: 6, bookTitle: '操作系统', filename: 'os.pdf', format: 'pdf' },
    },
    {
      id: 'os-p5',
      title: '操作系统 · p.5',
      text: '# 第 3 章 虚拟内存\n\n多级页表将虚拟页号映射到物理页框，TLB 快表缓存热点地址转换。',
      courses: ['OS'],
      document: { id: 'doc-os', materialId: 'doc-os', page: 5, totalPages: 6, bookTitle: '操作系统', filename: 'os.pdf', format: 'pdf' },
    },
    {
      id: 'db-p1',
      title: '数据库 · p.1',
      text: '# 第 1 章 存储引擎\n\nB+ 树索引与 LSM-Tree 日志结构合并树的读写放大对比。',
      courses: ['DB'],
      document: { id: 'doc-db', materialId: 'doc-db', page: 1, totalPages: 1, bookTitle: '数据库', filename: 'db.pdf', format: 'pdf' },
    },
  ];
  const documents = [{
    id: 'doc-os',
    currentRevision: 'r1',
    versions: [{
      revision: 'r1',
      sourceIds: sources.slice(0, 5).map(s => s.id),
      outline: {
        revision: 'r1',
        entries: [
          { title: '第 1 章 进程与线程', level: 1, anchor: { sourceId: 'os-p1', offset: 0 } },
          { title: '1.2 线程调度模型', level: 2, anchor: { sourceId: 'os-p2', offset: 0 } },
          { title: '第 2 章 死锁处理', level: 1, anchor: { sourceId: 'os-p3', offset: 0 } },
          { title: '2.2 银行家算法', level: 2, anchor: { sourceId: 'os-p4', offset: 0 } },
          { title: '第 3 章 虚拟内存', level: 1, anchor: { sourceId: 'os-p5', offset: 0 } },
        ],
      },
    }],
  }];
  return { sources, documents };
}

test('1a. retrieveBuiltin fuses MiniSearch lexical + PageIndex outline tree in hybrid/lexical/tree modes', async () => {
  assert.deepEqual(BUILTIN_RETRIEVAL_MODES, ['hybrid', 'lexical', 'tree']);
  const state = makeStemTextbook();

  const hybrid = await retrieveBuiltin({
    query: '银行家算法 死锁避免 Need 矩阵',
    sources: state.sources,
    documents: state.documents,
    state,
    course: 'OS',
    limit: 3,
  });
  assert.equal(hybrid.provider, 'builtin');
  assert.equal(hybrid.unresolved, 0);
  assert.equal(hybrid.diagnostics.engine, 'hybrid');
  assert.ok(hybrid.diagnostics.lexicalHits >= 1);
  assert.ok(hybrid.diagnostics.treeHits >= 1);
  assert.ok(hybrid.diagnostics.treeSize >= 5);
  assert.equal(hybrid.passages[0].sourceId, 'os-p4');
  assert.equal(hybrid.passages[0].page, 4);
  assert.ok(hybrid.passages.every(p => p.sourceId !== 'db-p1'), 'course filter isolates OS from DB');

  const lexicalOnly = await retrieveBuiltin({
    query: 'TLB 快表 多级页表',
    sources: state.sources,
    course: 'OS',
    mode: 'lexical',
    limit: 2,
  });
  assert.equal(lexicalOnly.diagnostics.engine, 'lexical');
  assert.equal(lexicalOnly.diagnostics.treeHits, 0);
  assert.equal(lexicalOnly.passages[0].sourceId, 'os-p5');

  const treeOnly = await retrieveBuiltin({
    query: '线程调度模型',
    sources: state.sources,
    documents: state.documents,
    course: 'OS',
    mode: 'tree',
    limit: 2,
  });
  assert.equal(treeOnly.diagnostics.engine, 'tree');
  assert.equal(treeOnly.diagnostics.lexicalHits, 0);
  assert.equal(treeOnly.passages[0].sourceId, 'os-p2');

  // AbortSignal cancellation is respected immediately.
  const ac = new AbortController();
  ac.abort(new Error('cancelled'));
  await assert.rejects(retrieveBuiltin({ query: '死锁', sources: state.sources, signal: ac.signal }), /cancelled/);
});

test('1b. retrieveFromPort preserves default builtin=null contract and supports opt-in localHybrid without a host port', async () => {
  const state = makeStemTextbook();

  // Default builtin call stays 100% backward compatible (returns null).
  const legacy = await retrieveFromPort(
    { tools: () => [], call: async () => ({}) },
    { provider: 'builtin' },
    { query: '死锁', sources: state.sources },
  );
  assert.equal(legacy, null);

  // Zero-download local hybrid works even when port is undefined!
  const local = await retrieveFromPort(
    undefined,
    { provider: 'builtin', localHybrid: true },
    { query: '多级页表 TLB', sources: state.sources, documents: state.documents, course: 'OS', limit: 3 },
  );
  assert.ok(local);
  assert.equal(local.provider, 'builtin');
  assert.equal(local.passages[0].sourceId, 'os-p5');

  // createBuiltinRetriever works as a drop-in studyRetrieval service.
  const service = createBuiltinRetriever(() => state);
  const viaService = await retrieveFromPort(
    { tools: () => [], call: async () => ({}), service: () => service },
    { provider: 'service' },
    { query: 'LSM-Tree B+ 树', sources: state.sources, course: 'DB', limit: 2 },
  );
  assert.equal(viaService.provider, 'service');
  assert.equal(viaService.passages[0].sourceId, 'db-p1');
});

test('1c. narrowSelection and retrieval.preview use zero-download localHybrid for oversized builtin books while keeping legacy defaults', async t => {
  const home = await mkdtemp(join(tmpdir(), 'w3-retrieval-home-'));
  const root = await mkdtemp(join(tmpdir(), 'w3-retrieval-lib-'));
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (before === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = before;
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  const filler = n => `第${n}页普通背景说明，用于构建大型教材分章篇幅。`.repeat(90);
  const bigSources = Array.from({ length: 280 }, (_, idx) => {
    const page = idx + 1;
    const head = idx % 20 === 0 ? `# 第 ${idx / 20 + 1} 章 专题\n\n` : '';
    const special = page === 142
      ? '## 7.2 银行家算法与安全序列\n\n银行家算法通过 Available、Allocation 和 Need 矩阵避免死锁。\n\n'
      : '';
    return {
      id: `big-p${page}`,
      title: `大型教材 · p.${page}`,
      text: `${head}${special}${filler(page)}`,
      courses: ['OS'],
      document: { id: 'big-book', page, totalPages: 280, bookTitle: '大型教材', filename: 'big.pdf' },
    };
  });

  // Oversized WITHOUT focus still throws selection-too-large (legacy contract).
  await assert.rejects(
    narrowSelection({ port: undefined, sources: bigSources, request: { focus: '' }, root }),
    err => err?.code === 'selection-too-large',
  );

  // Oversized WITH focus automatically narrows via zero-download builtin hybrid!
  const narrowed = await narrowSelection({
    port: undefined,
    sources: bigSources,
    request: { focus: '银行家算法 安全序列 死锁避免', course: 'OS' },
    root,
  });
  assert.ok(narrowed.retrieval, 'returns retrieval metadata');
  assert.equal(narrowed.retrieval.provider, 'builtin');
  assert.equal(narrowed.retrieval.diagnostics.engine, 'hybrid');
  assert.ok(narrowed.sources.length < bigSources.length);
  assert.ok(narrowed.sources.some(s => s.id === 'big-p142'), 'locates exact target page 142 in 280-page textbook');
  assert.ok(narrowSources(bigSources, [{ sourceId: 'big-p142', score: 1, text: 'x' }]).sources.length === 1);

  // StudyService retrieval.preview: legacy default stays empty; localHybrid:true returns ranked pages!
  const service = new StudyService(root, { coach: false });
  t.after(() => service.dispose());
  const imported = await service.call('materials.document.import', {
    dataBase64: Buffer.from(
      '<!-- page: 1 -->\n# 第 1 章 进程\n进程控制块 PCB。\n\n<!-- page: 2 -->\n# 第 2 章 死锁\n银行家算法安全序列判定。\n',
      'utf8',
    ).toString('base64'),
    filename: 'mini-os.md',
    courses: ['OS'],
  });
  const legacyPreview = await service.call('retrieval.preview', { sourceIds: imported.sourceIds, query: '银行家算法' });
  assert.deepEqual(legacyPreview, { provider: 'builtin', pages: [], unresolved: 0, hits: 0 });

  const localPreview = await service.call('retrieval.preview', {
    sourceIds: imported.sourceIds,
    query: '银行家算法',
    localHybrid: true,
    limit: 5,
  });
  assert.equal(localPreview.provider, 'builtin');
  assert.ok(localPreview.pages.length >= 1);
  assert.equal(localPreview.pages[0].page, 2);
  assert.match(localPreview.pages[0].snippet, /银行家算法/);
});

/* ---------- 2. Strict OOXML Namespace URI Normalization ---------- */

test('2a. XML parser normalizes Transitional & Strict OOXML Namespace URIs regardless of prefix or default xmlns', () => {
  const strictDoc = parseXml(`
    <wml:document xmlns:wml="http://purl.oclc.org/ooxml/wordprocessingml/main"
                  xmlns:math="http://purl.oclc.org/ooxml/officeDocument/math"
                  xmlns:rel="http://purl.oclc.org/ooxml/officeDocument/relationships">
      <wml:body>
        <wml:p>
          <wml:pPr><wml:pStyle wml:val="Heading1"/></wml:pPr>
          <wml:hyperlink rel:id="rId9"><wml:r><wml:t xml:space="preserve">Strict </wml:t></wml:r></wml:hyperlink>
          <math:oMath><math:r><math:t>x</math:t></math:r></math:oMath>
        </wml:p>
      </wml:body>
    </wml:document>
  `);
  assert.equal(canonicalTag(strictDoc), 'w:document');
  const body = strictDoc.children.find(c => typeof c !== 'string');
  assert.equal(canonicalTag(body), 'w:body');
  const p = body.children.find(c => typeof c !== 'string');
  assert.equal(canonicalTag(p), 'w:p');
  const pStyle = p.children[1].children[0];
  assert.equal(attr(pStyle, 'w:val'), 'Heading1');
  const hyperlink = p.children.find(c => canonicalTag(c) === 'w:hyperlink');
  assert.equal(attr(hyperlink, 'r:id'), 'rId9');
  const oMath = p.children.find(c => canonicalTag(c) === 'm:oMath');
  assert.equal(canonicalTag(oMath), 'm:oMath');

  assert.equal(isRelationshipType('http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', 'slide'), true);
  assert.equal(isRelationshipType('http://purl.oclc.org/ooxml/officeDocument/relationships/slide', 'slide'), true);
  assert.equal(isRelationshipType('http://purl.oclc.org/ooxml/officeDocument/relationships/notesSlide', 'notesSlide'), true);
  assert.equal(isRelationshipType('http://example.com/relationships/slide', 'slide'), false);

  // XXE / DOCTYPE security boundary stays enforced.
  assert.throws(() => parseXml('<!DOCTYPE foo [<!ENTITY x "y">]><root/>'), /DTDs and entity declarations/);
});

test('2b. Strict OOXML DOCX (custom prefix & default namespace) and Strict OOXML PPTX extract cleanly', async () => {
  const STRICT_W = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
  const STRICT_R = 'http://purl.oclc.org/ooxml/officeDocument/relationships';
  const STRICT_P = 'http://purl.oclc.org/ooxml/presentationml/main';
  const STRICT_A = 'http://purl.oclc.org/ooxml/drawingml/main';

  // Strict DOCX using default xmlns (unprefixed elements) + custom prefix wml: in styles.
  const strictDocxZip = zipFiles([
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    {
      name: 'word/styles.xml',
      data: `<wml:styles xmlns:wml="${STRICT_W}"><wml:style wml:type="paragraph" wml:styleId="H1"><wml:name wml:val="heading 1"/></wml:style></wml:styles>`,
    },
    {
      name: 'word/document.xml',
      data: `<document xmlns="${STRICT_W}"><body><p><pPr><pStyle val="H1"/></pPr><r><t>Strict Word Title</t></r></p><p><r><t>Strict body line.</t></r></p></body></document>`,
    },
  ]);
  const docxRes = await extractOffice(strictDocxZip, { format: 'docx', filename: 'strict.docx' });
  assert.equal(docxRes.sources[0].text, '# Strict Word Title\n\nStrict body line.');

  // Strict PPTX using custom pml:/dml:/rel: prefixes and Strict relationship URIs.
  const strictPptxZip = zipFiles([
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    {
      name: 'ppt/presentation.xml',
      data: `<pml:presentation xmlns:pml="${STRICT_P}" xmlns:rel="${STRICT_R}"><pml:sldIdLst><pml:sldId id="256" rel:id="rId1"/></pml:sldIdLst></pml:presentation>`,
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: `<rpkg:Relationships xmlns:rpkg="http://schemas.openxmlformats.org/package/2006/relationships"><rpkg:Relationship Id="rId1" Type="${STRICT_R}/slide" Target="slides/slide1.xml"/></rpkg:Relationships>`,
    },
    {
      name: 'ppt/slides/slide1.xml',
      data: `<pml:sld xmlns:pml="${STRICT_P}" xmlns:dml="${STRICT_A}"><pml:cSld><pml:spTree><pml:sp><pml:nvSpPr><pml:cNvPr id="2" name="T"/><pml:nvPr><pml:ph type="title"/></pml:nvPr></pml:nvSpPr><pml:txBody><dml:p><dml:r><dml:t>Strict Slide</dml:t></dml:r></dml:p></pml:txBody></pml:sp><pml:sp><pml:nvSpPr><pml:cNvPr id="3" name="B"/><pml:nvPr><pml:ph type="body"/></pml:nvPr></pml:nvSpPr><pml:txBody><dml:p><dml:r><dml:t>Strict bullet</dml:t></dml:r></dml:p></pml:txBody></pml:sp></pml:spTree></pml:cSld></pml:sld>`,
    },
    {
      name: 'ppt/slides/_rels/slide1.xml.rels',
      data: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${STRICT_R}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
    },
    {
      name: 'ppt/notesSlides/notesSlide1.xml',
      data: `<pml:notes xmlns:pml="${STRICT_P}" xmlns:dml="${STRICT_A}"><pml:cSld><pml:spTree><pml:sp><pml:nvSpPr><pml:cNvPr id="3" name="N"/><pml:nvPr><pml:ph type="body"/></pml:nvPr></pml:nvSpPr><pml:txBody><dml:p><dml:r><dml:t>Strict speaker note</dml:t></dml:r></dml:p></pml:txBody></pml:sp></pml:spTree></pml:cSld></pml:notes>`,
    },
    { name: 'docProps/core.xml', data: coreXml('Strict Deck') },
  ]);
  const pptxRes = await extractOffice(strictPptxZip, { format: 'pptx', filename: 'strict.pptx' });
  assert.equal(pptxRes.sources.length, 1);
  assert.equal(pptxRes.sources[0].text, '## 第 1 页 · Strict Slide\n\n- Strict bullet\n\n备注：\nStrict speaker note');
});

/* ---------- 3. Pure JS OMML -> LaTeX & mc:AlternateContent ---------- */

const M_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const A14_NS = 'http://schemas.microsoft.com/office/drawing/2010/main';

const mRun = text => `<m:r><m:t>${text}</m:t></m:r>`;

test('3a. OMML converter translates fractions, scripts, radicals, n-ary ops, delimiters, matrices, Greek & functions to standard LaTeX', () => {
  const convert = xml => ommlToLatex(parseXml(`<m:oMath xmlns:m="${M_NS}">${xml}</m:oMath>`));

  // Fraction: bar, linear, noBar (binomial)
  assert.equal(convert(`<m:f><m:num>${mRun('a+b')}</m:num><m:den>${mRun('c')}</m:den></m:f>`), '\\frac{a+b}{c}');
  assert.equal(convert(`<m:f><m:fPr><m:type m:val="noBar"/></m:fPr><m:num>${mRun('n')}</m:num><m:den>${mRun('k')}</m:den></m:f>`), '\\binom{n}{k}');

  // Superscript, subscript, sub+sup
  assert.equal(convert(`<m:sSup><m:e>${mRun('x')}</m:e><m:sup>${mRun('2')}</m:sup></m:sSup>`), 'x^{2}');
  assert.equal(convert(`<m:sSub><m:e>${mRun('a')}</m:e><m:sub>${mRun('i')}</m:sub></m:sSub>`), 'a_{i}');
  assert.equal(convert(`<m:sSubSup><m:e>${mRun('x')}</m:e><m:sub>${mRun('i')}</m:sub><m:sup>${mRun('2')}</m:sup></m:sSubSup>`), 'x_{i}^{2}');

  // Radicals: square root (with degHide=1) & cube root
  assert.equal(convert(`<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${mRun('x+1')}</m:e></m:rad>`), '\\sqrt{x+1}');
  assert.equal(convert(`<m:rad><m:deg>${mRun('3')}</m:deg><m:e>${mRun('8')}</m:e></m:rad>`), '\\sqrt[3]{8}');

  // N-ary: default integral (omitted m:chr) & summation
  assert.equal(
    convert(`<m:nary><m:sub>${mRun('0')}</m:sub><m:sup>${mRun('∞')}</m:sup><m:e>${mRun('e')}</m:e></m:nary>`),
    '\\int_{0}^{\\infty}e',
  );
  assert.equal(
    convert(`<m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub>${mRun('i=1')}</m:sub><m:sup>${mRun('n')}</m:sup><m:e><m:sSub><m:e>${mRun('x')}</m:e><m:sub>${mRun('i')}</m:sub></m:sSub></m:e></m:nary>`),
    '\\sum_{i=1}^{n}x_{i}',
  );

  // Delimiters & matrices (plain matrix, pmatrix, cases)
  assert.equal(convert(`<m:d><m:e>${mRun('x+y')}</m:e></m:d>`), '\\left( x+y \\right)');
  assert.equal(
    convert(`<m:m><m:mr><m:e>${mRun('1')}</m:e><m:e>${mRun('2')}</m:e></m:mr><m:mr><m:e>${mRun('3')}</m:e><m:e>${mRun('4')}</m:e></m:mr></m:m>`),
    '\\begin{matrix} 1 & 2 \\\\ 3 & 4 \\end{matrix}',
  );
  assert.equal(
    convert(`<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val="]"/></m:dPr><m:e><m:m><m:mr><m:e>${mRun('a')}</m:e><m:e>${mRun('b')}</m:e></m:mr><m:mr><m:e>${mRun('c')}</m:e><m:e>${mRun('d')}</m:e></m:mr></m:m></m:e></m:d>`),
    '\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}',
  );

  // Greek symbol followed by Latin variable preserves safe command spacing (\alpha x, not \alphax)
  assert.equal(convert(mRun('αx + β ≤ π')), '\\alpha x + \\beta \\le \\pi');

  // Block m:oMathPara formatting
  const blockNode = parseXml(`<m:oMathPara xmlns:m="${M_NS}"><m:oMath>${mRun('E=mc')}</m:oMath></m:oMathPara>`);
  assert.equal(formatOmml(blockNode), '$$E=mc$$');
});

test('3b. DOCX and PPTX extract inline & display OMML equations and handle mc:AlternateContent Choice + Fallback', async () => {
  // DOCX with inline m:oMath, display m:oMathPara, and mc:AlternateContent (one Choice math, one Fallback text)
  const docxBody = `
    <w:p xmlns:m="${M_NS}" xmlns:mc="${MC_NS}">
      <w:r><w:t xml:space="preserve">Quadratic roots: </w:t></w:r>
      <m:oMath>
        <m:f>
          <m:num>${mRun('-b±')}<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e><m:sSup><m:e>${mRun('b')}</m:e><m:sup>${mRun('2')}</m:sup></m:sSup>${mRun('-4ac')}</m:e></m:rad></m:num>
          <m:den>${mRun('2a')}</m:den>
        </m:f>
      </m:oMath>
    </w:p>
    <w:p xmlns:m="${M_NS}">
      <m:oMathPara>
        <m:oMath>
          <m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub>${mRun('k=1')}</m:sub><m:sup>${mRun('n')}</m:sup><m:e>${mRun('k')}</m:e></m:nary>
        </m:oMath>
      </m:oMathPara>
    </w:p>
    <w:p xmlns:mc="${MC_NS}">
      <mc:AlternateContent>
        <mc:Choice Requires="wps"><w:r><w:drawing/></w:r></mc:Choice>
        <mc:Fallback><w:r><w:t>Fallback equation note</w:t></w:r></mc:Fallback>
      </mc:AlternateContent>
    </w:p>
  `;
  const docx = await extractOffice(docxFile(docxBody), { format: 'docx', filename: 'stem.docx' });
  const docxText = docx.sources[0].text;
  assert.match(docxText, /Quadratic roots: \$\\frac\{-b\\pm\\sqrt\{b\^\{2\}-4ac\}\}\{2a\}\$/);
  assert.match(docxText, /\$\$\\sum_\{k=1\}\^\{n\}k\$\$/);
  assert.match(docxText, /Fallback equation note/);

  // PPTX with real PowerPoint <mc:AlternateContent><mc:Choice><a14:m><m:oMathPara> AND shape-level Fallback
  const mathPara = `<a:p>
    <a:r><a:t>Gauss integral: </a:t></a:r>
    <mc:AlternateContent xmlns:mc="${MC_NS}">
      <mc:Choice xmlns:a14="${A14_NS}" Requires="a14">
        <a14:m>
          <m:oMathPara xmlns:m="${M_NS}">
            <m:oMath>
              <m:nary><m:sub>${mRun('-∞')}</m:sub><m:sup>${mRun('∞')}</m:sup><m:e><m:sSup><m:e>${mRun('e')}</m:e><m:sup>${mRun('-x')}</m:sup></m:sSup></m:e></m:nary>
            </m:oMath>
          </m:oMathPara>
        </a14:m>
      </mc:Choice>
      <mc:Fallback><a:r><a:t>should-not-use-when-choice-has-math</a:t></a:r></mc:Fallback>
    </mc:AlternateContent>
  </a:p>`;
  const fallbackShape = `<mc:AlternateContent xmlns:mc="${MC_NS}">
    <mc:Choice Requires="p14"><p:pic><p:nvPicPr><p:cNvPr id="8" name="P"/></p:nvPicPr></p:pic></mc:Choice>
    <mc:Fallback>${shape([apara('Fallback slide text')], { id: 12 })}</mc:Fallback>
  </mc:AlternateContent>`;
  const pptx = await extractOffice(
    pptxFile([{ shapes: [shape([apara('Calculus')], { ph: 'title' }), shape([mathPara], { ph: 'body', id: 3 }), fallbackShape] }]),
    { format: 'pptx', filename: 'calc.pptx' },
  );
  const slideText = pptx.sources[0].text;
  assert.match(slideText, /Gauss integral: \$\$\\int_\{-\\infty\}\^\{\\infty\}e\^\{-x\}\$\$/);
  assert.doesNotMatch(slideText, /should-not-use-when-choice-has-math/);
  assert.match(slideText, /Fallback slide text/);
});

/* ---------- 4. Zustand Fine-Grained Selector Hardening ---------- */

const uiMod = await loadUi(`
  export {
    AppContext,
    AppStoreProvider,
    createAppStore,
    syncAppStore,
    useApp,
    useAppSelector,
    useOptionalAppSelector,
  } from './ui/app/app-context.js';
  export { IngestBanner, StorageIssuesBanner, RecoveryBanner, ContextReturn } from './ui/app/AppBanners.jsx';
  export { RemoveDialog } from './ui/Sources.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
`);

test('4. useAppSelector & useOptionalAppSelector work across Zustand store, legacy AppContext fallback, and bare standalone render', () => {
  const {
    AppContext,
    AppStoreProvider,
    createAppStore,
    useAppSelector,
    useOptionalAppSelector,
    StorageIssuesBanner,
    RecoveryBanner,
    RemoveDialog,
    StudyServicesContext,
  } = uiMod;

  function SelectorProbe() {
    const page = useAppSelector((s) => s.nav?.page);
    const missing = useOptionalAppSelector((s) => s.core?.refresh ? 'has-refresh' : 'no-refresh');
    return React.createElement('div', null, `${page}|${missing}`);
  }

  // 1. Inside Zustand <AppStoreProvider> (zero AppContext provider present).
  const store = createAppStore({
    nav: { page: 'sources' },
    core: { refresh: () => {} },
    data: { storageIssues: [{ file: 'broken.json' }] },
    lib: { recovery: { draft: { title: 'Saved Draft' } } },
    drafts: { restoreRecovery: () => {}, clearRecovery: () => {} },
  });
  const storeHtml = renderToStaticMarkup(
    React.createElement(AppStoreProvider, { store },
      React.createElement(SelectorProbe),
      React.createElement(StorageIssuesBanner),
      React.createElement(RecoveryBanner),
    ),
  );
  assert.match(storeHtml, /sources\|has-refresh/);
  assert.match(storeHtml, /broken\.json/);
  assert.match(storeHtml, /Saved Draft/);

  // 2. Inside legacy <AppContext.Provider> ONLY (backward compatibility for existing test harnesses).
  const legacyHtml = renderToStaticMarkup(
    React.createElement(AppContext.Provider, { value: { nav: { page: 'draft' }, core: {} } },
      React.createElement(SelectorProbe),
    ),
  );
  assert.equal(legacyHtml, '<div>draft|no-refresh</div>');

  // 3. Bare standalone render (no AppStoreProvider and no AppContext.Provider): useOptionalAppSelector returns undefined cleanly.
  const bareItem = { id: 's1', title: 'Notes', archived: true, usedBy: [], pages: [{ id: 's1' }], format: 'md' };
  const bareHtml = renderToStaticMarkup(
    React.createElement(StudyServicesContext.Provider, { value: { busy: false, act: async () => ({}), call: async () => ({}) } },
      React.createElement(RemoveDialog, { item: bareItem, onClose: () => {}, onRemoved: () => {}, canRemove: true }),
    ),
  );
  assert.match(bareHtml, /Notes/);
});
