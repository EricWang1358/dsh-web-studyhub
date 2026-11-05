import { createHash } from 'node:crypto';
import { currentCourseOutline, materialsFingerprint } from '../../../course-outline-book.js';
import { currentCourseNotes } from '../../../course-book.js';
import { currentInventory } from '../../../course-book-inventory.js';
import { documentIndex, outlineLeaves } from '../../../course-book-inputs.js';
import { buildOutlineIndex, parseSpan } from '../../../course-outline-index.js';
import { planOutline, planPapersOnly } from '../outline/plan.js';
import { COVERAGE_LEVELS, bookCoverage } from '../../../book-settings.js';
import { REFUSALS, notesTitle } from './jobs/messages.js';
import { choosePapers } from '../outline/papers.js';
import { planInventory } from '../inventory/plan.js';
import { effortsOf } from '../inventory/policy.js';
import { isNewerVersion } from '../../../semver.js';
import { currentVersion } from '../../../update-check.js';
import { pitchLanguage } from './pitch-language.js';
import { candidateOf, pickSample, sampleMode } from './sample.js';
import { PART_CHAPTERS_MAX, partLeaves } from '../../../course-book-parts.js';

/* The plan of one review book build, pure: no model, no library write, no clock. Stage 0 (`planBook`) decides what the inventory reads (every range that is
   not known yet) and what the outline needs, and refuses (with a code, in the learner's words) before any model call. The only precondition is a course with
   at least one material.

   The outline:
     'full'   there is none, the course's materials changed since it was made, or it was not built from the inventory: the outline build's own plan, built from
              the inventory the first stage reads (outline/jobs/inventory-stages.js);
     'papers' the sample papers changed (the learner's, else the ones recognised by name): only the papers mark the leaves again;
     'keep'   the outline is current.
   The points are planned once the inventory and the outline are known (book/work.js), so a rebuild asks only what changed.

   The sample (#710, book/sample.js): what the build does about it is decided here (`sample`: make one; `anchor`: the approved sample its requests carry;
   `confirm`: it builds the rest of the waiting one). When the outline is kept and the book holds nothing but its sample, the whole book is to write, so the
   two points are picked here and the inventory reads only their materials (as the gap fill of one point does); otherwise the Job picks them once it knows what to write.

   `cards: true` (add term cards, #710 S6) touches no text: nothing is read, the outline is kept, every point keeps its body and only the card pass runs,
   in the book's own language; a course without a book is refused.

   `chapters` (#708, lib/course-book-parts.js): the chapters of the current outline the learner picked. Only their points are written (`only`) and only their
   materials read, as the gap fill of one point reads; every other point keeps what it has, so building another chapter later re-pays nothing. A pick needs the
   outline it names (refused when there is none or it is organised again first); building the rest of a waiting sample keeps the sample's pick. */

const refuse = (code, language, detail) => Object.assign(new Error(REFUSALS[code](language, detail)), { code });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameSet = (a, b) => a.length === b.length && a.every(item => b.includes(item));

/** Is the outline the one the inventory makes? Built from it, or (the quick fallback) from the descriptors while the inventory, unchanged, found nothing. */
const fromInventory = (outline, inventory) => outline.from === 'inventory'
  || (outline.from === 'descriptors' && !inventory.calls.length && !(inventory.previous?.courseInventory.items.length));

/** Was this outline written for a newer release than `reader`? Then updating the book cannot be trusted to read its anchors and would write empty explanations (#487). A record of a
    release before the field, or a value that is no version, has no floor. */
export const readerTooOld = (outline, reader) => isNewerVersion(outline?.minReader, reader);

