/* LaTeX in the text language models write for study cards. Pure and dependency-free.
 *
 * Three problems keep a formula from rendering, and each is handled here:
 *  - JSON turns a TeX command the model forgot to double-escape into something else: a valid
 *    escape silently (\beta becomes a backspace and "eta", \frac a form feed and "rac", \theta a
 *    tab, \nabla a newline, \rho a carriage return), an invalid one (\( \alpha \sigma \upsilon)
 *    fails the whole parse. `repairTexEscapes` fixes the invalid TeX escapes before parsing and
 *    `restoreTexControlChars` restores the silent ones afterwards, only inside math spans.
 *  - The formula is not inside $…$, $$…$$, \(…\) or \[…\] at all, so it shows as raw text
 *    ("a^{l-1}"). `bareMath` finds the unmistakable cases outside code and math.
 * Anything that is not clearly TeX is left alone, so an unrelated bad escape still fails. */

export const TEX_COMMANDS = [
  // Greek
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'varepsilon', 'zeta', 'eta', 'theta', 'vartheta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi',
  'pi', 'varpi', 'rho', 'varrho', 'sigma', 'varsigma', 'tau', 'upsilon', 'phi', 'varphi', 'chi', 'psi', 'omega',
  'Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega',
  // structure, operators, functions
  'frac', 'dfrac', 'tfrac', 'sqrt', 'sum', 'prod', 'int', 'oint', 'iint', 'lim', 'limsup', 'liminf', 'sup', 'inf', 'max', 'min', 'arg', 'argmax',
  'argmin', 'det', 'dim', 'ker', 'exp', 'log', 'ln', 'lg', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'sinh', 'cosh', 'tanh', 'arcsin', 'arccos', 'arctan',
  'binom', 'begin', 'end', 'left', 'right', 'big', 'Big', 'bigg', 'Bigg',
  // symbols and relations
  'infty', 'partial', 'nabla', 'cdot', 'cdots', 'ldots', 'dots', 'vdots', 'ddots', 'times', 'div', 'pm', 'mp', 'ast', 'star', 'circ', 'bullet',
  'oplus', 'otimes', 'odot', 'leq', 'geq', 'neq', 'ne', 'le', 'ge', 'approx', 'equiv', 'sim', 'simeq', 'cong', 'propto', 'll', 'gg', 'subset',
  'supset', 'subseteq', 'supseteq', 'in', 'notin', 'ni', 'cup', 'cap', 'emptyset', 'setminus', 'forall', 'exists', 'neg', 'not', 'land', 'lor',
  'wedge', 'vee', 'implies', 'iff', 'mid', 'parallel', 'perp', 'angle', 'triangle', 'prime', 'quad', 'qquad', 'hbar', 'ell', 'Re', 'Im', 'aleph',
  'langle', 'rangle', 'lceil', 'rceil', 'lfloor', 'rfloor',
  // arrows
  'to', 'gets', 'rightarrow', 'leftarrow', 'leftrightarrow', 'Rightarrow', 'Leftarrow', 'Leftrightarrow', 'mapsto', 'uparrow', 'downarrow',
  // fonts and accents
  'mathbb', 'mathbf', 'mathrm', 'mathcal', 'mathit', 'mathsf', 'mathtt', 'boldsymbol', 'text', 'textbf', 'textit', 'vec', 'hat', 'bar', 'tilde',
  'overline', 'underline', 'overrightarrow',
];
const COMMAND_WORD = new Set(TEX_COMMANDS);
/* Punctuation commands: \( \) \[ \] \{ \} \, \; \: \! \| \% \& \# \_ \^ \~ \' */
const TEX_PUNCTUATION = '()[]{},;:!|%&#_^~\'';

