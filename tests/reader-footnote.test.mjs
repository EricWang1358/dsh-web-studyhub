/* Hotfix 2.6.1: a MinerU / DocVortex page footnote (`<small><span class="docvortex-page-footnote" ...>…</span></small>`) is a footnote line
   in the reader, not literal HTML. The recognition is one pure helper (lib/footnote-html.js); the reader draws it as a real element built from
   React nodes (text sources) or the Markdown renderer's own tokens (Markdown sources), never as raw HTML, while the stored tags stay in the
   page as hidden counted text so selection / find / quote anchors keep mapping onto the stored text. The model never sees the tags. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseFragment } from 'parse5';
import { loadUi } from './helpers/ui-module.mjs';
import { findFootnotes, stripFootnoteHtml } from '../lib/footnote-html.js';
import { selectionEvidenceText } from '../lib/selection-evidence.js';
import { quoteFound } from '../lib/quote-match.js';
import { modelServices } from '../lib/runtime/models.js';

const ui = await loadUi(`
  export { default as ReadingSections } from './ui/document-preview/reader/ReadingSections.jsx';
  export { readingSections, splitParagraphs } from './ui/document-preview/reader/text-sections.js';
  export { renderReaderMarkdown } from './ui/document-preview/reader/markdown.js';
  export { locateVisibleQuote } from './ui/document-preview/selection.js';
  export { setUiLanguage } from './ui/i18n.js';
  export { default as MathText } from './ui/MathText.jsx';`);

const OWNER = '<small><span class="docvortex-page-footnote" data-block-type="page_footnote" style="color:#6b7280">① pH 是个例外，用正体。</span></small>';
const render = text => renderToStaticMarkup(React.createElement(ui.ReadingSections, { sections: ui.readingSections({ paged: false, sources: [{ id: 's', text }], text }), labelOf: () => '' }));
const countedText = html => {
  let text = '';
  const walk = node => {
    if (node.attrs?.some(attribute => attribute.name === 'data-study-marker')) return;
    if (node.nodeName === '#text') text += node.value;
    node.childNodes?.forEach(walk);
  };
  walk(parseFragment(html));
  return text;
};
const inners = text => findFootnotes(text).map(note => note.inner);
/** The drawn markup without the hidden stored text (the escaped tags kept in reader-bracket spans). */
const visibleMarkup = html => html.replace(/<span class="reader-bracket" aria-hidden="true">[^<]*<\/span>/g, '');

test('the helper recognises the DocVortex footnote family and nothing else', () => {
  assert.deepEqual(inners(OWNER), ['① pH 是个例外，用正体。']);
  const [note] = findFootnotes(`正文。\n\n${OWNER}\n\n下文。`);
  assert.equal(note.open + note.inner + note.close, note.raw, 'open, inner and close are the exact stored slices');
  assert.match(note.open, /^<small><span class="docvortex-page-footnote"[^>]*>$/);
  assert.equal(note.close, '</span></small>');
  for (const variant of [
    `<small><span data-block-type="page_footnote" class="docvortex-page-footnote">Note A</span></small>`,
    `<small><span class='docvortex-page-footnote'>Note A</span></small>`,
    `<small >  <span   class = "docvortex-page-footnote"  >Note A</span>\n</small>`,
    `<small><span class="docvortex-page-footnote" style="color:#6b7280;font-size:12px">Note A</span></small>`,
    `<small><span data-block-type='page_footnote'>Note A</span></small>`,
    `<span class="docvortex-page-footnote">Note A</span>`,
    `<SMALL><SPAN CLASS="docvortex-page-footnote">Note A</SPAN></SMALL>`,
    String.raw`<small><span class=\"docvortex-page-footnote\" style=\"color:#6b7280\">Note A</span></small>`,
  ]) assert.deepEqual(inners(variant), ['Note A'], variant);
  assert.deepEqual(inners(`${OWNER}\n${OWNER.replace('①', '②')}`).map(text => text[0]), ['①', '②'], 'several in a row stay separate');
  assert.deepEqual(inners(OWNER + OWNER.replace('①', '②')).length, 2, 'also on one line');
});

