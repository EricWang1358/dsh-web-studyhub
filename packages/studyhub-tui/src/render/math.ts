/**
 * LaTeX → Unicode approximation for terminals.
 *
 * `renderMath('\\frac{a}{b} + x^2')` → `a/b + x²`. Unknown commands degrade to their bare name,
 * unsupported super/subscript glyphs fall back to `^(…)` / `_(…)`, and any parser error returns the
 * input unchanged — this never throws.
 */
import { LruCache } from './lru.js';

const MATH_CACHE_MAX = 512;
const mathCache = new LruCache<string, string>(MATH_CACHE_MAX);

export function clearMathCache(): void {
  mathCache.clear();
}

export function mathCacheSize(): number {
  return mathCache.size;
}

// ---------------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------------

const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', varkappa: 'ϰ', lambda: 'λ', mu: 'μ', nu: 'ν',
  xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς',
  tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε', Zeta: 'Ζ', Eta: 'Η', Theta: 'Θ',
  Iota: 'Ι', Kappa: 'Κ', Lambda: 'Λ', Mu: 'Μ', Nu: 'Ν', Xi: 'Ξ', Omicron: 'Ο', Pi: 'Π', Rho: 'Ρ',
  Sigma: 'Σ', Tau: 'Τ', Upsilon: 'Υ', Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω',
  varGamma: 'Γ', varDelta: 'Δ', varTheta: 'Θ', varLambda: 'Λ', varPi: 'Π', varSigma: 'Σ', varPhi: 'Φ',
  varPsi: 'Ψ', varOmega: 'Ω', digamma: 'ϝ',
};

const SYMBOLS: Record<string, string> = {
  // big operators
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
  bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁', bigotimes: '⨂', bigvee: '⋁', bigwedge: '⋀',
  // relations
  infty: '∞', approx: '≈', neq: '≠', ne: '≠', leq: '≤', le: '≤', geq: '≥', ge: '≥', leqslant: '⩽',
  geqslant: '⩾', ll: '≪', gg: '≫', equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝',
  doteq: '≐', prec: '≺', succ: '≻', preceq: '⪯', succeq: '⪰', asymp: '≍', models: '⊨', vdash: '⊢',
  // sets / logic
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇',
  subsetneq: '⊊', supsetneq: '⊋', cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅',
  varnothing: '∅', forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬', land: '∧',
  wedge: '∧', lor: '∨', vee: '∨', complement: '∁',
  // arrows
  rightarrow: '→', to: '→', Rightarrow: '⇒', leftarrow: '←', gets: '←', Leftarrow: '⇐',
  leftrightarrow: '↔', Leftrightarrow: '⇔', iff: '⇔', implies: '⟹', impliedby: '⟸',
  mapsto: '↦', longrightarrow: '⟶', longleftarrow: '⟵', Longrightarrow: '⟹', Longleftarrow: '⟸',
  longleftrightarrow: '⟷', Longleftrightarrow: '⟺', longmapsto: '⟼', uparrow: '↑',
  downarrow: '↓', Uparrow: '⇑', Downarrow: '⇓', updownarrow: '↕', nearrow: '↗', searrow: '↘',
  swarrow: '↙', nwarrow: '↖', hookrightarrow: '↪', hookleftarrow: '↩', rightleftharpoons: '⇌',
  leadsto: '⇝',
  // calculus / operators
  partial: '∂', nabla: '∇', times: '×', cdot: '·', ast: '∗', star: '⋆', circ: '∘', bullet: '•',
  pm: '±', mp: '∓', div: '÷', oplus: '⊕', ominus: '⊖', otimes: '⊗', odot: '⊙', oslash: '⊘',
  dagger: '†', ddagger: '‡', wr: '≀', amalg: '⨿',
  // dots
  ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', dots: '…', dotsc: '…', dotsb: '⋯',
  // misc
  prime: '′', degree: '°', angle: '∠', measuredangle: '∡', perp: '⊥', parallel: '∥', mid: '∣',
  nmid: '∤', langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉',
  lvert: '|', rvert: '|', vert: '|', Vert: '‖', lVert: '‖', rVert: '‖', hbar: 'ℏ', hslash: 'ℏ',
  ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ', beth: 'ℶ', wp: '℘', therefore: '∴', because: '∵',
  top: '⊤', bot: '⊥', square: '□', Box: '□', blacksquare: '■', triangle: '△', diamond: '⋄',
  checkmark: '✓', surd: '√', imath: 'ı', jmath: 'ȷ', backslash: '\\', S: '§', P: '¶',
  copyright: '©', dag: '†', clubsuit: '♣', diamondsuit: '♢', heartsuit: '♡', spadesuit: '♠',
  flat: '♭', natural: '♮', sharp: '♯', lbrace: '{', rbrace: '}', lbrack: '[', rbrack: ']',
  // spacing
  quad: '  ', qquad: '    ', enspace: ' ', thinspace: ' ', medspace: ' ', thickspace: ' ',
  space: ' ', nobreakspace: ' ', negthinspace: '',
  // ignorable layout commands
  displaystyle: '', textstyle: '', scriptstyle: '', scriptscriptstyle: '', limits: '',
  nolimits: '', big: '', Big: '', bigg: '', Bigg: '', bigl: '', bigr: '', Bigl: '', Bigr: '',
  biggl: '', biggr: '', Biggl: '', Biggr: '', bigm: '', Bigm: '', middle: '', nonumber: '',
  notag: '', centering: '', strut: '', mathstrut: '', relax: '', bmod: ' mod ', mod: ' mod ',
};

