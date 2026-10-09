import { createHash } from 'node:crypto';
import { COURSE_OUTLINE_PROVENANCE, TIER_LABEL, inputFingerprint, isCourseOutlineSource } from './exam-point-list.js';
import { pointBacking } from './exam-blueprint-material.js';

/* 课程总纲 (course outline), step 2: the outline the model organises, as a special kind of material (the 考点清单 pattern of lib/exam-blueprint-material.js).

   It is an ordinary source record: `text` is the readable outline (a book's table of contents: 章 › 节 › 知识点, each with a short introduction), and the
   structured outline rides on the same record as `courseOutline`, marked by `provenance: 'course-outline'`. It is a REFERENCE (coverage, order, focus), never
   evidence: every list of materials leaves it out and a request that names it as material is refused (lib/exam-point-list.js isLibraryListSource, assertMaterials).

   A leaf (知识点) holds `anchors`: the keys of the v3.3.0 outline's own rows (a document key, or a document's chapter key: lib/course-outline-index.js), so the
   questions, their counts, mastery and practice keep being COMPUTED by that engine from the library as it is; nothing about questions is stored here. Each anchor
   belongs to one leaf at most; what the model left out is kept in `other` (shown as 其他), never dropped. With sample papers, a leaf the papers test carries the
   places of the paper questions (verbatim quotes of the paper, role past-paper) and its tier is computed from them by the 考点清单's own rule (pointBacking).

   Pure and import-light. Nothing here calls a model or writes a library. */

export const COURSE_OUTLINE_VERSION = 1;
export const OUTLINE_LIMITS = Object.freeze({ depth: 3, nodes: 800, titleChars: 80, introChars: 160, anchors: 6000, papers: 20, evidence: 6, quoteChars: 400, basisChars: 200 });
/** What the learning order may rest on, in the order the model is told to weigh them. */
export const ORDER_CODES = Object.freeze(['syllabus', 'numbering', 'dates', 'logic']);
const ID = /^[a-z0-9-]{1,40}$/;

const fail = message => { throw new Error(message); };
/** A title or introduction as stored: one line, cut at `max` (with an ellipsis) rather than refused, so a long name never voids a build. */
export const clip = (value, max) => {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
};
const digest = value => createHash('sha1').update(JSON.stringify(value)).digest('hex');

/** A node id from its content (its title and what it holds), told apart from an earlier equal one by a suffix. */
export function nodeId(taken, content) {
  const base = `n${digest(content).slice(0, 10)}`;
  let id = base, count = 1;
  while (taken.has(id)) id = `${base}-${++count}`;
  taken.add(id);
  return id;
}

function normalizePlace(raw, papers) {
  if (!raw || typeof raw !== 'object') fail('An exam place must be an object');
  const sourceId = clip(raw.sourceId, 200), quote = typeof raw.quote === 'string' ? raw.quote.replace(/\s+/g, ' ').trim() : '';
  if (!sourceId || !quote || quote.length > OUTLINE_LIMITS.quoteChars) fail('An exam place needs a sourceId and a quote');
  const paper = papers.find(item => item.key === raw.paper && item.sourceIds.includes(sourceId));
  if (!paper) fail(`An exam place names a material that is not a sample paper: ${sourceId.slice(0, 80)}`);
  const span = Number.isInteger(raw.start) && Number.isInteger(raw.end) && raw.end > raw.start && raw.start >= 0 ? { start: raw.start, end: raw.end } : {};
  return { sourceId, quote, paper: paper.key, ...span };
}

