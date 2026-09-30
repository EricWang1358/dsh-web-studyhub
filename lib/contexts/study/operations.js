import { get, id } from "../../util.js";
import { currentCourse, freshCardsForDecks } from "../../focus.js";
import { learningScope, learningState } from "../../learning-scope.js";
import { scopeKey, planPath, latestOutcomes, cardLevel } from "../../mastery.js";
import { shuffled, gradeCloze, initialReview, schedule } from "../../domain.js";
import { examExpired } from "../../exam-timing.js";
import { staleReviewEntries, projection, syncReviewEntry, submittedExam, examReport, startCourseRun, runOpen, runKey, roleExamQuestions, substance, creditPrerequisites } from "../../legacy-kernel.js";

export const handlers = {
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
"exam.report": async function (a) {
      const s = await this.store.read(), run = get(s.runs, a.runId, "Exam");
      if (!submittedExam(run)) throw new Error("这场考试尚未交卷，无法查看报告");
      return examReport(s, run);
    }
};
export const mutations = {
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

    }
};
