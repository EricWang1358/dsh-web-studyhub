import { createContext, useContext } from 'react';

/* The services nearly every page needs, offered once instead of passed down as call={call} busy={busy} setNotice=… through
   every level (ui-consistency #113). App provides it; a page reads it with `const { call, act, busy } = useStudy()`.
     call(action, args)   ask the host (rejects when the library switched meanwhile)
     act(action, args, after, options)   the single-flight write: disables the page while it runs, refreshes the library after
     busy                 an act() is running
     notify(notice)       the app's one feedback region: a string or { text, tone, action, ... } (see useToast for the verbs)
     askInChat(text)      hand a prompt to the conversation (clipboard when the host has no composer)
     host                 what the host offers (openAgent, pickDirectory, openInSidebar ...)
     openSettings(section)   open Settings, optionally scrolled to a section
     navigate(page, options) the app's single navigation; openModal(modal) opens one of the app dialogs
   Pages owned by other work packages keep their props this wave and can adopt the context when they are next touched. */
export const STUDY_SERVICE_NAMES = Object.freeze(['call', 'act', 'busy', 'notify', 'askInChat', 'host', 'openSettings', 'navigate', 'openModal']);

const nothing = () => {};
const standalone = Object.freeze({
  call: async () => { throw new Error('StudyServicesContext is missing: render the page inside the app, or provide the services'); },
  act: async () => undefined,
  busy: false,
  notify: nothing,
  askInChat: nothing,
  host: Object.freeze({}),
  openSettings: nothing,
  navigate: nothing,
  openModal: nothing,
});

export const StudyServicesContext = createContext(null);

/** The app's services; a standalone, harmless set when rendered outside the app (tests, previews). */
export const useStudy = () => useContext(StudyServicesContext) || standalone;
