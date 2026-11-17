/* #1073: find the "go on" actions of ui/ by a rule, not by a list, and decide their arrow by what they do (ui/DESIGN.md, Icons).
   A "go on" action is a Button whose words start with a verb of going on or of going somewhere (GO_ON_WORDS). It takes the learner somewhere (another page,
   a question, a practice round), so it ends in `arrow-right`; a control that acts where it stands (a job's 继续 / 接着做 on its card, a timer, a capture, the submit of
   a form, a confirm that starts a background task, a click that only sets state on this page such as opening a dialog) does its work in place and has no arrow,
   whatever its words. The English catalogue maps these labels to Go / Practise / Resume / Continue / Start / Go to / Open, so the Chinese source key is the one
   place to look. This list and `inPlaceWhy` are the whole decision: a new label that starts with one of the words is caught, one that acts in place says why. */

/** The words that lead a control which takes the learner somewhere: the verbs of going on (去 / 练 / 继续 / 开始 / 接着) and the two that name where it goes
    (前往 前往设置, 打开 打开资料). 查看 is not here: it shows (a fold, a filter, a panel) as often as it goes, and the click decides that, not the verb. */
export const GO_ON_WORDS = ['去', '练', '继续', '开始', '接着', '前往', '打开'];
const GO_ON = new RegExp(`^(?:${GO_ON_WORDS.join('|')})`, 'u');
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

