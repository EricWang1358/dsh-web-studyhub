/* Sample library (plan §3 D4, contract C6): one fictional course — design
   patterns, Memento and Bridge — in the learner's interface language, so a new
   learner can see every feature working before importing anything.

   `sample.load` goes through the real operations wherever one exists: the
   lecture is a retained Markdown original (materials.document.import), every
   quote is resolved to a checked passage (materials.selection.resolve), the
   deck is saved and published as a draft (draft.save, draft.publish), the
   knowledge skeleton and notes are created by their own actions. Only what has
   no operation is written directly with the same data contracts: three weeks
   of backdated answers (and the review schedule they produce), prerequisite
   links, a prepared lesson in a learning-flow session, and a few letters.
   The course itself is a course record (course.save) with a small exam
   profile, guidance from the lecture and focus topics.
   Loading never calls a model: the hand-written cards carry review marks.

   Every record is tagged `sample: true`; ids we choose start with `sample-`.
   `sample.remove` deletes exactly those records, the sample's retained
   original, and any answers or runs on the sample deck, and only drops links
   from the learner's own records to sample cards. Nothing else changes. */
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { initialReview, schedule } from "./domain.js";
import { startQuickSession } from "./workflows.js";
import { followupDigest } from "./followup.js";
import { reviewedCardFingerprint } from "./review-integrity.js";
import { CASE_FORMAT, renderRubric, normalizeGrading, casePaperSettings } from "./case-study.js";
import { commitRubricGrade } from "./rubric-grading.js";
import en from "./sample/en.js";
import zh from "./sample/zh.js";

export const SAMPLE_VERSION = 1;
export const SAMPLE_PREFIX = "sample-";
export const SAMPLE_IDS = Object.freeze({ deck: "sample-deck-patterns", draft: "sample-draft-patterns",
  session: "sample-session-patterns", request: "sample-guided-lesson",
  caseDeck: "sample-deck-case", caseSource: "sample-case-scenario", caseRun: "sample-run-case" });
const CONTENT = { en, zh };
const DAY_MS = 86400000;
/* Answers per day, from 21 days ago to yesterday: a realistic rhythm with rest days, so the heatmap and streak look lived in. */
const HISTORY_PER_DAY = [2, 3, 1, 0, 2, 4, 2, 0, 3, 2, 1, 3, 0, 2, 0, 3, 2, 4, 2, 3, 2];

/** 'en' for English requests ('en', 'en-US', 'English'), otherwise the Chinese edition. */
export const sampleLanguage = (value) => /^en/i.test(String(value || "").trim()) ? "en" : "zh";
export const sampleContent = (language) => CONTENT[sampleLanguage(language)];
export const sampleCardId = (key) => `${SAMPLE_PREFIX}${key}`;
const tagged = (record) => record?.sample === true;

/* The lecture's document id is content-addressed (materials/operations.js), so
   it is known even if a load stopped before tagging it. */
const lectureDocumentIds = new Set(Object.values(CONTENT).map((content) =>
  `document-${createHash("sha256").update(Buffer.from(content.document.markdown, "utf8")).digest("hex")}-md`));

/** What the UI needs to show, open and remove the sample course. */
export function sampleStatusOf(state) {
  const marker = state?.sampleLibrary;
  const loaded = marker?.status === "ready";
  const has = (list, id) => (list || []).some((item) => item.id === id && tagged(item));
  const source = (state?.sources || []).find(tagged);
  const session = (state?.workflowSessions || []).find(tagged);
  const deck = loaded ? (state.decks || []).find((item) => item.id === SAMPLE_IDS.deck && tagged(item)) : null;
  // The tour's practice round, limited to the sample questions that still exist.
  const practice = deck ? sampleContent(marker.language).practice.map(sampleCardId)
    .filter((cardId) => deck.cards.some((card) => card.id === cardId)).map((cardId) => ({ deckId: deck.id, cardId })) : [];
  return {
    loaded,
    loading: marker?.status === "loading",
    language: loaded ? marker.language : null,
    course: loaded ? marker.course : null,
    version: marker?.version ?? null,
    loadedAt: loaded ? marker.loadedAt || null : null,
    deckId: deck ? deck.id : null,
    practice,
    draftId: loaded && has(state.drafts, SAMPLE_IDS.draft) ? SAMPLE_IDS.draft : null,
    caseDeckId: loaded && has(state.decks, SAMPLE_IDS.caseDeck) ? SAMPLE_IDS.caseDeck : null,
    sourceId: loaded ? source?.id || null : null,
    sessionId: loaded ? session?.id || null : null,
    skeletonId: loaded ? (state.skeletons || []).find(tagged)?.id || null : null,
  };
}

