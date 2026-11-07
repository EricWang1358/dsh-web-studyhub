import { createHash } from 'node:crypto';
import { MOVE_MIN_SHARE } from './course-book-remap.js';
import { COURSE_OUTLINE_PROVENANCE, TIER_LABEL, inputFingerprint, isCourseOutlineSource } from './exam-point-list.js';
import { pointBacking } from './exam-blueprint-material.js';
import { isNewerVersion, parseVersion } from './semver.js';

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
/** The lowest StudyHub that can update the review book of an outline this release writes (`minReader`, #487): raise it when an outline stops being readable by what comes before.
    Only a release holding the check reads it (lib/contexts/generation/book/plan.js): the ones already out ignore it (docs/review-book.md "Rolling back"). */
export const OUTLINE_MIN_READER = '3.5.0';
export const OUTLINE_LIMITS = Object.freeze({ depth: 3, nodes: 800, titleChars: 80, introChars: 360, anchors: 6000, papers: 20, evidence: 6, quoteChars: 400, basisChars: 200,
  items: 400 });
const ITEM = /^i[0-9a-f]{11}$/;
/** How fine a build cuts the course into knowledge points (`shape.granularity`, #462): 'medium' is the cut every build made before the option existed. */
export const OUTLINE_GRANULARITIES = Object.freeze(['coarse', 'medium', 'fine']);
/** The cut a build was asked for, kept so a rebuild keeps it: { granularity?, maxPoints? } (only what was asked). */
export function outlineShape(raw) {
  const granularity = OUTLINE_GRANULARITIES.includes(raw?.granularity) ? raw.granularity : null;
  const maxPoints = Number.isInteger(raw?.maxPoints) && raw.maxPoints >= 1 && raw.maxPoints <= OUTLINE_LIMITS.nodes ? raw.maxPoints : null;
  return { ...(granularity ? { granularity } : {}), ...(maxPoints ? { maxPoints } : {}) };
}
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
  const seen = new Set();
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
    // An outline built from the 清点 names the items each knowledge point teaches (lib/course-book-inventory.js), each in one leaf.
    const items = (Array.isArray(node.items) ? node.items : []).filter(item => ITEM.test(item) && !seen.has(item) && seen.add(item)).slice(0, OUTLINE_LIMITS.items);
    const own = { ...base, anchors, ...(items.length ? { items } : {}) };
    if (!papers.length || !node.exam) return own;
    const evidence = (Array.isArray(node.exam.evidence) ? node.exam.evidence : []).slice(0, OUTLINE_LIMITS.evidence).map(place => normalizePlace(place, papers));
    return { ...own, ...(evidence.length ? { exam: { evidence } } : {}) };
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

/** An outline built by chapters (深度定制 S2, lib/contexts/generation/book/part-outline.js): which chapter of the materials (`key`, lib/custom-skeleton.js basis
    'documents': `doc#i` or a document key; `doc` its material) each top-level node is, with what finds it again after the material is converted anew (its
    `title`, `pages` [first, last] and `textPrint`) and its `print` when it was built (partPrint; null for a chapter the material no longer has, `lost`). Several keys may
    name one node (the chapters inside one text are read as one). A row naming no top-level node is dropped; a lost row keeps its old key beside a new one. */
function normalizeParts(raw, nodes) {
  const tops = new Set(nodes.map(node => node.id)), seen = new Set();
  const pagesOf = pages => (Array.isArray(pages) && pages.length === 2 && pages.every(Number.isInteger) ? { pages: [...pages] } : {});
  return (Array.isArray(raw) ? raw : []).map(part => ({ key: clip(part?.key, 300), doc: clip(part?.doc, 300), node: part?.node,
    ...(part?.title ? { title: clip(part.title, OUTLINE_LIMITS.titleChars) } : {}), ...pagesOf(part?.pages),
    ...(typeof part?.textPrint === 'string' && part.textPrint ? { textPrint: clip(part.textPrint, 40) } : {}),
    ...(typeof part?.print === 'string' || part?.print === null ? { print: part.print } : {}), ...(part?.lost === true ? { lost: true } : {}) }))
    .filter(part => part.key && part.doc && tops.has(part.node) && (part.lost || (!seen.has(part.key) && seen.add(part.key))));
}