test('inner text keeps its Markdown, math and entities as stored', () => {
  const inner = '② $x_i$ 是 *斜体*，A &amp; B &lt; C';
  assert.deepEqual(inners(`<small><span class="docvortex-page-footnote">${inner}</span></small>`), [inner]);
});

test('other HTML, malformed and nested markup, and code are never footnotes', () => {
  for (const text of ['<small>plain small</small>', '<span class="x">a</span>', '<small><span class="other">a</span></small>', '<b>b</b>',
    '<small><span class="docvortex-page-footnote">never closed', '<span class="docvortex-page-footnote">a <span>nested</span> b</span>',
    '<span class="docvortex-page-footnote">a\n\nb</span>', '<span class="docvortex-page-footnote-other">a</span>', 'docvortex-page-footnote',
    '`' + OWNER + '`', '``' + OWNER + '``', '```\n' + OWNER + '\n```', '~~~\n' + OWNER + '\n~~~', 'Say `x` then `' + OWNER + '` end.']) {
    assert.deepEqual(findFootnotes(text), [], text);
  }
  assert.equal(inners(`Use \`<span>\` and ${OWNER}`).length, 1, 'code elsewhere in the text does not hide a footnote');
  assert.deepEqual(findFootnotes('```\n' + OWNER + '\n```\n\n' + OWNER).length, 1, 'only the one outside the fence');
  const [stray] = findFootnotes(`<small>${OWNER.replace('<small>', '').replace('</small>', '')}`);
  assert.ok(stray && stray.start > 0, 'a stray <small> without its closing tag stays text; the footnote itself is still found');
});

test('stripFootnoteHtml keeps the footnote words and drops the tags, leaving everything else alone', () => {
  assert.equal(stripFootnoteHtml(`正文。\n\n${OWNER}\n\n下文。`), '正文。\n\n① pH 是个例外，用正体。\n\n下文。');
  assert.equal(stripFootnoteHtml(OWNER + OWNER.replace('①', '②')), '① pH 是个例外，用正体。\n② pH 是个例外，用正体。');
  const untouched = 'a <small>x</small> `' + OWNER + '` <b>b</b>';
  assert.equal(stripFootnoteHtml(untouched), untouched);
  // A quote cut through a footnote carries only one half of its tags.
  const opener = '<small><span class="docvortex-page-footnote" data-block-type="page_footnote" style="color:#6b7280">';
  assert.equal(stripFootnoteHtml(`正文。${opener}① pH 是`), '正文。① pH 是', 'the unmistakable opening tags always go');
  assert.equal(stripFootnoteHtml(`例外，用正体。</span></small>下一段`), '例外，用正体。</span></small>下一段', 'a lone closing tag is kept unless the caller says the text is a captured selection');
  assert.equal(stripFootnoteHtml(`${opener}① pH 是`, { dangling: true }), '① pH 是');
  assert.equal(stripFootnoteHtml(`正文。\n${opener}① pH</span></small> 之后</span></small>`, { dangling: true }), '正文。\n① pH 之后');
  assert.equal(stripFootnoteHtml('<span class="x">a</span> <small>b</small>', { dangling: true }), '<span class="x">a</span> <small>b</small>');
  assert.equal(stripFootnoteHtml(''), '');
  assert.equal(stripFootnoteHtml(undefined), '');
});

