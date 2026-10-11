import { createHash } from 'node:crypto';
import { documentIndex, examFingerprint, leafSegments, outlineLeaves, previousLeaf } from '../../../course-book-inputs.js';
import { acceptedPrints, excerpt, levelOf, readingOf } from '../../../course-book-reading.js';
import { BRIDGES_PER_CALL, CALL_CHARS, EXAM_LEAVES_PER_CALL, LEAVES_PER_CALL, SUMMARY_CHARS } from './constants.js';

/* What one review book build has to do, decided by the program before any call: for each knowledge point of the outline, whether its explanation (body) and
   its exam notes (exam) are kept as they are (no call) or written, and the calls they are written in. Pure: no model, no clock.

   How much of a point's material is read is the build's 讲解详尽程度 (`coverage`, lib/course-book-reading.js): a point that fits one shared call (and every point
   at 精简) is explained with a few others in one call; a bigger one at 标准 / 详尽 in passes, each pass its own call over its own pages (so a failed pass is
   asked again alone).
   A body is kept when an earlier explanation of the SAME texts in the same language exists that read at least what this level reads (acceptedPrints: the same
   level again asks nothing, a lower level keeps a more detailed explanation, a higher one asks only where it reads more): the leaf it continues
   (lib/course-book-inputs.js previousLeaf; after an outline rebuild the ids are new), else any earlier leaf of such a fingerprint. Exam notes are kept when the
   leaf's paper places did not change; a leaf no paper tests needs no call (it says so); without papers there are none. A leaf whose materials have no readable
   text has an empty body and no call. With `point` (读更多 of one knowledge point) only that point is written; every other keeps what it has. */

const short = value => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);

export { excerpt };

/** Consecutive leaves in calls of at most LEAVES_PER_CALL leaves and CALL_CHARS characters of material (a leaf alone may fill a call). */
export function packLeaves(items, { leaves = LEAVES_PER_CALL, chars = CALL_CHARS } = {}) {
  const batches = [];
  let current = [], size = 0;
  for (const item of items) {
    const length = item.shown.reduce((sum, part) => sum + part.text.length, 0);
    if (current.length && (current.length >= leaves || size + length > chars)) { batches.push(current); current = []; size = 0; }
    current.push(item); size += length;
  }
  if (current.length) batches.push(current);
  return batches.map((members, at) => ({ number: at + 1, items: members, key: `cb:notes:${short(members.map(item => [item.id, item.fingerprint]))}` }));
}

/** One call per pass of a big point, after the shared calls; a pass is shown and quoted from its own pages only. */
function passBatches(items, first) {
  const batches = [];
  items.forEach((item, at) => {
    if (!item.needsBody || !item.passes) return;
    item.passes.forEach((pass, k) => {
      const member = { id: item.id, title: item.title, path: item.path, ...(item.intro ? { intro: item.intro } : {}), evidence: item.evidence, segments: pass.pieces, shown: pass.pieces,
        quotes: pass.quotes, part: { n: k + 1, of: item.passes.length, labels: pass.labels } };
      batches.push({ number: first + batches.length, items: [member], leafAt: at, pass: k, key: `cb:pass:${short([item.id, item.fingerprint, k])}` });
    });
  });
  return batches;
}

/** The one-line summary of a point's notes a bridge is written from: its 一句话 (else the first sentence of its explanation, else its first key point), marks out. */
export function summaryOf(body) {
  if (!body || body.empty) return '';
  const first = body.parts?.[0], text = body.explain || first?.explain || body.points?.[0] || first?.points?.[0] || '';
  const plain = text.replace(/\s?\[\^\d{1,2}\]/g, '').replace(/\$[^$]*\$/g, '').replace(/\s+/g, ' ').trim();
  const lead = /^(?:一句话|In one sentence)\s*[:：]\s*/i.exec(plain), rest = lead ? plain.slice(lead[0].length) : plain;
  const sentence = /^.+?(?:[。！？!?]|\.(?=\s|$))/.exec(rest)?.[0] ?? rest;
  return sentence.slice(0, SUMMARY_CHARS).trim();
}

/**
 * The bridges a build writes, once the explanations are known: per chapter its points that have an explanation, in order, each with its neighbours. A point
 * keeps its bridge when its fingerprint (the language, the chapter, the titles and summaries of the point and its two neighbours) is the one it was written for;
 * the others are asked in calls of at most BRIDGES_PER_CALL consecutive points of one chapter. Pure. -> { batches: [{ number, chapter, items, key }] }; every
 * item gets `bridgeFingerprint` and keeps `bridge` when it is current.
 */
