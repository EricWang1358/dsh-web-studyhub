import { templateParts } from './exam-kit-model.js';

/* The 速查表 of the review book as ONE self-contained HTML page (#710 S5): the page the 速查表 view shows in a frame, the browser prints (its @media print
   makes A4 pages of two columns without anything around them), and the learner saves as a .html file that opens offline on a computer or a phone. Inline
   style only, no script, no font, no image, no address: formulas are MathML drawn by the browser itself (ui/study-math-render.js). Drawn from
   ui/book/cheat-sheet-model.js, in the language of the book (the words are below, like lib/course-book-lookup.js's). Pure, no React.

   cheatSheetHtml(sheet, { formula, links }) -> the page.
     formula(source) -> MathML | null: how a formula given as TeX is drawn (null, or none given: its source as text).
     links: true (the view): a point's code is a link `data-go="<hid>"` the view turns into "open the book there"; the saved file has no book to go to. */

const WORDS = {
  zh: { lang: 'zh-CN', sheet: '速查表', templates: '答题模板', matrix: '题干信号矩阵', compare: '易混对照', formulas: '公式', cards: '术语卡', signals: '题干信号', fills: '真题怎么填', points: '知识点',
    papers: '真题', template: '模板', asks: '考查本质与切入点', words: '题干原词', page: n => `第 ${n} 页`, pitch: '考场原句', counts: { cards: '术语卡', types: '答题模板', confusables: '易混对照', formulas: '公式' },
    kinds: { related: '相关概念', opposite: '对立概念', parallel: '并列概念', part: '子概念' }, aspects: { what: '是什么', when: '什么时候用', difference: '区别', mistake: '最常见的错' },
    vs: ' 对 ', file: title => (title ? `${title} 速查表` : '速查表'), unplaced: '未归位', nav: '目录' },
  en: { lang: 'en', sheet: 'Cheat sheet', templates: 'Answer templates', matrix: 'Question-signal matrix', compare: 'Confusable pairs', formulas: 'Formulas', cards: 'Term cards', signals: 'Signals in the stem',
    fills: 'How past questions fill it', points: 'Points', papers: 'Past papers', template: 'Template', asks: 'What is really tested', words: 'Trigger words', page: n => `p. ${n}`, pitch: 'Exam pitch',
    counts: { cards: 'Term cards', types: 'Answer templates', confusables: 'Confusable pairs', formulas: 'Formulas' },
    kinds: { related: 'Related', opposite: 'Opposite', parallel: 'Parallel', part: 'Part' }, aspects: { what: 'What it is', when: 'When to use', difference: 'Difference', mistake: 'Common mistake' },
    vs: ' vs ', file: title => (title ? `${title} - cheat sheet` : 'cheat sheet'), unplaced: 'Unplaced', nav: 'Contents' },
};
const wordsOf = language => WORDS[language === 'en' ? 'en' : 'zh'];