/**
 * Check and shape the structured outline. Throws a plain Error naming the first problem.
 * @param input { course, language?, orderBasis: { codes, syllabus? }, nodes, other?: { anchors }, papers?: [{ key, title?, sourceIds, fingerprint? }],
 *                fingerprint, counts?, parts?: [{ key, doc, node }], supersedes? }
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
  const counts = Object.fromEntries(['units', 'leftover', 'invalid', 'repeated', 'items', 'unplaced'].map(name => [name, Number.isInteger(input.counts?.[name]) ? input.counts[name] : 0]));
  // Points left above the build's maxPoints (chapters are never merged to reach it, outline/fit.js); absent when the cap held.
  if (Number.isInteger(input.counts?.overCap) && input.counts.overCap > 0) counts.overCap = input.counts.overCap;
  if (!/^[0-9a-f]{8}$/.test(String(input.fingerprint))) fail('A course outline records the fingerprint of the materials it was built from');
  const parts = normalizeParts(input.parts, nodes);
  return { version: COURSE_OUTLINE_VERSION, course: input.course, ...(input.language === 'en' ? { language: 'en' } : { language: 'zh' }),
    orderBasis: { codes: [...new Set(codes)], ...(syllabus && codes.includes('syllabus') ? { syllabus } : {}) }, nodes, other: { anchors: other },
    ...(papers.length ? { papers } : {}), ...(['auto', 'learner'].includes(input.papersBy) ? { papersBy: input.papersBy } : {}),
    // What it was built from: the 清点 (knowledge points of items) or, as the quick fallback, the descriptors of the materials; and the 清点 it read.
    ...(Object.keys(outlineShape(input.shape)).length ? { shape: outlineShape(input.shape) } : {}),
    ...(['inventory', 'descriptors'].includes(input.from) ? { from: input.from } : {}), ...(/^[0-9a-f]{16}$/.test(String(input.inventoryPrint)) ? { inventoryPrint: input.inventoryPrint } : {}),
    fingerprint: input.fingerprint, counts, ...(parts.length ? { parts } : {}), ...(input.supersedes ? { supersedes: clip(input.supersedes, 200) } : {}),
    // A record that continues another (extended, marked again by papers) keeps that one's floor when it is higher: never lowered.
    minReader: parseVersion(input.minReader) && isNewerVersion(input.minReader, OUTLINE_MIN_READER) ? input.minReader : OUTLINE_MIN_READER };
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

/** The fingerprint of a course's materials as the outline engine sees them (their keys, names, pages, chapters, size and content): a change shows the outline as out of date. */
export function materialsFingerprint(documents) {
  const rows = (Array.isArray(documents) ? documents : []).map(item => [item.key, item.title, (item.sourceIds || []).join(','),
    (item.chapters || []).map(chapter => chapter.title).join('|'), item.chars ?? 0, ...(item.textPrint ? [item.textPrint] : [])].join('\u0001')).sort();
  return inputFingerprint(rows);
}

/** What a chapter of the materials (or a whole material) is made of, as staleness sees it: its pages, its size and its content digest. */
export const partPrint = ({ sourceIds, chars, textPrint }) => inputFingerprint([
  (sourceIds || []).join(','), String(chars ?? 0), ...(textPrint ? [textPrint] : []),
]);

const fromChapter = (doc, chapter) => ({
  key: `${doc.key}#${chapter.index}`,
  title: chapter.title,
  pages: [chapter.startPage, chapter.endPage],
  sourceIds: chapter.sourceIds,
  chars: chapter.chars,
  ...(chapter.textPrint ? { textPrint: chapter.textPrint } : {}),
});

function pageShare(a, b) {
  if (!Array.isArray(a) || a.length !== 2 || !Array.isArray(b) || b.length !== 2) return 0;
  const overlap = Math.min(a[1], b[1]) - Math.max(a[0], b[0]) + 1;
  if (overlap <= 0) return 0;
  const span = Math.max(a[1] - a[0] + 1, b[1] - b[0] + 1);
  return span > 0 ? overlap / span : 0;
}

/** Match the parts of one document in two passes over unclaimed chapters: first by exact (index + title), title (nearest page), or exact pages; then by identical
    chapter textPrint or page-range overlap >= MOVE_MIN_SHARE (so a chapter renamed and moved at the same time keeps its node). */
