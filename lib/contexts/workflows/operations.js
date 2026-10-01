
import { workflowList, workflowContext, saveWorkflow, deleteWorkflow, startSession, saveSessionRecord, saveSessionMaterial, restoreSessionMaterial, advanceSession, goToStep, setSessionStatus, deleteSession, editableSession, currentStep, sessionCards } from "../../workflows.js";
import { id } from "../../util.js";
import { shuffled } from "../../domain.js";
import { projection } from '../../study-state.js';


/** workflows operations close over only the ports declared by this context. */
export function createOperations(ports) {
  const { state: storagePort, worker, teachingSession, language: providedLanguage } = ports;
const handlers = {
"workflow.list": async function () { return workflowList(await storagePort.read(), providedLanguage); },
"workflow.context": async function (a) { return workflowContext(await storagePort.read(), a); },
"workflow.session.get": async function (a) {
      return teachingSession(worker, a.id);
    }
};
const mutations = {
"workflow.save": saveWorkflow,
"workflow.delete": deleteWorkflow,
"workflow.session.start": startSession,
"workflow.session.record": saveSessionRecord,
"workflow.session.material": saveSessionMaterial,
"workflow.session.material.restore": restoreSessionMaterial,
"workflow.session.advance": advanceSession,
"workflow.session.goto": goToStep,
"workflow.session.status": setSessionStatus,
"workflow.session.delete": deleteSession,
"workflow.practice.start": (s, a) => {
      const session = editableSession(s, a), step = currentStep(session);
      if (step.kind !== "practice") throw new Error("当前不是练习步骤");
      const previous = session.records[step.id]?.runId;
      const earlier = previous && s.runs.find((r) => r.id === previous);
      // A finished or ended round is kept; "练一轮新的" starts another for the same step.
      if (earlier && !(a.fresh && (earlier.closedAt || earlier.entries.every((e) => e.feedback))))
        return { session, run: projection(s, earlier) };
      if (earlier) earlier.closedAt ||= new Date().toISOString();
      const cards = sessionCards(s, session).slice(0, step.count);
      if (!cards.length) throw new Error("本次学习范围没有可练习的题目，可以先补充资料或跳过本步");
      const run = { id: id(), mode: "path", workflowSessionId: session.id,
        deckId: new Set(cards.map((c) => c.deckId)).size === 1 ? cards[0].deckId : null,
        scope: session.scope, key: `workflow:${session.id}:${step.id}`, index: 0, startedAt: new Date().toISOString(),
        entries: cards.map(({ deckId, card }) => ({ deckId, card: structuredClone(card),
          order: card.options ? shuffled(card.options.map((o) => o.id)) : undefined,
          startedAt: Date.now(), feedback: null, revealed: false, selected: null })) };
      s.runs.push(run);
      session.records[step.id] = { ...session.records[step.id], runId: run.id };
      session.version++;
      session.updatedAt = new Date().toISOString();
      return { session, run: projection(s, run) };
    }
};
  return { handlers, mutations };
}