const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh',
  'coth', 'log', 'ln', 'lg', 'exp', 'max', 'min', 'sup', 'inf', 'det', 'dim', 'ker', 'deg', 'gcd',
  'lcm', 'arg', 'Pr', 'lim', 'liminf', 'limsup', 'hom', 'tr', 'rank', 'sgn', 'span',
]);

/** Single-char escapes: `\,` `\{` … */
const ESCAPES: Record<string, string> = {
  ',': ' ', ':': ' ', ';': ' ', '>': ' ', ' ': ' ', '!': '', '{': '{', '}': '}', '%': '%',
  $: '$', '&': '&', '#': '#', _: '_', '|': '‖', '\\': '\n', '/': '',
};

const ACCENTS: Record<string, { mark: string; all: boolean }> = {
  vec: { mark: '\u20D7', all: false },
  overrightarrow: { mark: '\u20D7', all: false },
  hat: { mark: '\u0302', all: false },
  widehat: { mark: '\u0302', all: false },
  bar: { mark: '\u0304', all: false },
  overline: { mark: '\u0305', all: true },
  underline: { mark: '\u0332', all: true },
  dot: { mark: '\u0307', all: false },
  ddot: { mark: '\u0308', all: false },
  tilde: { mark: '\u0303', all: false },
  widetilde: { mark: '\u0303', all: false },
  acute: { mark: '\u0301', all: false },
  grave: { mark: '\u0300', all: false },
  check: { mark: '\u030C', all: false },
  breve: { mark: '\u0306', all: false },
};

const SUP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '−': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ',
  m: 'ᵐ', n: 'ⁿ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ',
  z: 'ᶻ', A: 'ᴬ', B: 'ᴮ', D: 'ᴰ', E: 'ᴱ', G: 'ᴳ', H: 'ᴴ', I: 'ᴵ', J: 'ᴶ', K: 'ᴷ', L: 'ᴸ', M: 'ᴹ',
  N: 'ᴺ', O: 'ᴼ', P: 'ᴾ', R: 'ᴿ', T: 'ᵀ', U: 'ᵁ', V: 'ⱽ', W: 'ᵂ',
  α: 'ᵅ', β: 'ᵝ', γ: 'ᵞ', δ: 'ᵟ', ε: 'ᵋ', θ: 'ᶿ', ι: 'ᶥ', φ: 'ᵠ', χ: 'ᵡ',
  '′': '′', '″': '″', '∘': '°', '°': '°', '*': '*', '∗': '*', '†': '†', '‡': '‡', '∞': '∞',
};

const SUB: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '−': '₋', '=': '₌', '(': '₍', ')': '₎',
  a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ',
  s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ', β: 'ᵦ', γ: 'ᵧ', ρ: 'ᵨ', φ: 'ᵩ', χ: 'ᵪ',
};

/** Characters allowed to pass through a script conversion untouched (e.g. `a_{i,j}` → `aᵢ,ⱼ`). */
const SCRIPT_PASSTHROUGH = new Set([',', '.', '·']);

