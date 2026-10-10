/* The 复习全书 as one Markdown text (owner decision 2026-10-10): the book of a course is plain Markdown plus links to questions, so it can be edited
   freely, exported and printed. Pure, no I/O; the record and the ops are lib/course-book-doc-ops.js.

   What the program writes is wrapped in comment markers, the rest is the learner's:
     <!-- sh:id bk:… -->                             before each heading of the outline: its stable id (lib/course-book-links.js)
     <!-- sh:gen id=<leaf>.notes fp=<hash> -->…<!-- /sh:gen -->   a knowledge point's notes (考情, 知识梳理, 讲解, 例子, 补充, 出处 as footnotes)
     <!-- sh:gen id=<leaf>.q fp=<hash> -->…<!-- /sh:gen -->       its questions as links and the 练 5 道 / 本节问答 links
     <!-- sh:qa card=<cardId> fid=<followupId> -->…<!-- /sh:qa -->  a 追问 kept during practice, under the card's link (then the learner's text)
   `fp` is the hash of the region as written: a region whose text no longer has that hash was edited by the learner. A program write touches only (a) its own
   region, replaced only while untouched (otherwise the learner's text stays and the new one is a suggestion, accept / ignore), (b) a NEW region it inserts,
   (c) a 追问 region under a question link. A region whose marker the learner deleted or broke is the learner's text.
   Links degrade to readable Markdown: [练习：…](studyhub://card/<deckId>/<cardId>), [练 5 道：…](studyhub://practice?node=<key>&n=5),
   [本节问答：…](studyhub://qa?node=<key>), and a footnote's place [「quote」](studyhub://source/<sourceId>). */
import { createHash } from 'node:crypto';
import { bookLinks, CHUNK, headingPart } from './course-book-links.js';

export { assignHeadingIds, bookIndex, bookLinks, bookSections, parseBookLink, plainBook, CHUNK } from './course-book-links.js';

