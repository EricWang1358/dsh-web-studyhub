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

/** Why a click handler leaves nothing behind, from what it calls alone: it only calls setters of this page's state (`setEditing(true)`, `setOpen((open) => !open)`: a
    dialog or a fold opens). A call of a prop, a router or a host (`onSettings()`, `nav.navigate(…)`) leaves. */
export function setsStateWhy(click) {
  const calls = [...click.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\(/g)].map((match) => match[1]);
  return calls.length && calls.every((call) => /^set[A-Z]/.test(call)) ? 'it only sets state on this page (a dialog, a fold, a view); the learner stays' : '';
}

/** Why a go-on Button's click acts where it stands, from what it calls alone: a job or data action (`act(…)`: 继续 / 接着做 on a job), or setsStateWhy. */
export function structuralWhy(click) {
  if (/(?:^|[^\w$.])(?:core\.)?act\(/.test(click)) return 'it runs a job or data action (act) on what is shown; the page stays';
  return setsStateWhy(click);
}

/** Why a Button acts where it stands, or '' when it takes the learner somewhere. One decision, in this order: what its click does (structuralWhy: a job or data
    action, the study actions 继续 / 接着做 / 继续安装 on a job's card or the console; only a setter of this page's state); a listed place (IN_PLACE). A form's submit
    is decided by what it starts: 开始本轮 submits and goes on to the round, so it keeps its arrow. `used` collects the listed places that matched. */
export function inPlaceWhy(open, file = '', used = null) {
  const click = propOf(open, 'onClick');
  const structural = structuralWhy(click);
  if (structural) return structural;
  const place = IN_PLACE.find((entry) => entry.file === file && (entry.submit ? /\stype="submit"/.test(open) && !click : new RegExp(`\\b(?:${entry.handler})\\b`).test(click)));
  if (place) used?.add(place);
  return place?.why || '';
}

/** The go-on Buttons of one source file whose arrow does not match what they do: [{ label, open, want }]. A Button with its own leading icon (the sparkle of
    生成) takes no arrow either way; the test checks that no Button leads with a play icon. A Button whose words are not go-on words (修改并导入) is decided by what its
    click does alone (structuralWhy): an arrow on one that only sets state here is wrong, whatever it says. (An action spec `{ label, run }` is drawn by one component
    that decides its arrow itself; `specProblems` checks that.) */
export function goOnProblems(source, { file = '', helpers = new Map(), used = null } = {}) {
  const problems = [], vars = varsOf(source);
  for (const { open, children, at } of buttonElements(source)) {
    if (/\sicon=/.test(open)) continue;
    const labels = labelsOf(children, helpers, vars).filter((label) => GO_ON.test(label));
    const arrow = /\biconEnd=(?:"arrow-right"|\{[^}]*arrow-right)/.test(open);
    if (!labels.length) {
      const here = arrow ? setsStateWhy(propOf(open, 'onClick')) : '';
      if (here) problems.push({ label: labelsOf(children, helpers, vars).join(' | ') || children.trim().slice(0, 30), open: open.replace(/\s+/g, ' ').slice(0, 120), want: `no arrow: ${here}` });
      continue;
    }
    const here = inPlaceWhy(open, file, used);
    const want = here && arrow ? `no arrow: ${here}` : !here && !arrow ? 'iconEnd="arrow-right": it takes the learner somewhere' : '';
    if (want) problems.push({ label: labels.join(' | '), open: open.replace(/\s+/g, ' ').slice(0, 120), want, at });
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

/** Every object literal `{ label: …, … }` of a source file, as its source text. */
function labelledObjects(source) {
  const found = [];
  for (let at = source.search(/\{\s*label:/); at >= 0; ) {
    let depth = 0, end = at;
    for (; end < source.length; end++) { if (source[end] === '{') depth++; else if (source[end] === '}' && --depth === 0) break; }
    found.push(source.slice(at, end + 1));
    const next = source.slice(at + 1).search(/\{\s*label:/);
    at = next < 0 ? -1 : at + 1 + next;
  }
  return found;
}

/** The message and empty-state actions `{ label, onClick }` of a source file (Banner, InlineMessage, Toast, EmptyState, a file row: they draw a Button from the
    object) whose arrow does not match what they do, by the same rule as a Button: a go-on label that leaves the page wants `iconEnd: 'arrow-right'`; one that only
    sets state here has none; an action with its own leading `icon` takes none. [{ label, open, want }] */
export function actionProblems(source, { helpers = new Map() } = {}) {
  const vars = varsOf(source), problems = [];
  for (const object of labelledObjects(source)) {
    const click = valueOfProp(object, 'onClick');
    if (!click || /\brun:/.test(object) || /[{,]\s*icon\s*:/.test(object)) continue;
    const label = valueOfProp(object, 'label'), labels = labelsOf(/^[A-Za-z_$][\w$]*$/.test(label) ? `{${label}}` : label, helpers, vars).filter((word) => GO_ON.test(word));
    if (!labels.length) continue;
    const arrow = /[{,]\s*iconEnd\s*:\s*['"]arrow-right['"]/.test(object), here = setsStateWhy(click);
    const want = here && arrow ? `no arrow: ${here}` : !here && !arrow ? "iconEnd: 'arrow-right': it takes the learner somewhere" : '';
    if (want) problems.push({ label: labels.join(' | '), open: object.replace(/\s+/g, ' ').slice(0, 120), want });
  }
  return problems;
}

/** The job card's action specs `{ label, …, run }` of a source file whose `here` does not match what `run` does: a run that only sets state on this page (修改并导入
    opens a dialog) is `here: true`, so the card draws no arrow; a spec marked `here: true` whose run leaves the page (a call of a prop or a host) is not. A run that
    is a name (`run: retry`) is not read. [{ label, open, want }] */
export function specProblems(source) {
  const problems = [];
  for (const object of labelledObjects(source)) {
    const run = valueOfProp(object, 'run');
    if (run && /=>/.test(run)) {
      const here = /(?:^|[{,])\s*here\s*:\s*true\b/.test(object), sets = setsStateWhy(run);
      const label = valueOfProp(object, 'label').slice(0, 40), open = object.replace(/\s+/g, ' ').slice(0, 120);
      if (sets && !here) problems.push({ label, open, want: `here: true: ${sets}` });
      else if (here && !structuralWhy(run) && /(?<![.\w$])[A-Za-z_$][\w$]*\(/.test(run)) problems.push({ label, open, want: 'no `here`: its run leaves the page' });
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
