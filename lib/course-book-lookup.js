/* 查找页 of the 复习全书 (M6, docs/plans/review-book.md): the pages that lead the printed book (开卷速查) and the page's 「查找」 view, so that in an
   open-book exam a question leads to "which section, which definition, which steps". Generated from the book every time, never kept or edited by
   hand; every entry points to a STABLE heading code (I4: the heading's id, `h12` -> H12, never renumbered when sections are inserted or moved).
   Pure, browser-safe.

   bookLookup(book, { caseTypes, answerCards }) -> { language, toc, answerOrder, types, concepts, mistakes, places } | null
     book: course.book.open's answer ({ status, title, language, nodes, unplaced }).
     toc:      [{ id, code, level, title }] every heading of the stitched book, the book's own title left out (a heading the learner typed too).
     types:    the question types (lib/case-types.js; `caseTypes` with `own: true` on a course's own) that have an answer card in the book, or are the
               course's own: { id, label, signals, steps, formulas, mistakes, costs, places, cards } — the 速查表 row 题型 → 检查顺序/公式 → 最常见错误/代价.
     concepts: [{ term, places, from }] the terms of the answer cards' concepts, of bold defined terms in the files (`**term**` starting a definition
               sentence — followed by ：/: or 是/指/即/is/means… —, or any bold term of a 「定义」 line) and of explicit `[[term]]` markers in any file.
     mistakes: [{ hid, code, number, title, items: [{ kind: 'asked' | 'pitfall', text, deckId?, cardId? }] }] per point: the follow-ups put into the book
               (sh:qa blocks, what the learner had to ask) and the answer cards' 易错检查.
     places:   [{ hid, code, number, title }] the points (and 未归位) in reading order; every `places` above is a list of these hids.
     `answerCards`: [{ deckId, cardId, prompt, hid, questionType: { id, label }, concepts: [{ name }], pitfalls, cost }] (lib/course-book-cards.js).
   renderLookup(lookup, { number }) -> the Markdown front matter of the export; `number(deckId, cardId, hid)` the numbered question (H12-Q3) or null. */
import { bookIndex, stitchBook } from './course-book-links.js';
import { qaBlocks } from './course-book-qa-text.js';
import { answerCardWords } from './answer-card.js';
import { answerOrderWords, typeLabel } from './case-types.js';

/** The stable code of a heading id (h12 -> H12); 未归位 is U. */
export const codeOf = hid => (hid === 'unplaced' ? 'U' : String(hid ?? '').toUpperCase());

const NOPRINT = /<!-- sh:noprint -->[\s\S]*?<!-- \/sh:noprint -->/g;
/** A text without its `<!-- sh:noprint -->…<!-- /sh:noprint -->` regions (left out of the export and its page estimate). A marker never closed is taken
    out alone: its text stays (a print never loses text silently). */
export const withoutNoprint = text => String(text ?? '').replace(NOPRINT, '').replace(/<!-- \/?sh:noprint -->/g, '');
/** The noprint markers taken out, the text kept (the page's preview). */
export const withoutNoprintMarkers = text => String(text ?? '').replace(/<!-- \/?sh:noprint -->/g, '');
const TERM_MARK = /\[\[([^[\]\n]{1,40})\]\]/g;
/** `[[term]]` as the term (the preview and the export show the word; the 按概念 page lists it). */
export const plainTerms = text => String(text ?? '').replace(TERM_MARK, '$1');

const WORDS = {
  zh: { lookup: '查找', toc: '目录', types: '按题型', concepts: '按概念', mistakes: '易错点（按知识点）', order: '答题顺序', head: ['题型 · 题干信号', '检查顺序 · 公式', '最常见错误 · 必须交代的代价'],
    formula: '公式', cost: '代价', where: '在哪里', asked: '问过', pitfall: '易错', sep: '：', list: '、', semi: '；', arrow: ' → ', paren: text => `（${text}）` },
  en: { lookup: 'Lookup', toc: 'Contents', types: 'By question type', concepts: 'By concept', mistakes: 'Mistakes by point', order: 'Answer order',
    head: ['Type · signals in the stem', 'Steps · formulas', 'Common mistakes · the cost to state'], formula: 'Formulas', cost: 'Cost', where: 'Where', asked: 'Asked',
    pitfall: 'Pitfall', sep: ': ', list: ', ', semi: '; ', arrow: ' → ', paren: text => ` (${text})` },
};
/** The words of the 查找页 in a language (the page uses the same). */
export const lookupWords = language => WORDS[language === 'en' ? 'en' : 'zh'];

const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const clip = (text, max) => { const value = squash(text); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };
const keyOf = text => squash(text).normalize('NFKC').toLowerCase();
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const leavesOf = nodes => (nodes || []).flatMap(node => (node.leaf ? [node] : leavesOf(node.children)));

