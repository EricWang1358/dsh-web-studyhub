import { createHash } from 'node:crypto';
import { COURSE_NOTES_PROVENANCE, isCourseNotesSource } from './exam-point-list.js';

/* 复习全书 (the review book), its explanation layer: for each knowledge point (leaf) of a 课程总纲 (lib/course-outline-book.js) a condensed explanation in the
   model's words, with 角标 citations to the original place. A special kind of source record, as the 总纲 and the 考点清单 are: `provenance: 'course-outline-notes'`,
   a readable `text`, the structured `courseNotes`. A REFERENCE, never evidence: every list of materials leaves it out and a request that names it as material is
   refused (lib/exam-point-list.js isLibraryListSource, assertMaterials); questions keep citing the original text.

   It is its own record beside the outline (not a field of it): the outline's id is a fingerprint of its content, and the two are rebuilt at different times (a
   rebuilt outline keeps every explanation whose materials did not change; new sample papers rewrite only 考情). Each leaf holds two independent parts:
     body: 知识梳理 (points), 讲解 (explain), 例子 (example), 补充 (extra, what the materials do not say), cites; keyed by `fingerprint`, the leaf's material
           texts and the language (lib/course-book-inputs.js). Questions are not an input: they are placed live by the outline's anchors.
     exam: 考情, only when the outline rests on sample papers; keyed by its own `fingerprint` (the paper places of the leaf and the language).
   A cite is a quote found WORD FOR WORD in the original (lib/quote-locate.js); a quote that is not found is dropped before anything is stored. `[^n]` in the texts
   marks cite n. The record is machine-owned: the learner's own blocks (later) live elsewhere and are never written here. Pure; nothing here calls a model. */

export const COURSE_NOTES_VERSION = 1;
/* A body read in passes (讲解详尽程度 标准 / 详尽, lib/course-book-reading.js) holds `parts` instead of its own points / explain / example: one per pass in page
   order, each { ranges (what its heading names: [{ material, unit: 'page' | 'char' | 'whole', from?, to? }]), points, explain, example? }; its cites are numbered
   through all parts, and `read` lists the ranges it read ([{ sourceId, start, end }], the 覆盖 figure). A body without them is as before levels existed. */
export const NOTES_LIMITS = Object.freeze({ leaves: 800, points: 8, pointChars: 240, explainChars: 3000, exampleChars: 2000, extra: 4, extraChars: 300, cites: 24,
  quoteChars: 300, examChars: 400, anchors: 200, parts: 8, ranges: 12, read: 2000, bridgeChars: 200 });
const ID = /^[a-z0-9-]{1,40}$/;
const FINGERPRINT = /^[0-9a-f]{16}$/;
export const CITE = /\[\^(\d{1,2})\]/g;

const fail = message => { throw new Error(message); };
const line = (value, max) => { const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''; return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text; };
const block = (value, max) => { const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : ''; return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text; };
/** A text with only the marks of cites that exist (a mark of a dropped quote is taken out with the space before it). */
export const keepMarks = (text, count) => text.replace(/\s?\[\^(\d{1,2})\]/g, (mark, n) => (Number(n) >= 1 && Number(n) <= count ? mark : ''));