const BB_EXCEPTIONS: Record<string, string> = { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' };
const CAL_EXCEPTIONS: Record<string, string> = {
  B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ',
};
const FRAK_EXCEPTIONS: Record<string, string> = { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' };

type Alphabet = 'bf' | 'bb' | 'cal' | 'frak' | 'sf' | 'tt';

function mapAlphabet(text: string, kind: Alphabet): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    const upper = c >= 65 && c <= 90;
    const lower = c >= 97 && c <= 122;
    const digit = c >= 48 && c <= 57;
    let mapped: string | undefined;
    switch (kind) {
      case 'bf':
        if (upper) mapped = String.fromCodePoint(0x1d400 + c - 65);
        else if (lower) mapped = String.fromCodePoint(0x1d41a + c - 97);
        else if (digit) mapped = String.fromCodePoint(0x1d7ce + c - 48);
        break;
      case 'bb':
        if (upper) mapped = BB_EXCEPTIONS[ch] ?? String.fromCodePoint(0x1d538 + c - 65);
        else if (lower) mapped = String.fromCodePoint(0x1d552 + c - 97);
        else if (digit) mapped = String.fromCodePoint(0x1d7d8 + c - 48);
        break;
      case 'cal':
        if (upper) mapped = CAL_EXCEPTIONS[ch] ?? String.fromCodePoint(0x1d49c + c - 65);
        else if (lower) mapped = CAL_EXCEPTIONS[ch] ?? String.fromCodePoint(0x1d4b6 + c - 97);
        break;
      case 'frak':
        if (upper) mapped = FRAK_EXCEPTIONS[ch] ?? String.fromCodePoint(0x1d504 + c - 65);
        else if (lower) mapped = String.fromCodePoint(0x1d51e + c - 97);
        break;
      case 'sf':
        if (upper) mapped = String.fromCodePoint(0x1d5a0 + c - 65);
        else if (lower) mapped = String.fromCodePoint(0x1d5ba + c - 97);
        else if (digit) mapped = String.fromCodePoint(0x1d7e2 + c - 48);
        break;
      case 'tt':
        if (upper) mapped = String.fromCodePoint(0x1d670 + c - 65);
        else if (lower) mapped = String.fromCodePoint(0x1d68a + c - 97);
        else if (digit) mapped = String.fromCodePoint(0x1d7f6 + c - 48);
        break;
    }
    out += mapped ?? ch;
  }
  return out;
}

const ALPHABET_CMDS: Record<string, Alphabet | null> = {
  mathbf: 'bf', textbf: 'bf', boldsymbol: 'bf', bm: 'bf', bold: 'bf', mathbb: 'bb', Bbb: 'bb',
  mathcal: 'cal', mathscr: 'cal', mathfrak: 'frak', mathsf: 'sf', mathtt: 'tt',
  mathrm: null, mathit: null, mathnormal: null, textit: null, emph: null, mathop: null,
  mathbin: null, mathrel: null, mathord: null, mathpunct: null, operatorname: null, hbox: null,
  mbox: null,
};

