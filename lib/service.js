import { Store } from "./store.js";
import { prepareJsonImport } from "./json-import.js";
import { isSlayDeck, slayCard, restoreSlainCard } from "./slay.js";
import { id, required, get } from "./util.js";
import { teachingView, getTeaching, startTeaching, answerTeaching } from "./teaching.js";
import {
  checkSettings,
  initialReview,
  schedule,
  shuffled,
  validateDeck,
  publicCard,
  gradeCloze,
} from "./domain.js";
import { generateBatched, planGeneration, MAX_SELECTED_CHARS } from "./batch.js";
import { extractPdf } from "./documents.js";
import { GENERATION_TIMEOUT_MS, GENERATION_JOB_TIMEOUT_MS } from "./generation-limits.js";
import { importLegacy } from "./legacy.js";
import { captureQuestion, parseSparInput, samePrompt } from "./capture.js";
import { findCard, linkPrerequisite, prerequisiteView, checkScope } from "./prereq.js";
import { studyMap, studyStats, wrongBook, graphData } from "./insights.js";
import { parseIngest, INGEST_KINDS, MAX_INGEST_CHARS } from "./ingest.js";
import { cardLevel, latestOutcomes, planPath, scopeKey } from "./mastery.js";
import {
  FEEDBACK_TAGS, GOALS, LEVEL_NAMES, MAX_READY, REWRITE_TAGS,
  cognitiveLevel, debriefRules, ensureLearner, evidenceWindows, runMetrics, threadView, trimLogs,
  writeDebrief, writeFollowup, writeNudge, writeRewrite, writeVariants,
} from "./coach.js";

// 陪学 background state, per library root (services are created per request).
const coachInflight = new Map();
const coachTasks = new Map();
const coachQueues = new Map();
const prepPending = new Map();
const PREP_DELAY_MS = 20000;
const jobs = new Map();
// Generations for one library run one after another; later requests queue.
const queues = new Map();
const settled = new Map();
// Live delivery handles are deliberately excluded from public job snapshots.
const generationMessengers = new Map();
const generationControllers = new Map();
// Captures on one library run in turn, so each classifies against the previous one's result.
const captureQueues = new Map();
const activeJob = (j) => ["running", "queued", "cancelling"].includes(j.status);
const publicJob = ({ root, ...j }) => j;
function pruneJobs() {
  const terminal = [...jobs.values()]
    .filter((j) => !activeJob(j))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  for (const job of terminal.slice(100)) jobs.delete(job.id);
}
function projection(s, run) {
  const entry = run.closedAt ? null : run.entries[run.index];
  const outcome = latestOutcomes(s.attempts);
  const decks = new Map(s.decks.map((d) => [d.id, new Map(d.cards.map((c) => [c.id, c]))]));
  return {
    id: run.id,
    startedAt: run.startedAt,
    mode: run.mode,
    scope: run.scope ?? [{ deckId: run.deckId }],
    deckId: entry?.deckId ?? run.deckId,
    title: runTitle(s, run),
    sourceIds: [
      ...new Set(
        run.entries.flatMap((e) => e.card.citations.map((c) => c.sourceId)),
      ),
    ],
    index: run.index,
    queueVersion: run.queueVersion || 0,
    total: run.entries.length,
    ...(run.mode !== "exam" ? { navigation: run.entries.map((e, index) => {
      const deckId = e.deckId ?? run.deckId;
      const card = decks.get(deckId)?.get(e.card.id) || e.card;
      return { index, cardId: card.id, deckId, topic: card.topic,
        level: cardLevel(card, outcome(deckId, card.id)), answered: !!e.feedback };
    }) } : {}),
    complete: !entry,
    closed: !!run.closedAt,
    weakTopics: [
      ...new Set(
        run.entries
          .filter((e) => e.feedback?.grade < 3)
          .map((e) => e.card.topic),
      ),
    ],
    // Tail retries are extra practice on a question already counted once.
    questions: run.entries.filter((x) => !x.retry).length,
    answered: run.entries.filter((x) => !x.retry && x.feedback).length,
    correct: run.entries.filter((x) => !x.retry && x.feedback?.grade >= 3).length,
    retries: run.entries.filter((x) => x.retry && x.feedback).length,
    card: entry ? publicCard(entry.card, entry.order) : null,
    prerequisites: entry ? currentPrerequisites(s, run, entry) : [],
    revision: entry ? liveCard(s, run, entry)?.revisions?.length || 0 : 0,
    returnTo: run.returnTo || null,
    feedback: entry?.feedback ?? null,
    revealed: entry?.revealed ?? false,
    retry: !!entry?.retry,
    contentUpdated: !!entry?.contentUpdated,
    ...(entry && run.mode !== "exam"
      ? {
          coach: threadView(s, entry.card.id),
          vote: (({ vote, tags } = {}) => (vote ? { vote, tags } : null))(
            (s.feedback || []).findLast((f) => f.cardId === entry.card.id),
          ),
          level: cognitiveLevel(entry.card, s.learner?.levels?.[entry.card.id]),
          origin: originView(s, entry.card.origin),
        }
      : {}),
    teaching: entry
      ? teachingView(
          s.teaching.findLast(
            (t) => t.runId === run.id && t.origin_quiz_id === entry.card.id,
          ),
        )
      : null,
    // An open exam exposes the learner's own recorded selections so a panel
    // can restore them; correctness stays hidden until submit.
    ...(run.mode === "exam" && !run.closedAt
      ? {
          picks: run.entries.map((e) => ({
            deckId: e.deckId ?? run.deckId,
            cardId: e.card.id,
            selected: e.selected || null,
          })),
        }
      : {}),
    ...(entry?.revealed ? { solution: solution(entry.card) } : {}),
  };
}
/** Where a 为你定制 card came from, for the question header. */
function originView(s, origin) {
  if (!origin?.cardId) return null;
  try {
    const { card } = findCard(s, origin);
    return { reason: origin.reason, deckId: origin.deckId, cardId: card.id, prompt: String(card.prompt).slice(0, 60) };
  } catch {
    return { reason: origin.reason, prompt: "" };
  }
}
function liveCard(s, run, entry) {
  const deckId = entry.deckId ?? run.deckId;
  return s.decks.find((d) => d.id === deckId)?.cards.find((c) => c.id === entry.card.id);
}
const EDITABLE = ["topic", "objective", "prompt", "answer", "hint", "explanation", "misconception", "rubric", "options", "citations"];
const substance = (c) =>
  JSON.stringify([
    c.kind,
    c.prompt,
    c.answer,
    (c.options || []).map((o) => [o.id, o.text, o.correct]),
    c.cloze ? [c.cloze.text, c.cloze.answers] : null,
  ]);
/**
 * Replace one published card's content in place. Wording and explanation
 * fixes keep its schedule; a changed question, answer or correct option
 * restarts it. The previous content is kept for one-step revert, open
 * editing drafts and open runs see the new version. Substantive edits archive
 * the previous answer snapshot and require a fresh answer in the open view.
 */
function applyCardContent(s, ref, content, revision, { keepAnswered = false } = {}) {
  const { deck, card } = findCard(s, ref),
    index = deck.cards.indexOf(card);
  const next = { ...card, ...content, id: card.id, kind: card.kind };
  const cards = deck.cards.map((c, i) => (i === index ? next : c));
  const errors = validateDeck({ title: deck.title, cards }, s.sources).errors.filter((e) =>
    e.startsWith(`Card ${index + 1}:`),
  );
  if (errors.length) throw new Error(errors.join("\n"));
  const reset = substance(card) !== substance(next);
  const inExam = s.runs.some((run) =>
    run.mode === "exam" && !run.closedAt && run.entries.some((entry) =>
      (entry.deckId ?? run.deckId) === deck.id && entry.card.id === card.id,
    ),
  );
  if (reset && inExam)
    throw new Error("Finish or end the active exam before changing this question or its answer");
  const { review, flag, suspended, requires, revisions, ...previous } = card;
  next.review = reset ? initialReview(s.settings) : card.review;
  next.revisions = revision
    ? [...(card.revisions || []), { at: new Date().toISOString(), reason: revision, content: previous }].slice(-5)
    : (card.revisions || []).slice(0, -1);
  deck.cards[index] = next;
  const editing = s.drafts.find((d) => d.editingDeckId === deck.id);
  if (editing) {
    editing.cards = editing.cards.map((c) => (c.id === card.id ? structuredClone(next) : c));
    editing.draftVersion = (editing.draftVersion || 0) + 1;
  }
  let refreshed = 0;
  for (const run of s.runs.filter((r) => !r.closedAt)) {
    let resetEntry = false;
    for (const entry of run.entries)
      if ((entry.deckId ?? run.deckId) === deck.id && entry.card.id === card.id) {
        // A coach fix after answering must not wipe the feedback on screen.
        // With the same answer key the improved wording replaces the card in
        // place and the result stands; a changed key keeps the answered
        // snapshot and applies from the next attempt.
        if (keepAnswered && entry.feedback) {
          if (answerKey(entry.card) === answerKey(next)) {
            entry.card = structuredClone(next);
            delete entry.keepSnapshot;
            refreshed++;
          } else entry.keepSnapshot = true;
          continue;
        }
        resetEntry = syncReviewEntry(entry, next) || resetEntry;
        refreshed++;
      }
    if (resetEntry) run.queueVersion = (run.queueVersion || 0) + 1;
  }
  return { deckId: deck.id, cardId: card.id, scheduleReset: reset, revisions: next.revisions.length, refreshedInOpenRuns: refreshed };
}
const answerKey = (c) =>
  JSON.stringify([
    c.kind,
    (c.options || []).map((o) => [o.id, o.correct === true]).sort(),
    c.cloze ? c.cloze.answers?.map((a) => [a.id, a.value]) : null,
  ]);