function hasSampleRecords(state) {
  if (state.sampleLibrary) return true;
  return Object.values(state).some((value) => Array.isArray(value) && value.some(tagged)) ||
    (state.documents || []).some((document) => lectureDocumentIds.has(document.id));
}

/* One load or removal at a time per library; a double click waits its turn. */
const queues = new Map();
function serial(root, work) {
  const previous = queues.get(root) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  const settled = next.catch(() => {});
  queues.set(root, settled);
  settled.then(() => { if (queues.get(root) === settled) queues.delete(root); });
  return next;
}

/** host: { call(action, args), store, has(action) } — the library's own service. */
export function sampleAction(host, action, args = {}) {
  if (action === "sample.status") return host.store.read().then(sampleStatusOf);
  if (action === "sample.load") return serial(host.store.root, () => loadSample(host, args));
  if (action === "sample.remove") return serial(host.store.root, () => removeSample(host));
  return Promise.reject(new Error(`Unknown study action: ${action}`));
}

async function loadSample(host, { language, now = Date.now() } = {}) {
  const current = await host.store.read();
  if (current.sampleLibrary?.status === "ready") return sampleStatusOf(current);
  // An interrupted load leaves tagged records behind: start from a clean slate.
  if (hasSampleRecords(current)) await removeRecords(host.store);
  const content = sampleContent(language);
  const at = (days, minutes = 0) => new Date(now - days * DAY_MS + minutes * 60000).toISOString();
  await host.store.update((s) => {
    s.sampleLibrary = { version: SAMPLE_VERSION, status: "loading", language: content.language, course: content.course, startedAt: at(0) };
  });
  try {
    await buildSample(host, content, at);
  } catch (error) {
    await removeRecords(host.store).catch(() => {});
    throw error;
  }
  return sampleStatusOf(await host.store.read());
}