/** The most question links a knowledge point lists; the rest are practised through its 练 5 道 link. */
export const LINKS_SHOWN = 20;
const WORDS = {
  zh: { book: '复习全书', exam: '考情', tested: '样卷考过。', untested: '样卷没有考到这一点。', points: '知识梳理', explain: '讲解', example: '例子', extra: '补充（资料以外）',
    cites: '出处', questions: '本节的题', card: '练习', practice: n => `练 ${n} 道`, qa: '本节问答', more: n => `还有 ${n} 道题，在「练 ${CHUNK} 道」里按顺序出。`, none: '这一节还没有题。',
    asked: '追问', answer: '答', sep: '：', quote: text => `「${text}」`, unplaced: '未归位' },
  en: { book: 'Review book', exam: 'In the sample papers', tested: 'Tested in the sample papers.', untested: 'The sample papers do not test this point.', points: 'Key points',
    explain: 'Explanation', example: 'Example', extra: 'Extra (beyond the materials)', cites: 'Sources', questions: 'Questions of this point', card: 'Practise', practice: n => `Practise ${n}`,
    qa: 'Questions and answers', more: n => `${n} more questions come in order through “Practise ${CHUNK}”.`, none: 'This point has no questions yet.', asked: 'Follow-up', answer: 'Answer',
    sep: ': ', quote: text => `“${text}”`, unplaced: 'Not placed' },
};
const wordsOf = language => WORDS[language === 'en' ? 'en' : 'zh'];
const hash = text => createHash('sha256').update(text).digest('hex').slice(0, 12);
const oneLine = (value, max = 160) => { const text = String(value ?? '').replace(/\{\{[^{}]+\}\}/g, '＿＿').replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max)}…` : text; };
const genBlock = (id, body) => `<!-- sh:gen id=${id} fp=${hash(body)} -->\n${body}\n<!-- /sh:gen -->`;
// A region's text never holds another region's opening marker: a region whose closing marker was deleted is no region (its text is the learner's).
const GEN = /<!-- sh:gen id=(\S+) fp=([0-9a-f]+) -->\n((?:(?!<!-- sh:gen )[\s\S])*?)\n<!-- \/sh:gen -->/g;
const QA = /<!-- sh:qa card=(\S+) fid=(\S+) -->\n((?:(?!<!-- sh:qa )[\s\S])*?)\n<!-- \/sh:qa -->/g;

/** The generated regions of a text: [{ id, fp, body, start, end, edited }] (start/end: the whole block, markers included). */
export function genSections(text) {
  return [...String(text ?? '').matchAll(GEN)].map(match => ({ id: match[1], fp: match[2], body: match[3], start: match.index, end: match.index + match[0].length, edited: hash(match[3]) !== match[2] }));
}
/** The 追问 regions of a text: [{ cardId, fid, start, end, raw }]. */
export function qaSections(text) {
  return [...String(text ?? '').matchAll(QA)].map(match => ({ cardId: match[1], fid: match[2], start: match.index, end: match.index + match[0].length, raw: match[0] }));
}
const rawOf = (text, section) => text.slice(section.start, section.end);
const leafOf = id => String(id).replace(/\.[a-z]+$/, '');

/** A leaf's notes as Markdown: its marks renumbered from `first` (footnotes are unique in the whole book), the 出处 as footnotes with a link to the place. */
function notesMarkdown(notes, words, first) {
  const lines = [], body = notes.body, renumber = text => String(text ?? '').replace(/\[\^(\d{1,2})\]/g, (mark, n) => `[^${first + Number(n) - 1}]`);
  if (notes.exam) lines.push(`**${words.exam}** ${notes.exam.tested ? words.tested : words.untested}${notes.exam.note ? ` ${notes.exam.note}` : ''}`, '');
  if (body?.points?.length) lines.push(`**${words.points}**`, '', ...body.points.map(point => `- ${renumber(point)}`), '');
  if (body?.explain) lines.push(`**${words.explain}**`, '', renumber(body.explain), '');
  if (body?.example) lines.push(`**${words.example}**`, '', renumber(body.example), '');
  if (body?.extra?.length) lines.push(`**${words.extra}**`, '', ...body.extra.map(item => `- ${item}`), '');
  if (body?.cites?.length) lines.push(`**${words.cites}**`, '', ...body.cites.map(cite => `[^${first + cite.n - 1}]: [${words.quote(oneLine(cite.quote, 200))}](${bookLinks.source(cite.sourceId)})${cite.title ? ` · ${oneLine(cite.title, 120)}` : ''}`), '');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { text: lines.join('\n'), cites: body?.cites?.length ? Math.max(...body.cites.map(cite => cite.n)) : 0 };
}

function questionsMarkdown(key, title, questions, words) {
  if (!questions.length) return words.none;
  const shown = questions.slice(0, LINKS_SHOWN), name = oneLine(title, 80);
  return [`**${words.questions}**`, '', ...shown.map(item => `- [${words.card}${words.sep}${oneLine(item.prompt)}](${bookLinks.card(item.deckId, item.cardId)})`),
    ...(questions.length > shown.length ? ['', words.more(questions.length - shown.length)] : []), '',
    `[${words.practice(CHUNK)}${words.sep}${name}](${bookLinks.practice(key)}) · [${words.qa}${words.sep}${name}](${bookLinks.qa(key)})`].join('\n');
}

/**
 * The book as the program writes it: `title` (the course), `nodes` (the outline's tree: { id, key, title, children?, leaf }), `notesOf(id)` (a leaf's notes as
 * lib/course-book-view.js leafNotes gives them, or null), `questionsOf(key)` ([{ deckId, cardId, prompt }] in reading order), `language` ('zh' | 'en').
 */
export function assembleBook({ title, nodes, notesOf, questionsOf, language }) {
  const words = wordsOf(language), out = [`# ${words.book} · ${oneLine(title, 120)}`];
  let cite = 1;
  const walk = (list, prefix, depth) => list.forEach((node, at) => {
    const number = `${prefix}${at + 1}`;
    out.push('', `${'#'.repeat(Math.min(6, depth + 1))} ${number} ${oneLine(node.title, 120)} <!-- sh:id ${node.key} -->`);
    if (!node.leaf) { walk(node.children || [], `${number}.`, depth + 1); return; }
    const notes = notesOf(node.id);
    if (notes && (notes.body || notes.exam)) { const made = notesMarkdown(notes, words, cite); cite += made.cites; if (made.text) out.push('', genBlock(`${node.id}.notes`, made.text)); }
    out.push('', genBlock(`${node.id}.q`, questionsMarkdown(node.key, node.title, questionsOf(node.key), words)));
  });
  walk(nodes, '', 1);
  return `${out.join('\n')}\n`;
}

