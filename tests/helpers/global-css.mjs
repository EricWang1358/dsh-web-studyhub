/* The global stylesheets that used to be ui/style.css (#154), for the tests that match rule text across them.
   GLOBAL_CSS_FILES is the cascade order of ui/styles.js. */
import { readFileSync } from 'node:fs';

export const GLOBAL_CSS_FILES = [
  'ui/tokens.css', 'ui/paper.css', 'ui/base.css', 'ui/legacy.css', 'ui/shell.css', 'ui/study-map/catalog.css', 'ui/review/question.css', 'ui/study-map/desk.css',
  'ui/sources-page.css', 'ui/binding.css', 'ui/audio-import.css', 'ui/draft.css', 'ui/review/session.css', 'ui/markdown.css', 'ui/followup.css', 'ui/motion.css',
];

const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** All the global sheets in cascade order, one string. */
export const globalCss = () => GLOBAL_CSS_FILES.map(read).join('\n');

/** One of them (path from the repo root). */
export const cssOf = read;
