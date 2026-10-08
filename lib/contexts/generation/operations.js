import { resolveQuestionReferences, normalizeQuestionReferenceLimits, normalizeQuestionReferenceFormat } from "../../question-references.js";
import { get, id } from "../../util.js";
import { resolveCourse } from "../../source-courses.js";
import { currentCourse } from "../../focus.js";
import { MAX_SELECTED_CHARS, planGeneration, generateBatched } from "../../batch.js";
import { createRetrievalHandlers, narrowSelection } from "./retrieval-operations.js";
import { GENERATION_TIMEOUT_MS } from "../../generation-limits.js";
import { completeJson, parseJson } from "../../generation.js";
import { applyPathRefinement, MAX_STEPS } from "../../generation-path.js";
import { SUGGEST_GOALS, sourceOutlines, weakTopicsFor, suggestionSignals, buildSuggestPrompt, suggestRetryPrompt, normalizeSuggestion, localSuggestion } from "./suggest.js";
import { ownWork } from "../../runtime/work-ownership.js";
import { mergeContinuedDraft } from '../../bank-import.js';
import { supplementPublication, supplementBudgetPublication } from '../../runtime/jobs.js';
import { caseGenerationArgs, resolveCourseProfile, boundedGuidance, isBlank, isCaseDeck, weakCriteria, drillFocus } from '../../case-study.js';
import { estimateRun, estimateFromState, createTextMeasure, compactEstimate, calibrateEstimate } from '../../token-estimate.js';
import { calibrationFor } from '../../estimate-calibration.js';
import { observedByStage } from '../../stage-usage.js';
import { continuationKindCounts, canContinueDraft } from '../../draft-continuation.js';
import { describePartReport } from '../../generation-report.js';
import { jevPreReviewHook, jevReviewHook } from '../../jev-hooks.js';
import { readExperimental } from '../../experimental.js';
import { requestKinds, resolveGenerationRequest } from '../../generation-settings.js';
import { normalizeNotation, resolveNotation } from '../../notation.js';
import { recordEvent, recordWait } from '../../job-calls.js';
import { holdClock, workClock } from '../../job-parallel.js';
import { generationControl } from '../../job-control.js';
import { partPlanOf, partPlanText } from '../../part-plan.js';
import { mergePlanTargets } from '../../plan-targets.js';
import { sectionsOf } from '../../sections.js';
import { topUpRound, sourcesOfDraft, leafSectionsFor, coverageForDraft, documentTopUp } from '../../coverage-state.js';
import { draftPart, nextPartOf } from '../../deck-parts.js';
import { ROUND_LIMIT, topUpSpec } from '../../coverage-round.js';
import { isLevel, levelOf, autoCompleteOf } from '../../coverage-strength.js';
import { FILL_ROUNDS, STOP_REASONS, roundList, markRound, finishRound, appendFillRound, wantedUncovered, stepOf, progressOf, uncreditedOf, resetRunning, interruptedRounds, roundOfKeys, recordAttempts, sectionRef, unitOfRefs } from '../../coverage-run.js';
import { shortOfPlans } from '../../plan-record.js';
import { newMarker, resumedMarker, mirrorOf, coverCounts, listOf, runStageText, interruptedRuns } from './coverage-runs.js';
import { jobArchive } from '../../job-archive.js';
import { totalTokens } from '../../token-usage.js';
import { isPermanentFailure, classifyFailure } from '../../generation-failure.js';
import { coveragePlan, coverageSpec, coverageRequested, weighsSections } from '../../coverage-plan.js';
import { sectionWeights, lengthWeights } from '../../section-weights.js';
import { COVERAGE_SELECTION_CHARS, GOAL_QUESTIONS_MAX } from '../../limits.js';
import { GENERATION_STAGE_TEXT } from '../jobs/contracts.js';
import { libraryQueue } from './jobs/library-queue.js';
import { startGeneration } from './jobs/submit-generation.js';
import { inputRefOf } from './jobs/input-ref.js';
import { definitionRef } from './jobs/generation.js';
import { createRunStore } from '../../generation-run-store.js';
import { recoverRuns } from './jobs/recover-runs.js';
import { resumeArgs } from './jobs/resume-args.js';
import { createDraftRepair } from './draft-repair.js';
import { createDraftPublish } from './draft-publish.js';
import { createSupplementResume } from './supplement-resume.js';
import { createCaseResume, publishCase } from './case-publish.js';
import { publishDraft, resultOfReceipt } from './jobs/publish-step.js';
import { assertMaterials, notExamPointList } from '../../exam-point-list.js';

/* The sections of the run's sources (lib/sections.js): what each part of the run is said to cover is named from them. A label is a convenience: a source that cannot be divided keeps its title. */
const safeSections = (sources) => { try { return sectionsOf(sources); } catch { return []; } };
const objectivesOf = (decks) => decks.flatMap((deck) => (deck?.cards || []).map((card) => card.objective));
/** The objectives a generation is told not to repeat. Adding to a deck (or continuing a draft) names that deck and draft alone;
    a new draft is told about the whole library, which lib/batch.js narrows to what its materials could repeat. */
function existingFor(state, target, draft) {
  const own = objectivesOf([...(target ? [get(state.decks, target.id, '目标题组')] : []), ...(draft ? [get(state.drafts, draft.id, 'Draft')] : [])]);
  return target ? { existing: own, pinnedExisting: own }
    : { existing: objectivesOf([...state.decks, ...state.drafts]), pinnedExisting: own };
}

/** generation operations close over only the ports declared by this context. */
export function createOperations(ports) {
  const { state: storagePort, workOwner: providedWorkOwner, call: providedCall, announceJob: providedAnnounceJob, complete: providedComplete, light: providedLight, language: providedLanguage } = ports;
  const { jobs, queues, settled, generationMessengers, generationControllers, jobControls, jobOutputs } = ports.work;
  const { activeJob, pruneJobs } = ports.jobServices;
  const queue = libraryQueue({ queues, settled });
  // How a prepared run is queued: behind the switch `runtime.pilot.generation` as a job of the unified runtime, else as it always was (jobs/submit-generation.js).
  const managed = ports.runtime?.pilot?.generation === true;
  // Behind the switch of its own (`generationRestart`) a run is also kept on disk, so that it survives a restart.
  const runs = managed && ports.runtime?.pilot?.generationRestart === true ? createRunStore({ root: storagePort.root, read: storagePort.read, definitionRef }) : undefined;
  const env = { managed, runs, prepare: (request) => prepareRun(request), jobs: ports.runtime?.jobs, sharedQuota: ports.runtime?.sharedQuota === true, feature: ports.runtime?.feature ?? 'generate', queue, workOwner: providedWorkOwner,
    work: { jobs, generationControllers, jobControls, jobOutputs, generationMessengers }, ask: providedComplete, askLight: providedLight, announce: providedAnnounceJob };
  const say = (zh, en) => providedLanguage === 'en' ? en : zh;
  // EXPERIMENTAL Jev hooks of the generation pipeline: both undefined unless "Show experimental features" is on and the learner switched the feature on.
  const experimentalHooks = async () => {
    const experimental = await readExperimental(), options = { seam: ports.jev, language: providedLanguage, experimental };
    return { preReview: await jevPreReviewHook(options), jevReview: await jevReviewHook(options) };
  };
// Behind the switch of its own (`generationRepair`, needs `generation`) the background repair of rejected cards is a job of the runtime as well.
const repair = createDraftRepair(ports, { env, managed: managed && ports.runtime?.pilot?.generationRepair === true });
// Behind the switch of its own (`generationPublish`, needs `generation`) so is the publication of a draft: the check, then the one write, which a crash never makes twice.
const publishManaged = managed && ports.runtime?.pilot?.generationPublish === true;
const publish = createDraftPublish(ports, { env, managed: publishManaged });
// A supplement's own publication, behind the same switch, goes the same way: planned, committed through the runtime, and found done after a crash.
const supplementResume = createSupplementResume(ports, { env });
const caseResume = createCaseResume(ports, { env });
const handlers = {
"draft.publish.start": (a) => publish.start(a),
"generate.suggest": async function (a) {
      // The 帮我想想 assist (WP23): read-only, one cheap light-model call over titles, headings, the exam profile and weak topics.
      if (!Array.isArray(a.sourceIds)) throw new Error("generate.suggest needs sourceIds (a list)");
      const course = typeof a.course === "string" ? a.course : undefined;
      const state = await storagePort.read();
      const wanted = new Set(a.sourceIds.filter((item) => typeof item === "string").slice(0, 500));
      const outlines = sourceOutlines(state.sources.filter((source) => wanted.has(source.id) && notExamPointList(source)));
      const weakTopics = weakTopicsFor(state, course);
      const local = localSuggestion({ weakTopics, outlines });
      const basis = { sources: outlines.length, weakTopics: weakTopics.length };
      if (!outlines.length && !weakTopics.length) return { ...local, basis, unavailable: { reason: "no-signal" } };
      if (!providedLight) return { ...local, basis, unavailable: { reason: "no-model" } };
      let profile = null;
      if (course) { try { profile = await providedCall("course.profile", { name: course }); } catch { /* an unregistered course has no stated exam */ } }
      const { system, prompt } = buildSuggestPrompt(suggestionSignals({ course, profile, outlines, weakTopics,
        goal: SUGGEST_GOALS.includes(a.goal) ? a.goal : undefined }), { language: providedLanguage });
      let timer;
      try {
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("The model did not respond in time (timeout)")), 45000); });
        // One call; an answer that cannot be read (not JSON, or not the shape) gets one more try with the exact format, then it is shown, not guessed at.
        const ask = async (text) => {
          const raw = String(await Promise.race([providedLight(system, text), timeout]) ?? "");
          try { return { suggestion: normalizeSuggestion(parseJson(raw)), raw }; } catch { return { raw }; }
        };
        let answer = await ask(prompt);
        if (!answer.suggestion) answer = await ask(suggestRetryPrompt(prompt));
        clearTimeout(timer);
        // Whichever way the model answers, the learner is left with their own data.
        return answer.suggestion ? { source: "model", ...answer.suggestion, basis }
          : { ...local, basis, unavailable: { reason: "nothing-usable", sample: answer.raw.replace(/\s+/g, " ").trim().slice(0, 200) } };
      } catch (error) {
        clearTimeout(timer);
        return { ...local, basis, unavailable: { reason: "failed", message: String(error?.message || error).slice(0, 300) } };
      }
    },