// The bold labels the book writes itself (the generated file, the Q&A and answer-card blocks): never a defined term.
const LABELS = new Set(['考情', '知识梳理', '讲解', '例子', '补充（资料以外）', '出处', '本节问答', '本节的题', '追问', '答', '分析题答案卡', '定义', '关于',
  'In the sample papers', 'Key points', 'Explanation', 'Example', 'Extra (beyond the materials)', 'Sources', 'Questions and answers', 'Questions of this point',
  'Follow-up', 'Answer', 'Answer card', 'Definition', 'About',
  ...['zh', 'en'].flatMap(language => Object.values(answerCardWords(language)).filter(value => typeof value === 'string'))].map(keyOf));
const FENCE = /^\s*(```|~~~)/;
const PREFIX = /^\s*(?:>\s*)*(?:(?:[-*+]|\d{1,3}[.)、])\s+)?/;
const BOLD_START = /^\*\*([^*\n]{1,40}?)\*\*/;
const SEPARATOR = /^\s*(?:[（(][^）)\n]{0,40}[）)]\s*)?(?:[:：=]|是|指|即|——|—|(?:is|are|means|refers to)\b)/u;
const DEFINITION_LINE = /^(?:\*\*)?\s*(?:定义|definition)\s*[:：]?\s*(?:\*\*)?\s*[:：]/iu;
const BOLD = /\*\*([^*\n]{1,40}?)\*\*/g;
/** A term as listed: footnote marks and a trailing colon off, spaces squashed; '' for a label of the book or nothing usable. */
function cleanTerm(raw) {
  const term = squash(String(raw ?? '').replace(/\[\^[^\]]*\]/g, '')).replace(/[:：]+$/u, '').trim();
  return term && term.length <= 40 && !/[[\]]/.test(term) && !LABELS.has(keyOf(term)) ? term : '';
}

/** The terms a text defines: [{ term, from: 'bold' | 'marker' }] in order (lines inside code fences are left alone). */
export function definedTerms(text) {
  const out = [];
  let fenced = false;
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) { fenced = !fenced; continue; }
    if (fenced) continue;
    for (const match of line.matchAll(TERM_MARK)) out.push({ term: match[1], from: 'marker' });
    const body = line.replace(PREFIX, '');
    if (DEFINITION_LINE.test(body)) { for (const match of body.matchAll(BOLD)) out.push({ term: match[1], from: 'bold' }); continue; }
    const bold = BOLD_START.exec(body);
    if (bold && (/[:：]\s*$/u.test(bold[1]) || SEPARATOR.test(body.slice(bold[0].length)))) out.push({ term: bold[1], from: 'bold' });
  }
  return out.map(item => ({ ...item, term: cleanTerm(item.term) })).filter(item => item.term);
}

/** The question of a Q&A block (its first quoted line, the bold label off). */
const askedOf = raw => {
  const line = String(raw).split('\n').find(item => /^>\s*\S/.test(item));
  return line ? clip(line.replace(/^>\s*/, '').replace(/^\*\*[^*\n]*\*\*\s*/, ''), 200) : '';
};

/** The 查找页 of a book (see the top of this file). */
export function bookLookup(book, { caseTypes = [], answerCards = [] } = {}) {
  if (book?.status !== 'ok') return null;
  const language = book.language === 'en' ? 'en' : 'zh';
  const places = [...leavesOf(book.nodes).map(leaf => ({ hid: leaf.hid, number: leaf.number, title: leaf.title, texts: [leaf.gen, leaf.mine, leaf.qa] })),
    ...(String(book.unplaced?.text ?? '').trim() ? [{ hid: 'unplaced', number: '', title: book.unplaced.title, texts: [book.unplaced.text] }] : [])];
  const order = new Map(places.map((place, at) => [place.hid, at]));
  const inOrder = hids => [...new Set(hids.filter(hid => order.has(hid)))].sort((a, b) => order.get(a) - order.get(b));
  // A heading the learner typed is listed under its point, never above the point's own level (as the export prints it).
  const outline = new Set(), collect = list => (list || []).forEach(node => { outline.add(node.hid); collect(node.children); });
  collect(book.nodes);
  outline.add('unplaced');
  let under = 1;
  const toc = bookIndex(stitchBook({ title: book.title, nodes: book.nodes, unplaced: book.unplaced })).flat.filter(entry => entry.id && entry.id !== 'book').map(entry => {
    const level = outline.has(entry.id) ? entry.level : Math.min(6, Math.max(entry.level, under + 1));
    if (outline.has(entry.id)) under = entry.level;
    return { id: entry.id, code: codeOf(entry.id), level, title: plainTerms(entry.title) };
  });
  const cards = (Array.isArray(answerCards) ? answerCards : []).filter(card => card && card.cardId);

  const terms = new Map();
  const add = (raw, hid, from) => {
    const term = cleanTerm(raw);
    if (!term || !order.has(hid)) return;
    const key = keyOf(term), item = terms.get(key) || { term, places: [], from: [] };
    terms.set(key, { ...item, places: inOrder([...item.places, hid]), from: [...new Set([...item.from, from])].sort() });
  };
  for (const place of places) for (const text of place.texts) for (const found of definedTerms(text)) add(found.term, place.hid, found.from);
  for (const card of cards) for (const concept of card.concepts || []) add(concept?.name, card.hid, 'card');
  const concepts = [...terms.values()].sort((a, b) => compare(keyOf(a.term), keyOf(b.term)) || compare(a.term, b.term));

  const known = new Set(caseTypes.map(type => type.id));
  const typeOf = card => (known.has(card.questionType?.id) ? card.questionType.id : 'general');
  const types = caseTypes.flatMap(type => {
    const own = cards.filter(card => typeOf(card) === type.id);
    if (!own.length && !type.own) return [];
    const unique = list => [...new Map(list.map(item => [keyOf(item), squash(item)])).values()].filter(Boolean);
    return [{ id: type.id, label: typeLabel(type, language), signals: (type.signals || []).slice(0, 6), steps: type.steps || [], formulas: type.formulas || [],
      mistakes: unique([...(type.mistakes || []), ...own.flatMap(card => card.pitfalls || [])]).slice(0, 8), costs: unique(own.map(card => clip(card.cost, 160))).slice(0, 3),
      places: inOrder(own.map(card => card.hid)), cards: own.map(card => ({ deckId: card.deckId, cardId: card.cardId, hid: order.has(card.hid) ? card.hid : null, prompt: clip(card.prompt, 120) })) }];
  });

  const mistakes = places.flatMap(place => {
    const items = [], seen = new Set();
    const push = item => { const key = `${item.kind}\u0000${keyOf(item.text)}`; if (item.text && !seen.has(key)) { seen.add(key); items.push(item); } };
    for (const text of place.texts) for (const block of qaBlocks(text)) push({ kind: 'asked', text: askedOf(block.raw), cardId: block.cardId });
    for (const card of cards.filter(item => item.hid === place.hid)) for (const pitfall of card.pitfalls || []) push({ kind: 'pitfall', text: clip(pitfall, 200), deckId: card.deckId, cardId: card.cardId });
    return items.length ? [{ hid: place.hid, code: codeOf(place.hid), number: place.number, title: place.title, items }] : [];
  });
  return { language, toc, answerOrder: answerOrderWords(language), types, concepts, mistakes,
    places: places.map(place => ({ hid: place.hid, code: codeOf(place.hid), number: place.number, title: place.title })) };
}

const cell = text => String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
const ref = hid => `[${codeOf(hid)}](#${hid})`;
const circled = at => (at < 20 ? String.fromCodePoint(0x2460 + at) : `(${at + 1})`);

/** The 查找页 as Markdown (the front matter of the export): 目录, 按题型 (the 速查表), 按概念, 易错点; a part with nothing in it is left out. Deterministic. */
export function renderLookup(lookup, { number = () => null } = {}) {
  if (!lookup) return '';
  const w = lookupWords(lookup.language), out = [`## ${w.lookup} {#lookup}`, '', `### ${w.toc} {#lookup-toc}`, ''];
  let depth = -1;
  for (const entry of lookup.toc) {
    depth = Math.max(0, Math.min(entry.level - 2, depth + 1));
    out.push(`${'  '.repeat(depth)}- ${ref(entry.id)} ${squash(entry.title)}`);
  }
  if (lookup.types.length) {
    out.push('', `### ${w.types} {#lookup-types}`, '', `**${w.order}**${w.sep}${lookup.answerOrder.join(w.arrow)}`, '', `| ${w.head.join(' | ')} |`, '| --- | --- | --- |');
    for (const type of lookup.types) {
      const numbered = type.cards.map(card => (card.hid ? number(card.deckId, card.cardId, card.hid) : null)).filter(Boolean);
      const where = type.places.length ? ` · ${w.where}${w.sep}${type.places.map(ref).join(w.list)}${numbered.length ? w.paren(numbered.join(w.list)) : ''}` : '';
      const first = `**${type.label}**${type.signals.length ? w.paren(type.signals.join(w.list)) : ''}${where}`;
      const steps = [...type.steps.map((step, at) => `${circled(at)} ${step}`), ...(type.formulas.length ? [`${w.formula}${w.sep}${type.formulas.join(w.semi)}`] : [])].join(' ');
      const traps = [...type.mistakes, ...(type.costs.length ? [`${w.cost}${w.sep}${type.costs.join(w.semi)}`] : [])].join(w.semi);
      out.push(`| ${cell(first)} | ${cell(steps)} | ${cell(traps)} |`);
    }
  }
  if (lookup.concepts.length) {
    out.push('', `### ${w.concepts} {#lookup-concepts}`, '');
    for (const concept of lookup.concepts) out.push(`- **${concept.term}**${w.sep}${concept.places.map(ref).join(w.list)}`);
  }
  if (lookup.mistakes.length) {
    out.push('', `### ${w.mistakes} {#lookup-mistakes}`, '');
    for (const place of lookup.mistakes) {
      out.push(`- ${ref(place.hid)} ${squash(`${place.number} ${place.title}`)}`);
      for (const item of place.items) {
        const at = item.kind === 'pitfall' ? number(item.deckId, item.cardId, place.hid) : null;
        out.push(`  - ${item.kind === 'asked' ? w.asked : w.pitfall}${w.sep}${item.text}${at ? w.paren(at) : ''}`);
      }
    }
  }
  return `${out.join('\n')}\n`;
}
