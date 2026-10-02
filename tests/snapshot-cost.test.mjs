/* The panel polls `snapshot` every 2.5 s, and the next poll after every answer or
   下一题 click rebuilds it. On the owner's library (600 sources, 15 courses, 3 000
   cards) the course list alone spent ~2.5 s of synchronous CPU, which stalled
   whatever request arrived meanwhile: "有时候点击下一题会卡两秒左右". These tests
   pin the cost by counting work, never by timing it. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { courseIdsOf, courseIndex, courseList } from "../lib/courses.js";
import { StudyService } from "../lib/service.js";

/** A state whose card citations count how often they are read. */
function library({ courses, sources, cardsPerDeck = 20 }) {
  const reads = { citations: 0 };
  const names = Array.from({ length: courses }, (_, i) => `Course ${i}`);
  const state = {
    courses: [],
    sources: Array.from({ length: sources }, (_, i) => ({ id: `s${i}`, title: `Source ${i}`, text: "t" })),
    // Legacy sources: no `courses` array, so the course is inferred from the decks that cite them.
    decks: names.map((name, d) => ({
      id: `d${d}`, title: `Deck ${d}`, course: name,
      cards: Array.from({ length: cardsPerDeck }, (_, c) => {
        const card = { id: `d${d}c${c}`, kind: "flashcard", topic: "t", prompt: "p", answer: "a" };
        const source = `s${(d * cardsPerDeck + c) % sources}`;
        Object.defineProperty(card, "citations", { enumerable: true, get() { reads.citations++; return [{ sourceId: source }]; } });
        return card;
      }),
    })),
    drafts: [],
  };
  return { state, reads, cards: courses * cardsPerDeck };
}

test("the course list reads each card's citations a bounded number of times, not once per source and course", () => {
  const { state, reads, cards } = library({ courses: 12, sources: 150 });
  const list = courseList(state, []);
  assert.equal(list.length, 12);
  // Before: courses x sources x cards (12 x 150 x 240 = 432 000 reads). One pass over the cards is enough.
  assert.ok(reads.citations <= cards * 3, `read citations ${reads.citations} times for ${cards} cards`);
});

test("the course list still counts inferred sources by the decks that cite them", () => {
  const { state } = library({ courses: 3, sources: 6, cardsPerDeck: 2 });
  // Cards cite s0..s5 round-robin: deck d0 -> s0,s1; d1 -> s2,s3; d2 -> s4,s5.
  const byName = Object.fromEntries(courseList(state, []).map((course) => [course.name, course.sources]));
  assert.deepEqual(byName, { "Course 0": 2, "Course 1": 2, "Course 2": 2 });
});

test("an inferred source's course ids follow its own name, its audio course and its citing decks", () => {
  const { state } = library({ courses: 2, sources: 2, cardsPerDeck: 1 });
  state.sources.push({ id: "extra", title: "x", text: "t", course: "Course 1", audio: { course: "Course 0" } });
  const index = courseIndex(state);
  const idOf = (name) => index.resolve(name).id;
  assert.deepEqual(courseIdsOf(state.sources[0], index), [idOf("Course 0")]);
  assert.deepEqual(courseIdsOf(state.sources[2], index).sort(), [idOf("Course 0"), idOf("Course 1")].sort());
  // A source that is not (yet) in the library is still resolved from its own record.
  assert.deepEqual(courseIdsOf({ id: "s1", text: "t" }, index), [idOf("Course 1")]);
  assert.deepEqual(courseIdsOf({ id: "ghost", text: "t", course: "Course 1" }, index), [idOf("Course 1")]);
});

/** Run `work` while counting the structuredClone calls whose argument mentions `marker`. */
async function clonesOf(marker, work) {
  const real = globalThis.structuredClone;
  let count = 0;
  globalThis.structuredClone = (value, options) => {
    try { if (JSON.stringify(value)?.includes(marker)) count++; } catch { /* not serialisable: not a library read */ }
    return real(value, options);
  };
  try { await work(); } finally { globalThis.structuredClone = real; }
  return count;
}

test("review.get reads the committed library without copying it (it used to copy the collection, and the read again on its way out)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "study-clone-count-"));
  const service = new StudyService(root);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  const card = (id) => ({ id, kind: "flashcard", topic: "t", prompt: `prompt ${id}`, answer: "a", citations: [] });
  await service.store.update((s) => {
    s.decks.push({ id: "live", title: "Live deck", cards: [card("c1"), card("c2")] });
    // Nothing the review itself returns mentions this deck, so any clone containing it is a library read.
    s.decks.push({ id: "bulk", title: "BULK-MARKER-DECK", cards: [card("b1")] });
  });
  const run = await service.call("review.start", { deckId: "live", mode: "flashcard" });
  const clones = await clonesOf("BULK-MARKER-DECK", () => service.call("review.get", { runId: run.id }));
  // Before: the collection was copied for the reader and the whole read was copied again on its way out (2); then one private
  // copy (1). review.get only looks, so it reads the store's frozen committed values (storagePort.view) and copies nothing.
  assert.equal(clones, 0, `the library was cloned ${clones} times for one review.get`);
});
