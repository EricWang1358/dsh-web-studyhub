import { runTitle, runTitleInfo } from "./run-title.js";
import { decksInCourse, currentCourse } from "./focus.js";
import { learningState } from "./learning-scope.js";
import { COURSE_BATCH, courseBatch, courseRoute } from "./course-route.js";
import { id, get } from "./util.js";
import { teachingView } from "./teaching.js";
import { initialReview, schedule, shuffled, publicCard } from "./domain.js";
import { examLimitMs } from "./exam-timing.js";
import { findCard, prerequisiteView } from "./prereq.js";
import { currentFollowups } from "./followup.js";
import { cardLevel, latestOutcomes, scopeKey } from "./mastery.js";
import { cognitiveLevel, threadView } from "./coach.js";
import { answerKey, contentKey } from './card-content.js';
import { casePaperReport } from './case-study.js';
import { readingView } from './reading-return.js';
import { currentTranslation } from './translation-source.js';
import { QUESTION_COUNT, isQuestionCount } from './limits.js';

function balancedExamQuestions(pool, count, pastRuns = [], balanceKinds = false) {
  const lastSeen = new Map();
  for (const run of pastRuns.filter(submittedExam)) {
    const at = Date.parse(run.submittedAt || run.closedAt);
    if (!Number.isFinite(at)) continue;
    for (const entry of run.entries) {
      const key = JSON.stringify([entry.deckId ?? run.deckId, entry.card.id]);
      lastSeen.set(key, Math.max(lastSeen.get(key) ?? -Infinity, at));
    }
  }
  const seenAt = ({ deckId, card }) => lastSeen.get(JSON.stringify([deckId, card.id])) ?? -Infinity;
  const compare = (a, b) => seenAt(a) < seenAt(b) ? -1 : seenAt(a) > seenAt(b) ? 1 : 0;
  if (balanceKinds) {
    const availableQuiz = pool.filter((item) => item.card.kind === "quiz").length;
    const availableMulti = pool.length - availableQuiz;
    let quotaQuiz = Math.min(Math.ceil(count / 2), availableQuiz);
    let quotaMulti = Math.min(Math.floor(count / 2), availableMulti);
    let remaining = count - quotaQuiz - quotaMulti;
    const moreQuiz = Math.min(remaining, availableQuiz - quotaQuiz);
    quotaQuiz += moreQuiz;
    remaining -= moreQuiz;
    quotaMulti += remaining;
    const candidates = shuffled(pool), picked = [], topics = new Set();
    let pickedQuiz = 0, pickedMulti = 0;
    while (picked.length < count) {
      const eligible = candidates.filter((item) => item.card.kind === "quiz"
        ? pickedQuiz < quotaQuiz : pickedMulti < quotaMulti);
      eligible.sort((a, b) => {
        const topicA = JSON.stringify([a.deckId, a.card.topic || "未分类"]);
        const topicB = JSON.stringify([b.deckId, b.card.topic || "未分类"]);
        return Number(topics.has(topicA)) - Number(topics.has(topicB)) || compare(a, b);
      });
      const chosen = eligible[0];
      if (!chosen) break;
      picked.push(chosen);
      topics.add(JSON.stringify([chosen.deckId, chosen.card.topic || "未分类"]));
      if (chosen.card.kind === "quiz") pickedQuiz++;
      else pickedMulti++;
      candidates.splice(candidates.indexOf(chosen), 1);
    }
    return shuffled(picked);
  }
  const byTopic = new Map();
  for (const item of shuffled(pool)) {
    const key = JSON.stringify([item.deckId, item.card.topic || "未分类"]);
    if (!byTopic.has(key)) byTopic.set(key, []);
    byTopic.get(key).push(item);
  }
  const lanes = shuffled([...byTopic.values()]);
  for (const lane of lanes) lane.sort((a, b) => compare(b, a));
  lanes.sort((a, b) => compare(a.at(-1), b.at(-1)));
  const picked = [];
  while (picked.length < count && lanes.length) {
    for (let i = 0; i < lanes.length && picked.length < count;) {
      picked.push(lanes[i].pop());
      if (lanes[i].length) i++;
      else lanes.splice(i, 1);
    }
  }
  return picked;
}

