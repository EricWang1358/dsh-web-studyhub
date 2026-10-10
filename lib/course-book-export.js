/* The export of the 复习全书 (M6, docs/plans/review-book.md, I10): the learner's printable CP (开卷速查教材) as ordinary Markdown that Pandoc reads.
   Pure, browser-safe, deterministic (same book -> same bytes: no time, no random, a fixed order everywhere).

   exportBook(book, { cardOf, answerCards, caseTypes, form: 'single' | 'folder', answerKey, questions: 'linked' | 'all' | 'none' }) ->
     { form, title, language, filename, text?, files?, manifest?, questions, estimate: { pages, book, withAnswers, columns, rows } }
   book: course.book.open's answer with all of every point's questions. In order: the book's title, the 查找页 (lib/course-book-lookup.js renderLookup),
   then for each node its heading (`## 1.2 Title 〔H12〕 {#h12}`: the stable code in the margin, the heading id as Pandoc's anchor), a point's generated
   file, its questions, the learner's file, its Q&A file (the AI blocks woven in after their paragraphs, as the page shows them), 未归位 last, and with
   `answerKey` the 答案册.
     - Marker comments go: `sh:id` becomes the `{#id}` anchor and the 〔code〕; the lines of `sh:qa`, `sh:card`, `sh:ai` blocks go, their content stays;
       `<!-- sh:noprint -->…<!-- /sh:noprint -->` is left out (of the estimate too); `[[term]]` is the term.
     - A question link (studyhub://card) becomes the numbered question: `**H12-Q3** stem`, with the options of a choice question (A., B., …) the first
       time it appears in its point. `questions` (QUESTION_MODES): 'linked' (the default) prints only the questions the book's text links (a Q&A
       file's, the learner's); 'all' also prints every point's own questions under 本节的题, numbered first in the page's order (Q1…); 'none' prints
       no question (its links go). The answer key and the estimate follow what is printed.
       A link to a question that is gone (deleted, suspended, in an archived deck) is left out. 练 N 道 (practice) and 本节问答 (qa) links are dropped;
       a 出处 (source) link keeps its words.
     - Footnotes are named per file (`[^<hid><g|m|q>-<n>]`), so stitched files never collide.
     - 答案册: per point, the same numbers: the answer (the right options of a choice question, the blanks of a cloze), the explanation, an answer card
       in full (lib/answer-card.js renderAnswerCard).
   `single`: one Markdown text. `folder`: the files (`000-front.md`, `001-h3.gen.md`, …) and the manifest `book.yaml` listing them in order; the files
   joined with one newline are the single text, so `pandoc $(sed -n 's/^  - //p' book.yaml)` reads the same book.
   estimate: A4 pages by a fixed rule (PAGE_RULE: about 40 Chinese characters or 80 other characters a line, 45 lines a page, a blank line half a line):
   an estimate, never a measurement. */
import { aiBlocks, weaveBlocks, withoutAiBlocks } from './course-book-ai-text.js';
import { closeFences, namespaceFootnotes, parseBookLink } from './course-book-links.js';
import { renderAnswerCard } from './answer-card.js';
import { bookLookup, codeOf, renderLookup, withoutNoprint, plainTerms } from './course-book-lookup.js';

export const EXPORT_FORMS = Object.freeze(['single', 'folder']);
/** Which questions are printed: 'linked' (default: those the book's text links, a Q&A file's, the learner's), 'all' (also every point's own), 'none'. */
export const QUESTION_MODES = Object.freeze(['linked', 'all', 'none']);
export const PAGE_RULE = Object.freeze({ columns: 40, rows: 45 });
const WORDS = {
  zh: { questions: '本节的题', answers: '答案册', answer: '答案', explanation: '解析', none: '这本书里没有题。', key: '含答案册', sep: '：', semi: '；',
    paren: text => `（${text}）`, manifest: '复习全书的导出（StudyHub）：按顺序拼接这些文件' },
  en: { questions: 'Questions of this point', answers: 'Answer key', answer: 'Answer', explanation: 'Explanation', none: 'This book holds no questions.',
    key: 'with-answers', sep: ': ', semi: '; ', paren: text => ` (${text})`, manifest: 'Export of the review book (StudyHub): the files below, concatenated in order' },
};

