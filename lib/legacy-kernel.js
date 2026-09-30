import { preparePublication } from './contexts/bank/publication.js';
import { ownWork } from './runtime/work-ownership.js';
import { Store } from "./store.js";
import { commitAssist } from './assist-content.js';
import { importCourses, libraryCourses, resolveCourse } from "./source-courses.js";

import { runTitle, runTitleInfo } from './run-title.js';
import { languageSystem, validLanguage } from './language.js';




import { prepareJsonImport } from "./json-import.js";
import { cardKey, normalizeImportText, sameTitle } from "./bulk-import.js";


import { isSlayDeck } from "./slay.js";


import { coursesOf, currentCourse } from "./focus.js";
import { learningState } from "./learning-scope.js";
import { COURSE_BATCH, courseBatch, courseRoute } from "./course-route.js";



import { id, get } from "./util.js";
import { teachingView } from "./teaching.js";
import { initialReview, schedule, shuffled, validateDeck, publicCard, norm } from "./domain.js";



import { EXAM_LIMIT_MS } from "./exam-timing.js";
import { oralAction } from "./oral-exam-service.js";


import { extname } from "node:path";
import { AUDIO_EXTENSIONS } from "./audio-file.js";
import { discardUpload } from "./audio-upload.js";
import { readAudioSettings } from "./audio-settings.js";

import { executeAudioJob } from "./audio-job.js";
import { executeAudioBatch, listAudioBatches, removeAudioBatch, saveAudioBatch, verifySingleAudioInput } from "./audio-batch.js";

import { LiveSession, makeTranslator, readSaved, register, registered, writeSaved } from "./live.js";


import { GeminiTiers, defaultFetch } from "./gemini.js";
import { makeCorrector } from "./live-correction.js";



import { findCard, prerequisiteView } from "./prereq.js";



import { currentFollowups, followupDigest } from "./followup.js";
import { cardLevel, latestOutcomes, scopeKey } from "./mastery.js";
import { notify } from "./inbox.js";


import { isModelFailure, modelFailureMessage, withModelRetry } from "./model-retry.js";
import { FEEDBACK_TAGS, MAX_READY, cognitiveLevel, debriefRules, ensureLearner, evidenceWindows, learnerAnswer, runMetrics, threadView, trimLogs, staleSelfAssessment, writeDebrief, writeNudge, writeRewrite, writeVariants } from "./coach.js";

// 陪学 background state, per library root (services are created per request).
const coachInflight = new Map();
// Only the owning worker may publish its finished checkpoint while its job is active.
const supplementPublication = Symbol('supplement publication');
const supplementBudgetPublication = Symbol('reviewed checkpoint after budget');

