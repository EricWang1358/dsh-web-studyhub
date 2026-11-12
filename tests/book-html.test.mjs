/* ui/book/book-html.js (#896): the whole 复习全书 as ONE self-contained, printable HTML page, made from the Markdown of the export (lib/course-book-export.js)
   and nothing else. The page names no address; every footnote mark has its footnote and a way back; maths is MathML; each chapter starts a page on paper;
   and with 「不含原文引文」 the words quoted from the materials are not in the file while the place they came from stays. No model, no browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { exportBook as runExport } from '../lib/course-book-export.js';
import { QUOTE_PAIRS } from '../lib/footnote-syntax.js';
import { bookHtml, bookHtmlFile, bookHtmlFilename, withoutSourceQuotes } from '../ui/book/book-html.js';
import { mathPageCss } from '../ui/study-math-render.js';
import { cardOf, exportBook, GEN } from './helpers/course-book-export-book.mjs';

const exported = (patch, options = {}) => runExport(exportBook(patch), { cardOf, answerKey: true, questions: 'all', ...options });
const idsOf = html => [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
const hrefsOf = html => [...html.matchAll(/\bhref="([^"]*)"/g)].map(match => match[1]);
const bodyText = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

/** A quote full of what Markdown and HTML read as syntax; its place is the title after it. */
const TRICKY = 'Quotex *starword* and _underword_ <b>boldword</b> & {#fake} | pipeword `tickword` $mword$ ^caretword^ ~tildeword~ ※ 」tailwords';
const withTricky = () => exported({ gen: GEN.replace(/\[「Availability is the proportion of time」\]\(studyhub:\/\/source\/s1\) · Lecture 4/, () => `[「${TRICKY}」](studyhub://source/s1) · Lecture 9, p. 12`) });

test('the page: one document with a cover, a contents list and each part of the book, in the book\'s language', () => {
  const book = exported();
  const html = bookHtml(book.text, { language: book.language });
  assert.match(html, /^<!doctype html>\n<html lang="zh-CN">/);
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(html, /<title>复习全书 · SA<\/title>/);
  assert.equal([...html.matchAll(/<h1\b/g)].length, 1, 'the title once');
  assert.match(html, /<header class="cover"><h1[^>]*>复习全书 · SA<\/h1>/);
  assert.match(html, /<nav class="contents" aria-label="目录">/);
  const chapters = [...html.matchAll(/<h2 id="([^"]+)" class="chapter">/g)].map(match => match[1]);
  assert.deepEqual(chapters, ['lookup', 'h1', 'unplaced', 'answers'], 'the lookup, the chapter, 未归位 and the answer key start a page each');
  assert.deepEqual(hrefsOf(html.match(/<nav class="contents"[\s\S]*?<\/nav>/)[0]), chapters.map(id => `#${id}`), 'and the contents links to each');
  const en = bookHtml(runExport({ ...exportBook(), language: 'en', title: 'Review book · SA' }, { cardOf }).text, { language: 'en' });
  assert.match(en, /<html lang="en">/);
  assert.match(en, /aria-label="Contents"/);
  assert.match(en, /class="fn-title">Sources</);
});

