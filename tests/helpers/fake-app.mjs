/* A stand-in for the app's controller (ui/app/app-context.js) and its public services (ui/study-context.jsx), for tests that render a
   page or a Settings pane outside <App>. The test's own bundle exports the two contexts, so the provider and the component share
   one instance:
     const m = await loadUi(`export { AppContext } from './ui/app/app-context.js'; export { StudyServicesContext } from './ui/study-context.jsx'; ...`);
     renderToStaticMarkup(inApp(m, element, { data, call }))
   Only the fields a pane reads are filled; pass `app` / `services` to add or override. */
import React from 'react';

const noop = () => {};

export function fakeApp({ data = {}, host = {}, call = noop, busy = false, app = {} } = {}) {
  return {
    language: 'zh', host, data, canChat: false,
    connection: { binding: { root: data.root || '/library', rootSource: 'workspace', modelSource: 'session', provider: '', model: '', effort: { current: '' } },
      setBinding: noop, updateBinding: noop, running: false },
    core: { call, act: noop, busy, notify: noop, setError: noop },
    settingsEntry: { setCourseSettings: noop, openSettings: noop, openModelSettings: noop },
    tour: { tourResume: null, sampleBusy: false, startTour: noop, loadSampleOnly: noop, setRemovingSample: noop },
    ...app,
  };
}

export function inApp(m, element, { data, host = {}, call, act, busy = false, notify = noop, app, services } = {}) {
  const study = { call: call || (async () => { throw new Error('no call'); }), act: act || (async () => undefined), busy, notify, askInChat: noop, host,
    openSettings: noop, navigate: noop, openModal: noop, ...services };
  return React.createElement(m.StudyServicesContext.Provider, { value: study },
    React.createElement(m.AppContext.Provider, { value: fakeApp({ data, host, call: study.call, busy, app }) }, element));
}
