/* What the assistant's study_workspace tool may not do (lib/index.js runStudyTool). These actions belong to the learner's own clicks in the
   panel: the panel's door (lib/host.js) still carries them, with the confirmations it already asks for. Status, plan and history reads stay
   with the assistant, and so do the imports, which only use what the learner configured here. */

// Choosing the program StudyHub runs, installing software or models, and storing a service token or the consent to upload are Settings-only.
const SETTINGS_ONLY = Object.freeze({
  'marker.install.start': 'it installs or removes software',
  'marker.install.uninstall': 'it installs or removes software',
  'marker.settings.set': 'it chooses the program StudyHub runs to convert PDFs',
  'mineru.local.setup': 'it downloads models and changes the local MinerU configuration',
  'mineru.settings.set': 'it stores the MinerU token and the consent to upload PDFs to MinerU',
});

/** The one read whose argument names a program: marker.local.status {command} starts that path with --help (the path box of 检测并保存). The assistant only asks about what the learner configured. */
export function assistantArgsRefusal(action, args) {
  if (action === 'marker.local.status' && args && typeof args === 'object' && Object.hasOwn(args, 'command'))
    return 'marker.local.status with a command is not available to the assistant: it chooses the program StudyHub runs to convert PDFs, and the learner does that in Settings';
  return null;
}

/** Why `action` is not the assistant's to call, as the error it should see; null when it is. Decided by the name alone, before any argument is read. */
export function assistantRefusal(action) {
  // The usage frequency record is the learner's own: the panel reads and switches it, the assistant never does (docs/usage-frequency.md).
  if (action.startsWith('usage.frequency.'))
    return "usage.frequency.* is not available to the assistant: it is the learner's own usage record, used by the panel only";
  if (Object.hasOwn(SETTINGS_ONLY, action))
    return `${action} is not available to the assistant: ${SETTINGS_ONLY[action]}, and the learner does that in Settings`;
  return null;
}