/** JSON text with the invalid TeX escapes doubled (\( becomes \\( and \alpha becomes \\alpha); other text is unchanged. */
export function repairTexEscapes(text) {
  const source = String(text ?? '');
  let out = '', quoted = false, changed = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (!quoted) { out += ch; if (ch === '"') quoted = true; continue; }
    if (ch === '"') { quoted = false; out += ch; continue; }
    if (ch !== '\\') { out += ch; continue; }
    const next = source[i + 1];
    if (next === undefined) { out += ch; continue; }
    if ('"\\/bfnrt'.includes(next)) { out += ch + next; i++; continue; }
    if (next === 'u' && /^[0-9a-fA-F]{4}/.test(source.slice(i + 2, i + 6))) { out += source.slice(i, i + 6); i += 5; continue; }
    const word = /^[A-Za-z]+/.exec(source.slice(i + 1))?.[0] || '';
    if (TEX_PUNCTUATION.includes(next) || (word && COMMAND_WORD.has(word))) { out += '\\\\'; changed = true; continue; }
    out += ch;
  }
  return changed ? out : source;
}

/* A control character JSON made out of \b \f \t \r \n, and the rest of every TeX command that starts with that letter. */
const CONTROL = { '\b': 'b', '\f': 'f', '\t': 't', '\r': 'r', '\n': 'n' };
const CONTROL_ESCAPE = { '\b': '\\x08', '\f': '\\f', '\t': '\\t', '\r': '\\r', '\n': '\\n' };
const RESTORE = Object.fromEntries(Object.entries(CONTROL).map(([control, letter]) => {
  const rest = TEX_COMMANDS.filter(name => name[0] === letter).map(name => name.slice(1)).sort((a, b) => b.length - a.length);
  return [control, new RegExp(`${CONTROL_ESCAPE[control]}(?=(?:${rest.join('|')})(?![A-Za-z]))`, 'g')];
}));
const MATH_SPAN = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$]{1,400}?\$/g;

function restoreString(text) {
  if (!/[\b\f\t\r\n]/.test(text) || !/\$|\\[([]/.test(text)) return text;
  return text.replace(MATH_SPAN, span => {
    // A real line break is normal in display math, never in an inline formula.
    const display = span.startsWith('$$') || span.startsWith('\\[');
    let value = span;
    for (const [control, pattern] of Object.entries(RESTORE)) {
      if (control === '\n' && display) continue;
      value = value.replace(pattern, `\\${CONTROL[control]}`);
    }
    return value;
  });
}

/** Parsed JSON with the TeX commands that JSON escapes silently turned into control characters restored, inside math only. */
export function restoreTexControlChars(value) {
  if (typeof value === 'string') return restoreString(value);
  if (Array.isArray(value)) return value.map(restoreTexControlChars);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreTexControlChars(item)]));
  return value;
}

const CODE = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`/g;
/* The delimiters the study cards render (the same boundaries as prepareStudyMath): "$5 and $10" is currency. */
const DELIMITED = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<![\\$\w])\$(?=\S)[^$\n]*?[^\s$\\]\$(?!\d)/g;
const BARE = [
  /[A-Za-z0-9.]*[A-Za-z0-9)\]}]\^\{[^{}\n]{0,60}\}/g,
  /[A-Za-z0-9.]*[A-Za-z0-9)\]}]_\{[^{}\n]{0,60}\}/g,
  new RegExp(`\\\\(?:${[...TEX_COMMANDS].sort((a, b) => b.length - a.length).join('|')})(?![A-Za-z])`, 'g'),
];

/* A command attached to a Windows path or UNC share (C:\Users\log) is a folder name, not TeX. */
const pathLike = token => /[A-Za-z]:\\|\\[A-Za-z]/.test(token);

/** The unmistakable TeX in a text that is not inside math delimiters or code (a^{l-1}, x_{i}, \frac): the pieces a card would show as raw text. */
export function bareMath(text) {
  const rest = String(text ?? '').replace(CODE, ' ').replace(DELIMITED, ' ');
  const found = [];
  const add = piece => { if (!found.includes(piece)) found.push(piece); };
  BARE.forEach((pattern, index) => {
    for (const match of rest.matchAll(pattern)) {
      if (index === 2 && pathLike(rest.slice(0, match.index).split(/\s/).pop())) continue;
      add(match[0]);
    }
  });
  return found;
}
