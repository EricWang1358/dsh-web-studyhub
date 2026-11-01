import { get, id } from "../../util.js";
import { createRetrievalHandlers } from "./retrieval-operations.js";
import { withinDeadline } from "../../within-deadline.js";
import { completeJson, parseJson } from "../../generation.js";
import { applyPathRefinement } from "../../generation-path.js";
import { suggestSources, sourceOutlines, weakTopicsFor, suggestionSignals, buildSuggestPrompt, suggestRetryPrompt, normalizeSuggestion, localSuggestion, suggestAnswer, modelFailed } from "./suggest.js";
import { pathSteps, buildPathPrompt, pathRetryPrompt, pathUnavailable, pathFailed, pathAnswer } from "./path-suggest.js";
import { ownWork } from "../../runtime/work-ownership.js";
import { isCaseDeck, weakCriteria, drillFocus } from '../../case-study.js';
import { jevPreReviewHook, jevReviewHook } from '../../jev-hooks.js';
import { readExperimental } from '../../experimental.js';
import { recordEvent } from '../../job-calls.js';
import { restoredJob } from './coverage-runs.js';
import { jobArchive } from '../../job-archive.js';
import { libraryQueue } from './jobs/library-queue.js';
import { definitionRef } from './jobs/generation.js';
import { createRunStore } from '../../generation-run-store.js';
import { recoverRuns } from './jobs/recover-runs.js';
import { planDraftRecovery } from './jobs/recover-plan.js';
import { resumeArgs } from './jobs/resume-args.js';
import { createRunClose } from './run-close.js';
import { createDraftRepair } from './draft-repair.js';
import { createDraftPublish } from './draft-publish.js';
import { createSupplementResume } from './supplement-resume.js';
import { createCaseResume } from './case-publish.js';
import { TARGET } from './generate/messages.js';
import { generate } from './generate/operation.js';

const ASSIST_TIMEOUT_MS = 45000;
/** How a prepared run is queued: behind the switch `runtime.pilot.generation` as a job of the unified runtime, else as it always was (jobs/submit-generation.js). Behind switches of their own, each needing that one:
    a run is also kept on disk, so that it survives a restart (`generationRestart`); the background repair of rejected cards is a job of the runtime as well (`generationRepair`); so is the publication
    of a draft: the check, then the one write, which a crash never makes twice (`generationPublish`). */
function switchesOf(runtime) {
  const pilot = runtime?.pilot, managed = pilot?.generation === true, on = (name) => managed && pilot[name] === true;
  return { managed, keptOnDisk: on('generationRestart'), repairManaged: on('generationRepair'), publishManaged: on('generationPublish'),
    jobs: runtime?.jobs, sharedQuota: runtime?.sharedQuota === true, feature: runtime?.feature ?? 'generate' };
}

