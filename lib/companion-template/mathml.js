/* Zero-dependency offline LaTeX -> W3C MathML compiler for self-contained interactive companion HTML files.
   Every formula ($...$ or $$...$$) is rendered at compile time into pure <math xmlns="http://www.w3.org/1998/Math/MathML">
   stored in a side table (`lesson._math`), referenced by `@@SHM_0@@` tokens. Domain plugins carry zero UI npm packages
   (tests/domain-bundle-isolation.test.mjs) and lesson prose stays 100% textNode-only in the browser. */

const DISPLAY_FORMULA_PATTERN = /\$\$([\s\S]+?)\$\$/g;
const INLINE_FORMULA_OR_CURRENCY_PATTERN = /\\\$|(?<!\$)\$\d+(?:[.,]\d+)*(?=\s+[A-Za-z(]|\s*[.,;:!?)\]]|$)|(?<!\$)\$(?!\$)([^\n$]+?)(?<!\\|\$)\$(?!\$|[0-9])/g;
const RAW_SOURCE_KEYS = new Set([
  'source', 'expr', 'xExpr', 'yExpr', 'dxExpr', 'dyExpr', 'xVar', 'yVar',
  'command', 'path', 'id', 'of', 'lab', 't', 'type', 'beat', 'layout', 'lang', 'tone', 'format', 'template',
]);
const XML_ILLEGAL_CTRL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g;
const MAX_PARSE_DEPTH = 64;

const SYMBOLS = Object.freeze({
  // Lowercase & variant Greek
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', varkappa: 'ϰ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ',
  rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', digamma: 'ϝ',
  // Uppercase Greek
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  // Calculus, physics & set constants
  infty: '∞', partial: '∂', nabla: '∇', ell: 'ℓ', hbar: 'ℏ', emptyset: '∅', varnothing: '∅',
  aleph: 'ℵ', beth: 'ℶ', wp: '℘', Re: 'ℜ', Im: 'ℑ', complement: '∁',
  // Formal, propositional, predicate & modal logic
  forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬', land: '∧', wedge: '∧', lor: '∨', vee: '∨', veebar: '⊻',
  vdash: '⊢', dashv: '⊣', nvdash: '⊬', models: '⊨', vDash: '⊨', nvDash: '⊭', Vdash: '⊩',
  top: '⊤', bot: '⊥', Box: '□', square: '□', blacksquare: '■', qed: '∎', Diamond: '◇', lozenge: '◊',
  therefore: '∴', because: '∵', ulcorner: '⌜', urcorner: '⌝', llcorner: '⌞', lrcorner: '⌟',
  // Set theory & relations
  in: '∈', notin: '∉', ni: '∋', owns: '∋',
  subset: '⊂', subseteq: '⊆', subsetneq: '⊊', nsubseteq: '⊈',
  supset: '⊃', supseteq: '⊇', supsetneq: '⊋', nsupseteq: '⊉',
  sqsubset: '⊏', sqsubseteq: '⊑', sqsupset: '⊐', sqsupseteq: '⊒',
  cup: '∪', cap: '∩', sqcup: '⊔', sqcap: '⊓', setminus: '∖', backslash: '∖',
  // Binary operators
  pm: '±', mp: '∓', times: '×', div: '÷', cdot: '⋅', centerdot: '⋅', ast: '∗', star: '⋆', circ: '∘', bullet: '∙',
  oplus: '⊕', ominus: '⊖', otimes: '⊗', oslash: '⊘', odot: '⊙', ltimes: '⋉', rtimes: '⋊', dagger: '†', ddagger: '‡',
  // Comparisons & equivalences
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
  approx: '≈', approxeq: '≊', asymp: '≍', equiv: '≡', nequiv: '≢',
  sim: '∼', simeq: '≃', cong: '≅', ncong: '≇', propto: '∝', varpropto: '∝',
  doteq: '≐', triangleq: '≜', coloneqq: '≔', coloneq: '≔', eqqcolon: '≕',
  ll: '≪', gg: '≫', lesssim: '≲', gtrsim: '≳', prec: '≺', succ: '≻', preceq: '≼', succeq: '≽',
  mid: '∣', nmid: '∤', parallel: '∥', nparallel: '∦', perp: '⊥',
  // Arrows
  to: '→', rightarrow: '→', leftarrow: '←', gets: '←', leftrightarrow: '↔',
  longrightarrow: '⟶', longleftarrow: '⟵', longleftrightarrow: '⟷',
  Rightarrow: '⇒', Leftarrow: '⇐', iff: '⇔', Leftrightarrow: '⇔',
  implies: '⟹', Longrightarrow: '⟹', impliedby: '⟸', Longleftarrow: '⟸', Longleftrightarrow: '⟺',
  mapsto: '↦', longmapsto: '⟼', hookrightarrow: '↪', twoheadrightarrow: '↠',
  uparrow: '↑', downarrow: '↓', updownarrow: '↕', Uparrow: '⇑', Downarrow: '⇓', nearrow: '↗', searrow: '↘', swarrow: '↙', nwarrow: '↖',
  // Large operators (sums, products, integrals, big unions/intersections)
  sum: '∑', prod: '∏', coprod: '∐',
  bigcup: '⋃', bigcap: '⋂', bigoplus: '⨁', bigotimes: '⨂', bigsqcup: '⨆', bigvee: '⋁', bigwedge: '⋀',
  int: '∫', iint: '∬', iiint: '∭', oint: '∮', oiint: '∯',
  // Dots & geometry/misc
  dots: '…', ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱',
  angle: '∠', measuredangle: '∡', triangle: '△', triangleleft: '◁', triangleright: '▷',
  prime: '′', degree: '°', circ_deg: '°', checkmark: '✓',
});

