/* Pure JS Office Math Markup Language (OMML, ECMA-376 Part 1 §22.1) to standard LaTeX.
   Ported in zero-dependency JS inspired by MIT officeParser and BSD Mammoth.js.
   Uses namespace-normalized element/attribute accessors from `./xml.js` so both
   Transitional and Strict OOXML Word (.docx) and PowerPoint (.pptx) equations work
   identically without silent loss of STEM formulas. */

import { attr, canonicalTag, element, elements, textContent } from './xml.js';

const MATH_SYMBOLS = Object.freeze({
  'α': '\\alpha', 'β': '\\beta', 'γ': '\\gamma', 'δ': '\\delta',
  'ε': '\\varepsilon', 'ϵ': '\\epsilon', 'ζ': '\\zeta', 'η': '\\eta',
  'θ': '\\theta', 'ϑ': '\\vartheta', 'ι': '\\iota', 'κ': '\\kappa',
  'λ': '\\lambda', 'μ': '\\mu', 'ν': '\\nu', 'ξ': '\\xi',
  'π': '\\pi', 'ϖ': '\\varpi', 'ρ': '\\rho', 'ϱ': '\\varrho',
  'σ': '\\sigma', 'ς': '\\varsigma', 'τ': '\\tau', 'υ': '\\upsilon',
  'φ': '\\varphi', 'ϕ': '\\phi', 'χ': '\\chi', 'ψ': '\\psi', 'ω': '\\omega',
  'Γ': '\\Gamma', 'Δ': '\\Delta', 'Θ': '\\Theta', 'Λ': '\\Lambda',
  'Ξ': '\\Xi', 'Π': '\\Pi', 'Σ': '\\Sigma', 'Υ': '\\Upsilon',
  'Φ': '\\Phi', 'Ψ': '\\Psi', 'Ω': '\\Omega',
  '∞': '\\infty', '±': '\\pm', '∓': '\\mp', '×': '\\times', '÷': '\\div',
  '·': '\\cdot', '⋅': '\\cdot', '∘': '\\circ', '∗': '\\ast',
  '≤': '\\le', '≥': '\\ge', '≠': '\\ne', '≈': '\\approx', '≡': '\\equiv',
  '∼': '\\sim', '≃': '\\simeq', '≅': '\\cong', '∝': '\\propto',
  '≪': '\\ll', '≫': '\\gg',
  '∈': '\\in', '∉': '\\notin', '∋': '\\ni', '⊂': '\\subset', '⊃': '\\supset',
  '⊆': '\\subseteq', '⊇': '\\supseteq', '∪': '\\cup', '∩': '\\cap', '∅': '\\emptyset',
  '∀': '\\forall', '∃': '\\exists', '¬': '\\neg', '∧': '\\land', '∨': '\\lor',
  '∂': '\\partial', '∇': '\\nabla', 'ℏ': '\\hbar', 'ℓ': '\\ell', '℘': '\\wp',
  'ℝ': '\\mathbb{R}', 'ℕ': '\\mathbb{N}', 'ℤ': '\\mathbb{Z}', 'ℚ': '\\mathbb{Q}', 'ℂ': '\\mathbb{C}',
  '→': '\\to', '←': '\\leftarrow', '↔': '\\leftrightarrow',
  '⇒': '\\Rightarrow', '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow', '↦': '\\mapsto',
  '∑': '\\sum', '∏': '\\prod', '∐': '\\coprod',
  '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '∮': '\\oint',
  '⋃': '\\bigcup', '⋂': '\\bigcap', '⋁': '\\bigvee', '⋀': '\\bigwedge',
  '√': '\\sqrt', '°': '^\\circ', '′': "'", '″': "''",
  '−': '-', '–': '-', '…': '\\ldots', '⋯': '\\cdots', '⋮': '\\vdots', '⋱': '\\ddots',
  '⊥': '\\perp', '∥': '\\parallel', '∠': '\\angle', '△': '\\triangle',
  '⟨': '\\langle', '⟩': '\\rangle', '〈': '\\langle', '〉': '\\rangle',
  '⌈': '\\lceil', '⌉': '\\rceil', '⌊': '\\lfloor', '⌋': '\\rfloor',
});