/** The documents some points (a Set of node ids: a gap fill's one, the sample's, a pick's) read: their anchors' documents and those of the inventory items they hold. */
function pointDocs(documents, outline, points, previousInventory) {
  const docs = documentIndex(documents), own = new Set(), wanted = new Set();
  for (const { node } of outlineLeaves(outline.courseOutline.nodes).filter(entry => points.has(entry.node.id))) {
    for (const anchor of node.anchors || []) {
      const span = docs.has(anchor) ? null : parseSpan(anchor), base = span ? docs.get(span.doc) : docs.get(anchor);
      if (base) own.add(base.item.key);
    }
    for (const item of node.items || []) wanted.add(item);
  }
  for (const item of previousInventory?.courseInventory.items || []) if (wanted.has(item.id)) {
    for (const place of item.places || []) if (place.doc) own.add(place.doc);
  }
  return own;
}

/** The points a blank book writes, as the sample's pick sees them: every leaf of the outline with an anchor (of the picked chapters, `only`, when there is a pick). */
const outlineCandidates = (outline, only) => outlineLeaves(outline.courseOutline.nodes).filter(({ node }) => node.anchors?.length && (!only || only.has(node.id)))
  .map(({ node }) => candidateOf(node));

/** The chapters a request names, or null when it names none (`chapters` absent); an empty list is a pick of nothing, refused by the plan. */
const chaptersOf = value => (Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && id))].slice(0, PART_CHAPTERS_MAX) : null);

/** Does the book (in this language) hold no explanation but its sample's? Then the whole book is to write. */
function blankBook(previous, language) {
  const own = previous?.courseNotes.language === language ? previous.courseNotes : null, sample = new Set(own?.sample?.leaves || []);
  return !own || own.leaves.every(leaf => !leaf.body || leaf.body.empty || sample.has(leaf.id));
}

/** @param request { course, language?, papers?: [document key, document id or page id], coverage?: the detail level (else the saved settings.book.coverage),
    point?: the node id whose gaps are filled, sample?: 'auto' | 'confirm' | 'skip' (book/sample.js), cards?: only the card pass, concurrency?: the learner's text concurrency,
    chapters?: [chapter node id] the picked part (#708) }; refused with course-book-part-outline / course-book-part-invalid;
    `reader`: the release running (a test's). */