"generate.path.suggest": async function (a) {
      /* 分步出题路径: the plan itself is made locally (lib/generation-path.js: chapters, pages, budget); this asks a light model, over titles and sizes only
         (never the text), to name the steps, say what each practises and suggest an order and a count. Without a model, or when it fails or answers nothing
         usable, the answer says so and the plan stays as it was: it never throws for a model problem. */
      if (!Array.isArray(a?.steps)) throw new Error("generate.path.suggest needs steps (a list)");
      const clipText = (value, length) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, length);
      const steps = a.steps.slice(0, MAX_STEPS).filter((step) => step && typeof step.id === "string")
        .map((step) => ({ id: clipText(step.id, 40), title: clipText(step.title, 120), pages: Math.max(0, Math.round(Number(step.pages) || 0)), chars: Math.max(0, Math.round(Number(step.chars) || 0)) }));
      if (!steps.length) return { source: "local", steps: [], unavailable: { reason: "no-steps" } };
      if (!providedLight) return { source: "local", steps: [], unavailable: { reason: "no-model" } };
      const goal = SUGGEST_GOALS.includes(a.goal) ? a.goal : undefined;
      const target = providedLanguage === "en" ? "English" : "中文 (Chinese)";
      const system = `You plan how a learner works through a big book chapter by chapter with an AI that writes questions from their own materials. You receive only the steps of the plan (id, title, pages, characters), in book order. Return JSON only: {"steps": [{"id": "an id from the input", "title": "a short clear name, at most 60 characters", "focus": "what the questions of this step should practise, one short sentence, at most 120 characters", "count": integer 6-30 (how many questions this step deserves), "reason": "why it comes here, at most 80 characters"}]} listing EVERY step once, in the order you recommend (keep the book order unless a step clearly depends on a later one). Never add or remove steps, never change which pages a step covers. Write names, focus and reason in ${target}.`;
      const prompt = JSON.stringify({ course: typeof a.course === "string" ? clipText(a.course, 120) : undefined, goal, steps });
      let timer;
      try {
        const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("The model did not respond in time (timeout)")), 45000); });
        const ask = (text) => Promise.race([completeJson(providedLight, system, text), timeout]);
        let reply = await ask(prompt), refined = applyPathRefinement(steps, reply);
        // One more try, saying what was wrong: a reply that does not list the steps by their exact ids is the usual slip.
        if (refined.source !== "model") {
          reply = await ask(`${prompt}

Your previous reply could not be used: it did not list the steps by their exact ids. Reply with ONLY {"steps":[{"id": ...}]} listing EVERY one of these ids once, in your recommended order: ${steps.map((step) => step.id).join(", ")}.`);
          refined = applyPathRefinement(steps, reply);
        }
        clearTimeout(timer);
        return refined.source === "model" ? { source: "model", steps: refined.steps }
          : { source: "local", steps: [], unavailable: { reason: "nothing-usable", sample: JSON.stringify(reply ?? null).slice(0, 200) } };
      } catch (error) {
        clearTimeout(timer);
        return { source: "local", steps: [], unavailable: { reason: "failed", message: String(error?.message || error).slice(0, 300) } };
      }
    },
"supplement": async function (a) {
      if (typeof a.deckId !== 'string' || !a.deckId.trim()) throw new Error('补题需要明确的目标题组 deckId');
      if (a.mergeTargetId !== undefined && a.mergeTargetId !== a.deckId) throw new Error('补题目标冲突');
      return handlers.generate({ ...a, mergeTargetId: a.deckId }, { publishTarget: true });
    },