const TEXT_CMDS = new Set(['text', 'textrm', 'textnormal', 'textsf', 'texttt', 'textup', 'mbox', 'hbox']);

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const WS_GLOBAL_RE = /\s+/g;
const WS_CHAR_RE = /\s/;
const ATOM_RE = /^[\p{L}\p{N}\p{M}.′∞]+$/u;
const TEXT_ESCAPE_RE = /\\([{}%$&#_ ])/g;
const DOLLAR_DISPLAY_RE = /^\$\$([\s\S]*)\$\$$/;
const BRACKET_DISPLAY_RE = /^\\\[([\s\S]*)\\\]$/;
const PAREN_INLINE_RE = /^\\\(([\s\S]*)\\\)$/;
const DOLLAR_INLINE_RE = /^\$([^$]*)\$$/;
const MULTI_SPACE_RE = / {2,}(?=\S)/g;
const NEWLINE_RE = /\n/g;

function isWhitespaceChar(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || WS_CHAR_RE.test(ch);
}

function graphemes(s: string): string[] {
  const out: string[] = [];
  for (const g of graphemeSegmenter.segment(s)) out.push(g.segment);
  return out;
}

function toScript(content: string, map: Record<string, string>, marker: '^' | '_'): string {
  const body = content.replace(WS_GLOBAL_RE, '');
  if (!body) return '';
  const gs = graphemes(body);
  let mapped = '';
  let ok = true;
  let any = false;
  for (const g of gs) {
    const m = map[g];
    if (m !== undefined) {
      mapped += m;
      any = true;
    } else if (SCRIPT_PASSTHROUGH.has(g)) mapped += g;
    else {
      ok = false;
      break;
    }
  }
  if (ok && any) return mapped;
  if (gs.length === 1) return marker + body;
  return `${marker}(${body})`;
}

/** Atoms render without parentheses in \frac / \sqrt. */
function isAtom(s: string): boolean {
  if (!s) return true;
  if (ATOM_RE.test(s)) return true;
  return graphemes(s).length === 1;
}

const MATRIX_ENVS: Record<string, [string, string]> = {
  matrix: ['', ''], smallmatrix: ['', ''], pmatrix: ['(', ')'], bmatrix: ['[', ']'],
  Bmatrix: ['{', '}'], vmatrix: ['|', '|'], Vmatrix: ['‖', '‖'], cases: ['{ ', ''],
  array: ['', ''],
};

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

class TexParser {
  private i = 0;
  private matrixDepth = 0;

  private readonly s: string;

  constructor(s: string) {
    this.s = s;
  }

  parse(): string {
    return this.parseSeq(null);
  }

  private peek(): string {
    return this.s[this.i] ?? '';
  }

  private skipWs(): void {
    while (this.i < this.s.length && isWhitespaceChar(this.s[this.i])) this.i++;
  }

  /** Parse until `stop` (consumed) or end of input. */
  private parseSeq(stop: string | null): string {
    let out = '';
    while (this.i < this.s.length) {
      const ch = this.s[this.i];
      if (stop !== null && ch === stop) {
        this.i++;
        return out;
      }
      if (isWhitespaceChar(ch)) {
        this.skipWs();
        if (out && !out.endsWith(' ') && !out.endsWith('\n')) out += ' ';
        continue;
      }
      if (ch === '^' || ch === '_') {
        this.i++;
        const arg = this.parseArg();
        out += toScript(arg, ch === '^' ? SUP : SUB, ch);
        continue;
      }
      if (ch === '\'') {
        this.i++;
        out += '′';
        continue;
      }
      if (ch === '}') {
        // stray closing brace — drop it
        this.i++;
        continue;
      }
      out += this.parseAtom();
    }
    return out;
  }

  /** A single unit: `{group}`, `\command` (+ its args) or one character. */
  private parseAtom(): string {
    const ch = this.peek();
    if (ch === '{') {
      this.i++;
      return this.parseSeq('}');
    }
    if (ch === '\\') return this.parseCommand();
    if (ch === '~') {
      this.i++;
      return ' ';
    }
    if (ch === '&') {
      this.i++;
      return ' ';
    }
    const cp = this.s.codePointAt(this.i) as number;
    const c = String.fromCodePoint(cp);
    this.i += c.length;
    return c;
  }

  /** Argument of ^ _ \frac …: a group, a command, or one character. */
  private parseArg(): string {
    this.skipWs();
    if (this.i >= this.s.length) return '';
    return this.parseAtom();
  }

  /** Raw (unparsed) brace group contents, or a single char when no brace follows. */
  private parseRawArg(): string {
    this.skipWs();
    if (this.peek() !== '{') {
      const c = this.peek();
      this.i += c.length;
      return c;
    }
    let depth = 0;
    const start = this.i + 1;
    for (; this.i < this.s.length; this.i++) {
      const c = this.s[this.i];
      if (c === '\\') {
        this.i++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          const raw = this.s.slice(start, this.i);
          this.i++;
          return raw;
        }
      }
    }
    return this.s.slice(start);
  }

  private parseOptional(): string | null {
    this.skipWs();
    if (this.peek() !== '[') return null;
    this.i++;
    return this.parseSeq(']');
  }

  private readCommandName(): string {
    // assumes this.s[this.i] === '\\'
    this.i++;
    const start = this.i;
    while (this.i < this.s.length) {
      const c = this.s.charCodeAt(this.i);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) this.i++;
      else break;
    }
    if (this.i > start) return this.s.slice(start, this.i);
    const c = this.peek();
    this.i += c.length;
    return c;
  }

  private parseDelimiter(): string {
    this.skipWs();
    const c = this.peek();
    if (!c) return '';
    if (c === '.') {
      this.i++;
      return '';
    }
    if (c === '\\') {
      const name = this.readCommandName();
      if (name === '{' || name === '}') return name;
      if (name === '|') return '‖';
      return SYMBOLS[name] ?? name;
    }
    this.i++;
    return c;
  }

  private parseCommand(): string {
    const name = this.readCommandName();
    if (!name) return '\\';
    if (name.length === 1) {
      const cc = name.charCodeAt(0);
      if (!((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122))) {
        if (name === '\\') return this.matrixDepth > 0 ? '; ' : '\n';
        return ESCAPES[name] ?? name;
      }
    }
    if (name in GREEK) return GREEK[name];
    if (FUNCTIONS.has(name)) return name;

    switch (name) {
      case 'frac':
      case 'dfrac':
      case 'tfrac':
      case 'cfrac': {
        const a = this.parseArg().trim();
        const b = this.parseArg().trim();
        return `${isAtom(a) ? a : `(${a})`}/${isAtom(b) ? b : `(${b})`}`;
      }
      case 'binom':
      case 'dbinom':
      case 'tbinom': {
        const n = this.parseArg().trim();
        const k = this.parseArg().trim();
        return `C(${n},${k})`;
      }
      case 'sqrt': {
        const idx = this.parseOptional();
        const x = this.parseArg().trim();
        const body = isAtom(x) ? x : `(${x})`;
        const n = idx?.trim();
        if (!n || n === '2') return `√${body}`;
        if (n === '3') return `∛${body}`;
        if (n === '4') return `∜${body}`;
        return `${toScript(n, SUP, '^')}√${body}`;
      }
      case 'left':
      case 'right':
        return this.parseDelimiter();
      case 'pmod': {
        const x = this.parseArg().trim();
        return ` (mod ${x})`;
      }
      case 'begin': {
        const rawEnv = this.parseRawArg();
        const env = rawEnv.endsWith('*') ? rawEnv.slice(0, -1) : rawEnv;
        if (env === 'array') this.parseRawArg(); // column spec
        const m = MATRIX_ENVS[env];
        if (m) {
          this.matrixDepth++;
          return m[0];
        }
        return '';
      }
      case 'end': {
        const rawEnv = this.parseRawArg();
        const env = rawEnv.endsWith('*') ? rawEnv.slice(0, -1) : rawEnv;
        const m = MATRIX_ENVS[env];
        if (m) {
          this.matrixDepth = Math.max(0, this.matrixDepth - 1);
          return m[1];
        }
        return '';
      }
      case 'color':
        this.parseRawArg();
        return '';
      case 'textcolor':
      case 'colorbox': {
        this.parseRawArg();
        return this.parseArg();
      }
      case 'overset':
      case 'stackrel': {
        const over = this.parseArg().trim();
        const base = this.parseArg().trim();
        return `${base}${toScript(over, SUP, '^')}`;
      }
      case 'underset': {
        const under = this.parseArg().trim();
        const base = this.parseArg().trim();
        return `${base}${toScript(under, SUB, '_')}`;
      }
      case 'not': {
        const x = this.parseArg();
        if (x === '=') return '≠';
        if (x === '∈') return '∉';
        if (x === '⊂') return '⊄';
        return x ? `${x}\u0338` : '';
      }
      case 'boxed':
      case 'phantom':
      case 'hphantom':
      case 'vphantom': {
        const x = this.parseArg();
        return name === 'boxed' ? `[${x}]` : '';
      }
      default:
        break;
    }

    if (TEXT_CMDS.has(name)) {
      const raw = this.parseRawArg();
      if (!raw.includes('\\')) return raw;
      TEXT_ESCAPE_RE.lastIndex = 0;
      return raw.replace(TEXT_ESCAPE_RE, '$1');
    }
    if (name in ALPHABET_CMDS) {
      const kind = ALPHABET_CMDS[name];
      const inner = name === 'textbf' ? this.parseRawArg() : this.parseArg();
      return kind ? mapAlphabet(inner, kind) : inner;
    }
    if (name in ACCENTS) {
      const { mark, all } = ACCENTS[name];
      const inner = this.parseArg();
      if (!inner) return '';
      const gs = graphemes(inner);
      if (all) return gs.map((g) => g + mark).join('');
      gs[gs.length - 1] += mark;
      return gs.join('');
    }
    if (name in SYMBOLS) return SYMBOLS[name];
    // Unknown command: degrade to its bare name.
    return name;
  }
}