/**
 * Where a region that is not in `text` goes: after the region before it in `order` (ids, the program's order) that `text` holds, else under the heading of its
 * knowledge point (`<!-- sh:id bk:<leaf> -->`), else at the end. Never inside or over the learner's text.
 */
function placeRegion(text, block, id, order) {
  const own = genSections(text), at = order.indexOf(id);
  const before = order.slice(0, Math.max(0, at)).reverse().map(other => own.find(item => item.id === other)).find(Boolean);
  if (before) return `${text.slice(0, before.end)}\n\n${block}${text.slice(before.end)}`;
  const part = headingPart(text, `bk:${leafOf(id)}`);
  if (part) return `${text.slice(0, part.lineEnd)}\n\n${block}${text.slice(part.lineEnd)}`;
  return `${text.replace(/\n*$/, '\n\n')}${block}\n`;
}

/**
 * Updating the learner's text with what the program writes now, on the CURRENT saved text: `stored`, `fresh` (assembleBook now), `known` ({ id: fp } of each
 * region as the program last wrote it into the text) and `ignored` ({ id: fp } suggestions set aside). -> { text, known, suggestions: [{ id, fp, text, missing? }] }.
 * A region nobody edited (its text still hashes to its fp) is replaced; an edited one stays and its new text is a suggestion; one the learner deleted or broke
 * (its marker gone) is theirs too: the new text is a suggestion when the program's text changed since, never a second copy; a region the program never wrote is
 * added in its place. A suggestion set aside at that fp is not offered again.
 */
export function mergeBook(stored, fresh, { known = {}, ignored = {} } = {}) {
  let text = String(stored ?? '');
  const was = { ...known }, suggestions = [], next = genSections(fresh), order = next.map(item => item.id);
  for (const section of next) {
    const mine = genSections(text).find(item => item.id === section.id), block = rawOf(fresh, section), offer = ignored[section.id] !== section.fp;
    // Untouched: the new text replaces it, unless the learner set this very text aside (ignored, or undone with course.book.doc.undo).
    if (mine && !mine.edited) { if (mine.fp !== section.fp && offer) { text = text.slice(0, mine.start) + block + text.slice(mine.end); was[section.id] = section.fp; } continue; }
    if (mine) { if (mine.fp !== section.fp && offer) suggestions.push({ id: section.id, fp: section.fp, text: section.body }); continue; }
    if (Object.hasOwn(was, section.id)) { if (was[section.id] !== section.fp && offer) suggestions.push({ id: section.id, fp: section.fp, text: section.body, missing: true }); continue; }
    text = placeRegion(text, block, section.id, order);
    was[section.id] = section.fp;
  }
  return { text, known: was, suggestions };
}

/** Taking a suggestion: region `id` becomes `fresh`'s (in its place, or placed anew when the learner's copy is gone). The text, unchanged when `fresh` has no such region. */
export function acceptSuggestion(text, fresh, id) {
  const mine = genSections(text).find(item => item.id === id), theirs = genSections(fresh).find(item => item.id === id);
  if (!theirs) return text;
  return mine ? text.slice(0, mine.start) + rawOf(fresh, theirs) + text.slice(mine.end) : placeRegion(text, rawOf(fresh, theirs), id, genSections(fresh).map(item => item.id));
}

/** An AI 「加一段」: a NEW region `id` at the end of knowledge point `node`'s part (before the next node marker), never over existing text. Null when `id` is taken. */
export function insertRegion(text, { node, id, body }) {
  const source = String(text ?? '');
  if (genSections(source).some(item => item.id === id)) return null;
  const part = headingPart(source, node);
  if (!part) return `${source.replace(/\n*$/, '\n\n')}${genBlock(id, body)}\n`;
  return `${source.slice(0, part.end).replace(/\n*$/, '')}\n\n${genBlock(id, body)}\n${source.slice(part.end)}`;
}

const quoted = text => String(text ?? '').trim().split('\n').map(line => (line.trim() ? `> ${line}` : '>')).join('\n');
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A 追问 block under the first link to `cardId`, after the 追问 already there; null without such a link. */
function underCard(text, cardId, block) {
  const link = new RegExp(`\\]\\(studyhub://card/[^/)\\s]+/${escape(encodeURIComponent(cardId))}\\)`).exec(text);
  if (!link) return null;
  const end = text.indexOf('\n', link.index);
  let tail = end < 0 ? text.length : end;
  for (let match; (match = /^\n\n?<!-- sh:qa card=[^\n]*-->\n[\s\S]*?\n<!-- \/sh:qa -->/.exec(text.slice(tail)));) tail += match[0].length;
  return `${text.slice(0, tail)}\n\n${block}${tail === text.length ? '\n' : ''}${text.slice(tail)}`;
}