"generate": async function (a, { publishTarget = false, take = null, self } = {}) {
      // `take`: hand the prepared run to the caller instead of queueing it (a retry prepares its own run); `self`: the logical job that is preparing, which is not its own rival.
      const mine = (job) => self !== undefined && job.contract?.jobId === self;
      if (!providedComplete)
        throw new Error(
          "Configure a model provider and model in the study settings first",
        );
      const s = await storagePort.read();
      const previous = a.resumeDraftId ? get(s.drafts, a.resumeDraftId, "Draft") : null;
      // 用未覆盖的资料补题: the continuation of an open draft, written from these sources only and added to that same draft.
      const extraIds = a.extraSourceIds === undefined ? null : [...new Set(Array.isArray(a.extraSourceIds) ? a.extraSourceIds.filter((item) => typeof item === "string") : [])];
      if (extraIds) {
        if (!previous) throw new Error(say("补题需要指定目标草稿（resumeDraftId）", "Adding from sources needs the target draft (resumeDraftId)"));
        assertMaterials(s.sources.filter((source) => extraIds.includes(source.id)));
        if (!extraIds.length || extraIds.some((sourceId) => !s.sources.some((source) => source.id === sourceId)))
          throw new Error(say("请选择题组可用的资料", "Choose sources that are still in the library"));
        if (!Number.isInteger(a.count) || a.count < 1 || a.count > 30) throw new Error(say("补题题数需在 1–30 之间", "Choose 1–30 questions to add"));
      }
      // 为没覆盖的部分补题: the continuation that is asked for the sections of the draft's material that have no question (lib/coverage-round.js), not for a number of questions.
      // `coverage.run` is 接着做 / 继续补完: the rounds of the draft's plan from the next one that is not done, one after another (lib/coverage-run.js).
      const coverageAsked = a.coverage === undefined || a.coverage === null ? null : a.coverage;
      // 为没覆盖的部分补题 of a PUBLISHED deck's material (lib/deck-parts.js): never in place. A NEW draft whose targets are exactly the document's sections without a question; published into the
      // deck it becomes the deck's next part. `documentId` names the document (its key, its id or any of its sources: coverage.get's `key`), `partOf` the deck when several hold its questions.
      const partAsked = a.documentId !== undefined && a.documentId !== null;
      if (partAsked) {
        if (typeof a.documentId !== "string" || !a.documentId.trim()) throw new Error(say("documentId 需要是资料的标识", "documentId must name a document"));
        if (previous || extraIds || publishTarget || a.mergeTargetId !== undefined) throw new Error(say("为资料补题会新建一份草稿，不能同时指定草稿或目标题组", "Topping up a document makes a new draft: it cannot be combined with resumeDraftId, extraSourceIds or mergeTargetId"));
        if (!coverageAsked || coverageAsked.run !== undefined) throw new Error(say("为资料补题需要 coverage: { sectionIds?, autoComplete?, tokenBudget? }", "Topping up a document needs coverage: { sectionIds?, autoComplete?, tokenBudget? }"));
        if (a.partOf !== undefined && (typeof a.partOf !== "string" || !a.partOf)) throw new Error(say("partOf 需要是题组的标识", "partOf must be a deck id"));
      }
      if (coverageAsked) {
        if (!previous && !partAsked) throw new Error(say("按覆盖补题需要指定目标草稿（resumeDraftId）", "Covering the missing sections needs the target draft (resumeDraftId)"));
        if (extraIds) throw new Error(say("按覆盖补题不能同时指定补题资料（extraSourceIds）", "Covering the missing sections cannot be combined with extraSourceIds"));
        if (typeof coverageAsked !== "object" || Array.isArray(coverageAsked) || Object.keys(coverageAsked).some((key) => !["sectionIds", "run", "autoComplete", "tokenBudget"].includes(key)) ||
            (coverageAsked.sectionIds !== undefined && (!Array.isArray(coverageAsked.sectionIds) || coverageAsked.sectionIds.some((item) => typeof item !== "string"))) ||
            (coverageAsked.run !== undefined && typeof coverageAsked.run !== "boolean") || (coverageAsked.autoComplete !== undefined && typeof coverageAsked.autoComplete !== "boolean") ||
            (coverageAsked.tokenBudget !== undefined && !(Number.isInteger(coverageAsked.tokenBudget) && coverageAsked.tokenBudget >= 1000)))
          throw new Error(say("coverage 只接受 { sectionIds: [小节的标识], run, autoComplete, tokenBudget }", "coverage takes { sectionIds, run, autoComplete, tokenBudget } only"));
      }
      const runAsked = coverageAsked?.run === true, priorRun = previous?.editorial?.coverageRun || {};
      let plannedSpec = previous?.editorial?.coverageSpec;
      if (runAsked && coverageAsked.sectionIds !== undefined) throw new Error(say("接着做不能同时指定小节（sectionIds）", "Continuing the run cannot be combined with sectionIds"));
      if (runAsked && !plannedSpec?.rounds?.length) throw new Error(say("这份草稿没有出题计划，不能接着做；请用「为没覆盖的部分补题」", "This draft has no coverage plan to continue; use 为没覆盖的部分补题"));
      if (previous) {
        if (previous.editingDeckId || !previous.editorial?.generation?.sourceIds?.length ||
            !Number.isInteger(previous.editorial.requested))
          throw new Error("这份草稿没有可继续的生成记录，请从资料重新出题");
        if (!Number.isInteger(a.draftVersion) || a.draftVersion !== previous.draftVersion)
          throw new Error("草稿已更新，请刷新后再继续补题");
        if ([...jobs.values()].some((job) => job.root === storagePort.root && job.draftId === previous.id && activeJob(job) && !mine(job)))
          throw new Error("这份草稿正在生成，请等待当前任务完成");
      }
      // 覆盖强度: a NEW draft from sources is asked for a coverage level (lean / standard / full: lib/coverage-strength.js) and, optionally, a total number of questions (any whole number up to
      // GOAL_QUESTIONS_MAX; what does not fit in one round of ROUND_LIMIT questions becomes rounds). A caller that sends only `count` up to ROUND_LIMIT is planned exactly as it always was.
      if (a.coverageLevel !== undefined && a.coverageLevel !== null && !isLevel(a.coverageLevel)) throw new Error(say("覆盖强度只能是 lean、standard 或 full", "coverageLevel must be lean, standard or full"));
      const wantsCoverage = !previous && !extraIds && !coverageAsked && !publishTarget && a.kind !== "case" && coverageRequested(a);
      if (wantsCoverage && a.count !== undefined && a.count !== null && (!Number.isInteger(a.count) || a.count < 1 || a.count > GOAL_QUESTIONS_MAX))
        throw new Error(say(`请选择 1–${GOAL_QUESTIONS_MAX} 道题`, `Choose 1–${GOAL_QUESTIONS_MAX} questions`));
      if (wantsCoverage && a.autoComplete !== undefined && typeof a.autoComplete !== "boolean") throw new Error(say("autoComplete 只能是 true 或 false", "autoComplete must be true or false"));
      if (wantsCoverage && a.tokenBudget !== undefined && !(Number.isInteger(a.tokenBudget) && a.tokenBudget >= 1000)) throw new Error(say("tokenBudget 需要是不小于 1000 的整数", "tokenBudget must be a whole number of at least 1000 tokens"));
      const roundLimit = ports.coverage?.roundLimit ?? ROUND_LIMIT, fillRounds = ports.coverage?.fillRounds ?? FILL_ROUNDS;
      // The document, the deck the new draft is for (its next part) and the round of the screen. Refused while another top-up of the same document is starting (its draft is not saved yet).
      let part = null;
      if (partAsked) {
        const found = documentTopUp(s, { documentId: a.documentId }, { partOf: a.partOf, limit: roundLimit });
        if (!found) throw new Error(say("找不到这份资料", "This document is not in the library"));
        if (!found.candidates.length) throw new Error(say("这份资料的题还没有发布到题组；请在草稿页为没覆盖的部分补题", "No published deck holds this document's questions yet; top up its draft instead"));
        if (!found.chosen || (a.partOf === undefined && found.candidates.length > 1))
          throw new Error(say(`这份资料的题在 ${found.candidates.length} 个题组里，请用 partOf 说明补的是哪个题组：${found.candidates.map((item) => `「${item.title}」(${item.id})`).join("、")}`,
            `This document's questions are in ${found.candidates.length} decks; say which one with partOf: ${found.candidates.map((item) => `"${item.title}" (${item.id})`).join(", ")}`));
        if ([...jobs.values()].some((job) => job.root === storagePort.root && job.part?.documentKey === found.item.key && activeJob(job) && !mine(job)))
          throw new Error(say("这份资料正在补题，请等这一份草稿做完", "This document is already being topped up; wait for that draft"));
        const deck = get(s.decks, found.chosen.id, "题组");
        part = { found, deck, n: found.chosen.nextPart, documentKey: found.item.key, sourceIds: found.draft.editorial.generation.sourceIds };
      }
      // A draft that already is a part (its next round, 接着做 after a restart) keeps saying whose part it is.
      const previousDeck = previous && draftPart(previous) ? s.decks.find((deck) => deck.id === draftPart(previous).deckId && !deck.archived) : null;
      const previousPart = previousDeck ? { deckId: previousDeck.id, deckTitle: previousDeck.title, n: nextPartOf(previousDeck) } : null;
      const request = previous ? {
        ...previous.editorial.generation,
        count: extraIds ? a.count : previous.editorial.requested - previous.cards.length,
        ...(extraIds ? { sourceIds: extraIds } : {}),
        title: previous.title,
        folder: previous.folder,
        course: resolveCourse(s, {}, { course: previous.course ?? previous.editorial.generation.course ?? previous.folder ?? '', preferred: currentCourse(s) }),
      } : part ? {
        // A part keeps the settings its deck was written with (kind, language, difficulty, notation, performance) and the deck's course; it is named after the material until the learner publishes it.
        ...Object.fromEntries(Object.entries(a).filter(([key]) => !["documentId", "partOf", "coverage", "sourceIds", "mergeTargetId"].includes(key))),
        sourceIds: part.sourceIds, title: typeof a.title === "string" && a.title.trim() ? a.title : part.found.item.title, course: part.deck.course ?? part.deck.folder ?? '',
      } : { ...a, course: resolveCourse(s, a, { preferred: currentCourse(s) }) };
      Object.assign(request, resolveGenerationRequest(s.settings?.generation,
        { ...request, performance: a.performance },
        { language: providedLanguage, continuation: previous?.editorial.generation ?? part?.deck.editorial?.generation }));
      const targetId = previous ? previous.mergeTargetId ?? request.mergeTargetId : a.mergeTargetId;
      const target = targetId !== undefined ? get(s.decks, targetId, '目标题组') : null;
      if (publishTarget && target?.id !== a.deckId) throw new Error('续补草稿的目标与 deckId 不一致');
      if (target) {
        if (target.archived || target.systemKind) throw new Error('只能并入未归档的普通题组');
        request.mergeTargetId = target.id;
        request.course = target.course ?? target.folder ?? '';
      }
      // 接着做: where the plan of the draft stands now. A round that was running when the host stopped is pending again; the first step is the next planned round, else a fill round for the sections that
      // were planned and did not come out. (The learner asked for it, so the retry bound of a run starts again.)
      let runStart = null;
      if (runAsked) {
        const fresh = resetRunning(plannedSpec);
        runStart = stepOf({ spec: fresh, uncovered: wantedUncovered(fresh, coverageForDraft(s, previous)), run: { autoComplete: true, fillUsed: 0, tokensUsed: 0 }, fillRounds });
        if (runStart.type === "stop") throw new Error(say("这份草稿的出题计划已经完成，没有可以接着做的轮次", "The coverage plan of this draft is complete: there is no round to continue"));
      }
      // The round the screen showed (or, without section keys, the default round: the next round of the plan): which sections, how many questions, and what the planner is given.
      const covering = runStart ? topUpRound(s, previous, { sectionIds: runStart.keys, fit: true, batchSize: request.performance?.batchSize, limit: roundLimit })
        : part ? (() => { const found = documentTopUp(s, { documentId: a.documentId }, { partOf: part.deck.id, sectionIds: coverageAsked.sectionIds, batchSize: request.performance?.batchSize, limit: roundLimit });
          // The plan of a part is made over the sections nobody is working on (`planning`); what it says (覆盖现在 …) is the document's coverage.
          return { coverage: found.planning, round: found.round, request: found.request, inFlight: found.inFlight }; })()
        : coverageAsked ? topUpRound(s, previous, { sectionIds: coverageAsked.sectionIds, batchSize: request.performance?.batchSize, limit: roundLimit }) : null;
      if (covering?.round.error) {
        const reason = covering.round.error;
        throw new Error(reason === "covered" ? say("这些小节已经有题了，请刷新后再补题", "Some of these sections already have questions; refresh and try again")
          : reason === "too-many" ? say("一轮最多补 30 道题，请少选几个小节", "One round adds at most 30 questions; choose fewer sections")
          : say("资料或草稿已变化，找不到这些小节，请刷新后再补题", "The material or the draft changed and these sections cannot be found; refresh and try again"));
      }
      if (covering && !covering.round.questions && covering.inFlight > 0) throw new Error(say("没覆盖的小节正在另一份草稿里补题，请到那份草稿继续", "The sections without a question are already being topped up in another draft; continue that draft"));
      if (covering && !covering.round.questions) throw new Error(say("所有小节都已经有题了，无需补题", "Every section already has questions; there is nothing to add"));
      // 为没覆盖的部分补题 on a draft that has no plan (a plain run, asked for a number of questions): its uncovered sections ARE the plan of a run, rounds of at most `roundLimit` questions one after another
      // until every section has a question (lib/coverage-round.js topUpSpec); the executor below is the ONE executor of a coverage run, nothing else loops. The draft keeps the plan like any other.
      // (Only when the rounds are to go on by themselves: `autoComplete` asked for, or not said while no section was chosen. A caller that chose sections and said nothing gets the one round it chose, as it always did.)
      // A part of a deck always has its plan (its rounds may also wait for the learner: 自动补到完整 off).
      const synthesized = !!covering && !runAsked && !plannedSpec?.rounds?.length && (!!part || (coverageAsked.autoComplete ?? coverageAsked.sectionIds === undefined));
      if (synthesized) plannedSpec = topUpSpec(covering.coverage, { kept: previous?.cards.length ?? 0, limit: roundLimit });
      if (previous && !extraIds && !covering && requestKinds(request).length > 1) {
        const kindCounts = continuationKindCounts(previous);
        if (kindCounts) request.kindCounts = kindCounts;
      }
      if (request.kind && !["quiz", "multi", "flashcard", "open", "cloze", "mixed", "case"].includes(request.kind))
        throw new Error("Unknown question kind");
      // A case-study paper (WP12): its exam settings, guidance and focus topics default from the course profile.
      if (request.kind === "case") {
        // Ordinary question-count defaults do not describe an exam paper.
        if (a.count === undefined) delete request.count;
        if (previous || target) throw new Error(say("案例分析题不能续补或并入已有题组", "A case paper cannot continue a draft or merge into a deck"));
        // 再来一个同类案例: the same materials and paper shape as an earlier case set.
        if (typeof request.fromDeckId === "string") {
          const from = [...s.decks, ...s.drafts].find((deck) => deck.id === request.fromDeckId), earlier = from?.editorial?.generation;
          if (!from || earlier?.kind !== "case") throw new Error(say("找不到可以仿照的案例", "No earlier case to follow"));
          for (const key of ["sourceIds", "language", "styleText", "referenceSourceIds", "referenceLimits", "referenceFormat"]) if (a[key] === undefined && earlier[key] !== undefined) request[key] = earlier[key];
          if (request.questions === undefined) request.questions = Math.min(5, earlier.questions || 2);
          if (request.totalMarks === undefined) request.totalMarks = earlier.totalMarks;
          if (a.course === undefined) request.course = from.course ?? from.folder ?? "";
        }
        request.case = caseGenerationArgs(request, { say, profile: await resolveCourseProfile(providedCall, request.course) });
        request.count = request.case.questions;
      }
      if (request.constraints !== undefined && (!request.constraints || typeof request.constraints !== 'object' || Array.isArray(request.constraints) ||
          Object.entries(request.constraints).some(([key, value]) => !['topicNoAnswer', 'hintNoAnswer', 'oneTargetPerStem', 'optionsSameAxis'].includes(key) || typeof value !== 'boolean')))
        throw new Error('constraints accepts boolean topicNoAnswer, hintNoAnswer, oneTargetPerStem and optionsSameAxis only');
      // A coverage run is sized by its plan (below); every other run asks for 1 to ROUND_LIMIT questions, as it always did.
      let count = covering ? covering.round.questions : Number(request.count ?? 10);
      if (!wantsCoverage && (!Number.isInteger(count) || count < 1 || count > (covering ? roundLimit : ROUND_LIMIT)))
        throw new Error(previous ? "草稿已达到请求的题数，无需补题" : "Choose 1–30 questions");
      if (previous && a.referenceSourceIds !== undefined) request.referenceSourceIds = a.referenceSourceIds;
      if (previous && a.referenceLimits !== undefined) request.referenceLimits = a.referenceLimits;
      if (previous && a.referenceFormat !== undefined) request.referenceFormat = a.referenceFormat;
      request.referenceLimits = normalizeQuestionReferenceLimits(request.referenceLimits);
      request.referenceFormat = normalizeQuestionReferenceFormat(request.referenceFormat);
      request.questionReferences = resolveQuestionReferences(s, request);
      request.referenceSourceIds = request.questionReferences.map(source => source.id);
      let sources = s.sources.filter((x) => request.sourceIds?.includes(x.id));
      assertMaterials(sources);
      if (previous && sources.length !== new Set(request.sourceIds).size)
        throw new Error("原出题资料已有缺失，请先恢复资料再继续补题");
      if (!sources.length && !request.case?.scenario) throw new Error("Select at least one source");
      // The sections of the whole material name what each part covers; the run itself is written from the text of the chosen sections only (pieces that remember where they were cut).
      const fullSources = sources;
      if (covering) sources = covering.request.sources;
      const reuse = covering?.request.reuse || [];
      let planCount = covering ? covering.request.count : count;
      // A large selection is narrowed to the pages a retrieval provider finds for the topic (WP28); a continued draft keeps its sources. A coverage run reads its whole selection (each planning call is
      // given only the sections assigned to it), so it is narrowed only when it is over the bound of COVERAGE_SELECTION_CHARS or the learner asked for retrieval.
      const narrowing = previous || part || request.case ? null : await narrowSelection({ port: ports.retrieval, sources, request, ...(wantsCoverage ? { limit: COVERAGE_SELECTION_CHARS, above: COVERAGE_SELECTION_CHARS } : {}) });
      if (narrowing) sources = narrowing.sources;
      // The plan of a coverage run, made now from the lengths of the sections (the job card and the estimate need it at once) and made again from the model's importance weights when the job runs.
      let coverageRun = null, assignments = covering ? covering.request.assignments : undefined;
      if (wantsCoverage) {
        const leaves = leafSectionsFor(s, sources);
        if (!leaves.length) throw new Error(say("所选资料里没有可以出题的文字", "The selected sources have no text to write questions from"));
        const first = coveragePlan({ leaves, weights: lengthWeights(leaves), level: levelOf(a.coverageLevel), goalCount: Number.isInteger(a.count) ? a.count : undefined, limit: roundLimit });
        coverageRun = { level: first.plan.level, goalCount: Number.isInteger(a.count) ? a.count : undefined, leaves, goal: first.plan.goal, rounds: first.rounds.length, covered: first.plan.mustCover };
        ({ questions: count } = first.rounds[0]);
        planCount = count;
        assignments = first.rounds[0].assignments;
      }
      // 公式写法: the learner's choice stays on the draft (补题/修题 reuse it); "auto" is resolved once per run from this run's sources.
      request.notation = normalizeNotation(request.notation);
      request.notationResolved = resolveNotation(request.notation, sources);
      const chars = sources.reduce((n, x) => n + x.text.length, 0), selectionLimit = coverageRun ? COVERAGE_SELECTION_CHARS : MAX_SELECTED_CHARS;
      if (chars > selectionLimit)
        throw Object.assign(new Error(
          `Selected sources total ${chars} characters; the limit is ${selectionLimit}. Select fewer sources.`,
        ), { code: 'selection-too-large' });
      // What this run was asked, frozen with the draft that checkpoints it (jobs/input-ref.js): a later run judges whether the checkpoint still fits it.
      // A draft that is continued keeps what its first run was asked: the later run is judged against that, never against what is left to ask (a top-up asks for more, so it freezes anew).
      const keptRef = previous?.editorial?.generation?.inputRef;
      const inputRef = keptRef && !extraIds ? keptRef : inputRefOf({ definition: definitionRef(publishTarget ? 'supplement' : 'generation'), request: { ...request, count }, sources: fullSources,
        ...(extraIds ? { extraSourceIds: extraIds, added: a.count } : {}) });
      // The plan this job executes rounds of (lib/coverage-run.js): a new coverage run, 接着做, or a top-up of a draft that kept its plan. `spec` is the plan with each round's state; the draft keeps it
      // (`editorial.coverageSpec`) together with the marker of the run (`editorial.coverageRun`) at every boundary, so the DRAFT is the checkpoint.
      let plan = null;
      if (wantsCoverage || (covering && plannedSpec?.rounds?.length)) {
        const auto = wantsCoverage ? (a.autoComplete ?? autoCompleteOf(a.coverageLevel)) : runAsked ? (coverageAsked.autoComplete ?? priorRun.autoComplete ?? true) : (coverageAsked.autoComplete ?? synthesized);
        // Where the job starts: the sections that already have a question are not its work (its progress is counted from here; lib/job-contract.js coverOf).
        const startView = wantsCoverage ? null : part ? covering.coverage : coverageForDraft(s, previous);
        plan = { auto, tokenBudget: wantsCoverage ? a.tokenBudget : (coverageAsked.tokenBudget ?? priorRun.tokenBudget), resumed: runAsked, newRun: wantsCoverage, spec: wantsCoverage ? null : resetRunning(plannedSpec),
          rerun: runAsked ? interruptedRounds(plannedSpec) : [], first: runStart, marker: null, fills: 0, round: 1, percent: startView ? startView.percentLeaves : 0, tokensBase: previous ? priorRun.tokensUsed || 0 : 0, estimate: null, started: false,
          cover: { leaves: startView ? startView.leaves : coverageRun.leaves.length, covered: startView ? startView.covered : 0, atStart: startView ? startView.covered : 0, ...(!auto && covering?.round.sections > 0 ? { fixed: covering.round.sections } : {}) } };
      }
      pruneJobs();
      const root = storagePort.root,
        ahead = [...jobs.values()].filter((j) => j.root === root && activeJob(j) && !mine(j)).length,
        planned = request.case ? null : planGeneration({ sources, count: planCount, kind: request.kind, kinds: request.kinds, kindCounts: request.kindCounts, performance: request.performance, reuse, assignments }),
        parts = planned ? planned.length : 1;
      // What a run that goes on by itself is working towards: the whole plan; every other job asks for the questions of its own round.
      const planGoal = plan ? (coverageRun?.goal ?? plannedSpec?.goal ?? count) : 0;
      const job = {
        id: id(),
        root,
        ...(target ? { mergeTargetId: target.id } : {}),
        ...(publishTarget ? { type: 'supplement', targetTitle: target.title } : {}),
        // A new draft that will be the next part of a deck (lib/deck-parts.js): the 任务 console says 「Deck · 第二部分」, and a second top-up of the same document waits for it.
        ...(part ? { part: { deckId: part.deck.id, deckTitle: part.deck.title, n: part.n, documentKey: part.documentKey } } : previousPart ? { part: previousPart } : {}),
        sourceIds: [...new Set([...(plan ? fullSources : sources), ...reuse.flatMap((group) => group.sources)].map((source) => source.id))],
        ...(narrowing?.retrieval ? { retrieval: narrowing.retrieval } : {}),
        status: ahead ? "queued" : "running",
        stage: ahead ? "Waiting for the previous generation" : "Writing source-grounded questions",
        kind: request.kind || "quiz",
        ...(requestKinds(request).length > 1 ? { kinds: requestKinds(request) } : {}),
        course: request.course,
        count,
        requestedTotal: previous ? covering ? (plan?.auto ? Math.max(planGoal, previous.cards.length + count) : previous.cards.length + count) : previous.editorial.requested + (extraIds ? count : 0) : (plan?.auto ? planGoal : count),
        ...(coverageRun ? { coveragePlan: { level: coverageRun.level, goal: coverageRun.goal, round: 1, rounds: coverageRun.rounds, sections: coverageRun.covered, weights: 'length' } }
          : plan ? { coveragePlan: { level: plannedSpec.level, goal: plannedSpec.goal, round: runStart?.index !== undefined ? plannedSpec.rounds[runStart.index].round : plannedSpec.rounds.length, rounds: plannedSpec.rounds.length, sections: plannedSpec.mustCover, weights: plannedSpec.weightSource } } : {}),
        ...(plan ? { coverageRun: { autoComplete: plan.auto, state: 'running', list: plan.spec ? listOf(plan.spec) : [], percent: plan.percent, ...coverCounts(plan.cover), tokensUsed: plan.tokensBase, startedAt: new Date().toISOString(), ...(plan.tokenBudget ? { tokenBudget: plan.tokenBudget } : {}), ...(previous ? { draftId: previous.id } : {}) } } : {}),
        // `askedQuestions`: what this job itself is asked to write (the pending rounds of its plan when it goes on by itself, else its one round or request): its own progress is counted against it.
        ...(previous ? { draftId: previous.id, deckTitle: previous.title, savedCount: previous.cards.length, savedAtStart: previous.cards.length, continued: true,
            askedQuestions: plan?.auto ? roundList(plan.spec).filter((round) => round.status !== 'done' && round.status !== 'skipped').reduce((sum, round) => sum + round.questions, 0) || count : count,
            ...(extraIds ? { extraSources: sources.length } : {}) }
          // The progress card names the requested deck before its first draft is saved (P28).
          : typeof request.title === "string" && request.title.trim() ? { deckTitle: request.title.trim() } : {}),
        parts,
        // What each part covers (its source ids and a short range), known from the start so a waiting part can be followed to its material (the 任务 console).
        ...(planned ? { partPlan: partPlanOf(planned, partPlanText(providedLanguage), { sections: safeSections(fullSources) }) } : {}),
        ...(covering ? { coverage: { sections: covering.round.sections, questions: covering.round.questions, reused: covering.round.reused, left: covering.round.left } } : {}),
        steps: [],
        concurrency: request.case ? 1 : request.performance.concurrency,
        batchSize: request.case ? count : request.performance.batchSize,
        generationTimeoutSeconds: GENERATION_TIMEOUT_MS / 1000,
        totalTimeoutSeconds: request.performance.jobTimeoutMinutes * 60,
        messages: [],
        startedAt: new Date().toISOString(),
      };
      job.language = providedLanguage;
      // What this run is expected to use, kept to set beside what it did use (WP27); never a reason to refuse or fail.
      try {
        const measure = createTextMeasure({ tokenMeter: ports.tokenMeter });
        const raw = (request.case
          ? estimateRun('case', { language: request.language, ...request.case, sources, questionReferences: request.questionReferences, referenceFormat: request.referenceFormat,
            guidance: boundedGuidance(s.sources.filter((source) => request.case.guidanceSourceIds.includes(source.id))) }, { measure })
          : estimateRun('generate', { sources, count: planCount, assignments, reuse, coverageSections: covering?.request.titles, kind: request.kind, kinds: request.kinds, kindCounts: request.kindCounts, difficulty: request.difficulty, language: request.language,
            questionReferences: request.questionReferences, referenceFormat: request.referenceFormat, focus: request.focus, role: request.role, constraints: request.constraints, course: request.course, title: request.title, performance: request.performance,
            ...existingFor(s, target, previous) }, { measure }));
        // This library's own earlier runs correct the range (lib/estimate-calibration.js); the job keeps the uncalibrated stage totals the next ratio is read against.
        const factors = await calibrationFor(root).factors().catch(() => null);
        job.estimate = compactEstimate(calibrateEstimate(raw, factors), raw);
        // The estimator's number for what the run still has to do (the console says it, labelled 预计, until the rounds done give a better one): a new run is priced like the form priced it, whole.
        if (plan) {
          if (wantsCoverage) {
            const whole = estimateFromState('generate', { sourceIds: sources.map((source) => source.id), coverageLevel: a.coverageLevel, ...(Number.isInteger(a.count) ? { count: a.count } : {}), kind: a.kind, kinds: a.kinds, language: a.language, performance: a.performance },
              s, { tokenMeter: ports.tokenMeter, language: providedLanguage, roundLimit });
            if (whole.totalTokens?.high > 0) plan.estimate = { tokens: calibrateEstimate(whole, factors).totalTokens };
          } else if (job.estimate.totalTokens?.high > 0 && count > 0) {
            const left = roundList(plan.spec).filter((round) => round.status !== 'done' && round.status !== 'skipped').reduce((sum, round) => sum + round.questions, 0), scale = Math.max(1, left) / count;
            plan.estimate = { tokens: { low: Math.round(job.estimate.totalTokens.low * scale), high: Math.round(job.estimate.totalTokens.high * scale) } };
          }
          if (plan.estimate) job.coverageRun.estimate = plan.estimate;
        }
      } catch { /* an estimate is a convenience */ }
      // One run per draft, decided in one breath with the registration of the job: two calls that both passed the check above (they await) do not both start.
      if (previous && [...jobs.values()].some((other) => other.root === root && other.draftId === previous.id && activeJob(other) && !mine(other)))
        throw new Error("这份草稿正在生成，请等待当前任务完成");
      // Once the new job exists: an interrupted run of the draft is replaced by it, and a plain run it continues says by which task.
      const supersede = (newId) => {
        if (!previous) return;
        for (const [jobId, other] of jobs) {
          if (other.root !== root || other.draftId !== previous.id || jobId === newId) continue;
          if (other.coverageRun && (other.status === "interrupted" || (other.status === "failed" && other.retryable))) jobs.delete(jobId);
          // A plain run that was continued stays in the list as it ended (its numbers do not move), says by which task it was continued and offers nothing more (lib/job-contract.js `continued`).
          else if (!other.coverageRun && other.retryable === true && !activeJob(other)) other.continuedBy = newId;
        }
      };
      // The learner's live hand on this run (the 任务 console): concurrency, the model of this run alone and the reasoning of each stage; for a coverage run also pause (no new model call starts, the running ones finish; lib/batch.js) and 自动补到完整. It lasts as long as the job.
      const makeControl = (card) => generationControl({ job: card, request, offers: ports.offersModel, ...(plan ? { rounds: { autoComplete: plan.auto, onAuto: (value) => plan.onAuto?.(value),
        onPaused: () => plan.onPaused?.() } } : {}) });
      // `runId`: what the run is called across Attempts (the runtime's logical job; the job's own id when it is not one). `checkpoint(draft)`: told after every save of the run's draft.
      const execute = async ({ job, control, controller, models, runId = job.id, checkpoint, commit, plans }) => {
        const scenarioSourceId = request.case ? `scenario-${runId}` : undefined;
        if (controller.signal.aborted) {
          job.status = "cancelled";
          job.finishedAt ||= new Date().toISOString();
          generationControllers.delete(job.id);
          jobControls.delete(job.id);
          control.close();
          // A run of the runtime is announced by its settlement sink (jobs/notices.js), once, whatever the mode.
          if (!managed) providedAnnounceJob(job);
          return;
        }
        // The time limit: one run of a plain job has `jobTimeoutMinutes`; a COVERAGE RUN has it per ROUND (a long run is rounds on rounds, and each may take as long as a run did), and no limit as a whole:
        // it ends by its stop conditions. A round that reaches its limit keeps the questions that passed review (they are saved as they pass) and the run goes on from there.
        const roundMs = ports.coverage?.roundTimeoutMs ?? job.totalTimeoutSeconds * 1000;
        let signal = controller.signal, roundAbort = null, roundTimer, roundLink;
        // The limit is the time the round WORKS: its clock stops when the pause is reached (no call is running) and goes on with what is left when the learner resumes, so a long pause never costs the round.
        // The same holds for the `ms` a round records (what the projection of the time left is made of): the time it stood still in a pause is not in it.
        let roundLeft = roundMs, roundSince = 0, roundStopped = false, idleSince = 0, idleMs = 0;
        const workedMs = () => { const now = Date.now(); return Math.max(0, now - (plan.t0 || now) - idleMs - (idleSince ? now - idleSince : 0)); };
        const startRoundClock = () => {
          roundSince = Date.now();
          roundTimer = setTimeout(() => {
            job.stage = "Time budget of this round reached; stopping workers";
            roundAbort.abort(Object.assign(new Error(`Generation reached its ${Math.max(1, Math.round(roundMs / 60000))}-minute budget for this round; approved questions were retained`), { code: 'GENERATION_BUDGET' }));
          }, roundLeft);
        };
        const stopRoundClock = () => {
          if (!roundSince) return;
          clearTimeout(roundTimer);
          roundLeft = Math.max(1, roundLeft - (Date.now() - roundSince));
          roundSince = 0;
          roundStopped = true;
        };
        const resumeRoundClock = () => {
          if (idleSince) { idleMs += Date.now() - idleSince; idleSince = 0; }
          if (roundStopped) { roundStopped = false; startRoundClock(); }
        };
        const armRound = () => {
          roundAbort = new AbortController();
          roundLink = () => roundAbort.abort(controller.signal.reason);
          if (controller.signal.aborted) roundLink(); else controller.signal.addEventListener("abort", roundLink, { once: true });
          roundLeft = roundMs;
          roundStopped = false;
          startRoundClock();
          signal = roundAbort.signal;
        };
        const disarmRound = () => { clearTimeout(roundTimer); roundSince = 0; roundStopped = false; if (roundLink) controller.signal.removeEventListener("abort", roundLink); signal = controller.signal; };
        if (plan) control.on((changed) => { if (changed.paused === false) resumeRoundClock(); });
        // 要求并行 (lib/job-parallel.js): the limit is the time the run works, so a job held in the queue after a model error does not spend it (the round clock above is told the same way, below).
        const timer = plan ? null : workClock(job, job.totalTimeoutSeconds * 1000, () => {
          job.status = "cancelling";
          job.stage = "Time budget reached; stopping workers";
          controller.abort(Object.assign(new Error(`Generation reached its ${request.performance.jobTimeoutMinutes}-minute total budget; approved questions were retained`), { code: 'GENERATION_BUDGET' }));
        });
        const letGoOfHold = plan ? holdClock(job, { stop: () => { idleSince ||= Date.now(); stopRoundClock(); }, resume: () => { if (!control.values.paused) resumeRoundClock(); } }) : null;
        job.status = "running";
        // The run clock (the console's 已用) starts here, once the library's queue has let the job in; a retry or a continuation is a job of its own.
        job.runStartedAt ??= new Date().toISOString();
        job.stage = "Writing source-grounded questions";
        let savedVersion;
        const publish = async (budgetReached = false) => {
          job.stage = 'Publishing reviewed questions into the requested deck';
          const asked = { id: job.draftId, draftVersion: savedVersion, mergeTargetId: target.id, requireReviewed: true, [supplementPublication]: job.id,
            ...(budgetReached ? { [supplementBudgetPublication]: true } : {}) };
          const result = publishManaged && commit
            ? resultOfReceipt(await publishDraft({ call: providedCall, read: storagePort.read, models, signal: controller.signal, commit, plans, stepKey: budgetReached ? 'publish-budget' : 'publish',
              base: asked, draft: { id: job.draftId, draftVersion: savedVersion, title: job.deckTitle },
              meta: { targetTitle: target.title, sourceIds: job.sourceIds, kind: job.kind, count: job.count, requestedTotal: job.requestedTotal, savedCount: job.savedCount } }))
            : await providedCall('draft.publish', asked);
          job.publication = { deckId: result.deckId || null, added: result.added || 0, total: result.total ?? null,
            accepted: result.accepted, rejected: result.rejected, remainingDraftId: result.rejectedDraft?.id || null };
          if (result.deckId !== target.id) throw new Error('没有题目通过发布检查，目标题组未增加；检查记录已保留');
          if (result.rejectedDraft) job.draftId = result.rejectedDraft.id;
          else delete job.draftId;
        };
        // ---- the bookkeeping of a coverage run: the state of the rounds and the marker go to the draft at every boundary, and the job shows the same facts live ----
        const tokensNow = () => plan.tokensBase + totalTokens(job.tokenUsage);
        const syncRun = () => { if (plan?.spec) job.coverageRun = mirrorOf(plan.spec, plan.marker, { percent: plan.percent, cover: plan.cover, draftId: job.draftId }); };
        // The coverage the run shows, from a view of the draft: the percent and the sections that have a question (the progress of the job is counted in them).
        const seen = (view) => { plan.percent = view.percentLeaves; plan.cover = { ...plan.cover, leaves: view.leaves, covered: view.covered }; };
        const persist = async () => {
          if (!plan?.spec || !job.draftId) return;
          const current = (await storagePort.read()).drafts.find((item) => item.id === job.draftId);
          if (!current) return;
          plan.marker = { ...plan.marker, updatedAt: new Date().toISOString() };
          const saved = await providedCall("draft.save", { deck: { ...current, editorial: { ...current.editorial, coverageSpec: plan.spec, coverageRun: plan.marker } }, requireExisting: true });
          savedVersion = saved.draftVersion;
          await checkpoint?.(saved);
        };
        const stopRun = (reason, extra = {}) => {
          const known = STOP_REASONS[reason];
          plan.marker = { ...plan.marker, state: reason === "complete" || reason === "target" ? "complete" : "stopped", stop: { reason, at: new Date().toISOString(), round: plan.round, ...extra } };
          recordEvent(job, { level: known.level, code: "run-stop", args: { reason, round: plan.round, ...extra } });
          syncRun();
        };
        try {
          const latest = await storagePort.read();
          if (sources.some((source) => !latest.sources.some((current) => current.id === source.id)))
            throw new Error("出题资料在任务开始前已被删除，请重新选择资料");
          const baseDraft = previous ? get(latest.drafts, previous.id, "Draft") : null;
          if (baseDraft && baseDraft.draftVersion !== previous.draftVersion)
            throw new Error("草稿在排队期间被修改，请重新打开后再继续补题");
          // The importance of every section of a coverage run, asked once per chunk of about 20 sections from the light model (lib/section-weights.js), then the plan again from them: how many questions each
          // section gets, and which sections the first round holds (the heaviest). Without a light model, or when it fails, the sections are weighted by length and the draft says so.
          let runAssignments = assignments, runCount = planCount, runSpec;
          if (coverageRun) {
            const weighing = weighsSections({ goalCount: coverageRun.goalCount, sections: coverageRun.leaves.length });
            if (weighing) job.stage = `${GENERATION_STAGE_TEXT.planning} · Weighing the importance of the sections`;
            const weigh = models.weigh ? (system, prompt) => models.weigh(system, prompt, { stage: job.stage, signal: controller.signal }) : undefined;
            // A small custom total is not weighed section by section (lib/coverage-plan.js weighsSections): the questions go to the longest sections anyway, and the whole material would be sent
            // to the light model for it. The same length fallback as having no light model, with its reason kept on the draft.
            const weighed = weighing
              ? await sectionWeights({ sections: coverageRun.leaves, sources, light: weigh, language: providedLanguage, signal: controller.signal })
              : { weights: lengthWeights(coverageRun.leaves), source: 'length', calls: 0, reasked: 0, reason: 'small-target' };
            const made = coveragePlan({ leaves: coverageRun.leaves, weights: weighed.weights, level: coverageRun.level, goalCount: coverageRun.goalCount, limit: roundLimit });
            runAssignments = made.rounds[0].assignments;
            runCount = made.rounds[0].questions;
            runSpec = coverageSpec({ plan: made.plan, rounds: made.rounds, weights: weighed.weights, weightSource: weighed.source, ...(weighed.reason === 'small-target' ? { weightReason: 'small-target' } : {}), custom: coverageRun.goalCount !== undefined });
            // The card shows what the run really does now: the questions of the first round, its parts, how the whole plan is cut into rounds.
            const again = planGeneration({ sources, count: runCount, kind: request.kind, kinds: request.kinds, kindCounts: request.kindCounts, performance: request.performance, reuse, assignments: runAssignments });
            Object.assign(job, { count: runCount, requestedTotal: plan?.auto ? made.plan.goal : runCount, parts: again.length, partPlan: partPlanOf(again, partPlanText(providedLanguage), { sections: safeSections(fullSources) }),
              coveragePlan: { level: coverageRun.level, goal: made.plan.goal, round: 1, rounds: made.rounds.length, sections: made.plan.mustCover, weights: weighed.source } });
            plan.spec = runSpec;
          }
          // The marker of the run: this job, whether it goes on by itself, what it may spend.
          if (plan) {
            const startedAt = new Date().toISOString(), options = { jobId: job.id, autoComplete: control.values.autoComplete, tokenBudget: plan.tokenBudget, estimate: plan.estimate, startedAt };
            plan.marker = previous ? resumedMarker(priorRun, options) : newMarker(options);
            plan.onAuto = (value) => { plan.marker = { ...plan.marker, autoComplete: value }; if (value) job.requestedTotal = Math.max(plan.spec?.goal || 0, job.savedCount || 0); syncRun(); };
            plan.onPaused = () => { plan.paused = true; idleSince ||= Date.now(); stopRoundClock(); };
            // The progress bar of a run that goes on by itself is the whole plan.
            if (plan.auto && plan.spec?.goal) job.requestedTotal = Math.max(plan.spec.goal, job.savedCount || 0);
            syncRun();
            plan.started = true;
          }
          const stepOfRound = async (ctx, fresh) => {
            // A step of the pipeline: one model call. `signal` is the job's, or the round's own when the run has a time limit per round.
            const call = async (system, prompt, context = {}) => {
              signal.throwIfAborted();
              const notes = job.messages.map((m) => m.text);
              return models.call(system, notes.length
                ? `${prompt}\n\nAdditional learner requirements (apply within the requested schema and source evidence):\n${JSON.stringify(notes)}` : prompt,
                { ...context, stage: context.stage || job.stage, signal, ...(plan ? { round: plan.round } : {}) });
            };
            const base = ctx.base;
            savedVersion = base?.draftVersion;
            // The deck's coverage list names every source it was written from, the added ones too.
            const mergeSources = ctx.mergeSources;
            const saveProgress = async (produced) => {
              const deck = { ...produced, editorial: { ...produced.editorial,
                generation: { ...produced.editorial?.generation, notation: request.notation, notationResolved: request.notationResolved } } };
              let updated = base ? mergeContinuedDraft(base, deck, mergeSources, extraIds ? { addSourceIds: extraIds, requested: job.requestedTotal } : {}) : deck;
              // What the draft was asked and which run saved it (a continued draft is the base's, so this is written after the merge): jobs/input-ref.js, jobs/resume-args.js.
              updated = { ...updated, editorial: { ...updated.editorial, generation: { ...updated.editorial.generation, inputRef, runId } } };
              // A part is a draft of the whole DOCUMENT (its coverage is the document's, lib/coverage-state.js), whichever sources this round was written from, and it says which deck it is for.
              if (part) updated = { ...updated, editorial: { ...updated.editorial, part: { deckId: part.deck.id, n: part.n }, generation: { ...updated.editorial.generation, sourceIds: part.sourceIds } } };
              // The plan of a coverage run and the state of its rounds travel with every save of the round.
              if (plan?.spec) updated = { ...updated, editorial: { ...updated.editorial, coverageSpec: plan.spec, coverageRun: plan.marker } };
              // A case paper's scenario becomes a material before the draft that cites it.
              const pending = updated.case?.pendingScenario;
              if (pending) {
                const known = (await storagePort.read()).sources.find((source) => source.id === pending.id);
                // An earlier Attempt of this run added its scenario and was cut short before the draft that cites it: that material is replaced, never duplicated.
                if (known && known.text !== pending.text) await providedCall("source.remove", { id: pending.id });
                if (!known || known.text !== pending.text)
                  await providedCall("source.add", { id: pending.id, title: say(`案例：${pending.title}`, `Case: ${pending.title}`), text: pending.text,
                    courses: request.course ? [request.course] : [] });
                const { pendingScenario: _pending, ...meta } = updated.case;
                updated = { ...updated, case: meta };
              }
              if (savedVersion !== undefined && !(await storagePort.read()).drafts.some((d) => d.id === updated.id))
                throw new Error("Generation draft was removed; refusing to recreate it");
              // Reserve the draft identity before its commit becomes visible to
              // another request; publication must see the active producer.
              job.draftId = updated.id;
              const saved = await providedCall("draft.save", { deck: { ...updated, ...(savedVersion === undefined ? {} : { draftVersion: savedVersion }) },
                requireExisting: savedVersion !== undefined });
              savedVersion = saved.draftVersion;
              job.draftId = saved.id;
              job.deckTitle = saved.title;
              job.savedCount = saved.cards.length;
              await checkpoint?.(saved);
              // The coverage the run shows follows the questions as they are saved (at most every few seconds: it reads the whole material), not only the round boundaries.
              if (plan?.spec && Date.now() - (plan.percentAt || 0) > 3000) {
                plan.percentAt = Date.now();
                try { seen(coverageForDraft(await storagePort.read(), saved)); syncRun(); } catch { /* the number is a convenience */ }
              }
            };
            const deck = await generateBatched(
              call,
              {
                ...request,
                notation: request.notationResolved,
                ...(request.case ? { case: { ...request.case, guidance: boundedGuidance(fresh.sources.filter((source) => request.case.guidanceSourceIds.includes(source.id))) },
                  scenarioSourceId: scenarioSourceId } : {}),
                signal,
                control,
                // The provider answered 429: the run slowed down (or sped up again); the card says so.
                // A 429 back-off is a dashed bar on the job's timeline and a line of its log.
                onWait: (wait) => {
                  recordWait(job, wait);
                  if (wait.phase === "start") recordEvent(job, { level: "warn", code: "rate-limit", args: { slot: wait.slot, seconds: Math.max(1, Math.round(wait.ms / 1000)) } });
                },
                // The knowledge points the plan lists, and what became of each (lib/plan-targets.js): the job keeps a compact copy for the console; a round of a coverage run replaces only its own.
                onTargets: (record) => { job.planTargets = mergePlanTargets(job.planTargets, plan?.round, record); },
                onThrottle: (event) => {
                  const seen = job.throttle || { events: 0, lowest: event.configured };
                  job.throttle = { events: seen.events + (event.reason === "rate-limit" ? 1 : 0), concurrency: event.concurrency, configured: event.configured, lowest: Math.min(seen.lowest, event.concurrency) };
                  recordEvent(job, { level: event.reason === "rate-limit" ? "warn" : "info", code: "throttle", args: { reason: event.reason, concurrency: event.concurrency, configured: event.configured } });
                },
                count: ctx.count,
                sources: ctx.sources,
                ...(ctx.assignments ? { assignments: ctx.assignments } : {}),
                ...(ctx.first && coverageRun ? { coverageLevel: coverageRun.level, coverageSpec: plan.spec } : {}),
                ...(ctx.covering ? { reuse: ctx.reuse, coverageSections: ctx.titles } : {}),
                // EXPERIMENTAL (hidden and off by default): a Jev pre-check before the independent review (lib/jev-triage.js), and, if the learner
                // chose it, Jev in place of the model for the cards it is sure about (lib/jev-review.js). Both are undefined unless switched on.
                ...(request.case ? {} : await experimentalHooks()),
                ...existingFor(fresh, target, base),
              },
              (stage, context) => {
                if (!controller.signal.aborted) job.stage = context?.part ? `Parallel generation · up to ${job.concurrency} batches` : stage;
                // A part that is filling its gap says which round and how many are still missing (the card shows the newest).
                if (context?.part && context.fill !== undefined) {
                  job.fills ||= {};
                  if (context.fill) job.fills[context.part] = context.fill; else delete job.fills[context.part];
                }
              },
              saveProgress,
            );
            await saveProgress(deck);
            return { deck, saveProgress };
          };
          // ---- the rounds ----
          let ctx = { base: baseDraft, mergeSources: extraIds ? latest.sources.filter((source) => baseDraft.editorial.generation.sourceIds.includes(source.id) || extraIds.includes(source.id))
              : covering ? sourcesOfDraft(latest, baseDraft) : sources, sources, count: runCount, assignments: runAssignments, reuse, titles: covering?.request.titles, covering: !!covering, first: true,
            questions: covering ? covering.round.questions : runCount, index: plan ? (coverageRun ? 0 : plan.first ? (plan.first.type === "round" ? plan.first.index : null) : roundOfKeys(plan.spec, covering.request.sectionKeys)) : null,
            keys: covering?.request.sectionKeys };
          let deck, final = null, lastUncovered = null;
          // The sections as a line of the log names them (a page, else its title): the leaves of the plan, then what each coverage view says.
          const known = new Map((coverageRun?.leaves || []).map((section) => [section.key, section])), refOf = (key) => sectionRef(known.get(key));
          const refsOf = (keys, max) => { const refs = keys.map(refOf); return refs.every(Boolean) && keys.length <= max ? refs : null; };
          // Paused before the first round (asked while the sections were being weighed): the first round waits for the learner.
          if (plan) await control.waitIfPaused(controller.signal);
          for (;;) {
            controller.signal.throwIfAborted();
            let fresh = ctx.base ? await storagePort.read() : latest;
            let before = null, round = null;
            if (plan) {
              // A round that is not one of the plan (the sections the learner chose, the sections a run retries) is a fill round: it is written down as one, so the draft says what was run.
              if (ctx.index === null || ctx.index < 0) { plan.spec = appendFillRound(plan.spec, { keys: ctx.keys || [], questions: ctx.questions }); ctx.index = plan.spec.rounds.length - 1; }
              round = plan.spec.rounds[ctx.index];
              plan.round = round.round;
              const rerun = plan.rerun.includes(ctx.index);
              const viewNow = ctx.base ? coverageForDraft(fresh, ctx.base) : null;
              if (viewNow) for (const section of viewNow.sections) known.set(section.key, section);
              const unit = unitOfRefs(round.sectionIds.map(refOf));
              plan.spec = markRound(plan.spec, ctx.index, "running", { unit });
              plan.marker = { ...plan.marker, state: "running" };
              before = viewNow ? wantedUncovered(plan.spec, viewNow) : new Set((plan.spec.quotas || []).map((item) => item.sectionId));
              plan.before = before; plan.cardsBefore = ctx.base?.cards.length ?? 0; plan.t0 = Date.now(); idleMs = 0; plan.tokensBefore = tokensNow();
              job.coveragePlan = { ...(job.coveragePlan || {}), round: round.round, rounds: plan.spec.rounds.length };
              if (!ctx.first) {
                const planned = planGeneration({ sources: ctx.sources, count: ctx.count, kind: request.kind, kinds: request.kinds, kindCounts: request.kindCounts, performance: request.performance, reuse: ctx.reuse || [], assignments: ctx.assignments });
                Object.assign(job, { count: ctx.questions, parts: planned.length, partPlan: partPlanOf(planned, partPlanText(providedLanguage), { sections: safeSections(fullSources) }), 
                  coverage: { sections: ctx.keys?.length ?? 0, questions: ctx.questions } });
                delete job.partReport;
              }
              if (rerun) recordEvent(job, { level: "warn", code: "round-rerun", args: { round: round.round, rounds: plan.spec.rounds.length } });
              // A retry round says which earlier rounds left its sections without a question (the rounds the plan recorded for them), and a small round names its sections.
              const from = round.fill ? [...new Set(round.sectionIds.flatMap((key) => (plan.spec.attempts?.[key]?.rounds || []).map((item) => item.round)))].sort((a, b) => a - b).slice(0, 4) : [];
              recordEvent(job, { level: "done", code: "round-start", args: { round: round.round, rounds: plan.spec.rounds.length, sections: round.sectionIds.length, questions: round.questions, fill: !!round.fill, unit,
                ...(refsOf(round.sectionIds, 4) ? { names: refsOf(round.sectionIds, 4) } : {}), ...(from.length ? { from } : {}) } });
              syncRun();
              // The draft says "running" before the model is asked (a restart finds the round in flight and runs it again); the first round of a new run has no draft yet, its first save says it.
              // (Saving it makes a new version of the draft: the round is written on top of that one.)
              if (ctx.base) { await persist(); fresh = await storagePort.read(); ctx.base = get(fresh.drafts, job.draftId, "Draft"); }
            }
            if (plan) armRound();
            let failure = null;
            try { ({ deck } = await stepOfRound(ctx, fresh)); } catch (error) { failure = error; }
            const timedOut = !!failure && !controller.signal.aborted && roundAbort?.signal.aborted && roundAbort.signal.reason?.code === 'GENERATION_BUDGET';
            if (plan) disarmRound();
            if (failure) {
              // A single job is as it always was: the failure is the job's. A coverage run settles the round (below) unless it is a stop, or a first round that left no draft behind.
              if (!plan || controller.signal.aborted || !job.draftId) throw failure;
            }
            if (!plan) break;
            // The round is over: what it kept, what it covered, what it cost, and the state of the plan.
            const after = await storagePort.read(), draft = after.drafts.find((item) => item.id === job.draftId);
            if (failure && failure.result && draft) {
              // A round that kept nothing still knows what it planned and why each part failed: the sections it asked for are planned-and-failed, not unknown (the fill round writes them again).
              try { const merged = mergeContinuedDraft(draft, failure.result, sourcesOfDraft(after, draft)); await providedCall("draft.save", { deck: { ...merged, draftVersion: draft.draftVersion, editorial: { ...merged.editorial, coverageSpec: plan.spec, coverageRun: plan.marker } }, requireExisting: true }); } catch { /* the record is a convenience */ }
            }
            const settled = (await storagePort.read()).drafts.find((item) => item.id === job.draftId) || draft;
            const coverageNow = settled ? coverageForDraft(await storagePort.read(), settled) : null;
            const uncovered = coverageNow ? wantedUncovered(plan.spec, coverageNow) : before;
            const { progress, gained } = progressOf(before, uncovered);
            lastUncovered = uncovered;
            // What the round did for ITS OWN sections (a question whose quote lies in another section covers that one too: that is progress, not something the round was asked for).
            const own = round.sectionIds.filter((key) => before.has(key) && !uncovered.has(key)).length;
            if (coverageNow) seen(coverageNow);
            const reason = failure ? (timedOut ? "timeout" : String(failure.message || failure).replace(/\s+/g, " ").slice(0, 160)) : undefined;
            // The cause as a code (lib/generation-failure.js): every screen says it in its own words; the provider's English is only the log's.
            const code = failure ? (timedOut ? "timeout" : classifyFailure(failure).code) : undefined;
            const keptNow = Math.max(0, (settled?.cards.length ?? 0) - plan.cardsBefore), uncredited = uncreditedOf({ kept: keptNow, gained });
            plan.spec = finishRound(plan.spec, ctx.index, { status: failure ? "failed" : "done", kept: keptNow, covered: own, uncredited, tokens: tokensNow() - plan.tokensBefore, ms: workedMs(), reason, ...(code && code !== "unknown" ? { code } : {}) });
            // A section this round was asked for and that still has no question has failed one more time: the plan keeps how often and why, so a run does not try a section that fails again and again for ever (REPEAT_LIMIT).
            const failedKeys = round.sectionIds.filter((key) => before.has(key) && uncovered.has(key));
            if (failedKeys.length) {
              const sectionOf = new Map((coverageNow?.sections || []).map((section) => [section.key, section]));
              // What the plan knew about a section that came back short (how many points it needed, how many it got, how long the section is) is kept with the attempt: the screens word it.
              const shortHere = shortOfPlans((failure ? failure.result : deck)?.editorial?.partPlans);
              const reasonFor = (key) => { const section = sectionOf.get(key); return section?.state === "planned-failed" && section.reason ? section.reason : code && code !== "unknown" ? code : "plan-short"; };
              const detailFor = (key) => {
                const row = reasonFor(key) === "plan-short" ? shortHere.get(key) : null;
                return row && Number.isFinite(row.needed) ? { needed: row.needed, got: row.got ?? 0, ...(Number.isFinite(row.chars) ? { chars: row.chars } : {}), ...(Number.isFinite(row.returned) ? { returned: row.returned, outside: row.outside ?? 0 } : {}), ...(row.why ? { why: row.why } : {}) } : null;
              };
              plan.spec = recordAttempts(plan.spec, failedKeys, reasonFor, round.round, detailFor, !!round.fill);
            }
            plan.marker = { ...plan.marker, tokensUsed: tokensNow() };
            // The sections the round was asked for and still has no question for, named with what is known of each (at most six; the count says how many).
            const lost = failedKeys.slice(0, 6).map((key) => { const record = plan.spec.attempts?.[key]; return { ...(refOf(key) || {}), ...(record?.short ? { needed: record.short.needed, got: record.short.got } : record?.reason ? { reason: record.reason } : {}) }; });
            recordEvent(job, { level: failure ? "warn" : "done", code: "round-end", args: { round: round.round, rounds: plan.spec.rounds.length, status: failure ? "failed" : "done", fill: !!round.fill, kept: plan.spec.rounds[ctx.index].kept, covered: own, ...(uncredited ? { uncredited } : {}), tried: round.sectionIds.length, unit: plan.spec.rounds[ctx.index].unit, percent: plan.percent,
              ...(failedKeys.length ? { lost, lostCount: failedKeys.length } : {}), ...(reason ? { reason } : {}), ...(code && code !== "unknown" ? { code } : {}) } });
            // A failure that repeating cannot fix (a refused key, no credit) ends the run; the questions that passed stay. A round that fails in a job that does not go on by itself is that job's failure, as it always was.
            if (failure && ((!timedOut && isPermanentFailure(failure)) || !control.values.autoComplete)) {
              // The key was refused (or the account is out of credit): what passed stays, and the run can go on from its next round once that is fixed (接着做).
              if (!timedOut && isPermanentFailure(failure)) { stopRun("refused", { code, ...(code && code !== "unknown" ? {} : { detail: reason }) }); job.retryable = true; }
              await persist();
              throw failure;
            }
            const decide = () => stepOf({ spec: plan.spec, uncovered, run: { autoComplete: control.values.autoComplete, fillUsed: plan.fills, tokensUsed: plan.marker.tokensUsed, tokenBudget: plan.marker.tokenBudget }, fillRounds });
            let step = decide();
            // A round that covered no section it had none for, after its own retries, ends a run that goes on by itself: the same asking again would give the same answer.
            // A PLANNED round that covered nothing is not the end while a bounded fill round can still write the sections that did not come out again (the last planned round, say, with sections left); only a round whose
            // next step is another planned round, or a fill round that gained nothing, is "no progress". The stop says how many sections are left.
            // Progress is NEW COVERAGE (a section that had no question has one now), never the number of questions kept: a round that kept questions and credited none is no progress, and says so (`uncredited`).
            if (!progress && (step.type === "round" || (step.type === "fill" && round.fill))) step = { type: "stop", reason: "no-progress", left: uncovered.size, ...(uncredited ? { uncredited } : {}), ...(code && code !== "unknown" ? { code } : {}), ...(reason ? { detail: reason } : {}) };
            // Paused between rounds: the round in flight has finished, no new one starts until the learner goes on (or stops here).
            while ((step.type === "round" || step.type === "fill") && control.values.paused) {
              plan.marker = { ...plan.marker, state: "paused" };
              recordEvent(job, { level: "done", code: "run-paused", args: { after: round.round } });
              syncRun();
              await persist();
              await control.waitIfPaused(controller.signal);
              plan.marker = { ...plan.marker, state: "running" };
              recordEvent(job, { level: "done", code: "run-resumed", args: { next: round.round + 1 } });
              step = decide();
            }
            for (const index of step.skipped || []) plan.spec = markRound(plan.spec, index, "skipped", { reason: "covered" });
            if (step.type === "round" || step.type === "fill") {
              const state = await storagePort.read(), current = get(state.drafts, job.draftId, "Draft");
              const next = topUpRound(state, current, { sectionIds: step.keys, fit: true, batchSize: request.performance?.batchSize, limit: roundLimit });
              if (next.round.error || !next.round.questions) { step = { type: "stop", reason: "round-failed", detail: say("资料或草稿变了，找不到下一轮要补的小节", "The material or the draft changed and the sections of the next round cannot be found") }; }
              else {
                if (step.type === "fill") plan.fills += 1;
                ctx = { base: current, mergeSources: sourcesOfDraft(state, current), sources: next.request.sources, count: next.request.count, assignments: next.request.assignments, reuse: next.request.reuse, titles: next.request.titles,
                  covering: true, first: false, questions: next.round.questions, index: step.type === "round" ? step.index : null, keys: next.request.sectionKeys };
                continue;
              }
            }
            final = step;
            break;
          }
          if (plan) {
            // The run is over for now: why, in the marker, in the log and on the job.
            if (final.type === "wait") { plan.marker = { ...plan.marker, state: "waiting" }; recordEvent(job, { level: "done", code: "run-waiting", args: { round: plan.round, rounds: plan.spec.rounds.length, left: roundList(plan.spec).filter((item) => item.status === "pending").length } }); syncRun(); }
            else {
              // A stop that leaves sections without a question names them and says how many retry rounds were made, so the line is not a number of rounds nobody can check.
              const leftKeys = [...(lastUncovered || [])], names = refsOf(leftKeys, 4);
              stopRun(final.reason, { ...(final.left !== undefined ? { left: final.left } : {}), ...(final.uncredited ? { uncredited: final.uncredited } : {}), ...(final.code ? { code: final.code } : {}), ...(final.detail ? { detail: final.detail } : {}),
                ...(final.left > 0 ? { unit: names ? unitOfRefs(names) : "part", ...(names ? { names } : {}), fills: roundList(plan.spec).filter((item) => item.fill && ["done", "failed"].includes(item.status)).map((item) => item.round) } : {}) });
            }
            // What follows the last round is real work (the draft, with its plan and the marker of the run, is written once more): the log says so, with how long it took, so the minutes before 「任务完成」 are not silent.
            const closing = Date.now();
            recordEvent(job, { level: "step", code: "run-closing", args: { cards: job.savedCount ?? 0 } });
            await persist();
            recordEvent(job, { level: "step", code: "run-closed", args: { ms: Date.now() - closing } });
            if (final.type === "stop" && STOP_REASONS[final.reason].ok) job.requestedTotal = job.savedCount ?? job.requestedTotal;
          }
          controller.signal.throwIfAborted();
          // How many parts passed or failed and why, in plain words, for the card and for the agent that reads the job (lib/generation-report.js).
          if (deck?.editorial?.partReport) job.partReport = { ...deck.editorial.partReport, summary: describePartReport(deck.editorial.partReport, providedLanguage) };
          if (publishTarget) await publish();
          // A pasted case with the learner's answers is theirs: publish it and grade the answers now.
          if (request.case?.answers?.some((answer) => !isBlank(answer))) {
            const draftId = job.draftId, saved = get((await storagePort.read()).drafts, draftId, "Draft");
            if (publishManaged && commit) await publishCase({ call: providedCall, read: storagePort.read, models, signal: controller.signal, commit, plans, job,
              draft: { id: draftId, draftVersion: savedVersion, title: saved.title, cards: saved.cards }, answers: request.case.answers });
            else {
            job.stage = "Publishing the imported case";
            delete job.draftId;
            const receipt = await providedCall("draft.publish.quick", { id: draftId, draftVersion: savedVersion });
            job.publication = { deckId: receipt.deckId || receipt.id, added: receipt.added, total: receipt.total };
            const answered = request.case.answers.map((answer, index) => ({ answer, card: saved.cards[index] })).filter((item) => item.card && !isBlank(item.answer));
            for (const [index, item] of answered.entries()) {
              controller.signal.throwIfAborted();
              job.stage = `Reviewing your answers against the rubric ${index + 1}/${answered.length}`;
              await providedCall("card.grade", { deckId: job.publication.deckId, cardId: item.card.id, answer: item.answer });
            }
            job.graded = answered.length;
            }
          }
          job.status = "complete";
          job.stage = job.graded ? say(`案例已导入，${job.graded} 道题已批改`, `Case imported; ${job.graded} answer(s) graded`)
            : publishTarget ? `Added ${job.publication.added} questions to ${target.title}; total ${job.publication.total}`
            : plan ? runStageText(final, plan, job)
            : job.savedCount < job.requestedTotal || deck.editorial.failures.length
            ? `Draft ready with ${job.savedCount}/${job.requestedTotal} questions; ${deck.editorial.failures.length} part(s) failed`
            : "Draft ready for review";
        } catch (e) {
          job.status = controller.signal.aborted && job.cancelRequestedAt ? "cancelled" : "failed";
          job.stage = controller.signal.aborted ? controller.signal.reason.message : e.message;
          // The host stopped under a coverage run (the plugin was unloaded, the app is closing): nobody stopped it and nothing failed. The draft is left as it is (its marker says the run was running, the round in
          // flight is run again) and the job is INTERRUPTED with 接着做, exactly what the next start would restore from the draft (coverage.recover).
          const hostStopped = !!plan?.started && controller.signal.aborted && !job.cancelRequestedAt && controller.signal.reason?.code !== 'GENERATION_BUDGET';
          if (hostStopped) {
            job.status = "interrupted";
            job.retryable = true;
            job.stage = say("宿主已停止，这次运行被中断；已通过的题已保存，点「接着做」继续。", "The host stopped and this run was interrupted; the questions that passed are saved. 接着做 continues it.");
            recordEvent(job, { level: "error", code: "run-interrupted", args: { round: plan.round, rounds: plan.spec?.rounds?.length ?? 0 } });
          }
          // A coverage run that ends this way (the learner stopped it, a failure that repeating cannot fix) leaves the draft saying so: the rounds done stay done, the round in flight is not left "running".
          if (plan?.started && plan.spec && !plan.marker?.stop && !hostStopped) {
            try {
              const index = plan.spec.rounds.findIndex((item) => item.status === "running");
              if (index >= 0) plan.spec = finishRound(plan.spec, index, { status: "failed", kept: 0, covered: 0, tokens: tokensNow() - (plan.tokensBefore || 0), ms: workedMs(), reason: job.status === "cancelled" ? "cancelled" : String(e.message || e).slice(0, 160) });
              const stopCode = classifyFailure(e).code;
              stopRun(job.status === "cancelled" ? "learner" : isPermanentFailure(e) ? "refused" : "round-failed", job.status === "cancelled" ? {} : { ...(stopCode !== "unknown" ? { code: stopCode } : {}), detail: String(e.message || e).slice(0, 200) });
              // Whatever stopped the round (a refused key, the time limit, a model failure), the draft is the checkpoint: 接着做 goes on from the next round that is not done.
              if (job.status !== "cancelled" && job.draftId) job.retryable = true;
              await persist();
            } catch { /* the draft may be gone; the job still ends */ }
          }
          // A top-up of one round (no plan) that ended before it was done asked for `kept + this round's questions`, a number of its own: once it has ended the number of questions is the draft's one (what it
          // was asked for, or what it holds), the number the banner, the row and the draft page say (lib/shortfall.js), so the console says the same.
          if (!plan && covering && job.draftId && job.status !== 'complete') {
            try { const kept = (await storagePort.read()).drafts.find((item) => item.id === job.draftId); if (kept) job.requestedTotal = Math.max(Number.isInteger(kept.editorial?.requested) ? kept.editorial.requested : 0, kept.cards.length); } catch { /* the draft may be gone */ }
          }
          // A plain run (a count, no plan) that ended before it was done and kept a draft is continued, not started again: 接着做 makes the questions it was asked for and did not get, with its own settings.
          if (!plan && !publishTarget && job.draftId && (job.status === 'failed' || job.status === 'cancelled') && !job.retryable) {
            try { const kept = (await storagePort.read()).drafts.find((item) => item.id === job.draftId); if (kept && canContinueDraft(kept)) job.retryable = true; } catch { /* the draft may be gone */ }
          }
          if (publishTarget && controller.signal.reason?.code === 'GENERATION_BUDGET' &&
              !job.cancelRequestedAt && job.draftId && job.savedCount > 0) {
            job.status = 'running';
            try {
              await publish(true);
              job.status = 'complete';
              job.stage = `Time budget reached; added ${job.publication.added}/${job.requestedTotal} requested questions to ${target.title}; total ${job.publication.total}`;
            } catch (error) {
              job.status = job.cancelRequestedAt ? 'cancelled' : 'failed';
              job.stage = `Time budget reached; checkpoint publication blocked: ${error.message}`;
            }
          }
        } finally {
          timer?.clear();
          letGoOfHold?.();
          clearTimeout(roundTimer);
          generationControllers.delete(job.id);
          generationMessengers.delete(job.id);
          jobControls.delete(job.id);
          control.close();
          jobOutputs.endJob(job.id);
          delete job.fills;
          // What a finished run really used, per stage, next to what was estimated: the next estimate learns from it. Awaited, so the library folder is quiet when the job ends; never a reason to fail the job.
          if (job.status === 'complete' && job.estimate?.stageTotals && !plan) await calibrationFor(root).record({ stageTotals: job.estimate.stageTotals, actual: observedByStage(job) }).catch(() => {});
          job.finishedAt = new Date().toISOString();
          if (!managed) providedAnnounceJob(job);
        }
      };
      const task = { kind: publishTarget ? 'supplement' : 'generation', args: a, root, seed: job, makeControl, execute,
        models: { performance: request.performance, feature: request.case ? 'case' : env.feature } };
      if (take) { take(task); return { prepared: true }; }
      const status = job.status;
      const started = await startGeneration(env, task);
      supersede(started.jobId);
      return {
        jobId: started.jobId,
        status,
        queuedBehind: ahead,
        parts,
        ...(publishTarget ? { deckId: target.id, completion: 'published-to-target' } : {}),
        ...(previous ? { draftId: previous.id, missing: count } : {}),
        ...(part ? { part: { deckId: part.deck.id, deckTitle: part.deck.title, n: part.n } } : {}),
        ...(covering ? { coverage: { sections: covering.round.sections, questions: covering.round.questions, left: covering.round.left, rounds: covering.round.rounds } } : {}),
        // What a coverage run will do: its level, how many questions in all, the sections it covers, how many rounds it takes and that this job makes the first.
        ...(coverageRun ? { plan: { level: coverageRun.level, goal: coverageRun.goal, sections: coverageRun.covered, rounds: coverageRun.rounds, round: 1, questions: count } } : {}),
        // 接着做: the plan of the draft and the round this job starts with.
        ...(runAsked ? { plan: { level: plannedSpec.level, goal: plannedSpec.goal, sections: plannedSpec.mustCover, rounds: plannedSpec.rounds.length, round: runStart.type === "round" ? plannedSpec.rounds[runStart.index].round : plannedSpec.rounds.length + 1, questions: count } }
          // 为没覆盖的部分补题: what the job will do, in the same words as 接着做: the plan of the draft (a plain draft's is its uncovered sections), the round it starts with and how many questions that is.
          : plan && !coverageRun ? { plan: { ...(plannedSpec.level ? { level: plannedSpec.level } : {}), goal: plannedSpec.goal, sections: plannedSpec.mustCover, rounds: plannedSpec.rounds.length, round: roundList(plan.spec)[roundOfKeys(plan.spec, covering.request.sectionKeys)]?.round ?? plannedSpec.rounds.length + 1, questions: count } } : {}),
        ...(plan ? { autoComplete: plan.auto } : {}),
        next: publishTarget
          ? "Supplementation is queued and will publish reviewed questions into the exact target. Saving is already authorized by this action; do not ask again or enqueue duplicates. Final notification reports added/total and any blocked work. Use a bounded job.wait when needed to finish the requested workflow, not a polling loop."
          : plan?.auto ? "Generation runs in the background, round after round until the plan is covered; the learner can pause, resume or stop it in the Study workspace (任务). Tell the learner it is queued and where to watch it. Use job.wait only if explicitly waiting for completion; do not repeatedly poll snapshot or enqueue duplicates."
          : "Generation runs in the background. Tell the learner it is queued and open the Study workspace for progress. Use job.wait only if explicitly waiting for completion; do not repeatedly poll snapshot or enqueue duplicates.",
      };
    },
