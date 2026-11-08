import { refuseRetiredWorkflow } from "./workflows.js";

export function createWorkflowGuide() {
  /* Learning flows are retired (#779): historical sessions remain read-only via workflow.list / workflow.session.get,
     while quickstart, rescope and retelling feedback writes refuse and guide to course.method.* + study.session.*. */
  const workflowGuideHandlers = {
    "workflow.quickstart": async function () { refuseRetiredWorkflow(); },
    "workflow.rescope": async function () { refuseRetiredWorkflow(); },
    "workflow.feedback": async function () { refuseRetiredWorkflow(); },
  };
  return { workflowGuideHandlers };
}