async function buildSample(host, content, at) {
  const { course } = content;
  // 1. The lecture: a retained Markdown original, so the viewer, passage selection and links work.
  const imported = await host.call("materials.document.import", {
    dataBase64: Buffer.from(content.document.markdown, "utf8").toString("base64"),
    filename: content.document.filename, format: "md", title: content.document.title, courses: [course],
  });
  const sourceIds = new Set(imported.sourceIds);
  await host.store.update((s) => {
    for (const source of s.sources) if (sourceIds.has(source.id)) source.sample = true;
    for (const document of s.documents || []) if (document.id === imported.documentId) document.sample = true;
  });

  // 2. Every card cites a checked passage of that lecture.
  const passages = new Map();
  const passage = async (quote) => {
    if (!passages.has(quote)) {
      const resolved = await host.call("materials.selection.resolve", { documentId: imported.documentId, quote });
      if (resolved.status !== "resolved") throw new Error(`Sample passage is ${resolved.status}: ${quote}`);
      passages.set(quote, resolved.selection);
    }
    return passages.get(quote);
  };
  const cited = async ({ key, quote, ...card }) => {
    const selection = await passage(quote);
    return { ...structuredClone(card), id: sampleCardId(key),
      citations: [{ sourceId: selection.sourceId, quote: selection.quote, selection }] };
  };
  const reviewed = (cards) => ({ reviewedCards: Object.fromEntries(cards.map((card) => [card.id, reviewedCardFingerprint(card)])) });

  // 3. The deck: saved as a draft and published like any other. The review
  //    marks say these hand-written cards were checked, so no model is asked.
  const deckCards = await Promise.all(content.deck.cards.map(cited));
  const saved = await host.call("draft.save", { deck: { id: SAMPLE_IDS.deck, title: content.deck.title, course,
    sample: true, cards: deckCards, editorial: reviewed(deckCards) } });
  const published = await host.call("draft.publish", { id: SAMPLE_IDS.deck, draftVersion: saved.draftVersion });
  if (published.deckId !== SAMPLE_IDS.deck || published.rejected)
    throw new Error("The sample deck did not pass publication checks");

  // 3b. A case set (WP12): its scenario is a material, its open questions carry marks and rubric criteria.
  const study = content.caseStudy;
  if (study && host.has("source.add")) {
    await host.call("source.add", { id: SAMPLE_IDS.caseSource, title: study.scenario.title, text: study.scenario.paragraphs.join("\n\n"), courses: [course] });
    await host.store.update((s) => { for (const source of s.sources) if (source.id === SAMPLE_IDS.caseSource) source.sample = true; });
    const caseCards = study.questions.map(({ key, quote, criteria, ...question }, index) => ({ ...structuredClone(question), id: sampleCardId(key), kind: "open",
      rubricCriteria: structuredClone(criteria), rubric: renderRubric(criteria, content.language), caseQuestion: index + 1,
      citations: [{ sourceId: SAMPLE_IDS.caseSource, quote }] }));
    const savedCase = await host.call("draft.save", { deck: { id: SAMPLE_IDS.caseDeck, title: study.title, course, sample: true, format: CASE_FORMAT,
      case: { sourceId: SAMPLE_IDS.caseSource, title: study.title, totalMarks: caseCards.reduce((sum, card) => sum + card.marks, 0), origin: "generated",
        cues: structuredClone(study.cues), language: content.language }, cards: caseCards, editorial: reviewed(caseCards) } });
    const publishedCase = await host.call("draft.publish", { id: SAMPLE_IDS.caseDeck, draftVersion: savedCase.draftVersion });
    if (publishedCase.deckId !== SAMPLE_IDS.caseDeck || publishedCase.rejected) throw new Error("The sample case set did not pass publication checks");
  }

  // 4. A pending draft waiting for review and publication.
  const draftCards = await Promise.all(content.draft.cards.map(cited));
  await host.call("draft.save", { deck: { id: SAMPLE_IDS.draft, title: content.draft.title, course, sample: true,
    cards: draftCards, editorial: reviewed(draftCards) } });

  // 5. A knowledge skeleton over the deck, through its own action.
  let skeletonId = null;
  if (host.has("skeleton.save")) {
    const { skeleton } = content;
    const created = await host.call("skeleton.save", { skeleton: { ...structuredClone(skeleton), scope: [{ deckId: SAMPLE_IDS.deck }],
      nodes: skeleton.nodes.map((node) => ({ ...node, cards: node.cards.map(sampleCardId) })) } });
    skeletonId = created.id;
  }

  // 6. Two notes: created and written through the notes actions.
  const noteIds = new Map();
  if (host.has("note.create") && host.has("note.save")) {
    for (const note of content.notes) {
      const cards = content.deck.cards.filter((card) => card.topic === note.topic)
        .map((card) => ({ deckId: SAMPLE_IDS.deck, cardId: sampleCardId(card.key) }));
      const created = await host.call("note.create", { title: note.title, cards });
      await host.call("note.save", { id: created.id, expectedRevision: created.revision, markdown: note.markdown });
      noteIds.set(note.key, created.id);
    }
  }

  // 6b. The course record: exam profile, the lecture as examiner guidance, focus topics.
  if (host.has("course.save") && content.exam) {
    const { daysAhead, ...exam } = content.exam;
    const date = new Date(Date.parse(at(-daysAhead))).toISOString().slice(0, 10);
    await host.call("course.save", { name: course, exam: { ...structuredClone(exam), date },
      guidanceSourceIds: [...sourceIds].slice(0, 1), focusTopics: content.focusTopics || [] });
  }

  // 7. What has no operation of its own, written with the same data contracts.
  const flow = host.has("workflow.list");
  await host.store.update((s) => {
    const deck = s.decks.find((item) => item.id === SAMPLE_IDS.deck);
    if (!deck) throw new Error("The sample deck is missing");
    const cards = new Map(deck.cards.map((card) => [card.id, card]));
    const ref = (key) => ({ deckId: deck.id, cardId: sampleCardId(key) });

    // About three weeks of answers: busy days, light days and a few rest days;
    // shaky at first, steadier later, and two slips today.
    const fresh = new Set(content.fresh.map(sampleCardId));
    const history = deck.cards.filter((card) => !fresh.has(card.id));
    const reviews = new Map();
    const answer = (card, grade, timestamp, id, runId, elapsed) => {
      const before = reviews.get(card.id) || initialReview(s.settings);
      const after = schedule(before, grade, timestamp, s.settings);
      s.attempts.push({ id, runId, quiz_id: card.id, deckId: deck.id, topic: card.topic, timestamp, grade,
        assessment: ["quiz", "multi", "cloze"].includes(card.kind) ? "graded" : "self", elapsed_ms: elapsed,
        retry: false, before: structuredClone(before), after, sample: true });
      reviews.set(card.id, after);
    };
    const relearned = new Set(content.due.map(sampleCardId));
    for (let day = 21; day >= 1; day--) {
      const pool = day <= 3 ? history.filter((card) => !relearned.has(card.id)) : history;
      for (let j = 0; j < HISTORY_PER_DAY[21 - day]; j++) {
        const card = pool[(day * 3 + j) % pool.length];
        const grade = (day > 14 ? [1, 3, 2, 4] : day > 6 ? [3, 4, 3, 5] : [4, 5, 4, 5])[j % 4];
        answer(card, grade, at(day, j * 6 + (day % 3) * 37), `sample-attempt-${day}-${j}`, `sample-round-${day}`, 26000 + ((day * 7 + j * 5) % 11) * 2400);
      }
      // Forgotten three days ago and relearned the next day: due again today.
      if (day === 3 || day === 2) for (const key of content.due)
        answer(cards.get(sampleCardId(key)), day === 3 ? 1 : 3, at(day, 50), `sample-${day === 3 ? "lapse" : "relearn"}-${key}`, `sample-round-${day}`, 36000);
    }
    for (const key of content.weak)
      answer(cards.get(sampleCardId(key)), 1, at(0, -45), `sample-mistake-${key}`, "sample-round-today", 42000);
    for (const card of deck.cards) card.review = reviews.get(card.id) || initialReview(s.settings);

    for (const [dependent, prerequisite] of content.prerequisites) {
      const card = cards.get(sampleCardId(dependent));
      card.requires = [...(card.requires || []), ref(prerequisite)];
    }

    const asked = cards.get(sampleCardId(content.followup.card));
    asked.followups = [...(asked.followups || []), { id: "sample-followup", at: at(0, -20), digest: followupDigest(asked),
      originalQuestion: content.followup.question, question: content.followup.question, answer: content.followup.answer, source: "assistant" }];

    for (const document of s.documents || []) if (document.id === imported.documentId) document.sample = true;
    for (const skeleton of s.skeletons || []) if (skeleton.id === skeletonId) skeleton.sample = true;
    for (const item of s.courses || []) if (item.name === course) item.sample = true;
    for (const note of s.notes || []) if ([...noteIds.values()].includes(note.id)) {
      note.sample = true;
      note.createdAt = at(3);
      note.updatedAt = at(1);
    }

    for (const letter of content.inbox) {
      const noteId = letter.note ? noteIds.get(letter.note) : undefined;
      if (letter.note && !noteId) continue;
      s.inbox.push({ id: `sample-mail-${letter.key}`, kind: letter.kind, ...ref(letter.card), ...(noteId ? { noteId } : {}),
        detail: letter.detail, at: at(0, -letter.minutesAgo), read: !!letter.read, sample: true });
    }

    if (flow) {
      const session = startQuickSession(s, { requestId: SAMPLE_IDS.request, goal: content.lesson.goal, title: content.lesson.title,
        scope: [{ deckId: deck.id }], skeletonId, language: content.language });
      session.id = SAMPLE_IDS.session;
      session.sample = true;
      const lesson = session.template.steps.find((step) => step.kind === "lesson");
      if (lesson) {
        session.currentStepId = lesson.id;
        session.records[lesson.id] = {
          content: `> ${content.lesson.note}\n\n` + content.lesson.sections.map(([title, text]) => `## ${title}\n\n${text}`).join("\n\n"),
          citations: structuredClone(cards.get(sampleCardId(content.deck.cards[0].key)).citations), updatedAt: at(0, -30) };
      }
    }

    // A case paper sat two days ago and graded with the case's rubric (hand-written grading, no model):
    // its marks, quotes, gaps and flags show what rubric grading returns.
    const caseDeck = study && s.decks.find((item) => item.id === SAMPLE_IDS.caseDeck);
    if (caseDeck) {
      const scenario = (s.sources.find((source) => source.id === caseDeck.case.sourceId) || {}).text || "";
      const answers = Object.fromEntries(study.attempt.answers.map(([key, text]) => [sampleCardId(key), text]));
      const grading = normalizeGrading({ summary: study.attempt.summary, questions: study.attempt.grading.map(({ key, ...item }) => ({ ...structuredClone(item), cardId: sampleCardId(key) })) },
        { questions: caseDeck.cards.map((card) => ({ cardId: card.id, marks: card.marks, criteria: card.rubricCriteria })), answers, scenario });
      const paper = casePaperSettings({ minutesPerMark: 3, readingMinutes: 5 }, caseDeck.cards, caseDeck.id);
      const startedAt = at(2, 30), submittedAt = at(2, 62), perQuestion = { [caseDeck.cards[0].id]: 17 * 60000, [caseDeck.cards[1]?.id]: 9 * 60000 };
      s.runs.push({ id: SAMPLE_IDS.caseRun, sample: true, deckId: caseDeck.id, mode: "exam", examKinds: "case", paper, scope: [{ deckId: caseDeck.id }],
        index: 0, startedAt, closedAt: submittedAt, submittedAt, timings: { readingMs: 5 * 60000, writingMs: 26 * 60000, transcribeMs: 0, perQuestion },
        highlights: [{ id: "sample-hl-1", paragraph: 3, start: 0, end: 24, color: "yellow" }],
        entries: caseDeck.cards.map((card) => ({ deckId: caseDeck.id, card: structuredClone(card), startedAt: Date.parse(startedAt), feedback: null,
          revealed: false, selected: null, response: answers[card.id] || null })) });
      for (const card of caseDeck.cards) if (answers[card.id]) {
        commitRubricGrade(s, { ref: { deckId: caseDeck.id, cardId: card.id }, runId: SAMPLE_IDS.caseRun, answer: answers[card.id], grading, timestamp: submittedAt });
        const attempt = s.attempts.at(-1);
        Object.assign(attempt, { sample: true, elapsed_ms: perQuestion[card.id] || 0 });
      }
      // The paper's letters were read long ago; the sample's fresh letters stay on top.
      for (const letter of s.inbox) if (letter.kind === "grade" && letter.deckId === caseDeck.id) Object.assign(letter, { read: true, at: submittedAt, sample: true });
    }

    s.sampleLibrary = { version: SAMPLE_VERSION, status: "ready", language: content.language, course: content.course, loadedAt: at(0) };
  });
}

