/* The global stylesheets, in cascade order (ui-consistency #154). They used to be one ui/style.css; each file now sits next to the
   components it styles. The DSH host injects them together (host/workspace.jsx); the standalone preview bundles them in this
   order (ui/dev.jsx imports this module first). Views that mount later bring their own sheets (useInjectCss).
   Where a stylesheet is not a string (the preview bundles CSS instead), it is left out of the text. */
import tokens from './tokens.css';
import paper from './paper.css';
import base from './base.css';
import legacy from './legacy.css';
import shell from './shell.css';
import catalog from './study-map/catalog.css';
import question from './review/question.css';
import desk from './study-map/desk.css';
import sourcesPage from './sources-page.css';
import binding from './binding.css';
import audioImport from './audio-import.css';
import draft from './draft.css';
import session from './review/session.css';
import markdown from './markdown.css';
import followup from './followup.css';
import motion from './motion.css';

export const GLOBAL_SHEETS = [tokens, paper, base, legacy, shell, catalog, question, desk, sourcesPage, binding, audioImport, draft, session, markdown, followup, motion];

export default GLOBAL_SHEETS.filter((sheet) => typeof sheet === 'string').join('\n');