/** generation operations close over only the ports declared by this context. */
export function createOperations(ports) {
  const { state: storagePort, workOwner: providedWorkOwner, call: providedCall, announceJob: providedAnnounceJob, complete: providedComplete, light: providedLight, language: providedLanguage } = ports;
  const { jobs, queues, settled, generationMessengers, generationControllers, jobControls, jobOutputs } = ports.work;
  const { activeJob, pruneJobs } = ports.jobServices;
  const queue = libraryQueue({ queues, settled });
  const { managed, keptOnDisk, repairManaged, publishManaged, ...runtimeEnv } = switchesOf(ports.runtime);
  const runs = keptOnDisk ? createRunStore({ root: storagePort.root, read: storagePort.read, definitionRef }) : undefined;
  const env = { managed, runs, prepare: (request) => prepareRun(request), ...runtimeEnv, queue, workOwner: providedWorkOwner,
    work: { jobs, generationControllers, jobControls, jobOutputs, generationMessengers }, ask: providedComplete, askLight: providedLight, announce: providedAnnounceJob };
  const say = (zh, en) => providedLanguage === 'en' ? en : zh;
  // The light model of an assist: told to stop when the assist's time limit passes (lib/within-deadline.js).
  const lightUntil = (signal) => (system, text) => providedLight(system, text, { signal });
  // EXPERIMENTAL Jev hooks of the generation pipeline: both undefined unless "Show experimental features" is on and the learner switched the feature on.
  const experimentalHooks = async () => {
    const experimental = await readExperimental(), options = { seam: ports.jev, language: providedLanguage, experimental };
    return { preReview: await jevPreReviewHook(options), jevReview: await jevReviewHook(options) };
  };
const repair = createDraftRepair(ports, { env, managed: repairManaged });
const publish = createDraftPublish(ports, { env, managed: publishManaged });
// A supplement's own publication, behind the same switch, goes the same way: planned, committed through the runtime, and found done after a crash.
const supplementResume = createSupplementResume(ports, { env });
const caseResume = createCaseResume(ports, { env });
const runClose = createRunClose(ports, { env });
const generateHost = { complete: providedComplete, read: () => storagePort.read(), root: storagePort.root, jobs, activeJob, pruneJobs, say, language: providedLanguage, call: providedCall, retrieval: ports.retrieval,
  tokenMeter: ports.tokenMeter, offersModel: ports.offersModel, coverage: ports.coverage, runClose, env,
  execution: { read: () => storagePort.read(), call: providedCall, say, language: providedLanguage, announce: providedAnnounceJob, managed, publishManaged, experimentalHooks, coverage: ports.coverage,
    work: { generationControllers, jobControls, generationMessengers, jobOutputs } } };
const handlers = {
"draft.publish.start": (a) => publish.start(a),
"generate.weakTopics": async function (a) {
      // The learner's weakest topics of a course, from their own answers: local and read-only (no model, nothing written). The course panel offers them as suggestions for 重点知识点.
      const course = typeof a.course === "string" ? a.course : undefined;
      return { topics: weakTopicsFor(await storagePort.read(), course, 8) };
    },
"generate.suggest": async function (a) {
      // The 帮我想想 assist (WP23): read-only, one cheap light-model call over titles, headings, the exam profile and weak topics.
      if (!Array.isArray(a.sourceIds)) throw new Error("generate.suggest needs sourceIds (a list)");
      const course = typeof a.course === "string" ? a.course : undefined;
      const state = await storagePort.read();
      const outlines = sourceOutlines(suggestSources(state.sources, a.sourceIds));
      const weakTopics = weakTopicsFor(state, course);
      const local = localSuggestion({ weakTopics, outlines });
      const basis = { sources: outlines.length, weakTopics: weakTopics.length };
      if (!outlines.length && !weakTopics.length) return { ...local, basis, unavailable: { reason: "no-signal" } };
      if (!providedLight) return { ...local, basis, unavailable: { reason: "no-model" } };
      let profile = null;
      if (course) { try { profile = await providedCall("course.profile", { name: course }); } catch { /* an unregistered course has no stated exam */ } }
      const { system, prompt } = buildSuggestPrompt(suggestionSignals({ course, profile, outlines, weakTopics,
        goal: a.goal }), { language: providedLanguage });
      try {
        return await withinDeadline(ASSIST_TIMEOUT_MS, async (race, signal) => {
          // One call; an answer that cannot be read (not JSON, or not the shape) gets one more try with the exact format, then it is shown, not guessed at.
          const ask = async (text) => {
            const raw = String(await race(lightUntil(signal)(system, text)) ?? "");
            try { return { suggestion: normalizeSuggestion(parseJson(raw)), raw }; } catch { return { raw }; }
          };
          let answer = await ask(prompt);
          if (!answer.suggestion) answer = await ask(suggestRetryPrompt(prompt));
          return suggestAnswer({ local, basis, answer });
        });
      } catch (error) {
        return { ...local, basis, unavailable: modelFailed(error) };
      }
    },
"generate.path.suggest": async function (a) {
      /* 分步出题路径: the plan itself is made locally (lib/generation-path.js: chapters, pages, budget); this asks a light model, over titles and sizes only
         (never the text), to name the steps, say what each practises and suggest an order and a count. Without a model, or when it fails or answers nothing
         usable, the answer says so and the plan stays as it was: it never throws for a model problem. */
      if (!Array.isArray(a?.steps)) throw new Error("generate.path.suggest needs steps (a list)");
      const steps = pathSteps(a.steps);
      if (!steps.length) return pathUnavailable("no-steps");
      if (!providedLight) return pathUnavailable("no-model");
      const { system, prompt } = buildPathPrompt({ course: a.course, goal: a.goal, steps }, { language: providedLanguage });
      try {
        return await withinDeadline(ASSIST_TIMEOUT_MS, async (race, signal) => {
          const ask = (text) => race(completeJson(lightUntil(signal), system, text));
          let reply = await ask(prompt), refined = applyPathRefinement(steps, reply);
          if (refined.source !== "model") {
            reply = await ask(pathRetryPrompt(prompt, steps));
            refined = applyPathRefinement(steps, reply);
          }
          return pathAnswer(refined, reply);
        });
      } catch (error) {
        return pathFailed(error);
      }
    },
"supplement": async function (a) {
      if (typeof a.deckId !== 'string' || !a.deckId.trim()) throw new Error(TARGET.supplementNeedsDeck);
      if (a.mergeTargetId !== undefined && a.mergeTargetId !== a.deckId) throw new Error(TARGET.supplementConflict);
      return handlers.generate({ ...a, mergeTargetId: a.deckId }, { publishTarget: true });
    },
"generate": (a, options) => generate(generateHost, a, options),
/* Weak rubric criteria of a case set become drills (WP12): the supplementation
   pipeline writes, reviews and publishes them into an ordinary deck of the same
   course, scheduled with FSRS-6 from the start. */
"case.drills": async function (a) {
      if (!providedComplete) throw new Error("Configure a model provider and model in the study settings first");
      const s = await storagePort.read();
      const deck = get(s.decks, a.deckId, "Deck");
      if (!isCaseDeck(deck)) throw new Error(say("只有案例分析题组可以生成薄弱项练习", "Only case sets have rubric drills"));
      const latest = new Map();
      for (const attempt of s.attempts) if (attempt.assessment === "rubric" && attempt.deckId === deck.id && attempt.rubric) latest.set(attempt.quiz_id, attempt.rubric);
      const grading = { questions: deck.cards.filter((card) => latest.has(card.id)).map((card, index) => ({ cardId: card.id, n: card.caseQuestion || index + 1,
        criteria: latest.get(card.id).criteria.map((criterion) => ({ ...criterion, ratio: criterion.max ? criterion.score / criterion.max : 0,
          missing: (criterion.missing || []).map((text) => ({ text })) })) })) };
      const wanted = Array.isArray(a.criteria) ? new Set(a.criteria.filter((item) => typeof item === "string")) : null;
      const weak = wanted ? weakCriteria(grading, 1.01).filter((item) => wanted.has(`${item.cardId}:${item.criterionId}`)) : weakCriteria(grading);
      if (!weak.length) throw new Error(say("最近的批改里没有低于 60% 的评分项，暂时不需要针对练习", "No rubric criterion scored below 60% in the latest grading; there is nothing to drill"));
      const sourceIds = [deck.case.sourceId, ...(deck.editorial?.generation?.sourceIds || [])]
        .filter((sourceId, index, all) => all.indexOf(sourceId) === index && s.sources.some((source) => source.id === sourceId));
      if (!sourceIds.length) throw new Error(say("案例原文和课程资料都已删除，无法出练习", "The case and its materials were removed; drills cannot be written"));
      let deckId = deck.case.drillDeckId && s.decks.some((item) => item.id === deck.case.drillDeckId && !item.archived) ? deck.case.drillDeckId : null;
      if (!deckId) {
        deckId = id();
        await storagePort.update((state) => {
          const live = get(state.decks, deck.id, "Deck");
          state.decks.push({ id: deckId, title: say(`${live.title} · 薄弱项练习`, `${live.title} · drills`), course: live.course ?? live.folder ?? "",
            cards: [], createdAt: new Date().toISOString(), publishedAt: new Date().toISOString() });
          live.case.drillDeckId = deckId;
        });
      }
      const started = await handlers.supplement({ deckId, sourceIds, count: Math.min(10, Math.max(2, weak.length * 2)), kind: "mixed",
        focus: drillFocus(weak, { title: deck.title }), language: deck.case.language });
      return { ...started, deckId, criteria: weak.length, count: Math.min(10, Math.max(2, weak.length * 2)) };
    },
/* 重启恢复: a coverage run that was running when the host stopped is not lost. The DRAFT is the checkpoint (lib/coverage-run.js): its marker says 'running' or 'paused' and its plan has rounds that are not
   done, but no job of this process works on it. Each such draft comes back as an INTERRUPTED job (the same id the run had, so what the learner archived stays archived), with the retry 接着做
   (generate { coverage: { run: true } }) that continues at the next round that is not done. A round that was in flight is run again from its start. Idempotent: a draft that already has a job
   in this process (running, or restored earlier) is left alone. Called when the snapshot is read and by the jobs context. */
"coverage.recover": async function () {
      if (runs) await recoverRuns({ runs, restore: restoreRun, read: storagePort.read, memory: queues });
      const root = storagePort.root, state = typeof storagePort.view === "function" ? await storagePort.view() : await storagePort.read();
      const listed = () => [...jobs.values()], look = (archived) => planDraftRecovery({ drafts: state.drafts, jobs: listed(), archived, root });
      if (!look(new Set()).length) return { recovered: 0 };
      const archived = new Set((await jobArchive(root).list().catch(() => [])).flatMap((record) => record.ids || []));
      // Decided in one breath with the registration: no await from here on, so two looks at once do not both bring a run back.
      const found = look(archived);
      for (const item of found) {
        const job = restoredJob(item, { root, language: providedLanguage, say, newId: id, now: new Date().toISOString() });
        recordEvent(job, { level: "error", code: "run-interrupted", args: { round: item.round, rounds: item.spec.rounds.length, inflight: item.inflight[0] ?? null } });
        ownWork(job, providedWorkOwner);
        jobs.set(job.id, job);
      }
      return { recovered: found.length };
    },
"draft.repair": (a) => repair.start(a)
};
// A retry prepares its run again from the arguments the job was asked with (jobs/generation.js): the draft its earlier Attempt saved is continued, not started over.
const prepareRun = async ({ kind, args, runId, persistence }) => {
  if (kind === 'draft-repair') return repair.prepareAgain({ args, runId });
  if (kind === 'draft-publish') return publish.prepareAgain({ args, runId, persistence });
  if (kind === 'generation' && publishManaged) { const finishing = await caseResume.taskFor({ args, runId, persistence }); if (finishing) return finishing; }
  if (kind === 'supplement' && publishManaged) { const finishing = await supplementResume.taskFor({ args, runId, persistence }); if (finishing) return finishing; }
  let prepared;
  await handlers.generate(resumeArgs(args, await storagePort.read(), runId), { publishTarget: kind === 'supplement', take: (task) => { prepared = task; }, self: runId });
  return prepared;
};
const restoreRun = (run) => ports.runtime.jobs.restore(run.kind, { run: run.id }, { prepare: env.prepare, queue, work: env.work, root: storagePort.root, runs, jobs: ports.runtime.jobs, announce: providedAnnounceJob });
Object.assign(handlers, createRetrievalHandlers(ports));
const mutations = {

};
  return { handlers, mutations };
}