async function removeSample(host) {
  const removed = await removeRecords(host.store);
  return { removed, status: sampleStatusOf(await host.store.read()) };
}

/** Remove every sample record and what only exists because of them; returns counts per collection. */
async function removeRecords(store) {
  const files = [];
  const counts = await store.update((s) => {
    const counts = {};
    const keep = (field, predicate) => {
      if (!Array.isArray(s[field])) return;
      const before = s[field].length;
      s[field] = s[field].filter(predicate);
      if (before !== s[field].length) counts[field] = before - s[field].length;
    };
    const decks = new Set((s.decks || []).filter(tagged).map((deck) => deck.id));
    const documents = (s.documents || []).filter((document) => tagged(document) || lectureDocumentIds.has(document.id));
    const documentIds = new Set(documents.map((document) => document.id));
    const sources = new Set([...(s.sources || []).filter(tagged).map((source) => source.id),
      ...documents.flatMap((document) => (document.versions || []).flatMap((version) => version.sourceIds || []))]);
    const notes = new Set((s.notes || []).filter(tagged).map((note) => note.id));
    const toSample = (ref) => !!ref && decks.has(ref.deckId);
    const mentionsSample = (record) => [...decks].some((id) => JSON.stringify(record ?? null).includes(JSON.stringify(id)));
    const sampleRun = (run) => tagged(run) || (Array.isArray(run.entries) && run.entries.length > 0
      ? run.entries.every((entry) => decks.has(entry.deckId ?? run.deckId))
      : decks.has(run.deckId) || ((run.scope || []).length > 0 && run.scope.every(toSample)));

    keep("sources", (source) => !sources.has(source.id));
    keep("documents", (document) => !documentIds.has(document.id));
    keep("decks", (deck) => !decks.has(deck.id));
    keep("drafts", (draft) => !tagged(draft));
    keep("attempts", (attempt) => !tagged(attempt) && !decks.has(attempt.deckId));
    for (const field of ["runs", "oralRuns"]) {
      keep(field, (run) => !sampleRun(run));
      // A round over several decks keeps going without the sample questions.
      for (const run of s[field] || []) {
        if (!Array.isArray(run.entries) || !run.entries.some((entry) => decks.has(entry.deckId ?? run.deckId))) continue;
        const index = run.entries.slice(0, run.index || 0).filter((entry) => !decks.has(entry.deckId ?? run.deckId)).length;
        run.entries = run.entries.filter((entry) => !decks.has(entry.deckId ?? run.deckId));
        run.index = Math.min(index, Math.max(0, run.entries.length - 1));
        if (Array.isArray(run.scope)) run.scope = run.scope.filter((ref) => !toSample(ref));
      }
    }
    for (const field of ["teaching", "coach", "feedback", "prepared"]) keep(field, (item) => !tagged(item) && !mentionsSample(item));
    keep("inbox", (item) => !tagged(item) && !decks.has(item.deckId) && !(item.noteId && notes.has(item.noteId)));
    keep("skeletons", (skeleton) => !tagged(skeleton));
    keep("notes", (note) => !tagged(note));
    keep("workflowSessions", (session) => !tagged(session));
    keep("courses", (course) => !tagged(course));

    // The learner's own records keep everything except their links to sample questions.
    for (const deck of [...(s.decks || []), ...(s.drafts || [])])
      for (const card of deck.cards || [])
        if (Array.isArray(card.requires) && card.requires.some(toSample)) card.requires = card.requires.filter((ref) => !toSample(ref));
    for (const note of s.notes || [])
      if (note.cards?.some(toSample)) note.cards = note.cards.filter((ref) => !toSample(ref));
    for (const skeleton of s.skeletons || []) {
      if (!mentionsSample(skeleton)) continue;
      skeleton.scope = (skeleton.scope || []).filter((ref) => !toSample(ref));
      for (const node of skeleton.nodes || []) node.cards = (node.cards || []).filter((ref) => !toSample(ref));
    }
    for (const session of s.workflowSessions || [])
      if (session.scope?.some(toSample)) session.scope = session.scope.filter((ref) => !toSample(ref));
    if (s.ingest && decks.has(s.ingest.deckId)) delete s.ingest;

    const remaining = new Set((s.documents || []).flatMap((document) => (document.versions || []).map((version) => version.attachment?.path)));
    for (const document of documents) for (const version of document.versions || [])
      if (version.attachment?.path && !remaining.has(version.attachment.path)) files.push(version.attachment.path);
    delete s.sampleLibrary;
    return counts;
  });
  // Originals are content-addressed files under attachments/materials; delete only the sample's.
  await Promise.all([...new Set(files)].filter((path) => /^attachments\/materials\/[a-f0-9]{64}\.md$/.test(path))
    .map((path) => rm(join(store.root, path), { force: true })));
  return counts;
}