/** Check and shape the tree: at most three levels, a node holds children or anchors, never both, each anchor once in the whole outline. */
function normalizeNodes(raw, { papers, used, ids }) {
  let count = 0;
  const walk = (list, depth) => (Array.isArray(list) ? list : []).map(node => {
    if (!node || typeof node !== 'object') fail('An outline node must be an object');
    if (++count > OUTLINE_LIMITS.nodes) fail(`An outline holds at most ${OUTLINE_LIMITS.nodes} nodes`);
    if (depth > OUTLINE_LIMITS.depth) fail('An outline has at most three levels');
    const id = typeof node.id === 'string' && ID.test(node.id) ? node.id : fail('An outline node needs an id');
    if (ids.has(id)) fail(`Outline node id repeated: ${id}`);
    ids.add(id);
    const title = clip(node.title, OUTLINE_LIMITS.titleChars) || fail(`Outline node ${id} needs a title`);
    const intro = clip(node.intro, OUTLINE_LIMITS.introChars);
    const base = { id, title, ...(intro ? { intro } : {}) };
    if (Array.isArray(node.children) && node.children.length) {
      if (Array.isArray(node.anchors) && node.anchors.length) fail(`Outline node ${id} holds both children and anchors`);
      return { ...base, children: walk(node.children, depth + 1) };
    }
    const anchors = (Array.isArray(node.anchors) ? node.anchors : []).map(anchor => typeof anchor === 'string' && anchor ? anchor : fail(`Outline node ${id}: an anchor must be a key`));
    for (const anchor of anchors) { if (used.has(anchor)) fail(`Anchor in two places: ${anchor.slice(0, 80)}`); used.add(anchor); }
    if (!papers.length || !node.exam) return { ...base, anchors };
    const evidence = (Array.isArray(node.exam.evidence) ? node.exam.evidence : []).slice(0, OUTLINE_LIMITS.evidence).map(place => normalizePlace(place, papers));
    return { ...base, anchors, ...(evidence.length ? { exam: { evidence } } : {}) };
  });
  return walk(raw, 1);
}

/** The papers as inputs of the 考点清单's backing rule: one past-paper input per paper. */
const paperInputs = papers => papers.map(paper => ({ role: 'past-paper', documentId: paper.key, sourceIds: paper.sourceIds }));
/** How many of the chosen sample papers tested a leaf (the 考点清单's rule, on the leaf's places). */
export function leafPapers(node, papers) {
  const places = (node?.exam?.evidence || []).map(place => ({ role: 'past-paper', sourceId: place.sourceId, documentId: place.paper }));
  return places.length ? pointBacking(places, paperInputs(papers)).samplePapers : 0;
}
/** 样卷考过 (must) when a paper tested the leaf, else 补充 (extra); null when the outline rests on no paper (then nothing is said). */
export const leafTier = (node, papers) => !papers?.length ? null : leafPapers(node, papers) > 0 ? 'must' : 'extra';

/**
 * Check and shape the structured outline. Throws a plain Error naming the first problem.
 * @param input { course, language?, orderBasis: { codes, syllabus? }, nodes, other?: { anchors }, papers?: [{ key, title?, sourceIds, fingerprint? }],
 *                fingerprint, counts?, supersedes? }
 */
export function normalizeCourseOutline(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('A course outline must be an object');
  if (typeof input.course !== 'string') fail('A course outline names its course (an empty string for uncategorised)');
  const papers = (Array.isArray(input.papers) ? input.papers : []).map(paper => {
    const key = clip(paper?.key, 300), sourceIds = Array.isArray(paper?.sourceIds) ? paper.sourceIds.filter(id => typeof id === 'string' && id) : [];
    if (!key || !sourceIds.length) fail('A sample paper names its document and its sources');
    return { key, ...(paper.title ? { title: clip(paper.title, 200) } : {}), sourceIds, ...(typeof paper.fingerprint === 'string' ? { fingerprint: paper.fingerprint } : {}) };
  });
  if (papers.length > OUTLINE_LIMITS.papers) fail(`A course outline rests on at most ${OUTLINE_LIMITS.papers} sample papers`);
  const used = new Set(), ids = new Set(['other']);
  const nodes = normalizeNodes(input.nodes, { papers, used, ids });
  if (!nodes.length) fail('A course outline needs at least one chapter');
  const other = (Array.isArray(input.other?.anchors) ? input.other.anchors : []).filter(anchor => typeof anchor === 'string' && anchor);
  for (const anchor of other) { if (used.has(anchor)) fail(`Anchor in two places: ${anchor.slice(0, 80)}`); used.add(anchor); }
  if (used.size > OUTLINE_LIMITS.anchors) fail(`A course outline holds at most ${OUTLINE_LIMITS.anchors} anchors`);
  const codes = (Array.isArray(input.orderBasis?.codes) ? input.orderBasis.codes : []).filter(code => ORDER_CODES.includes(code));
  const syllabus = clip(input.orderBasis?.syllabus, OUTLINE_LIMITS.titleChars * 2);
  const counts = Object.fromEntries(['units', 'leftover', 'invalid', 'repeated'].map(name => [name, Number.isInteger(input.counts?.[name]) ? input.counts[name] : 0]));
  if (!/^[0-9a-f]{8}$/.test(String(input.fingerprint))) fail('A course outline records the fingerprint of the materials it was built from');
  return { version: COURSE_OUTLINE_VERSION, course: input.course, ...(input.language === 'en' ? { language: 'en' } : { language: 'zh' }),
    orderBasis: { codes: [...new Set(codes)], ...(syllabus && codes.includes('syllabus') ? { syllabus } : {}) }, nodes, other: { anchors: other },
    ...(papers.length ? { papers } : {}), fingerprint: input.fingerprint, counts, ...(input.supersedes ? { supersedes: clip(input.supersedes, 200) } : {}) };
}

