import { get, id } from "../../util.js";
import { findCard, linkPrerequisite } from "../../prereq.js";
import { notify } from "../../inbox.js";
import { suggestionDigest, suggestFollowups, followupQuestion, followupDigest, currentFollowups, answerFollowup } from "../../followup.js";
import { validateDeck, initialReview } from "../../domain.js";
import { ensureLearner, writeFollowup, threadView, FEEDBACK_TAGS, trimLogs, REWRITE_TAGS, debriefRules, runMetrics, GOALS, LEVEL_NAMES, MAX_READY } from "../../coach.js";
import { isSlayDeck } from "../../slay.js";
import { applyCardContent } from '../../card-content.js';


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
      const { deck, card } = findCard(await storagePort.read(), a);
      const digest = suggestionDigest(card, providedLanguage);
      if (card.followupSuggestions?.digest === digest)
        return { questions: card.followupSuggestions.questions };
      if (!providedLight) throw new Error("追问需要可用的模型");
      const ref = { deckId: deck.id, cardId: card.id };
      const key = JSON.stringify([storagePort.root, card.id, digest]);
      if (!suggestionInflight.has(key)) {
        suggestionInflight.set(key, suggestFollowups(providedLight, card).then((result) =>
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
      const { deck, card } = findCard(await storagePort.read(), a);
      const digest = followupDigest(card);
      // Retrying a submitted question reuses its answer, including after a reload.
      const existing = currentFollowups(card).find((item) => item.originalQuestion === question);
      if (existing) return { deckId: deck.id, cardId: card.id, item: existing };
      if (!providedLight) throw new Error("追问需要可用的模型");
      const ref = { deckId: deck.id, cardId: card.id };
      const key = JSON.stringify([storagePort.root, card.id, digest, question]);
      if (!followupInflight.has(key)) {
        followupInflight.set(key, answerFollowup(providedLight, card, question).then((reply) =>
          storagePort.update((s) => {
            const live = findCard(s, ref).card;
            if (followupDigest(live) !== digest) throw new Error("题目已更新，请返回新版题目重新追问");
            const saved = currentFollowups(live).find((item) => item.originalQuestion === question);
            if (saved) return { item: saved, prepEnabled: false };
            const item = { id: id(), at: new Date().toISOString(), digest, originalQuestion: question, ...reply };
            live.followups = [...(live.followups || []), item];
            notify(s, { kind: "followup", ...ref, detail: item.question });
            return { item, prepEnabled: providedCoach && s.learner?.consent.prep === true };
          }),
        ).then(({ item, prepEnabled }) => {
          if (prepEnabled)
            providedQueuePrep({ ...ref, reason: "followup", followupId: item.id });
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
        { consent, goal, summary, signals, updatedAt } = ensureLearner(s);
      return { consent: consent.prep, goal, summary, signals, updatedAt, ready: s.prepared.filter((p) => p.status === "ready").length };
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
          followup = await writeFollowup(providedLight, { card, note, learner });
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
      const result = await storagePort.update((s) => {
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
      // `rewriteVia: "assist"`: the panel opens its 修题 box for the rewrite tags (one visible path to the background assistant), so the
      // silent coach rewrite is not also started. Clients without the flag keep the background rewrite.
      const viaAssist = a.rewriteVia === "assist";
      const rewrite = result.added.filter((t) => REWRITE_TAGS.has(t));
      if (providedCoach && providedLight) {
        if (rewrite.length && !viaAssist) {
          providedScheduleRewrite(result.ref, rewrite);
          scheduled.push("rewrite");
        }
        for (const reason of result.added.filter((t) => t === "too-easy" || t === "too-hard"))
          if (result.consent === true) {
            providedQueuePrep({ ...result.ref, reason });
            scheduled.push("prep");
          }
      }
      return { vote, tags: result.added, scheduled, ...(viaAssist ? { fix: rewrite } : {}), status: providedCoachStatus(await storagePort.read(STATUS_FIELDS)) };
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
      const { deck, card } = findCard(await storagePort.read(), a);
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
    }
};
const mutations = {
"coach.forget": (s) => {
      // Clears the profile and pending prepared cards; practice history stays.
      const memoryRevision = (ensureLearner(s).memoryRevision || 0) + 1;
      s.learner = null;
      const learner = ensureLearner(s);
      learner.memoryRevision = memoryRevision;
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