function normalizeBody(raw, id) {
  if (!raw || typeof raw !== 'object') fail(`Leaf ${id}: the explanation must be an object`);
  if (!FINGERPRINT.test(String(raw.fingerprint))) fail(`Leaf ${id}: the explanation records the fingerprint of its materials`);
  if (raw.empty === true) return { fingerprint: raw.fingerprint, empty: true };
  const cites = (Array.isArray(raw.cites) ? raw.cites : []).slice(0, NOTES_LIMITS.cites).map((cite, at) => {
    const quote = line(cite?.quote, NOTES_LIMITS.quoteChars), sourceId = line(cite?.sourceId, 200);
    if (!quote || !sourceId || cite.n !== at + 1) fail(`Leaf ${id}: cite ${at + 1} needs its number, a sourceId and a quote`);
    const span = Number.isInteger(cite.start) && Number.isInteger(cite.end) && cite.end > cite.start && cite.start >= 0 ? { start: cite.start, end: cite.end } : {};
    return { n: at + 1, sourceId, quote, ...span };
  });
  const marks = text => keepMarks(text, cites.length);
  const pointsOf = list => (Array.isArray(list) ? list : []).map(item => marks(line(item, NOTES_LIMITS.pointChars))).filter(Boolean).slice(0, NOTES_LIMITS.points);
  const points = pointsOf(raw.points), explain = marks(block(raw.explain, NOTES_LIMITS.explainChars)), example = marks(block(raw.example, NOTES_LIMITS.exampleChars));
  // 补充 is what the materials do not say: it carries no cite.
  const extra = (Array.isArray(raw.extra) ? raw.extra : []).map(item => keepMarks(line(item, NOTES_LIMITS.extraChars), 0)).filter(Boolean).slice(0, NOTES_LIMITS.extra);
  const parts = (Array.isArray(raw.parts) ? raw.parts : []).slice(0, NOTES_LIMITS.parts).map(part => {
    const own = { ranges: rangesOf(part?.ranges), points: pointsOf(part?.points), explain: marks(block(part?.explain, NOTES_LIMITS.explainChars)) };
    const shown = marks(block(part?.example, NOTES_LIMITS.exampleChars));
    return { ...own, ...(shown ? { example: shown } : {}) };
  }).filter(part => part.points.length || part.explain);
  if (!points.length && !explain && !parts.length) fail(`Leaf ${id}: an explanation needs points or a text`);
  const read = (Array.isArray(raw.read) ? raw.read : []).slice(0, NOTES_LIMITS.read)
    .filter(range => typeof range?.sourceId === 'string' && Number.isInteger(range.start) && Number.isInteger(range.end) && range.end > range.start && range.start >= 0)
    .map(range => ({ sourceId: line(range.sourceId, 200), start: range.start, end: range.end }));
  return { fingerprint: raw.fingerprint, points, explain, ...(example ? { example } : {}), ...(extra.length ? { extra } : {}), ...(parts.length ? { parts } : {}), cites,
    ...(read.length ? { read } : {}), ...(typeof raw.replaces === 'string' ? { replaces: line(raw.replaces, 200) } : {}) };
}

/** What a part's heading names, checked: per material its pages or characters a–b, or the material whole. */
function rangesOf(raw) {
  const whole = value => Number.isInteger(value) && value >= 0;
  return (Array.isArray(raw) ? raw : []).slice(0, NOTES_LIMITS.ranges).map(range => {
    const material = line(range?.material, 160), unit = ['page', 'char'].includes(range?.unit) && whole(range.from) && whole(range.to) && range.to >= range.from ? range.unit : 'whole';
    return unit === 'whole' ? { material, unit } : { material, unit, from: range.from, to: range.to };
  });
}

const RANGE_WORDS = {
  zh: { page: (from, to) => (from === to ? `第 ${from} 页` : `第 ${from}–${to} 页`), char: (from, to) => `第 ${from}–${to} 字`, more: n => `等 ${n} 份`, join: '；' },
  en: { page: (from, to) => (from === to ? `Page ${from}` : `Pages ${from}–${to}`), char: (from, to) => `Characters ${from}–${to}`, more: n => `and ${n} more`, join: '; ' },
};
/** The heading of one part of a body read in passes: 「第 a–b 页」, with the material's name when the parts read more than one material. */
export function partHeading(part, language, named) {
  const say = RANGE_WORDS[language === 'en' ? 'en' : 'zh'], shown = part.ranges.slice(0, 3);
  const text = shown.map(range => {
    const where = range.unit === 'whole' ? '' : say[range.unit](range.from, range.to);
    return named || range.unit === 'whole' ? [range.material, where].filter(Boolean).join(' · ') : where;
  });
  return [text.join(say.join), part.ranges.length > shown.length ? say.more(part.ranges.length - shown.length) : ''].filter(Boolean).join(' ');
}
/** Do the parts of a body read more than one material (so each heading names its material)? */
export const partsNamed = parts => new Set((parts || []).flatMap(part => part.ranges.map(range => range.material))).size > 1;

/** A leaf's transitions (过渡句): `in` from the point before it (or the chapter's opening), `out` on to the next, `wrap` the chapter's wrap-up after its last
    point; keyed by their own fingerprint (the titles and summaries of the point and its neighbours), so a changed neighbour rewrites them and never the body. */