/**
 * A 追问 kept during practice, written under the first link to its card: `<!-- sh:qa card=… fid=… -->` a quote `> **追问：** … > **答：** …` `<!-- /sh:qa -->`.
 * Returns the new text, or null when the text has no link to the card or already holds this follow-up (`written`: follow-up ids written before, kept
 * even when the learner deleted the block).
 */
export function insertFollowup(text, { cardId, followupId, question, answer }, { language, written = [] } = {}) {
  const source = String(text ?? '');
  if (!followupId || written.includes(followupId) || source.includes(`fid=${followupId} -->`)) return null;
  const words = wordsOf(language);
  return underCard(source, cardId, `<!-- sh:qa card=${cardId} fid=${followupId} -->\n${quoted(`**${words.asked}${words.sep}** ${question}`)}\n>\n${quoted(`**${words.answer}${words.sep}** ${answer}`)}\n<!-- /sh:qa -->`);
}

/** Is there a link to this card in the text? */
export const linksCard = (text, cardId) => new RegExp(`\\]\\(studyhub://card/[^/)\\s]+/${escape(encodeURIComponent(cardId))}\\)`).test(String(text ?? ''));

/**
 * A link to a question written at the end of knowledge point `node`'s part (the learner's line, outside any region); with no such point (`node` null or not in
 * the text) under a 「未归位」 heading at the end, made once (`<!-- sh:id unplaced -->`).
 */
export function insertCardLink(text, { node, deckId, cardId, prompt }, { language } = {}) {
  const words = wordsOf(language), line = `- [${words.card}${words.sep}${oneLine(prompt)}](${bookLinks.card(deckId, cardId)})`;
  let source = String(text ?? ''), key = node && headingPart(source, node) ? node : 'unplaced';
  if (key === 'unplaced' && !headingPart(source, key)) source = `${source.replace(/\n*$/, '\n\n')}## ${words.unplaced} <!-- sh:id unplaced -->\n`;
  const cut = headingPart(source, key).end;
  return `${source.slice(0, cut).replace(/\n*$/, '')}\n\n${line}\n${source.slice(cut)}`;
}

/** The text without the 追问 region of `followupId` (and the blank line before it); null when it holds none. */
export function removeFollowup(text, followupId) {
  const source = String(text ?? ''), region = qaSections(source).find(item => item.fid === followupId);
  if (!region) return null;
  const from = source.slice(0, region.start).replace(/\n{1,2}$/, '').length;
  return source.slice(0, from) + source.slice(region.end);
}

/**
 * The editor's save over a book that changed meanwhile (an AI write landed while the learner typed): `mine` (the learner's text), `base` (the text they
 * started from), `theirs` (the saved text now). Starts from the learner's text and brings in, region by region, what the program wrote since `base`: a
 * generated region the learner did not touch takes the new text; one both changed keeps the learner's (the new text is a suggestion, see mergeBook); a new
 * region is placed in its place; a new 追问 goes under its card's link (left out when the learner removed the link). -> { text, conflicts: [id] }.
 */
export function rebaseBook(mine, base, theirs) {
  let text = String(mine ?? '');
  const conflicts = [], baseGen = genSections(base), theirGen = genSections(theirs), order = theirGen.map(item => item.id);
  for (const section of theirGen) {
    const before = baseGen.find(item => item.id === section.id), own = genSections(text).find(item => item.id === section.id);
    if (before && rawOf(base, before) === rawOf(theirs, section)) continue;
    if (own && before && rawOf(text, own) === rawOf(base, before)) { text = text.slice(0, own.start) + rawOf(theirs, section) + text.slice(own.end); continue; }
    if (!before && !own) { text = placeRegion(text, rawOf(theirs, section), section.id, order); continue; }
    if (!own || rawOf(text, own) !== rawOf(theirs, section)) conflicts.push(section.id);
  }
  const baseQa = new Set(qaSections(base).map(item => item.fid));
  for (const section of qaSections(theirs)) if (!baseQa.has(section.fid) && !qaSections(text).some(item => item.fid === section.fid)) text = underCard(text, section.cardId, section.raw) ?? text;
  return { text, conflicts };
}