function patchContent(card, raw) {
  const patch = raw && typeof raw === "object" ? raw : {};
  const content = {};
  for (const key of EDITABLE) if (patch[key] !== undefined) content[key] = patch[key];
  if (!Object.keys(content).length) throw new Error("Nothing to update");
  // Options may be patched by id, e.g. only their explanations.
  if (Array.isArray(content.options) && card.options) {
    const byId = (o) => card.options.find((x) => x.id === o?.id);
    content.options = content.options.every(byId)
      ? card.options.map((o) => ({ ...o, ...content.options.find((x) => x.id === o.id) }))
      : content.options.map((o) => ({ ...(byId(o) || {}), ...o }));
  }
  return content;
}
function syncReviewEntry(entry, next) {
  const reset = substance(entry.card) !== substance(next);
  const sameOptions = JSON.stringify((entry.card.options || []).map((o) => [o.id, o.correct])) ===
    JSON.stringify((next.options || []).map((o) => [o.id, o.correct]));
  if (reset) {
    if (entry.feedback) entry.previousVersions = [...(entry.previousVersions || []), {
      card: structuredClone(entry.card), feedback: structuredClone(entry.feedback),
      order: entry.order ? [...entry.order] : undefined,
      signature: entry.signature, at: new Date().toISOString(),
    }];
    entry.feedback = null;
    entry.revealed = false;
    entry.selected = null;
    delete entry.signature;
    entry.startedAt = Date.now();
    entry.contentUpdated = true;
  }
  entry.card = structuredClone(next);
  if (!sameOptions && next.options) entry.order = shuffled(next.options.map((o) => o.id));
  return reset;
}
// Older versions intentionally left answered entries frozen after card.update.
// Repair only open non-exam snapshots; ordinary polling never writes.
function staleReviewEntries(s, run) {
  if (run.closedAt || run.mode === "exam") return [];
  return run.entries.flatMap((entry) => {
    const live = liveCard(s, run, entry);
    if (!live || contentKey(live) === contentKey(entry.card)) return [];
    // A snapshot kept after a coach fix only waits while the answer key differs;
    // older versions kept it even for wording fixes, so such entries heal here.
    if (entry.keepSnapshot && answerKey(live) !== answerKey(entry.card)) return [];
    return [{ entry, live }];
  });
}
function currentPrerequisites(s, run, entry) {
  const deckId = entry.deckId ?? run.deckId,
    live = s.decks.find((d) => d.id === deckId)?.cards.find((c) => c.id === entry.card.id);
  return live ? prerequisiteView(s, deckId, live, latestOutcomes(s.attempts)) : [];
}
/** The card the learner is on in the most recently active open run. */
function currentRun(s) {
  let best = null;
  for (const run of s.runs) {
    const entry = !run.closedAt && run.entries[run.index];
    if (entry && (!best || (entry.startedAt || 0) > (best.entry.startedAt || 0)))
      best = { run, entry };
  }
  return best;
}
function currentCard(s) {
  const best = currentRun(s);
  if (!best) throw new Error("No question is open in the study panel");
  return { deckId: best.entry.deckId ?? best.run.deckId, cardId: best.entry.card.id };
}
const contentKey = (card) => {
  const { review, flag, suspended, requires, revisions, ...content } = card;
  return JSON.stringify(content);
};
/**
 * Answering a question correctly shows its prerequisites are understood too.
 * Prerequisites that are due, weak or never studied (two levels deep) get a
 * passing review, recorded as implicit attempts; ones not yet due are left
 * alone so their intervals do not inflate.
 */
function creditPrerequisites(s, ref, runId, timestamp) {
  const outcome = latestOutcomes(s.attempts),
    seen = new Set(),
    now = Date.parse(timestamp);
  let credited = 0;
  const visit = (from, depth) => {
    let card;
    try {
      card = findCard(s, from).card;
    } catch {
      return;
    }
    for (const r of card.requires || []) {
      const key = r.deckId + "\0" + r.cardId;
      if (seen.has(key)) continue;
      seen.add(key);
      let pre;
      try {
        pre = findCard(s, r);
      } catch {
        continue;
      }
      if (pre.deck.archived || pre.card.suspended) continue;
      const last = outcome(pre.deck.id, pre.card.id),
        due = !pre.card.review?.due_at || Date.parse(pre.card.review.due_at) <= now;
      if (due || (last !== undefined && last < 3)) {
        const before = pre.card.review ?? initialReview(s.settings),
          after = schedule(before, 4, timestamp, s.settings);
        pre.card.review = after;
        s.attempts.push({
          id: id(),
          runId,
          quiz_id: pre.card.id,
          deckId: pre.deck.id,
          topic: pre.card.topic,
          timestamp,
          grade: 4,
          implicit: true,
          via: ref,
          before,
          after,
        });
        credited++;
      }
      if (depth < 2) visit(r, depth + 1);
    }
  };
  visit(ref, 1);
  return credited;
}
const runOpen = (r) => !r.closedAt && r.index < r.entries.length;
const runKey = (r) => r.key ?? scopeKey(r.mode, [{ deckId: r.deckId }]);
const runTouches = (r, deckId) =>
  r.deckId === deckId || r.entries.some((e) => e.deckId === deckId);
function runTitle(s, r) {
  if (r.mode === "path" && !r.scope?.length) return "今日学习";
  if (r.mode === "exam") return `模拟考试 · ${r.entries.length} 题`;
  if (r.scope?.length && r.scope.every((x) => x.cardId)) {
    const coachDeck = s.decks.find((d) => d.systemKind === "coach");
    if (coachDeck && r.scope.every((x) => x.deckId === coachDeck.id)) return `为你定制 · ${r.scope.length} 题`;
    return r.returnTo ? `前置题 · ${r.scope.length} 道` : `所选 ${r.scope.length} 道题`;
  }
  const titles = [
    ...new Set(
      (r.scope?.length ? r.scope : [{ deckId: r.deckId }]).map(
        (x) => s.decks.find((d) => d.id === x.deckId)?.title || "题组",
      ),
    ),
  ];
  const topics = (r.scope || []).filter((x) => x.topic).map((x) => x.topic);
  return topics.length === 1 && titles.length === 1
    ? `${titles[0]} › ${topics[0]}`
    : titles.length > 1
      ? `${titles[0]} 等 ${titles.length} 个题组`
      : titles[0];
}
const cleanFolder = (folder) =>
  (typeof folder === "string" ? folder : "")
    .split("/")
    .map((x) => x.trim())
    .filter(Boolean)
    .join(" / ")
    .slice(0, 200);