test('no raw footnote or anchor marker; each mark has its footnote, in its chapter, and a way back; every link in the page goes to an element of it', () => {
  const book = exported();
  const html = bookHtml(book.text, { language: book.language });
  assert.doesNotMatch(html, /\[\^/);
  assert.doesNotMatch(html, /\{#/);
  const ids = new Set(idsOf(html));
  assert.equal(ids.size, idsOf(html).length, 'every id once');
  for (const href of hrefsOf(html)) assert.ok(ids.has(href.slice(1)), `${href} is an element of the page`);
  const marks = [...html.matchAll(/class="fnref"><a href="#(fn-[^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(marks, ['fn-h2g-1', 'fn-h2m-1', 'fn-h3g-1', 'fn-unplaced-1'], 'the marks of the book (the learner\'s own too)');
  for (const target of marks) {
    const item = html.match(new RegExp(`<li id="${target}">[\\s\\S]*?</li>`))?.[0];
    assert.ok(item, `${target} has a footnote`);
    const back = /class="fnback" href="#(fnref-[^"]+)"/.exec(item)?.[1];
    assert.ok(back && ids.has(back), `${target} leads back to its mark`);
  }
  assert.doesNotMatch(html, /<strong>出处<\/strong>/, 'the 出处 label that stood over the definitions goes with them');
  const chapter = html.slice(html.indexOf('id="h1"'), html.indexOf('id="unplaced"'));
  assert.ok(chapter.includes('Availability is the proportion of time') && chapter.includes('Throughput is requests per second'), 'a chapter\'s footnotes stand inside it');
  assert.ok(chapter.lastIndexOf('<section class="footnotes"') > chapter.lastIndexOf('吞吐量'), 'at its end');
  assert.match(html, /<li id="fn-h2g-1">「Availability is the proportion of time」 · Lecture 4/);
  assert.match(html, /<li id="fn-h2m-1">my own footnote/);
});

test('the file names no address: no link, script, picture or import from outside, and a studyhub:// link is only its words', () => {
  const book = exported();
  const md = `${book.text}\n\nSee [Practise](studyhub://practice?heading=h2&n=5) and [a site](https://example.org/x).\n\n![pic](https://example.org/p.png)\n`;
  const html = bookHtml(md, { language: 'zh' });
  assert.doesNotMatch(html, /<script|<link|<img|<iframe|<object|<embed|@import|\burl\(|\bsrc=|studyhub:/i);
  assert.deepEqual(hrefsOf(html).filter(href => !href.startsWith('#')), [], 'every href is inside the page');
  assert.doesNotMatch(html, /https?:\/\/(?!example\.org)/, 'and no namespace address either (the visible address of a link is its words)');
  assert.match(bodyText(html), /Practise and a site \(https:\/\/example\.org\/x\)\./);
});

test('maths is MathML', () => {
  const book = exported({ gen: GEN.replace('串联时 A = A1 x A2。', () => '串联时 $A = A_1 \\times A_2$。\n\n$$\\frac{MTBF}{MTBF + MTTR}$$') });
  const html = bookHtml(book.text, { language: 'zh' });
  assert.ok([...html.matchAll(/<math\b/g)].length >= 2);
  assert.match(html, /<math[^>]*display="block"/);
  assert.doesNotMatch(html, /xmlns|\$\$/);
});

test('printed: each chapter starts a page, the footnote list stays with its title, light colours', () => {
  const html = bookHtml(exported().text, { language: 'zh' });
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.match(css, /color-scheme:light/);
  assert.doesNotMatch(css, /prefers-color-scheme/);
  assert.match(css, /@page\{size:A4/);
  assert.match(css, /@media print\{[^]*h2\.chapter\{break-before:page\}/);
  assert.match(css, /\.fn-title\{[^}]*break-after:avoid/);
  assert.match(css, /\.footnotes li\{break-inside:avoid/);
});

test('narrow screens: a viewport and no fixed width that would make the page scroll sideways', () => {
  const css = bookHtml(exported().text, { language: 'zh' }).match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.doesNotMatch(css, /(?:^|[;{\s])(?:min-)?width:\s*\d+(?:\.\d+)?(?:px|pt|mm|cm|in|rem|em)\b/, 'no fixed width');
  assert.match(css, /th,td\{[^}]*overflow-wrap:anywhere/);
  assert.match(css, /img\{max-width:100%/);
});

test('without source quotes: the words quoted from the materials are not in the file, the place they came from is', () => {
  const book = withTricky();
  const withQuotes = bookHtml(book.text, { language: book.language });
  const without = bookHtml(book.text, { language: book.language, quotes: false });
  assert.match(bodyText(withQuotes), /Quotex starword and underword <b>boldword<\/b> & \{#fake\} \| pipeword tickword/, 'with the quotes: every character of the quote is shown as text, none is run');
  assert.match(withQuotes, /&lt;b&gt;boldword&lt;\/b&gt;/);
  assert.doesNotMatch(withQuotes, /<b>/);
  const text = bodyText(without);
  for (const part of ['Quotex', 'starword', 'underword', 'boldword', '{#fake}', 'pipeword', 'tickword', 'caretword', 'tildeword', '※', 'tailwords', 'Throughput is requests per second', 'Availability is the proportion']) {
    assert.ok(!text.includes(part), `the quote's "${part}" is not in the file (a footnote, or a concept of an answer card)`);
  }
  assert.doesNotMatch(without, /&lt;b&gt;|<b>|<math/, 'nor its markup');
  assert.match(without, /<li id="fn-h2g-1">（原文引文已省略） · Lecture 9, p\. 12/, 'the place (the source and its page) stays');
  assert.match(without, /<li id="fn-h3g-1">（原文引文已省略）/, 'a quote with no place says only that a quote is left out');
  assert.match(without, /<li id="fn-h2m-1">my own footnote/, 'a note the learner wrote is theirs, not a quote');
  assert.match(without, /class="fnref"><a href="#fn-h2g-1"/, 'the mark and its way back are still there');
  assert.match(without, /class="sub">[^<]*原文引文已省略/, 'and the cover says so');
  assert.doesNotMatch(withQuotes, /class="sub">[^<]*原文引文已省略/);
  assert.equal(bookHtml(book.text, { language: book.language, quotes: true }), withQuotes);
});

test('without source quotes, in English', () => {
  const book = runExport({ ...exportBook(), language: 'en', title: 'Review book · SA' }, { cardOf });
  assert.match(book.text, /“Availability is the proportion of time” · Lecture 4|「Availability is the proportion of time」 · Lecture 4/);
  const en = bookHtml(book.text.replace('「Availability is the proportion of time」', '“Availability is the proportion of time”'), { language: 'en', quotes: false });
  assert.ok(!en.includes('proportion of time'));
  assert.match(en, /\(source quote left out\) · Lecture 4/);
});

test('withoutSourceQuotes: every form a footnote quote is written in, the quote gone and the place kept; what is not a quote and code are left as they are', () => {
  const left = '（已省略）';
  const cut = text => withoutSourceQuotes(text, left);
  assert.equal(cut('[^1]: 「Some words」 · Lecture 4'), `[^1]: ${left} · Lecture 4`);
  assert.equal(cut('[^1]: “Some words” · Slides, p. 3'), `[^1]: ${left} · Slides, p. 3`);
  assert.equal(cut('[^1]: 「Some words」'), `[^1]: ${left}`);
  assert.equal(cut('[^1]: 「Some words」 (s1)'), `[^1]: ${left}`, 'the id of a source is not a place');
  assert.equal(cut('[^1]: 「a」 and 「b」 and c」 · Lecture 4'), `[^1]: ${left} · Lecture 4`, 'a closing mark inside the quote does not end it early');
  assert.equal(cut('[^1]: 「never closed words'), `[^1]: ${left}`, 'a quote that is not closed is taken whole');
  assert.equal(cut('[^1]: [「Some words」](studyhub://source/s1) · Lecture 4'), `[^1]: ${left} · Lecture 4`, 'the book\'s own form, before the export resolves its link');
  assert.equal(cut('[^h2g-1]：「Full width colon」 · L'), `[^h2g-1]: ${left} · L`);
  assert.equal(cut('[^1]: my own note'), '[^1]: my own note');
  assert.equal(cut('Text 「kept」 [^1]'), 'Text 「kept」 [^1]', 'a quote in the running text is not a footnote');
  const fenced = '```\n[^1]: 「in code」 · L\n```';
  assert.equal(cut(fenced), fenced);
  assert.equal(cut('a\r\n[^1]: 「x」 · L\r\nb'), `a\n[^1]: ${left} · L\nb`, 'line ends of either kind');
  assert.equal(cut(''), '');
});

test('withoutSourceQuotes: the 概念 lines of an answer card lose the material\'s slice and keep the name, the material and the flag; the other lines of the card stay', () => {
  const left = '（已省略）';
  const card = ['**题型**：可用性', '', '**识别信号**', '', '- 「可用性」：「求系统可用性」', '', '**概念**', '', '- **可用性**（资料：Lecture 4）：「Availability is the proportion of time」', '- **MTTR**：「mean time to repair」（未核实）', '',
    '**假设**', '', '- 「mean」 stays'].join('\n');
  const cutCard = withoutSourceQuotes(card, left);
  assert.equal(cutCard, card.replace('「Availability is the proportion of time」', left).replace('「mean time to repair」', left));
  assert.match(cutCard, /- 「可用性」：「求系统可用性」/, 'the stem\'s words an answer card quotes are the question\'s');
  const en = ['**Concepts**', '', '- **Availability** (Material: Lecture 4): “A quote, with “inner” marks”', '- **MTTR**: “repair time” (not verified)', '', 'After.'].join('\n');
  assert.equal(withoutSourceQuotes(en, '(left out)'), ['**Concepts**', '', '- **Availability** (Material: Lecture 4): (left out)', '- **MTTR**: (left out) (not verified)', '', 'After.'].join('\n'));
  assert.equal(withoutSourceQuotes('- **x**：「not under the label」', left), '- **x**：「not under the label」');
  assert.equal(withoutSourceQuotes('**概念**\n\n- plain bullet without a quote\n- **y**：「cut」', left), '**概念**\n\n- plain bullet without a quote\n- **y**：（已省略）');
});

test('the file is named after the Markdown file of the export', () => {
  assert.equal(bookHtmlFilename('复习全书-SA-含答案册.md'), '复习全书-SA-含答案册.html');
  assert.equal(bookHtmlFilename('book'), 'book.html');
  assert.equal(bookHtmlFilename(''), 'book.html');
});

test('withoutSourceQuotes: a definition the renderer reads in any of its shapes is cut: indented, in a blockquote or a list, over several lines', () => {
  const left = '（已省略）';
  const cut = text => withoutSourceQuotes(text, left);
  assert.equal(cut('  [^1]: 「indented words」 · L'), `  [^1]: ${left} · L`);
  assert.equal(cut('> [^1]: 「quoted words」 · L'), `> [^1]: ${left} · L`);
  assert.equal(cut('> > [^1]: 「twice quoted」 · L'), `> > [^1]: ${left} · L`);
  assert.equal(cut('- [^1]: 「listed words」 · L'), `- [^1]: ${left} · L`);
  assert.equal(cut('1. [^1]: 「numbered words」 · L'), `1. [^1]: ${left} · L`);
  assert.equal(cut('[^1]: 「first line\n    line two」 · L\nnext'), `[^1]: ${left} · L\nnext`, 'the continuation lines are part of the note');
  assert.equal(cut('[^1]: 「first line\n\tline two」 · L\n\nnext'), `[^1]: ${left} · L\n\nnext`, 'a tab indents too');
  assert.equal(cut('> [^1]: 「first\n>     second」 · L'), `> [^1]: ${left} · L`, 'in a blockquote too');
  assert.equal(cut('[^1]: my note\n    goes on'), '[^1]: my note\n    goes on', 'a note of the learner\'s is left as it was, its lines too');
  assert.equal(cut('[^1]: 「a」 · L\nnot indented'), `[^1]: ${left} · L\nnot indented`, 'a line that is not indented ends the note');
  const html = bookHtml(['# T', '', '## C {#c}', '', 'Word [^1] and [^2] and [^3].', '', '  [^1]: 「indentedsecret」 · L1', '', '> [^2]: 「quotedsecret」 · L2', '',
    '[^3]: 「twolinesecret', '    second」 · L3'].join('\n'), { language: 'zh', quotes: false });
  assert.doesNotMatch(html, /secret/);
  assert.match(html, /<li id="fn-1">（原文引文已省略） · L1/);
  assert.match(html, /<li id="fn-3">（原文引文已省略） · L3/);
});

test('withoutSourceQuotes: the quotation marks are the writer\'s own table (lib/book-footnotes.js), the plain apostrophe included', () => {
  const left = '（已省略）';
  assert.equal(withoutSourceQuotes('[^1]: \'exact words\' (s1)', left), `[^1]: ${left}`);
  assert.equal(withoutSourceQuotes('[^1]: \'exact words\' · L', left), `[^1]: ${left} · L`);
  for (const [open, close] of Object.entries(QUOTE_PAIRS)) assert.equal(withoutSourceQuotes(`[^1]: ${open}some words${close} · L`, left), `[^1]: ${left} · L`, `${open}…${close}`);
  assert.ok(Object.keys(QUOTE_PAIRS).includes('「') && Object.keys(QUOTE_PAIRS).includes('“') && Object.keys(QUOTE_PAIRS).includes("'"));
});

test('with or without quotes the page has the same footnotes, also when the colon is full width', () => {
  const md = ['# T', '', '## C {#c}', '', 'Word [^x].', '', '[^x]：「q words」 · L'].join('\n');
  for (const quotes of [true, false]) {
    const html = bookHtml(md, { language: 'zh', quotes });
    assert.match(html, /class="fnref"><a href="#fn-x"/, `quotes ${quotes}: the mark is a reference`);
    assert.match(html, /<li id="fn-x">/, `quotes ${quotes}: with its footnote`);
    assert.doesNotMatch(html, /\[\^|：「/);
  }
});

test('the file the dialog saves: made from the text and language of the export, named after its file, with the formula fonts', async () => {
  const book = exported(), mathCss = await mathPageCss();
  assert.deepEqual(await bookHtmlFile(book, { quotes: false }), { filename: '复习全书-SA-含答案册.html', html: bookHtml(book.text, { language: 'zh', quotes: false, mathCss }) });
  assert.equal((await bookHtmlFile(book)).html, bookHtml(book.text, { language: 'zh', quotes: true, mathCss }), 'with the quotes by default');
  const withFormula = bookHtml('# Book\n\n## One\n\nInline $\\mathbb{E}[X]$.', { language: 'en', mathCss });
  assert.ok(withFormula.includes(mathCss), 'a page with a formula carries the stylesheet, the fonts and their notices');
});
