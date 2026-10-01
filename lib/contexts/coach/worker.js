import { ownWork } from '../../runtime/work-ownership.js';
import { isSlayDeck } from "../../slay.js";
import { id, get } from "../../util.js";
import { findCard } from "../../prereq.js";
import { currentFollowups } from "../../followup.js";
import { notify } from "../../inbox.js";
import { isModelFailure, modelFailureMessage } from "../../model-retry.js";
import { FEEDBACK_TAGS, MAX_READY, cognitiveLevel, debriefRules, ensureLearner, evidenceWindows, learnerAnswer, runMetrics, threadView, trimLogs, staleSelfAssessment, writeDebrief, writeNudge, writeRewrite, writeVariants } from "../../coach.js";
import { applyCardContent, patchContent } from '../../card-content.js';

export function createCoachWorker(worker, work) {
  const { coachInflight, coachTasks, coachQueues, rewriteSlots, prepPending } = work;
  const MAX_PARALLEL_REWRITES = 3, PREP_DELAY_MS = 20000;
async function nudgeFor(runId, index) {
    const root = worker.store.root,
      s = await worker.store.read(),
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
        const nudge = await writeNudge(worker.light, {
          card: entry.card,
          answer,
          earlier: s.coach.filter((n) => n.cardId === cardId && n.point).map((n) => n.point).slice(-3),
          learner: s.learner,
        });
        return worker.store.update((st) => {
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

function coachTask(kind, label, meta, work) {
    const root = worker.store.root,
      list = coachTasks.get(root) || [];
    const task = { id: id(), kind, label, status: "running", startedAt: new Date().toISOString(), ...meta };
    ownWork(task, worker.workOwner);
    list.push(task);
    coachTasks.set(root, list.slice(-20));
    // Rewrites the learner asked for never wait behind a background prep batch,
    // and rewrites of different cards run in parallel (up to a small cap); two
    // rewrites of one card still queue so the second sees the first's result.
    const lane = kind === "rewrite" ? `${root}:rewrite:${meta.cardId}` : `${root}:prep`;
    const run = kind === "rewrite" ? () => worker.rewriteSlot(work) : work;
    const previous = coachQueues.get(lane) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => { if (task.cancelled) throw new Error('Work owner unloaded'); return run(); }).then(
      (message) => Object.assign(task, { status: "done", message: message || "", finishedAt: new Date().toISOString() }),
      (e) => Object.assign(task, { status: "failed", message: modelFailureMessage(e), finishedAt: new Date().toISOString() }),
    );
    coachQueues.set(lane, next);
    next.finally(() => {
      if (coachQueues.get(lane) === next) coachQueues.delete(lane);
    });
    return next;
  }

async function rewriteSlot(work) {
    const root = worker.store.root,
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

async function coachIdle() {
    const root = worker.store.root;
    for (;;) {
      const lanes = [...coachQueues.entries()].filter(([lane]) => lane.startsWith(`${root}:`)).map(([, p]) => p.catch(() => {}));
      if (!lanes.length) return;
      await Promise.all(lanes);
    }
  }

function queuePrep(target) {
    if (!worker.coach || !worker.light) return;
    const pending = prepPending.get(worker.workOwner) || { targets: [], timer: null, service: worker };
    ownWork(pending, worker.workOwner);
    pending.service = worker;
    if (!pending.targets.some((t) => t.cardId === target.cardId && t.reason === target.reason && t.followupId === target.followupId)) pending.targets.push(target);
    prepPending.set(worker.workOwner, pending);
    if (pending.targets.length >= 3) worker.flushPrep();
    else if (!pending.timer) {
      pending.timer = setTimeout(() => pending.service.flushPrep(), PREP_DELAY_MS);
      pending.timer.unref?.();
    }
  }

function flushPrep() {
    const pending = prepPending.get(worker.workOwner);
    if (!pending?.targets.length) return worker.coachIdle();
    clearTimeout(pending.timer);
    prepPending.delete(worker.workOwner);
    for (let i = 0; i < pending.targets.length; i += 4) {
      const batch = pending.targets.slice(i, i + 4);
      worker.coachTask("prep", `准备 ${batch.length} 道定制题`, { cardIds: [...new Set(batch.map((t) => t.cardId))] }, () => worker.writePrepared(batch));
    }
    return worker.coachIdle();
  }

async function writePrepared(batch) {
    const s = await worker.store.read(),
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
    const results = await writeVariants(worker.light, {
      targets: targets.slice(0, MAX_READY - ready.length),
      sources: s.sources.filter((x) => cited.has(x.id)),
      learner,
      existingPrompts: [...s.decks.flatMap((d) => d.cards.map((c) => c.prompt)), ...s.prepared.map((p) => p.card.prompt)],
    });
    if (!results.length) return "这批变式没有通过校验，已跳过";
    await worker.store.update((st) => {
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

function scheduleRewrite(ref, tags) {
    return worker.coachTask("rewrite", `按「${tags.map((t) => FEEDBACK_TAGS[t]).join("、")}」改题`, { cardId: ref.cardId, deckId: ref.deckId, tags }, async () => {
      const s = await worker.store.read(),
        learner = ensureLearner(s),
        { deck, card } = findCard(s, ref),
        evidence = evidenceWindows(s.sources, [card]);
      const apply = (p, summary) => worker.store.update((st) => {
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
      // Empty replies and provider errors are retried inside worker.light. A
      // second round only follows a reply we can correct: unparsable JSON or a
      // patch that fails validation (the error is fed back to the model).
      let errors;
      for (let round = 0; ; round++) {
        try {
          const { patch, summary } = await writeRewrite(worker.light, { card, tags, evidence, learner, errors });
          await apply(patch, summary);
          return summary;
        } catch (e) {
          // The model call itself failed (already retried or hedged inside
          // worker.light, or timed out): another round would only wait again.
          if (round >= 1 || isModelFailure(e)) throw e;
          errors = e.message;
        }
      }
    });
  }

function queueApplicationGaps(run, learner) {
    const seen = new Set();
    for (const e of run.entries)
      if (e.feedback?.grade >= 3 && !e.retry && cognitiveLevel(e.card, learner.levels[e.card.id]) !== "apply" && !seen.has(e.card.topic) && seen.size < 4) {
        seen.add(e.card.topic);
        worker.queuePrep({ deckId: e.deckId ?? run.deckId, cardId: e.card.id, reason: "application-gap" });
      }
  }

async function debrief(a) {
    const s = await worker.store.read(),
      run = get(s.runs, a.runId, "Review"),
      learner = ensureLearner(s);
    if (run.mode === "exam") throw new Error("模拟考试请看成绩单");
    const metrics = runMetrics(s, run),
      withStatus = (d) => ({ ...d, status: worker.coachStatus(s) });
    if (run.debrief?.version === 2 && run.debrief.answered === metrics.answered) return withStatus(run.debrief);
    const ready = s.prepared.filter((p) => p.status === "ready").length;
    const rules = debriefRules(metrics, { ready, consent: learner.consent.prep, modelReady: worker.coach && !!worker.light });
    if (rules.wantsPrep) {
      worker.queueApplicationGaps(run, learner);
      worker.flushPrep();
    }
    let model = null;
    if (worker.coach && worker.light && metrics.answered >= 3)
      try {
        model = await writeDebrief(worker.light, { metrics, rules, learner });
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
    await worker.store.update((st) => {
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

function coachActivity() {
    const root = worker.store.root;
    return [(coachTasks.get(root) || []).slice(-5).map((t) => [t.id, t.status]), prepPending.get(worker.workOwner)?.targets.length || 0];
  }

/* Per-card view of variant preparation for the wrong-book page: which cards
   are being written, which already have a variant, and which batch ended
   without one (with the plain-language reason). */
function variantStates(s, tasks) {
    const prep = tasks.filter((t) => t.kind === "prep"),
      readyRows = s.prepared.filter((p) => p.status === "ready"),
      readyIds = new Set(readyRows.map((p) => p.originCardId)),
      pending = prepPending.get(worker.workOwner)?.targets || [],
      preparing = new Set([...pending.map((t) => t.cardId), ...prep.filter((t) => t.status === "running").flatMap((t) => t.cardIds || [])]);
    const latest = new Map();
    for (const task of prep) for (const cardId of task.cardIds || []) latest.set(cardId, task);
    const failedCards = [];
    for (const [cardId, task] of latest) {
      if (task.status === "running" || preparing.has(cardId) || readyIds.has(cardId)) continue;
      if (s.prepared.some((p) => p.originCardId === cardId && p.createdAt >= task.startedAt)) continue;
      failedCards.push({ cardId, message: task.status === "failed" || !/^备好/.test(task.message || "") ? task.message || "没有写出通过校验的变式" : "这道题没有写出通过校验的变式，已跳过" });
    }
    return {
      preparingCards: [...preparing],
      readyCards: readyRows.map((p) => ({ id: p.id, originDeckId: p.originDeckId, originCardId: p.originCardId, reason: p.reason, prompt: p.card.prompt })),
      failedCards,
    };
  }

function coachStatus(s) {
    const learner = ensureLearner(s),
      root = worker.store.root,
      tasks = coachTasks.get(root) || [];
    return {
      enabled: worker.coach && !!worker.light,
      consent: learner.consent.prep,
      goal: learner.goal,
      ready: s.prepared.filter((p) => p.status === "ready").length,
      preparing: tasks.some((t) => t.kind === "prep" && t.status === "running") || !!prepPending.get(worker.workOwner)?.targets.length,
      ...variantStates(s, tasks),
      tasks: tasks.slice(-5).map(({ id, kind, label, status, message, cardId, cardIds, finishedAt }) => ({ id, kind, label, status, message, cardId, ...(cardIds ? { cardIds } : {}), finishedAt })),
    };
  }
  const methods = { nudgeFor, coachTask, rewriteSlot, coachIdle, queuePrep, flushPrep, writePrepared, scheduleRewrite, queueApplicationGaps, debrief, coachActivity, coachStatus };
  Object.assign(worker, methods);
  return methods;
}