const OPERATOR_SYMBOLS = new Set([
  '±', '∓', '×', '÷', '⋅', '∗', '⋆', '∘', '∙', '⊕', '⊖', '⊗', '⊘', '⊙', '⋉', '⋊',
  '≤', '≥', '≠', '≈', '≊', '≍', '≡', '≢', '∼', '≃', '≅', '≇', '∝', '≐', '≜', '≔', '≕',
  '≪', '≫', '≲', '≳', '≺', '≻', '≼', '≽', '∣', '∤', '∥', '∦', '⊥',
  '→', '←', '↔', '⟶', '⟵', '⟷', '⇒', '⇐', '⇔', '⟹', '⟸', '⟺', '↦', '⟼', '↪', '↠',
  '↑', '↓', '↕', '⇑', '⇓', '↗', '↘', '↙', '↖',
  '∑', '∏', '∐', '⋃', '⋂', '⨁', '⨂', '⨆', '⋁', '⋀', '∫', '∬', '∭', '∮', '∯',
  '∈', '∉', '∋', '⊂', '⊆', '⊊', '⊈', '⊃', '⊇', '⊋', '⊉', '⊏', '⊑', '⊐', '⊒', '∪', '∩', '⊔', '⊓', '∖',
  '∀', '∃', '∄', '¬', '∧', '∨', '⊻', '⊢', '⊣', '⊬', '⊨', '⊭', '⊩', '□', '◇', '◊', '∴', '∵',
]);

const NOT_NEGATIONS = Object.freeze({
  '=': '≠', equiv: '≢', in: '∉', vdash: '⊬', models: '⊭', vDash: '⊭',
  subset: '⊄', subseteq: '⊈', supset: '⊅', supseteq: '⊉',
  sim: '≁', approx: '≉', cong: '≇', parallel: '∦', mid: '∤', exists: '∄', le: '≰', leq: '≰', ge: '≱', geq: '≱',
});

// Operators whose sub/superscripts go directly under/over in displayMode (integrals keep side limits unless \limits is used)
const UNDEROVER_OPS = new Set([
  'sum', 'prod', 'coprod', 'bigcup', 'bigcap', 'bigoplus', 'bigotimes', 'bigsqcup', 'bigvee', 'bigwedge',
  'lim', 'limsup', 'liminf', 'sup', 'inf', 'max', 'min', 'argmax', 'argmin',
]);

const NAMED_FUNCS = Object.freeze({
  sin: 'sin', cos: 'cos', tan: 'tan', cot: 'cot', sec: 'sec', csc: 'csc',
  arcsin: 'arcsin', arccos: 'arccos', arctan: 'arctan',
  sinh: 'sinh', cosh: 'cosh', tanh: 'tanh', coth: 'coth',
  exp: 'exp', ln: 'ln', log: 'log', lg: 'lg',
  lim: 'lim', limsup: 'lim\u2009sup', liminf: 'lim\u2009inf',
  sup: 'sup', inf: 'inf', max: 'max', min: 'min', argmax: 'arg\u2009max', argmin: 'arg\u2009min',
  det: 'det', dim: 'dim', ker: 'ker', coker: 'coker', im: 'im', rank: 'rank', tr: 'tr', span: 'span',
  deg: 'deg', gcd: 'gcd', lcm: 'lcm', Pr: 'Pr', Var: 'Var', Cov: 'Cov', arg: 'arg', sgn: 'sgn', mod: 'mod', bmod: 'mod',
});

const ACCENTS = Object.freeze({
  hat: { ch: '^', stretchy: false },
  widehat: { ch: '^', stretchy: true },
  check: { ch: 'ˇ', stretchy: false },
  breve: { ch: '˘', stretchy: false },
  acute: { ch: 'ˊ', stretchy: false },
  grave: { ch: 'ˋ', stretchy: false },
  bar: { ch: '¯', stretchy: false },
  overline: { ch: '¯', stretchy: true },
  vec: { ch: '→', stretchy: false },
  overrightarrow: { ch: '→', stretchy: true },
  overleftarrow: { ch: '←', stretchy: true },
  dot: { ch: '˙', stretchy: false },
  ddot: { ch: '¨', stretchy: false },
  dddot: { ch: '⃛', stretchy: false },
  tilde: { ch: '~', stretchy: false },
  widetilde: { ch: '~', stretchy: true },
});