function matchDocParts(entries, doc, found) {
  const chapterEntries = [];
  for (const entry of entries) {
    if (entry.part.key === doc.key) {
      found.set(entry.at, { key: doc.key, title: doc.title, pages: [1, Math.max(1, doc.totalPages || doc.pages?.length || 1)],
        sourceIds: doc.sourceIds, chars: doc.chars, ...(doc.textPrint ? { textPrint: doc.textPrint } : {}) });
    } else chapterEntries.push(entry);
  }
  if (!chapterEntries.length) return;
  const chapters = (doc.chapters || []).filter(chapter => !chapter.front), claimed = new Set(), paged = doc.chapterUnit !== 'text';
  const ordered = [...chapterEntries].sort((a, b) => Number(!!a.part.lost) - Number(!!b.part.lost) || a.at - b.at);
  const near = (part, chapter) => Math.abs(chapter.startPage - (part.pages?.[0] ?? chapter.startPage));
  const free = () => chapters.filter(chapter => !claimed.has(chapter.index));
  const take = (at, chapter) => { claimed.add(chapter.index); found.set(at, fromChapter(doc, chapter)); };
  for (const { part, at } of ordered) {
    const index = Number(/#(\d+)$/.exec(part.key)?.[1]);
    const exact = free().find(chapter => chapter.index === index && (!part.title || chapter.title === part.title));
    if (exact) take(at, exact);
  }
  for (const { part, at } of ordered) {
    if (found.has(at) || !part.title) continue;
    const hit = free().filter(chapter => chapter.title === part.title).sort((a, b) => near(part, a) - near(part, b))[0];
    if (hit) take(at, hit);
  }
  if (paged) for (const { part, at } of ordered) {
    if (found.has(at) || part.lost || !part.pages) continue;
    const hit = free().find(chapter => chapter.startPage === part.pages[0] && chapter.endPage === part.pages[1]);
    if (hit) take(at, hit);
  }
  const sameText = (part, chapter) => (part.textPrint ? Boolean(chapter.textPrint) && chapter.textPrint === part.textPrint
    : Boolean(part.print) && partPrint(fromChapter(doc, chapter)) === part.print);
  for (const { part, at } of ordered) {
    if (found.has(at)) continue;
    const hit = free().filter(chapter => sameText(part, chapter)).sort((a, b) => near(part, a) - near(part, b))[0];
    if (hit) take(at, hit);
  }
  if (paged) {
    const pairs = [];
    for (const { part, at } of ordered) {
      if (found.has(at) || part.lost || !part.pages) continue;
      for (const chapter of free()) {
        const share = pageShare(part.pages, [chapter.startPage, chapter.endPage]);
        if (share >= MOVE_MIN_SHARE) pairs.push({ at, chapter, share, dist: near(part, chapter) });
      }
    }
    pairs.sort((a, b) => b.share - a.share || a.dist - b.dist || a.at - b.at);
    for (const pair of pairs) if (!found.has(pair.at) && !claimed.has(pair.chapter.index)) take(pair.at, pair.chapter);
  }
}

/** The parts of an outline built by chapters as the materials hold them now: [{ part, now, key (the current one), print, changed, lost }]. `changed`: its pages,
    size or content moved since it was built (a legacy part without a print counts as unchanged while its chapter is found); a lost part is changed until recorded lost. */
export function partsNow(parts, documents) {
  const list = Array.isArray(parts) ? parts : [];
  const byKey = new Map((Array.isArray(documents) ? documents : []).map(doc => [doc.key, doc]));
  const byDoc = new Map(), found = new Map();
  list.forEach((part, at) => {
    if (!byDoc.has(part.doc)) byDoc.set(part.doc, []);
    byDoc.get(part.doc).push({ part, at });
  });
  for (const [docKey, entries] of byDoc) {
    const doc = byKey.get(docKey);
    if (doc) matchDocParts(entries, doc, found);
  }
  return list.map((part, at) => {
    const now = found.get(at) ?? null, print = now ? partPrint(now) : null;
    return { part, now, key: now?.key ?? part.key, print, changed: part.print === undefined ? !now : print !== part.print, lost: !now };
  });
}

/** The parts to record: each as the materials hold it now (its current key, title, pages, textPrint and print), a lost one kept with print null (never dropped). */
export const settledParts = (parts, documents) => partsNow(parts, documents).map(({ part, now, key, print }) => (now
  ? { key, doc: part.doc, node: part.node, title: now.title, pages: now.pages, ...(now.textPrint ? { textPrint: now.textPrint } : {}), print }
  : { ...part, print: null, lost: true }));

/** Is an outline out of date? THE ONE RULE. A whole outline: the course's materials changed since it was made (their fingerprint). An outline built by chapters
    (`parts`): one of ITS chapters changed (its pages, size or content), or one it holds is no longer in the materials and not yet said so; a chapter not built, another
    chapter of the same material, or a new material is no change of it, so an edit there never makes the whole book out of date. */
export const outlineStale = (outline, documents) => (outline.parts?.length ? partsNow(outline.parts, documents).some(entry => entry.changed)
  : outline.fingerprint !== materialsFingerprint(documents));

/** The outline of a course: the newest one that is not archived, filed under exactly that course (an empty string: the uncategorised one). */
export function currentCourseOutline(sources, course) {
  if (typeof course !== 'string' || course === '*') return null;
  const mine = (Array.isArray(sources) ? sources : []).filter(source => isCourseOutlineSource(source) && !source.archived && source.courseOutline.version === COURSE_OUTLINE_VERSION
    && (course === '' ? !(source.courses || []).length : (source.courses || []).includes(course)));
  return mine.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || String(a.id).localeCompare(String(b.id)))[0] ?? null;
}

export { isCourseOutlineSource };
