/* Formula notation (公式写法): the learner's choice for how generated questions write formulas.
   'text' is plain Unicode Markdown (H₂SO₄, x², √2): the most stable to render and to check.
   'latex' is $…$ / $\ce{…}$: best for maths. 'auto' picks one from the sources, once per run.
   Pure module: no I/O, no model calls. Prompts, autofix and checks consume it elsewhere. */

export const NOTATIONS = Object.freeze(['auto', 'text', 'latex']);
export const normalizeNotation = value => NOTATIONS.includes(value) ? value : 'auto';

/* ---------- resolving "auto" ---------- */

const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
// Commands that only appear in TeX; plain prose and code do not contain them.
const TEX_COMMAND = /\\(?:frac|dfrac|tfrac|sqrt|ce|begin|end|sum|int|lim|cdot|times|neq|leq|geq|alpha|beta|gamma|theta|lambda|pi|infty|mathrm|text)(?![a-zA-Z])/;
// $…$ that looks like maths (a command, ^, _, braces, = or a lone variable); never "$5 and $10" or "$HOME and $PATH".
const DOLLAR_SPAN = /(?<![\\$\w])\$(?=[^\s$])([^$\n]{1,200}?)(?<=[^\s\\])\$(?![\d$])/g;
const MATH_SYMBOLS = /[√∑∫∏≠≤≥≈±∞∂∇∈∉∪∩∀∃²³¹⁰⁴-⁹⁺⁻₀-₉₊₋ₐ-ₜ]/g;
const ASCII_POWER = /[A-Za-z0-9)\]]\^(?:\{[^{}\n]*\}|[+-]?\d+|[nkm](?![A-Za-z0-9]))/g;

const sourceTexts = sources => (Array.isArray(sources) ? sources : [sources])
  .map(item => typeof item === 'string' ? item : item?.text).filter(text => typeof text === 'string' && text);

function hasDollarMath(text) {
  for (const match of text.matchAll(DOLLAR_SPAN)) if (/[\\^_{}=]|^[A-Za-z]$/.test(match[1])) return true;
  return false;
}

/** The notation a run really uses. text/latex pass through; auto → latex for LaTeX in the sources or a meaningful
    density of formulas, chemical formulas and maths symbols, else text. Code is ignored; a caret counts for little
    (programming text is full of ^ and x+1), so a few of them never flip the choice. */
export function resolveNotation(choice, sources) {
  const picked = normalizeNotation(choice);
  if (picked !== 'auto') return picked;
  const body = sourceTexts(sources).join('\n').replace(CODE, ' ');
  if (!body.trim()) return 'text';
  if (TEX_COMMAND.test(body) || hasDollarMath(body)) return 'latex';
  const chemical = [...body.matchAll(CHEMICAL_CANDIDATE)].filter(match => chemicalToken(match) !== null).length;
  const score = (body.match(MATH_SYMBOLS)?.length || 0) + chemical + (body.match(ASCII_POWER)?.length || 0) * 0.5;
  return score >= 30 || (score >= 5 && score * 1000 / Math.max(body.length, 400) >= 2) ? 'latex' : 'text';
}

/** One short prompt rule for a RESOLVED mode ('' for an unresolved choice, so callers can skip it). */
export function notationInstruction(mode, _language) {
  if (mode === 'text') return 'Formula notation: write every formula and chemical formula in plain Unicode text, e.g. H₂SO₄, SO₄²⁻, x², √2, 5√2, x≠1, x≤3, ∫₀¹ x dx, fractions as a/b (parenthesize compound parts). Never use $…$ delimiters or TeX commands such as \\frac, \\sqrt or \\ce.';
  if (mode === 'latex') return 'Formula notation: write every formula, every option that is a mathematical expression, and every chemical formula or equation in LaTeX inside $…$ (chemistry as $\\ce{H2SO4}$ and ions as $\\ce{SO4^2-}$); plain words and plain numbers stay outside. In the JSON output double every backslash ("\\\\frac", "\\\\ce").';
  return '';
}

/* ---------- Unicode scripts ---------- */