const BASIS_WORDS = Object.freeze({ syllabus: name => (name ? `讲义大纲《${name}》的顺序` : '讲义大纲的顺序'), numbering: () => '资料标题里的编号（01、02、v2.1、Day 1 这类）',
  dates: () => '录音的日期', logic: () => '先学什么、后学什么的道理' });
/** What the learning order rests on, said plainly (the page says the same from the codes). */
export function orderBasisText(basis) {
  const parts = (basis?.codes || []).map(code => BASIS_WORDS[code]?.(basis.syllabus)).filter(Boolean);
  return parts.length ? `学习顺序依据：${parts.join('；')}。` : '学习顺序依据：资料导入的先后。';
}

/** The readable text of an outline: the table of contents the reader shows. It says it is a reference, and it names no question. */
export function courseOutlineText(title, outline) {
  const lines = [`# ${title}`, '', orderBasisText(outline.orderBasis), '', '这份总纲由模型按资料整理，只是参考：它不是资料，不能用来出题；题目的出处仍是原来的资料。', ''];
  const papers = outline.papers || [];
  if (papers.length) lines.push(`依据 ${papers.length} 份样卷标出样卷考过的知识点：${papers.map(paper => paper.title || paper.key).join('、')}。`, '');
  const write = (node, number, depth) => {
    const tier = leafTier(node, papers);
    const mark = tier === 'must' ? `（${TIER_LABEL.must} ${leafPapers(node, papers)}/${papers.length} 份）` : tier === 'extra' ? `（${TIER_LABEL.extra}）` : '';
    if (depth === 1) lines.push(`## ${number} ${node.title}${mark}`, ...(node.intro ? ['', node.intro] : []), '');
    else if (depth === 2 && node.children) lines.push(`### ${number} ${node.title}`, ...(node.intro ? ['', node.intro] : []), '');
    else lines.push(`- ${number} ${node.title}${mark}${node.intro ? `：${node.intro}` : ''}`);
    (node.children || []).forEach((child, at) => write(child, `${number}.${at + 1}`, depth + 1));
    if (depth === 1 || (depth === 2 && node.children)) lines.push('');
  };
  outline.nodes.forEach((node, at) => write(node, `${at + 1}`, 1));
  if (outline.other.anchors.length) lines.push('## 其他', '', `还有 ${outline.other.anchors.length} 处资料没有归入上面的章节。`, '');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/**
 * A source record for the library, ready for `materials.v1 sources.ingest`. The id is a fingerprint of the content, so the same outline saved twice is one
 * record and a changed one is a new one (the old stays readable, archived when a rebuild replaces it).
 */
export function courseOutlineMaterial({ title, ...input } = {}) {
  const name = clip(title, 200) || fail('Title is required');
  const outline = normalizeCourseOutline(input);
  const id = `course-outline-${createHash('sha256').update(JSON.stringify([name, outline])).digest('hex').slice(0, 40)}`;
  return { id, title: name, text: courseOutlineText(name, outline), format: 'md', courses: outline.course ? [outline.course] : [], provenance: COURSE_OUTLINE_PROVENANCE, courseOutline: outline };
}

/** The fingerprint of a course's materials as the outline engine sees them (their keys, names, pages, chapters and size): a change shows the outline as out of date. */
export function materialsFingerprint(documents) {
  const rows = (Array.isArray(documents) ? documents : []).map(item => [item.key, item.title, (item.sourceIds || []).join(','),
    (item.chapters || []).map(chapter => chapter.title).join('|'), item.chars ?? 0].join('\u0001')).sort();
  return inputFingerprint(rows);
}

/** The outline of a course: the newest one that is not archived, filed under exactly that course (an empty string: the uncategorised one). */
export function currentCourseOutline(sources, course) {
  if (typeof course !== 'string' || course === '*') return null;
  const mine = (Array.isArray(sources) ? sources : []).filter(source => isCourseOutlineSource(source) && !source.archived && source.courseOutline.version === COURSE_OUTLINE_VERSION
    && (course === '' ? !(source.courses || []).length : (source.courses || []).includes(course)));
  return mine.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

export { isCourseOutlineSource };
