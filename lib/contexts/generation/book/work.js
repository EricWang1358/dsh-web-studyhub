import { createHash } from 'node:crypto';
import { documentIndex, examFingerprint, leafSegments, outlineLeaves, previousLeaf } from '../../../course-book-inputs.js';
import { displayTitle } from '../../../document-title.js';
import { assignItems, checklistOf } from './checklist.js';
import { EXAM_LEAVES_PER_CALL, WRITE_VERSION } from './constants.js';
import { leafSources, short16, textPrint, unitsOf } from './sources.js';

/* What one review book build has to do, decided by the program before any call: for each knowledge point of the outline its MUST-COVER checklist (from the
   inventory), the pages it is written from and the units it is written in, and whether its explanation is kept (the same pages, checklist and neighbours
   read before, and it passed: no call), mended (the same, but it was short: review and repair only what is missing) or written. Its exam notes as before.
   With `point` (fill the gaps of one point) only that point is worked on. Pure: no model, no clock. */

const short = value => createHash('sha1').update(JSON.stringify(value)).digest('hex').slice(0, 12);

/** The fingerprint of an explanation: the writing's version, the language, the detail level, the texts read, the checklist and the neighbours. */
const printOf = ({ language, level, readPrint, checklist, before, after, tested }) => short16(['book', WRITE_VERSION, language === 'en' ? 'en' : 'zh', level, readPrint,
  checklist.map(item => [item.id, item.name, item.priority]), before ?? null, after ?? null, !!tested]);

/** Can the units of an earlier body be mended unit by unit (the same number of units)? */
const mendable = (body, units) => Array.isArray(body?.units) && body.units.length === units.length;

/**
 * @param input { state, documents (allDocuments), outline (record), previous (notes record | null), language, level, point, inventory (courseInventory | null),
 *        ranges (the inventory's ranges with their texts) }
 * @returns { items: [leaf work], unplaced: [item id], extend: [{ id, items }], examBatches, papers, level }
 */
export function bookWork({ state, documents, outline, previous, language, level, point = null, inventory = null, ranges = [], placed }) {
  const byId = new Map((state.sources || []).map(source => [source.id, source])), docs = documentIndex(documents);
  const titles = new Map(documents.map(doc => [doc.key, displayTitle(doc.title)])), papers = outline.courseOutline.papers || [];
  const earlier = previous?.courseNotes.language === language ? previous.courseNotes.leaves : [];
  const byPrint = new Map(earlier.filter(leaf => leaf.body?.units).map(leaf => [leaf.body.fingerprint, leaf.body]));
  const leaves = (outline.courseOutline.nodes || []).flatMap((top, chapter) => outlineLeaves([top]).map(leaf => ({ ...leaf, chapter, chapterTitle: top.title })));
  const assigned = assignItems(leaves.map(({ node }) => ({ id: node.id, items: node.items, segments: leafSegments(byId, docs, node.anchors) })), inventory, placed);
  const extend = leaves.filter(({ node }) => node.items && assigned.byLeaf.get(node.id).length > node.items.length)
    .map(({ node }) => ({ id: node.id, items: assigned.byLeaf.get(node.id) }));
  const items = leaves.map(({ node, path, chapter, chapterTitle }, at) => {
    const tested = !!node.exam?.evidence?.length, before = leaves[at - 1]?.node.title ?? null, after = leaves[at + 1]?.node.title ?? null;
    const checklist = checklistOf(assigned.byLeaf.get(node.id), inventory, { level, tested, titles });
    const segments = leafSources({ node, checklist }, { byId, docs, documents, ranges }), units = unitsOf(segments, checklist);
    const readPrint = textPrint(units.flatMap(unit => unit.segments).map(segment => segment.text));
    const fingerprint = printOf({ language, level, readPrint, checklist, before, after, tested });
    const own = previousLeaf(earlier, node), same = own?.body?.fingerprint === fingerprint ? own.body : byPrint.get(fingerprint) ?? null;
    const others = point && node.id !== point, asked = point && node.id === point;
    let mode = 'write', body = null;
    if (!segments.length && !checklist.length) { mode = 'keep'; body = { fingerprint, empty: true }; }
    else if (others) { mode = 'keep'; body = own?.body ?? null; }
    else if (same?.status === 'ok' && !asked) { mode = 'keep'; body = same; }
    // Mended: by 补漏 of this point, or by any build while a pass of it was never written; a point left short is otherwise kept as it is (no call).
    // Only a body of the same pages, checklist and level can be mended: one written against another checklist is written again.
    else if (asked && same && mendable(same, units)) { mode = 'mend'; body = same; }
    else if (same && mendable(same, units) && same.units.some(unit => unit.status === 'pending')) { mode = 'mend'; body = same; }
    else if (same) { mode = 'keep'; body = same; }
    const item = { id: node.id, title: node.title, path, ...(node.intro ? { intro: node.intro } : {}), anchors: node.anchors, chapter, chapterTitle, before, after, tested,
      evidence: node.exam?.evidence || [], checklist, segments, units, readPrint, fingerprint, mode, ...(asked ? { asked: true } : {}), ...(body ? { body } : {}), needsExam: false,
      ...(previous && own?.body && mode !== 'keep' ? { replaces: previous.id, earlier: own.body } : {}) };
    if (papers.length) {
      const examPrint = examFingerprint(language, node, papers), keptExam = own?.exam?.fingerprint === examPrint ? own.exam
        : !item.evidence.length ? { fingerprint: examPrint, tested: false } : others ? own?.exam ?? null : null;
      Object.assign(item, { examFingerprint: examPrint, ...(keptExam ? { exam: keptExam } : {}), needsExam: !keptExam && !others,
        ...(previous && own?.exam && !keptExam ? { examReplaces: previous.id } : {}) });
    }
    return item;
  });
  const examNeeded = items.filter(item => item.needsExam), examBatches = [];
  for (let at = 0; at < examNeeded.length; at += EXAM_LEAVES_PER_CALL) {
    const members = examNeeded.slice(at, at + EXAM_LEAVES_PER_CALL);
    examBatches.push({ number: examBatches.length + 1, items: members, key: `cb:exam:${short(members.map(item => [item.id, item.examFingerprint]))}` });
  }
  return { items, unplaced: assigned.unplaced, extend, examBatches, papers, level };
}