const SUP = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ' };
const SUB = { 0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉', '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ' };
/** Every character mapped, or null: a half-converted exponent would read worse than the ASCII one. */
const script = (text, map) => { let out = ''; for (const ch of text) { if (!Object.hasOwn(map, ch)) return null; out += map[ch]; } return out; };

/* ---------- chemistry ---------- */

const ELEMENTS = new Set(('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Ag Cd In Sn Sb Te I Xe Cs Ba La W Pt Au Hg Pb Bi U').split(' '));
const DIATOMIC = new Set(['O2', 'Cl2', 'Br2', 'O3']);
const NOT_CHEMISTRY = /^(?:B2B|B2C|C2C|P2P|O2O|H2H|N2N|S2S)$/;
// A candidate word that may be a formula: optional coefficient, element groups, optional ^charge. Validated below.
const CHEMICAL_CANDIDATE = /(?<![\w.^])(\d{0,2})((?:[A-Z][a-z]?|\()[A-Za-z0-9()]*)(\^\{?\d*[+-]\}?)?(?!\w)/g;

/** Subscript a formula word (H2SO4, Ca(OH)2); null when it is not made only of real elements, digits and balanced parentheses.
    Digit runs must be 2–12 so module codes (CS2030, CS50) and labels (H1B) are never read as chemistry. */
function formulaWord(word) {
  let i = 0, out = '', groups = 0, digits = 0, depth = 0;
  while (i < word.length) {
    const ch = word[i];
    if (ch === '(') { depth++; out += ch; i++; continue; }
    if (ch === ')') { if (--depth < 0) return null; out += ch; i++; continue; }
    if (/[A-Z]/.test(ch)) {
      const two = word.slice(i, i + 2), symbol = ELEMENTS.has(two) && /[a-z]/.test(two[1] || '') ? two : ELEMENTS.has(ch) ? ch : null;
      if (!symbol) return null;
      out += symbol; i += symbol.length; groups++; continue;
    }
    if (/\d/.test(ch)) {
      const run = /^\d+/.exec(word.slice(i))[0];
      if (!/[A-Za-z)]/.test(word[i - 1] || '') || run.startsWith('0') || Number(run) < 2 || Number(run) > 12) return null;
      out += script(run, SUB); i += run.length; digits++; continue;
    }
    return null;
  }
  return depth === 0 && groups ? { out, groups, digits } : null;
}

/** The converted form of one CHEMICAL_CANDIDATE match, or null when it should stay as written. */
function chemicalToken(match) {
  const [, coefficient, rest, charge] = match;
  let body = rest, head = '', tail = '';
  // Prose parentheses glue onto a word: "(H2SO4)" parses whole, "see H2SO4)" needs the stray ")" set aside.
  for (let guard = 0; guard < 4; guard++) {
    const word = NOT_CHEMISTRY.test(body) ? null : formulaWord(body);
    if (word) {
      const accepted = (word.groups >= 2 && word.digits >= 1) || (charge && word.groups >= 1) || (coefficient && word.groups === 1 && word.digits >= 1)
        || (!coefficient && DIATOMIC.has(body));
      if (!accepted) return null;
      const sup = charge ? chargeScript(charge) : '';
      return sup === null ? null : `${head}${coefficient}${word.out}${sup}${tail}`;
    }
    if (body.endsWith(')')) { tail = ')' + tail; body = body.slice(0, -1); } else if (body.startsWith('(')) { head += '('; body = body.slice(1); } else return null;
  }
  return null;
}
const chargeScript = charge => script(charge.replace(/^\^\{?|\}$/g, ''), SUP);

/** \ce{…} content → Unicode, or null when it holds anything this converter does not understand (isotopes, \bond, gas arrows). */
function chemistry(raw) {
  let out = '', i = 0, start = true, coefficient = false;
  while (i < raw.length) {
    const ch = raw[i], rest = raw.slice(i);
    let m;
    if (/\s/.test(ch)) { out += ch; i++; start = true; continue; }
    if ((m = /^(<=>|<->|-->|->|<-)/.exec(rest))) { out += { '<=>': '⇌', '<->': '↔', '-->': '→', '->': '→', '<-': '←' }[m[1]]; i += m[1].length; start = true; continue; }
    if (ch === '^') {
      m = /^\^(?:\{([^{}]*)\}|([0-9]*[+-]))/.exec(rest);
      const sup = m ? script(m[1] ?? m[2], SUP) : null;
      if (sup === null) return null;
      out += sup; i += m[0].length; start = false; continue;
    }
    if ((ch === '+' || ch === '-') && out && !start && /[A-Za-z0-9)\]]/.test(raw[i - 1]) && (i + 1 === raw.length || /[\s),;\]]/.test(raw[i + 1]))) { out += SUP[ch]; i++; start = false; continue; }
    if (ch === '+') { out += ch; i++; start = true; continue; }
    if (ch === '.' || ch === '*') {
      if (coefficient && /\d/.test(raw[i - 1] || '') && /\d/.test(raw[i + 1] || '')) { out += ch; i++; continue; }
      out += '·'; i++; start = true; continue;
    }
    if ((m = /^\d+/.exec(rest))) {
      coefficient = start;
      if (start) out += m[0];
      else { const sub = script(m[0], SUB); if (sub === null) return null; out += sub; }
      i += m[0].length; continue;
    }
    if (/[A-Za-z()[\],:;=]/.test(ch)) { out += ch; i++; start = false; continue; }
    return null;
  }
  return out;
}