const MISTAKES = ["auto", "all", "none"];
function ingestView(s) {
  const m = s.ingest;
  if (!m?.active) return null;
  const deck = m.deckId && s.decks.find((d) => d.id === m.deckId);
  return {
    active: true,
    deckId: deck?.id || null,
    deckTitle: deck?.title || m.deckTitle,
    folder: deck ? deck.folder || "" : m.folder,
    kind: m.kind,
    mistakes: m.mistakes,
    added: m.added || 0,
    startedAt: m.startedAt,
  };
}
/** Run one library-mutating model task at a time (captures and ingests). */
async function inTurn(root, task) {
  const previous = captureQueues.get(root) || Promise.resolve();
  let release;
  const turn = new Promise((resolve) => (release = resolve));
  captureQueues.set(root, previous.then(() => turn));
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}
const solution = (q) => ({
  answer: q.answer,
  explanation: q.explanation,
  misconception: q.misconception,
  rubric: q.rubric,
  citations: q.citations,
  options: q.options,
  ...(q.kind === "cloze" ? { cloze: q.cloze } : {}),
});
/** Actions that only read or orchestrate; each manages its own store access. */
const HANDLERS = {
    "review.get": async function (a) {
      const s = await this.store.read();
      const run = get(s.runs, a.runId, "Review");
      if (!staleReviewEntries(s, run).length) return projection(s, run);
      return this.store.update((latest) => {
        const current = get(latest.runs, a.runId, "Review");
        let reset = false;
        for (const { entry, live } of staleReviewEntries(latest, current))
          if (entry.keepSnapshot && entry.feedback) {
            // Same answer key: show the improved card, keep the learner's result.
            entry.card = structuredClone(live);
            delete entry.keepSnapshot;
          } else reset = syncReviewEntry(entry, live) || reset;
        if (reset) current.queueVersion = (current.queueVersion || 0) + 1;
        return projection(latest, current);
      });
    },
    "deck.get": async function (a) {
      return get((await this.store.read()).decks, a.id, "Deck");
    },
    "teach.get": async function (a) {
      return getTeaching(await this.store.read(), a);
    },
    "teach.start": async function (a) {
      return startTeaching(this.store, this.complete, a);
    },
    "teach.answer": async function (a) {
      return answerTeaching(this.store, this.complete, a);
    },
    "map": async function (a) {
      return studyMap(await this.store.read());
    },
    "stats": async function (a) {
      return studyStats(await this.store.read());
    },
    "wrongbook": async function (a) {
      return wrongBook(await this.store.read());
    },
    "graph": async function (a) {
      return graphData(await this.store.read(), a);
    },
    "snapshot": async function (a) {
      // Polling panels send their last fingerprint. It is built from the
      // library file's stat plus in-memory job and coach state, so an
      // unchanged poll neither reads nor parses the library (megabytes of
      // source text) nor builds and sends a full snapshot. Due counts move
      // with time, so the fingerprint also rolls over each minute.
      const root = this.store.root;
      const fingerprint = JSON.stringify([
        await this.store.stamp(), root, !!this.complete, this.coach && !!this.light,
        Math.floor(Date.now() / 60000), this.coachActivity(),
        [...jobs.values()].filter((j) => j.root === root).map(publicJob),
      ]);
      if (!a.compact && a.since === fingerprint) return { unchanged: true, fingerprint };
      const s = await this.store.read();
      const coach = this.coachStatus(s);
      const outcome = latestOutcomes(s.attempts),
        map = studyMap(s);
      const latestRuns = new Map();
      for (const r of s.runs.filter(runOpen)) latestRuns.set(runKey(r), r);
      const snapshot = {
        today: map.today,
        next: map.next,
        progress: Object.fromEntries(map.decks.map((d) => [d.id, d])),
        root: this.store.root,
        revision: s.revision,
        settings: s.settings,
        sources: s.sources,
        decks: s.decks.map((d) => ({
          id: d.id,
          title: d.title,
          folder: d.folder || "",
          count: d.cards.length,
          systemKind: d.systemKind,
          archived: !!d.archived,
          available: d.cards.filter((q) => !q.suspended).length,
          quizCount: d.cards.filter(
            (q) => !q.suspended && q.kind !== "flashcard",
          ).length,
          examCount: d.cards.filter((q) => !q.suspended && ["quiz", "multi"].includes(q.kind)).length,
          suspended: d.cards.filter((q) => q.suspended).length,
          wrong: d.cards.filter((q) => !q.suspended && outcome(d.id, q.id) < 3)
            .length,
          topics: [...new Set(d.cards.map((q) => q.topic))],
          due: d.cards.filter(
            (q) =>
              !q.suspended &&
              (!q.review?.due_at || Date.parse(q.review.due_at) <= Date.now()),
          ).length,
          flagged: d.cards.filter((q) => q.flag).length,
        })),
        drafts: s.drafts,
        attempts: s.attempts.slice(-100),
        runs: [...latestRuns.values()]
          // A run is unresumable once every deck it references is gone; hide it
          // rather than offering a button that fails with "Deck not found".
          // Path runs may carry an empty scope (all decks) or a null deckId
          // when they span decks, so the run's own entries are authoritative.
          .filter((r) => {
            const ids = new Set(
              (r.entries || []).map((e) => e.deckId).filter(Boolean),
            );
            for (const x of r.scope || []) if (x.deckId) ids.add(x.deckId);
            if (!ids.size && r.deckId) ids.add(r.deckId);
            return [...ids].some((id) => s.decks.some((d) => d.id === id));
          })
          .map((r) => ({
            id: r.id,
            deckId: r.deckId,
            title: runTitle(s, r),
            scope: r.scope ?? [{ deckId: r.deckId }],
            index: r.index,
            total: r.entries.length,
            mode: r.mode,
          })),
        jobs: [...jobs.values()]
          .filter((j) => j.root === this.store.root)
          .map(publicJob),
        modelReady: !!this.complete,
        coach,
        ...(a.compact ? {} : { fingerprint }),
        ingest: ingestView(s),
        lastRun: (() => {
          // The run itself, not the first run that happens to sit on the same card.
          const best = currentRun(s);
          const run = best?.run;
          if (!run || !runOpen(run) || !s.decks.some((d) => d.id === (best.entry.deckId ?? run.deckId))) return null;
          return { id: run.id, title: runTitle(s, run), index: run.index, total: run.entries.length, mode: run.mode };
        })(),
      };
      // Agents get summaries; full texts stay behind source.get / deck.get.
      if (a.compact)
        Object.assign(snapshot, {
          sources: s.sources.map((x) => ({ id: x.id, title: x.title, chars: x.text.length })),
          drafts: s.drafts.map((d) => ({
            id: d.id,
            title: d.title,
            cards: d.cards.length,
            draftVersion: d.draftVersion,
            editingDeckId: d.editingDeckId,
          })),
          attempts: s.attempts.length,
        });
      return snapshot;
    },
    "export": async function (a) {
      return this.store.read();
    },
    "coach.status": async function () {
      return this.coachStatus(await this.store.read());
    },
    /** What the coach remembers, shown in 设置 so the learner can inspect or clear it. */
    "coach.profile": async function () {
      const s = await this.store.read(),
        { consent, goal, summary, signals, updatedAt } = ensureLearner(s);
      return { consent: consent.prep, goal, summary, signals, updatedAt, ready: s.prepared.filter((p) => p.status === "ready").length };
    },
    "coach.nudge": async function (a) {
      if (!this.light) throw new Error("当前会话没有可用模型");
      return this.nudgeFor(a.runId, a.index);
    },
    "coach.reply": async function (a) {
      const reply = a.reply;
      if (!["got", "confused", "check"].includes(reply)) throw new Error("Unknown reply");
      let followup = null;
      if (reply === "confused") {
        if (!this.light) throw new Error("当前会话没有可用模型");
        const s = await this.store.read(),
          learner = ensureLearner(s),
          note = get(s.coach, a.noteId, "陪学记录");
        // Two extra angles at most; after that the thread offers the chat instead.
        if ((note.followups || []).length < 2) {
          let card;
          try {
            card = findCard(s, note).card;
          } catch {
            card = s.runs.find((r) => r.id === note.runId)?.entries[note.entryIndex]?.card;
          }
          if (!card) throw new Error("这道题已经不在题库里");
          followup = await writeFollowup(this.light, { card, note, learner });
        }
      }
      return this.store.update((st) => {
        const learner = ensureLearner(st),
          note = get(st.coach, a.noteId, "陪学记录");
        if (reply === "got" && note.reply !== "got") {
          note.reply = "got";
          learner.signals.got++;
        } else if (reply === "confused") {
          note.reply = "confused";
          learner.signals.confused++;
          if (followup) note.followups = [...(note.followups || []), { ...followup, at: new Date().toISOString() }];
        } else if (reply === "check" && note.check && !note.checked) {
          const choice = Number(a.choice);
          if (!Number.isInteger(choice) || choice < 0 || choice >= note.check.options.length) throw new Error("Invalid choice");
          note.checked = { choice, correct: choice === note.check.answer };
          learner.signals[note.checked.correct ? "got" : "confused"]++;
        }
        return { thread: threadView(st, note.cardId) };
      });
    },
    "coach.feedback": async function (a) {
      const vote = a.vote;
      if (!["up", "down"].includes(vote)) throw new Error("vote must be up or down");
      const tags = [...new Set(Array.isArray(a.tags) ? a.tags : [])].filter((t) => Object.hasOwn(FEEDBACK_TAGS, t));
      if (vote === "up" && tags.length) throw new Error("Tags describe a problem; use vote down");
      const result = await this.store.update((s) => {
        const learner = ensureLearner(s),
          { deck, card } = findCard(s, a),
          now = new Date().toISOString();
        // Taps within ten minutes on the same card refine one record.
        const recent = s.feedback.findLast((f) => f.cardId === card.id && Date.now() - Date.parse(f.at) < 600000);
        let added = tags;
        if (recent?.vote === vote) {
          added = tags.filter((t) => !recent.tags.includes(t));
          recent.tags.push(...added);
          recent.at = now;
        } else {
          s.feedback.push({ id: id(), deckId: deck.id, cardId: card.id, vote, tags, at: now });
          learner.signals[vote]++;
        }
        for (const t of added) if (t === "too-easy") learner.signals.easy++;
        else if (t === "too-hard") learner.signals.hard++;
        trimLogs(s);
        return { ref: { deckId: deck.id, cardId: card.id }, added, consent: learner.consent.prep };
      });
      const scheduled = [];
      if (this.coach && this.light) {
        const rewrite = result.added.filter((t) => REWRITE_TAGS.has(t));
        if (rewrite.length) {
          this.scheduleRewrite(result.ref, rewrite);
          scheduled.push("rewrite");
        }
        for (const reason of result.added.filter((t) => t === "too-easy" || t === "too-hard"))
          if (result.consent === true) {
            this.queuePrep({ ...result.ref, reason });
            scheduled.push("prep");
          }
      }
      return { vote, tags: result.added, scheduled, status: this.coachStatus(await this.store.read()) };
    },
    "coach.consent": async function (a) {
      if (typeof a.prep !== "boolean") throw new Error("prep must be true or false");
      const recentWrong = await this.store.update((s) => {
        const learner = ensureLearner(s);
        learner.consent.prep = a.prep;
        learner.updatedAt = new Date().toISOString();
        const seen = new Set();
        return s.attempts.slice(-40).reverse().filter((x) => x.grade < 3 && !seen.has(x.quiz_id) && seen.add(x.quiz_id))
          .slice(0, 4).map((x) => ({ deckId: x.deckId, cardId: x.quiz_id, reason: "wrong" }));
      });
      // Opting in prepares variants of what was just missed, in one batch.
      if (a.prep && this.coach) {
        recentWrong.forEach((t) => this.queuePrep(t));
        this.flushPrep();
      }
      return this.coachStatus(await this.store.read());
    },
    /** Run the pending variant batch now (tests, or a debrief that needs it). */
    "coach.prepare": async function () {
      await this.flushPrep();
      return this.coachStatus(await this.store.read());
    },
    "coach.debrief": async function (a) {
      // The panel prefetches on the last answer and asks again on the summary;
      // concurrent requests for the same state share one model call.
      const key = `${this.store.root}:debrief:${a.runId}`;
      if (!coachInflight.has(key))
        coachInflight.set(key, this.debrief(a).finally(() => coachInflight.delete(key)));
      return coachInflight.get(key);
    },
    "source.import": async function (a) {
      const extracted = await extractPdf(a);
      const imported = await this.store.update((s) => {
        let added = 0;
        const legacyPages = s.sources.filter((source) => source.document?.id === extracted.documentId &&
          !source.document.extractionVersion && extracted.sources.some((current) => current.document.page === source.document.page)).length;
        for (const source of extracted.sources) {
          if (!s.sources.some((x) => x.id === source.id)) { s.sources.push(source); added++; }
        }
        return { added, legacyPages };
      });
      return { ...extracted, ...imported, sourceIds: extracted.sources.map((s) => s.id),
        sources: extracted.sources.map(({ text, ...s }) => ({ ...s, chars: text.length, preview: text.slice(0, 300) })) };
    },
    "generate": async function (a) {
      if (!this.complete)
        throw new Error(
          "Configure a model provider and model in the study settings first",
        );
      if (a.kind && !["quiz", "multi", "flashcard", "open", "cloze", "mixed"].includes(a.kind))
        throw new Error("Unknown question kind");
      const count = Number(a.count ?? 10);
      if (!Number.isInteger(count) || count < 1 || count > 30)
        throw new Error("Choose 1–30 questions");
      const s = await this.store.read(),
        sources = s.sources.filter((x) => a.sourceIds?.includes(x.id));
      if (!sources.length) throw new Error("Select at least one source");
      const chars = sources.reduce((n, x) => n + x.text.length, 0);
      if (chars > MAX_SELECTED_CHARS)
        throw new Error(
          `Selected sources total ${chars} characters; the limit is ${MAX_SELECTED_CHARS}. Select fewer sources.`,
        );
      pruneJobs();
      const root = this.store.root,
        ahead = [...jobs.values()].filter((j) => j.root === root && activeJob(j)).length,
        parts = planGeneration({ sources, count, kind: a.kind }).length;
      const job = {
        id: id(),
        root,
        status: ahead ? "queued" : "running",
        stage: ahead ? "Waiting for the previous generation" : "Writing source-grounded questions",
        kind: a.kind || "quiz",
        count,
        parts,
        steps: [],
        concurrency: 3,
        generationTimeoutSeconds: GENERATION_TIMEOUT_MS / 1000,
        totalTimeoutSeconds: GENERATION_JOB_TIMEOUT_MS / 1000,
        messages: [],
        startedAt: new Date().toISOString(),
      };
      jobs.set(job.id, job);
      const controller = new AbortController();
      generationControllers.set(job.id, controller);
      const run = async () => {
        if (controller.signal.aborted) {
          job.status = "cancelled";
          job.finishedAt ||= new Date().toISOString();
          generationControllers.delete(job.id);
          return;
        }
        const timer = setTimeout(() => {
          job.status = "cancelling";
          job.stage = "Time budget reached; stopping workers";
          controller.abort(new Error("Generation reached its 20-minute total budget; approved questions were retained"));
        }, job.totalTimeoutSeconds * 1000);
        job.status = "running";
        job.stage = "Writing source-grounded questions";
        try {
          const latest = await this.store.read();
          let savedVersion;
          const saveProgress = async (deck) => {
            if (savedVersion !== undefined && !(await this.store.read()).drafts.some((d) => d.id === deck.id))
              throw new Error("Generation draft was removed; refusing to recreate it");
            const saved = await this.call("draft.save", { deck: { ...deck, ...(savedVersion === undefined ? {} : { draftVersion: savedVersion }) } });
            savedVersion = saved.draftVersion;
            job.draftId = saved.id;
            job.savedCount = saved.cards.length;
          };
          const deck = await generateBatched(
            async (system, prompt, context = {}) => {
              controller.signal.throwIfAborted();
              const stage = context.stage || job.stage;
              const step = { id: id(), stage, part: context.part, status: "starting", startedAt: new Date().toISOString() };
              job.steps.push(step);
              try {
                const notes = job.messages.map((m) => m.text);
                const value = await this.complete(system, notes.length
                  ? `${prompt}\n\nAdditional learner requirements (apply within the requested schema and source evidence):\n${JSON.stringify(notes)}` : prompt, {
                  jobId: job.id, stage, signal: controller.signal,
                  onEvent: (event) => Object.assign(step, event),
                  setMessenger: (send) => {
                    if (send) {
                      if (!generationMessengers.has(job.id)) generationMessengers.set(job.id, new Map());
                      generationMessengers.get(job.id).set(step.id, send);
                    } else generationMessengers.get(job.id)?.delete(step.id);
                  },
                });
                controller.signal.throwIfAborted();
                step.runtime ||= "direct";
                step.status = "complete";
                return value;
              } catch (error) { step.status = "failed"; throw error; }
              finally { generationMessengers.get(job.id)?.delete(step.id); step.finishedAt = new Date().toISOString(); }
            },
            {
              ...a,
              signal: controller.signal,
              count,
              sources,
              existing: [...latest.decks, ...latest.drafts].flatMap((d) => d.cards.map((q) => q.objective)),
            },
            (stage, context) => {
              if (!controller.signal.aborted) job.stage = context?.part ? "Parallel generation · up to 3 batches" : stage;
            },
            saveProgress,
          );
          await saveProgress(deck);
          controller.signal.throwIfAborted();
          job.status = "complete";
          job.stage = deck.editorial.failures.length
            ? `Draft ready with ${deck.cards.length}/${count} questions; ${deck.editorial.failures.length} part(s) failed`
            : "Draft ready for review";
        } catch (e) {
          job.status = controller.signal.aborted && job.cancelRequestedAt ? "cancelled" : "failed";
          job.stage = controller.signal.aborted ? controller.signal.reason.message : e.message;
        } finally {
          clearTimeout(timer);
          generationControllers.delete(job.id);
          generationMessengers.delete(job.id);
          job.finishedAt = new Date().toISOString();
        }
      };
      const done = (queues.get(root) || Promise.resolve()).then(run);
      queues.set(root, done);
      settled.set(job.id, done);
      void done.finally(() => {
        settled.delete(job.id);
        if (queues.get(root) === done) queues.delete(root);
      });
      return {
        jobId: job.id,
        status: job.status,
        queuedBehind: ahead,
        parts,
        next: "Generation runs in the background. Tell the learner it is queued and open the Study workspace for progress. Use job.wait only if explicitly waiting for completion; do not repeatedly poll snapshot or enqueue duplicates.",
      };
    },
    "job.cancel": async function (a) {
      const scoped = [...jobs.values()].filter((j) => j.root === this.store.root);
      if (a.all && a.jobId) throw new Error("Use jobId or all, not both");
      if (!a.all && !a.jobId) throw new Error("Specify jobId or all:true to cancel this library queue");
      const targets = a.all ? scoped.filter(activeJob) : [get(scoped, a.jobId, "Study job")];
      for (const job of targets) {
        if (!activeJob(job) || job.status === "cancelling") continue;
        const queued = job.status === "queued";
        job.cancelRequestedAt = new Date().toISOString();
        job.status = queued ? "cancelled" : "cancelling";
        job.stage = queued ? "Cancelled before starting" : "Stopping generation workers; keeping approved draft";
        generationControllers.get(job.id)?.abort(new Error("Generation cancelled; approved questions were retained"));
        if (queued) {
          job.finishedAt = new Date().toISOString();
          generationControllers.delete(job.id);
        }
      }
      return { jobs: targets.map(publicJob), note: "Cancelling means worker cleanup is pending. Cancelled queued jobs will never start. Saved drafts are retained." };
    },
    "job.message": async function (a) {
      const candidates = [...jobs.values()].filter((j) => j.root === this.store.root && activeJob(j));
      if (!a.jobId && candidates.length > 1) throw new Error("Multiple generation jobs are active; specify jobId");
      const job = a.jobId ? get(candidates, a.jobId, "Active generation job") : candidates[0];
      if (!job) throw new Error("No active generation job; completed drafts are not changed by messages");
      const text = typeof a.message === "string" ? a.message.trim() : "";
      if (!text || text.length > 4000) throw new Error("Use a message of 1–4000 characters");
      if (job.messages.length >= 20) throw new Error("This job already has 20 supplementary messages");
      const message = { id: id(), text, at: new Date().toISOString(), delivery: "next-stage" };
      job.messages.push(message);
      const senders = [...(generationMessengers.get(job.id)?.values() || [])];
      if (senders.length) {
        message.receipts = await Promise.all(senders.map(async (send) => {
          try { return { ...await send(text), delivered: true }; }
          catch (error) { return { delivered: false, error: error.message }; }
        }));
        const delivered = message.receipts.filter((receipt) => receipt.delivered);
        if (delivered.length === senders.length) message.delivery = "delivered";
        else if (delivered.length) message.delivery = "partial";
        if (senders.length === 1 && delivered.length) Object.assign(message, delivered[0]);
      }
      return { jobId: job.id, ...message,
        note: message.delivery === "delivered"
          ? "Delivered to all currently reachable children and retained for later stages; completed batches are unchanged."
          : "Saved for the next model stage; NOT delivered to the current child. If no stage remains, regenerate the draft with this requirement." };
    },
    "job.wait": async function (a) {
      const root = this.store.root,
        job = a.jobId
          ? get([...jobs.values()].filter((j) => j.root === root), a.jobId, "Job")
          : [...jobs.values()].filter((j) => j.root === root).at(-1);
      if (!job) return { status: "none" };
      const seconds = Math.min(Math.max(Number(a.timeoutSeconds) || 60, 1), 60);
      if (activeJob(job)) {
        let timer;
        await Promise.race([
          settled.get(job.id),
          new Promise((resolve) => {
            timer = setTimeout(resolve, seconds * 1000);
          }),
        ]);
        clearTimeout(timer);
      }
      const result = publicJob(job);
      result.waitLimitSeconds = seconds;
      if (job.draftId) {
        const draft = (await this.store.read()).drafts.find((d) => d.id === job.draftId);
        if (draft)
          result.draft = {
            id: draft.id,
            title: draft.title,
            cards: draft.cards.length,
            topics: [...new Set(draft.cards.map((c) => c.topic))],
            warnings: draft.quality?.warnings?.length || 0,
            failures: draft.editorial?.failures || [],
          };
      } else if (activeJob(job))
        result.next = "Still running in the background. Return control to the learner; progress and the resulting draft appear in the Study workspace. Do not start duplicate jobs.";
      return result;
    },
    "source.get": async function (a) {
      const source = get((await this.store.read()).sources, a.id, "Source");
      const offset = Math.max(0, Number(a.offset) || 0),
        limit = Math.min(Math.max(Number(a.limit) || 20000, 1), 60000);
      return {
        id: source.id,
        title: source.title,
        ...(source.document ? { document: source.document } : {}),
        chars: source.text.length,
        offset,
        text: source.text.slice(offset, offset + limit),
      };
    },
    "capture": async function (a) {
      if (!this.complete)
        throw new Error("A model is required to file questions");
      const parsed =
        a.question !== undefined
          ? { question: String(a.question).trim(), kind: a.kind || "flashcard" }
          : parseSparInput(a.input);
      if (parsed.question.length < 2 || parsed.question.length > 2000)
        throw new Error("Question must be 2–2000 characters");
      if (!["flashcard", "quiz", "multi", "open"].includes(parsed.kind))
        throw new Error("Unknown question kind");
      const startedAt = Date.now();
      return inTurn(this.store.root, async () => {
        const timings = { queueMs: Date.now() - startedAt, modelCalls: [] };
        const state = await this.store.read();
        const dependent =
          a.requiredBy === "current" || parsed.prerequisite
            ? currentCard(state)
            : a.requiredBy
              ? (({ deck, card }) => ({ deckId: deck.id, cardId: card.id }))(findCard(state, a.requiredBy))
              : null;
        const plan = await captureQuestion(async (system, prompt) => {
          const start = Date.now();
          try { return await this.complete(system, prompt); }
          finally { timings.modelCalls.push({ stage: system.startsWith("You file") ? "placement" : "author", elapsedMs: Date.now() - start, inputChars: system.length + prompt.length }); }
        }, state, {
          ...parsed,
          deckId: typeof a.deckId === "string" ? a.deckId : undefined,
          answer: typeof a.answer === "string" ? a.answer.slice(0, 8000) : "",
          related: dependent && { ...dependent, prompt: findCard(state, dependent).card.prompt },
          notes: typeof a.notes === "string" ? a.notes.slice(0, 4000) : "",
        });
        const link = (s, result) => {
          if (!dependent) return result;
          try {
            const linked = linkPrerequisite(s, dependent, result);
            return {
              ...result,
              prerequisiteFor: { ...dependent, prompt: findCard(s, dependent).card.prompt },
              alreadyLinked: !!linked.existing,
            };
          } catch (e) {
            return { ...result, linkError: e.message };
          }
        };
        const result = await this.store.update((s) => link(s, (() => {
          const at = (deck, card) => ({
            deckId: deck.id,
            deckTitle: deck.title,
            folder: deck.folder || "",
            topic: card.topic,
            cardId: card.id,
            prompt: card.prompt,
            kind: card.kind,
          });
          if (plan.duplicate) {
            const deck = get(s.decks, plan.duplicate.deckId, "Deck");
            return {
              status: "duplicate",
              ...at(deck, get(deck.cards, plan.duplicate.cardId, "Question")),
            };
          }
          let deck = plan.deckId && s.decks.find((d) => d.id === plan.deckId);
          const created = !deck;
          if (!deck) {
            deck = {
              id: id(),
              title: plan.newDeck?.title || "随手问",
              folder: cleanFolder(plan.newDeck?.folder),
              cards: [],
            };
            s.decks.push(deck);
          }
          const same = deck.cards.find((c) => samePrompt(c.prompt, plan.card.prompt));
          if (same) return { status: "duplicate", ...at(deck, same) };
          if (plan.note) s.sources.push(plan.note);
          const card = {
            ...plan.card,
            review: initialReview(s.settings),
            capturedAt: new Date().toISOString(),
          };
          deck.cards.push(card);
          // Keep an open editing draft in step so publishing it cannot drop the new card.
          const editing = s.drafts.find((d) => d.editingDeckId === deck.id);
          if (editing) {
            editing.cards.push(structuredClone(card));
            editing.draftVersion = (editing.draftVersion || 0) + 1;
          }
          return {
            status: "added",
            ...at(deck, card),
            answer: card.answer,
            grounded: !plan.note,
            newDeck: created,
          };
        })()));
        return { ...result, performance: { ...timings, totalMs: Date.now() - startedAt } };
      });
    },
    "card.get": async function (a) {
      const s = await this.store.read(),
        { deck, card } = findCard(s, a),
        outcome = latestOutcomes(s.attempts),
        cited = new Set(card.citations?.map((c) => c.sourceId));
      return {
        deckId: deck.id,
        deckTitle: deck.title,
        folder: deck.folder || "",
        card: (({ review, revisions, ...content }) => content)(card),
        revisions: (card.revisions || []).map(({ at, reason }) => ({ at, reason })),
        prerequisites: prerequisiteView(s, deck.id, card, outcome),
        requiredBy: s.decks.flatMap((d) =>
          d.cards
            .filter((c) => c.requires?.some((r) => r.deckId === deck.id && r.cardId === card.id))
            .map((c) => ({ deckId: d.id, cardId: c.id, prompt: c.prompt })),
        ),
        sources: s.sources.filter((x) => cited.has(x.id)).map((x) => ({ id: x.id, title: x.title, chars: x.text.length })),
      };
    },
    "card.current": async function (a) {

      return this.call("card.get", currentCard(await this.store.read()));
    },
    "ingest.status": async function (a) {
      return ingestView(await this.store.read());
    },
    "ingest": async function (a) {
      if (!this.complete) throw new Error("A model is required to record questions");
      const text = typeof a.text === "string" ? a.text.trim() : "";
      if (text.length < 8) throw new Error("Paste at least one question");
      if (text.length > MAX_INGEST_CHARS)
        throw new Error(`Pasted text is ${text.length} characters; send at most ${MAX_INGEST_CHARS} per batch`);
      return inTurn(this.store.root, async () => {
        const state = await this.store.read(),
          mode = state.ingest?.active ? state.ingest : {};
        const kind = a.kind ?? mode.kind ?? "auto",
          mistakes = a.mistakes ?? mode.mistakes ?? "auto";
        if (!INGEST_KINDS.includes(kind)) throw new Error("Unknown question kind");
        if (!MISTAKES.includes(mistakes)) throw new Error("mistakes must be auto, all or none");
        const target = a.deckId
          ? get(state.decks, a.deckId, "Deck")
          : a.deckTitle
            ? state.decks.find((d) => d.title === a.deckTitle && (d.folder || "") === cleanFolder(a.folder))
            : mode.deckId && state.decks.find((d) => d.id === mode.deckId);
        const deckTitle = target?.title || a.deckTitle || mode.deckTitle || "对话录题";
        const source = {
          id: id(),
          title: String(a.title || `对话录入 · ${deckTitle} · ${new Date().toISOString().slice(0, 16).replace("T", " ")}`).slice(0, 200),
          text,
          origin: "conversation",
        };
        const parsed = await parseIngest(this.complete, {
          text,
          kind,
          mistakes,
          source,
          existing: target ? target.cards.map((c) => c.objective) : [],
        });
        return this.store.update((s) => {
          let deck = target && s.decks.find((d) => d.id === target.id);
          const created = !deck;
          const report = { added: [], duplicates: [], skipped: [], ignored: parsed.ignored };
          const fresh = [];
          for (const r of parsed.results) {
            const label = String(r.card.prompt || "").slice(0, 80);
            if (r.errors.length) {
              report.skipped.push({ prompt: label, reason: r.errors.join("; ") });
              continue;
            }
            const twin = s.decks
              .flatMap((d) => d.cards.map((c) => ({ d, c })))
              .find(({ c }) => samePrompt(c.prompt, r.card.prompt));
            if (twin || fresh.some((x) => samePrompt(x.card.prompt, r.card.prompt))) {
              report.duplicates.push({ prompt: label, deckTitle: twin?.d.title || deckTitle, topic: twin?.c.topic });
              continue;
            }
            fresh.push(r);
          }
          if (fresh.length) {
            if (!deck) {
              deck = { id: id(), title: deckTitle, folder: cleanFolder(a.folder ?? mode.folder), cards: [] };
              s.decks.push(deck);
            }
            s.sources.push(source);
            const timestamp = new Date().toISOString();
            for (const r of fresh) {
              const card = {
                ...r.card,
                review: initialReview(s.settings),
                capturedAt: timestamp,
                origin: "conversation",
                ...(r.inferred ? { flag: "答案由模型推断，待核对" } : {}),
              };
              deck.cards.push(card);
              if (r.wrong)
                s.attempts.push({
                  id: id(),
                  quiz_id: card.id,
                  deckId: deck.id,
                  topic: card.topic,
                  timestamp,
                  grade: 1,
                  imported: "mistake",
                });
              report.added.push({
                cardId: card.id,
                kind: card.kind,
                topic: card.topic,
                prompt: card.prompt.slice(0, 80),
                mistake: r.wrong,
                answerInferred: r.inferred,
              });
            }
            const editing = s.drafts.find((d) => d.editingDeckId === deck.id);
            if (editing) {
              editing.cards.push(...fresh.map((r) => structuredClone(deck.cards.find((c) => c.id === r.card.id))));
              editing.draftVersion = (editing.draftVersion || 0) + 1;
            }
            if (s.ingest?.active) {
              s.ingest.added = (s.ingest.added || 0) + fresh.length;
              if (!s.ingest.deckId && !a.deckId && !a.deckTitle) s.ingest.deckId = deck.id;
            }
          }
          return {
            deckId: deck?.id || null,
            deckTitle,
            folder: deck ? deck.folder || "" : cleanFolder(a.folder ?? mode.folder),
            newDeck: !!deck && created,
            sourceId: fresh.length ? source.id : null,
            ...report,
          };
        });
      });
    },
    "legacy.import": async function (a) {
      const imported = await importLegacy(
        required(a.path, "Legacy library path"),
      );
      return this.store.update((s) => {
        for (const source of imported.sources)
          if (!s.sources.some((x) => x.id === source.id))
            s.sources.push(source);
        const existing = s.decks.find((d) => d.id === imported.deck.id);
        if (existing)
          return { id: existing.id, reused: true, warnings: imported.warnings };
        s.decks.push(imported.deck);
        return {
          id: imported.deck.id,
          count: imported.deck.cards.length,
          warnings: imported.warnings,
        };
      });
    },
};