function normalizeBridge(raw, id) {
  if (!raw || typeof raw !== 'object' || !FINGERPRINT.test(String(raw.fingerprint))) fail(`Leaf ${id}: a bridge records the fingerprint of what it connects`);
  const own = Object.fromEntries(['in', 'out', 'wrap'].map(key => [key, line(raw[key], NOTES_LIMITS.bridgeChars)]).filter(([, text]) => text));
  return Object.keys(own).length ? { fingerprint: raw.fingerprint, ...own } : null;
}

function normalizeExam(raw, id) {
  if (!raw || typeof raw !== 'object' || !FINGERPRINT.test(String(raw.fingerprint))) fail(`Leaf ${id}: 考情 records the fingerprint of its paper places`);
  const note = line(raw.note, NOTES_LIMITS.examChars);
  return { fingerprint: raw.fingerprint, tested: raw.tested === true, ...(raw.tested === true && note ? { note } : {}),
    ...(typeof raw.replaces === 'string' ? { replaces: line(raw.replaces, 200) } : {}) };
}

/**
 * Check and shape the notes. Throws a plain Error naming the first problem.
 * @param input { course, language?, outlineId, leaves: [{ id, title, anchors, body?, exam? }], papers?: [{ key, fingerprint? }], counts?, supersedes? }
 */
export function normalizeCourseNotes(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Course notes must be an object');
  if (typeof input.course !== 'string') fail('Course notes name their course (an empty string for uncategorised)');
  const outlineId = line(input.outlineId, 200) || fail('Course notes name the outline they explain');
  if (!Array.isArray(input.leaves) || input.leaves.length > NOTES_LIMITS.leaves) fail(`Course notes hold at most ${NOTES_LIMITS.leaves} leaves`);
  const ids = new Set();
  const leaves = input.leaves.map(raw => {
    const id = typeof raw?.id === 'string' && ID.test(raw.id) ? raw.id : fail('A leaf of the notes needs the id of its outline node');
    if (ids.has(id)) fail(`Leaf repeated: ${id}`);
    ids.add(id);
    const anchors = (Array.isArray(raw.anchors) ? raw.anchors : []).filter(anchor => typeof anchor === 'string' && anchor).slice(0, NOTES_LIMITS.anchors);
    const bridge = raw.bridge ? normalizeBridge(raw.bridge, id) : null;
    return { id, title: line(raw.title, 80) || fail(`Leaf ${id} needs a title`), anchors, ...(raw.body ? { body: normalizeBody(raw.body, id) } : {}),
      ...(bridge ? { bridge } : {}), ...(raw.exam ? { exam: normalizeExam(raw.exam, id) } : {}) };
  });
  const papers = (Array.isArray(input.papers) ? input.papers : []).map(paper => ({ key: line(paper?.key, 300) || fail('A sample paper names its document'),
    ...(typeof paper.fingerprint === 'string' ? { fingerprint: paper.fingerprint } : {}) }));
  const counts = Object.fromEntries(['written', 'reused', 'examWritten', 'examReused', 'dropped', 'missed', 'empty']
    .map(name => [name, Number.isInteger(input.counts?.[name]) ? input.counts[name] : 0]));
  return { version: COURSE_NOTES_VERSION, course: input.course, language: input.language === 'en' ? 'en' : 'zh', outlineId, leaves, ...(papers.length ? { papers } : {}),
    counts, ...(input.supersedes ? { supersedes: line(input.supersedes, 200) } : {}) };
}

const WORDS = {
  zh: { note: '这份复习全书由模型按资料写成，只是参考：它不是资料，不能用来出题；角标指向原文，题目的出处仍是原来的资料。', exam: '考情', tested: '样卷考过。',
    untested: '样卷没有考到。', points: '知识梳理', explain: '讲解', example: '例子', extra: '补充（资料以外）', none: '这一点的资料里没有可读的文字。' },
  en: { note: 'The model wrote this review book from the materials. It is a reference, not course material: it cannot be used to make questions; the marks point to the '
    + 'original text, which questions keep citing.', exam: 'In the sample papers', tested: 'Tested in the sample papers.', untested: 'Not tested in the sample papers.',
  points: 'Key points', explain: 'Explanation', example: 'Example', extra: 'Beyond the materials', none: 'The materials of this point have no readable text.' },
};

