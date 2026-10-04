import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* Settings loads each category's pane lazily (ui/settings-groups.js). A static render of an unloaded pane shows its loading line, so a test
   that looks inside a pane first renders the page once with every category showing (the tour layout), lets the modules arrive, and then
   renders as usual: the loaded panes render synchronously from then on. `Settings` is the bundled default export. */
export async function warmSettingsPanes(Settings, props = {}) {
  const noop = () => {};
  const element = React.createElement(Settings, { data: { settings: {}, focus: { courses: [] }, sources: [], decks: [], courses: [], root: 'r' },
    settings: {}, setSettings: noop, legacy: '', setLegacy: noop, exportData: noop, onRestored: noop, tourActive: true, ...props });
  renderToStaticMarkup(element);
  await new Promise(resolve => setTimeout(resolve, 50));
  renderToStaticMarkup(element);
  await new Promise(resolve => setTimeout(resolve, 50));
}