const SPACES = Object.freeze({ ',': '0.17em', ':': '0.22em', ';': '0.28em', '!': '-0.17em', quad: '1em', qquad: '2em', ' ': '0.25em', enspace: '0.5em', thinspace: '0.17em' });
const DELIMS = Object.freeze({
  '{': '{', '}': '}', lbrace: '{', rbrace: '}',
  langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉',
  '|': '‖', vert: '|', lvert: '|', rvert: '|', Vert: '‖', lVert: '‖', rVert: '‖',
  backslash: '∖', '/': '/', '.': '',
});
const SIZED_DELIM_CMDS = new Set([
  'big', 'Big', 'bigg', 'Bigg',
  'bigl', 'bigr', 'bigm', 'Bigl', 'Bigr', 'Bigm',
  'biggl', 'biggr', 'biggm', 'Biggl', 'Biggr', 'Biggm',
]);
const EXTENSIBLE_ARROWS = Object.freeze({
  xrightarrow: '⟶',
  xleftarrow: '⟵',
  xleftrightarrow: '⟷',
  xRightarrow: '⟹',
  xLeftarrow: '⟸',
  xLeftrightarrow: '⟺',
  xmapsto: '⟼',
});
const CANCEL_SPECS = Object.freeze({
  cancel: { cls: 'sh-cancel', notation: 'updiagonalstrike' },
  bcancel: { cls: 'sh-bcancel', notation: 'downdiagonalstrike' },
  xcancel: { cls: 'sh-xcancel', notation: 'updiagonalstrike downdiagonalstrike' },
  sout: { cls: 'sh-sout', notation: 'horizontalstrike' },
});