test('the text reader draws a footnote as a real note element: no literal tags, no style, text and hidden stored tags', () => {
  const stored = `正文第一句。\n\n${OWNER}\n\n下一段。`;
  for (const language of ['zh', 'en']) {
    ui.setUiLanguage(language);
    const html = render(stored);
    assert.match(html, /<p class="reader-p reader-p--footnote reader-footnote" role="note">/, language);
    assert.equal((html.match(/reader-footnote/g) || []).length, 1);
    assert.match(html, /① pH 是个例外，用正体。/);
    assert.doesNotMatch(visibleMarkup(html), /style=|color:#6b7280|docvortex|&lt;/, 'the converter style and tags are never drawn');
    assert.doesNotMatch(html, /<small|<span class="docvortex|<[^>]*\sstyle=/, 'no raw element and no style attribute from the stored tags');
    // The stored tags are escaped text inside hidden brackets, exactly as written.
    assert.match(html, /<span class="reader-bracket" aria-hidden="true">&lt;small&gt;&lt;span class=&quot;docvortex-page-footnote&quot;/);
    assert.equal(countedText(html).replace(/\s+/g, ''), stored.replace(/\s+/g, ''), 'the counted text is the stored text');
  }
  ui.setUiLanguage('zh');
});

test('a footnote glued to a body paragraph, and several footnotes, become separate lines; a footnote is never a heading', () => {
  const stored = `这是一段正文，没有句号\n${OWNER}\n${OWNER.replace('①', '②')}`;
  const kinds = ui.splitParagraphs(stored).map(paragraph => paragraph.kind);
  assert.deepEqual(kinds, ['prose', 'footnote', 'footnote']);
  assert.deepEqual(ui.splitParagraphs(OWNER).map(paragraph => paragraph.kind), ['footnote'], 'a footnote alone is not a heading');
  assert.equal((render(stored).match(/reader-footnote/g) || []).length, 2);
});

test('inline math inside a footnote is drawn as a formula and its source stays counted', () => {
  const stored = `<small><span class="docvortex-page-footnote">③ 其中 $x_i$ 表示第 i 项。</span></small>`;
  const html = render(stored);
  assert.match(html, /class="reader-math"/);
  assert.equal(countedText(html).replace(/\s+/g, ''), stored.replace(/\s+/g, ''));
});

test('other HTML in text sources stays escaped text, and code that mentions a footnote is untouched', () => {
  for (const text of ['<small>just small</small>', '<b>bold</b> and <span class="x">span</span>', 'Mention `' + OWNER + '` inline.', '```\n' + OWNER + '\n```']) {
    const html = render(text);
    assert.doesNotMatch(html, /reader-footnote/, text);
    assert.equal(countedText(html).replace(/\s+/g, ''), text.replace(/\s+/g, ''), 'drawn exactly as before: the stored text');
  }
});

test('the footnote renderer adds no raw-HTML path', () => {
  const source = readFileSync(new URL('../ui/document-preview/reader/ReadingSections.jsx', import.meta.url), 'utf8');
  assert.equal((source.match(/dangerouslySetInnerHTML/g) || []).length, 1, 'only the formula drawing, as before');
});

test('Markdown sources draw the footnote the same way and leave the rest of Markdown alone', () => {
  const stored = `正文，含 $a+b$ 公式。\n\n${OWNER}\n${OWNER.replace('①', '②').replace('是个例外', 'A &amp; B *例外*')}\n\n## 下一节\n\n| a | b |\n|---|---|\n| 1 | 2 |`;
  const html = ui.renderReaderMarkdown(stored);
  assert.equal((html.match(/<p class="reader-footnote" role="note">/g) || []).length, 2);
  assert.doesNotMatch(visibleMarkup(html), /&lt;small|&lt;span|docvortex|style=/, 'no literal tags outside the hidden brackets');
  assert.doesNotMatch(html, /<[^>]*\sstyle=|<small/);
  assert.match(html, /<em>例外<\/em>/, 'Markdown emphasis inside is rendered by the Markdown renderer');
  assert.match(html, /A &amp; B/, 'entities are decoded once, then escaped');
  assert.match(html, /<h2>下一节<\/h2>/);
  assert.match(html, /<table>/);
  assert.equal(countedText(html).replace(/\s+/g, '').includes('<small><spanclass="docvortex-page-footnote"'), true, 'the stored opening tag stays counted text');
  for (const text of ['<small>just small</small>', '`' + OWNER + '`', '```\n' + OWNER + '\n```', '    ' + OWNER]) {
    assert.doesNotMatch(ui.renderReaderMarkdown(text), /reader-footnote/, text);
  }
  assert.match(ui.renderReaderMarkdown('<small>just small</small>'), /&lt;small&gt;just small&lt;\/small&gt;/, 'raw HTML is still escaped');
});

test('a quote in or around a footnote still maps onto the stored text', () => {
  const stored = `酸碱度的符号写作 pH。\n\n${OWNER}\n\n下一段开始。`;
  for (const html of [render(stored), ui.renderReaderMarkdown(stored)]) {
    const counted = countedText(html);
    const anchorOf = quote => {
      const at = counted.indexOf(quote);
      return { quote, prefix: counted.slice(Math.max(0, at - 40), at), suffix: counted.slice(at + quote.length, at + quote.length + 40) };
    };
    const inside = ui.locateVisibleQuote(stored, anchorOf('pH 是个例外，用正体。'));
    assert.equal(inside.status, 'resolved');
    assert.equal(stored.slice(inside.start, inside.end).replace(/\s+/g, ''), 'pH是个例外，用正体。');
    const across = ui.locateVisibleQuote(stored, anchorOf(counted.slice(counted.indexOf('符号写作'), counted.indexOf('<small>') + '<small>'.length)));
    assert.equal(across.status, 'resolved', 'a selection that crosses from the body into the footnote');
    const after = ui.locateVisibleQuote(stored, anchorOf('下一段开始。'));
    assert.equal(after.status, 'resolved', 'text after the footnote keeps its prefix');
    assert.equal(stored.slice(after.start, after.end), '下一段开始。');
  }
});

test('the model never sees the footnote tags: selection evidence, the model gateway and quote matching', async () => {
  const text = `正文。\n\n${OWNER}\n\n下文。`;
  const start = text.indexOf('正'), selection = { quote: '正文', start, end: start + 2 };
  const evidence = selectionEvidenceText(text, selection);
  assert.match(evidence, /① pH 是个例外，用正体。/);
  assert.doesNotMatch(evidence, /<small|<span|docvortex|#6b7280/);
  assert.equal(selectionEvidenceText(text, { quote: '一个足够长的选中文字不用上下文', start: 0, end: 3 }), '一个足够长的选中文字不用上下文');

  const captured = `正文。<small><span class="docvortex-page-footnote" data-block-type="page_footnote" style="color:#6b7280">① pH 是个例外`;
  assert.equal(selectionEvidenceText(text, { quote: captured, start: 0, end: 5 }), '正文。① pH 是个例外', 'a selection that ends inside a footnote');
  assert.equal(selectionEvidenceText(text, { quote: '例外，用正体。</span></small>下文。', start: 0, end: 5 }), '例外，用正体。下文。', 'and one that starts inside it');

  const seen = [];
  const services = modelServices({ complete: async (system, prompt) => { seen.push(prompt); return 'ok'; } });
  await services.complete('system', `Passage:\n${text}`);
  await services.complete('system', JSON.stringify({ passage: text }));
  assert.equal(seen.length, 2);
  for (const prompt of seen) { assert.match(prompt, /pH 是个例外/); assert.doesNotMatch(prompt, /<small|<span|docvortex|#6b7280/); }
  await services.complete('system', 'Plain prompt with <small>x</small> stays.');
  assert.match(seen[2], /<small>x<\/small>/);

  assert.equal(quoteFound(text, 'pH 是个例外，用正体'), true);
  assert.equal(quoteFound('<small>some words in a note</small>', 'small some words in a note'), false, 'a tag name is no wording');
});

test('a quote taken from a footnote is shown as its words, never as its tags', () => {
  const stored = `正文。${OWNER}`;
  const shown = renderToStaticMarkup(React.createElement(ui.MathText, { text: stored }));
  assert.equal(shown, '正文。① pH 是个例外，用正体。');
  assert.equal(renderToStaticMarkup(React.createElement(ui.MathText, { text: '例外，用正体。</span></small>' })), '例外，用正体。');
  assert.equal(renderToStaticMarkup(React.createElement(ui.MathText, { text: 'Plain $x$ and <small>html</small>' })).includes('&lt;small&gt;html'), true, 'other text is untouched');
});
