/* "Build the index" from a material's badge or a list's shortcut line: Settings opens at 检索扩展 (the extension's install step when it is not installed) with the
   course of that material already chosen. The build itself stays where it is (ui/ExtensionPanel.jsx): nothing starts from the click.
   The course is one value in its own module, as the audio section's request is (ui/audio-focus.js): the Settings pane reads it once when it opens. */
let course = '';
/** Ask for `name` (a course name; '' for none) to be the chosen course when the search-extension section opens. */
export const requestIndexCourse = (name) => { course = typeof name === 'string' ? name : ''; };
/** The course a link asked for ('' when none); read without taking it, so a pane that draws twice reads it twice. */
export const peekIndexCourse = () => course;
/** The pane has read it: the next visit to Settings starts clean. */
export const clearIndexCourse = () => { course = ''; };
/** The click handler of every "build the index" link: ask for the course, then open Settings at the search-extension section. */
export function openIndexBuilder(openSettings, name) {
  requestIndexCourse(name);
  openSettings?.('settings-extensions');
}
