/* #1073: find the "go on" actions of ui/ by a rule, not by a list, and decide their arrow by what they do (ui/DESIGN.md, Icons).
   A "go on" action is a Button whose words start with a verb of going on (去 / 练 / 继续 / 开始 / 接着). It takes the learner somewhere (another page, a question,
   a practice round), so it ends in `arrow-right`; a control that acts where it stands (a job's 继续 / 接着做 on its card, a timer, a capture, the submit of a form,
   a confirm that starts a background task) does its work in place and has no arrow, whatever its verb. The English catalogue maps these labels to
   Go / Practise / Resume / Continue / Start, so the Chinese source key is the one place to look. */

const GO_ON = /^(?:去|练|继续|开始|接着)/u;
/** The words a Button can be given directly: ui('…'), uiFormat('…', …) or uiMessage('…'). */
const LITERAL = /\bui(?:Format|Message)?\(\s*(["'`])((?:\\.|(?!\1).)*)\1/gu;
const literalsOf = (text) => [...text.matchAll(LITERAL)].map((match) => match[2]);

/** The source of the tag that starts at `at` (`<Button …>`): to the first `>` outside braces and quotes. */
function openingTagEnd(source, at) {
  let depth = 0, quote = '';
  for (let end = at; end < source.length; end++) {
    const ch = source[end];
    if (quote) { if (ch === '\\') end++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '>' && !depth && source[end - 1] !== '=') return end;
  }
  return -1;
}

/** Every `<Button …>children</Button>` of a source file: { open, children }. A self-closing Button has no label of its own and is left out. */
export function buttonElements(source) {
  const found = [];
  for (let at = source.indexOf('<Button'); at >= 0; at = source.indexOf('<Button', at + 1)) {
    if (!/[\s>]/.test(source[at + 7] ?? '')) continue;
    const end = openingTagEnd(source, at);
    if (end < 0 || source[end - 1] === '/') continue;
    const close = source.indexOf('</Button>', end);
    if (close < 0) continue;
    found.push({ open: source.slice(at, end + 1), children: source.slice(end + 1, close) });
  }
  return found;
}

/** The expression of a prop of an opening tag (`onClick={…}`, balanced braces), or ''. */
export function propOf(open, name) {
  const at = open.search(new RegExp(`\\s${name}=\\{`));
  if (at < 0) return '';
  const start = open.indexOf('{', at);
  let depth = 0;
  for (let end = start; end < open.length; end++) {
    if (open[end] === '{') depth++;
    else if (open[end] === '}' && --depth === 0) return open.slice(start + 1, end);
  }
  return '';
}

/** The helpers of ui/ that hand a Button its words: `const name = (…) => …` on one line or a short `function name(…) { … }` whose body says ui('…') /
    uiFormat('…'). A table keyed by its argument (`({ resume: ui('继续'), … })[action]`) also knows which label each key gives. name → { all, byKey }. */
export function labelHelpers(sources) {
  const helpers = new Map();
  const add = (name, body) => {
    const all = literalsOf(body);
    if (!all.length || helpers.has(name)) return;
    const byKey = new Map([...body.matchAll(/['"]?([\w-]+)['"]?:\s*ui(?:Format)?\(\s*(["'`])((?:\\.|(?!\2).)*)\2/gu)].map((match) => [match[1], match[3]]));
    helpers.set(name, { all, byKey });
  };
  for (const { source } of sources) {
    for (const match of source.matchAll(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)\n]*\)|[A-Za-z_$][\w$]*)\s*=>([^\n]*)/g)) add(match[1], match[2]);
    for (const match of source.matchAll(/(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{([\s\S]{0,600}?)\n\}/g)) add(match[1], match[2]);
  }
  return helpers;
}

/** Every label the children of a Button can show: what they say directly, and what a helper they call returns (the one its literal key picks, else all). */
export function labelsOf(children, helpers = new Map()) {
  const labels = literalsOf(children);
  for (const match of children.matchAll(/\b([A-Za-z_$][\w$]*)\(\s*(?:(["'])([\w-]+)\2)?/g)) {
    const helper = !/^ui(?:Format|Message)?$/.test(match[1]) && helpers.get(match[1]);
    if (!helper) continue;
    const keyed = match[3] !== undefined && helper.byKey.get(match[3]);
    labels.push(...(keyed ? [keyed] : helper.all));
  }
  return labels;
}

/** The places where a go-on verb acts where it stands, decided by what the control does there (its onClick handler), not by its words.
    `handler` is a name the onClick calls; without it every go-on Button of the file is one of them. */
export const IN_PLACE = [
  { file: 'ui/Ingest.jsx', why: 'the submit of the paste form: it hands the text to the main chat, the learner stays' },
  { file: 'ui/AudioImport.jsx', why: 'the submit of the audio form: the import runs in the background, the learner stays' },
  { file: 'ui/LiveClass.jsx', why: 'the capture controls of a live class: start, pause and resume the recording on this page' },
  { file: 'ui/MineruInstallCard.jsx', why: 'the installer card: 继续安装 goes on installing on this card' },
  { file: 'ui/PdfConvertJob.jsx', handler: 'onRetry', why: '接着做 retries the conversion on its own row of the history' },
  { file: 'ui/UsageSettings.jsx', handler: 'onPause', why: 'a switch of the settings page: the record goes on, the page stays' },
  { file: 'ui/ExplanationFollowup.jsx', handler: 'onAskMore', why: 'sends the follow-up typed above it into the same thread' },
  { file: 'ui/document-preview/PageAsk.jsx', handler: 'onContinue', why: 'reads the next part of the page into the same answer' },
  { file: 'ui/companions/CompanionBuildDialog.jsx', handler: 'handleBuild', why: 'the confirm of a dialog: it starts a background build and the learner stays' },
  { file: 'ui/document-preview/translation/TranslationMenu.jsx', handler: 'onStart', why: 'the confirm of a menu panel: it starts a background translation of this page' },
  { file: 'ui/document-preview/reader/OutlineAssist.jsx', handler: 'onRun', why: 'the confirm of the outline assistant form: it starts a background task' },
];

/** Why a Button acts where it stands, or '' when it takes the learner somewhere. One decision, in this order: a job or data action (`act(…)`, the study
    actions: 继续 / 接着做 / 继续安装 on a job's card or the console, the page stays); a listed place (IN_PLACE). A form's submit is decided by what it starts:
    开始本轮 submits and goes on to the round, so it keeps its arrow. `used` collects the listed places that matched. */
export function inPlaceWhy(open, file = '', used = null) {
  const click = propOf(open, 'onClick');
  if (/(?:^|[^\w$.])(?:core\.)?act\(/.test(click)) return 'it runs a job or data action (act) on what is shown; the page stays';
  const place = IN_PLACE.find((entry) => entry.file === file && (!entry.handler || new RegExp(`\\b${entry.handler}\\b`).test(click)));
  if (place) used?.add(place);
  return place?.why || '';
}

/** The go-on Buttons of one source file whose arrow does not match what they do: [{ label, open, want }]. A Button with its own leading icon (the sparkle of
    生成) takes no arrow either way; the test checks that no Button leads with a play icon. (An action spec `{ label, run }` is drawn by one component that decides
    its arrow itself.) */
export function goOnProblems(source, { file = '', helpers = new Map(), used = null } = {}) {
  const problems = [];
  for (const { open, children } of buttonElements(source)) {
    const labels = labelsOf(children, helpers).filter((label) => GO_ON.test(label));
    if (!labels.length || /\sicon=/.test(open)) continue;
    const arrow = /\biconEnd=/.test(open), here = inPlaceWhy(open, file, used);
    const want = here && arrow ? `no arrow: ${here}` : !here && !arrow ? 'iconEnd="arrow-right": it takes the learner somewhere' : '';
    if (want) problems.push({ label: labels.join(' | '), open: open.replace(/\s+/g, ' ').slice(0, 120), want });
  }
  return problems;
}

/** Every `<Icon …/>` of a source file: { tag, prop } where `prop` is true for an icon handed to a Button / IconButton as `icon={<Icon …/>}`. */
export function iconTags(source) {
  return [...source.matchAll(/<Icon\b[^>]*?\/>/g)].map((match) => ({
    tag: match[0],
    prop: /(?:icon|iconEnd|leading|trailing)(?:=\{|:)\s*$/.test(source.slice(Math.max(0, match.index - 40), match.index)),
  }));
}

/** Every place of a source file that leads a control's words with the play icon: a Button with words and `icon="play"` (or an expression that can give 'play'),
    and an action spec `{ …, icon: 'play' }` (a menu item, a flow's button). [{ kind, open }] */
export function playLeads(source) {
  const found = [];
  for (const { open, children } of buttonElements(source)) {
    const icon = /\sicon="([^"]*)"/.exec(open)?.[1] ?? propOf(open, 'icon');
    if (/(?:^|['"])play(?:['"]|$)/.test(icon) && children.trim()) found.push({ kind: 'button', open: open.replace(/\s+/g, ' ') });
  }
  for (const match of source.matchAll(/\{[^{}\n]*\bicon:\s*['"]play['"][^{}\n]*\}/g)) found.push({ kind: 'spec', open: match[0].slice(0, 140) });
  return found;
}