const NARY_OPS = Object.freeze({
  '∫': '\\int',
  '∬': '\\iint',
  '∭': '\\iiint',
  '∮': '\\oint',
  '∑': '\\sum',
  '∏': '\\prod',
  '∐': '\\coprod',
  '⋃': '\\bigcup',
  '⋂': '\\bigcap',
  '⋁': '\\bigvee',
  '⋀': '\\bigwedge',
  '⨁': '\\bigoplus',
  '⨂': '\\bigotimes',
});

const KNOWN_FUNCS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc',
  'sinh', 'cosh', 'tanh', 'coth',
  'arcsin', 'arccos', 'arctan',
  'log', 'ln', 'lg', 'exp',
  'lim', 'limsup', 'liminf', 'max', 'min', 'sup', 'inf',
  'det', 'dim', 'gcd', 'lcm', 'arg', 'deg', 'ker', 'hom', 'Pr', 'mod',
]);

const ACCENT_COMMANDS = Object.freeze({
  '\u0302': '\\hat', '^': '\\hat', 'ˆ': '\\hat',
  '\u0304': '\\bar', '\u0305': '\\bar', '¯': '\\bar', '_': '\\bar',
  '\u20d7': '\\vec', '→': '\\vec',
  '\u0303': '\\tilde', '~': '\\tilde', '˜': '\\tilde',
  '\u0307': '\\dot', '˙': '\\dot',
  '\u0308': '\\ddot', '¨': '\\ddot',
  '\u0301': '\\acute', '\u0300': '\\grave', '\u0306': '\\breve', '\u030c': '\\check',
});

const DELIM_MAP = Object.freeze({
  '': '.',
  '(': '(',
  ')': ')',
  '[': '[',
  ']': ']',
  '{': '\\{',
  '}': '\\}',
  '|': '|',
  '‖': '\\|',
  '⟨': '\\langle',
  '⟩': '\\rangle',
  '〈': '\\langle',
  '〉': '\\rangle',
  '⌈': '\\lceil',
  '⌉': '\\rceil',
  '⌊': '\\lfloor',
  '⌋': '\\rfloor',
});

const mVal = node => attr(node, 'm:val');
const isOn = node => {
  if (!node) return false;
  const v = mVal(node);
  return v === undefined || v === '1' || v === 'true' || v === 'on';
};

/** Join two LaTeX fragments cleanly, inserting a space when a `\command` would otherwise fuse into a following ASCII letter. */
function joinLatex(left, right) {
  if (!left) return right;
  if (!right) return left;
  if (/\\[A-Za-z]+$/.test(left) && /^[A-Za-z]/.test(right)) return `${left} ${right}`;
  return `${left}${right}`;
}