export function planBook(state, request = {}, { reader = currentVersion() } = {}) {
  const requested = request.language === 'en' ? 'en' : 'zh', course = request.course, cardsOnly = request.cards === true;
  const coverage = COVERAGE_LEVELS.includes(request.coverage) ? request.coverage : bookCoverage(state.settings?.book);
  const point = typeof request.point === 'string' && request.point ? request.point : null;
  if (typeof course !== 'string' || course === '*') throw refuse('course-book-no-course', requested);
  const documents = buildOutlineIndex(state, { course }).allDocuments;
  if (!documents.length) throw refuse('course-book-no-materials', requested);
  const outline = currentCourseOutline(state.sources, course), previous = currentCourseNotes(state.sources, course);
  if (cardsOnly && !(outline && previous)) throw refuse('course-book-no-book', requested);
  // The cards of a book are written in its language, whatever the language of the page that asked.
  const language = cardsOnly ? (previous.courseNotes.language === 'en' ? 'en' : 'zh') : requested;
  if (readerTooOld(outline?.courseOutline, reader)) throw refuse('course-book-needs-newer', requested, { needs: outline.courseOutline.minReader, running: reader });
  const own = (outline?.courseOutline.papers || []).map(paper => paper.key);
  // The papers: the learner's, else the outline's own when the learner chose them, else the ones recognised by name (used by default).
  const chosen = choosePapers(documents, { asked: Array.isArray(request.papers) ? request.papers : null, outline: outline?.courseOutline ?? null });
  // A paper only guessed by its name that has no text is left out here too, so the outline's papers and these agree (no re-reading on every update).
  const readable = key => { const doc = documents.find(item => item.key === key), byId = new Map((state.sources || []).map(source => [source.id, source]));
    return !!doc && doc.sourceIds.some(id => String(byId.get(id)?.text ?? '').trim()); };
  const asked = chosen.by === 'auto' ? chosen.keys.filter(readable) : chosen.keys;
  // The inventory runs first (an unchanged range costs nothing); filling one point's gaps leaves unread materials outside that point for a whole-book update.
  const onlyDocs = cardsOnly ? new Set() : point && outline ? pointDocs(documents, outline, new Set([point]), currentInventory(state.sources, course)) : null;
  let inventory = planInventory(state, documents, { course, language, papers: new Set(asked), onlyDocs });
  // The card pass writes no text, so it makes no sample.
  const asking = cardsOnly ? 'skip' : ['confirm', 'skip'].includes(request.sample) ? request.sample : 'auto';
  const sampling = sampleMode({ asked: asking, point, sample: previous?.courseNotes.sample ?? null, level: coverage, language });
  if (sampling.stale) throw refuse('course-book-sample-stale', language);
  // An outline of an older version (not built from the inventory) is made again only when the learner says so (`rebuildOutline`): the book keeps it, and its
  // notes are built on it, until then (the page offers it once, saying the learner's notes follow by place).
  const rebuild = !!outline && !fromInventory(outline.courseOutline, inventory) && (request.rebuildOutline === true || outline.courseOutline.from === 'descriptors');
  const mode = (point || cardsOnly) && outline ? 'keep'
    : !outline || outline.courseOutline.fingerprint !== materialsFingerprint(documents) || rebuild ? 'full' : !sameSet(asked, own) ? 'papers' : 'keep';
  // The picked chapters (building the rest of a waiting sample: the sample's), on the outline as it is: their points only, and their materials only read.
  const chapters = point || cardsOnly ? null : chaptersOf(request.chapters) ?? (sampling.confirm ? previous?.courseNotes.sample?.chapters ?? null : null);
  let only = null;
  if (chapters) {
    if (mode === 'full') throw refuse('course-book-part-outline', language);
    only = partLeaves(outline.courseOutline.nodes, chapters);
    if (!only) throw refuse('course-book-part-invalid', language);
    const onlyDocs = pointDocs(documents, outline, only, currentInventory(state.sources, course));
    inventory = planInventory(state, documents, { course, language, papers: new Set(asked), onlyDocs });
  }
  // A blank book on a kept outline: the sample's points now, and the inventory of their materials only (what else is read waits for the rest).
  const pick = sampling.make && mode !== 'full' && blankBook(previous, language) ? pickSample(outlineCandidates(outline, only), previous?.courseNotes.sample) : null;
  let inventoryLeft = 0;
  if (pick) {
    const own = pointDocs(documents, outline, new Set([pick.typical, pick.heavy]), currentInventory(state.sources, course));
    const narrow = planInventory(state, documents, { course, language, papers: new Set(asked), onlyDocs: own });
    inventoryLeft = inventory.calls.length - narrow.calls.length; inventory = narrow;
  }
  const outlineRequest = { course, language, papers: asked, papersBy: chosen.by, inventory: false };
  const outlinePlan = mode === 'full' ? planOutline(state, outlineRequest) : mode === 'papers' ? planPapersOnly(state, outlineRequest) : null;
  const planKey = digest([course, language, outline?.id ?? null, previous?.id ?? null, outlinePlan?.planKey ?? null, materialsFingerprint(documents), coverage, point,
    inventory.calls.map(call => call.key), sampling.make, pick, cardsOnly, chapters]);
  return { course, language, coverage, point, ...(cardsOnly ? { cardsOnly } : {}), ...(chapters ? { chapters, only } : {}), title: notesTitle(language, course), mode,
    outline, previous, outlinePlan, state, documents, planKey, inventory,
    // The language of the 术语卡's exam pitch, decided once for the build: the papers' (#710).
    pitchLanguage: pitchLanguage({ documents, sources: state.sources, papers: asked, language }),
    sample: sampling.make ? { pick, inventoryLeft } : null, anchor: sampling.anchor ?? null, confirm: !!sampling.confirm,
    efforts: effortsOf(state.settings), concurrency: request.concurrency, papersBy: chosen.by, scopeHash: digest(['course-book', course, outline?.id ?? null, asked]),
    steps: inventory.steps + (outlinePlan?.steps ?? 0) };
}
