import { currentCourse, freshCardsForDecks, setFocus } from "../../focus.js";
import { parseJson } from "../../generation.js";
import { get, id, required } from "../../util.js";
import { findCard, prerequisiteView } from "../../prereq.js";
import { notify } from "../../inbox.js";
import { latestOutcomes, scopeKey, planPath, cardLevel } from "../../mastery.js";
import { translateSource, translateCard } from "../../translation.js";

import { slayCard, restoreSlainCard, isSlayDeck } from "../../slay.js";
import { initialReview, shuffled, gradeCloze, schedule } from "../../domain.js";
import { learningScope, learningState } from "../../learning-scope.js";
import { examExpired } from "../../exam-timing.js";
import { getTeaching, startTeaching, answerTeaching } from "../../teaching.js";
import { substance, applyCardContent, patchContent, syncReviewEntry } from '../../card-content.js';
import { roleExamQuestions, examReport, submittedExam, startCourseRun, projection, staleReviewEntries, currentCard, creditPrerequisites, runOpen, runKey, runTouches } from '../../study-state.js';


/** study operations close over only the ports declared by this context. */
export function createOperations(ports) {
  const { state: storagePort, call: providedCall, light: providedLight, complete: providedComplete } = ports;
  const { translateInflight } = ports.work;
const handlers = {
"card.update.batch": async function (a) {
      const updates = Array.isArray(a.updates) ? a.updates : [];
      if (!updates.length || updates.length > 100) throw new Error("updates 需要 1–100 项 {cardId, deckId?, patch, reason}");
      const results = [];
      for (const [index, item] of updates.entries()) {
        try {
          if (!item || typeof item !== "object") throw new Error("每一项必须是对象");
          const updated = await providedCall("card.update", { ...item, quiet: true });
          results.push({ index, cardId: updated.cardId, deckId: updated.deckId, ok: true, scheduleReset: !!updated.scheduleReset });
        } catch (error) {
          results.push({ index, cardId: item?.cardId, ok: false, error: error.message });
        }
      }
      const done = results.filter((r) => r.ok);
      if (done.length) await storagePort.update((s) => {
        const { deck, card } = findCard(s, updates[done[0].index]);
        notify(s, { kind: "improve", deckId: deck.id, cardId: card.id,
          detail: done.length > 1 ? `对话批量改进了 ${done.length} 道题` : String(updates[done[0].index].reason || "对话改进了题目").slice(0, 500) });
      });
      return { updated: done.length, failed: results.length - done.length, results };
    },
"card.get": async function (a) {
      const s = await storagePort.read(),
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

      return providedCall("card.get", currentCard(await storagePort.read()));
    },
"card.translate": async function (a) {
      const s = await storagePort.read();
      const { deck, card } = findCard(s, a);
      const { digest } = translateSource(card);
      if (card.translation && card.translation.digest === digest)
        return { deckId: deck.id, cardId: card.id, cached: true, translation: card.translation };
      if (!providedLight) throw new Error("翻译这道题需要可用的模型");
      const key = JSON.stringify([storagePort.root, card.id, digest]);
      if (!translateInflight.has(key))
        translateInflight.set(
          key,
          translateCard(providedLight, card)
            .then(({ translation }) =>
              storagePort.update((st) => {
                const live = findCard(st, a).card;
                if (translateSource(live).digest !== digest) throw new Error("题目已更新，请重新翻译");
                // Re-check under the lock: a parallel call may have saved it already.
                if (!live.translation || live.translation.digest !== digest)
                  live.translation = { lang: "en", at: new Date().toISOString(), digest, ...translation };
                return true;
              }),
            )
            .finally(() => translateInflight.delete(key)),
        );
      await translateInflight.get(key);
      const latest = findCard(await storagePort.read(), a).card;
      return { deckId: deck.id, cardId: card.id, cached: false, translation: latest.translation || null };
    },
"card.locate": async function (a) {
      const { deck, card } = findCard(await storagePort.read(), a);
      return { deck: { id: deck.id, title: deck.title, folder: deck.folder || "" }, card };
    },
"review.get": async function (a) {
      const s = await storagePort.read();
      const run = get(s.runs, a.runId, "Review");
      if (!staleReviewEntries(s, run).length) return projection(s, run);
      return storagePort.update((latest) => {
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
"exam.report": async function (a) {
      const s = await storagePort.read(), run = get(s.runs, a.runId, "Exam");
      if (!submittedExam(run)) throw new Error("这场考试尚未交卷，无法查看报告");
      return examReport(s, run);
    },
"focus.suggest": async function (a) {
      const state = await storagePort.read();
      const role = required(a.role || state.focus?.role, "岗位方向").slice(0, 200);
      const jd = typeof a.jd === "string" ? a.jd.slice(0, 20000) : state.focus?.jd || "";
      const topics = [...new Set(state.decks.flatMap((deck) => deck.cards.map((card) => card.topic)).filter(Boolean))].slice(0, 250);
      const model = providedLight || providedComplete;
      if (!model) return { role, jd, targetTopics: [], method: "rules" };
      try {
        const response = parseJson(await model("Given a target job and optional job description, choose up to 20 relevant knowledge topic names from the provided existing list. Return JSON {role:string,targetTopics:string[]}. Do not invent topic names or alter study cards.",
          JSON.stringify({ role, jd, availableTopics: topics })));
        const selected = Array.isArray(response.targetTopics) ? response.targetTopics
          .filter((topic) => topics.includes(topic)).slice(0, 20) : [];
        return { role: typeof response.role === "string" ? response.role.slice(0, 200) : role,
          jd, targetTopics: selected, method: "ai" };
      } catch { return { role, jd, targetTopics: [], method: "rules" }; }
    },
"teach.get": async function (a) {
      return getTeaching(await storagePort.read(), a);
    },
"teach.start": async function (a) {
      return startTeaching(storagePort, providedComplete, a);
    },
"teach.answer": async function (a) {
      return answerTeaching(storagePort, providedComplete, a);
    }
};
const mutations = {
"card.slay": (s, a) => {
      const result = slayCard(s, a);
      return a.runId ? projection(s, get(s.runs, a.runId, "Review")) : result;
    },
"card.restore": (s, a) => restoreSlainCard(s, a),
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
      const result = applyCardContent(s, a, content, reason);
      // Only the conversation calls card.update; the learner may have moved on.
      const { deck: updatedDeck, card: updated } = findCard(s, a);
      // A batch sends one letter for the whole set instead of one per card.
      if (!a.quiet) notify(s, { kind: "improve", deckId: updatedDeck.id, cardId: updated.id, detail: reason });
      return result;

    },
"card.revert": (s, a) => {
      const { card } = findCard(s, a);
      const last = card.revisions?.at(-1);
      if (!last) throw new Error("This question has no earlier version");
      return { ...applyCardContent(s, a, last.content, null, { keepAnswered: true }), reverted: last.reason };

    },
"review.weak.start": (s, a, ports) => {
      const previous = get(s.runs, a.runId, "Review");
      const seen = new Set();
      const scope = previous.entries.flatMap((entry) => {
        if (entry.retry || !entry.feedback || entry.feedback.grade >= 3) return [];
        const deckId = entry.deckId ?? previous.deckId;
        const deck = s.decks.find((item) => item.id === deckId);
        const card = deck?.cards.find((item) => item.id === entry.card.id);
        const key = JSON.stringify([deckId, entry.card.id]);
        if (!deck || deck.archived || !card || card.suspended || seen.has(key)) return [];
        seen.add(key);
        return [{ deckId, cardId: card.id }];
      }).slice(0, 200);
      if (!scope.length) throw new Error("这一轮没有可重练的薄弱题");
      return ports.mutate("review.start", s, { mode: "path", scope, fresh: true });
    },
"review.start": (s, a, ports) => {
      if (a.mode === "course") return startCourseRun(s, a, ports);
      if (
        !["quiz", "flashcard", "due", "wrong", "new", "path", "exam"].includes(
          a.mode,
        )
      )
        throw new Error("Unknown review mode");
      const scopedMode = ['new', 'path', 'exam'].includes(a.mode);
      const scopeArgs = scopedMode && (a.scope !== undefined || a.course !== undefined || !a.deckId)
        ? { ...a, ...(a.currentCourse === true && a.scope === undefined && a.course === undefined ? { course: currentCourse(s) } : {}) }
        : { scope: [{ deckId: get(s.decks, a.deckId, 'Deck').id }] };
      const selection = learningScope(s, scopeArgs), scope = selection.scope;
      if (!selection.all && !scope.length) throw new Error('当前范围没有可用题目');
      const key = scopeKey(a.mode, scope),
        open = s.runs.filter((r) => !r.workflowSessionId && runOpen(r) && runKey(r) === key);
      if (open.length && a.fresh !== true && a.mode !== "exam") {
        const resumed = open.at(-1),
          closedAt = new Date().toISOString();
        for (const r of open.slice(0, -1)) r.closedAt = closedAt;
        return projection(s, resumed);
      }
      let picked, examKinds;
      if (a.mode === "new" && (a.currentCourse === true || a.scope !== undefined || a.course !== undefined || !a.deckId)) {
        const count = Number(a.count ?? 10);
        if (!Number.isInteger(count) || count < 1 || count > 100)
          throw new Error("请选择 1–100 道新题");
        const scopedDecks = learningState(s, scopeArgs).decks.filter(deck => !deck.archived && !deck.systemKind);
        const refs = freshCardsForDecks(s, scopedDecks, count);
        picked = refs.map((ref) => ({ deckId: ref.deckId,
          card: get(get(s.decks, ref.deckId, "Deck").cards, ref.cardId, "Question") }));
      } else if (a.mode === "path") {
        if (scope.some((x) => get(s.decks, x.deckId, "Deck").archived))
          throw new Error("Restore this archived deck before studying");
        picked = planPath(s.decks, latestOutcomes(s.attempts), {
          scope,
        }).entries.map((x) => ({ deckId: x.deckId, card: x.card }));
      } else if (a.mode === "exam") {
        const count = Number(a.count ?? 10);
        if (!Number.isInteger(count) || count < 1 || count > 50)
          throw new Error("Choose 1–50 exam questions");
        examKinds = a.examKinds || "all";
        if (!["all", "quiz", "multi", "balanced"].includes(examKinds))
          throw new Error("Choose all, quiz, multi or balanced exam questions");
        const pool = [];
        for (const deck of s.decks) {
          if (deck.archived) continue;
          for (const card of deck.cards) {
            if (card.suspended) continue;
            if (!["quiz", "multi"].includes(card.kind)) continue;
            if (["quiz", "multi"].includes(examKinds) && card.kind !== examKinds) continue;
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
        if (!pool.length) throw new Error("所选范围没有符合题型的选择题，请调整题组或题型");
        picked = roleExamQuestions(s, pool, Math.min(count, pool.length), examKinds === "balanced", a.scope === undefined && a.course === undefined && !a.deckId);
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
        picked = (a.mode === "new" && a.ordered ? cards : shuffled(cards))
          .sort((x, y) => Number(!!y.flag) - Number(!!x.flag))
          .map((card) => ({ deckId: deck.id, card }));
        if (a.mode === "new" && a.count !== undefined) {
          const count = Number(a.count);
          if (!Number.isInteger(count) || count < 1 || count > 100)
            throw new Error("Choose 1–100 new questions");
          picked = picked.slice(0, count);
        }
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
        ...(a.mode === "exam" ? { examKinds,
          examRole: s.focus?.mode === "interview" ? s.focus.role || "" : "",
          examTargetTopics: s.focus?.mode === "interview" && a.scope === undefined && a.course === undefined && !a.deckId ? s.focus.targetTopics || [] : [] } : {}),
        scope,
        key,
        ...(typeof a.returnTo === "string" && s.runs.some((r) => r.id === a.returnTo)
          ? { returnTo: a.returnTo }
          : {}),
        ...(a.purpose === "inbox" ? { purpose: "inbox" } : {}),
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
      if (entry.card.publicationUngrable)
        throw new Error("这道题缺少可判分内容，请跳过或点问题标记修题");
      if (run.mode === "exam") {
        if (examExpired(run)) throw new Error("考试时间已到，请交卷");
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
      const staleSnapshot = entry.keepSnapshot && substance(entry.card) !== substance(live),
        before = live.review ?? initialReview(s.settings),
        timestamp = new Date().toISOString(),
        after = entry.retry || staleSnapshot ? before : schedule(before, grade, timestamp, s.settings);
      live.review = after;
      entry.revealed = true;
      entry.signature = signature;
      entry.contentUpdated = false;
      entry.feedback = {
        correct,
        grade,
        selected,
        nextDue: after.due_at,
        ...(staleSnapshot ? { updatedAfterOpening: true } : {}),
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
        assessment: choice || cloze ? "graded" : "self",
        elapsed_ms: Math.max(0, Date.now() - entry.startedAt),
        retry: !!entry.retry,
        before,
        after,
        ...(staleSnapshot ? { updatedAfterOpening: true } : {}),
      });
      entry.feedback.credited = correct && !entry.retry && !staleSnapshot
        ? creditPrerequisites(s, { deckId, cardId: live.id }, run.id, timestamp)
        : 0;
      return projection(s, run);

    },
"review.move": (s, a) => {
      const run = get(s.runs, a.runId, "Review");
      if (run.closedAt) throw new Error("Review has ended");
      if (run.mode === "exam" && examExpired(run)) throw new Error("考试时间已到，请交卷");
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
"review.skip": (s, a) => {
      const run = get(s.runs, a.runId, "Review");
      const entry = run.entries[run.index];
      if (run.closedAt || run.mode === "exam") throw new Error("当前练习不能跳过此题");
      if (a.queueVersion !== undefined && a.queueVersion !== (run.queueVersion || 0))
        throw new Error("Question changed; refresh review");
      if (!entry || entry.card.id !== a.cardId || !entry.card.publicationUngrable)
        throw new Error("这道题无需跳过");
      run.entries.splice(run.index, 1);
      run.queueVersion = (run.queueVersion || 0) + 1;
      return projection(s, run);
    },
"exam.submit": (s, a) => {
      const run = get(s.runs, a.runId, "Review");
      if (run.mode !== "exam") throw new Error("Not an exam run");
      if (run.submittedAt) return examReport(s, run);
      if (run.closedAt) throw new Error("Exam has ended without submission");
      const timestamp = new Date().toISOString();
      for (const entry of run.entries) {
        const deckId = entry.deckId ?? run.deckId,
          deck = get(s.decks, deckId, "Deck");
        if (entry.selected == null) continue;
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
          assessment: "graded",
          elapsed_ms: Math.max(0, Date.now() - entry.startedAt),
          before,
          after,
        });
      }
      run.closedAt = timestamp;
      run.submittedAt = timestamp;
      return examReport(s, run);

    },
"focus.set": (s, a) => setFocus(s, a)
};
  return { handlers, mutations };
}
