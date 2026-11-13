import { createContext, useContext } from 'react';

/* The controller App builds from its hooks and hands to the shell's own parts (sidebar, top bar, dialogs, page adapters).
   It is the app's internal wiring, so it is not for pages: a page reads the public services with useStudy()
   (ui/study-context.jsx). Fields: language, host, data, connection, core, shell, nav, lib (state), set (setters), session, learn,
   intents, drafts, notebooks, tour, inbox, sources, settingsEntry, dailyPlan, board. */
export const AppContext = createContext(null);

/** Is the reader (a material full-size) the open dialog of `modal` (lib.modal)? The daily plan listens while it is; the 对照栏 of the practice page gives way to it (one reader at a time, #1012). */
export const readerOpen = (modal) => modal?.type === 'source';

export function useApp() {
  const app = useContext(AppContext);
  if (!app) throw new Error('useApp must be used inside <App>');
  return app;
}