const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The name a saved sheet gets: the book's title and the sheet's word, with no character a file name cannot hold. */
export function cheatSheetFilename({ title, language }) {
  const safe = String(title ?? '').replace(/[\\/:*?"<>|\s]+/g, ' ').trim();
  return `${wordsOf(language).file(safe)}.html`;
}

/** Is a gist TeX (or an equation of symbols) rather than a sentence? A sentence stays text: drawn as math its words would run together. */
const isFormula = source => /[\\^_{}$]/.test(source) || (/[=<>≤≥≈≠]/.test(source) && !/\p{L}{3,}/u.test(source));
function drawFormula(source, formula) {
  const tex = String(source ?? '').replace(/^\s*\$\$?|\$\$?\s*$/g, '').trim();
  // The MathML namespace address is an HTML parser's business, not the page's: it reads <math> without it, and the file then names no address at all.
  const drawn = tex && isFormula(source) && formula ? formula(tex, false)?.replace(/ xmlns="[^"]*"/g, '') : null;
  return drawn ? `<span class="math">${drawn}</span>` : `<code>${esc(source)}</code>`;
}

const CSS = `
:root{color-scheme:light;--ink:#15171a;--mute:#555b63;--line:#c9ced4;--soft:#f2f4f6;--accent:#1f4f8a;--mark:#fff3bf}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:12px 16px 32px;font:14px/1.45 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);background:#fff}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
h1{margin:0;font-size:1.35rem;line-height:1.25}
h1 small{font-weight:500;color:var(--mute);font-size:.9rem;margin-left:.4em}
h2{margin:1.4rem 0 .5rem;padding:.25rem .5rem;font-size:1.05rem;background:var(--soft);border-left:4px solid var(--ink);break-after:avoid}
h3{margin:.9rem 0 .35rem;font-size:.95rem;break-after:avoid}
p{margin:.2rem 0}
code{font:.92em/1.3 ui-monospace,Consolas,monospace;overflow-wrap:anywhere}
.sub{color:var(--mute);font-size:.85rem}
.nav{display:flex;flex-wrap:wrap;gap:.25rem .9rem;margin:.5rem 0 0;font-size:.85rem}
.cols{column-width:21rem;column-gap:1.4rem}
.box{break-inside:avoid;margin:0 0 .55rem;padding:.35rem .5rem;border:1px solid var(--line);border-radius:3px;background:#fff}
.box h4{margin:0 0 .15rem;font-size:.92rem}
.code{display:inline-block;margin-right:.3em;padding:0 .3em;font:700 .8em/1.4 ui-monospace,Consolas,monospace;border:1px solid var(--ink);border-radius:2px}
.alt,.mute{color:var(--mute)}
.pitch{font-style:italic}
.label{margin-right:.35em;font-weight:700;font-size:.82em;color:var(--mute)}
.rel a{white-space:nowrap}
.sep{margin:0 .3em;color:var(--mute)}
.pt{font-size:.82rem;color:var(--mute)}
.pt b{font-family:ui-monospace,Consolas,monospace;color:var(--ink)}
.tpl{white-space:pre-line;padding:.25rem .4rem;background:var(--soft);border-left:3px solid var(--ink)}
.slot{background:var(--mark);color:inherit;padding:0 .15em;border:1px dashed var(--ink);border-radius:2px;font-weight:700}
ul.plain{margin:.2rem 0;padding:0;list-style:none}
ul.plain li{margin:.15rem 0}
table{width:100%;border-collapse:collapse;font-size:.88rem}
th,td{border:1px solid var(--line);padding:.2rem .4rem;text-align:left;vertical-align:top}
th{background:var(--soft)}
.math{font-size:1.05em}
.math math{font-size:1.1em}
.fm{break-inside:avoid;margin:0 0 .5rem;padding:.3rem .5rem;border-bottom:1px dotted var(--line)}
@media (max-width:40rem){
  body{padding:10px 12px 28px}
  .mx thead{display:none}
  .mx,.mx tbody,.mx tr,.mx td{display:block;width:100%}
  .mx tr{margin:0 0 .5rem;border:1px solid var(--line)}
  .mx td{border:0;border-bottom:1px solid var(--soft)}
  .mx td:empty{display:none}
  .mx td::before{content:attr(data-head);display:block;font-size:.75rem;font-weight:700;color:var(--mute)}
}
@page{size:A4;margin:9mm 9mm}
@media print{
  html,body{background:#fff}
  body{padding:0;font-size:8pt;line-height:1.28;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  h1{font-size:12pt}
  h2{margin:7pt 0 3pt;font-size:9.5pt;padding:1.5pt 4pt}
  h3{margin:5pt 0 2pt;font-size:8.5pt}
  .nav{display:none}
  a{color:inherit}
  .cols{column-count:2;column-width:auto;column-gap:5mm}
  .box{margin-bottom:3pt;padding:2pt 3.5pt}
  .box h4{font-size:8.3pt}
  table{font-size:7.5pt}
  th,td{padding:1pt 2.5pt}
  .mx tr{break-inside:avoid}
}
`;

const point = (place, links) => (place ? `<span class="pt">${links ? `<a href="#" data-go="${esc(place.hid)}"><b>${esc(place.code)}</b></a>` : `<b>${esc(place.code)}</b>`} ${esc([place.number, place.title].filter(Boolean).join(' '))}</span>` : '');
const where = (entry, words, links) => [point(entry.place, links), Number.isInteger(entry.page) ? `<span class="pt">${esc(words.page(entry.page))}${entry.material ? ` · ${esc(entry.material)}` : ''}</span>` : ''].filter(Boolean).join(' · ');
/** A card's number as a link to the card when the sheet holds it; any other text stays text. */
const codeLink = (code, known) => (known.has(code) ? `<a href="#${esc(code)}">${esc(code)}</a>` : esc(code));

function templateBox(type, words, links) {
  const body = templateParts(type.template).map(part => (part.slot ? `<mark class="slot">${esc(part.text)}</mark>` : esc(part.text))).join('');
  return `<article class="box" id="${esc(type.code)}"><h4><span class="code">${esc(type.code)}</span>${esc(type.name)}</h4>
${type.signals.length ? `<p class="mute"><span class="label">${words.signals}</span>${esc(type.signals.join(' · '))}</p>` : ''}${type.asks ? `<p>${esc(type.asks)}</p>` : ''}
<p class="tpl">${body}</p>
${type.fills.length ? `<p class="label">${words.fills}</p><ul class="plain">${type.fills.map(fill => `<li><b>${esc(fill.ref)}</b> ${esc(fill.fill)}</li>`).join('')}</ul>` : ''}
${type.places.length ? `<p>${type.places.map(place => point(place, links)).join('<span class="sep">·</span>')}</p>` : ''}</article>`;
}

function matrix(types, words, links) {
  const heads = [words.words, words.asks, words.template, words.points, words.papers];
  const cell = (head, html) => `<td data-head="${esc(head)}">${html}</td>`;
  return `<table class="mx"><thead><tr>${heads.map(head => `<th scope="col">${esc(head)}</th>`).join('')}</tr></thead><tbody>${types.map(type => `<tr>
${cell(heads[0], esc(type.signals.join(' · ')))}${cell(heads[1], esc(type.asks))}${cell(heads[2], `<a href="#${esc(type.code)}">${esc(type.code)}</a>`)}
${cell(heads[3], type.places.map(place => point(place, links)).join('<br>'))}${cell(heads[4], esc(type.anchors.join(' · ')))}</tr>`).join('')}</tbody></table>`;
}

function pairBox(pair, words, known) {
  const items = pair.items.length ? `<p class="mute">${pair.items.map(code => codeLink(code, known)).join('<span class="sep">·</span>')}</p>` : '';
  return `<article class="box" id="${esc(pair.id)}"><h4><span class="code">${esc(pair.id)}</span>${pair.names.map(esc).join(words.vs)}</h4>${items}
<table><thead><tr><th></th>${pair.names.map(name => `<th scope="col">${esc(name)}</th>`).join('')}</tr></thead><tbody>${pair.rows.map(row => `<tr><th scope="row">${esc(words.aspects[row.aspect])}</th>${row.cells.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></article>`;
}

function relations(card, words, known) {
  return Object.keys(words.kinds).map(kind => {
    const own = card.relations.filter(relation => relation.kind === kind);
    return own.length ? `<p class="rel"><span class="label">${words.kinds[kind]}</span>${own.map(relation => (relation.code && known.has(relation.code)
      ? `<a href="#${esc(relation.code)}">${esc(relation.name)} ${esc(relation.code)}</a>` : esc(relation.name))).join('<span class="sep">·</span>')}</p>` : '';
  }).join('');
}

function cardBox(card, words, known, links) {
  return `<article class="box" id="${esc(card.code)}"><h4><span class="code">${esc(card.code)}</span>${esc(card.name)}${card.alt ? ` <span class="alt">${esc(card.alt)}</span>` : ''}</h4>
${card.plain ? `<p>${esc(card.plain)}</p>` : ''}${card.pitch ? `<p class="pitch"><span class="label">${words.pitch}</span>${esc(card.pitch)}</p>` : ''}${relations(card, words, known)}<p>${where(card, words, links)}</p></article>`;
}

function formulaItem(entry, words, formula, known, links) {
  return `<div class="fm"><p><b>${esc(entry.term)}</b>${entry.code ? ` ${codeLink(entry.code, known)}` : ''}</p><p>${drawFormula(entry.gist, formula)}</p><p>${where(entry, words, links)}</p></div>`;
}

const part = (id, title, body) => `<section id="${id}"><h2>${esc(title)}</h2>\n${body}</section>`;

/** The sheet (ui/book/cheat-sheet-model.js cheatSheet) as the page. */
export function cheatSheetHtml(sheet, { formula = null, links = false } = {}) {
  const words = wordsOf(sheet.language), known = new Set(sheet.chapters.flatMap(chapter => chapter.cards.map(card => card.code)));
  const parts = [];
  if (sheet.kit) {
    parts.push(['sheet-templates', words.templates, part('sheet-templates', words.templates, `<div class="cols">${sheet.kit.types.map(type => templateBox(type, words, links)).join('\n')}</div>`)]);
    parts.push(['sheet-matrix', words.matrix, part('sheet-matrix', words.matrix, matrix(sheet.kit.types, words, links))]);
  }
  if (sheet.confusables.length) parts.push(['sheet-compare', words.compare, part('sheet-compare', words.compare, `<div class="cols">${sheet.confusables.map(pair => pairBox(pair, words, known)).join('\n')}</div>`)]);
  if (sheet.formulas.length) parts.push(['sheet-formulas', words.formulas, part('sheet-formulas', words.formulas, `<div class="cols">${sheet.formulas.map(entry => formulaItem(entry, words, formula, known, links)).join('\n')}</div>`)]);
  if (sheet.chapters.length) parts.push(['sheet-cards', words.cards, part('sheet-cards', words.cards, sheet.chapters.map(chapter => `<h3>${esc([chapter.number, chapter.title].filter(Boolean).join(' '))}</h3>
<div class="cols">${chapter.cards.map(card => cardBox(card, words, known, links)).join('\n')}</div>`).join('\n'))]);
  const { counts } = sheet, name = [sheet.title, words.sheet].filter(Boolean).join(' · ');
  return `<!doctype html>
<html lang="${words.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)}</title>
<style>${CSS}</style>
</head>
<body>
<header><h1>${esc(sheet.title)}<small>${esc(words.sheet)}</small></h1>
<p class="sub">${esc(Object.keys(words.counts).filter(key => counts[key]).map(key => `${words.counts[key]} ${counts[key]}`).join(' · '))}</p>
<nav class="nav" aria-label="${esc(words.nav)}">${parts.map(([id, title]) => `<a href="#${id}">${esc(title)}</a>`).join('')}</nav></header>
<main>
${parts.map(item => item[2]).join('\n')}
</main>
</body>
</html>
`;
}
