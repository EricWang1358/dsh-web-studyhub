/* ui/markdown-page.js (#896): Markdown as the body of ONE self-contained static page, the part the whole-book page (ui/book/book-html.js) and the pocket review
   page (#887) share. Footnotes and heading anchors are small rules written here (the bundled markdown-it has neither); the page names no address. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, contentsList, MARKDOWN_CSS } from '../ui/markdown-page.js';
import { BASE_CSS, staticPage } from '../ui/static-page.js';

const DOC = [
  '# The Book {#book}', '', 'Front words.', '',
  '## One {#c1}', '', 'Alpha [^a-1] and beta [^a-2], alpha again [^a-1].', '', '### Point {#p1}', '', 'Deep [^a-3].', '',
  '[^a-1]: First note', '[^a-2]: Second note with **bold**', '[^a-3]: Third',
  '', '## Two {#c2}', '', 'Gamma [^b-1].', '', '[^b-1]: Only in two', '[^unused]: never marked',
].join('\n');

const idsOf = html => [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const hrefsOf = html => [...html.matchAll(/\bhref="([^"]*)"/g)].map(match => match[1]);

test('a footnote mark becomes a numbered reference with a working back-link; no raw marker is left', () => {
  const { html } = renderMarkdown(DOC);
  assert.doesNotMatch(html, /\[\^/, 'no raw footnote marker');
  assert.doesNotMatch(html, /\{#/, 'no raw anchor marker');
  const ids = new Set(idsOf(html));
  assert.equal(idsOf(html).length, ids.size, 'every id is unique');
  for (const href of hrefsOf(html)) assert.ok(ids.has(href.slice(1)), `${href} points at an element of the page`);
  const refs = [...html.matchAll(/<sup class="fnref"><a href="#(fn-[^"]+)" id="(fnref-[^"]+)">(\d+)<\/a><\/sup>/g)];
  assert.deepEqual(refs.map(match => [match[1], match[3]]), [['fn-a-1', '1'], ['fn-a-2', '2'], ['fn-a-1', '1'], ['fn-a-3', '3'], ['fn-b-1', '1']], 'numbered in the order of first mention, again per chapter');
  assert.notEqual(refs[0][2], refs[2][2], 'two marks of one footnote have two ids');
  for (const [, definition] of refs) assert.ok(ids.has(definition), `${definition} is a footnote`);
  const first = html.match(/<li id="fn-a-1">[\s\S]*?<\/li>/)[0];
  assert.match(first, /First note/);
  assert.equal([...first.matchAll(/class="fnback" href="#(fnref-[^"]+)"/g)].length, 2, 'a footnote marked twice has a back-link for each mark');
  assert.match(html, /Second note with <strong>bold<\/strong>/, 'a footnote holds Markdown');
});

test('the footnotes stand at the end of their chapter, under a title, and a footnote nobody marks is left out', () => {
  const { html } = renderMarkdown(DOC, { footnotesLabel: 'Sources' });
  const sections = html.split('<section class="footnotes"').length - 1;
  assert.equal(sections, 2, 'one list per chapter that has footnotes');
  const one = html.indexOf('id="c1"'), two = html.indexOf('id="c2"'), firstList = html.indexOf('<section class="footnotes"');
  assert.ok(one < firstList && firstList < two, 'the first list is before the second chapter starts');
  assert.ok(html.indexOf('Deep') < firstList, 'after the chapter\'s last word, a point\'s notes included');
  assert.match(html, /<section class="footnotes"[^>]*><p class="fn-title">Sources<\/p><ol>/);
  assert.doesNotMatch(html, /never marked/);
  assert.match(html, /<li id="fn-b-1">Only in two/);
});

test('one footnote marked in two chapters has its own list entry and ids in each', () => {
  const { html } = renderMarkdown(['## A', '', 'One [^n].', '', '## B', '', 'Two [^n].', '', '[^n]: Shared'].join('\n'));
  const ids = idsOf(html);
  assert.equal(ids.length, new Set(ids).size, 'no id twice');
  assert.equal([...html.matchAll(/<li id=/g)].length, 2);
  for (const href of hrefsOf(html)) assert.ok(ids.includes(href.slice(1)), `${href} exists`);
});

test('a mark with no footnote is dropped, not shown raw; a definition inside a code fence is code', () => {
  const { html } = renderMarkdown('## A\n\nText [^gone] end.\n\n```\n[^x]: code\n```\n');
  assert.doesNotMatch(html, /\[\^gone\]|<sup/);
  assert.match(html, /Text\s+end\./);
  assert.match(html, /\[\^x\]: code/);
});

test('a label paragraph in front of the definitions is taken out with them', () => {
  const { html } = renderMarkdown('## A\n\nWord [^1].\n\n**Sources**\n\n[^1]: Note\n\nAfter.', { isFootnoteLabel: text => text === '**Sources**' });
  assert.doesNotMatch(html, /<strong>Sources<\/strong>/);
  assert.match(html, /After\./);
});

test('{#id} becomes the element id and the marker text goes; a heading without one gets an id for the contents', () => {
  const { html, headings } = renderMarkdown(DOC);
  assert.match(html, /<h2 id="c1" class="chapter">One<\/h2>/);
  assert.match(html, /<h3 id="p1">Point<\/h3>/);
  assert.deepEqual(headings.map(item => [item.id, item.level, item.text]), [['book', 1, 'The Book'], ['c1', 2, 'One'], ['p1', 3, 'Point'], ['c2', 2, 'Two']]);
  const bare = renderMarkdown('## Plain chapter\n\n## Other chapter\n\n## Plain chapter');
  const found = bare.headings.map(item => item.id);
  assert.equal(new Set(found).size, 3, 'ids are unique even for equal titles');
  assert.ok(found.every(Boolean));
  const dup = renderMarkdown('## A {#x}\n\n## B {#x}');
  assert.equal(new Set(dup.headings.map(item => item.id)).size, 2, 'a repeated id is not repeated on the page');
  assert.doesNotMatch(dup.html, /\{#/);
  assert.match(renderMarkdown('Mid {#not-a-heading} text').html, /\{#not-a-heading\}/, 'only a heading\'s tail is an anchor');
});

test('the title is the first top heading: named, and left out of the body when asked', () => {
  assert.equal(renderMarkdown(DOC).title, 'The Book');
  const dropped = renderMarkdown(DOC, { dropTitle: true });
  assert.doesNotMatch(dropped.html, /<h1/);
  assert.equal(dropped.title, 'The Book');
  assert.equal(renderMarkdown('no heading').title, '');
});

test('the contents list links to the chapters', () => {
  const { headings } = renderMarkdown(DOC);
  const html = contentsList(headings, { label: 'Contents' });
  assert.match(html, /^<nav class="contents" aria-label="Contents"><p class="contents-title">Contents<\/p><ol>/);
  assert.deepEqual(hrefsOf(html), ['#c1', '#c2'], 'chapters only, by default');
  assert.equal(contentsList([], { label: 'x' }), '');
  assert.match(contentsList([{ id: 'a', level: 2, text: '<b>&' }], { label: '"' }), /&lt;b&gt;&amp;/, 'escaped');
});

test('studyhub:// links are plain words; other links show where they go; only links inside the page are links', () => {
  const { html } = renderMarkdown('## A {#a}\n\n[Practise 5](studyhub://practice?heading=h1&n=5) · [site](https://example.org/x) · https://example.org/y · [up](#a) · [mail](mailto:a@b.c)');
  assert.deepEqual(hrefsOf(html), ['#a'], 'one link, inside the page');
  assert.match(html, /Practise 5 · site \(https:\/\/example\.org\/x\) · https:\/\/example\.org\/y · <a href="#a">up<\/a> · mail \(mailto:a@b\.c\)/);
});

test('an image is kept only when it is inside the page (a data: picture); any other becomes its words', () => {
  const dot = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const { html } = renderMarkdown(`![inside](${dot}) ![outside](https://example.org/a.png) ![local](studyhub-media://x/y.png)`);
  assert.equal([...html.matchAll(/<img\b/g)].length, 1);
  assert.match(html, /outside/);
  assert.match(html, /local/);
  assert.doesNotMatch(html, /https?:\/\/|studyhub-media/);
});

test('maths is MathML, with no namespace address; a formula KaTeX cannot draw shows its source', () => {
  const { html } = renderMarkdown('Inline $A = \\frac{M}{M + R}$ and\n\n$$x^2 + y^2 = z^2$$\n\nBad $\\notacommand$ done.');
  assert.ok([...html.matchAll(/<math\b/g)].length >= 2);
  assert.doesNotMatch(html, /xmlns|https?:\/\//);
  assert.match(html, /<math[^>]*display="block"/);
  assert.doesNotMatch(html, /<\/?eq|<\/?section>/);
  assert.match(html, /<code>.notacommand<\/code>/, 'a formula that cannot be drawn shows its source');
});

test('markup in the text is text: raw HTML and scripts are shown, not run', () => {
  const { html } = renderMarkdown('## T <script>alert(1)</script> {#t}\n\n<img src="https://example.org/x.png" onerror="boom()"> <b>x</b>');
  assert.doesNotMatch(html, /<script|<img|<b>/);
  assert.match(html, /&lt;script&gt;/);
});

test('the page: a viewport, light colours, no address, no script; wide things scroll inside themselves, not the page', () => {
  const { html } = renderMarkdown(DOC);
  const page = staticPage({ lang: 'en', title: 'T', css: BASE_CSS + MARKDOWN_CSS, body: html });
  assert.match(page, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(page, /color-scheme:light/);
  assert.doesNotMatch(page, /<script|<link|<img|@import|src=|url\(|https?:\/\//);
  assert.doesNotMatch(MARKDOWN_CSS, /(?:^|[;{\s])(?:min-)?width:\s*\d+(?:\.\d+)?(?:px|pt|mm|cm|in)\b/, 'no fixed width that would force a sideways scroll on a phone');
  assert.match(MARKDOWN_CSS, /@page\{size:A4/);
  assert.match(MARKDOWN_CSS, /h2\.chapter\{[^}]*break-before:page/, 'each chapter starts a page on paper');
  assert.match(MARKDOWN_CSS, /\.fn-title\{[^}]*break-after:avoid/, 'a footnote list is not parted from its title');
  assert.match(MARKDOWN_CSS, /@media print/);
});