function escapeTextLatex(raw) {
  return raw.replace(/([\\{}#$%&_])/g, '\\$1');
}

function convertMathText(raw, { normalText = false } = {}) {
  const str = String(raw ?? '');
  if (!str) return '';
  if (normalText && /[\p{Script=Han}\s]{1,}|^[A-Za-z]{2,}(?:\s+[A-Za-z]+)*$/u.test(str.trim())) {
    return `\\text{${escapeTextLatex(str)}}`;
  }
  let out = '';
  for (const ch of str) {
    if (Object.hasOwn(MATH_SYMBOLS, ch)) {
      out = joinLatex(out, MATH_SYMBOLS[ch]);
    } else if (ch === '{' || ch === '}') {
      out = joinLatex(out, `\\${ch}`);
    } else {
      out = joinLatex(out, ch);
    }
  }
  return out;
}

function wrapBase(base) {
  const trimmed = base.trim();
  if (!trimmed) return '{}';
  if (/^(?:[A-Za-z0-9]|\\[A-Za-z]+|\{[^{}]*\})$/.test(trimmed)) return trimmed;
  return `{${trimmed}}`;
}

function renderChildren(node) {
  let out = '';
  for (const child of elements(node)) {
    const part = renderNode(child);
    if (part) out = joinLatex(out, part);
  }
  return out.trim();
}

function renderRun(node) {
  const rPr = element(node, 'm:rPr');
  const normalText = isOn(element(rPr, 'm:nor'));
  let out = '';
  for (const child of elements(node)) {
    const tag = canonicalTag(child);
    if (tag === 'm:t' || tag === 'w:t' || tag === 'a:t') {
      out = joinLatex(out, convertMathText(textContent(child), { normalText }));
    } else if (tag === 'mc:AlternateContent') {
      out = joinLatex(out, renderAlternate(child));
    }
  }
  return out;
}

function renderFraction(node) {
  const fPr = element(node, 'm:fPr');
  const type = mVal(element(fPr, 'm:type')) || 'bar';
  const num = renderChildren(element(node, 'm:num'));
  const den = renderChildren(element(node, 'm:den'));
  if (type === 'lin') return `${wrapBase(num)}/${wrapBase(den)}`;
  if (type === 'noBar') return `\\binom{${num}}{${den}}`;
  return `\\frac{${num}}{${den}}`;
}

function renderSup(node) {
  const base = wrapBase(renderChildren(element(node, 'm:e')));
  const sup = renderChildren(element(node, 'm:sup'));
  return sup ? `${base}^{${sup}}` : base;
}

function renderSub(node) {
  const base = wrapBase(renderChildren(element(node, 'm:e')));
  const sub = renderChildren(element(node, 'm:sub'));
  return sub ? `${base}_{${sub}}` : base;
}

function renderSubSup(node) {
  const base = wrapBase(renderChildren(element(node, 'm:e')));
  const sub = renderChildren(element(node, 'm:sub'));
  const sup = renderChildren(element(node, 'm:sup'));
  return `${base}${sub ? `_{${sub}}` : ''}${sup ? `^{${sup}}` : ''}`;
}

function renderPreScript(node) {
  const sub = renderChildren(element(node, 'm:sub'));
  const sup = renderChildren(element(node, 'm:sup'));
  const base = renderChildren(element(node, 'm:e'));
  return `{}${sub ? `_{${sub}}` : ''}${sup ? `^{${sup}}` : ''}${base}`;
}

function renderRadical(node) {
  const radPr = element(node, 'm:radPr');
  const degHide = isOn(element(radPr, 'm:degHide'));
  const deg = degHide ? '' : renderChildren(element(node, 'm:deg'));
  const body = renderChildren(element(node, 'm:e'));
  return deg ? `\\sqrt[${deg}]{${body}}` : `\\sqrt{${body}}`;
}

function renderNary(node) {
  const naryPr = element(node, 'm:naryPr');
  const chrNode = element(naryPr, 'm:chr');
  const rawChr = chrNode ? mVal(chrNode) : undefined;
  // ECMA-376 §22.1.2.70: when m:chr is omitted on m:nary, the default n-ary operator is the integral sign ∫.
  const chr = rawChr || '∫';
  const op = Object.hasOwn(NARY_OPS, chr) ? NARY_OPS[chr] : convertMathText(chr);
  const sub = isOn(element(naryPr, 'm:subHide')) ? '' : renderChildren(element(node, 'm:sub'));
  const sup = isOn(element(naryPr, 'm:supHide')) ? '' : renderChildren(element(node, 'm:sup'));
  const body = renderChildren(element(node, 'm:e'));
  const head = `${op}${sub ? `_{${sub}}` : ''}${sup ? `^{${sup}}` : ''}`;
  return body ? joinLatex(head, body) : head;
}

function renderMatrixRows(matrixNode) {
  const rows = [];
  for (const row of elements(matrixNode, 'm:mr')) {
    const cells = elements(row, 'm:e').map(cell => renderChildren(cell));
    rows.push(cells.join(' & '));
  }
  return rows.join(' \\\\ ');
}

function renderMatrix(node, env = 'matrix') {
  const body = renderMatrixRows(node);
  return body ? `\\begin{${env}} ${body} \\end{${env}}` : '';
}

function mapDelimiter(raw, fallback) {
  const value = raw === undefined ? fallback : raw;
  if (Object.hasOwn(DELIM_MAP, value)) return DELIM_MAP[value];
  return convertMathText(value) || '.';
}

function renderDelimiter(node) {
  const dPr = element(node, 'm:dPr');
  const begNode = element(dPr, 'm:begChr');
  const endNode = element(dPr, 'm:endChr');
  const sepNode = element(dPr, 'm:sepChr');
  const rawBeg = begNode ? (mVal(begNode) ?? '') : '(';
  const rawEnd = endNode ? (mVal(endNode) ?? '') : ')';
  const rawSep = sepNode ? (mVal(sepNode) ?? '|') : '|';
  const items = elements(node, 'm:e');

  // Idiomatic matrix/cases environments when a delimiter directly wraps a single m:m.
  if (items.length === 1) {
    const innerEls = elements(items[0]);
    if (innerEls.length === 1 && canonicalTag(innerEls[0]) === 'm:m') {
      if (rawBeg === '(' && rawEnd === ')') return renderMatrix(innerEls[0], 'pmatrix');
      if (rawBeg === '[' && rawEnd === ']') return renderMatrix(innerEls[0], 'bmatrix');
      if (rawBeg === '|' && rawEnd === '|') return renderMatrix(innerEls[0], 'vmatrix');
      if (rawBeg === '{' && rawEnd === '}') return renderMatrix(innerEls[0], 'Bmatrix');
      if (rawBeg === '{' && rawEnd === '') return renderMatrix(innerEls[0], 'cases');
    }
  }

  const sep = rawSep ? ` ${convertMathText(rawSep)} ` : ' ';
  const inner = items.map(item => renderChildren(item)).join(sep);
  const left = mapDelimiter(rawBeg, '(');
  const right = mapDelimiter(rawEnd, ')');
  return `\\left${left} ${inner} \\right${right}`.replace(/\s+/g, ' ').trim();
}

function renderFunction(node) {
  const rawName = renderChildren(element(node, 'm:fName')).trim();
  const body = renderChildren(element(node, 'm:e'));
  const fn = KNOWN_FUNCS.has(rawName) ? `\\${rawName}` : rawName;
  return body ? joinLatex(fn, body) : fn;
}

function renderLimLow(node) {
  const base = renderChildren(element(node, 'm:e')).trim();
  const lim = renderChildren(element(node, 'm:lim'));
  const fn = KNOWN_FUNCS.has(base) ? `\\${base}` : base;
  if (!lim) return fn;
  if (KNOWN_FUNCS.has(base) || /^\\(?:lim|max|min|sup|inf|sum|prod|bigcup|bigcap)\b/.test(fn)) {
    return `${fn}_{${lim}}`;
  }
  return `\\underset{${lim}}{${fn}}`;
}

function renderLimUpp(node) {
  const base = renderChildren(element(node, 'm:e')).trim();
  const lim = renderChildren(element(node, 'm:lim'));
  return lim ? `\\overset{${lim}}{${base}}` : base;
}

function renderAccent(node) {
  const accPr = element(node, 'm:accPr');
  const chr = mVal(element(accPr, 'm:chr')) || '\u0302';
  const cmd = Object.hasOwn(ACCENT_COMMANDS, chr) ? ACCENT_COMMANDS[chr] : '\\hat';
  const body = renderChildren(element(node, 'm:e'));
  return body ? `${cmd}{${body}}` : '';
}

function renderBar(node) {
  const barPr = element(node, 'm:barPr');
  const pos = mVal(element(barPr, 'm:pos')) || 'top';
  const body = renderChildren(element(node, 'm:e'));
  if (!body) return '';
  return pos === 'bot' ? `\\underline{${body}}` : `\\overline{${body}}`;
}

function renderGroupChr(node) {
  const pr = element(node, 'm:groupChrPr');
  const chr = mVal(element(pr, 'm:chr')) || '⏟';
  const pos = mVal(element(pr, 'm:pos')) || 'bot';
  const body = renderChildren(element(node, 'm:e'));
  if (!body) return '';
  if (chr === '⏞' || pos === 'top') return `\\overbrace{${body}}`;
  return `\\underbrace{${body}}`;
}

function renderEqArr(node) {
  const rows = elements(node, 'm:e').map(row => renderChildren(row)).filter(Boolean);
  if (!rows.length) return '';
  if (rows.length === 1) return rows[0];
  return `\\begin{aligned} ${rows.join(' \\\\ ')} \\end{aligned}`;
}

function renderAlternate(node) {
  const choice = element(node, 'mc:Choice');
  const fromChoice = choice ? renderChildren(choice) : '';
  if (fromChoice) return fromChoice;
  const fallback = element(node, 'mc:Fallback');
  return fallback ? renderChildren(fallback) : '';
}

function renderNode(node) {
  if (!node || typeof node === 'string') return '';
  switch (canonicalTag(node)) {
    case 'm:oMathPara': {
      const maths = elements(node, 'm:oMath').map(item => renderChildren(item)).filter(Boolean);
      return maths.length ? maths.join(' \\\\ ') : renderChildren(node);
    }
    case 'm:oMath':
    case 'm:e':
    case 'm:num':
    case 'm:den':
    case 'm:sup':
    case 'm:sub':
    case 'm:deg':
    case 'm:lim':
    case 'm:fName':
      return renderChildren(node);
    case 'm:r':
      return renderRun(node);
    case 'm:t':
    case 'w:t':
    case 'a:t':
      return convertMathText(textContent(node));
    case 'w:r':
    case 'a:r':
      return renderRun(node);
    case 'm:f':
      return renderFraction(node);
    case 'm:sSup':
      return renderSup(node);
    case 'm:sSub':
      return renderSub(node);
    case 'm:sSubSup':
      return renderSubSup(node);
    case 'm:sPre':
      return renderPreScript(node);
    case 'm:rad':
      return renderRadical(node);
    case 'm:nary':
      return renderNary(node);
    case 'm:d':
      return renderDelimiter(node);
    case 'm:m':
      return renderMatrix(node);
    case 'm:func':
      return renderFunction(node);
    case 'm:limLow':
      return renderLimLow(node);
    case 'm:limUpp':
      return renderLimUpp(node);
    case 'm:acc':
      return renderAccent(node);
    case 'm:bar':
      return renderBar(node);
    case 'm:groupChr':
      return renderGroupChr(node);
    case 'm:eqArr':
      return renderEqArr(node);
    case 'm:box':
    case 'm:borderBox':
    case 'm:phant':
      return renderChildren(element(node, 'm:e') || node);
    case 'mc:AlternateContent':
      return renderAlternate(node);
    default:
      return '';
  }
}

/** Convert an `m:oMath` or `m:oMathPara` XML node into raw LaTeX (without `$` delimiters). */
export function ommlToLatex(node) {
  if (!node) return '';
  return renderNode(node).replace(/[ \t]+/g, ' ').trim();
}

/** Format an `m:oMath` (`$...$`) or `m:oMathPara` (`$$...$$`) XML node as Markdown LaTeX. */
export function formatOmml(node, { display } = {}) {
  const latex = ommlToLatex(node);
  if (!latex) return '';
  const isBlock = display ?? canonicalTag(node) === 'm:oMathPara';
  return isBlock ? `$$${latex}$$` : `$${latex}$`;
}
