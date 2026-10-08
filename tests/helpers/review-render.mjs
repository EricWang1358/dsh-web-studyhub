import React from 'react';
import { reviewChoiceKind } from '../../ui/review/session-logic.js';

/* Review takes a session and a few links; the services come from the study context. Tests that render the practice page describe it with
   a plain object of the things they care about (run, data, selected, busy, host, coachProps, detour ...) and this helper builds the session,
   the services and the Review props from it. Anything not given is quiet: no handlers fire, nothing is selected. */
const noop = () => {};

/** { services, props } for Review. `old` may carry: run, data, shellTitle, feedback, coachProps, busy, host, call, act, askInChat, setPage, setModal, choice, isCloze,
 *  selected, hint, explain, response, clozeValues, teaching, teachAnswer, showBack, showEn, enBusyKey, teachingBusy, enterRun, reviewAct, assistCard,
 *  detour, contextReturnLabel, onReturnContext, onReturnFromDetour, and the links (onBackToWorkflow, onCourseFlow, openSkeleton, onOpenNote, onMakeNote,
 *  onMakeTask, onRecapSettings, onModelSettings, onReturnToReading). */
export function reviewParts(old) {
  const kind = reviewChoiceKind(old.run);
  const entry = { selected: old.selected ?? [], hint: !!old.hint, explain: !!old.explain, response: old.response ?? '', clozeValues: old.clozeValues ?? {},
    teaching: old.teaching ?? null, teachAnswer: old.teachAnswer ?? '' };
  const actions = { reviewAct: old.reviewAct ?? noop, choose: noop, flipCard: noop, assistCard: old.assistCard ?? noop, slayCard: noop, studyPrerequisites: noop,
    teachingAct: old.teachingAct ?? noop, toggleEn: noop, toggleHelp: noop, setResponse: noop, setClozeValue: noop, setTeachAnswer: noop, closeShortcutHelp: noop,
    showExplanation: noop, askAboutCard: noop, improveCard: noop, toggleAutopilot: old.toggleAutopilot ?? noop };
  const session = { run: old.run, entry, showBack: !!old.showBack, showEn: !!old.showEn, enBusyKey: old.enBusyKey || '', teachingBusy: !!old.teachingBusy,
    autopilot: !!old.autopilot, choice: old.choice ?? kind.choice, isCloze: old.isCloze ?? kind.isCloze, rubricCard: kind.rubricCard, enterRun: old.enterRun ?? noop, actions };
  const services = { call: old.call ?? (async () => ({})), act: old.act ?? (async () => undefined), busy: !!old.busy, notify: noop, askInChat: old.askInChat ?? noop,
    host: old.host ?? {}, openSettings: noop, navigate: old.setPage ?? noop, openModal: old.setModal ?? noop };
  const links = Object.fromEntries(['onBackToWorkflow', 'onCourseFlow', 'openSkeleton', 'onOpenNote', 'onMakeNote', 'onMakeTask', 'onRecapSettings', 'onModelSettings', 'onReturnToReading']
    .filter((name) => old[name]).map((name) => [name, old[name]]));
  const context = { label: old.contextReturnLabel, onReturn: old.onReturnContext, detour: old.detour, onReturnFromDetour: old.onReturnFromDetour };
  // The background assistant's tasks are part of the library snapshot (data.assist).
  const data = old.assistTasks ? { ...old.data, assist: old.assistTasks } : old.data;
  return { services, props: { session, data, shellTitle: old.shellTitle, feedback: old.feedback, coachProps: old.coachProps, links, context } };
}

/** <StudyServicesContext.Provider><Review/></...> from the old-style description. */
export function reviewElement(Review, StudyServicesContext, old) {
  const { services, props } = reviewParts(old);
  return React.createElement(StudyServicesContext.Provider, { value: services }, React.createElement(Review, props));
}
