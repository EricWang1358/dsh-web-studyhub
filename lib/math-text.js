import { proseSegments } from './tex-text.js';
import { chemSpans } from './chem-text.js';

/* Plain-text math: what a model writes instead of TeX ("5√2", "x^2+1", "(x−1)(x+1)", "x≠1"). The study cards only render math inside
 * $…$, so these show as raw text (the radical bar is never drawn, a caret stays a caret). `bareMathText` finds the unmistakable cases outside
 * math, code, links and chemistry; `toTex` converts one; `wrapMathText` wraps each found span in place and leaves the prose around it alone.
 * Pure and dependency-free. A span needs an operand on both sides of its operator and either a single-letter variable, a radical, a power or a
 * relation sign: "1+1", "3-5", "2026-10-04", "A/B", "C++", "m/s" and "e-mail" are prose. */

const REL = '≠≤≥≈±∓';
const OPERATORS = '+−-=<>/×÷·≠≤≥≈±∓';
const SLASH_PROSE = new Set(['w/o', 'c/o', 'a/c', 's/he', 'n/a', 'y/n', 'm/s', 'h/w', 'i/o', 'e/g']);
const WORD = /[A-Za-z0-9_]/;
const COMMANDS = { '−': '-', '×': '\\times', '÷': '\\div', '·': '\\cdot', '≠': '\\neq', '≤': '\\le', '≥': '\\ge', '≈': '\\approx', '±': '\\pm', '∓': '\\mp',
  'π': '\\pi', '∞': '\\infty', '∑': '\\sum', '∫': '\\int', '∏': '\\prod' };

/** Index just after the expression that starts at `start` in `s` and what it contains, or null when none starts there. */
function expressionAt(s, start) {
  const info = { variable: false, op: false, radical: false, caret: false, special: false };
  let depth = 0;
  const number = (i) => { const m = /^\d+(?:\.\d+)?/.exec(s.slice(i, i + 24)); return m ? i + m[0].length : -1; };
  const letter = (i) => (/[a-z]/.test(s[i] || '') && !WORD.test(s[i + 1] || '') ? i + 1 : -1);
  const braces = (i) => {
    const close = s.indexOf('}', i);
    return s[i] === '{' && close > i && close - i < 64 && !s.slice(i, close).includes('\n') ? close + 1 : -1;
  };
  const group = (i) => {
    if (s[i] !== '(' || depth >= 4) return -1;
    depth++;
    const end = expression(i + 1);
    depth--;
    return end >= 0 && s[end] === ')' ? end + 1 : -1;
  };
  const operand = (i) => {
    for (const read of [number, letter, group]) { const end = read(i); if (end >= 0) return end; }
    if (s[i] === 'π') { info.variable = true; return i + 1; }
    return -1;
  };
  const atom = (i) => {
    let end = -1;
    if (/\d/.test(s[i] || '')) end = number(i);
    else if (/[a-z]/.test(s[i] || '')) { end = letter(i); if (end >= 0) info.variable = true; }
    else if (s[i] === 'π') { end = i + 1; info.variable = true; }
    else if (s[i] === '∞') end = i + 1;
    else if (s[i] === '(') end = group(i);
    else if (s[i] === '√') {
      let at = i + 1;
      while (s[at] === '√') at++;
      end = operand(at);
      if (end >= 0) info.radical = true;
    } else if ('∑∫∏'.includes(s[i] || '\0')) {
      end = i + 1; info.special = true;
      while (s[end] === '_' || s[end] === '^') {
        const bound = s[end + 1] === '{' ? braces(end + 1) : /[A-Za-z0-9]/.test(s[end + 1] || '') ? end + 2 : -1;
        if (bound < 0) break;
        end = bound;
      }
    }
    if (end < 0) return -1;
    // Powers: x^2, 3^n, x^-1, x^(n-1), x^{2}.
    while (s[end] === '^') {
      let at = end + 1;
      if (s[at] === '-' || s[at] === '−') at++;
      const power = s[at] === '{' ? braces(at) : operand(at);
      if (power < 0) break;
      info.caret = true; end = power;
    }
    return end;
  };
  const term = (i) => {
    let end = atom(i);
    if (end < 0) return -1;
    for (;;) {
      const c = s[end] || '', before = s[end - 1] || '';
      const next = (c === '√' || (c === '(' && /[\d)a-z]/.test(before)) || (/[a-zπ]/.test(c) && /[\d)]/.test(before))) ? atom(end) : -1;
      if (next < 0) return end;
      end = next;
    }
  };
  function expression(i) {
    let end = term(i);
    if (end < 0) return -1;
    for (;;) {
      let at = end;
      const spaced = s[at] === ' ';
      if (spaced) at++;
      const op = s[at];
      if (!op || !OPERATORS.includes(op)) break;
      if ((op === '-') && (spaced || s[at + 1] === ' ')) break;
      if (op === '-' && /[A-Za-z]/.test(s[at - 1] || '') && /[A-Za-z]/.test(s[at + 1] || '')) break;
      let from = at + 1;
      if (s[from] === ' ') from++;
      if ((s[from] === '-' || s[from] === '−') && op !== '-' && op !== '−') from++;
      const next = term(from);
      if (next < 0) break;
      info.op = true;
      if (REL.includes(op)) info.special = true;
      end = next;
    }
    return end;
  }
  const end = expression(start);
  return end < 0 ? null : { end, info };
}

