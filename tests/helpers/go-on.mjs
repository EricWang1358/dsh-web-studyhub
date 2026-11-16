/* #1073 round 3: find the "go on" actions of ui/ by a rule, not by a list. A "go on" action is a Button  whose label starts with a verb
   of going on (去 / 练 / 继续 / 开始 / 接着), and ui/DESIGN.md says it ends in `arrow-right`. The English catalogue maps these labels to Go / Practise / Continue / Start, so the
   Chinese source key is the one place to look. */

const GO_ON = /^(?:去|练|继续|开始|接着)/u;

/** The source of the opening tag that starts at `at` (`<Button …>`): to the first `>` outside braces and quotes. */
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

const labelsOf = (text) => [...text.matchAll(/\bui\((["'])((?:\\.|(?!\1).)*)\1\)/gu)].map((match) => match[2]);

/** The "go on" Buttons of one source file that do not end in an arrow: [{ label, open }]. (An action spec `{ label, run }` of a plan or a card is drawn by one component that adds the arrow itself.) */
export function goOnProblems(source) {
  const problems = [];
  for (const { open, children } of buttonElements(source)) {
    for (const label of labelsOf(children)) {
      // A Button that already has its own leading icon (the sparkle of 生成) takes no arrow (ui/DESIGN.md); the test checks that no go-on Button leads with a play icon.
      if (GO_ON.test(label) && !/\biconEnd=/.test(open) && !/\sicon=/.test(open)) problems.push({ label, open: open.replace(/\s+/g, ' ').slice(0, 120) });
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
