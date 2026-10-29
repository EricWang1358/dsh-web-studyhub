/* What the assistant's study_workspace tool may not do (lib/index.js runStudyTool). These actions belong to the learner's own clicks in the
   panel: the panel's door (lib/host.js) still carries them, with the confirmations it already asks for. Status, plan and history reads stay
   with the assistant, and so do the imports, which only use what the learner configured here. */

// Choosing the program StudyHub runs, installing or removing software and models, and stopping the local service are Settings-only.
const SETTINGS_ONLY = Object.freeze({
  'marker.install.start': 'it installs or removes software',
  'marker.install.uninstall': 'it installs or removes software',
  'marker.settings.set': 'it chooses the program StudyHub runs to convert PDFs',
  'mineru.install.start': 'it installs or removes software',
  'mineru.install.uninstall': 'it installs or removes software',
  'mineru.local.stop': 'it stops the local MinerU service the learner may be using',
  'live.local.install': 'it installs or removes software',
  'live.local.uninstall': 'it installs or removes software',
});

/* course.save {plan} (备考计划) is not Settings-only: the plan is drafted WITH the learner in the chat and the assistant saves it when they agree, on request
   (the consent rule is in the contract the assistant reads, lib/study-contracts.js area plan, and in the hand-off message that starts it). It cannot repoint
   anything: it is bounded dates and text on the course record (lib/courses.js checkedPlan), and the schedule built from it never changes a card or a result. */

/** The one read whose argument names a program: marker.local.status {command} starts that path with --help (the path box of 检测并保存). The assistant only asks about what the learner configured. */
export function assistantArgsRefusal(action, args, { liveProvider } = {}) {
  // Which engine hears the live class (local: the sound stays on this computer) is the learner's: the assistant can neither change the saved choice nor
  // start a class on another engine. `liveProvider` is the learner's saved choice, read by the caller for live.start.
  if (action === 'audio.settings.set' && args && typeof args === 'object' && Object.hasOwn(args, 'liveProvider'))
    return 'audio.settings.set with liveProvider is not available to the assistant: which engine hears a live class is the learner\'s choice, and the learner does that in Settings';
  if (action === 'live.start' && args && typeof args === 'object' && args.provider !== undefined && args.provider !== (liveProvider || 'auto'))
    return 'live.start with a provider other than the learner\'s saved choice is not available to the assistant: which engine hears a live class is the learner\'s choice, and the learner does that in Settings';
  if (action === 'marker.local.status' && args && typeof args === 'object' && Object.hasOwn(args, 'command'))
    return 'marker.local.status with a command is not available to the assistant: it chooses the program StudyHub runs to convert PDFs, and the learner does that in Settings';
  // Starting StudyHub's service stays the assistant's (a conversion does it anyway); stopping another MinerU on the way is the learner's, like mineru.local.stop.
  if (action === 'mineru.local.start' && args && typeof args === 'object' && args.stopExternal === true)
    return 'mineru.local.start with stopExternal is not available to the assistant: it stops another MinerU service the learner may be using, and the learner does that in Settings';
  return null;
}

/** Why `action` is not the assistant's to call, as the error it should see; null when it is. Decided by the name alone, before any argument is read. */
export function assistantRefusal(action) {
  // 带学: the session's side of a new question is recorded by study.question.prepare / result / cancel themselves (#547), never set by hand.
  if (['study.question.wait', 'study.question.settle', 'study.question.release'].includes(action))
    return `${action} is internal to guided study: use study.question.prepare, study.question.result and study.question.cancel`;
  // HB-1: Answers and submissions belong exclusively to the learner's own panel interactions
  if (['review.answer', 'exam.submit', 'oral.answer', 'oral.submit'].includes(action))
    return `${action} is not available to the assistant: answers and submission belong exclusively to the learner's own panel interactions (HB-1)`;
  if (action.startsWith('usage.frequency.'))
    return "usage.frequency.* is not available to the assistant: it is the learner's own usage record, used by the panel only";
  if (Object.hasOwn(SETTINGS_ONLY, action))
    return `${action} is not available to the assistant: ${SETTINGS_ONLY[action]}, and the learner does that in Settings`;
  return null;
}