/** Mutations; each runs inside one locked store.update transaction. */
const MUTATIONS = {
    "card.slay": (s, a) => {
      const result = slayCard(s, a);
      return a.runId ? projection(s, get(s.runs, a.runId, "Review")) : result;
    },
    "card.restore": (s, a) => restoreSlainCard(s, a),
    "draft.import": (s, a) => {
      const { source, deck } = prepareJsonImport(a.text);
      s.sources.push(source);
      s.drafts.push(deck);
      return deck;
    },
    "deck.edit": (s, a) => {
      const deck = get(s.decks, a.id, "Deck");
      if (isSlayDeck(deck)) throw new Error("请先将题目恢复到原题组再编辑");
      const existing = s.drafts.find((d) => d.editingDeckId === deck.id);
      if (existing) return existing;
      const draft = {
        ...structuredClone(deck),
        id: id(),
        editingDeckId: deck.id,
        baseVersion: deck.contentVersion || 0,
        draftVersion: 1,
      };
      s.drafts.push(draft);
      return draft;

    },
    "deck.archive": (s, a) => {
      const deck = get(s.decks, a.id, "Deck");
      if (isSlayDeck(deck)) throw new Error("斩题组不参与复习，请逐题恢复到原题组");
      deck.archived = a.archived === true;
      if (deck.archived)
        for (const run of s.runs.filter(
          (r) => runTouches(r, deck.id) && !r.closedAt,
        ))
          run.closedAt = new Date().toISOString();
      return { ok: true };

    },
    "card.update": (s, a) => {
      const { card } = findCard(s, a);
      const content = patchContent(card, a.patch);
      const reason = typeof a.reason === "string" && a.reason.trim() ? a.reason.trim().slice(0, 500) : "Improved in conversation";
      return applyCardContent(s, a, content, reason);

    },
    "coach.forget": (s) => {
      // Clears the profile and pending prepared cards; practice history stays.
      s.learner = null;
      const learner = ensureLearner(s);
      s.prepared = s.prepared.filter((p) => p.status !== "ready");
      return { consent: learner.consent.prep, goal: "", summary: "", signals: learner.signals, updatedAt: null, ready: 0 };
    },
    "coach.goal": (s, a) => {
      const learner = ensureLearner(s);
      if (a.goal !== "" && !Object.hasOwn(GOALS, a.goal)) throw new Error("Unknown goal");
      learner.goal = a.goal;
      learner.updatedAt = new Date().toISOString();
      return { goal: learner.goal };
    },
    /** Move every ready prepared card into 为你定制 and start practising them. */
    "coach.practice": (s) => {
      ensureLearner(s);
      const ready = s.prepared.filter((p) => p.status === "ready");
      if (!ready.length) throw new Error("还没有备好的定制题");
      let deck = s.decks.find((d) => d.systemKind === "coach");
      if (!deck) {
        deck = { id: id(), title: "为你定制", systemKind: "coach", folder: "", cards: [], createdAt: new Date().toISOString() };
        s.decks.push(deck);
      }
      deck.archived = false;
      const added = [];
      for (const p of ready) {
        const card = { ...p.card, review: initialReview(s.settings), origin: { deckId: p.originDeckId, cardId: p.originCardId, reason: p.reason } };
        const cards = [...deck.cards, card];
        if (validateDeck({ title: deck.title, cards }, s.sources).errors.some((e) => e.startsWith(`Card ${cards.length}:`))) {
          p.status = "invalid";
          continue;
        }
        deck.cards.push(card);
        s.learner.levels[card.id] = LEVEL_NAMES[p.level] ? p.level : "apply";
        // A 太难 scaffold is exactly a prerequisite of the card it was written for.
        if (p.reason === "too-hard")
          try {
            linkPrerequisite(s, { deckId: p.originDeckId, cardId: p.originCardId }, { deckId: deck.id, cardId: card.id });
          } catch {
            // The original was removed or the link would cycle; the card still stands alone.
          }
        p.status = "used";
        added.push({ deckId: deck.id, cardId: card.id });
      }
      if (!added.length) throw new Error("备好的题没有通过校验，请稍后再试");
      return MUTATIONS["review.start"](s, { mode: "path", scope: added, fresh: true });
    },
    /** Undo a coach rewrite without disturbing the answered question on screen. */
    "coach.revert": (s, a) => {
      const { card } = findCard(s, a);
      const last = card.revisions?.at(-1);
      if (!last) throw new Error("This question has no earlier version");
      const result = applyCardContent(s, a, last.content, null, { keepAnswered: true });
      for (const n of s.coach || []) if (n.cardId === card.id && n.revertable) n.revertable = false;
      return { ...result, reverted: last.reason };
    },
    "card.revert": (s, a) => {
      const { card } = findCard(s, a);
      const last = card.revisions?.at(-1);
      if (!last) throw new Error("This question has no earlier version");
      return { ...applyCardContent(s, a, last.content, null), reverted: last.reason };

    },
    "ingest.start": (s, a) => {
      const kind = a.kind ?? "auto",
        mistakes = a.mistakes ?? "auto";
      if (!INGEST_KINDS.includes(kind)) throw new Error("Unknown question kind");
      if (!MISTAKES.includes(mistakes)) throw new Error("mistakes must be auto, all or none");
      const deck = a.deckId ? get(s.decks, a.deckId, "Deck") : null;
      const deckTitle = deck?.title || String(a.deckTitle || "").trim().slice(0, 120);
      if (!deckTitle) throw new Error("Choose a deck or name a new one");
      s.ingest = {
        active: true,
        deckId: deck?.id || s.decks.find((d) => d.title === deckTitle && (d.folder || "") === cleanFolder(a.folder))?.id || null,
        deckTitle,
        folder: deck ? deck.folder || "" : cleanFolder(a.folder),
        kind,
        mistakes,
        added: 0,
        startedAt: new Date().toISOString(),
      };
      return ingestView(s);

    },
    "ingest.stop": (s, a) => {
      const was = ingestView(s);
      if (s.ingest) s.ingest.active = false;
      return { stopped: !!was, added: was?.added || 0, deckTitle: was?.deckTitle || null };

    },
    "card.link": (s, a) => {

      return linkPrerequisite(
        s,
        { deckId: a.deckId, cardId: a.cardId },
        a.requires || {},
        a.remove === true,
      );
    },
    "deck.move": (s, a) => {
      const deck = get(s.decks, a.id, "Deck");
      if (typeof a.folder === "string" && a.folder.length > 200)
        throw new Error("Folder name is too long");
      deck.folder = cleanFolder(a.folder);
      return { id: deck.id, folder: deck.folder };

    },
    "settings": (s, a) => {

      s.settings = checkSettings({ ...s.settings, ...a });
      return s.settings;
    },
    "source.add": (s, a) => {
      const source = {
        id: a.id || id(),
        title: required(a.title, "Source title"),
        text: required(a.text, "Source text"),
      };
      if (source.text.length > MAX_SELECTED_CHARS)
        throw new Error(`Source must be at most ${MAX_SELECTED_CHARS} characters`);
      if (s.sources.some((x) => x.id === source.id))
        throw new Error("Source id already exists");
      s.sources.push(source);
      return source;

    },
    "source.remove": (s, a) => {
      if (
        [
          ...s.decks,
          ...s.drafts,
          ...s.runs.map((r) => ({ cards: r.entries.flatMap((e) => [e.card, ...(e.previousVersions || []).map((v) => v.card)]) })),
        ].some((d) =>
          d.cards.some((q) =>
            q.citations?.some((c) => c.sourceId === a.id),
          ),
        )
      )
        throw new Error("Source is referenced by a deck or draft");
      s.sources = s.sources.filter((x) => x.id !== a.id);
      return { ok: true };

    },
    "draft.save": (s, a) => {
      const d = structuredClone(a.deck);
      d.id = d.id || id();
      const report = validateDeck(d, s.sources);
      if (report.errors.length) throw new Error(report.errors.join("\n"));
      d.quality = report;
      d.createdAt = new Date().toISOString();
      const old = s.drafts.findIndex((x) => x.id === d.id);
      if (
        old >= 0 &&
        (d.draftVersion || 0) !== (s.drafts[old].draftVersion || 0)
      )
        throw new Error(
          "Draft changed in another window; reopen it before saving",
        );
      if (old >= 0) {
        d.editingDeckId = s.drafts[old].editingDeckId;
        d.baseVersion = s.drafts[old].baseVersion;
      } else if (d.editingDeckId)
        throw new Error("Use deck.edit to create an editing draft");
      d.draftVersion = (d.draftVersion || 0) + 1;
      if (old >= 0) s.drafts[old] = d;
      else s.drafts.push(d);
      return d;

    },
    "draft.delete": (s, a) => {

      if (
        a.draftVersion !== undefined &&
        s.drafts.some(
          (d) => d.id === a.id && d.draftVersion !== a.draftVersion,
        )
      )
        throw new Error(
          "Draft changed in another window; reopen it before deleting",
        );
      s.drafts = s.drafts.filter((d) => d.id !== a.id);
      return { ok: true };
    },
    "draft.publish": (s, a) => {
      const draft = get(s.drafts, a.id, "Draft"),
        report = validateDeck(draft, s.sources);
      if (
        a.draftVersion !== undefined &&
        draft.draftVersion !== a.draftVersion
      )
        throw new Error(
          "Draft changed in another window; review it before publishing",
        );
      if (report.errors.length) throw new Error(report.errors.join("\n"));
      if (draft.editingDeckId) {
        const live = get(s.decks, draft.editingDeckId, "Deck");
        if ((live.contentVersion || 0) !== draft.baseVersion)
          throw new Error("Deck changed; reopen an editing draft");
        if (s.runs.some((r) => runTouches(r, live.id) && runOpen(r)))
          throw new Error(
            "Finish or end active reviews before applying deck edits",
          );
        const updated = structuredClone(draft);
        updated.cards.forEach((q) => {
          const previous = live.cards.find((c) => c.id === q.id);
          q.review =
            previous && contentKey(previous) === contentKey(q)
              ? previous.review
              : initialReview(s.settings);
          q.flag = previous?.flag || "";
          q.requires = previous ? previous.requires || [] : q.requires || [];
          if (previous?.revisions) q.revisions = previous.revisions;
          q.suspended = previous?.suspended || false;
        });
        delete updated.editingDeckId;
        delete updated.baseVersion;
        delete updated.draftVersion;
        Object.assign(live, updated, {
          id: live.id,
          archived: live.archived,
          contentVersion: (live.contentVersion || 0) + 1,
        });
        s.drafts = s.drafts.filter((d) => d.id !== draft.id);
        return { id: live.id };
      }
      if (s.decks.some((d) => d.id === draft.id))
        throw new Error("Deck already exists; publish a new deck id");
      const published = structuredClone(draft);
      published.cards.forEach((q) => {
        q.review = initialReview(s.settings);
      });
      s.decks.push(published);
      s.drafts = s.drafts.filter((d) => d.id !== a.id);
      return { id: draft.id };

    },
    "review.start": (s, a) => {
      if (
        !["quiz", "flashcard", "due", "wrong", "new", "path", "exam"].includes(
          a.mode,
        )
      )
        throw new Error("Unknown review mode");
      const scope =
        a.mode === "path" || a.mode === "exam"
          ? checkScope(s, a.scope)
          : [{ deckId: get(s.decks, a.deckId, "Deck").id }];
      const key = scopeKey(a.mode, scope),
        open = s.runs.filter((r) => runOpen(r) && runKey(r) === key);
      if (open.length && a.fresh !== true && a.mode !== "exam") {
        const resumed = open.at(-1),
          closedAt = new Date().toISOString();
        for (const r of open.slice(0, -1)) r.closedAt = closedAt;
        return projection(s, resumed);
      }
      let picked;
      if (a.mode === "path") {
        if (scope.some((x) => get(s.decks, x.deckId, "Deck").archived))
          throw new Error("Restore this archived deck before studying");
        picked = planPath(s.decks, latestOutcomes(s.attempts), {
          scope,
        }).entries.map((x) => ({ deckId: x.deckId, card: x.card }));
      } else if (a.mode === "exam") {
        const count = Number(a.count ?? 10);
        if (!Number.isInteger(count) || count < 1 || count > 50)
          throw new Error("Choose 1–50 exam questions");
        const pool = [];
        for (const deck of s.decks) {
          if (deck.archived) continue;
          for (const card of deck.cards) {
            if (card.suspended) continue;
            if (!["quiz", "multi"].includes(card.kind)) continue;
            if (
              scope.length &&
              !scope.some(
                (x) =>
                  x.deckId === deck.id &&
                  (x.cardId ? x.cardId === card.id : !x.topic || x.topic === (card.topic || "未分类")),
              )
            )
              continue;
            pool.push({ deckId: deck.id, card });
          }
        }
        if (scope.some((x) => get(s.decks, x.deckId, "Deck").archived))
          throw new Error("Restore this archived deck before the exam");
        picked = shuffled(pool).slice(0, Math.min(count, pool.length));
      } else {
        const deck = get(s.decks, a.deckId, "Deck");
        if (deck.archived)
          throw new Error("Restore this archived deck before studying");
        let cards = deck.cards.filter((q) => !q.suspended);
        if (a.mode === "new") {
          const outcome = latestOutcomes(s.attempts);
          cards = cards.filter((q) => cardLevel(q, outcome(deck.id, q.id)) === "new");
        }
        if (a.mode === "wrong") {
          const outcome = latestOutcomes(s.attempts);
          cards = cards.filter((q) => outcome(deck.id, q.id) < 3);
        }
        if (a.mode === "quiz")
          cards = cards.filter((q) => q.kind !== "flashcard");
        if (a.mode === "due")
          cards = cards.filter(
            (q) =>
              !q.review?.due_at ||
              Date.parse(q.review.due_at) <= Date.now(),
          );
        picked = shuffled(cards)
          .sort((x, y) => Number(!!y.flag) - Number(!!x.flag))
          .map((card) => ({ deckId: deck.id, card }));
      }
      if (!picked.length)
        throw new Error("No questions available for this mode");
      for (const r of open) r.closedAt = new Date().toISOString();
      const run = {
        id: id(),
        deckId: new Set(picked.map((x) => x.deckId)).size === 1
          ? picked[0].deckId
          : null,
        mode: a.mode,
        scope,
        key,
        ...(typeof a.returnTo === "string" && s.runs.some((r) => r.id === a.returnTo)
          ? { returnTo: a.returnTo }
          : {}),
        index: 0,
        startedAt: new Date().toISOString(),
        entries: picked.map(({ deckId, card }) => ({
          deckId,
          card: structuredClone(card),
          order: card.options
            ? shuffled(card.options.map((o) => o.id))
            : undefined,
          startedAt: Date.now(),
          feedback: null,
          revealed: false,
          selected: null,
        })),
      };
      s.runs.push(run);
      return projection(s, run);

    },
    "review.end": (s, a) => {
      const run = get(s.runs, a.runId, "Review");
      run.closedAt = run.closedAt || new Date().toISOString();
      return projection(s, run);

    },
    "review.reveal": (s, a) => {
      const run = get(s.runs, a.runId, "Review"),
        entry = run.entries[run.index];
      if (run.closedAt) throw new Error("Review has ended");
      if (a.queueVersion !== undefined && a.queueVersion !== (run.queueVersion || 0))
        throw new Error("Question changed; refresh review before revealing");
      if (run.mode === "exam")
        throw new Error("Submit the exam before reviewing answers");
      if (!entry || entry.card.id !== a.cardId)
        throw new Error("Question changed; refresh review");
      if (
        run.mode !== "flashcard" &&
        ["quiz", "multi", "cloze"].includes(entry.card.kind) &&
        !entry.feedback
      )
        throw new Error("Submit an answer first");
      entry.revealed = true;
      return projection(s, run);

    },
    "review.answer": (s, a) => {
      const run = get(s.runs, a.runId, "Review"),
        entry = run.entries[run.index];
      if (run.closedAt) throw new Error("Review has ended");
      if (a.queueVersion !== undefined && a.queueVersion !== (run.queueVersion || 0))
        throw new Error("Question changed; refresh review before answering");
      if (!entry || entry.card.id !== a.cardId)
        throw new Error("Question changed; refresh review");
      if (run.mode === "exam") {
        // An exam answer is only recorded; grading happens on submit.
        // Clearing every option withdraws the recorded answer.
        if (!["quiz", "multi"].includes(entry.card.kind))
          throw new Error("Exam questions are single or multiple choice");
        const selected = Array.isArray(a.selected)
          ? [...new Set(a.selected)].sort()
          : [];
        if (
          selected.some((x) => !entry.card.options.some((o) => o.id === x)) ||
          (entry.card.kind === "quiz" && selected.length > 1)
        )
          throw new Error("Choose valid options");
        entry.selected = selected.length ? selected : null;
        return projection(s, run);
      }
      const choice =
        run.mode !== "flashcard" &&
        ["quiz", "multi"].includes(entry.card.kind);
      const cloze = run.mode !== "flashcard" && entry.card.kind === "cloze";
      const selected = Array.isArray(a.selected)
        ? [...new Set(a.selected)].sort()
        : [];
      const signature = JSON.stringify(
        choice ? selected : cloze ? a.answers : a.grade,
      );
      if (entry.feedback) {
        if (entry.signature !== signature)
          throw new Error(
            "Question already answered with different response",
          );
        return projection(s, run);
      }
      let correct, grade, details;
      if (choice) {
        if (
          !selected.length ||
          selected.some(
            (x) => !entry.card.options.some((o) => o.id === x),
          ) ||
          (entry.card.kind === "quiz" && selected.length !== 1)
        )
          throw new Error("Choose valid options");
        correct =
          JSON.stringify(
            entry.card.options
              .filter((o) => o.correct)
              .map((o) => o.id)
              .sort(),
          ) === JSON.stringify(selected);
        grade = correct ? 4 : 1;
      } else if (cloze) {
        const verdict = gradeCloze(entry.card, a.answers || {});
        correct = verdict.correct;
        grade = correct ? 4 : 1;
        details = verdict.details;
      } else {
        if (!entry.revealed)
          throw new Error("Reveal the answer before grading");
        grade = a.grade;
        if (!Number.isInteger(grade) || grade < 0 || grade > 5)
          throw new Error("Grade must be an integer from 0 to 5");
        correct = grade >= 3;
      }
      const deckId = entry.deckId ?? run.deckId;
      const live = get(
        get(s.decks, deckId, "Deck").cards,
        entry.card.id,
        "Question",
      );
      const before = live.review ?? initialReview(s.settings),
        timestamp = new Date().toISOString(),
        after = entry.retry ? before : schedule(before, grade, timestamp, s.settings);
      live.review = after;
      entry.revealed = true;
      entry.signature = signature;
      entry.contentUpdated = false;
      entry.feedback = {
        correct,
        grade,
        selected,
        nextDue: after.due_at,
        ...(details ? { details } : {}),
        ...(cloze ? { answers: Object.fromEntries(entry.card.cloze.answers.map(({ id }) =>
          [id, typeof a.answers?.[id] === "string" ? a.answers[id] : ""])) } : {}),
      };
      // One extra recall attempt per card, at the tail of this run. It is
      // practice after feedback, not a second spaced repetition interval.
      if (grade <= 1 && !entry.retry && !run.entries.some((e) => e.retry && e.card.id === entry.card.id && (e.deckId ?? run.deckId) === deckId)) {
        run.entries.push({
          deckId,
          card: structuredClone(live),
          // Reshuffle so the retry tests recall, not the remembered position.
          order: entry.order ? shuffled(entry.order) : undefined,
          startedAt: Date.now(),
          feedback: null,
          revealed: false,
          selected: null,
          retry: true,
        });
        entry.feedback.retryQueued = true;
      }
      s.attempts.push({
        id: id(),
        runId: run.id,
        quiz_id: live.id,
        deckId,
        topic: live.topic,
        timestamp,
        grade,
        elapsed_ms: Math.max(0, Date.now() - entry.startedAt),
        retry: !!entry.retry,
        before,
        after,
      });
      entry.feedback.credited = correct && !entry.retry
        ? creditPrerequisites(s, { deckId, cardId: live.id }, run.id, timestamp)
        : 0;
      return projection(s, run);

    },
    "review.move": (s, a) => {
      const run = get(s.runs, a.runId, "Review");
      if (run.closedAt) throw new Error("Review has ended");
      if (a.index !== undefined) {
        if (!Number.isInteger(a.index) || a.index < 0 || a.index >= run.entries.length)
          throw new Error("Invalid question index");
        run.index = a.index;
        if (!run.entries[run.index].feedback) run.entries[run.index].startedAt = Date.now();
        return projection(s, run);
      }
      if (![-1, 1].includes(a.direction))
        throw new Error("Invalid direction");
      if (
        a.direction === 1 &&
        run.mode !== "exam" &&
        !run.entries[run.index]?.feedback
      )
        throw new Error("Answer this question before continuing");
      run.index = Math.max(
        0,
        Math.min(run.entries.length, run.index + a.direction),
      );
      if (run.index === run.entries.length && run.mode !== "exam") {
        const unanswered = run.entries.findIndex((e) => !e.feedback);
        if (unanswered !== -1) run.index = unanswered;
      }
      if (run.entries[run.index] && !run.entries[run.index].feedback)
        run.entries[run.index].startedAt = Date.now();
      return projection(s, run);

    },
    "exam.submit": (s, a) => {
      const run = get(s.runs, a.runId, "Review");
      if (run.mode !== "exam") throw new Error("Not an exam run");
      if (run.closedAt) throw new Error("Exam already submitted");
      const timestamp = new Date().toISOString();
      let answered = 0,
        correct = 0;
      const byTopic = new Map(),
        byDeck = new Map(),
        wrong = [];
      const bump = (map, key, label, ok) => {
        const row =
          map.get(key) || { ...label, correct: 0, total: 0 };
        row.total++;
        if (ok) row.correct++;
        map.set(key, row);
      };
      for (const entry of run.entries) {
        const deckId = entry.deckId ?? run.deckId,
          deck = get(s.decks, deckId, "Deck"),
          topic = entry.card.topic || "未分类";
        if (entry.selected == null) {
          bump(byTopic, JSON.stringify([deckId, topic]), { topic }, false);
          bump(byDeck, deckId, { deckId, title: deck.title }, false);
          continue;
        }
        const selected = [...new Set(entry.selected)].sort();
        const ok =
          JSON.stringify(
            entry.card.options
              .filter((o) => o.correct)
              .map((o) => o.id)
              .sort(),
          ) === JSON.stringify(selected);
        const grade = ok ? 4 : 1,
          live = get(deck.cards, entry.card.id, "Question"),
          before = live.review ?? initialReview(s.settings),
          after = schedule(before, grade, timestamp, s.settings);
        live.review = after;
        entry.revealed = true;
        entry.feedback = {
          correct: ok,
          grade,
          selected,
          nextDue: after.due_at,
        };
        s.attempts.push({
          id: id(),
          runId: run.id,
          quiz_id: live.id,
          deckId,
          topic: live.topic,
          timestamp,
          grade,
          elapsed_ms: Math.max(0, Date.now() - entry.startedAt),
          before,
          after,
        });
        answered++;
        if (ok) correct++;
        else
          wrong.push({
            deckId,
            cardId: entry.card.id,
            topic,
            prompt: entry.card.prompt,
            kind: entry.card.kind,
          });
        bump(byTopic, JSON.stringify([deckId, topic]), { topic }, ok);
        bump(byDeck, deckId, { deckId, title: deck.title }, ok);
      }
      run.closedAt = timestamp;
      const total = run.entries.length;
      return {
        runId: run.id,
        total,
        answered,
        unanswered: total - answered,
        correct,
        scorePct: total ? Math.round((correct / total) * 100) : 0,
        durationMs: Math.max(0, Date.parse(timestamp) - Date.parse(run.startedAt)),
        byTopic: [...byTopic.values()],
        byDeck: [...byDeck.values()],
        wrong,
        weakScope: wrong.map((w) => ({ deckId: w.deckId, cardId: w.cardId })),
      };

    },
    "card.flag": (s, a) => {
      const card = get(
        get(s.decks, a.deckId, "Deck").cards,
        a.cardId,
        "Question",
      );
      card.flag =
        typeof a.reason === "string" ? a.reason.slice(0, 1000) : "";
      return { ok: true };

    },
    "card.suspend": (s, a) => {
      if (isSlayDeck(get(s.decks, a.deckId, "Deck"))) throw new Error("请使用恢复原题组功能");
      const card = get(
        get(s.decks, a.deckId, "Deck").cards,
        a.cardId,
        "Question",
      );
      card.suspended = a.suspended === true;
      return { ok: true };

    },
};