const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const MARKER_LINE = /^<!-- \/?sh:[a-z]+\b[^>]*-->$/;
const INLINE_MARKER = /<!-- \/?sh:[a-z]+\b[^>]*-->/g;
const ID_SUFFIX = /\s*<!-- sh:id (\S+) -->\s*$/;
const HEADING = /^#{1,6}\s/;
const FENCE = /^\s*(```|~~~)/;
const LINK = /\[([^\]\n]+)\]\((studyhub:\/\/[^)\s]+)\)/g;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+/;
const WIDE = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿︰-﹏＀-￯]/u;

/** The A4 pages of a Markdown text by PAGE_RULE (anchors and link targets are not printed, so not counted). 0 for an empty text. */
export function estimatePages(text) {
  let rows = 0;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/\s*\{#[^}\s]+\}\s*$/, '').replace(/\]\([^)\s]*\)/g, ']').replace(/^\s*(?:#{1,6}|[-*+]|\d{1,3}[.)]|>)\s+/, '');
    if (!line.trim()) { rows += 0.5; continue; }
    let units = 0;
    for (const char of line) units += WIDE.test(char) ? 1 : 0.5;
    rows += Math.max(1, Math.ceil(units / PAGE_RULE.columns));
  }
  return String(text ?? '').trim() ? Math.max(1, Math.ceil(rows / PAGE_RULE.rows)) : 0;
}

const letter = at => String.fromCharCode(65 + at);
const choice = card => (card.kind === 'quiz' || card.kind === 'multi') && Array.isArray(card.options) && card.options.length > 0;
/** The stem of a question on one line: its prompt (a blank as ＿＿), and a cloze's text. */
const stemOf = card => [card.prompt, card.kind === 'cloze' ? card.cloze?.text : '']
  .map(part => squash(String(part ?? '').replace(/\{\{[^{}]+\}\}/g, '＿＿'))).filter(Boolean).join(' ');
const optionsOf = card => (choice(card) ? card.options.map((option, at) => `${letter(at)}. ${squash(option?.text)}`) : []);

/** A point's numbering: its own questions first (Q1…), then each other question the first time it appears; `first` once per question. */
function numbering(hid, cardOf, list) {
  const numbers = new Map(), shown = new Set(), code = codeOf(hid);
  const number = (deckId, cardId) => {
    const key = `${deckId}|${cardId}`;
    if (!numbers.has(key)) { const card = cardOf(deckId, cardId); if (!card) return null; numbers.set(key, `${code}-Q${numbers.size + 1}`); list.push({ hid, deckId, cardId, card, number: numbers.get(key) }); }
    return numbers.get(key);
  };
  const show = (deckId, cardId) => { const key = `${deckId}|${cardId}`, first = !shown.has(key); shown.add(key); return first; };
  return { number, show };
}

/** One piece of a file as printed (see the top of this file): its footnotes named `ns`, its markers out, its links resolved. */
function printPiece(text, ns, ctx, words) {
  const source = String(text ?? '').trim();
  if (!source) return '';
  const out = [];
  let fenced = false;
  for (const line of namespaceFootnotes(closeFences(source), ns).split('\n')) {
    if (FENCE.test(line)) { fenced = !fenced; out.push(line); continue; }
    if (fenced) { out.push(line); continue; }
    if (MARKER_LINE.test(line.trim())) continue;
    const id = HEADING.test(line) ? ID_SUFFIX.exec(line)?.[1] : null, item = LIST_ITEM.exec(line), below = [];
    let dropped = false;
    let next = (id ? line.replace(ID_SUFFIX, '') : line).replace(LINK, (whole, label, href) => {
      const link = parseBookLink(href);
      if (!link) return whole;
      if (link.kind === 'source') return label;
      dropped = true;
      if (link.kind !== 'card') return '';
      const number = ctx.number(link.deckId, link.cardId);
      if (!number) return '';
      const card = ctx.cardOf(link.deckId, link.cardId), options = ctx.show(link.deckId, link.cardId) ? optionsOf(card) : [];
      if (options.length && item) below.push(...options.map(option => `${' '.repeat(item[0].length)}- ${option}`));
      return `**${number}** ${stemOf(card)}${options.length && !item ? words.paren(options.join(words.semi)) : ''}`;
    });
    next = plainTerms(next.replace(INLINE_MARKER, '')).replace(/\s+$/, '');
    if (dropped) next = next.replace(/(\S) {2,}(?=\S)/g, '$1 ');
    if (dropped && !next.replace(/^\s*(?:>\s*)*(?:(?:[-*+]|\d{1,3}[.)])(?:\s+|$))?/, '').replace(/[\s·|,，、;；:：]/gu, '')) continue;
    // A heading the learner typed sits under its point: never above the point's own level (the stitched files keep their structure in print).
    if (HEADING.test(next)) next = `${'#'.repeat(Math.min(6, Math.max(/^#+/.exec(next)[0].length, ctx.level + 1)))}${next.replace(/^#+/, '')}`;
    // An id copied into a second heading (by pasting) is that heading's code but not its anchor: an anchor is printed once.
    const anchor = id && !ctx.anchors.has(id) ? ` {#${id}}` : '';
    if (anchor) ctx.anchors.add(id);
    out.push(id ? `${next} 〔${codeOf(id)}〕${anchor}` : next, ...below);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const headingOf = (level, text, hid) => `${'#'.repeat(Math.min(6, Math.max(1, level)))} ${squash(plainTerms(text))} 〔${codeOf(hid)}〕 {#${hid}}`;
const mapLeaves = (nodes, fn) => (nodes || []).map(node => (node.leaf ? fn(node) : { ...node, children: mapLeaves(node.children, fn) }));
const join = parts => `${parts.map(part => String(part ?? '').trim()).filter(Boolean).join('\n\n')}\n`;
const safeName = title => squash(title).replace(/[\\/:*?"<>|#%{}~&\s·]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'book';

/** The answer of a question for the 答案册: the right options, the blanks, else its answer. */
function answerOf(card, words) {
  if (choice(card)) return card.options.map((option, at) => (option?.correct ? `${letter(at)}. ${squash(option.text)}` : '')).filter(Boolean).join(words.semi);
  if (card.kind === 'cloze' && Array.isArray(card.cloze?.answers)) return card.cloze.answers.map(item => squash(item?.value)).filter(Boolean).join(words.semi);
  return String(card.answer ?? '').trim();
}
/** A labelled text: on the label's line when it is one line, else under it. */
const labelled = (head, text) => (text.includes('\n') ? `${head}\n\n${text}` : `${head}${text}`);

/** The 答案册: per point that has numbered questions, each number with its answer, its explanation and an answer card in full. */
function answerKey(list, places, words) {
  const out = [`## ${words.answers} {#answers}`];
  if (!list.length) out.push(words.none);
  for (const place of places) {
    const own = list.filter(item => item.hid === place.hid);
    if (!own.length) continue;
    out.push(`### ${squash(`${place.number} ${place.title}`)} 〔${codeOf(place.hid)}〕 {#answers-${place.hid}}`);
    for (const item of own) {
      const ns = `ans-${item.number}`, answer = namespaceFootnotes(answerOf(item.card, words), ns), explanation = namespaceFootnotes(String(item.card.explanation ?? '').trim(), ns);
      out.push(labelled(`**${item.number}** ${words.answer}${words.sep}`, answer || '—'));
      if (explanation) out.push(labelled(`${words.explanation}${words.sep}`, explanation));
      if (item.card.answerCard && typeof item.card.answerCard === 'object') out.push(renderAnswerCard(item.card.answerCard));
    }
  }
  return join(out);
}

/** The export of a book (see the top of this file). */
export function exportBook(book, { cardOf: liveCard = () => null, answerCards = book?.answerCards ?? [], caseTypes = book?.caseTypes ?? [], form = 'single', answerKey: withKey = false,
  questions = 'linked' } = {}) {
  if (!EXPORT_FORMS.includes(form)) throw new Error(`form must be one of ${EXPORT_FORMS.join(', ')}`);
  if (!QUESTION_MODES.includes(questions)) throw new Error(`questions must be one of ${QUESTION_MODES.join(', ')}`);
  // 'none': no question is printed (a link to one is left out like a deleted one), so none is numbered and the answer key is empty.
  const cardOf = questions === 'none' ? () => null : liveCard;
  const language = book.language === 'en' ? 'en' : 'zh', words = WORDS[language];
  // What is printed: every file without its noprint regions; the 查找页 and the estimate are made from it.
  const printed = { ...book, nodes: mapLeaves(book.nodes, node => ({ ...node, gen: withoutNoprint(node.gen), mine: withoutNoprint(node.mine), qa: withoutNoprint(node.qa) })),
    unplaced: { ...book.unplaced, text: withoutNoprint(book.unplaced?.text) } };
  const list = [], numbers = new Map(), files = [];
  // The anchors of the manifest's headings and of the book's own (book, lookup, answers…) are taken before any file is printed.
  const anchors = new Set(['book', 'unplaced', 'answers', 'lookup', 'lookup-toc', 'lookup-types', 'lookup-concepts', 'lookup-mistakes']), collect = nodes => (nodes || []).forEach(node => { anchors.add(node.hid); collect(node.children); });
  collect(book.nodes);
  let pending = [];
  const contextOf = (hid, level) => {
    const own = numbering(hid, cardOf, list);
    return { cardOf, level, anchors, show: own.show, number: (deckId, cardId) => { const number = own.number(deckId, cardId); if (number) numbers.set(`${hid}|${deckId}|${cardId}`, number); return number; } };
  };
  const emit = node => {
    const ctx = contextOf(node.hid, node.depth + 1), print = (text, part) => printPiece(text, `${node.hid}${part}`, ctx, words);
    const live = questions === 'all' ? (node.questions || []).filter(entry => ctx.number(entry.deckId, entry.cardId)) : [];
    const woven = weaveBlocks([{ name: 'g', text: node.gen || '' }, { name: 'm', text: withoutAiBlocks(node.mine) }], aiBlocks(node.mine));
    const gen = [...pending, headingOf(node.depth + 1, `${node.number} ${node.title}`, node.hid), ...woven.top.map(item => print(item.block.raw, 'm'))], mine = [];
    pending = [];
    let inMine = false;
    for (const part of woven.parts) { if (part.name === 'm') inMine = true; (inMine ? mine : gen).push(part.block ? print(part.block.raw, 'm') : print(part.text, part.name)); }
    if (live.length) gen.push(`**${words.questions}**`, live.map(entry => {
      const card = cardOf(entry.deckId, entry.cardId), number = ctx.number(entry.deckId, entry.cardId), options = ctx.show(entry.deckId, entry.cardId) ? optionsOf(card) : [];
      return [`- **${number}** ${stemOf(card)}`, ...options.map(option => `  - ${option}`)].join('\n');
    }).join('\n'));
    mine.push(...woven.lost.map(item => print(item.block.raw, 'm')));
    files.push({ name: `${node.hid}.gen`, text: join(gen) });
    if (mine.some(Boolean)) files.push({ name: `${node.hid}.mine`, text: join(mine) });
    const qa = print(node.qa, 'q');
    if (qa) files.push({ name: `${node.hid}.qa`, text: join([qa]) });
  };
  const walk = list => (list || []).forEach(node => {
    if (node.leaf) emit(node);
    else { pending.push(headingOf(node.depth + 1, `${node.number} ${node.title}`, node.hid)); walk(node.children); }
  });
  walk(printed.nodes);
  const unplaced = printPiece(printed.unplaced.text, 'unplaced', contextOf('unplaced', 2), words);
  if (unplaced) files.push({ name: 'unplaced', text: join([headingOf(2, printed.unplaced.title, 'unplaced'), unplaced]) });
  const lookup = bookLookup(printed, { caseTypes, answerCards });
  const front = join([`# ${squash(book.title)} {#book}`, renderLookup(lookup, { number: (deckId, cardId, hid) => numbers.get(`${hid}|${deckId}|${cardId}`) ?? null })]);
  const key = answerKey(list, lookup.places, words);
  const body = [{ name: 'front', text: front }, ...files];
  const all = withKey ? [...body, { name: 'answers', text: key }] : body;
  const width = Math.max(3, String(all.length - 1).length), named = all.map((file, at) => ({ name: `${String(at).padStart(width, '0')}-${file.name}.md`, text: file.text }));
  const text = named.map(file => file.text).join('\n');
  const plain = body.map(file => file.text).join('\n');
  const estimate = { pages: estimatePages(text), book: estimatePages(plain), withAnswers: estimatePages(`${plain}\n${key}`), ...PAGE_RULE };
  const filename = `${safeName(book.title)}${withKey ? `-${words.key}` : ''}`;
  const base = { form, title: book.title, language, filename: `${filename}.md`, questionMode: questions, questions: list.length, estimate };
  if (form === 'single') return { ...base, text };
  const manifest = [`# ${words.manifest}${words.sep}pandoc $(sed -n 's/^  - //p' book.yaml) -o ${filename}.html`, `title: ${JSON.stringify(squash(book.title))}`,
    `language: ${language}`, 'files:', ...named.map(file => `  - ${file.name}`)].join('\n');
  return { ...base, filename, files: named, manifest: { name: 'book.yaml', text: `${manifest}\n` } };
}