function roleExamQuestions(state, pool, count, balanceKinds, useTargets) {
  const targets = useTargets && state.focus?.mode === "interview" ? new Set(state.focus.targetTopics || []) : new Set();
  const candidates = targets.size ? pool.filter(({ card }) => targets.has(card.topic || "未分类")) : pool;
  if (!candidates.length) throw new Error("所选题组没有目标岗位的知识点，请调整题组或岗位范围");
  const limit = Math.min(count, candidates.length);
  if (!targets.size || balanceKinds) return balancedExamQuestions(candidates, limit, state.runs, balanceKinds);
  const outcome = latestOutcomes(state.attempts);
  const weak = candidates.filter(({ deckId, card }) => {
    const grade = outcome(deckId, card.id);
    return grade !== undefined && grade < 3;
  });
  const bonus = balancedExamQuestions(weak, Math.min(Math.floor(limit / 4), weak.length), state.runs);
  const used = new Set(bonus.map(({ deckId, card }) => `${deckId}:${card.id}`));
  const covered = new Set(bonus.map(({ card }) => card.topic || "未分类"));
  const otherTopics = candidates.filter(({ deckId, card }) =>
    !used.has(`${deckId}:${card.id}`) && !covered.has(card.topic || "未分类"));
  const breadth = balancedExamQuestions(otherTopics, Math.min(limit - bonus.length, otherTopics.length), state.runs);
  for (const { deckId, card } of breadth) used.add(`${deckId}:${card.id}`);
  const left = limit - bonus.length - breadth.length;
  const fill = left > 0
    ? balancedExamQuestions(candidates.filter(({ deckId, card }) => !used.has(`${deckId}:${card.id}`)), left, state.runs)
    : [];
  return shuffled([...bonus, ...breadth, ...fill]);
}

function examScorePct(run, paper) {
  const earned = paper ? paper.total : run.entries.filter(entry => entry.feedback?.correct === true).length;
  const maximum = paper ? paper.max : run.entries.length;
  return maximum ? Math.round((earned / maximum) * 100) : 0;
}

function examReport(s, run) {
  const byTopic = new Map(), byDeck = new Map(), byKind = new Map(), wrong = [], skipped = [];
  const deckTitles = new Map(s.decks.map((deck) => [deck.id, deck.title]));
  const bump = (map, key, label, ok) => {
    const row = map.get(key) || { ...label, correct: 0, total: 0 };
    row.total++;
    if (ok) row.correct++;
    map.set(key, row);
  };
  let correct = 0;
  for (const entry of run.entries) {
    const deckId = entry.deckId ?? run.deckId;
    const deckTitle = deckTitles.get(deckId) || "已移除题组";
    const topic = entry.card.topic || "未分类";
    const ref = { deckId, cardId: entry.card.id, topic, prompt: entry.card.prompt, kind: entry.card.kind };
    const ok = entry.feedback?.correct === true;
    if (!entry.feedback) skipped.push(ref);
    else if (ok) correct++;
    else wrong.push(ref);
    bump(byTopic, JSON.stringify([deckId, topic]), { deckId, deckTitle, topic }, ok);
    bump(byDeck, deckId, { deckId, title: deckTitle }, ok);
    bump(byKind, entry.card.kind, { kind: entry.card.kind }, ok);
  }
  const total = run.entries.length;
  // A case paper (WP12) is scored in marks, question by question, as its answers are graded.
  const paper = run.examKinds === "case" ? casePaperReport(run, { title: deckTitles.get(run.paper?.deckId ?? run.deckId) || "" }) : null;
  const scorePct = examScorePct(run, paper);
  const quizCount = run.entries.filter((entry) => entry.card.kind === "quiz").length;
  const priorIndex = s.runs.indexOf(run);
  const previous = priorIndex < 0 || paper?.pending ? null : s.runs.slice(0, priorIndex).findLast((past) =>
    submittedExam(past) && runKey(past) === runKey(run) && past.entries.length === total &&
    (past.examKinds || "all") === (run.examKinds || "all") &&
    JSON.stringify(past.examTargetTopics || []) === JSON.stringify(run.examTargetTopics || []) &&
    past.entries.filter((entry) => entry.card.kind === "quiz").length === quizCount &&
    (!paper || casePaperReport(past).pending === 0));
  const previousScorePct = previous
    ? examScorePct(previous, paper ? casePaperReport(previous) : null)
    : null;
  return {
    runId: run.id, startedAt: run.startedAt, submittedAt: run.submittedAt || run.closedAt,
    examKinds: run.examKinds || "all", examRole: run.examRole || "",
    total, answered: total - skipped.length, unanswered: skipped.length, correct,
    scorePct,
    comparison: previous ? { runId: previous.id, scorePct: previousScorePct, deltaPct: scorePct - previousScorePct } : null,
    durationMs: run.paper ? Math.max(0, Date.parse(run.closedAt) - Date.parse(run.startedAt)) : Math.min(examLimitMs(run),
      Math.max(0, Date.parse(run.closedAt) - Date.parse(run.startedAt))),
    ...(paper ? { case: paper } : {}),
    byTopic: [...byTopic.values()], byDeck: [...byDeck.values()], byKind: [...byKind.values()], wrong, skipped,
    weakScope: [...wrong, ...skipped].map(({ deckId, cardId }) => ({ deckId, cardId })),
  };
}