/* Weak rubric criteria of a case set become drills (WP12): the supplementation
   pipeline writes, reviews and publishes them into an ordinary deck of the same
   course, scheduled with SM-2 from the start. */
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
      if (runs) await recoverRuns({ runs, restore: restoreRun, memory: queues });
      const root = storagePort.root, state = typeof storagePort.view === "function" ? await storagePort.view() : await storagePort.read(), found = interruptedRuns(state.drafts);
      if (!found.length) return { recovered: 0 };
      const archived = new Set((await jobArchive(root).list().catch(() => [])).flatMap((record) => record.ids || []));
      let recovered = 0;
      for (const { draft, spec, marker, round, inflight } of found) {
        if (archived.has(marker.jobId) || jobs.has(marker.jobId) || [...jobs.values()].some((job) => job.root === root && job.draftId === draft.id)) continue;
        const list = resetRunning(spec), rounds = spec.rounds.length;
        const job = { id: marker.jobId || id(), root, status: "interrupted", retryable: true, continued: true, draftId: draft.id, deckTitle: draft.title, kind: draft.editorial.generation?.kind || "quiz", course: draft.course ?? "",
          sourceIds: draft.editorial.generation?.sourceIds || [], count: 0, savedCount: draft.cards.length, requestedTotal: Math.max(spec.goal || 0, draft.cards.length), parts: 0, steps: [], messages: [],
          coveragePlan: { level: spec.level, goal: spec.goal, round, rounds, sections: spec.mustCover, weights: spec.weightSource },
          coverageRun: mirrorOf(list, marker, { draftId: draft.id }),
          stage: say(`上次运行被中断：第 ${round} 轮没有做完。已通过的题已保存，点「接着做」从第 ${round} 轮继续。`, `The last run was interrupted before round ${round}. The questions that passed are saved; 接着做 continues at round ${round}.`),
          startedAt: marker.startedAt || new Date().toISOString(), finishedAt: marker.updatedAt || new Date().toISOString(), language: providedLanguage };
        recordEvent(job, { level: "error", code: "run-interrupted", args: { round, rounds, inflight: inflight[0] ?? null } });
        ownWork(job, providedWorkOwner);
        jobs.set(job.id, job);
        recovered += 1;
      }
      return { recovered };
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