const escXml = s => String(s)
  .replace(XML_ILLEGAL_CTRL_RE, '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

function cleanTexEscapes(raw) {
  return String(raw ?? '')
    .replace(/\\(?:,|thinspace)/g, '\u2009')
    .replace(/\\(?:;|:| |quad|qquad|enspace)/g, ' ')
    .replace(/\\!/g, '')
    .replace(/\\([{}%&$#_])/g, '$1')
    .replace(/\\([A-Za-z]+)/g, (_, c) => (Object.hasOwn(SYMBOLS, c) ? SYMBOLS[c] : c));
}

function formatMtextContent(raw) {
  let txt = cleanTexEscapes(raw).replace(/~/g, '\u00A0');
  if (/^\s/.test(txt)) txt = '\u00A0' + txt.replace(/^\s+/, '');
  if (/\s$/.test(txt)) txt = txt.replace(/\s+$/, '') + '\u00A0';
  return escXml(txt);
}

/** Split environment body on top-level `\\` (plus optional `*[len]`) and top-level `&` while respecting `{...}` and nested `\begin...\end`. */
function splitLatexTable(content) {
  const rows = [];
  let cells = [];
  let buf = '';
  let braceDepth = 0;
  let envDepth = 0;
  let k = 0;
  const len = content.length;

  while (k < len) {
    const ch = content[k];
    if (ch === '\\') {
      if (content[k + 1] === '\\') {
        if (braceDepth === 0 && envDepth === 0) {
          k += 2;
          while (k < len && (content[k] === ' ' || content[k] === '\t')) k++;
          if (content[k] === '*') {
            k++;
            while (k < len && (content[k] === ' ' || content[k] === '\t')) k++;
          }
          if (content[k] === '[') {
            k++;
            while (k < len && content[k] !== ']') k++;
            if (content[k] === ']') k++;
          }
          cells.push(buf);
          rows.push(cells);
          cells = [];
          buf = '';
          continue;
        }
        buf += '\\\\';
        k += 2;
        continue;
      }
      if (content.startsWith('\\begin{', k)) envDepth++;
      else if (content.startsWith('\\end{', k) && envDepth > 0) envDepth--;
      if (k + 1 < len) {
        buf += content.slice(k, k + 2);
        k += 2;
        continue;
      }
    }
    if (ch === '{') braceDepth++;
    else if (ch === '}' && braceDepth > 0) braceDepth--;
    else if (ch === '&' && braceDepth === 0 && envDepth === 0) {
      cells.push(buf);
      buf = '';
      k++;
      continue;
    }
    buf += ch;
    k++;
  }
  if (buf.trim() || cells.length) {
    cells.push(buf);
    rows.push(cells);
  }
  return rows.filter(r => r.length > 1 || r[0].trim().length > 0);
}

function findMatchingEndEnv(src, startIdx, env) {
  const beginTag = `\\begin{${env}}`;
  const endTag = `\\end{${env}}`;
  let depth = 1;
  let pos = startIdx;
  while (pos < src.length && depth > 0) {
    const nextBegin = src.indexOf(beginTag, pos);
    const nextEnd = src.indexOf(endTag, pos);
    if (nextEnd < 0) return -1;
    if (nextBegin >= 0 && nextBegin < nextEnd) {
      depth++;
      pos = nextBegin + beginTag.length;
    } else {
      depth--;
      if (depth === 0) return nextEnd;
      pos = nextEnd + endTag.length;
    }
  }
  return -1;
}

function parseLatexToMathMlBody(src, displayMode, depth = 0) {
  if (depth > MAX_PARSE_DEPTH) return `<mtext>${escXml(src)}</mtext>`;
  let i = 0;
  let groupDepth = 0;
  const n = src.length;
  const skipWs = () => { while (i < n && /\s/.test(src[i])) i++; };

  function readBracedRaw() {
    skipWs();
    if (i >= n) return '';
    if (src[i] !== '{') {
      if (src[i] === '\\' && i + 1 < n) {
        let j = i + 1;
        if (!/[A-Za-z]/.test(src[j])) { const out = src.slice(i, j + 1); i = j + 1; return out; }
        while (j < n && /[A-Za-z]/.test(src[j])) j++;
        const out = src.slice(i, j);
        i = j;
        return out;
      }
      return src[i++];
    }
    i++;
    let bDepth = 1;
    const start = i;
    while (i < n && bDepth > 0) {
      if (src[i] === '\\' && i + 1 < n) { i += 2; continue; }
      if (src[i] === '{') bDepth++;
      else if (src[i] === '}') bDepth--;
      i++;
    }
    const end = bDepth === 0 ? i - 1 : i;
    return src.slice(start, Math.max(start, end));
  }

  function readBracketGroup() {
    skipWs();
    if (src[i] !== '[') return null;
    const saved = i;
    i++;
    const start = i;
    let bDepth = 1;
    while (i < n && bDepth > 0) {
      if (src[i] === '\\' && i + 1 < n) { i += 2; continue; }
      if (src[i] === '[') bDepth++;
      else if (src[i] === ']') bDepth--;
      i++;
    }
    if (bDepth !== 0) {
      i = saved;
      return null;
    }
    const inner = src.slice(start, Math.max(start, i - 1));
    return parseLatexToMathMlBody(inner, false, depth + 1);
  }

  function readDelimToken() {
    skipWs();
    if (i >= n) return '';
    if (src[i] === '\\') {
      i++;
      if (i >= n) return '';
      let dc = '';
      if (!/[A-Za-z]/.test(src[i])) dc = src[i++];
      else while (i < n && /[A-Za-z]/.test(src[i])) dc += src[i++];
      if (Object.hasOwn(DELIMS, dc)) return DELIMS[dc];
      if (Object.hasOwn(SYMBOLS, dc)) return SYMBOLS[dc];
      return dc;
    }
    const ch = src[i++];
    if (ch === '.') return '';
    return Object.hasOwn(DELIMS, ch) ? DELIMS[ch] : ch;
  }

  function wrapRow(items) {
    if (!items.length) return '<mrow></mrow>';
    return items.length === 1 ? items[0] : `<mrow>${items.join('')}</mrow>`;
  }

  function unwrapItem(val) {
    if (!val) return '<mrow></mrow>';
    return typeof val === 'object' ? val.markup : val;
  }

  function parseStyledIdent(variant) {
    const raw = readBracedRaw();
    if (!raw) return '<mrow></mrow>';
    if (raw.includes('_') || raw.includes('^') || /\\(?:frac|sqrt|hat|bar|tilde|dot|ddot|vec|overline|underline|left|right|begin)\b/.test(raw)) {
      return `<mstyle mathvariant="${variant}">${parseLatexToMathMlBody(raw, false, depth + 1)}</mstyle>`;
    }
    const cleaned = cleanTexEscapes(raw).trim();
    return cleaned ? `<mi mathvariant="${variant}">${escXml(cleaned)}</mi>` : '<mrow></mrow>';
  }

  function renderTextNode(raw, attr = '') {
    const str = String(raw ?? '');
    if (str.includes('$')) {
      const parts = [];
      let last = 0;
      const re = /\$([^$]+)\$/g;
      for (let m = re.exec(str); m; m = re.exec(str)) {
        if (m.index > last) parts.push(`<mtext${attr}>${formatMtextContent(str.slice(last, m.index))}</mtext>`);
        parts.push(parseLatexToMathMlBody(m[1], false, depth + 1));
        last = re.lastIndex;
      }
      if (last < str.length) parts.push(`<mtext${attr}>${formatMtextContent(str.slice(last))}</mtext>`);
      return wrapRow(parts);
    }
    return `<mtext${attr}>${formatMtextContent(str)}</mtext>`;
  }

  function parseAtom(stopChar = '') {
    skipWs();
    if (i >= n) return null;
    const ch = src[i];
    if (ch === '}') {
      if (stopChar === '}') return null;
      // Malformed stray closing brace at top-level: skip without truncating remainder
      i++;
      return '<mrow></mrow>';
    }
    if (ch === '{') {
      i++;
      if (groupDepth >= MAX_PARSE_DEPTH) {
        return '<mrow></mrow>';
      }
      groupDepth++;
      const inner = parseRow('}', false);
      groupDepth--;
      if (src[i] === '}') i++;
      return wrapRow(inner);
    }
    if (ch === '\\') {
      i++;
      if (i >= n) return '<mrow></mrow>';
      const esc = src[i];
      if (!/[A-Za-z]/.test(esc)) {
        i++;
        if (Object.hasOwn(SPACES, esc)) return `<mspace width="${SPACES[esc]}"/>`;
        if (Object.hasOwn(DELIMS, esc)) return DELIMS[esc] ? `<mo>${escXml(DELIMS[esc])}</mo>` : '<mrow></mrow>';
        if (esc === '%') return '<mo>%</mo>';
        if (esc === '&' || esc === '#' || esc === '$' || esc === '_') return `<mtext>${escXml(esc)}</mtext>`;
        return `<mo>${escXml(esc)}</mo>`;
      }
      let cmd = '';
      while (i < n && /[A-Za-z]/.test(src[i])) cmd += src[i++];

      if (cmd === 'left') {
        const openD = readDelimToken();
        const inner = parseRow(stopChar, true);
        let closeD = '';
        skipWs();
        if (src.startsWith('\\right', i) && !/[A-Za-z]/.test(src[i + 6] || '')) {
          i += 6;
          closeD = readDelimToken();
        }
        const openMo = openD ? `<mo stretchy="true">${escXml(openD)}</mo>` : '';
        const closeMo = closeD ? `<mo stretchy="true">${escXml(closeD)}</mo>` : '';
        return `<mrow>${openMo}${inner.join('')}${closeMo}</mrow>`;
      }
      if (cmd === 'right' || cmd === 'middle' || SIZED_DELIM_CMDS.has(cmd)) {
        const d = readDelimToken();
        const stretchy = cmd !== 'right' ? ' stretchy="true"' : '';
        return d ? `<mo${stretchy}>${escXml(d)}</mo>` : '<mrow></mrow>';
      }
      if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac' || cmd === 'cfrac') {
        const num = unwrapItem(parseAtom(stopChar));
        const den = unwrapItem(parseAtom(stopChar));
        return `<mfrac>${num}${den}</mfrac>`;
      }
      if (cmd === 'binom' || cmd === 'dbinom' || cmd === 'tbinom') {
        const top = unwrapItem(parseAtom(stopChar));
        const bot = unwrapItem(parseAtom(stopChar));
        return `<mrow><mo stretchy="true">(</mo><mfrac linethickness="0">${top}${bot}</mfrac><mo stretchy="true">)</mo></mrow>`;
      }
      if (cmd === 'sqrt') {
        const rootIdx = readBracketGroup();
        const body = unwrapItem(parseAtom(stopChar));
        return rootIdx ? `<mroot>${body}${rootIdx}</mroot>` : `<msqrt>${body}</msqrt>`;
      }
      if (cmd === 'overline') {
        const base = unwrapItem(parseAtom(stopChar));
        return `<mover accent="true">${base}<mo stretchy="true">¯</mo></mover>`;
      }
      if (cmd === 'underline') {
        const base = unwrapItem(parseAtom(stopChar));
        return `<munder accentunder="true">${base}<mo stretchy="true">_</mo></munder>`;
      }
      if (cmd === 'overbrace') {
        const base = unwrapItem(parseAtom(stopChar));
        return { markup: `<mover>${base}<mo stretchy="true">⏞</mo></mover>`, bigOp: true, forceLimits: true };
      }
      if (cmd === 'underbrace') {
        const base = unwrapItem(parseAtom(stopChar));
        return { markup: `<munder>${base}<mo stretchy="true">⏟</mo></munder>`, bigOp: true, forceLimits: true };
      }
      if (cmd === 'overset' || cmd === 'stackrel') {
        const top = unwrapItem(parseAtom(stopChar));
        const base = unwrapItem(parseAtom(stopChar));
        return `<mover>${base}${top}</mover>`;
      }
      if (cmd === 'underset') {
        const bot = unwrapItem(parseAtom(stopChar));
        const base = unwrapItem(parseAtom(stopChar));
        return `<munder>${base}${bot}</munder>`;
      }
      if (cmd === 'substack') {
        const raw = readBracedRaw();
        const rows = splitLatexTable(raw);
        const mrows = rows.length
          ? rows.map(r => `<mtr><mtd>${parseLatexToMathMlBody(r.join(' '), false, depth + 1)}</mtd></mtr>`).join('')
          : '<mtr><mtd><mrow></mrow></mtd></mtr>';
        return `<mstyle scriptlevel="1"><mtable class="sh-substack" columnalign="center" rowspacing="0.12em">${mrows}</mtable></mstyle>`;
      }
      if (Object.hasOwn(CANCEL_SPECS, cmd)) {
        const spec = CANCEL_SPECS[cmd];
        const body = unwrapItem(parseAtom(stopChar));
        return `<menclose class="${spec.cls}" notation="${spec.notation}">${body}</menclose>`;
      }
      if (Object.hasOwn(EXTENSIBLE_ARROWS, cmd)) {
        const subPart = readBracketGroup();
        const supPart = unwrapItem(parseAtom(stopChar));
        const arrowMo = `<mo stretchy="true">${escXml(EXTENSIBLE_ARROWS[cmd])}</mo>`;
        return subPart ? `<munderover>${arrowMo}${subPart}${supPart}</munderover>` : `<mover>${arrowMo}${supPart}</mover>`;
      }
      if (cmd === 'boxed') {
        const body = unwrapItem(parseAtom(stopChar));
        return `<mtable frame="solid"><mtr><mtd>${body}</mtd></mtr></mtable>`;
      }
      if (cmd === 'pmod') {
        const body = unwrapItem(parseAtom(stopChar));
        return `<mrow><mspace width="0.4em"/><mo>(</mo><mi mathvariant="normal">mod</mi><mspace width="0.22em"/>${body}<mo>)</mo></mrow>`;
      }
      if (Object.hasOwn(ACCENTS, cmd)) {
        const spec = ACCENTS[cmd];
        const base = unwrapItem(parseAtom(stopChar));
        const strAttr = spec.stretchy ? ' stretchy="true"' : '';
        return `<mover accent="true">${base}<mo${strAttr}>${escXml(spec.ch)}</mo></mover>`;
      }
      if (cmd === 'not') {
        skipWs();
        if (i < n && src[i] === '=') { i++; return '<mo>≠</mo>'; }
        if (i < n && src[i] === '<') { i++; return '<mo>≮</mo>'; }
        if (i < n && src[i] === '>') { i++; return '<mo>≯</mo>'; }
        if (src[i] === '\\') {
          let j = i + 1, nextCmd = '';
          while (j < n && /[A-Za-z]/.test(src[j])) nextCmd += src[j++];
          if (Object.hasOwn(NOT_NEGATIONS, nextCmd)) {
            i = j;
            return `<mo>${escXml(NOT_NEGATIONS[nextCmd])}</mo>`;
          }
        }
        return '<mo>¬</mo>';
      }
      if (cmd === 'text' || cmd === 'textrm' || cmd === 'mbox' || cmd === 'textnormal') {
        return renderTextNode(readBracedRaw());
      }
      if (cmd === 'textbf') {
        return renderTextNode(readBracedRaw(), ' mathvariant="bold"');
      }
      if (cmd === 'textit' || cmd === 'emph') {
        return renderTextNode(readBracedRaw(), ' mathvariant="italic"');
      }
      if (cmd === 'texttt') {
        return renderTextNode(readBracedRaw(), ' mathvariant="monospace"');
      }
      if (cmd === 'textsf') {
        return renderTextNode(readBracedRaw(), ' mathvariant="sans-serif"');
      }
      if (cmd === 'operatorname') {
        skipWs();
        const starred = src[i] === '*';
        if (starred) i++;
        const txt = cleanTexEscapes(readBracedRaw()).trim();
        const opBig = starred || UNDEROVER_OPS.has(txt.replace(/\s+/g, ''));
        return { markup: `<mi mathvariant="normal">${escXml(txt)}</mi>`, bigOp: opBig, forceLimits: starred };
      }
      if (cmd === 'mathrm') return parseStyledIdent('normal');
      if (cmd === 'mathbf' || cmd === 'bm' || cmd === 'boldsymbol') return parseStyledIdent('bold');
      if (cmd === 'mathbb') return parseStyledIdent('double-struck');
      if (cmd === 'mathcal' || cmd === 'mathscr') return parseStyledIdent('script');
      if (cmd === 'mathfrak') return parseStyledIdent('fraktur');
      if (cmd === 'mathsf') return parseStyledIdent('sans-serif');
      if (cmd === 'mathtt') return parseStyledIdent('monospace');
      if (cmd === 'mathit') return parseStyledIdent('italic');
      if (cmd === 'displaystyle' || cmd === 'textstyle' || cmd === 'scriptstyle' || cmd === 'scriptscriptstyle' || cmd === 'limits' || cmd === 'nolimits') {
        return '<mrow></mrow>';
      }
      if (cmd === 'begin') {
        const env = readBracedRaw().trim();
        let colAlign = '';
        if (env === 'array') {
          skipWs();
          if (src[i] === '{') {
            const spec = readBracedRaw();
            const mapped = [...spec].filter(c => 'lcr'.includes(c)).map(c => (c === 'l' ? 'left' : c === 'r' ? 'right' : 'center'));
            if (mapped.length) colAlign = ` columnalign="${mapped.join(' ')}"`;
          }
        } else if (env === 'cases' || env === 'dcases' || env === 'rcases') {
          colAlign = ' columnalign="left"';
        }
        const endMarker = `\\end{${env}}`;
        const endPos = env ? findMatchingEndEnv(src, i, env) : -1;
        const content = endPos >= 0 ? src.slice(i, endPos) : src.slice(i);
        i = endPos >= 0 ? endPos + endMarker.length : n;
        const parsedRows = splitLatexTable(content);
        const mrows = parsedRows.length
          ? parsedRows.map(cells => `<mtr>${cells.map(c => `<mtd>${parseLatexToMathMlBody(c, false, depth + 1)}</mtd>`).join('')}</mtr>`).join('')
          : '<mtr><mtd><mrow></mrow></mtd></mtr>';
        const table = `<mtable${colAlign}>${mrows}</mtable>`;
        if (env === 'pmatrix') return `<mrow><mo stretchy="true">(</mo>${table}<mo stretchy="true">)</mo></mrow>`;
        if (env === 'bmatrix') return `<mrow><mo stretchy="true">[</mo>${table}<mo stretchy="true">]</mo></mrow>`;
        if (env === 'Bmatrix') return `<mrow><mo stretchy="true">{</mo>${table}<mo stretchy="true">}</mo></mrow>`;
        if (env === 'vmatrix') return `<mrow><mo stretchy="true">|</mo>${table}<mo stretchy="true">|</mo></mrow>`;
        if (env === 'Vmatrix') return `<mrow><mo stretchy="true">‖</mo>${table}<mo stretchy="true">‖</mo></mrow>`;
        if (env === 'cases' || env === 'dcases') return `<mrow><mo stretchy="true">{</mo>${table}</mrow>`;
        if (env === 'rcases') return `<mrow>${table}<mo stretchy="true">}</mo></mrow>`;
        return table;
      }
      if (Object.hasOwn(SPACES, cmd)) return `<mspace width="${SPACES[cmd]}"/>`;
      if (Object.hasOwn(DELIMS, cmd)) return DELIMS[cmd] ? `<mo>${escXml(DELIMS[cmd])}</mo>` : '<mrow></mrow>';
      if (Object.hasOwn(NAMED_FUNCS, cmd)) {
        return { markup: `<mi mathvariant="normal">${escXml(NAMED_FUNCS[cmd])}</mi>`, bigOp: UNDEROVER_OPS.has(cmd) };
      }
      if (Object.hasOwn(SYMBOLS, cmd)) {
        const sym = SYMBOLS[cmd];
        const isTopBot = cmd === 'top' || cmd === 'bot';
        const isOp = !isTopBot && (UNDEROVER_OPS.has(cmd) || OPERATOR_SYMBOLS.has(sym));
        const markup = isTopBot
          ? `<mi mathvariant="normal">${escXml(sym)}</mi>`
          : isOp
            ? `<mo>${escXml(sym)}</mo>`
            : `<mi>${escXml(sym)}</mi>`;
        return { markup, bigOp: UNDEROVER_OPS.has(cmd) };
      }
      return `<mi>${escXml(cmd)}</mi>`;
    }

    if (/\d/.test(ch)) {
      let num = '';
      while (i < n && /[\d.]/.test(src[i])) num += src[i++];
      return `<mn>${escXml(num)}</mn>`;
    }
    if (/[A-Za-z]/.test(ch)) {
      i++;
      return `<mi>${escXml(ch)}</mi>`;
    }
    i++;
    if (ch === '-') return '<mo>−</mo>';
    if (ch === '\'') return '<mo>′</mo>';
    return `<mo>${escXml(ch)}</mo>`;
  }

  function parseScripted(stopChar = '') {
    const rawBase = parseAtom(stopChar);
    if (!rawBase) return null;
    const baseObj = typeof rawBase === 'object' ? rawBase : null;
    const base = baseObj ? baseObj.markup : rawBase;
    let limitMode = baseObj?.forceLimits ? 'limits' : (baseObj?.bigOp && displayMode ? 'limits' : 'scripts');

    let sub = null;
    let sup = null;
    while (true) {
      skipWs();
      if (src.startsWith('\\limits', i) && !/[A-Za-z]/.test(src[i + 7] || '')) {
        i += 7;
        limitMode = 'limits';
        continue;
      }
      if (src.startsWith('\\nolimits', i) && !/[A-Za-z]/.test(src[i + 9] || '')) {
        i += 9;
        limitMode = 'scripts';
        continue;
      }
      if (src[i] === '_') {
        i++;
        const nextSub = unwrapItem(parseAtom(stopChar));
        sub = sub ? `<mrow>${sub}${nextSub}</mrow>` : nextSub;
      } else if (src[i] === '^') {
        i++;
        const nextSup = unwrapItem(parseAtom(stopChar));
        sup = sup ? `<mrow>${sup}${nextSup}</mrow>` : nextSup;
      } else if (src[i] === '\'') {
        let count = 0;
        while (i < n && src[i] === '\'') { count++; i++; }
        const primes = `<mo>${'′'.repeat(count)}</mo>`;
        sup = sup ? `<mrow>${sup}${primes}</mrow>` : primes;
      } else {
        break;
      }
    }
    const hasSubstack = Boolean((sub && sub.includes('sh-substack')) || (sup && sup.includes('sh-substack')));
    const useUnderOver = limitMode === 'limits' || Boolean(baseObj?.bigOp && hasSubstack);
    if (sub && sup) return useUnderOver ? `<munderover>${base}${sub}${sup}</munderover>` : `<msubsup>${base}${sub}${sup}</msubsup>`;
    if (sub) return useUnderOver ? `<munder>${base}${sub}</munder>` : `<msub>${base}${sub}</msub>`;
    if (sup) return useUnderOver ? `<mover>${base}${sup}</mover>` : `<msup>${base}${sup}</msup>`;
    return base;
  }

  function parseRow(stopChar = '', stopOnRight = false) {
    const out = [];
    while (i < n) {
      skipWs();
      if (i >= n || (stopChar && src[i] === stopChar)) break;
      if (stopOnRight && src.startsWith('\\right', i) && !/[A-Za-z]/.test(src[i + 6] || '')) break;
      if (src.startsWith('\\choose', i) && !/[A-Za-z]/.test(src[i + 7] || '')) {
        i += 7;
        const top = wrapRow(out.splice(0, out.length));
        const bot = wrapRow(parseRow(stopChar, stopOnRight));
        return [`<mrow><mo stretchy="true">(</mo><mfrac linethickness="0">${top}${bot}</mfrac><mo stretchy="true">)</mo></mrow>`];
      }
      const item = parseScripted(stopChar);
      if (item === null) break;
      out.push(item);
    }
    return out;
  }

  return wrapRow(parseRow('', false));
}

export function renderTexToMathMl(tex, displayMode = false) {
  const clean = String(tex ?? '').replace(XML_ILLEGAL_CTRL_RE, '').trim();
  if (!clean) return null;
  const disp = displayMode ? ' display="block"' : '';
  try {
    const body = parseLatexToMathMlBody(clean, displayMode, 0);
    return `<math xmlns="http://www.w3.org/1998/Math/MathML"${disp}>${body}</math>`;
  } catch {
    return `<math xmlns="http://www.w3.org/1998/Math/MathML"${disp}><mtext>${escXml(clean)}</mtext></math>`;
  }
}

export const latexToMathML = renderTexToMathMl;
export const latexToMathMl = renderTexToMathMl;

/** Replace $...$ and $$...$$ in prose fields with `@@SHM_<index>@@` tokens and populate `_math`. */
export function compileMathInLesson(lesson) {
  const clone = structuredClone(lesson);
  const table = Array.isArray(clone._math) ? [...clone._math] : [];
  const byKey = new Map(table.map((entry, idx) => [`${entry.display ? 'D' : 'I'}:${entry.tex}`, idx]));

  const internFormula = (rawTex, display, whole) => {
    const tex = String(rawTex ?? '').trim();
    if (!tex) return whole;
    if (!display && (/^\d+(?:[.,]\d+)*$/.test(tex) || /^\d+(?:[.,]\d+)*\s+[A-Za-z(]/.test(tex))) return whole;
    const cacheKey = `${display ? 'D' : 'I'}:${tex}`;
    let index = byKey.get(cacheKey);
    if (index === undefined) {
      const mathml = renderTexToMathMl(tex, display);
      if (!mathml) return whole;
      index = table.length;
      table.push({ tex, display, mathml });
      byKey.set(cacheKey, index);
    }
    return `@@SHM_${index}@@`;
  };

  const replaceString = value => {
    if (typeof value !== 'string' || !value.includes('$')) return value;
    const afterDisplay = value.replace(DISPLAY_FORMULA_PATTERN, (whole, blockTex) => internFormula(blockTex, true, whole));
    return afterDisplay.replace(INLINE_FORMULA_OR_CURRENCY_PATTERN, (whole, inlineTex) => (
      inlineTex === undefined ? whole : internFormula(inlineTex, false, whole)
    ));
  };

  function visit(node, parentKey = '') {
    if (typeof node === 'string') {
      return RAW_SOURCE_KEYS.has(parentKey) ? node : replaceString(node);
    }
    if (Array.isArray(node)) return node.map(item => visit(item, parentKey));
    if (node && typeof node === 'object') {
      if (parentKey === 'experiments' || parentKey === '_math' || parentKey === 'values') return node;
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (parentKey === 'terms') {
          out[k] = typeof v === 'string' ? replaceString(v) : visit(v, k);
        } else {
          out[k] = visit(v, k);
        }
      }
      return out;
    }
    return node;
  }

  const transformed = visit(clone, '');
  if (table.length) transformed._math = table;
  return transformed;
}