/* Reads come from the shared library cache and commits keep their state as
   the new cache, so results can alias it. Callers own what they get back. */
const detach = (value) => (value && typeof value === "object" ? structuredClone(value) : value);

export class StudyService {
  /**
   * @param complete - full model route used by generation and teaching.
   * @param completeLight - same model with reasoning off/low for 陪学 calls.
   * @param coach - enable background coach work (nudge prefetch, prep batches).
   */
  constructor(root, { complete, completeLight, coach = false } = {}) {
    this.store = new Store(root);
    this.complete = complete;
    // Never forward coach options as a generation `execution` argument.
    this.light = completeLight || (complete && ((system, prompt) => complete(system, prompt)));
    this.coach = !!coach;
  }
  async call(action, a = {}) {
    if (!a || typeof a !== "object" || Array.isArray(a))
      throw new Error("Arguments must be an object");
    if (action === "draft.publish" && [...jobs.values()].some((job) => job.root === this.store.root && job.draftId === a.id && activeJob(job)))
      throw new Error("Generation is still updating this draft; wait until it finishes before publishing");
    const mutation = Object.hasOwn(MUTATIONS, action) ? MUTATIONS[action] : null;
    if (mutation) {
      const result = await this.store.update((s) => mutation(s, a));
      if (action === "review.answer") this.afterAnswer(result);
      return detach(result);
    }
    const handler = Object.hasOwn(HANDLERS, action) ? HANDLERS[action] : null;
    if (!handler) throw new Error("Unknown study action");
    return detach(await handler.call(this, a));
  }
  /** A wrong practice answer starts its 陪学 point and queues a variant target. */
  afterAnswer(run) {
    if (!this.coach || !this.light || run?.mode === "exam" || !run?.feedback || run.feedback.grade >= 3) return;
    this.nudgeFor(run.id, run.index).catch(() => {});
    if (run.card) this.queuePrep({ deckId: run.deckId, cardId: run.card.id, reason: "wrong" });
  }
  async nudgeFor(runId, index) {
    const root = this.store.root,
      s = await this.store.read(),
      run = get(s.runs, runId, "Review"),
      at = Number.isInteger(index) ? index : run.index,
      entry = run.entries[at];
    if (!entry?.feedback || entry.feedback.grade >= 3 || run.mode === "exam")
      throw new Error("答错后才会给出陪学点");
    const cardId = entry.card.id,
      deckId = entry.deckId ?? run.deckId;
    ensureLearner(s);
    const same = (n) => n.type === "nudge" && n.runId === runId && n.entryIndex === at;
    if (s.coach.some(same)) return { thread: threadView(s, cardId) };
    const key = `${root}\0${runId}\0${at}`;
    if (!coachInflight.has(key))
      coachInflight.set(key, (async () => {
        const picked = entry.feedback.selected?.map((x) => entry.card.options?.find((o) => o.id === x)?.text).filter(Boolean) ||
          (entry.feedback.answers ? Object.values(entry.feedback.answers) : undefined);
        const nudge = await writeNudge(this.light, {
          card: entry.card,
          picked,
          grade: ["flashcard", "open"].includes(entry.card.kind) || run.mode === "flashcard" ? entry.feedback.grade : undefined,
          earlier: s.coach.filter((n) => n.cardId === cardId && n.point).map((n) => n.point).slice(-3),
          learner: s.learner,
        });
        return this.store.update((st) => {
          ensureLearner(st);
          if (!st.coach.some(same))
            st.coach.push({ id: id(), type: "nudge", runId, entryIndex: at, deckId, cardId, ...nudge, createdAt: new Date().toISOString() });
          trimLogs(st);
          return { thread: threadView(st, cardId) };
        });
      })().finally(() => coachInflight.delete(key)));
    return coachInflight.get(key);
  }
  /** Background coach work for one library runs one task at a time. */
  coachTask(kind, label, meta, work) {
    const root = this.store.root,
      list = coachTasks.get(root) || [];
    const task = { id: id(), kind, label, status: "running", startedAt: new Date().toISOString(), ...meta };
    list.push(task);
    coachTasks.set(root, list.slice(-20));
    // Rewrites the learner asked for never wait behind a background prep batch.
    const lane = `${root}:${kind === "rewrite" ? "rewrite" : "prep"}`;
    const previous = coachQueues.get(lane) || Promise.resolve();
    const next = previous.catch(() => {}).then(work).then(
      (message) => Object.assign(task, { status: "done", message: message || "", finishedAt: new Date().toISOString() }),
      (e) => Object.assign(task, { status: "failed", message: String(e?.message || e).slice(0, 200), finishedAt: new Date().toISOString() }),
    );
    coachQueues.set(lane, next);
    return next;
  }
  /** Settles when both coach lanes of this library are idle. */
  coachIdle() {
    const root = this.store.root;
    return Promise.all([`${root}:rewrite`, `${root}:prep`].map((lane) => (coachQueues.get(lane) || Promise.resolve()).catch(() => {})));
  }
  queuePrep(target) {
    if (!this.coach || !this.light) return;
    const root = this.store.root,
      pending = prepPending.get(root) || { targets: [], timer: null, service: this };
    pending.service = this;
    if (!pending.targets.some((t) => t.cardId === target.cardId && t.reason === target.reason)) pending.targets.push(target);
    prepPending.set(root, pending);
    if (pending.targets.length >= 3) this.flushPrep();
    else if (!pending.timer) {
      pending.timer = setTimeout(() => pending.service.flushPrep(), PREP_DELAY_MS);
      pending.timer.unref?.();
    }
  }
  /** Write every pending variant target in batches of up to four. */
  flushPrep() {
    const root = this.store.root,
      pending = prepPending.get(root);
    if (!pending?.targets.length) return this.coachIdle();
    clearTimeout(pending.timer);
    prepPending.delete(root);
    for (let i = 0; i < pending.targets.length; i += 4) {
      const batch = pending.targets.slice(i, i + 4);
      this.coachTask("prep", `准备 ${batch.length} 道定制题`, {}, () => this.writePrepared(batch));
    }
    return this.coachIdle();
  }
  async writePrepared(batch) {
    const s = await this.store.read(),
      learner = ensureLearner(s);
    if (learner.consent.prep !== true) return "未开启备题";
    const ready = s.prepared.filter((p) => p.status === "ready");
    if (ready.length >= MAX_READY) return "定制题已经备满";
    const targets = [];
    for (const t of batch) {
      let found;
      try {
        found = findCard(s, t);
      } catch {
        continue;
      }
      if (isSlayDeck(found.deck) || ready.some((p) => p.originCardId === found.card.id && p.reason === t.reason)) continue;
      targets.push({
        ...t,
        deckId: found.deck.id,
        card: found.card,
        kind: t.reason === "too-hard" ? "flashcard" : found.card.kind === "multi" ? "multi" : "quiz",
      });
    }
    if (!targets.length) return "没有需要准备的题";
    const cited = new Set(targets.flatMap((t) => t.card.citations?.map((c) => c.sourceId) || []));
    const results = await writeVariants(this.light, {
      targets: targets.slice(0, MAX_READY - ready.length),
      sources: s.sources.filter((x) => cited.has(x.id)),
      learner,
      existingPrompts: [...s.decks.flatMap((d) => d.cards.map((c) => c.prompt)), ...s.prepared.map((p) => p.card.prompt)],
    });
    if (!results.length) return "这批变式没有通过校验，已跳过";
    await this.store.update((st) => {
      ensureLearner(st);
      for (const { target, card } of results)
        st.prepared.push({
          id: id(),
          card,
          originDeckId: target.deckId,
          originCardId: target.card.id,
          reason: target.reason,
          level: target.reason === "too-hard" ? "concept" : "apply",
          status: "ready",
          createdAt: new Date().toISOString(),
        });
      trimLogs(st);
    });
    return `备好 ${results.length} 道定制题`;
  }
  scheduleRewrite(ref, tags) {
    return this.coachTask("rewrite", `按「${tags.map((t) => FEEDBACK_TAGS[t]).join("、")}」改题`, { cardId: ref.cardId }, async () => {
      const s = await this.store.read(),
        learner = ensureLearner(s),
        { deck, card } = findCard(s, ref),
        evidence = evidenceWindows(s.sources, [card]);
      let { patch, summary } = await writeRewrite(this.light, { card, tags, evidence, learner });
      const apply = (p) => this.store.update((st) => {
        ensureLearner(st);
        const note = { id: id(), type: "update", deckId: deck.id, cardId: card.id, tags, createdAt: new Date().toISOString() };
        if (!Object.keys(p).length) note.text = summary.startsWith("核对") ? summary : `核对后未改动：${summary}`;
        else {
          applyCardContent(st, ref, patchContent(findCard(st, ref).card, p), `陪学按反馈修改：${tags.map((t) => FEEDBACK_TAGS[t]).join("、")}`, { keepAnswered: true });
          Object.assign(note, { text: summary, revertable: true });
        }
        st.coach.push(note);
        trimLogs(st);
      });
      try {
        await apply(patch);
      } catch (e) {
        // One corrective round: the learner explicitly asked for this fix.
        ({ patch, summary } = await writeRewrite(this.light, { card, tags, evidence, learner, errors: e.message }));
        await apply(patch);
      }
      return summary;
    });
  }
  async debrief(a) {
    const s = await this.store.read(),
      run = get(s.runs, a.runId, "Review"),
      learner = ensureLearner(s);
    if (run.mode === "exam") throw new Error("模拟考试请看成绩单");
    const metrics = runMetrics(s, run),
      withStatus = (d) => ({ ...d, status: this.coachStatus(s) });
    if (run.debrief?.answered === metrics.answered) return withStatus(run.debrief);
    const ready = s.prepared.filter((p) => p.status === "ready").length;
    const rules = debriefRules(metrics, { ready, consent: learner.consent.prep, modelReady: this.coach && !!this.light });
    if (rules.wantsPrep) {
      // Concept-only sessions get application variants of cards they got right.
      const seen = new Set();
      for (const e of run.entries)
        if (e.feedback?.grade >= 3 && !e.retry && cognitiveLevel(e.card, learner.levels[e.card.id]) !== "apply" && !seen.has(e.card.topic) && seen.size < 4) {
          seen.add(e.card.topic);
          this.queuePrep({ deckId: e.deckId ?? run.deckId, cardId: e.card.id, reason: "application-gap" });
        }
      this.flushPrep();
    }
    let model = null;
    if (this.coach && this.light && metrics.answered >= 3)
      try {
        model = await writeDebrief(this.light, { metrics, rules, learner });
      } catch {
        model = null;
      }
    const debrief = {
      answered: metrics.answered,
      metrics,
      insights: rules.insights,
      headline: model?.headline || rules.headline,
      why: model?.why || rules.why,
      next: ready ? "practice_prepared" : model?.next && model.next !== "practice_prepared" ? model.next : rules.next,
      preparing: rules.wantsPrep,
      at: new Date().toISOString(),
    };
    await this.store.update((st) => {
      const l = ensureLearner(st),
        r = st.runs.find((x) => x.id === run.id);
      if (r) r.debrief = debrief;
      if (model?.summary) {
        l.summary = model.summary;
        l.updatedAt = debrief.at;
      }
    });
    return withStatus(debrief);
  }
  /** Coach state that lives in memory rather than in the library file. */
  coachActivity() {
    const root = this.store.root;
    return [(coachTasks.get(root) || []).slice(-5).map((t) => [t.id, t.status]), prepPending.get(root)?.targets.length || 0];
  }
  coachStatus(s) {
    const learner = ensureLearner(s),
      root = this.store.root,
      tasks = coachTasks.get(root) || [];
    return {
      enabled: this.coach && !!this.light,
      consent: learner.consent.prep,
      goal: learner.goal,
      ready: s.prepared.filter((p) => p.status === "ready").length,
      preparing: tasks.some((t) => t.kind === "prep" && t.status === "running") || !!prepPending.get(root)?.targets.length,
      tasks: tasks.slice(-5).map(({ id, kind, label, status, message, cardId, finishedAt }) => ({ id, kind, label, status, message, cardId, finishedAt })),
    };
  }
}