/** `[{ start, end, piece }]` (positions in `text`) for the plain-text math outside math delimiters, code, links and chemistry. */
export function mathTextSpans(text) {
  const source = String(text ?? '');
  const chem = chemSpans(source);
  const spans = [];
  for (const { text: raw, offset } of proseSegments(source)) {
    let segment = raw;
    for (const piece of chem) {
      const from = Math.max(piece.start - offset, 0), to = Math.min(piece.end - offset, segment.length);
      if (to > from) segment = segment.slice(0, from) + ' '.repeat(to - from) + segment.slice(to);
    }
    for (let i = 0; i < segment.length;) {
      const found = /[\dA-Za-z(√π∞∑∫∏]/.test(segment[i]) && !/[A-Za-z0-9_.$\\@/^{}~#]/.test(segment[i - 1] || '') ? expressionAt(segment, i) : null;
      if (!found) { i++; continue; }
      const { end, info } = found, piece = segment.slice(i, end);
      const qualifies = info.radical || info.caret || info.special || (info.variable && info.op);
      const glued = /[A-Za-z0-9_@\\/{]/.test(segment[end] || '');
      if (qualifies && !glued && !SLASH_PROSE.has(piece) && piece.length <= 120) {
        let start = i;
        // A leading minus belongs to the expression (-x+1) unless it joins a word or a number (3-x).
        if ((segment[i - 1] === '-' || segment[i - 1] === '−') && !/[A-Za-z0-9)\]]/.test(segment[i - 2] || '')) start--;
        spans.push({ start: offset + start, end: offset + end, piece: segment.slice(start, end) });
      }
      i = end;
    }
  }
  return spans;
}

/** The plain-text math in a text, as the strings a card would show raw. */
export function bareMathText(text) {
  const found = [];
  for (const span of mathTextSpans(text)) if (!found.includes(span.piece)) found.push(span.piece);
  return found;
}

/** The TeX of a plain-text expression: √ and bare powers get braces, Unicode operators their commands, U+2212 becomes "-". */
export function toTex(expr) {
  const s = String(expr ?? '');
  const matching = (i, open, close) => {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === open) depth++;
      else if (s[j] === close && --depth === 0) return j;
    }
    return -1;
  };
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '√') {
      let at = i + 1, depth = 0;
      while (s[at] === '√') { depth++; at++; }
      let arg = '', end = at;
      if (s[at] === '(') { const close = matching(at, '(', ')'); if (close > at) { arg = toTex(s.slice(at + 1, close)); end = close + 1; } }
      else { const m = /^(?:\d+(?:\.\d+)?|[A-Za-zπ])/.exec(s.slice(at)); if (m) { arg = toTex(m[0]); end = at + m[0].length; } }
      out += `${'\\sqrt{'.repeat(depth)}\\sqrt{${arg}}${'}'.repeat(depth)}`;
      i = end - 1;
    } else if (c === '^') {
      let at = i + 1, sign = '';
      if (s[at] === '{') { const close = matching(at, '{', '}'); if (close > at) { out += `^{${toTex(s.slice(at + 1, close))}}`; i = close; continue; } }
      if (s[at] === '(') { const close = matching(at, '(', ')'); if (close > at) { out += `^{${toTex(s.slice(at + 1, close))}}`; i = close; continue; } }
      if (s[at] === '-' || s[at] === '−') { sign = '-'; at++; }
      const m = /^(?:\d+(?:\.\d+)?|[A-Za-z])/.exec(s.slice(at));
      if (m) { out += `^{${sign}${m[0]}}`; i = at + m[0].length - 1; } else out += c;
    } else {
      const command = COMMANDS[c] ?? c;
      // A command word followed by a letter or digit needs a space (\pi r, \neq 1), or it would read as a longer word.
      out += /^\\[A-Za-z]+$/.test(command) && /[A-Za-z0-9]/.test(s[i + 1] || '') ? `${command} ` : command;
    }
  }
  return out;
}

/** `text` with each plain-text math span wrapped in `$…$` as TeX; the prose around it, code, links and blanks are untouched. */
export function wrapMathText(text) {
  if (typeof text !== 'string' || text.includes('{{')) return text;
  let out = text;
  for (const span of mathTextSpans(text).reverse()) {
    const tex = toTex(span.piece);
    if (!tex || /[$\n]/.test(tex)) continue;
    const pad = /[A-Za-z0-9]/.test(out[span.start - 1] || '') ? ' ' : '';
    out = `${out.slice(0, span.start)}${pad}$${tex}$${out.slice(span.end)}`;
  }
  return out;
}