/** Every `<Button …>children</Button>` of a source file: { open, children, at } (`at` is where the tag starts). A self-closing Button has no label of its own and is left out. */
export function buttonElements(source) {
  const found = [];
  for (let at = source.indexOf('<Button'); at >= 0; at = source.indexOf('<Button', at + 1)) {
    if (!/[\s>]/.test(source[at + 7] ?? '')) continue;
    const end = openingTagEnd(source, at);
    if (end < 0 || source[end - 1] === '/') continue;
    const close = source.indexOf('</Button>', end);
    if (close < 0) continue;
    found.push({ open: source.slice(at, end + 1), children: source.slice(end + 1, close), at });
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
    // A helper that only calls another helper (`useModelSettingsLabel = () => modelSettingsLabel(…)`) hands on that one's words.
    const calls = [...body.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\(/g)].map((match) => match[1]).filter((call) => call !== name && !/^ui(?:Format|Message)?$/.test(call));
    if ((!all.length && !calls.length) || (helpers.has(name) && (helpers.get(name).all.length || !all.length))) return;
    const byKey = new Map([...body.matchAll(/['"]?([\w-]+)['"]?:\s*ui(?:Format)?\(\s*(["'`])((?:\\.|(?!\2).)*)\2/gu)].map((match) => [match[1], match[3]]));
    helpers.set(name, { all, byKey, calls: [...new Set(calls)] });
  };
  for (const { source } of sources) {
    for (const match of source.matchAll(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\([^)\n]*\)|[A-Za-z_$][\w$]*)\s*=>([^\n]*)/g)) add(match[1], match[2]);
    for (const match of source.matchAll(/(?:export\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{([\s\S]{0,600}?)\n\}/g)) add(match[1], match[2]);
  }
  return helpers;
}

/** What a helper returns: its own words (the one its literal key picks, else all) and, through the helpers it calls, theirs (a short chain, never a loop). */
function helperLabels(name, helpers, key, seen = new Set()) {
  const helper = helpers.get(name);
  if (!helper || seen.has(name) || seen.size > 5) return [];
  seen.add(name);
  const keyed = key !== undefined && helper.byKey.get(key);
  return [...(keyed ? [keyed] : helper.all), ...helper.calls.flatMap((call) => helperLabels(call, helpers, undefined, seen))];
}

/** The one-line declarations of a source file (`const settingsLabel = useModelSettingsLabel()`, or `a = 1, settingsLabel = …`): name → what it is set to. */
export function varsOf(source) {
  const vars = new Map();
  for (const match of source.matchAll(/(?:\b(?:const|let)\s+|,\s*)([A-Za-z_$][\w$]*)\s*=\s*((?:[^\n;,()]|\([^()\n]*\))*)/g)) if (!vars.has(match[1])) vars.set(match[1], match[2]);
  return vars;
}

/** Every label the children of a Button can show: what they say directly, what a helper they call returns (the one its literal key picks, else all), and what a
    variable they show was set to (`{settingsLabel}`, with the file's `varsOf`). */
export function labelsOf(children, helpers = new Map(), vars = new Map()) {
  const labels = literalsOf(children);
  for (const match of children.matchAll(/\b([A-Za-z_$][\w$]*)\(\s*(?:(["'])([\w-]+)\2)?/g)) {
    if (!/^ui(?:Format|Message)?$/.test(match[1])) labels.push(...helperLabels(match[1], helpers, match[3]));
  }
  for (const match of children.matchAll(/\{\s*([A-Za-z_$][\w$]*)\s*\}/g)) if (vars.has(match[1])) labels.push(...labelsOf(vars.get(match[1]), helpers));
  return labels;
}

/** The places where a go-on verb acts where it stands, decided by what the control does there (its onClick handler), not by its words.
    `handler` is a name (or `a|b`) the onClick calls; `submit` is a form's submit button (no onClick of its own). Every entry names the control, so a navigating label
    in the same file (LiveClass's 打开资料) is still caught. */
export const IN_PLACE = [
  { file: 'ui/Ingest.jsx', submit: true, why: 'the submit of the paste form: it hands the text to the main chat, the learner stays' },
  { file: 'ui/AudioImport.jsx', submit: true, why: 'the submit of the audio form: the import runs in the background, the learner stays' },
  { file: 'ui/LiveClass.jsx', submit: true, why: 'the submit of the live class form: it starts the recording on this page' },
  { file: 'ui/LiveClass.jsx', handler: 'onResume|perform', why: 'the capture controls of a live class: pause and resume the recording on this page' },
  { file: 'ui/MineruInstallCard.jsx', handler: 'start', why: 'the installer card: 继续安装 goes on installing on this card' },
  { file: 'ui/PdfConvertJob.jsx', handler: 'onRetry', why: '接着做 retries the conversion on its own row of the history' },
  { file: 'ui/UsageSettings.jsx', handler: 'onPause', why: 'a switch of the settings page: the record goes on, the page stays' },
  { file: 'ui/ExplanationFollowup.jsx', handler: 'onAskMore', why: 'sends the follow-up typed above it into the same thread' },
  { file: 'ui/document-preview/PageAsk.jsx', handler: 'onContinue', why: 'reads the next part of the page into the same answer' },
  { file: 'ui/companions/CompanionBuildDialog.jsx', handler: 'handleBuild', why: 'the confirm of a dialog: it starts a background build and the learner stays' },
  { file: 'ui/document-preview/translation/TranslationMenu.jsx', handler: 'onStart', why: 'the confirm of a menu panel: it starts a background translation of this page' },
  { file: 'ui/document-preview/reader/OutlineAssist.jsx', handler: 'onRun', why: 'the confirm of the outline assistant form: it starts a background task' },
];

/* ---- What a click does: read from its handler, never from its words -----------------------------------------------------------------------------------------
   Round 6 of the review: the words are a hint, the handler is the gate. Every Button with words and every `{ label, onClick }` / `{ label, run }` action is read
   by what its click calls: it leaves (another page or view, a practice run, a way back) or it acts where it stands (a setter of this page's state, a job or data
   action, a dialog over the page). Only a handler that says neither (a prop called `onPick`, a host call) falls back to the words (GO_ON_WORDS). */

/** Calls that say nothing about where the learner ends up: words, collections, timers, the event. */
const NEUTRAL = new Set(['ui', 'uiFormat', 'uiMessage', 'map', 'filter', 'find', 'some', 'every', 'includes', 'has', 'trim', 'join', 'slice', 'split', 'push', 'String',
  'Number', 'Boolean', 'Date', 'Set', 'Map', 'Array', 'Object', 'now', 'max', 'min', 'requestAnimationFrame', 'setTimeout', 'clearTimeout', 'flushSync', 'async',
  'if', 'for', 'while', 'switch', 'catch', 'then', 'finally', 'void', 'return', 'stopPropagation', 'preventDefault', 'closest', 'querySelector', 'toISOString',
  'toString', 'flatMap', 'keys', 'values', 'entries', 'parse', 'stringify', 'resolve', 'all', 'from', 'assign', 'useCallback', 'Promise', 'Error', 'log', 'warn']);
/** A dialog, a sheet, a menu or an editor opened over this page (by the page or the host: `openModal`, `host.setModal`, `openImport`): the learner stays
    (录入课程重点…, 展开窗口, 继续解析 reopens the import dialog). */
const OVER_PAGE = /^(?:(?:on)?[oO]pen\w*(?:Modal|Dialog|Sheet|Menu|Composer|Editor|Peek|Popover|Picker|Import)|setModal)$/;
/** The handlers that take the learner somewhere: a router or a page setter (navigate, nav.show.page, setPage, setScreen, setView, setRoute), a go or open prop
    (onGo…, go…, onOpen…, open…), the settings, the library, the board, the sources, the wrong book, a way back (onBack, onExit), a practice run (onPractice…,
    practice…, startReview, onReviewWeak, act('review.start', …)). */
const LEAVE = /^(?:navigate|go|goTo|goto|go[A-Z]\w*|on(?:Go|Open|Navigate|Practi[cs]e|Library|Board|Today|Sources|WrongBook|Jobs|Tasks|Back|Exit)\w*|on\w*Settings|open[A-Z]\w*|practi[cs]e[A-Z]?\w*|on\w*Practi[cs]e|start(?:Review|Round|Course|Path|Practice|Practise)\w*|onReviewWeak|set(?:Page|Screen|View|Route))$/;
const LEAVE_PATH = /(?:^|\.)(?:nav|router|history)\.|\.show\.|^wayBack\.go$/;
const LOCAL_BODY = 240;
/** The two modals that are views of their own, not dialogs over the page: the reader of a source and a companion lesson. Opening one takes the learner there. */
const VIEW_MODAL = /\b(?:openModal|setModal)\(\s*\{\s*type:\s*(['"])(?:source|companion)\1/;
/** A window outside StudyHub (the system browser, DSH's plugin manager): it leads with the `external` mark, never the go-on arrow. */
const EXTERNAL = /^(?:openFile|openExternal|openUrl|openPluginManager)$/;
const STARTS_RUN = /\bact\(\s*(['"])(?:review|exam)\.start\1/;
/** The handlers that act where they stand, when the page defines or owns them (an undotted call): a setter of this page's state, a job or data action (act, core.act),
    a toggle, a fold, a focus, a copy, a close. A dotted call (`host.setModal`) is not the page's own. */
const HERE = /^(?:set[A-Z]\w*|act|toggle\w*|onToggle\w*|focus|blur|select|scrollIntoView|copy|writeText|dismiss|close|onClose|onDismiss|onCancel|cancel|onChange|onExpand\w*|onCollapse\w*|onFold\w*)$/;

/** The source of the balanced `{…}` that starts at `at`, or ''. */
function balanced(source, at) {
  let depth = 0, quote = '';
  for (let end = at; end < source.length; end++) {
    const ch = source[end];
    if (quote) { if (ch === '\\') end++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(at, end + 1);
  }
  return '';
}

/** The handlers a source file defines itself, so a click that calls one is read through its body: `const name = (…) => …` (on one line or a braced body, also in
    `useCallback`), `function name(…) { … }`, and the properties of `x.current = { name: value }` (as `x.current.name`). name → body. */
export function localHandlers(source) {
  const locals = new Map();
  for (const match of source.matchAll(/(?:\bconst|\blet|,)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:useCallback\(\s*)?(?:async\s*)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*/g)) {
    const at = match.index + match[0].length;
    const body = source[at] === '{' ? balanced(source, at) : source.slice(at).split('\n')[0];
    if (!locals.has(match[1])) locals.set(match[1], body);
  }
  for (const match of source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) if (!locals.has(match[1])) locals.set(match[1], balanced(source, match.index + match[0].length - 1));
  for (const match of source.matchAll(/\b([A-Za-z_$][\w$]*)\.current\s*=\s*\{/g)) {
    const object = balanced(source, match.index + match[0].length - 1);
    for (const prop of object.matchAll(/[{,]\s*([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$.]*)/g)) locals.set(`${match[1]}.current.${prop[1]}`, prop[2]);
  }
  return locals;
}

/** The calls of a handler, as their dotted paths (`nav.show.page`, `onGoGenerate`); a handler that is only a name (`onClick={onGoGenerate}`) is that one call. */
function callsOf(click) {
  const text = click.trim();
  if (/^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*$/.test(text)) return [text.replace(/\?\./g, '.')];
  return [...text.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*)\s*(?:\?\.)?\(/g)].map((match) => match[1].replace(/\?\./g, '.'));
}

/** What a click does, from its handler alone: 'leave' (it takes the learner somewhere: another page or view, a practice run, a way back), 'here' (it acts where it
    stands: only setters of this page's state, a job or data action, a dialog over the page), 'external' (a window outside StudyHub), or '' when the handler does not say (a prop such as `onPick`, a host
    call): then the words decide. A handler defined in the same file (`locals`, from localHandlers) is read through its body. */
export function clickDoes(click, locals = new Map(), seen = new Set()) {
  if (!click || !click.trim()) return '';
  if (STARTS_RUN.test(click) || VIEW_MODAL.test(click)) return 'leave';
  const found = [];
  for (const path of callsOf(click)) {
    const name = path.split('.').at(-1), own = !path.includes('.') || /^core\.act$/.test(path);
    if (NEUTRAL.has(name)) continue;
    // A short handler of the page is read through its body; a long one (a loader, a whole flow) says too much to be one click's answer.
    if (locals.has(path) && !seen.has(path)) { seen.add(path); found.push(locals.get(path).length <= LOCAL_BODY ? clickDoes(locals.get(path), locals, seen) : ''); continue; }
    if (EXTERNAL.test(name)) found.push('external');
    else if (OVER_PAGE.test(name)) found.push('here');
    else if (LEAVE_PATH.test(path) || LEAVE.test(name)) found.push('leave');
    else if (own && HERE.test(name)) found.push('here');
    else found.push('');
  }
  if (found.includes('external')) return 'external';
  if (found.includes('leave')) return 'leave';
  // A job or data action of the page acts where it stands, whatever builds its arguments or says what it did (`core.act('generate', continueArgs(…), notify)`).
  if (callsOf(click).some((path) => /^(?:core\.)?act$/.test(path))) return 'here';
  return found.length && found.every((does) => does === 'here') ? 'here' : '';
}

/** Why a click handler leaves nothing behind, from what it calls alone: it acts where it stands (clickDoes) without a job action: setters of this page's state
    (`setEditing(true)`, `setOpen((open) => !open)`: a dialog or a fold opens), a dialog over the page. A page setter (`setPage`, `setScreen`, `setView`, `setRoute`)
    changes the view, so it leaves; a call of a prop, a router or a host (`onSettings()`, `nav.navigate(…)`, `host.setModal(…)`) is not the page's own. */
export function setsStateWhy(click, locals = new Map()) {
  return click && !/(?:^|[^\w$.])(?:core\.)?act\(/.test(click) && clickDoes(click, locals) === 'here' ? 'it only sets state on this page (a dialog, a fold, a view); the learner stays' : '';
}

/** Why a go-on Button's click acts where it stands, from what it calls alone: a job or data action (`act(…)`: 继续 / 接着做 on a job; `act('review.start')` starts a
    practice run, so it leaves), or setsStateWhy. */
export function structuralWhy(click, locals = new Map()) {
  if (/(?:^|[^\w$.])(?:core\.)?act\(/.test(click) && clickDoes(click, locals) === 'here') return 'it runs a job or data action (act) on what is shown; the page stays';
  return setsStateWhy(click, locals);
}

/** Why a Button acts where it stands, or '' when it takes the learner somewhere. One decision, in this order: what its click does (structuralWhy: a job or data
    action, the study actions 继续 / 接着做 / 继续安装 on a job's card or the console; only a setter of this page's state); a listed place (IN_PLACE). A form's submit
    is decided by what it starts: 开始本轮 submits and goes on to the round, so it keeps its arrow. `used` collects the listed places that matched. */
export function inPlaceWhy(open, file = '', used = null, locals = new Map()) {
  const click = propOf(open, 'onClick');
  const structural = structuralWhy(click, locals);
  if (structural) return structural;
  const place = IN_PLACE.find((entry) => entry.file === file && (entry.submit ? /\stype="submit"/.test(open) && !click : new RegExp(`\\b(?:${entry.handler})\\b`).test(click)));
  if (place) used?.add(place);
  return place?.why || '';
}

/** A way back: words that say so (返回 … / 回到 … / 回学习库: 返回学习库, 回到学习目录, 回到总纲). It leads with `icon="arrow-left"` and never ends in the go-on arrow. */
export const WAY_BACK = /^(?:返回|回到|回学习库)/u;

/** The Buttons whose click takes the learner somewhere but that draw no go-on arrow, each with why (ui/DESIGN.md, Icons). A Button whose words are data (a title,
    a topic, a code, a page number: `{entry.title}`) is not read at all: its words name what it opens, so it is an entry of a list, not an action. `label` is matched
    against the Button's words. */
export const LEAVES_WITHOUT_ARROW = [
  { file: 'ui/book/BookStep.jsx', label: /^(?:上一个|下一个)知识点/, why: 'the book’s pager: it steps to the point before or after on the same book page, like the bar’s ‹ ›' },
  { file: 'ui/tasks/PlanTable.jsx', label: /^第 \{0\} 页$/, why: 'a page number of the plan table: an entry of a list, its words are the page it opens' },
  { file: 'ui/Sources.jsx', label: /前言与目录|第 \{0\}/, why: 'a chapter row of the 资料 page: its words are the part it opens (前言与目录, 第 N 页), an entry of a list' },
  { file: 'ui/study-map/FocusProgressLine.jsx', label: /^重点 \{0\} 条/, why: 'a status, not an action: the summary of the course’s focus points, which opens their detail' },
  { file: 'ui/study-map/MethodLine.jsx', label: /^学法 · /, why: 'a status, not an action: the course’s 学法 stage, which opens the whole 学法 (its aria-label says so)' },
  { file: 'ui/CourseSettings.jsx', label: /^设置$/, why: 'opens the course’s panel inside the 设置 page (setCourseSettings): the page stays, the panel is its detail' },
  { file: 'ui/UpdateCenter.jsx', label: /^查看(?:处理办法|升级)$/, why: 'opens the update dialog over the settings page (UpdateCenter hands it setOpen(true))' },
  { file: 'ui/Draft.jsx', label: /^载入最新草稿$/, why: 'replaces this draft with its newer copy in the same editor: the learner stays' },
];

const isArrow = (open) => /\biconEnd=(?:"arrow-right"|\{[^}]*arrow-right)/.test(open);
const leadIcon = (open) => /\sicon="([^"]*)"/.exec(open)?.[1] ?? (propOf(open, 'icon') || '');

/** The Buttons of one source file whose arrow does not match what they do: [{ label, open, want, at }]. Every Button with words is read: what its click does
    (clickDoes) decides; only a click that does not say falls back to the words (GO_ON_WORDS). A way back (WAY_BACK) leads with `arrow-left` and has no go-on
    arrow. A Button with its own leading icon (the sparkle of 生成) takes no arrow either way; the test checks that no Button leads with a play icon. A listed
    place acts in place (IN_PLACE) or leaves without the arrow (LEAVES_WITHOUT_ARROW), each with why. `seen` counts what was read:
    { buttons, data, leave, here, unknown }. */
export function goOnProblems(source, { file = '', helpers = new Map(), used = null, seen = null } = {}) {
  const problems = [], vars = varsOf(source), locals = localHandlers(source);
  const count = (key) => { if (seen) seen[key] = (seen[key] || 0) + 1; };
  const push = (labels, open, want, at) => problems.push({ label: labels.join(' | ') || '?', open: open.replace(/\s+/g, ' ').slice(0, 120), want, at });
  for (const { open, children, at } of buttonElements(source)) {
    const labels = labelsOf(children, helpers, vars);
    count('buttons');
    if (!labels.length) { count('data'); continue; }
    // Its own leading icon is the `icon` prop, or an <Icon> its words start with (the ↗ of a draft's citation, drawn inside its first span).
    const click = propOf(open, 'onClick'), arrow = isArrow(open), icon = leadIcon(open) || (/^\s*(?:<span\b[^>]*>\s*)?<Icon\b[^>]*\bname="([^"]+)"/.exec(children)?.[1] ?? '');
    // A toggle says so itself (aria-pressed / aria-expanded: 今天读哪几节 opens its list where it stands).
    const does = /\saria-(?:pressed|expanded)=/.test(open) ? 'here' : clickDoes(click, locals);
    count(does || 'unknown');
    if (labels.some((label) => WAY_BACK.test(label)) && does !== 'here') {
      if (arrow) push(labels, open, 'no go-on arrow: it is a way back', at);
      else if (!/arrow-left/.test(icon)) push(labels, open, 'icon="arrow-left": it is a way back (ui/DESIGN.md, Icons)', at);
      continue;
    }
    if (does === 'external') { if (icon !== 'external' || arrow) push(labels, open, 'icon="external": it opens a window outside StudyHub', at); continue; }
    if (icon) continue;
    const listed = LEAVES_WITHOUT_ARROW.find((entry) => entry.file === file && entry.label.test(labels.join(' | ')));
    if (listed) { used?.add(listed); if (arrow) push(labels, open, `no arrow: ${listed.why}`, at); continue; }
    const here = inPlaceWhy(open, file, used, locals);
    const goes = !here && (does === 'leave' || (does === '' && labels.some((label) => GO_ON.test(label))));
    const want = here && arrow ? `no arrow: ${here}` : goes && !arrow ? `iconEnd="arrow-right": it takes the learner somewhere (${does === 'leave' ? 'its click leaves' : 'its words go on'})` : '';
    if (want) push(labels, open, want, at);
  }
  return problems;
}

/** The value of a property of an object literal `{ …, name: value, … }` (to the next comma or the closing brace outside brackets), or ''. */
function valueOfProp(object, name) {
  const at = object.search(new RegExp(`[{,]\\s*${name}\\s*:`));
  if (at < 0) return '';
  const start = object.indexOf(':', at) + 1;
  let depth = 0, quote = '';
  for (let end = start; end < object.length; end++) {
    const ch = object[end];
    if (quote) { if (ch === '\\') end++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) { if (depth === 0) return object.slice(start, end).trim(); depth--; }
    else if (ch === ',' && depth === 0) return object.slice(start, end).trim();
  }
  return object.slice(start).trim();
}

/** Every object literal `{ label: …, … }` of a source file: { object, before } (`before`: the source just in front of it, to tell a PageHeader's `back={…}`). */
function labelledObjects(source) {
  const found = [];
  for (let at = source.search(/\{\s*label:/); at >= 0; ) {
    let depth = 0, end = at;
    for (; end < source.length; end++) { if (source[end] === '{') depth++; else if (source[end] === '}' && --depth === 0) break; }
    found.push({ object: source.slice(at, end + 1), before: source.slice(Math.max(0, at - 24), at) });
    const next = source.slice(at + 1).search(/\{\s*label:/);
    at = next < 0 ? -1 : at + 1 + next;
  }
  return found;
}

/** The files whose action specs `{ label, run }` are drawn by one component that decides the arrow itself (`specProblems` reads them): the job card and its
    links (`here` says it acts in place), the 任务 console's result action, the first-run line's and the home plan's one primary (always a go-on), and the round's
    next step (`back` says it is a way back). Every other `{ label, run }` is a toast's or a message's action: it draws `iconEnd` as it is given. */
export const SPEC_FILES = ['ui/study-map/JobCard.jsx', 'ui/PdfConvertJob.jsx', 'ui/audio/AudioJobs.jsx', 'ui/tasks/CompactJobCard.jsx', 'ui/tasks/task-actions.js',
  'ui/custom-convert-link.js', 'ui/job-follow-up.js', 'ui/first-run/FirstRunLine.jsx', 'ui/study-map/home-plan.js', 'ui/Review.jsx'];

/** The message, toast and empty-state actions `{ label, onClick }` and `{ label, run }` of a source file (Banner, InlineMessage, Toast, EmptyState, a notify(): they
    draw a Button from the object, with the `iconEnd` they are given) whose arrow does not match what they do, by the same rule as a Button: what the handler does
    decides (clickDoes), the words only when it does not say; a way back has no go-on arrow; an action with its own leading `icon` takes none. A PageHeader's
    `back` draws its own arrow-left; a spec of SPEC_FILES is read by specProblems. [{ label, open, want }] */
export function actionProblems(source, { file = '', helpers = new Map(), seen = null, used = null } = {}) {
  const vars = varsOf(source), locals = localHandlers(source), problems = [];
  for (const { object, before } of labelledObjects(source)) {
    const onClick = valueOfProp(object, 'onClick'), run = valueOfProp(object, 'run'), click = onClick || run;
    if (!click || (!onClick && SPEC_FILES.includes(file)) || /\bback\s*[=:]\s*$/.test(before)) continue;
    const label = valueOfProp(object, 'label'), labels = labelsOf(/^[A-Za-z_$][\w$]*$/.test(label) ? `{${label}}` : label, helpers, vars);
    if (!labels.length) continue;
    if (seen) seen.actions = (seen.actions || 0) + 1;
    const arrow = /[{,]\s*iconEnd\s*:\s*['"]arrow-right['"]/.test(object), does = clickDoes(click, locals), open = object.replace(/\s+/g, ' ').slice(0, 120);
    if (labels.some((word) => WAY_BACK.test(word)) && does !== 'here') { if (arrow) problems.push({ label: labels.join(' | '), open, want: 'no go-on arrow: it is a way back' }); continue; }
    if (does === 'external' || /[{,]\s*icon\s*:/.test(object)) continue;
    const listed = LEAVES_WITHOUT_ARROW.find((entry) => entry.file === file && entry.label.test(labels.join(' | ')));
    if (listed) { used?.add(listed); if (arrow) problems.push({ label: labels.join(' | '), open, want: `no arrow: ${listed.why}` }); continue; }
    const here = does === 'here' ? 'it acts where it stands (a setter of this page, a job or data action)' : '';
    const goes = does === 'leave' || (does === '' && labels.some((word) => GO_ON.test(word)));
    const want = here && arrow ? `no arrow: ${here}` : goes && !arrow ? `iconEnd: 'arrow-right': it takes the learner somewhere (${does === 'leave' ? 'its handler leaves' : 'its words go on'})` : '';
    if (want) problems.push({ label: labels.join(' | '), open, want });
  }
  return problems;
}

/** The job card's action specs `{ label, …, run }` of a source file whose `here` does not match what `run` does: a run that only sets state on this page (修改并导入
    opens a dialog) is `here: true`, so the card draws no arrow; a spec marked `here: true` whose run does not act in place (a call of a prop or a host) is not. A run
    that is a name (`run: retry`) is not read. [{ label, open, want }] */
export function specProblems(source, { file = '' } = {}) {
  const problems = [], locals = localHandlers(source);
  if (file && !SPEC_FILES.includes(file)) return problems;
  for (const { object } of labelledObjects(source)) {
    const run = valueOfProp(object, 'run');
    if (run && /=>/.test(run)) {
      const here = /(?:^|[{,])\s*here\s*:\s*true\b/.test(object), sets = setsStateWhy(run, locals);
      const label = valueOfProp(object, 'label').slice(0, 40), open = object.replace(/\s+/g, ' ').slice(0, 120);
      if (sets && !here) problems.push({ label, open, want: `here: true: ${sets}` });
      else if (here && !structuralWhy(run, locals) && /(?<![.\w$])[A-Za-z_$][\w$]*\(/.test(run)) problems.push({ label, open, want: 'no `here`: its run leaves the page' });
    }
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