const submittedExam = (run) => run.mode === "exam" && !!run.closedAt &&
  (!!run.submittedAt || run.entries.some((entry) => !!entry.feedback));

function courseProgress(s, course) {
  const route = courseRoute(s, { course });
  if (!route) return { name: course };
  const chapter = route.current === null ? null : route.chapters[route.current];
  return { name: course, cards: route.cards, learned: route.learned, chapters: route.chapters.length,
    chapter: chapter ? { index: route.current, title: chapter.title, learned: chapter.learned, total: chapter.total } : null,
    next: route.next };
}

function startCourseRun(s, a, ports) {
  const course = typeof a.course === 'string' ? a.course.trim() : currentCourse(s);
  if (course == null || course === '*' || !decksInCourse(s, course).length) throw new Error("请先选择一门课程");
  const open = s.runs.filter((r) => r.purpose === "course" && r.course === course && runOpen(r));
  if (open.length && a.fresh !== true && !a.deckId) return projection(s, open.at(-1));
  const count = Number(a.count ?? COURSE_BATCH);
  if (!isQuestionCount(count)) throw new Error(`每批 ${QUESTION_COUNT.min}–${QUESTION_COUNT.max} 道题`);
  const batch = courseBatch(s, { course, count, fromDeckId: a.deckId });
  const scope = [...batch.reviews, ...batch.fresh].map(({ deckId, card }) => ({ deckId, cardId: card.id }));
  if (!scope.length) throw new Error("这门课程已经全部学完，也没有需要巩固的题");
  const closedAt = new Date().toISOString();
  for (const r of open) r.closedAt ||= closedAt;
  const started = ports.mutate("review.start", s, { mode: "path", scope, fresh: true });
  const run = get(s.runs, started.id, "Review");
  Object.assign(run, { purpose: "course", course, batchLabel: batch.label });
  return projection(s, run);
}

function workflowOrigin(s, run) {
  const session = s.workflowSessions.find((x) => x.id === run.workflowSessionId);
  if (!session) return null;
  const steps = session.template.steps, stepId = run.key?.split(":").pop();
  const index = steps.findIndex((x) => x.id === stepId);
  return { sessionId: session.id, topic: session.topic, stepTitle: steps[index]?.title || "题目练习",
    stepIndex: index, stepCount: steps.length, current: session.currentStepId === stepId && session.status !== "completed" };
}

function projection(s, run) {
  const entry = run.closedAt ? null : run.entries[run.index];
  const outcome = latestOutcomes(s.attempts);
  const decks = new Map(s.decks.map((d) => [d.id, new Map(d.cards.map((c) => [c.id, c]))]));
  return {
    id: run.id,
    startedAt: run.startedAt,
    mode: run.mode,
    ...(run.mode === "exam" ? { examKinds: run.examKinds || "all" } : {}),
    // A written exam says how long it lasts (a case paper says so in its `paper`), so the page's clock and the server's check agree.
    ...(run.mode === "exam" && !run.paper ? { limitMs: examLimitMs(run) } : {}),
    scope: run.scope ?? [{ deckId: run.deckId }],
    // A course's daily round (lib/daily-path.js): the result page carries on with the same course's next round.
    ...(run.dailyCourse !== undefined ? { dailyCourse: run.dailyCourse } : {}),
    ...(run.mode === 'new' ? { freshRemaining: learningState(s, { scope: run.scope ?? [{ deckId: run.deckId }] }).decks
      .filter(deck => !deck.archived && !deck.systemKind).reduce((n, deck) => n + deck.cards.filter(card =>
        !card.suspended && cardLevel(card, outcome(deck.id, card.id)) === 'new').length, 0) } : {}),
    deckId: entry?.deckId ?? run.deckId,
    title: runTitle(s, run),
    titleInfo: runTitleInfo(s, run),
    // A learning-flow practice step runs in the ordinary review page; say where to go back to.
    ...(run.workflowSessionId ? { workflow: workflowOrigin(s, run) } : {}),
    // A course batch reports where the course stands, for the way on from the result page.
    ...(run.purpose === "course" ? { course: courseProgress(s, run.course) } : {}),
    sourceIds: [
      ...new Set(
        run.entries.flatMap((e) => (Array.isArray(e.card.citations) ? e.card.citations : [])
          .map((c) => c?.sourceId).filter(Boolean)),
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
    // Where each weak topic lives, so the result page can start practice of just that topic: { topic: [{ deckId, topic }] }.
    weakScopes: weakScopesOf(run),
    // Tail retries are extra practice on a question already counted once.
    questions: run.entries.filter((x) => !x.retry).length,
    answered: run.entries.filter((x) => !x.retry && x.feedback).length,
    // Of those, the answers the learner graded themselves (flashcards, open questions): the score is worded by how it was measured, as the 点评 splits it.
    selfAnswered: run.entries.filter((x) => !x.retry && x.feedback && (run.mode === "flashcard" || !["quiz", "multi", "cloze"].includes(x.card.kind))).length,
    correct: run.entries.filter((x) => !x.retry && x.feedback?.grade >= 3).length,
    retries: run.entries.filter((x) => x.retry && x.feedback).length,
    card: entry ? publicCard(entry.card, entry.order) : null,
    prerequisites: entry ? currentPrerequisites(s, run, entry) : [],
    revision: entry ? liveCard(s, run, entry)?.revisions?.length || 0 : 0,
    returnTo: run.returnTo || null,
    // Started from the reader: where to go back to, and the mastery of those cards before and now.
    ...(run.reading ? { reading: readingView(s, run) } : {}),
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
          // A case paper restores the learner's typed answers too (WP12).
          ...(run.examKinds === "case" ? { responses: run.entries.map((e) => ({ deckId: e.deckId ?? run.deckId, cardId: e.card.id, response: e.response || "" })),
            paperCards: run.entries.map((e) => ({ deckId: e.deckId ?? run.deckId, ...publicCard(e.card) })) } : {}),
        }
      : {}),
    ...(run.paper ? { paper: run.paper } : {}),
    ...(run.highlights?.length || run.paper ? { highlights: run.highlights || [] } : {}),
    ...(entry && !entry.feedback && entry.card.rubricCriteria ? lastRubric(s, entry, run) : {}),
    ...(entry?.revealed ? { solution: solution(entry.card) } : {}),
  };
}