function checkSupplementPublication(args) {
  const jobId = args[supplementPublication] || args.publishJobId;
  const signal = generationControllers.get(jobId)?.signal;
  // Only the scheduler's deadline permits receipt-only finalization. User
  // cancellation still wins, including cancellation during the atomic write.
  if (args[supplementBudgetPublication] && signal?.reason?.code === 'GENERATION_BUDGET' &&
      !jobs.get(jobId)?.cancelRequestedAt) return;
  signal?.throwIfAborted();
}
// One EN translation per card at a time; late clicks join the in-flight call.
const translateInflight = new Map();
const followupInflight = new Map();
const suggestionInflight = new Map();
const coachReplyInflight = new Map();
const coachTasks = new Map();
const coachQueues = new Map();
// Rewrites for different cards run side by side, at most this many per library.
const MAX_PARALLEL_REWRITES = 3;
const rewriteSlots = new Map();
const prepPending = new Map();
const PREP_DELAY_MS = 20000;
const jobs = new Map();
function publicationTarget(state, draft, args) {
  const explicit = [];
  for (const field of ['mergeTargetId', 'deckId', 'deck']) {
    if (args[field] === undefined) continue;
    const value = field === 'deck' && args[field] && typeof args[field] === 'object' ? args[field].id : args[field];
    if (typeof value !== 'string' || !value.trim()) throw new Error('发布目标题组必须是有效 ID');
    explicit.push(value.trim());
  }
  const retained = draft.editingDeckId || draft.editorial?.repairOfDeckId || draft.mergeTargetId;
  if (new Set([...explicit, ...(retained ? [retained] : [])]).size > 1)
    throw new Error('发布目标题组冲突，请先重新保存草稿的目标');
  const targetId = explicit[0] || retained;
  if (!targetId) return null;
  const target = state.decks.find(deck => deck.id === targetId);
  if (!target) throw new Error('发布目标题组不存在');
  if (target.archived || target.systemKind) throw new Error('发布目标必须是未归档的普通题组');
  return target;
}
function publicationDuplicates(cards) {
  const indexes = ['objective', 'prompt'].map(field => {
    const values = new Map();
    for (const card of cards) {
      const value = norm(card[field]);
      if (!values.has(value)) values.set(value, new Set());
      values.get(value).add(card.id);
    }
    return { field, values };
  });
  return card => indexes.some(({ field, values }) => {
    const ids = values.get(norm(card[field]));
    return ids && (ids.size > 1 || !ids.has(card.id));
  });
}
// Generations for one library run one after another; later requests queue.
const queues = new Map();
// Recordings run one at a time across this host, independently of question generation.
// Single imports, batch members and live saves share the same FIFO processing slot.
const audioGate = { limit: 1, active: new Set(), waiting: [] };
/** Let waiting jobs start while there are free slots. */
function pumpAudio(gate) {
  while (gate.waiting.length && gate.active.size < gate.limit) {
    const next = gate.waiting.shift();
    gate.active.add(next.id);
    next.start();
  }
}
/** Single imports and batch members use the same actual processing slots. Batch orchestration holds none. */
function admitAudio(gate, taskId, signal, work) {
  let onAbort;
  const turn = new Promise(resolve => {
    gate.waiting.push({ id: taskId, start: resolve });
    onAbort = () => { const at = gate.waiting.findIndex(entry => entry.id === taskId); if (at >= 0) { gate.waiting.splice(at, 1); resolve(); } };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  pumpAudio(gate);
  return turn.then(work).finally(() => { signal.removeEventListener('abort', onAbort); gate.active.delete(taskId); pumpAudio(gate); });
}
// A failed audio job can be resumed: its work and what to clean up when it is over (job id → { filename, work, cleanup }).
const retryable = new Map();
function dropRetry(jobId) {
  const entry = retryable.get(jobId);
  if (!entry) return;
  retryable.delete(jobId);
  void Promise.resolve().then(() => entry.cleanup?.()).catch(() => {});
}
const settled = new Map();
const noteJobs = new Map();
// Live delivery handles are deliberately excluded from public job snapshots.
const generationMessengers = new Map();
const generationControllers = new Map();
// Captures on one library run in turn, so each classifies against the previous one's result.
const captureQueues = new Map();
const activeJob = (j) => ["running", "queued", "cancelling"].includes(j.status);
const publicJob = ({ root, ...j }) => j;
const UNGRADABLE_ISSUE = /(?:expected object|answer is required|prompt is required|need 3–6 options|options have an invalid shape|invalid correct option count|duplicate option id|each option requires|cloze |scoring rubric|unsupported kind)/i;
function markPublicationIssues(deck, sources) {
  const issues = deck.cards.map(() => []);
  for (const issue of validateDeck(deck, sources).errors) {
    const match = /^Card (\d+): (.*)$/.exec(issue);
    if (match && issues[Number(match[1]) - 1])
      issues[Number(match[1]) - 1].push(match[2]);
  }
  deck.cards.forEach((card, index) => {
    if (issues[index].length) {
      card.publicationIssues = issues[index];
      card.publicationUngrable = issues[index].some((issue) => UNGRADABLE_ISSUE.test(issue));
    } else {
      delete card.publicationIssues;
      delete card.publicationUngrable;
    }
  });
}
function repairContextIssues(card, draft, state, suppliedSources) {
  const issues = [];
  const suppliedIds = new Set(suppliedSources.map((source) => source.id));
  if (Array.isArray(card.citations) && card.citations.some((ref) => !suppliedIds.has(ref?.sourceId)))
    issues.push("修题引用了未提供给独立复审的资料");
  const peers = draft.cards.filter((other) => other.id !== card.id &&
    !draft.editorial?.rejectedIssues?.[other.id]);
  const liveId = draft.editingDeckId || draft.editorial?.repairOfDeckId;
  const live = liveId && state.decks.find((deck) => deck.id === liveId);
  if (live) peers.push(...live.cards.filter((other) =>
    draft.editorial?.repairOfDeckId || other.id !== card.id));
  if (peers.some((other) => norm(other.objective) === norm(card.objective)))
    issues.push("学习目标与已通过或已发布的题目重复，请改成不同考点");
  if (peers.some((other) => norm(other.prompt) === norm(card.prompt)))
    issues.push("问题与已通过或已发布的题目重复，请改成不同问题");
  if (live?.cards.some((other) => other.id === card.id && draft.editorial?.repairOfDeckId))
    issues.push("题目编号与已发布的题目重复");
  return issues;
}
function mergeContinuedDraft(base, fresh, sources) {
  const cards = [...base.cards], failures = [...(fresh.editorial.failures || [])];
  const targets = new Set(cards.map((card) => norm(card.objective)));
  const prompts = new Set(cards.map((card) => norm(card.prompt)));
  const ids = new Set(cards.map((card) => card.id));
  for (const card of fresh.cards) {
    if (ids.has(card.id) || targets.has(norm(card.objective)) || prompts.has(norm(card.prompt))) {
      failures.push("补题时跳过了一道与已有草稿重复的题");
      continue;
    }
    cards.push(card);
    ids.add(card.id);
    targets.add(norm(card.objective));
    prompts.add(norm(card.prompt));
  }
  const sourceIds = new Set(base.editorial.generation.sourceIds);
  const cited = new Set(cards.flatMap((card) => card.citations.map((c) => c.sourceId)).filter((sourceId) => sourceIds.has(sourceId)));
  const oldPlanned = new Map((base.editorial.coverage?.sources || []).map((row) => [row.id, row.planned]));
  if (!base.editorial.coverage?.sources)
    for (const audit of base.editorial.audits || [])
      for (const target of audit.targets || [])
        for (const sourceId of new Set((target.citations || []).map((ref) => ref.sourceId)))
          oldPlanned.set(sourceId, (oldPlanned.get(sourceId) || 0) + 1);
  const newPlanned = new Map((fresh.editorial.coverage?.sources || []).map((row) => [row.id, row.planned]));
  const completedBefore = base.editorial.completedParts || 0;
  return {
    ...base,
    cards,
    editorial: {
      ...fresh.editorial,
      requested: base.editorial.requested,
      generated: cards.length,
      parts: completedBefore + fresh.editorial.parts,
      completedParts: completedBefore + fresh.editorial.completedParts,
      generation: { ...base.editorial.generation, course: fresh.editorial.generation.course },
      audits: [...(base.editorial.audits || []), ...(fresh.editorial.audits || []).map((audit) => ({ ...audit, part: completedBefore + audit.part }))],
      reviewedCards: Object.fromEntries(cards.flatMap((card) => {
        const mark = base.editorial.reviewedCards?.[card.id] || fresh.editorial.reviewedCards?.[card.id];
        return mark ? [[card.id, mark]] : [];
      })),
      previousFailures: [...(base.editorial.previousFailures || []), ...(base.editorial.failures || [])],
      failures,
      coverage: {
        selected: sourceIds.size,
        cited: cited.size,
        sources: sources.filter((source) => sourceIds.has(source.id)).map(({ id: sourceId, title }) => ({
          id: sourceId, title,
          planned: (oldPlanned.get(sourceId) || 0) + (newPlanned.get(sourceId) || 0),
          accepted: cards.filter((card) => card.citations.some((ref) => ref.sourceId === sourceId)).length,
        })),
        uncited: sources.filter((source) => sourceIds.has(source.id) && !cited.has(source.id)).map(({ id: sourceId, title }) => ({ id: sourceId, title })),
      },
    },
  };
}
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
  const scorePct = total ? Math.round((correct / total) * 100) : 0;
  const quizCount = run.entries.filter((entry) => entry.card.kind === "quiz").length;
  const priorIndex = s.runs.indexOf(run);
  const previous = priorIndex < 0 ? null : s.runs.slice(0, priorIndex).findLast((past) =>
    submittedExam(past) && runKey(past) === runKey(run) && past.entries.length === total &&
    (past.examKinds || "all") === (run.examKinds || "all") &&
    JSON.stringify(past.examTargetTopics || []) === JSON.stringify(run.examTargetTopics || []) &&
    past.entries.filter((entry) => entry.card.kind === "quiz").length === quizCount);
  const previousScorePct = previous
    ? Math.round((previous.entries.filter((entry) => entry.feedback?.correct).length / total) * 100)
    : null;
  return {
    runId: run.id, startedAt: run.startedAt, submittedAt: run.submittedAt || run.closedAt,
    examKinds: run.examKinds || "all", examRole: run.examRole || "",
    total, answered: total - skipped.length, unanswered: skipped.length, correct,
    scorePct,
    comparison: previous ? { runId: previous.id, scorePct: previousScorePct, deltaPct: scorePct - previousScorePct } : null,
    durationMs: Math.min(EXAM_LIMIT_MS,
      Math.max(0, Date.parse(run.closedAt) - Date.parse(run.startedAt))),
    byTopic: [...byTopic.values()], byDeck: [...byDeck.values()], byKind: [...byKind.values()], wrong, skipped,
    weakScope: [...wrong, ...skipped].map(({ deckId, cardId }) => ({ deckId, cardId })),
  };
}
const submittedExam = (run) => run.mode === "exam" && !!run.closedAt &&
  (!!run.submittedAt || run.entries.some((entry) => !!entry.feedback));
function pruneJobs() {
  const terminal = [...jobs.values()]
    .filter((j) => !activeJob(j) && !((j.batchId || j.singleId) && j.status !== 'complete'))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  for (const job of terminal.slice(100)) {
    dropRetry(job.id); jobs.delete(job.id);
    if (job.batchId || job.singleId) void removeAudioBatch(job.root, job.batchId || job.singleId).catch(() => {});
  }
}
/**
 * Run one audio-type background job (an audio file import, or saving a live
 * class with proofreading): queued behind earlier recordings on this host,
 * cancellable, announced to the session when it ends. `work(job, signal)`
 * fills in the job record and throws on failure.
 */
function startAudioJob(service, filename, work, { cleanup, fields = {}, orchestrates = false, persist } = {}) {
  const root = service.store.root, gate = audioGate;
  const audioJobs = [...jobs.values()].filter((j) => j.root === root && j.type === "audio-import" && activeJob(j));
  if (audioJobs.some((j) => fields.batchId ? j.batchId === fields.batchId : !j.batchId && j.filename === filename)) throw new Error("这个音频已经在处理，请等它完成");
  pruneJobs();
  const waits = gate.active.size >= gate.limit;
  const queuedBehind = waits ? gate.waiting.length + 1 : 0;
  const job = {
    id: id(), root, type: "audio-import", filename, status: waits ? "queued" : "running",
    stage: waits ? "排队中" : "读取音频", phase: waits ? "queued" : "read", done: 0, total: 0,
    warnings: [], startedAt: new Date().toISOString(), ...fields,
  };
  ownWork(job, service.workOwner);
  jobs.set(job.id, job);
  retryable.set(job.id, { filename, work, cleanup, ...(fields.singleId ? { singleId: fields.singleId } : {}) });
  const controller = new AbortController();
  generationControllers.set(job.id, controller);
  const run = async () => {
    if (controller.signal.aborted) {
      job.status = "cancelled";
      job.retryable = true;
      job.finishedAt ||= new Date().toISOString();
      generationControllers.delete(job.id);
      await persist?.(job);
      return;
    }
    job.status = "running";
    job.phase = "read";
    job.stage = "读取音频";
    job.startedAt = new Date().toISOString(); // the time spent working, not the time spent waiting for a slot
    try {
      await work(job, controller.signal, (taskId, signal, member) => admitAudio(gate, taskId, signal, member));
      controller.signal.throwIfAborted();
      job.status = "complete";
      job.phase = "done";
      job.stage = job.reused ? "这段内容已按同样设置处理过，直接复用"
        : `已存为 ${job.sourceIds.length} 份资料${job.corrected === undefined ? "" : `，校对修正 ${job.corrected} 处`}`;
      // Done for good: nothing to resume, so the uploaded copy of the audio can go.
      retryable.delete(job.id);
      if (!persist) { try { await cleanup?.(); } catch { /* an old copy is removed by age later */ } }
    } catch (error) {
      job.status = controller.signal.aborted && job.cancelRequestedAt ? "cancelled" : "failed";
      // Kept for a retry: what was transcribed, proofread and translated is saved, so trying again only does the rest.
      job.retryable = retryable.has(job.id);
      job.stage = job.status === "cancelled" ? "已取消；已完成的部分会保留，再来一次会接着做" : String(error.message || error).slice(0, 400);
    } finally {
      generationControllers.delete(job.id);
      job.finishedAt = new Date().toISOString();
      // Persisted jobs resume from manifests, so a failed job needs no model/service closure.
      const retained = retryable.get(job.id);
      if (retained && (job.singleId || job.batchId)) retryable.set(job.id, {
        singleId: job.singleId, batchId: job.batchId, cleanup: retained.cleanup,
      });
      try {
        await persist?.(job);
        if (persist && job.status === 'complete') await cleanup?.();
      } catch { job.warnings.push('任务进度或原文件清理未能保存；已完成的逐段检查点仍保留。'); }
      try {
        await service.store.update(s => {
          for (const message of s.inbox || []) if (message.jobId === job.id) message.sourceIds = job.sourceIds || [];
          notify(s, { kind: job.status === 'complete' ? 'audio-result' : 'audio-failed', jobId: job.id,
            filename: job.filename, sourceIds: job.sourceIds,
            detail: job.status === 'failed' && job.retryable ? `${job.stage.length > 90 ? job.stage.slice(0, 89) + '…' : job.stage} 已完成的部分已保存，可在「音频转录」页点「接着做」` : job.stage });
        });
      } catch { job.warnings.push('信箱通知未能保存，请在音频转录页查看任务结果。'); }
      service.announceJob(job);
    }
  };
  const done = orchestrates ? Promise.resolve().then(run) : admitAudio(gate, job.id, controller.signal, run);
  settled.set(job.id, done);
  void done.finally(() => { settled.delete(job.id); });
  return {
    jobId: job.id, status: job.status, queuedBehind,
    next: "转写、校对和翻译在后台进行，长录音需要几分钟到十几分钟。告诉学习者已开始，进度在学习面板的资料页；只有明确要等待时才用 job.wait，不要轮询或重复提交。完成后是一份资料，不会自动出题。",
  };
}

async function preparedAudioSettings(service, args) {
  const settings = await service.audioSettings();
  if (!settings.freeKey && !settings.paidKey && !settings.groqKey)
    throw new Error('还没有配置 Gemini API 密钥（转写至少要有一把 Gemini 或 Groq 密钥）：请在「设置 › 音频转写」里填写（不要贴到对话里），或设置环境变量 GEMINI_FREE_API_KEY / GEMINI_PAID_API_KEY / GROQ_API_KEY');
  if (args.paidOnly === true && !settings.paidKey) throw new Error('选择了只用付费密钥，但还没有配置付费密钥');
  if (settings.textProvider === 'host' && !service.complete) throw new Error('当前没有可用的对话模型；请在设置里把文本处理改为 Gemini');
  return settings;
}
async function startBatch(service, batch, { retry = false } = {}) {
  const fields = { id: retry ? id() : batch.job.id, batchId: batch.id, warnings: batch.job.warnings || [], courses: batch.args.courses };
  const started = startAudioJob(service, batch.title, async (job, signal, admit) => {
    const settings = await preparedAudioSettings(service, batch.args);
    await executeAudioBatch({ root: service.store.root, batch, job, signal, settings, store: service.audioStore || service.store, complete: service.complete, fetch: service.fetch, admit });
  }, { fields, orchestrates: true, persist: job => saveAudioBatch(service.store.root, batch, job),
    cleanup: () => removeAudioBatch(service.store.root, batch.id, { inputsOnly: true }) });
  await saveAudioBatch(service.store.root, batch, jobs.get(started.jobId));
  return { ...started, batchId: batch.id };
}
function singleCleanup(root, record) {
  return async () => {
    await removeAudioBatch(root, record.id, { inputsOnly: true });
    if (record.upload) await discardUpload(record.upload);
  };
}
async function startSingleAudio(service, record, { retry = false } = {}) {
  const root = service.store.root;
  if (retry) await verifySingleAudioInput(record);
  if (retry) record.job.id = id();
  await saveAudioBatch(root, record);
  return startAudioJob(service, record.job.filename, async (job, signal) => {
    const settings = await preparedAudioSettings(service, record.args);
    await executeAudioJob({ job, args: record.args, settings, store: service.audioStore || service.store,
      complete: service.complete, fetch: service.fetch, signal });
  }, { fields: { id: record.job.id, singleId: record.id },
    persist: job => saveAudioBatch(root, record, job), cleanup: singleCleanup(root, record) });
}
const recoveredBatches = new Map();
function recoverAudioBatches(service) {
  const root = service.store.root;
  if (!recoveredBatches.has(root)) recoveredBatches.set(root, (async () => {
    for (const batch of await listAudioBatches(root)) {
      if (batch.kind === 'single') {
        if ([...jobs.values()].some(job => job.root === root && job.singleId === batch.id)) continue;
        const job = { ...batch.job, root, singleId: batch.id };
        if (activeJob(job)) Object.assign(job, { status: 'failed', retryable: true,
          stage: '上次导入已中断；已完成的部分已保存，点「接着做」继续', finishedAt: new Date().toISOString() });
        jobs.set(job.id, job);
        if (job.status !== 'complete') {
          job.retryable = true;
          retryable.set(job.id, { singleId: batch.id, cleanup: singleCleanup(root, batch) });
        }
        continue;
      }
      if ([...jobs.values()].some(job => job.root === root && job.batchId === batch.id)) continue;
      const job = { ...batch.job, root };
      if (activeJob(job)) Object.assign(job, { status: 'failed', retryable: true, stage: '上次导入已中断；已完成的部分已保存，点「接着做」继续', finishedAt: new Date().toISOString() });
      jobs.set(job.id, job);
      if (job.status !== 'complete') { job.retryable = true; retryable.set(job.id, { batchId: batch.id, cleanup: () => removeAudioBatch(root, batch.id, { inputsOnly: true }) }); }
    }
    // Before single-file manifests existed, only the failed inbox letter survived.
    // Show a recovery card rather than silently losing the task; the original
    // submitted path/options cannot be guessed, so the learner must reselect it.
    const state = await service.store.read();
    for (const letter of (state.inbox || []).filter(item => item.kind === 'audio-failed').slice(-50)) {
      if (jobs.has(letter.jobId) || !AUDIO_EXTENSIONS.includes(extname(letter.filename || '').toLowerCase())) continue;
      jobs.set(letter.jobId, { id: letter.jobId, root, type: 'audio-import', filename: letter.filename,
        status: 'failed', phase: 'unknown', stage: '旧版任务没有保存原文件位置和提交参数。请重新选择同一录音；相同内容和设置的已存检查点会复用。',
        legacy: true, relinkable: true, retryable: false, finishedAt: letter.at, startedAt: letter.at });
    }
  })().catch(error => { recoveredBatches.delete(root); throw error; }));
  return recoveredBatches.get(root);
}
/** A live session: the running one, or a saved one read back from disk. */
function liveTranslation(service, settings, { subject, vocabulary, paidOnly = false }) {
  const hostModel = service.light || service.complete;
  if (settings.textProvider === 'host' && !hostModel) throw new Error('当前没有可用的对话模型；请在音频设置里选择 Gemini');
  if (settings.textProvider !== 'host' && !settings.freeKey && !settings.paidKey) throw new Error('请先在音频设置中配置 Gemini 密钥');
  const tiers = new GeminiTiers({ keys: { free: settings.freeKey, paid: settings.paidKey }, fetch: service.fetch, skipFree: paidOnly });
  const complete = settings.textProvider === 'host' ? hostModel
    : (system, prompt, options) => tiers.complete(settings.liveTranslateModel, system, prompt, { signal: options?.signal, label: '实时翻译' });
  return { tiers, translate: makeTranslator({ complete, subject, vocabulary }) };
}
function liveCorrector(service, settings, { subject, vocabulary, paidOnly = false }) {
  const tiers = new GeminiTiers({ keys: { free: settings.freeKey, paid: settings.paidKey }, fetch: service.fetch, skipFree: paidOnly });
  const reasoning = settings.liveCorrectionReasoning || 'low';
  const spawn = service.light?.spawnCorrection || service.complete?.spawnCorrection;
  const complete = settings.textProvider === 'host'
    ? (system, prompt, options) => (service.light || service.complete)(system, prompt, { ...options, reasoningEffort: reasoning, maxTokens: 4096 })
    : (system, prompt, options) => tiers.complete(settings.liveTranslateModel, system, prompt, { ...options, thinkingLevel: reasoning, label: '上下文校正' });
  const background = settings.textProvider === 'host' && spawn
    ? (system, prompt, options) => spawn(system, prompt, { ...options, reasoningEffort: reasoning })
    : complete;
  return makeCorrector({ complete, background,
    subject, vocabulary, modelKey: `${settings.textProvider}:${settings.liveTranslateModel}:${reasoning}`,
    usage: settings.textProvider === 'host' ? undefined : () => tiers.summary() });
}
async function liveSessionOf(service, id) {
  const root = service.store.root;
  if (typeof id !== "string" || !id) throw new Error("需要实录编号 id");
  const existing = registered(root, id);
  if (existing) return existing;
  const saved = await readSaved(root, id);
  const session = new LiveSession({ id: saved.id, title: saved.title, tiers: new GeminiTiers({}), translate: null, save: (data) => writeSaved(root, data), saved });
  register(root, session);
  return session;
}
function courseProgress(s, course) {
  const route = courseRoute(s, { course });
  if (!route) return { name: course };
  const chapter = route.current === null ? null : route.chapters[route.current];
  return { name: course, cards: route.cards, learned: route.learned, chapters: route.chapters.length,
    chapter: chapter ? { index: route.current, title: chapter.title, learned: chapter.learned, total: chapter.total } : null,
    next: route.next };
}
/** 继续课程: pick up an unfinished batch, or build the next one along the course route. */
function startCourseRun(s, a, ports) {
  const course = typeof a.course === 'string' ? a.course.trim() : currentCourse(s);
  if (course == null || !coursesOf(s.decks).has(course)) throw new Error("请先选择一门课程");
  const open = s.runs.filter((r) => r.purpose === "course" && r.course === course && runOpen(r));
  if (open.length && a.fresh !== true && !a.deckId) return projection(s, open.at(-1));
  const count = Number(a.count ?? COURSE_BATCH);
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new Error("每批 1–50 道题");
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
function importCourse(state, args, deck, preferred = currentCourse(state)) {
  return resolveCourse(state, args, {
    course: deck.course ?? (args.folder !== undefined || libraryCourses(state).includes(deck.folder) ? deck.folder : undefined),
    preferred: preferred ?? deck.folder ?? '',
  });
}
/** One question-bank file into the library, inside one store transaction. */
function importJsonDeck(s, file, a, preferred, ports) {
  const { source, deck } = prepareJsonImport(normalizeImportText(file.text, file.name), s.sources);
  if (typeof a.folder === "string") deck.folder = a.folder.trim();
  deck.course = importCourse(s, a, deck, preferred);
  const target = a.into !== undefined ? get(s.decks, a.into, "目标题组")
    : s.decks.find((d) => !d.archived && !d.systemKind && sameTitle(d.title, deck.title) &&
      (d.folder || "") === (deck.folder || "") && (d.course ?? d.folder ?? '') === deck.course);
  if (target && (target.archived || target.systemKind)) throw new Error("只能并入普通题组");
  // Questions already in the target (or repeated within the file) are skipped.
  const have = new Set((target?.cards || []).map(cardKey)), seen = new Set();
  const fresh = deck.cards.filter((card) => {
    const key = cardKey(card);
    if (!key || have.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const skipped = deck.cards.length - fresh.length;
  const report = (final, added) => ({ file: file.name, title: final.title, deckId: final.id, folder: final.folder || "",
    created: !target, added, skipped, total: final.cards.length,
    ...(deck.quality?.warnings?.length ? { warnings: deck.quality.warnings.slice(0, 5) } : {}) });
  if (!fresh.length) return report(target || { title: deck.title, id: null, folder: deck.folder, cards: [] }, 0);
  deck.cards = fresh;
  if (target) {
    deck.title = target.title;
    deck.folder = target.folder || "";
    deck.course = target.course ?? target.folder ?? '';
    deck.mergeTargetId = target.id;
  }
  source.courses = importCourses({ course: deck.course });
  s.sources.push(source);
  s.drafts.push(deck);
  const published = ports.mutate("draft.publish.quick", s, { id: deck.id, draftVersion: deck.draftVersion });
  return report(get(s.decks, published.id, "题组"), fresh.length);
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
    scope: run.scope ?? [{ deckId: run.deckId }],
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
const clampInt = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : fallback;
};
/**
 * Search terms: an array, or a string split on | , ， 、 or OR (keeping phrases
 * like "Product Owner" whole), otherwise on whitespace. Case-insensitive.
 */
function searchTerms(args) {
  const input = args.query ?? args.terms ?? args.q ?? args.keywords;
  const help = 'Give a query with at least one term of 2+ characters, e.g. {"query":"iframe"}. Accepted fields: query, terms, q, keywords (a string or array of strings).';
  if (typeof input !== "string" && !(Array.isArray(input) && input.every((term) => typeof term === "string")))
    throw new Error(help);
  const text = String(input ?? "");
  const raw = Array.isArray(input)
    ? input
    : /[|,，、"]|\sOR\s/i.test(text)
      ? text.replace(/"/g, "|").split(/\s*(?:\||,|，|、|\sOR\s)\s*/i)
      : text.split(/\s+/);
  const terms = [...new Set(raw.map((t) => String(t).trim().toLowerCase()).filter((t) => t.length >= 2))].slice(0, 12);
  if (!terms.length) throw new Error(help);
  return terms;
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
const EDITABLE = ["topic", "objective", "prompt", "answer", "hint", "explanation", "misconception", "rubric", "options", "citations", "cloze"];
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
  const previousIssues = new Set((card.publicationIssues || []).map((issue) => `Card ${index + 1}: ${issue}`));
  if (errors.some((issue) => !previousIssues.has(issue))) throw new Error(errors.join("\n"));
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
  /* 追问是学习者自己问出来的，不能因为改题就消失：把它们的内容摘要迁到新版
     题目上（内容变了的标 stale，界面提示这条基于旧版题目），而不是留在旧摘要
     下再也显示不出来。 */
  const before = followupDigest(card),
    after = followupDigest(next),
    at = new Date().toISOString();
  if (card.followups?.length && before !== after)
    next.followups = card.followups.map((item) =>
      item.digest === before ? { ...item, digest: after, ...(reset ? { staleFrom: item.staleFrom || at } : {}) } : item,
    );
  delete next.followupSuggestions;
  deck.cards[index] = next;
  if (card.publicationIssues?.length) markPublicationIssues(deck, s.sources);
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
        // A background fix must not change an unanswered question while it is
        // on screen. The learner answers the snapshot they actually saw.
        if (keepAnswered && !entry.feedback && run.entries[run.index] === entry) {
          entry.keepSnapshot = true;
          continue;
        }
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
  if (card.kind === "cloze") {
    // A cloze card shows cloze.text, not prompt. Patches may change just the
    // text (answers stay), and a reworded prompt that carries exactly the
    // card's blank markers is the new cloze text too.
    if (content.cloze && typeof content.cloze === "object")
      content.cloze = { ...card.cloze, ...content.cloze, answers: content.cloze.answers ?? card.cloze?.answers };
    const ids = (text) => JSON.stringify([...String(text).matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[1]).sort());
    if (!content.cloze && typeof content.prompt === "string" && card.cloze?.answers?.length &&
      ids(content.prompt) === JSON.stringify(card.cloze.answers.map((x) => x.id).sort()))
      content.cloze = { ...card.cloze, text: content.prompt };
  }
  if (content.cloze !== undefined && card.kind !== "cloze") delete content.cloze;
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
    // Only a question the learner already answered needs "please answer again".
    const hadAnswer = !!entry.feedback || !!entry.revealed;
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
    entry.contentUpdated = hadAnswer;
  }
  entry.card = structuredClone(next);
  if (!sameOptions && next.options) entry.order = shuffled(next.options.map((o) => o.id));
  return reset;
}
// Older versions intentionally left answered entries frozen after card.update.
// Repair only open non-exam snapshots; ordinary polling never writes.
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
/** The card the learner is on in the most recently active standalone run. */
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
    course: m.course ?? (deck ? deck.course ?? deck.folder : '') ?? '',
    kind: m.kind,
    mistakes: m.mistakes,
    added: m.added || 0,
    startedAt: m.startedAt,
  };
}
function recordingDestination(state, args, mode = {}) {
  const useMode = !args.deckId && !args.deckTitle;
  const deckId = args.deckId || (useMode ? mode.deckId : null);
  const target = deckId ? get(state.decks, deckId, 'Deck') : null;
  if (target && (target.archived || target.systemKind)) throw new Error('请选择未归档的普通题组');
  const preferred = currentCourse(state);
  const course = target ? (useMode ? mode.course : undefined) ?? target.course ?? target.folder ?? ''
    : resolveCourse(state, args, { course: useMode ? mode.course : undefined, preferred: preferred ?? '' });
  const deckTitle = target?.title || String(args.deckTitle || (useMode ? mode.deckTitle : '') || '对话录题').trim().slice(0, 120);
  const folder = target ? target.folder || '' : cleanFolder(args.folder ?? (useMode ? mode.folder : undefined));
  const existing = target || state.decks.find(deck => !deck.archived && !deck.systemKind &&
    deck.title === deckTitle && (deck.folder || '') === folder && (deck.course ?? deck.folder ?? '') === course);
  return { deckId: existing?.id || null, deckTitle, folder, course };
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
  followups: currentFollowups(q),
  answer: q.answer,
  explanation: q.explanation,
  misconception: q.misconception,
  rubric: q.rubric,
  citations: q.citations,
  options: q.options,
  ...(q.kind === "cloze" ? { cloze: q.cloze } : {}),
  // The English answer side arrives with the reveal, never before.
  ...(q.translation
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
/** Actions that only read or orchestrate; each manages its own store access. */
const detach = value => value === undefined ? undefined : structuredClone(value);

export class LegacyKernel {
  /**
   * @param complete - full model route used by generation and teaching.
   * @param completeLight - same model with reasoning off/low for 陪学 calls.
   * @param coach - enable background coach work (nudge prefetch, prep batches).
   */
  constructor(root, { complete, completeLight, coach = false, notify, language, fetch, WebSocket, storage, workOwner } = {}) {
    /* Background work finishes long after the tool call that started it. notify
       hands the session a plugin notice so the conversation knows without being
       asked; the host decides when the model reads it. Absent outside DSH. */
    this.notify = typeof notify === "function" ? notify : null;
    this.store = storage || new Store(root);
    this.workOwner = workOwner;
    this.language = validLanguage(language) ? language : undefined;
    this.modelOptions = { complete, completeLight, coach, notify, fetch, WebSocket };
    this.fetch = fetch || defaultFetch;
    this.WebSocket = WebSocket || globalThis.WebSocket;
    const localized = model => model && Object.assign(
      (system, prompt, ...args) => model(languageSystem(system, this.language), prompt, ...args),
      model.spawnCorrection ? { spawnCorrection: (system, prompt, options) => model.spawnCorrection(languageSystem(system, this.language), prompt, options) } : {},
    );
    this.complete = localized(complete);
    // Never forward coach options as a generation `execution` argument.
    const light = localized(completeLight || (complete && Object.assign((system, prompt) => complete(system, prompt),
      complete.spawnCorrection ? { spawnCorrection: complete.spawnCorrection } : {})));
    // Background 陪学 calls retry empty replies and provider hiccups on their own.
    this.light = light && Object.assign((system, prompt, options) => withModelRetry(() => light(system, prompt, options)),
      light.spawnCorrection ? { spawnCorrection: light.spawnCorrection } : {});
    this.coach = !!coach;
  }
  async saveAssistResult(args) {
    return this.store.update(state => commitAssist(state, args, this.ports.mutations(["card.update", "card.link", "card.followup.add"])));
  }
  async dispatch(action, a = {}) {
    if (!a || typeof a !== "object" || Array.isArray(a))
      throw new Error("Arguments must be an object");
    if (['snapshot', 'audio.import', 'audio.retry', 'job.wait', 'job.cancel', 'job.dismiss'].includes(action)) await recoverAudioBatches(this);
    if (a.uiLanguage !== undefined) {
      if (!validLanguage(a.uiLanguage)) throw new Error('Unsupported interface language');
      const { uiLanguage, ...args } = a;
      // A request owns its language, including background model work.
      return this.fork({ language: uiLanguage }).dispatch(action, args);
    }
    if (action.startsWith("oral.")) return detach(await oralAction(this, action, a));
    if (action === "source.find") action = "source.search";
    if (action === "card.find") action = "card.search";
    a = await preparePublication.call(this, action, a);
    if (action === "source.remove" && [...jobs.values()].some((job) => job.root === this.store.root && activeJob(job) && job.sourceIds?.includes(a.id)))
      throw new Error("这份资料正在用于出题，请等待或取消生成任务后再删除");
    const mutation = this.ports.resolveMutation(action);
    if (action === 'settings' && Object.keys(a).length === 0)
      return detach((await this.store.read()).settings);
    if (mutation) {
      // Practice changes one run. An answer can also update the card's deck,
      // prerequisite decks and the attempt log; old runs and sources stay put.
      const reviewChange = ["review.move", "review.reveal", "review.skip", "review.answer"].includes(action)
        && typeof a.runId === "string"
        ? { runs: new Set([a.runId]),
            ...(action === "review.answer" ? { decks: "all", attempts: true } : {}) }
        : null;
      // Portal notes are frequent small writes, not a reason to rehash all source files.
      const workflowChange = action === "workflow.save" || action === "workflow.delete"
        ? { workflowTemplates: "all" }
        : action.startsWith("workflow.session.") || action === "workflow.practice.start"
          ? { workflowSessions: a.id ? new Set([a.id]) : "all",
              ...(["workflow.session.advance", "workflow.session.delete", "workflow.practice.start"].includes(action) ? { runs: "all" } : {}) }
          : null;
      const result = await this.store.update((s) => {
        if (a[supplementPublication] || a.publishJobId) checkSupplementPublication(a);
        return mutation(s, a, this.ports.forAction(action));
      }, reviewChange || workflowChange);
      if (action === "draft.delete") {
        const tasks = [...jobs.values()].filter((job) => job.root === this.store.root && job.draftId === a.id && activeJob(job));
        for (const job of tasks) await this.call("job.cancel", { jobId: job.id });
      }
      return detach(result);
    }
    const handler = this.ports.resolveHandler(action);
    if (!handler) throw new Error("Unknown study action");
    if (action === "coach.reply" && a.reply === "confused") {
      const key = JSON.stringify([this.store.root, a.noteId]);
      if (!coachReplyInflight.has(key))
        coachReplyInflight.set(key, handler.call(this, a).finally(() => coachReplyInflight.delete(key)));
      return detach(await coachReplyInflight.get(key));
    }
    return detach(await handler.call(this, a));
  }
  async nudgeFor(runId, index) {
    const root = this.store.root,
      s = await this.store.read(),
      run = get(s.runs, runId, "Review"),
      at = Number.isInteger(index) ? index : run.index,
      entry = run.entries[at];
    if (!entry?.feedback || entry.feedback.grade >= 3 || run.mode === "exam")
      throw new Error("客观题答错或自评未掌握后才会给出陪学点");
    const cardId = entry.card.id,
      deckId = entry.deckId ?? run.deckId;
    ensureLearner(s);
    const same = (n) => n.type === "nudge" && n.runId === runId && n.entryIndex === at;
    if (s.coach.some((n) => same(n) && !staleSelfAssessment(s, n))) return { thread: threadView(s, cardId) };
    const key = `${root}\0${runId}\0${at}`;
    if (!coachInflight.has(key))
      coachInflight.set(key, (async () => {
        const answer = learnerAnswer(entry.card, entry.feedback, {
          selfGraded: ["flashcard", "open"].includes(entry.card.kind) || run.mode === "flashcard",
        });
        const nudge = await writeNudge(this.light, {
          card: entry.card,
          answer,
          earlier: s.coach.filter((n) => n.cardId === cardId && n.point).map((n) => n.point).slice(-3),
          learner: s.learner,
        });
        return this.store.update((st) => {
          ensureLearner(st);
          st.coach = st.coach.filter((n) => !same(n) || !staleSelfAssessment(st, n));
          if (!st.coach.some(same))
            st.coach.push({ id: id(), type: "nudge", runId, entryIndex: at, deckId, cardId, ...nudge,
              ...(answer?.kind === "self-assessment"
                ? { answerKind: answer.kind, selfGrade: answer.grade, yourAnswer: answer.text }
                : answer ? { yourAnswer: answer.text, expected: answer.expected } : {}), createdAt: new Date().toISOString() });
            notify(st, { kind: "coach", deckId, cardId, detail: nudge.point });
          trimLogs(st);
          return { thread: threadView(st, cardId) };
        });
      })().finally(() => coachInflight.delete(key)));
    return coachInflight.get(key);
  }
  /** Tell the session how a finished generation job turned out. */
  /** The audio settings with "auto" resolved: text goes to the conversation model when this service has one, else to Gemini. */
  async audioSettings() {
    const settings = await readAudioSettings();
    return settings.textProvider === "auto" ? { ...settings, textProvider: this.complete || this.light ? "host" : "gemini" } : settings;
  }
  announceJob(job) {
    if (!this.notify) return;
    const title = job.deckTitle || "题组";
    const done = job.status === "complete";
    if (job.type === 'supplement') {
      const receipt = job.publication;
      try {
        this.notify({ summary: `「${job.targetTitle}」${done ? `补入 ${receipt.added} 题 · 共 ${receipt.total} 题` : '补题未完成'}`,
          text: `学习插件补题结果：任务 ${job.id} 状态 ${job.status}，目标题组 ${job.mergeTargetId}「${job.targetTitle}」。${job.stage}。` +
            (receipt ? `实际新增 ${receipt.added}，总数 ${receipt.total ?? '未变'}。` : '未确认有题目并入，请勿报告成功。') +
            (receipt?.remainingDraftId ? `未通过的题目保留在 ${receipt.remainingDraftId}，未并入。` : '') +
            (job.savedCount < job.requestedTotal ? `生成通过 ${job.savedCount || 0}/${job.requestedTotal}，未补足请求数量。` : '') +
            '只报告结果和必要阻塞原因；用户补入授权仍有效，不再询问是否发布，不自动重跑。' });
      } catch { /* the panel retains the result */ }
      return;
    }
    if (job.type === "audio-import") {
      try {
        this.notify({
          summary: `音频「${job.filename}」${done ? "已转写成中英对照逐字稿" : job.status === "cancelled" ? "导入已取消" : "导入未完成"}`,
          text: `学习插件通知：音频 ${job.filename} 的导入任务 ${job.id} 状态 ${job.status}。${job.stage}。` +
            (done && job.sourceIds?.length ? `逐字稿已存为资料 ${job.sourceIds.join("、")}，可在资料页核对；要出题时再用 generate，本次没有自动出题。` : ""),
        });
      } catch { /* the panel still shows the job */ }
      return;
    }
    if (job.type === "draft-publish") {
      try {
        this.notify({
          summary: `「${title}」${done ? "发布检查完成" : "发布未完成"}`,
          text: `学习插件通知：题组「${title}」的发布任务 ${job.id} 状态 ${job.status}。${job.stage}。`,
        });
      } catch { /* the panel still shows the job */ }
      return;
    }
    if (job.type === "draft-repair") {
      try {
        this.notify({
          summary: `「${title}」后台修题${done ? "全部通过" : job.status === "cancelled" ? "已取消"
            : job.savedCount ? "部分通过" : "未修好"} · ${job.savedCount}/${job.count} 题`,
          text: `学习插件通知：题组「${title}」的后台修题任务 ${job.id} 状态 ${job.status}。${job.stage}。` +
            `通过的题目留在草稿 ${job.draftId}，学习者可回到草稿把它们加入原题组；没有自动发布。`,
        });
      } catch { /* the panel still shows the job */ }
      return;
    }
    const summary = done
      ? `「${title}」生成完成 · ${job.savedCount ?? job.count} 题草稿待发布`
      : `「${title}」生成${job.status === "cancelled" ? "已取消" : "未完成"}：${job.stage}`;
    // Called from a job's finally: a notifier that throws must not disturb it.
    try {
      this.notify({
        summary,
        text:
          `学习插件通知（后台生成结束，学习者没有开口）：题组「${title}」的生成任务 ${job.id} 状态 ${job.status}。${job.stage}。` +
          (job.draftId ? `草稿 ${job.draftId} 已保存，${job.savedCount ?? 0}/${job.requestedTotal ?? job.count} 题通过审核，学习者可在学习面板的草稿里审阅或发布。` : "没有产出草稿。") +
          "下次回复时顺带把结果告诉学习者；不要因此重新发起生成，也不要轮询任务状态。",
      });
    } catch {
      /* the session is gone; the study panel still shows the job */
    }
  }
  /** Background coach work for one library runs one task at a time. */
  coachTask(kind, label, meta, work) {
    const root = this.store.root,
      list = coachTasks.get(root) || [];
    const task = { id: id(), kind, label, status: "running", startedAt: new Date().toISOString(), ...meta };
    list.push(task);
    coachTasks.set(root, list.slice(-20));
    // Rewrites the learner asked for never wait behind a background prep batch,
    // and rewrites of different cards run in parallel (up to a small cap); two
    // rewrites of one card still queue so the second sees the first's result.
    const lane = kind === "rewrite" ? `${root}:rewrite:${meta.cardId}` : `${root}:prep`;
    const run = kind === "rewrite" ? () => this.rewriteSlot(work) : work;
    const previous = coachQueues.get(lane) || Promise.resolve();
    const next = previous.catch(() => {}).then(run).then(
      (message) => Object.assign(task, { status: "done", message: message || "", finishedAt: new Date().toISOString() }),
      (e) => Object.assign(task, { status: "failed", message: modelFailureMessage(e), finishedAt: new Date().toISOString() }),
    );
    coachQueues.set(lane, next);
    next.finally(() => {
      if (coachQueues.get(lane) === next) coachQueues.delete(lane);
    });
    return next;
  }
  /** Run one rewrite once a per-library slot is free. */
  async rewriteSlot(work) {
    const root = this.store.root,
      slots = rewriteSlots.get(root) || { active: 0, waiting: [] };
    rewriteSlots.set(root, slots);
    if (slots.active >= MAX_PARALLEL_REWRITES) await new Promise((resolve) => slots.waiting.push(resolve));
    slots.active++;
    try {
      return await work();
    } finally {
      slots.active--;
      slots.waiting.shift()?.();
    }
  }
  /** Settles when every coach lane of this library is idle. */
  async coachIdle() {
    const root = this.store.root;
    for (;;) {
      const lanes = [...coachQueues.entries()].filter(([lane]) => lane.startsWith(`${root}:`)).map(([, p]) => p.catch(() => {}));
      if (!lanes.length) return;
      await Promise.all(lanes);
    }
  }
  queuePrep(target) {
    if (!this.coach || !this.light) return;
    const root = this.store.root,
      pending = prepPending.get(root) || { targets: [], timer: null, service: this };
    pending.service = this;
    if (!pending.targets.some((t) => t.cardId === target.cardId && t.reason === target.reason && t.followupId === target.followupId)) pending.targets.push(target);
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
      if (isSlayDeck(found.deck) || ready.some((p) => p.originCardId === found.card.id && p.reason === t.reason && p.followupId === t.followupId)) continue;
      const followup = t.reason === "followup" ? currentFollowups(found.card).find((item) => item.id === t.followupId) : null;
      if (t.reason === "followup" && !followup) continue;
      targets.push({
        ...t,
        ...(followup ? { followup } : {}),
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
          ...(target.followupId ? { followupId: target.followupId } : {}),
          level: target.reason === "too-hard" ? "concept" : "apply",
          status: "ready",
          createdAt: new Date().toISOString(),
        });
      for (const { target, card } of results)
        notify(st, { kind: "variant", deckId: target.deckId, cardId: target.card.id, detail: `备好定制题：${card.prompt}` });
      trimLogs(st);
    });
    return `备好 ${results.length} 道定制题`;
  }
  scheduleRewrite(ref, tags) {
    return this.coachTask("rewrite", `按「${tags.map((t) => FEEDBACK_TAGS[t]).join("、")}」改题`, { cardId: ref.cardId, deckId: ref.deckId, tags }, async () => {
      const s = await this.store.read(),
        learner = ensureLearner(s),
        { deck, card } = findCard(s, ref),
        evidence = evidenceWindows(s.sources, [card]);
      const apply = (p, summary) => this.store.update((st) => {
        ensureLearner(st);
        const note = { id: id(), type: "update", deckId: deck.id, cardId: card.id, tags, createdAt: new Date().toISOString() };
        if (!Object.keys(p).length) note.text = summary.startsWith("核对") ? summary : `核对后未改动：${summary}`;
        else {
          applyCardContent(st, ref, patchContent(findCard(st, ref).card, p), `陪学按反馈修改：${tags.map((t) => FEEDBACK_TAGS[t]).join("、")}`, { keepAnswered: true });
          Object.assign(note, { text: summary, revertable: true });
        }
        st.coach.push(note);
        notify(st, { kind: "rewrite", deckId: deck.id, cardId: card.id, detail: note.text });
        trimLogs(st);
      });
      // Empty replies and provider errors are retried inside this.light. A
      // second round only follows a reply we can correct: unparsable JSON or a
      // patch that fails validation (the error is fed back to the model).
      let errors;
      for (let round = 0; ; round++) {
        try {
          const { patch, summary } = await writeRewrite(this.light, { card, tags, evidence, learner, errors });
          await apply(patch, summary);
          return summary;
        } catch (e) {
          // The model call itself failed (already retried or hedged inside
          // this.light, or timed out): another round would only wait again.
          if (round >= 1 || isModelFailure(e)) throw e;
          errors = e.message;
        }
      }
    });
  }
  /** Concept-only sessions get application variants of cards they got right. */
  queueApplicationGaps(run, learner) {
    const seen = new Set();
    for (const e of run.entries)
      if (e.feedback?.grade >= 3 && !e.retry && cognitiveLevel(e.card, learner.levels[e.card.id]) !== "apply" && !seen.has(e.card.topic) && seen.size < 4) {
        seen.add(e.card.topic);
        this.queuePrep({ deckId: e.deckId ?? run.deckId, cardId: e.card.id, reason: "application-gap" });
      }
  }
  async debrief(a) {
    const s = await this.store.read(),
      run = get(s.runs, a.runId, "Review"),
      learner = ensureLearner(s);
    if (run.mode === "exam") throw new Error("模拟考试请看成绩单");
    const metrics = runMetrics(s, run),
      withStatus = (d) => ({ ...d, status: this.coachStatus(s) });
    if (run.debrief?.version === 2 && run.debrief.answered === metrics.answered) return withStatus(run.debrief);
    const ready = s.prepared.filter((p) => p.status === "ready").length;
    const rules = debriefRules(metrics, { ready, consent: learner.consent.prep, modelReady: this.coach && !!this.light });
    if (rules.wantsPrep) {
      this.queueApplicationGaps(run, learner);
      this.flushPrep();
    }
    let model = null;
    if (this.coach && this.light && metrics.answered >= 3)
      try {
        model = await writeDebrief(this.light, { metrics, rules, learner });
      } catch {
        model = null;
      }
    // The model can phrase the advice, but a conflicting action may also make
    // its headline and profile summary contradict the measured weak areas.
    const alignedModel = model?.next === rules.next ? model : null;
    const debrief = {
      version: 2,
      answered: metrics.answered,
      metrics,
      insights: rules.insights,
      headline: alignedModel?.headline || rules.headline,
      why: alignedModel?.why || rules.why,
      next: rules.next,
      preparing: rules.wantsPrep,
      at: new Date().toISOString(),
    };
    await this.store.update((st) => {
      const l = ensureLearner(st),
        r = st.runs.find((x) => x.id === run.id);
      if (r) r.debrief = debrief;
      if (alignedModel?.summary) {
        l.summary = alignedModel.summary;
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

export { checkSupplementPublication, MISTAKES, activeJob, applyCardContent, clampInt, cleanFolder, coachInflight, coachTasks, contentKey, creditPrerequisites, currentCard, currentRun, dropRetry, examReport, followupInflight, generationControllers, generationMessengers, importCourse, importJsonDeck, inTurn, ingestView, jobs, liveCorrector, liveSessionOf, liveTranslation, markPublicationIssues, mergeContinuedDraft, noteJobs, patchContent, preparedAudioSettings, projection, pruneJobs, publicJob, publicationDuplicates, publicationTarget, queues, recordingDestination, repairContextIssues, retryable, roleExamQuestions, runKey, runOpen, runTouches, searchTerms, settled, staleReviewEntries, startAudioJob, startBatch, startCourseRun, startSingleAudio, submittedExam, substance, suggestionInflight, supplementBudgetPublication, supplementPublication, syncReviewEntry, translateInflight };
