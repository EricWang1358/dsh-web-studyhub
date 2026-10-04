import React from 'react';

/* Pages read call / act / busy / askInChat from useStudy() (ui/study-context.jsx). A test that renders one gives it those services here
   instead of as props: `withStudy(Context, element, { act })`, where Context is the StudyServicesContext of the same bundle as the page
   (export it from the stdin: `export { StudyServicesContext } from './ui/study-context.jsx'`). Anything not given is quiet; pass
   `undefined` explicitly to say the host offers nothing (a page that checks `if (call)` then draws its plain state). */
const noop = () => {};

/** The services of a quiet app, with `over` on top. */
export const services = (over = {}) => ({ call: async () => ({}), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {},
  openSettings: noop, navigate: noop, openModal: noop, ...over });

/** `<StudyServicesContext.Provider value={services(over)}>{element}</...>` */
export const withStudy = (Context, element, over = {}) => React.createElement(Context.Provider, { value: services(over) }, element);