/** The latest grading of a rubric card, shown when it comes back in a new round. */
function lastRubric(s, entry, run) {
  const deckId = entry.deckId ?? run.deckId;
  const attempt = s.attempts.findLast((item) => item.assessment === "rubric" && !item.updatedAfterOpening && item.quiz_id === entry.card.id && item.deckId === deckId);
  return attempt ? { lastRubric: { total: attempt.score, max: attempt.maxScore, at: attempt.timestamp, criteria: attempt.rubric?.criteria || [] } } : {};
}

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

function staleReviewEntries(s, run) {
  if (run.closedAt || run.mode === "exam") return [];
  return run.entries.flatMap((entry, index) => {
    const live = liveCard(s, run, entry);
    if (!live || contentKey(live) === contentKey(entry.card)) return [];
    if (entry.keepSnapshot && !entry.feedback && index === run.index) return [];
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

function currentRun(s) {
  let best = null;
  for (const run of s.runs) {
    if (run.workflowSessionId) continue;
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

function weakScopesOf(run) {
  const scopes = {};
  for (const e of run.entries) {
    const deckId = e.deckId ?? run.deckId, topic = e.card.topic;
    if (!(e.feedback?.grade < 3) || !deckId || typeof topic !== "string" || !topic) continue;
    const list = (scopes[topic] ||= []);
    if (!list.some((ref) => ref.deckId === deckId)) list.push({ deckId, topic });
  }
  return scopes;
}

const runKey = (r) => r.key ?? scopeKey(r.mode, [{ deckId: r.deckId }]);

const runTouches = (r, deckId) =>
  r.deckId === deckId || r.entries.some((e) => e.deckId === deckId);

const solution = (q) => ({
  followups: currentFollowups(q),
  answer: q.answer,
  explanation: q.explanation,
  misconception: q.misconception,
  rubric: q.rubric,
  ...(q.rubricCriteria ? { rubricCriteria: q.rubricCriteria } : {}),
  citations: q.citations,
  options: q.options,
  ...(q.kind === "cloze" ? { cloze: q.cloze } : {}),
  // The English answer side arrives with the reveal, never before.
  ...(currentTranslation(q)
    ? { translation: {
        answer: q.translation.answer,
        explanation: q.translation.explanation,
        ...(Array.isArray(q.translation.options)
          ? { options: q.translation.options.map(({ id, explanation }) => ({ id, explanation })) }
          : {}),
        ...(Array.isArray(q.translation.blanks) ? { blanks: q.translation.blanks } : {}),
      } }
    : {}),
});

export { balancedExamQuestions, roleExamQuestions, examReport, submittedExam, courseProgress, startCourseRun, workflowOrigin, projection, originView, liveCard, staleReviewEntries, currentPrerequisites, currentRun, currentCard, creditPrerequisites, runOpen, runKey, runTouches, solution };