/* ---------- TeX → Unicode ---------- */

const ORDINARY = { pi: 'π', infty: '∞', partial: '∂', nabla: '∇', sum: '∑', int: '∫', prod: '∏', degree: '°', circ: '∘', ldots: '…', cdots: '…', dots: '…',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  rho: 'ρ', sigma: 'σ', tau: 'τ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  forall: '∀', exists: '∃', emptyset: '∅', ell: 'ℓ' };
const OPERATORS = { neq: '≠', ne: '≠', le: '≤', leq: '≤', ge: '≥', geq: '≥', lt: '<', gt: '>', times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓', approx: '≈', equiv: '≡',
  sim: '∼', propto: '∝', to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', leftrightarrow: '↔', in: '∈', notin: '∉',
  subset: '⊂', supset: '⊃', cup: '∪', cap: '∩', rightleftharpoons: '⇌', land: '∧', lor: '∨', neg: '¬' };
const SPACES = new Set([',', ';', ':', ' ', 'quad', 'qquad']);
const WRAPPERS = new Set(['text', 'textrm', 'textbf', 'textit', 'mathrm', 'mathbf', 'mathit', 'mathsf', 'operatorname', 'mathbb', 'boldsymbol']);
const KNOWN = new Set([...Object.keys(ORDINARY), ...Object.keys(OPERATORS), ...WRAPPERS, 'sqrt', 'frac', 'dfrac', 'tfrac', 'ce', 'left', 'right', 'begin', 'end', 'lim', 'sin', 'cos', 'tan', 'log', 'ln']);
const FUNCTIONS = new Set(['sin', 'cos', 'tan', 'log', 'ln', 'lim']);
class Incomplete extends Error {}
const bad = () => { throw new Incomplete(); };

/** Whether a converted piece can sit next to / and √ unparenthesised. */
function isAtomic(piece) {
  const text = piece.trim();
  if (!text) return true;
  if (/^[\p{L}\p{N}.°′″⁰-₟²³¹]+$/u.test(text)) return true;
  if (!text.startsWith('(') || !text.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) { if (text[i] === '(') depth++; else if (text[i] === ')' && --depth === 0 && i < text.length - 1) return false; }
  return true;
}
const wrap = piece => isAtomic(piece) ? piece.trim() : `(${piece.trim()})`;

function convertTex(src) {
  let i = 0, out = '';
  const skipSpaces = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const group = () => {
    let depth = 0;
    for (let start = i + 1; i < src.length; i++) {
      if (src[i] === '\\') { i++; continue; }
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i++);
    }
    return bad();
  };
  /** The argument of ^, _, \frac, \sqrt: a {group}, a \command or one character (a digit run after ^ and _, as authors mean it). */
  const argument = ({ run = false } = {}) => {
    skipSpaces();
    if (i >= src.length) return bad();
    if (src[i] === '{') return group();
    if (src[i] === '\\') { const m = /^\\(?:[a-zA-Z]+|.)/.exec(src.slice(i)); i += m[0].length; return m[0]; }
    if (run && /\d/.test(src[i])) { const m = /^\d+/.exec(src.slice(i)); i += m[0].length; return m[0]; }
    return src[i++];
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === '^' || ch === '_') {
      i++;
      const raw = argument({ run: true });
      if (ch === '^' && raw === '\\circ') { out += '°'; continue; }
      const inner = convertTex(raw), mapped = script(inner, ch === '^' ? SUP : SUB);
      if (mapped !== null) out += mapped;
      else if (ch === '^') out += `^(${inner})`;
      else return bad();
    } else if (ch === '{') { out += convertTex(group()); }
    else if (ch === '~') { out += ' '; i++; }
    else if (ch === '\\') {
      const m = /^\\([a-zA-Z]+|.)/s.exec(src.slice(i));
      if (!m) return bad();
      const name = m[1]; i += m[0].length;
      // TeX drops the space after a command; for an operator keep the author's spacing when the expression was spaced.
      const compact = !!out && !/\s$/.test(out), afterSymbol = ordinary => { if (ordinary || compact) skipSpaces(); };
      if (SPACES.has(name)) out += ' ';
      else if (name === '!') { /* negative thin space */ }
      else if (/^[{}%&#_$]$/.test(name)) out += name;
      else if (Object.hasOwn(ORDINARY, name)) { out += ORDINARY[name]; afterSymbol(true); }
      else if (Object.hasOwn(OPERATORS, name)) { out += OPERATORS[name]; afterSymbol(false); }
      else if (name === 'left' || name === 'right') { if (src[i] === '.') i++; }
      else if (name === 'sqrt') {
        let index = '';
        skipSpaces();
        if (src[i] === '[') { const end = src.indexOf(']', i); if (end < 0) return bad(); index = convertTex(src.slice(i + 1, end)); i = end + 1; }
        const body = convertTex(argument()), prefix = index ? script(index, SUP) : '';
        if (prefix === null) return bad();
        out += `${prefix}√${wrap(body)}`;
      } else if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const top = convertTex(argument()), bottom = convertTex(argument());
        out += `${wrap(top)}/${wrap(bottom)}`;
      } else if (name === 'ce') { const content = chemistry(argument()); if (content === null) return bad(); out += content; }
      else if (WRAPPERS.has(name)) { skipSpaces(); out += src[i] === '{' ? convertTex(group()) : ''; }
      else if (FUNCTIONS.has(name)) { out += name; skipSpaces(); }
      else return bad();
    } else { out += ch; i++; }
  }
  return out;
}