function stripDelimiters(tex: string): string {
  const t = tex.trim();
  let m = DOLLAR_DISPLAY_RE.exec(t);
  if (m) return m[1];
  m = BRACKET_DISPLAY_RE.exec(t);
  if (m) return m[1];
  m = PAREN_INLINE_RE.exec(t);
  if (m) return m[1];
  m = DOLLAR_INLINE_RE.exec(t);
  if (m) return m[1];
  return t;
}

function normalizeMathLine(line: string): string {
  if (line.includes('  ')) {
    MULTI_SPACE_RE.lastIndex = 0;
    line = line.replace(MULTI_SPACE_RE, (m) => (m.length >= 4 ? m : ' '));
  }
  return line.trim();
}

/** Convert a TeX expression (with or without `$` delimiters) to a Unicode approximation. */
export function renderMath(tex: string, enabled = true): string {
  if (!enabled || typeof tex !== 'string') return tex;
  const cached = mathCache.get(tex);
  if (cached !== undefined) return cached;
  let out: string;
  try {
    const parsed = new TexParser(stripDelimiters(tex)).parse();
    if (!parsed.includes('\n')) {
      out = normalizeMathLine(parsed);
    } else {
      out = parsed
        .split('\n')
        .map(normalizeMathLine)
        .filter((l, i, arr) => l !== '' || (i > 0 && i < arr.length - 1))
        .join('\n');
    }
  } catch {
    out = tex;
  }
  mathCache.set(tex, out);
  return out;
}

