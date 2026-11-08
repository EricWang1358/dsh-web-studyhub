import { workflowList, workflowContext, refuseRetiredWorkflow } from "../../workflows.js";

/** workflows operations close over only the ports declared by this context.
    Learning flows are retired (#779); historical records remain read-only while all write mutations refuse with guidance. */
export function createOperations(ports) {
  const { state: storagePort, worker, teachingSession, language: providedLanguage } = ports;
  const handlers = {
    "workflow.list": async function () { return workflowList(await storagePort.view(), providedLanguage); },
    "workflow.context": async function (a) { return workflowContext(await storagePort.view(), a, providedLanguage); },
    "workflow.session.get": async function (a) { return teachingSession(worker, a.id); },
  };
  const mutations = {
    "workflow.save": refuseRetiredWorkflow,
    "workflow.delete": refuseRetiredWorkflow,
    "workflow.session.start": refuseRetiredWorkflow,
    "workflow.session.record": refuseRetiredWorkflow,
    "workflow.session.material": refuseRetiredWorkflow,
    "workflow.session.material.restore": refuseRetiredWorkflow,
    "workflow.session.advance": refuseRetiredWorkflow,
    "workflow.session.goto": refuseRetiredWorkflow,
    "workflow.session.status": refuseRetiredWorkflow,
    "workflow.session.delete": refuseRetiredWorkflow,
    "workflow.practice.start": refuseRetiredWorkflow,
  };
  return { handlers, mutations };
}