/** The converted text of a maths span, or null when anything TeX is left over. */
function mathSpan(inner) {
  try {
    const out = convertTex(inner).replace(/[ \t]{2,}/g, ' ').trim();
    return /[\\{}_$]/.test(out) ? null : out;
  } catch (error) { if (error instanceof Incomplete) return null; throw error; }
}

/* ---------- prose ---------- */

const POWER = /([A-Za-z0-9)\]])\^(\{[^{}\n]*\}|[+-]?\d+|[nkm](?![A-Za-z0-9]))/g;

/** Bare ASCII formulas outside any $…$: H2SO4, SO4^2-, Fe^3+, x^2. Anything else in the prose is left as written. */
function prose(text) {
  const chemical = text.replace(CHEMICAL_CANDIDATE, (whole, ...groups) => {
    const converted = chemicalToken([whole, ...groups]);
    return converted === null ? whole : converted;
  });
  return chemical.replace(POWER, (whole, base, exponent) => {
    const raw = exponent.startsWith('{') ? exponent.slice(1, -1) : exponent, mapped = script(raw, SUP);
    return mapped !== null ? base + mapped : exponent.startsWith('{') ? `${base}^(${raw})` : whole;
  });
}

const SEGMENT = /(```[\s\S]*?```|`[^`\n]*`)|(\$\$[\s\S]+?\$\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]|(?<![\\$\w])\$(?=[^\s$])[^$\n]+?(?<=[^\s\\])\$(?![\d$]))/g;
const BARE_TEX = new RegExp(`\\\\(?:${[...KNOWN].join('|')})(?![a-zA-Z])`, 'g');

/** Text mode: simple TeX and ASCII formulas → plain Unicode, outside code. Whatever cannot be converted completely stays
    exactly as written and is listed in `unconverted` ({ span, index } in the INPUT) so a check can report it. */
export function toUnicodeMath(value) {
  const input = typeof value === 'string' ? value : '';
  const unconverted = [];
  let out = '', last = 0;
  const bare = (text, offset) => {
    for (const match of text.matchAll(BARE_TEX)) unconverted.push({ span: match[0], index: offset + match.index });
    return prose(text);
  };
  for (const match of input.matchAll(SEGMENT)) {
    out += bare(input.slice(last, match.index), last);
    if (match[1] !== undefined) out += match[1];
    else {
      const span = match[2], inner = span.startsWith('$$') || span.startsWith('\\') ? span.slice(2, -2) : span.slice(1, -1);
      const converted = mathSpan(inner);
      if (converted === null) { out += span; unconverted.push({ span, index: match.index }); } else out += converted;
    }
    last = match.index + match[0].length;
  }
  out += bare(input.slice(last), last);
  return { text: out, unconverted };
}
