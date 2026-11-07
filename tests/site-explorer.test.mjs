import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import { buildSite } from '../scripts/site-build.mjs';
import { FAILURE_MODES, OPEN_PRIMITIVES, PIPELINE_STAGES, buildExplorerNodes, escHtml, readSuiteSummary } from '../site/explorer-content.mjs';
import { fullContextIds } from '../lib/runtime/builtins.js';
import '../site/demo.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

const STANDARD_HTML_TAGS = new Set([
  'html', 'head', 'meta', 'title', 'style', 'body', 'a', 'div', 'span', 'button',
  'nav', 'b', 'main', 'header', 'h1', 'h2', 'h3', 'h4', 'p', 'br', 'article',
  'section', 'aside', 'code', 'dl', 'dt', 'dd', 'small', 'strong', 'pre',
  'label', 'output', 'input', 'script', 'footer',
]);

function collectUnknownTags(html) {
  const unknown = [];
  function walk(node) {
    if (node.tagName && !STANDARD_HTML_TAGS.has(node.tagName)) unknown.push(node.tagName);
    if (Array.isArray(node.childNodes)) node.childNodes.forEach(walk);
  }
  walk(parse(html));
  return unknown;
}

test('site-build emits explorer.html and explorer-en.html with Ink-desk tokens, zero CJK leaks, and verified GitHub paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studyhub-explorer-'));
  try {
    const report = await buildSite({ outdir: dir });
    assert.deepEqual(report.pages, ['index.html', 'en.html', 'explorer.html', 'explorer-en.html']);
    assert.equal(report.externalRuntimeRequests, 0);

    const [indexZh, indexEn, explorerZh, explorerEn] = await Promise.all(
      report.pages.map(name => readFile(join(dir, name), 'utf8')),
    );
    assert.match(indexZh, /href="explorer\.html">技术栈与架构<\/a>/);
    assert.match(indexEn, /href="explorer-en\.html">Architecture<\/a>/);

    // Exact Ink-desk dark & light tokens from ui/tokens.css; never --bg-glass or backdrop-filter.
    for (const token of [
      '--bg-canvas: #161412',
      '--bg-sunken: #110f0d',
      '--bg-surface: #1e1b18',
      '--bg-raised: #26231f',
      '--bg-selected: #292623',
      '--accent: #c93d22',
      '--paper: #ece4d6',
      '--bg-canvas: #f1ede6',
      '--bg-surface: #faf8f4',
      '--accent: #c03a1f',
      '--paper: #fffdf8',
      'prefers-color-scheme: light',
      'prefers-reduced-motion: reduce',
    ]) {
      assert.ok(explorerZh.includes(token), `missing token or media query: ${token}`);
    }
    assert.doesNotMatch(explorerZh + explorerEn, /--bg-glass|backdrop-filter/i);
    assert.doesNotMatch(explorerZh + explorerEn, /\$\d|\bUSD\b|人民币|元\/百万/);

    // Escaped angle-bracket placeholders & parse5 AST check: zero accidental custom/unknown HTML tags.
    assert.equal(escHtml('lib/contexts/<id>/ & "mcp:<tool>"'), 'lib/contexts/&lt;id&gt;/ &amp; &quot;mcp:&lt;tool&gt;&quot;');
    assert.match(explorerZh, /lib\/contexts\/&lt;id&gt;\//);
    assert.match(explorerEn, /lib\/contexts\/&lt;id&gt;\//);
    assert.deepEqual(collectUnknownTags(explorerZh), [], 'explorer.html must contain zero unknown/custom HTML tags');
    assert.deepEqual(collectUnknownTags(explorerEn), [], 'explorer-en.html must contain zero unknown/custom HTML tags');

    // Accurate skill, boundary, pipeline shape, and localized no-JS day suffix assertions.
    assert.match(explorerZh, /目标自学建课（study-self）/);
    assert.match(explorerEn, /goal-driven self-study setup \(study-self\)/);
    assert.match(explorerZh, /tests\/architecture-boundaries\.test\.mjs/);
    assert.match(explorerEn, /tests\/architecture-boundaries\.test\.mjs/);
    assert.match(explorerZh, /id="fsrsInterval">0天<\/strong>/);
    assert.match(explorerEn, /id="fsrsInterval">0d<\/strong>/);

    // English explorer must contain zero CJK characters outside the language-switch link.
    const strippedEn = explorerEn.replace(/<a class="language-switch"[^>]*>[\s\S]*?<\/a>/, '');
    assert.doesNotMatch(strippedEn, /[\u4e00-\u9fff]/, 'explorer-en.html must not leak CJK characters');

    // Every GitHub blob/main/... link must exist in the repository.
    const blobPaths = [...explorerZh.matchAll(/https:\/\/github\.com\/EricWang1358\/dsh-web-studyhub\/blob\/main\/([^"#?\s<]+)/g)]
      .map(match => decodeURIComponent(match[1]));
    assert.ok(blobPaths.length >= 20, 'explorer links to real repository source files');
    for (const relPath of new Set(blobPaths)) {
      await access(resolve(root, relPath));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('explorer metadata matches live StudyRuntime contexts, generation stages, test suite counts, and bundled FSRS-6 rules', () => {
  const nodes = buildExplorerNodes();
  const contextNodes = nodes.filter(node => node.group === 'contexts').map(node => node.label);
  assert.deepEqual(contextNodes, [...fullContextIds]);
  assert.equal(contextNodes.length, 19);
  assert.equal(nodes.filter(node => node.group === 'plugins').length, 8);
  assert.equal(nodes.filter(node => node.group === 'tools').length, 7);
  assert.equal(OPEN_PRIMITIVES.length, 4);
  assert.equal(PIPELINE_STAGES.length, 5);
  assert.match(PIPELINE_STAGES[0].outputShape, /targetId: "target-1"/);
  assert.match(PIPELINE_STAGES[3].outputShape, /issues: string\[\], suggestions: string\[\], summary: string, checks:/);
  assert.equal(FAILURE_MODES.length, 5);

  const suite = readSuiteSummary(root);
  assert.equal(suite.fastFiles + suite.slowUniqueFiles, suite.totalFiles);
  assert.equal(suite.items.length, suite.totalFiles);

  const demo = globalThis.STUDY_DEMO;
  assert.ok(demo && demo.FSRS6_WEIGHTS.length === 21);
  assert.equal(demo.FAMILIAR_DAYS, 6);
  assert.equal(demo.MASTERED_DAYS, 21);
  assert.equal(demo.MASTERED_STREAK, 2);
  const boosted = demo.focusScheduleSettings(demo.defaults, { isFocus: true });
  assert.equal(boosted.request_retention, 0.94);
});