/**
 * Matches `$$…$$`, `\[…\]`, `\(…\)` and `$…$` (the latter requires non-space just inside both
 * delimiters and is not followed by a digit, so "costs $5 and $6" stays prose).
 */
const MATH_SEGMENT_SOURCE =
  '\\$\\$([\\s\\S]+?)\\$\\$|\\\\\\[([\\s\\S]+?)\\\\\\]|\\\\\\(([\\s\\S]+?)\\\\\\)|(?<![\\\\$])\\$(?![\\s$])((?:\\\\.|[^$\\\\\\n])+?)(?<!\\s)\\$(?![\\d$])';
const MATH_SEGMENT_RE = new RegExp(MATH_SEGMENT_SOURCE, 'g');

export interface MathSegment {
  /** Full matched source including delimiters. */
  raw: string;
  /** TeX body without delimiters. */
  tex: string;
  /** true for `$$…$$` / `\[…\]`. */
  display: boolean;
}

/** Replace every math segment in `text` using `fn`. */
export function replaceMath(text: string, fn: (seg: MathSegment) => string): string {
  if (!text) return text;
  const hasDollar = text.includes('$');
  const hasBackslash = text.includes('\\');
  if (!hasDollar && !hasBackslash) return text;
  if (!hasDollar && !text.includes('\\(') && !text.includes('\\[')) return text;
  MATH_SEGMENT_RE.lastIndex = 0;
  return text.replace(MATH_SEGMENT_RE, (raw: string, d1?: string, d2?: string, i1?: string, i2?: string) => {
    const display = d1 !== undefined || d2 !== undefined;
    const tex = (d1 ?? d2 ?? i1 ?? i2 ?? '').trim();
    return fn({ raw, tex, display });
  });
}

/** Render every `$…$`, `$$…$$`, `\(…\)`, `\[…\]` segment inside prose. */
export function renderInlineMath(text: string, enabled = true): string {
  if (!enabled || typeof text !== 'string') return text;
  if (!text.includes('$') && !text.includes('\\')) return text;
  return replaceMath(text, ({ tex, display }) => {
    const r = renderMath(tex);
    if (display || !r.includes('\n')) return r;
    NEWLINE_RE.lastIndex = 0;
    return r.replace(NEWLINE_RE, ' ');
  });
}