export function bridgeWork(items, language, first = 1) {
  const chapters = new Map();
  for (const item of items) {
    if (!item.body || item.body.empty || !summaryOf(item.body)) continue;
    if (!chapters.has(item.chapter)) chapters.set(item.chapter, []);
    chapters.get(item.chapter).push(item);
  }
  const batches = [];
  for (const members of chapters.values()) {
    const needed = [];
    members.forEach((item, at) => {
      const near = other => (other ? { title: other.title, summary: summaryOf(other.body) } : null);
      Object.assign(item, { summary: summaryOf(item.body), before: near(members[at - 1]), after: near(members[at + 1]) });
      // 16 hex digits, as every fingerprint of the record.
      item.bridgeFingerprint = createHash('sha1').update(JSON.stringify(['bridge', language === 'en' ? 'en' : 'zh', item.chapterTitle, item.before, [item.title, item.summary], item.after])).digest('hex').slice(0, 16);
      if (item.priorBridge?.fingerprint === item.bridgeFingerprint) item.bridge = item.priorBridge;
      else { delete item.bridge; needed.push(item); }
    });
    for (let at = 0; at < needed.length; at += BRIDGES_PER_CALL) {
      const part = needed.slice(at, at + BRIDGES_PER_CALL);
      batches.push({ number: first + batches.length, chapter: part[0].chapterTitle, items: part, key: `cb:bridge:${short(part.map(item => [item.id, item.bridgeFingerprint]))}` });
    }
  }
  return { batches };
}

/**
 * @param state the library as read at the start; `documents` the course's documents (buildOutlineIndex allDocuments); `outline` the outline record explained;
 *        `previous` the course's current notes record or null; `coverage` the 讲解详尽程度 ('brief' | 'standard' | 'full'); `point` the one node id 读更多 writes.
 * @returns { items: [{ id, title, path, intro?, anchors, segments, shown, fingerprint, passes?, body?, needsBody, exam?, examFingerprint?, evidence, needsExam,
 *            replaces? }], bodyBatches (the shared calls, then one per pass: { leafAt, pass }), examBatches, papers }
 */
export function notesWork(state, documents, outline, previous, language, { coverage, point = null } = {}) {
  const level = levelOf(coverage);
  const byId = new Map((state.sources || []).map(source => [source.id, source])), docs = documentIndex(documents);
  const papers = outline.courseOutline.papers || [], earlier = previous?.courseNotes.language === language ? previous.courseNotes.leaves : [];
  const byPrint = new Map(earlier.filter(leaf => leaf.body).map(leaf => [leaf.body.fingerprint, leaf.body]));
  // Each leaf with its chapter (the top node it is under): the bridges are written chapter by chapter.
  const leaves = (outline.courseOutline.nodes || []).flatMap((top, chapter) => outlineLeaves([top]).map(leaf => ({ ...leaf, chapter, chapterTitle: top.title })));
  const items = leaves.map(({ node, path, chapter, chapterTitle }) => {
    const segments = leafSegments(byId, docs, node.anchors), reading = readingOf(segments, level, language), fingerprint = reading.fingerprint;
    const before = previousLeaf(previous?.courseNotes.leaves, node), own = earlier.includes(before) ? before : null, accepted = acceptedPrints(segments, level, language);
    const same = own?.body && accepted.has(own.body.fingerprint) ? own.body : [...accepted].map(print => byPrint.get(print)).find(Boolean);
    // 读更多 of another point: this one keeps what it has, current or not.
    const others = point && node.id !== point;
    const kept = same ? same : !segments.length ? { fingerprint, empty: true } : others ? own?.body ?? null : null;
    const item = { id: node.id, title: node.title, path, ...(node.intro ? { intro: node.intro } : {}), anchors: node.anchors, segments, shown: reading.shown ?? [],
      fingerprint, ...(reading.passes ? { passes: reading.passes } : {}), ...(kept ? { body: kept } : {}), needsBody: !kept && !others,
      evidence: node.exam?.evidence || [], needsExam: false, ...(previous && before?.body && !kept ? { replaces: previous.id, earlier: before.body } : {}),
      chapter, chapterTitle, ...(own?.bridge ? { priorBridge: own.bridge } : {}) };
    if (papers.length) {
      const examPrint = examFingerprint(language, node, papers);
      const keptExam = before?.exam?.fingerprint === examPrint && earlier.includes(before) ? before.exam : !item.evidence.length ? { fingerprint: examPrint, tested: false }
        : others ? own?.exam ?? null : null;
      Object.assign(item, { examFingerprint: examPrint, ...(keptExam ? { exam: keptExam } : {}), needsExam: !keptExam && !others,
        ...(previous && before?.exam && !keptExam ? { examReplaces: previous.id } : {}) });
    }
    return item;
  });
  const examNeeded = items.filter(item => item.needsExam), examBatches = [];
  for (let at = 0; at < examNeeded.length; at += EXAM_LEAVES_PER_CALL) {
    const members = examNeeded.slice(at, at + EXAM_LEAVES_PER_CALL);
    examBatches.push({ number: examBatches.length + 1, items: members, key: `cb:exam:${short(members.map(item => [item.id, item.examFingerprint]))}` });
  }
  const shared = packLeaves(items.filter(item => item.needsBody && !item.passes));
  return { items, bodyBatches: [...shared, ...passBatches(items, shared.length + 1)], examBatches, papers, coverage: level };
}
