import { get, id } from "../../util.js";
import { findCard, linkPrerequisite } from "../../prereq.js";
import { notify } from "../../inbox.js";
import { suggestionDigest, suggestFollowups, followupQuestion, followupDigest, currentFollowups, answerFollowup } from "../../followup.js";
import { validateDeck, initialReview } from "../../domain.js";
import { ensureLearner, writeFollowup, threadView, FEEDBACK_TAGS, trimLogs, REWRITE_TAGS, debriefRules, runMetrics, GOALS, LEVEL_NAMES, MAX_READY } from "../../coach.js";
import { LEARNER_PREFERENCES_MAX, LEARNER_PREFERENCE_MAX_CHARS } from "../../learner.js";
import { isSlayDeck } from "../../slay.js";
import { applyCardContent } from '../../card-content.js';
import { prepPolicy } from "../../custom-variants.js";
import { courseOf } from "../../courses.js";
import { learnerFacts } from "../../learner-facts.js";
import {
  analyzeAssessmentModes,
  compileCoachGenerationRequest,
  composeStrictMockPaper,
  confirmCalibrationFamily,
  computeCoachEvidence,
  projectCoachSpecForView,
  saveCoachSpec,
} from "../../exam-coach.js";


/** coach operations close over only the ports declared by this context. */
export function createOperations(ports) {
  const { state: storagePort, language: providedLanguage, light: providedLight, coach: providedCoach, queuePrep: providedQueuePrep, coachStatus: providedCoachStatus, nudgeFor: providedNudgeFor, scheduleRewrite: providedScheduleRewrite, queueApplicationGaps: providedQueueApplicationGaps, flushPrep: providedFlushPrep, debrief: providedDebrief } = ports;
  const { coachInflight, coachReplyInflight, followupInflight, suggestionInflight, coachTasks } = ports.work;
/** The coach status badge reads the learner profile and the prepared variants only: reading the whole library for it
    copied megabytes (sources, decks, runs) on every snapshot and every coach request. */
const STATUS_FIELDS = ["learner", "prepared"];
/** One explicit "generate variants" request never queues more than this many cards. */
const VARIANT_BATCH_CAP = 8;
const handlers = {
"coach.variants": async function (a) {
      const state = await storagePort.read();
      const asked = [], seen = new Set();
      for (const ref of Array.isArray(a.cards) ? a.cards : []) {
        let found;
        try {
          found = findCard(state, ref);
        } catch {
          continue;
        }
        if (seen.has(found.card.id) || isSlayDeck(found.deck)) continue;
        seen.add(found.card.id);
        asked.push({ deckId: found.deck.id, cardId: found.card.id });
      }
      if (!asked.length) throw new Error("请先选择要生成变式的题");
      if (!providedCoach || !providedLight) throw new Error("当前会话没有可用模型");
      // The learner's yes can arrive with the request ("同意并生成"); otherwise ask first.
      const consent = await storagePort.update((s) => {
        const learner = ensureLearner(s);
        if (a.consent === true && learner.consent.prep !== true) {
          learner.consent.prep = true;
          learner.updatedAt = new Date().toISOString();
        }
        return learner.consent.prep;
      });
      const fresh = await storagePort.read();
      if (consent !== true) return { queued: 0, skipped: [], deferred: 0, needsConsent: true, status: await providedCoachStatus(fresh) };
      const status = await providedCoachStatus(fresh),
        have = new Set(fresh.prepared.filter((p) => p.status === "ready").map((p) => p.originCardId)),
        working = new Set(status.preparingCards);
      const skipped = [], todo = [];
      for (const ref of asked) {
        if (have.has(ref.cardId)) skipped.push({ cardId: ref.cardId, reason: "ready" });
        else if (working.has(ref.cardId)) skipped.push({ cardId: ref.cardId, reason: "preparing" });
        else todo.push(ref);
      }
      const room = MAX_READY - status.ready;
      if (todo.length && room <= 0) throw new Error(`已备好的变式题已经攒满（${MAX_READY} 道），先去练掉一些再生成`);
      const chosen = todo.slice(0, Math.min(VARIANT_BATCH_CAP, room));
      for (const ref of chosen) providedQueuePrep({ ...ref, reason: "wrong" });
      if (chosen.length) providedFlushPrep();
      return { queued: chosen.length, skipped, deferred: todo.length - chosen.length, status: await providedCoachStatus(await storagePort.read(STATUS_FIELDS)) };
    },
"card.followup.suggest": async function (a) {
      const initialState = await storagePort.read(), { deck, card } = findCard(initialState, a);
      const digest = suggestionDigest(card, providedLanguage);
      if (card.followupSuggestions?.digest === digest)
        return { questions: card.followupSuggestions.questions };
      if (!providedLight) throw new Error("追问需要可用的模型");
      const ref = { deckId: deck.id, cardId: card.id };
      const key = JSON.stringify([storagePort.root, card.id, digest]);
      if (!suggestionInflight.has(key)) {
        suggestionInflight.set(key, suggestFollowups(providedLight, card, { learner: learnerFacts(initialState, courseOf(deck, initialState)) }).then((result) =>
          storagePort.update((s) => {
            const live = findCard(s, ref).card;
            if (suggestionDigest(live, providedLanguage) !== digest) throw new Error("题目或问答已更新，请重新获取推荐问题");
            live.followupSuggestions = { digest, questions: result.questions };
            return result;
          }),
        ).finally(() => suggestionInflight.delete(key)));
      }
      return suggestionInflight.get(key);
    },
"card.followup": async function (a) {
      const question = followupQuestion(a.question);
      const initialState = await storagePort.read(), { deck, card } = findCard(initialState, a);
      const digest = followupDigest(card);
      // Retrying a submitted question reuses its answer, including after a reload.
      const existing = currentFollowups(card).find((item) => item.originalQuestion === question);
      if (existing) return { deckId: deck.id, cardId: card.id, item: existing };
      if (!providedLight) throw new Error("追问需要可用的模型");
      const ref = { deckId: deck.id, cardId: card.id };
      const key = JSON.stringify([storagePort.root, card.id, digest, question]);
      if (!followupInflight.has(key)) {
        followupInflight.set(key, answerFollowup(providedLight, card, question, { learner: learnerFacts(initialState, courseOf(deck, initialState)) }).then((reply) =>
          storagePort.update((s) => {
            const { card: live, deck: owner } = findCard(s, ref);
            if (followupDigest(live) !== digest) throw new Error("题目已更新，请返回新版题目重新追问");
            const saved = currentFollowups(live).find((item) => item.originalQuestion === question);
            if (saved) return { item: saved, prepEnabled: { on: false } };
            const item = { id: id(), at: new Date().toISOString(), digest, originalQuestion: question, ...reply };
            live.followups = [...(live.followups || []), item];
            notify(s, { kind: "followup", ...ref, detail: item.question });
            return { item, prepEnabled: providedCoach ? prepPolicy(s, owner, s.learner?.consent.prep) : { on: false } };
          }),
        ).then(({ item, prepEnabled }) => {
          if (prepEnabled.on)
            providedQueuePrep({ ...ref, reason: "followup", followupId: item.id, ...(prepEnabled.viaPlan ? { viaPlan: true } : {}) });
          return item;
        }).finally(() => followupInflight.delete(key)));
      }
      return { ...ref, item: await followupInflight.get(key) };
    },
"coach.status": async function () {
      return providedCoachStatus(await storagePort.read(STATUS_FIELDS));
    },
"coach.profile": async function () {
      const s = await storagePort.read(),
        { consent, goal, preferences, summary, signals, updatedAt } = ensureLearner(s);
      return { consent: consent.prep, goal, preferences, summary, signals, updatedAt, ready: s.prepared.filter((p) => p.status === "ready").length };
    },
"coach.nudge": async function (a) {
      if (!providedLight) throw new Error("当前会话没有可用模型");
      return providedNudgeFor(a.runId, a.index);
    },
"coach.reply": async function (a) {
      const reply = a.reply;
      if (!["got", "confused", "check"].includes(reply)) throw new Error("Unknown reply");
      let followup = null;
      if (reply === "confused") {
        if (!providedLight) throw new Error("当前会话没有可用模型");
        const s = await storagePort.read(),
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
          followup = await writeFollowup(providedLight, { card, note, learner, facts: learnerFacts(s, courseOf(s.decks.find((d) => d.id === note.deckId), s)) });
        }
      }
      return storagePort.update((st) => {
        const learner = ensureLearner(st),
          note = get(st.coach, a.noteId, "陪学记录");
        if (reply === "got" && note.reply !== "got") {
          note.reply = "got";
          learner.signals.got++;
        } else if (reply === "confused") {
          note.reply = "confused";
          learner.signals.confused++;
          if (followup) {
            note.followups = [...(note.followups || []), { ...followup, at: new Date().toISOString() }];
            notify(st, { kind: "coach", deckId: note.deckId, cardId: note.cardId, detail: `换个角度再讲：${followup.explain}` });
          }
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
      // `rewriteVia: "assist"`: the panel opens its 修题 box for the rewrite tags (one visible path to the background assistant), so the
      // silent coach rewrite is not also started. Clients without the flag keep the background rewrite.
      const viaAssist = a.rewriteVia === "assist";
      const modelReady = Boolean(providedCoach && providedLight);
      const result = await storagePort.update((s) => {
        const learner = ensureLearner(s),
          { deck, card } = findCard(s, a),
          now = new Date().toISOString();
        if (a.consent === true && learner.consent.prep !== true) {
          learner.consent.prep = true;
          learner.updatedAt = now;
        }
        const prep = prepPolicy(s, deck, learner.consent.prep);
        // Taps within ten minutes on the same card refine one record.
        const recent = s.feedback.findLast((f) => f.cardId === card.id && Date.now() - Date.parse(f.at) < 600000);
        let entry = recent, added = tags;
        if (recent?.vote === vote) {
          added = tags.filter((t) => !recent.tags.includes(t));
          recent.tags.push(...added);
          recent.at = now;
        } else {
          entry = { id: id(), deckId: deck.id, cardId: card.id, vote, tags: [...tags], at: now };
          s.feedback.push(entry);
          learner.signals[vote]++;
        }
        for (const t of added) if (t === "too-easy") learner.signals.easy++;
        else if (t === "too-hard") learner.signals.hard++;
        // Only tags that actually schedule background work lock out repeat scheduling within 10 minutes (#963).
        const scheduledSet = new Set(entry.scheduledTags || []);
        const rewrite = !viaAssist && modelReady ? tags.filter((t) => REWRITE_TAGS.has(t) && !scheduledSet.has(t)) : [];
        const prepReasons = modelReady && prep.on ? tags.filter((t) => (t === "too-easy" || t === "too-hard") && !scheduledSet.has(t)) : [];
        if (rewrite.length || prepReasons.length) {
          for (const t of [...rewrite, ...prepReasons]) scheduledSet.add(t);
          entry.scheduledTags = [...scheduledSet];
        }
        const assistFix = viaAssist ? added.filter((t) => REWRITE_TAGS.has(t)) : [];
        trimLogs(s);
        return { ref: { deckId: deck.id, cardId: card.id }, added, rewrite, prepReasons, assistFix, prep };
      });
      const scheduled = [];
      if (result.rewrite.length) {
        providedScheduleRewrite(result.ref, result.rewrite);
        scheduled.push("rewrite");
      }
      for (const reason of result.prepReasons) {
        providedQueuePrep({ ...result.ref, reason, ...(result.prep.viaPlan ? { viaPlan: true } : {}) });
        if (!scheduled.includes("prep")) scheduled.push("prep");
      }
      if (result.prepReasons.length && (a.consent === true || a.flush === true)) providedFlushPrep();
      return { vote, tags: result.added, scheduled, ...(viaAssist ? { fix: result.assistFix } : {}), status: await providedCoachStatus(await storagePort.read(STATUS_FIELDS)) };
    },
"coach.consent": async function (a) {
      if (typeof a.prep !== "boolean") throw new Error("prep must be true or false");
      const recentWrong = await storagePort.update((s) => {
        const learner = ensureLearner(s);
        if (learner.consent.prep !== a.prep) learner.prepRevision = (learner.prepRevision || 0) + 1;
        learner.consent.prep = a.prep;
        learner.updatedAt = new Date().toISOString();
        const seen = new Set();
        return s.attempts.slice(-40).reverse().filter((x) => x.grade < 3 && !seen.has(x.quiz_id) && seen.add(x.quiz_id))
          .slice(0, 4).map((x) => ({ deckId: x.deckId, cardId: x.quiz_id, reason: "wrong" }));
      });
      // Opting in prepares variants of what was just missed, in one batch. From
      // a result page it also covers what that round's debrief would have
      // prepared had consent already been given (application variants).
      if (a.prep && providedCoach) {
        if (a.runId) {
          const s = await storagePort.read(),
            run = s.runs.find((r) => r.id === a.runId);
          if (run && run.mode !== "exam" &&
            debriefRules(runMetrics(s, run), { consent: true, modelReady: !!providedLight }).wantsPrep)
            providedQueueApplicationGaps(run, ensureLearner(s));
        }
        recentWrong.forEach((t) => providedQueuePrep(t));
        providedFlushPrep();
      }
      return providedCoachStatus(await storagePort.read(STATUS_FIELDS));
    },
"coach.rewrite.retry": async function (a) {
      const initialState = await storagePort.read(), { deck, card } = findCard(initialState, a);
      if (!providedCoach || !providedLight) throw new Error("当前会话没有可用模型");
      const root = storagePort.root,
        last = (coachTasks.get(root) || []).findLast((task) => task.kind === "rewrite" && task.cardId === card.id);
      if (!last) throw new Error("这道题没有待重试的改题");
      if (last.status === "failed") providedScheduleRewrite({ deckId: deck.id, cardId: card.id }, last.tags);
      return providedCoachStatus(await storagePort.read(STATUS_FIELDS));
    },
"coach.prepare": async function () {
      await providedFlushPrep();
      return providedCoachStatus(await storagePort.read(STATUS_FIELDS));
    },
"coach.debrief": async function (a) {
      // The panel prefetches on the last answer and asks again on the summary;
      // concurrent requests for the same state share one model call.
      const key = `${storagePort.root}:debrief:${a.runId}`;
      if (!coachInflight.has(key))
        coachInflight.set(key, providedDebrief(a).finally(() => coachInflight.delete(key)));
      return coachInflight.get(key);
    },
"coach.calibration.get": async function (a = {}) {
      const state = await storagePort.read();
      const course = typeof a.course === "string" ? a.course.trim() : "";
      const key = course || "__default__";
      const spec = state.learner?.examCoach?.[key] || null;
      const courses = [...new Set([
        ...(state.courses || []).map((c) => c?.name || c?.id),
        ...(state.sources || []).filter((s) => !s.archived).map((s) => s.course),
        ...(state.decks || []).filter((d) => !d.archived).map((d) => d.course),
      ].filter((v) => typeof v === "string" && v.trim()))];
      return {
        course,
        courses,
        spec: spec ? projectCoachSpecForView(spec) : null,
        solutionExposures: state.learner?.solutionExposures || [],
        evidence: computeCoachEvidence(state, { course, spec }),
      };
    },
"coach.calibration.analyze": async function (a = {}) {
      const state = await storagePort.read();
      const course = typeof a.course === "string" ? a.course.trim() : "";
      const key = course || "__default__";
      const analyzed = await analyzeAssessmentModes(state, {
        course,
        sourceIds: a.sourceIds,
        referenceSourceIds: a.referenceSourceIds,
        completeLight: a.useModel === true ? providedLight : null,
      });
      await storagePort.update((s) => {
        const learner = ensureLearner(s);
        learner.examCoach = { ...(learner.examCoach || {}), [key]: analyzed };
        learner.updatedAt = new Date().toISOString();
      });
      const fresh = await storagePort.read();
      const saved = fresh.learner?.examCoach?.[key] || analyzed;
      return {
        course,
        spec: projectCoachSpecForView(saved),
        evidence: computeCoachEvidence(fresh, { course, spec: saved }),
      };
    },
"coach.calibration.buildRequest": async function (a = {}) {
      const state = await storagePort.read();
      const course = typeof a.course === "string" ? a.course.trim() : "";
      const key = course || "__default__";
      const spec = a.spec || state.learner?.examCoach?.[key];
      if (!spec) throw new Error("尚未创建教练校准方案，请先执行「分析考察方式」");
      return compileCoachGenerationRequest(spec, state, a);
    },
"coach.mockPaper.compose": async function (a = {}) {
      const state = await storagePort.read();
      const course = typeof a.course === "string" ? a.course.trim() : "";
      return composeStrictMockPaper(state, { course, examShape: a.examShape || {} });
    }
};
const mutations = {
"coach.forget": (s) => {
      // Clears the profile and pending prepared cards; practice history and immutable solution-exposure receipts stay (#852/#853).
      const prevLearner = ensureLearner(s);
      const memoryRevision = (prevLearner.memoryRevision || 0) + 1;
      const preservedExposures = prevLearner.solutionExposures || [];
      s.learner = null;
      const learner = ensureLearner(s);
      learner.memoryRevision = memoryRevision;
      learner.solutionExposures = preservedExposures;
      s.prepared = s.prepared.filter((p) => p.status !== "ready");
      return { consent: learner.consent.prep, goal: "", preferences: [], summary: "", signals: learner.signals, updatedAt: null, ready: 0 };
    },
"coach.preferences": (s, a = {}) => {
      const learner = ensureLearner(s);
      let raw;
      if (a.preferences !== undefined) {
        if (!Array.isArray(a.preferences)) throw new Error("preferences must be an array of strings");
        raw = a.preferences;
      } else if (a.add !== undefined || a.remove !== undefined) {
        const adds = Array.isArray(a.add) ? a.add : a.add !== undefined ? [a.add] : [];
        const removes = new Set(
          (Array.isArray(a.remove) ? a.remove : a.remove !== undefined ? [a.remove] : [])
            .map((x) => {
              if (typeof x !== "string") throw new Error("Each preference must be a string");
              return x.replace(/\s+/g, " ").trim();
            })
            .filter(Boolean),
        );
        raw = [...(learner.preferences || []).filter((item) => !removes.has(item)), ...adds];
      } else {
        throw new Error("preferences must be an array of strings");
      }
      const checked = [];
      const seen = new Set();
      for (const entry of raw) {
        if (typeof entry !== "string") throw new Error("Each preference must be a string");
        const text = entry.replace(/\s+/g, " ").trim();
        if (!text || seen.has(text)) continue;
        if (text.length > LEARNER_PREFERENCE_MAX_CHARS) {
          throw new Error(`每条学习偏好不超过 ${LEARNER_PREFERENCE_MAX_CHARS} 字`);
        }
        seen.add(text);
        checked.push(text);
      }
      if (checked.length > LEARNER_PREFERENCES_MAX) {
        throw new Error(`学习偏好最多保存 ${LEARNER_PREFERENCES_MAX} 条`);
      }
      learner.preferences = checked;
      learner.updatedAt = new Date().toISOString();
      return { preferences: learner.preferences };
    },
"coach.goal": (s, a) => {
      const learner = ensureLearner(s);
      if (a.goal !== "" && !Object.hasOwn(GOALS, a.goal)) throw new Error("Unknown goal");
      learner.goal = a.goal;
      learner.updatedAt = new Date().toISOString();
      return { goal: learner.goal };
    },
"coach.practice": (s, a, ports) => {
      ensureLearner(s);
      // The wrong-book page can practise the variants of chosen mistakes, optionally with those mistakes.
      const only = Array.isArray(a.originCardIds) ? new Set(a.originCardIds) : null;
      const ready = s.prepared.filter((p) => p.status === "ready" && (!only || only.has(p.originCardId)));
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
      const also = (Array.isArray(a.scope) ? a.scope : []).filter((ref) => ref?.deckId && ref?.cardId);
      return ports.mutate("review.start", s, { mode: "path", scope: [...also, ...added], fresh: true });
    },
"coach.revert": (s, a) => {
      const { card } = findCard(s, a);
      const last = card.revisions?.at(-1);
      if (!last) throw new Error("This question has no earlier version");
      const result = applyCardContent(s, a, last.content, null, { keepAnswered: true });
      for (const n of s.coach || []) if (n.cardId === card.id && n.revertable) n.revertable = false;
      return { ...result, reverted: last.reason };
    },
"coach.calibration.save": (s, a = {}) => {
      const learner = ensureLearner(s);
      const course = typeof a.course === "string" ? a.course.trim() : "";
      const key = course || "__default__";
      const prev = learner.examCoach?.[key] || { course };
      const next = saveCoachSpec(prev, { ...a, course });
      learner.examCoach = { ...(learner.examCoach || {}), [key]: next };
      learner.updatedAt = new Date().toISOString();
      return {
        course,
        spec: projectCoachSpecForView(next),
        evidence: computeCoachEvidence(s, { course, spec: next }),
      };
    },
"coach.calibration.confirm": (s, a = {}) => {
      const learner = ensureLearner(s);
      const course = typeof a.course === "string" ? a.course.trim() : "";
      const key = course || "__default__";
      const prev = learner.examCoach?.[key];
      if (!prev) throw new Error("尚未创建教练校准方案");
      const res = confirmCalibrationFamily(prev, { ...a, learner, state: s });
      if (res.learner?.solutionExposures) learner.solutionExposures = res.learner.solutionExposures;
      learner.examCoach = { ...(learner.examCoach || {}), [key]: res.spec };
      learner.updatedAt = new Date().toISOString();
      return {
        course,
        spec: projectCoachSpecForView(res.spec),
        exposureReceipt: res.exposureReceipt,
        evidence: computeCoachEvidence(s, { course, spec: res.spec }),
      };
    }
};
  const reply = handlers['coach.reply'];
  handlers['coach.reply'] = args => {
    if (args.reply !== 'confused') return reply(args);
    const key = JSON.stringify([storagePort.root, args.noteId]);
    if (!coachReplyInflight.has(key)) coachReplyInflight.set(key, reply(args).finally(() => coachReplyInflight.delete(key)));
    return coachReplyInflight.get(key);
  };
  return { handlers, mutations };
}
