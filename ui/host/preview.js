/* global window */
// Plan contract C3: the preview has no chat, agent tasks or landing shell. It has no model catalog either, unless a QA script puts one on the
// page (window.STUDY_MODEL_GROUPS, shaped as DSH's catalog groups: [{ id, name, models: [{ id, name }] }]).
export default { capabilities: { edition: "preview", chat: false, agentTasks: false, landing: false },
  ...(Array.isArray(window.STUDY_MODEL_GROUPS) ? { modelGroups: window.STUDY_MODEL_GROUPS } : {}) };