/** The readable text of the notes: a book, one section per knowledge point, its cites as footnotes. */
export function courseNotesText(title, notes) {
  const say = WORDS[notes.language] || WORDS.zh, lines = [`# ${title}`, '', say.note, ''];
  for (const leaf of notes.leaves) {
    lines.push(`## ${leaf.title}`, '');
    // The transitions: an italic line leading in above the point, and one leading on (or the chapter's wrap-up) below it.
    if (leaf.bridge?.in) lines.push(`*${leaf.bridge.in}*`, '');
    const after = [leaf.bridge?.out, leaf.bridge?.wrap].filter(Boolean).map(text => `*${text}*`);
    if (leaf.exam) lines.push(`### ${say.exam}`, '', [leaf.exam.tested ? say.tested : say.untested, leaf.exam.note].filter(Boolean).join(' '), '');
    const body = leaf.body;
    if (!body) { if (after.length) lines.push(...after, ''); continue; }
    if (body.empty) { lines.push(say.none, '', ...(after.length ? [...after, ''] : [])); continue; }
    if (body.points.length) lines.push(`### ${say.points}`, '', ...body.points.map(point => `- ${point}`), '');
    if (body.explain) lines.push(`### ${say.explain}`, '', body.explain, '');
    if (body.example) lines.push(`### ${say.example}`, '', body.example, '');
    // Read in passes: each pass under the pages it read, in page order.
    for (const part of body.parts || []) {
      lines.push(`### ${partHeading(part, notes.language, partsNamed(body.parts))}`, '');
      if (part.points.length) lines.push(`#### ${say.points}`, '', ...part.points.map(point => `- ${point}`), '');
      if (part.explain) lines.push(`#### ${say.explain}`, '', part.explain, '');
      if (part.example) lines.push(`#### ${say.example}`, '', part.example, '');
    }
    if (body.extra) lines.push(`### ${say.extra}`, '', ...body.extra.map(item => `- ${item}`), '');
    if (after.length) lines.push(...after, '');
    // Footnote labels are made unique per leaf, so the book reads as one Markdown text.
    const own = text => text.replace(CITE, (_, n) => `[^${leaf.id}-${n}]`);
    for (let at = lines.length - 1; at >= 0 && !lines[at].startsWith('## '); at--) lines[at] = own(lines[at]);
    for (const cite of body.cites) lines.push(`[^${leaf.id}-${cite.n}]: 「${cite.quote}」`);
    if (body.cites.length) lines.push('');
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** A source record for the library, ready for `materials.v1 sources.ingest`; the id is a fingerprint of the content (the same notes saved twice are one record). */
export function courseNotesMaterial({ title, ...input } = {}) {
  const name = line(title, 200) || fail('Title is required');
  const notes = normalizeCourseNotes(input);
  const id = `course-outline-notes-${createHash('sha256').update(JSON.stringify([name, notes])).digest('hex').slice(0, 40)}`;
  return { id, title: name, text: courseNotesText(name, notes), format: 'md', courses: notes.course ? [notes.course] : [], provenance: COURSE_NOTES_PROVENANCE, courseNotes: notes };
}

/** Is what a build made the same as what is saved (the leaves, the outline, the language, the papers), so nothing needs to be written? */
export const sameNotes = (a, b) => !!a && !!b && JSON.stringify([a.outlineId, a.language, a.leaves, a.papers ?? []]) === JSON.stringify([b.outlineId, b.language, b.leaves, b.papers ?? []]);

/** The notes of a course: the newest that are not archived, filed under exactly that course (an empty string: the uncategorised one). */
export function currentCourseNotes(sources, course) {
  if (typeof course !== 'string' || course === '*') return null;
  const mine = (Array.isArray(sources) ? sources : []).filter(source => isCourseNotesSource(source) && !source.archived && source.courseNotes.version === COURSE_NOTES_VERSION
    && (course === '' ? !(source.courses || []).length : (source.courses || []).includes(course)));
  return mine.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

export { isCourseNotesSource };
