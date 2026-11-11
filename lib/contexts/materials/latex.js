/* Pure LaTeX (.tex / .ltx / .latex) projection for StudyHub materials.
   Strips comments and preamble noise, expands simple user math macros so KaTeX and the reader
   can draw formulas without preamble context, preserves verbatim code and math spans, and maps
   document structure (sections, Beamer frames, theorems, lists, tables) into clean readable text. */
import { markdownTable, meaningfulTitle } from '../../office/markdown.js';

const MATH_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'gather', 'gather*',
  'aligned', 'gathered', 'cases', 'array', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix',
]);

const SECTION_RANKS = {
  part: 1, chapter: 2, section: 3, subsection: 4, subsubsection: 5, paragraph: 6, subparagraph: 7,
};

const DEFAULT_THEOREMS = new Map([
  ['theorem', 'Theorem'], ['thm', 'Theorem'], ['lemma', 'Lemma'], ['lem', 'Lemma'],
  ['proposition', 'Proposition'], ['prop', 'Proposition'], ['corollary', 'Corollary'], ['cor', 'Corollary'],
  ['definition', 'Definition'], ['def', 'Definition'], ['defn', 'Definition'],
  ['example', 'Example'], ['ex', 'Example'], ['remark', 'Remark'], ['rem', 'Remark'], ['note', 'Note'],
  ['claim', 'Claim'], ['assumption', 'Assumption'], ['conjecture', 'Conjecture'], ['axiom', 'Axiom'],
  ['exercise', 'Exercise'], ['problem', 'Problem'], ['solution', 'Solution'], ['proof', 'Proof'],
]);

const PROTECTED_MACROS = new Set([
  'begin', 'end', 'section', 'subsection', 'subsubsection', 'chapter', 'part', 'paragraph', 'subparagraph',
  'item', 'label', 'ref', 'eqref', 'cite', 'frac', 'dfrac', 'tfrac', 'sqrt', 'sum', 'prod', 'int', 'lim',
  'left', 'right', 'text', 'textbf', 'textit', 'textrm', 'mathrm', 'mathbf', 'mathbb', 'mathcal', 'mathfrak',
  'operatorname', 'hat', 'tilde', 'bar', 'vec', 'dot', 'ddot', 'overline', 'underline',
]);

const DROP_COMMANDS_1 = new Set([
  'documentclass', 'usepackage', 'RequirePackage', 'bibliographystyle', 'bibliography', 'addbibresource',
  'geometry', 'hypersetup', 'usetikzlibrary', 'pagestyle', 'thispagestyle', 'pagenumbering',
  'label', 'index', 'vspace', 'hspace', 'phantom', 'vphantom', 'hphantom', 'color',
]);

const DROP_COMMANDS_2 = new Set(['setlength', 'addtolength', 'setcounter', 'addtocounter']);

const DROP_BARE = new Set([
  'maketitle', 'tableofcontents', 'listoffigures', 'listoftables', 'newpage', 'clearpage', 'cleardoublepage',
  'pagebreak', 'vfill', 'hfill', 'hrule', 'noindent', 'centering', 'raggedright', 'raggedleft', 'pause',
  'qed', 'qedhere', 'small', 'footnotesize', 'scriptsize', 'tiny', 'large', 'Large', 'LARGE', 'huge', 'Huge',
  'normalsize', 'bf', 'it', 'rm', 'sc', 'sf', 'sl', 'tt', 'allowdisplaybreaks', 'frontmatter', 'mainmatter', 'backmatter',
]);

const UNWRAP_INLINE = new Set([
  'textbf', 'textit', 'emph', 'underline', 'textrm', 'textsf', 'textsc', 'textnormal', 'textup', 'textsl',
  'mbox', 'hbox', 'fbox', 'framebox', 'only', 'uncover', 'visible', 'onslide', 'alert', 'structure',
]);

const isEscaped = (text, index) => {
  let backslashes = 0;
  for (let pos = index - 1; pos >= 0 && text[pos] === '\\'; pos -= 1) backslashes += 1;
  return backslashes % 2 === 1;
};

const skipSpaces = (text, pos, allowSingleNewline = true) => {
  let i = pos, newlines = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') i += 1;
    else if (allowSingleNewline && ch === '\n' && newlines === 0) { newlines += 1; i += 1; }
    else break;
  }
  return i;
};

const skipOverlay = (text, pos) => {
  if (text[pos] !== '<') return pos;
  const hit = /^<[0-9A-Za-z@|+\-,.: ]{1,40}>/.exec(text.slice(pos, pos + 42));
  return hit ? pos + hit[0].length : pos;
};

function readBalanced(text, pos, open, close) {
  if (text[pos] !== open) return null;
  let depth = 1, i = pos + 1;
  while (i < text.length && depth > 0) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === open) depth += 1;
    else if (text[i] === close) depth -= 1;
    i += 1;
  }
  return depth === 0 ? { body: text.slice(pos + 1, i - 1), end: i } : null;
}

const readBraced = (text, pos) => readBalanced(text, pos, '{', '}');

function readBracketed(text, pos) {
  if (text[pos] !== '[') return null;
  let brackets = 1, braces = 0, i = pos + 1;
  while (i < text.length && brackets > 0) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '{') braces += 1;
    else if (text[i] === '}' && braces > 0) braces -= 1;
    else if (braces === 0 && text[i] === '[') brackets += 1;
    else if (braces === 0 && text[i] === ']') brackets -= 1;
    i += 1;
  }
  return brackets === 0 ? { body: text.slice(pos + 1, i - 1), end: i } : null;
}

function shieldVerbatims(source) {
  const verbatims = [];
  const token = (value, block) => {
    const id = `\u0000V${verbatims.length}\u0000`;
    verbatims.push(value);
    return block ? `\n\n${id}\n\n` : id;
  };
  let out = '', i = 0;
  while (i < source.length) {
    if (source[i] === '\\' && !isEscaped(source, i)) {
      const env = /^\\begin\{(verbatim\*?|lstlisting|minted)\}/.exec(source.slice(i, i + 28));
      if (env) {
        const name = env[1], closer = `\\end{${name}}`;
        let start = i + env[0].length, lang = '';
        if (name === 'lstlisting' || name === 'minted') {
          const opt = readBracketed(source, skipSpaces(source, start, false));
          if (opt) start = opt.end;
          if (name === 'minted') {
            const arg = readBraced(source, skipSpaces(source, start, false));
            if (arg) { lang = arg.body.trim(); start = arg.end; }
          }
        }
        const end = source.indexOf(closer, start);
        if (end >= 0) {
          const inner = source.slice(start, end).replace(/^\n/, '').replace(/\n$/, '');
          out += token(`\`\`\`${lang}\n${inner}\n\`\`\``, true);
          i = end + closer.length;
          continue;
        }
      }
      const verb = /^\\verb\*?([^\sA-Za-z])/.exec(source.slice(i, i + 8));
      if (verb) {
        const delim = verb[1], start = i + verb[0].length, end = source.indexOf(delim, start);
        if (end >= 0 && !source.slice(start, end).includes('\n')) {
          out += token(`\`${source.slice(start, end)}\``, false);
          i = end + 1;
          continue;
        }
      }
    }
    out += source[i++];
  }
  return { text: out, verbatims };
}

function stripComments(text) {
  const lines = text.split('\n'), kept = [];
  for (const line of lines) {
    let cut = -1;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === '%' && !isEscaped(line, i)) { cut = i; break; }
    }
    if (cut < 0) kept.push(line);
    else if (line.slice(0, cut).trim() !== '') kept.push(line.slice(0, cut).replace(/[ \t]+$/, ''));
  }
  return kept.join('\n');
}

function readMacroTarget(text, pos) {
  const at = skipSpaces(text, pos);
  if (text[at] === '{') {
    const braced = readBraced(text, at);
    const match = braced && /^\\([A-Za-z]+)$/.exec(braced.body.trim());
    return match ? { name: match[1], end: braced.end } : null;
  }
  const bare = /^\\([A-Za-z]+)/.exec(text.slice(at, at + 64));
  return bare ? { name: bare[1], end: at + bare[0].length } : null;
}

const invokesSelf = (name, body) => new RegExp(`\\\\${name}(?![A-Za-z])`).test(body);

function registerMacro(macros, name, args, defaultArg, body) {
  if (!name || PROTECTED_MACROS.has(name) || invokesSelf(name, body)) return;
  macros.set(name, { args, defaultArg, body });
}

function harvestDefinitions(text) {
  const macros = new Map(), theorems = new Map(DEFAULT_THEOREMS);
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '\\' || isEscaped(text, i)) continue;
    const cmd = /^\\(newcommand|renewcommand|providecommand|DeclareMathOperator|def|newtheorem)(\*?)(?![A-Za-z])/.exec(text.slice(i, i + 32));
    if (!cmd) continue;
    const kind = cmd[1], star = cmd[2] === '*';
    let pos = i + cmd[0].length;
    if (kind === 'newtheorem') {
      const env = readBraced(text, skipSpaces(text, pos));
      if (!env) continue;
      pos = skipSpaces(text, env.end);
      const shared = readBracketed(text, pos);
      if (shared) pos = skipSpaces(text, shared.end);
      const label = readBraced(text, pos);
      if (label && env.body.trim()) theorems.set(env.body.trim(), cleanInlineProse(label.body).trim() || env.body.trim());
      i = (label ? label.end : env.end) - 1;
      continue;
    }
    const target = readMacroTarget(text, pos);
    if (!target) continue;
    pos = skipSpaces(text, target.end);
    if (kind === 'DeclareMathOperator') {
      const op = readBraced(text, pos);
      if (op) { registerMacro(macros, target.name, 0, undefined, `\\operatorname${star ? '*' : ''}{${op.body.trim()}}`); i = op.end - 1; }
      continue;
    }
    if (kind === 'def') {
      if (text[pos] === '{') {
        const body = readBraced(text, pos);
        if (body) { registerMacro(macros, target.name, 0, undefined, body.body); i = body.end - 1; }
      }
      continue;
    }
    let args = 0, defaultArg;
    const countOpt = readBracketed(text, pos);
    if (countOpt && /^\d$/.test(countOpt.body.trim())) {
      args = Number(countOpt.body.trim());
      pos = skipSpaces(text, countOpt.end);
      const defOpt = readBracketed(text, pos);
      if (defOpt) { defaultArg = defOpt.body; pos = skipSpaces(text, defOpt.end); }
    }
    const body = readBraced(text, pos);
    if (body) { registerMacro(macros, target.name, args, defaultArg, body.body); i = body.end - 1; }
  }
  return { macros, theorems };
}

function stripCommandWithBrace(text, commandName) {
  const pattern = new RegExp(`\\\\${commandName}\\*?`, 'g');
  let out = '', last = 0, match;
  while ((match = pattern.exec(text)) !== null) {
    const at = match.index;
    if (isEscaped(text, at) || /[A-Za-z]/.test(text[at + match[0].length] || '')) continue;
    let pos = skipSpaces(text, at + match[0].length, false);
    const opt = readBracketed(text, pos);
    if (opt) pos = skipSpaces(text, opt.end, false);
    const arg = readBraced(text, pos);
    if (!arg) continue;
    out += text.slice(last, at);
    last = arg.end;
    pattern.lastIndex = last;
  }
  return out + text.slice(last);
}

function extractTexTitle(text, filename) {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '\\' || isEscaped(text, i) || !/^\\title\*?(?![A-Za-z])/.test(text.slice(i, i + 10))) continue;
    let pos = skipSpaces(text, i + (text[i + 6] === '*' ? 7 : 6));
    const short = readBracketed(text, pos);
    if (short) pos = skipSpaces(text, short.end);
    const full = readBraced(text, pos);
    if (!full) continue;
    const stripped = stripCommandWithBrace(stripCommandWithBrace(full.body, 'thanks'), 'footnote').replace(/\\\\(?:\s*\[[^\]]*\])?/g, ' ');
    return meaningfulTitle(cleanInlineProse(stripped), filename);
  }
  return undefined;
}

function sliceDocumentBody(text) {
  const startMarker = '\\begin{document}', endMarker = '\\end{document}';
  const start = text.indexOf(startMarker);
  if (start < 0) return text;
  const from = start + startMarker.length;
  const end = text.indexOf(endMarker, from);
  return end >= 0 ? text.slice(from, end) : text.slice(from);
}

function readMathArg(text, pos) {
  const at = skipSpaces(text, pos);
  if (at >= text.length) return null;
  if (text[at] === '{') return readBraced(text, at);
  if (text[at] === '\\') {
    const ctrl = /^\\(?:[A-Za-z]+|.)/.exec(text.slice(at, at + 40));
    return ctrl ? { body: ctrl[0], end: at + ctrl[0].length } : null;
  }
  return { body: text[at], end: at + 1 };
}

function expandMathMacrosOnce(source, macros) {
  let out = '', i = 0, changed = false;
  while (i < source.length) {
    if (source[i] === '\\' && !isEscaped(source, i)) {
      const hit = /^\\([A-Za-z]+)/.exec(source.slice(i, i + 48));
      const spec = hit && macros.get(hit[1]);
      if (spec) {
        let pos = i + hit[0].length;
        const values = [];
        let ok = true;
        if (spec.args > 0 && spec.defaultArg !== undefined) {
          const opt = readBracketed(source, skipSpaces(source, pos, false));
          if (opt) { values.push(opt.body); pos = opt.end; }
          else values.push(spec.defaultArg);
        }
        while (values.length < spec.args) {
          const arg = readMathArg(source, pos);
          if (!arg) { ok = false; break; }
          values.push(arg.body);
          pos = arg.end;
        }
        if (ok) {
          out += spec.body.replace(/#([1-9])/g, (_, digit) => values[Number(digit) - 1] ?? '');
          i = pos;
          changed = true;
          continue;
        }
      }
    }
    out += source[i++];
  }
  return { text: out, changed };
}

function expandMathMacros(source, macros) {
  let current = stripCommandWithBrace(source, 'label');
  if (!macros.size) return current;
  for (let pass = 0; pass < 6 && current.length <= 16_384; pass += 1) {
    const next = expandMathMacrosOnce(current, macros);
    current = next.text;
    if (!next.changed) break;
  }
  return current;
}

function normalizeExtraMathEnvs(text) {
  return text
    .replace(/\\begin\{subequations\}([\s\S]*?)\\end\{subequations\}/g, '$1')
    .replace(/\\begin\{displaymath\}([\s\S]*?)\\end\{displaymath\}/g, '\\[$1\\]')
    .replace(/\\begin\{multline\*?\}([\s\S]*?)\\end\{multline\*?\}/g, '\\begin{gather*}$1\\end{gather*}')
    .replace(/\\begin\{flalign\*?\}([\s\S]*?)\\end\{flalign\*?\}/g, '\\begin{align*}$1\\end{align*}')
    .replace(/\\begin\{eqnarray\*?\}([\s\S]*?)\\end\{eqnarray\*?\}/g, (_, inner) => {
      const converted = inner.replace(/&[ \t]*([^&\n\\]*?)[ \t]*&/g, '&$1 ');
      return `\\begin{align*}${converted}\\end{align*}`;
    });
}

function shieldMath(input, macros) {
  const text = normalizeExtraMathEnvs(input), maths = [];
  const push = formula => { const id = `\u0000M${maths.length}\u0000`; maths.push(formula); return id; };
  let out = '', i = 0;
  while (i < text.length) {
    if (text[i] === '\\' && !isEscaped(text, i)) {
      const env = /^\\begin\{([A-Za-z]+\*?)\}/.exec(text.slice(i, i + 32));
      if (env && MATH_ENVS.has(env[1])) {
        const name = env[1], closer = `\\end{${name}}`, start = i + env[0].length, end = text.indexOf(closer, start);
        if (end >= 0) {
          const inner = expandMathMacros(text.slice(start, end), macros);
          out += push(`\\begin{${name}}${inner}\\end{${name}}`);
          i = end + closer.length;
          continue;
        }
      }
      if (text.startsWith('\\[', i) || text.startsWith('\\(', i)) {
        const display = text[i + 1] === '[', closer = display ? '\\]' : '\\)', start = i + 2;
        const end = text.indexOf(closer, start);
        if (end >= 0) {
          const inner = expandMathMacros(text.slice(start, end), macros);
          const body = display ? inner.trim() : inner.replace(/\s+/g, ' ').trim();
          if (body) out += push(display ? `\\[${body}\\]` : `\\(${body}\\)`);
          i = end + 2;
          continue;
        }
      }
    }
    if (text[i] === '$' && !isEscaped(text, i)) {
      const display = text[i + 1] === '$', delim = display ? '$$' : '$', start = i + delim.length;
      let end = text.indexOf(delim, start);
      while (end >= 0 && isEscaped(text, end)) end = text.indexOf(delim, end + delim.length);
      if (end >= 0) {
        const rawInner = text.slice(start, end);
        if (display || !rawInner.includes('\n\n')) {
          const inner = expandMathMacros(rawInner, macros);
          const body = display ? inner.trim() : inner.replace(/\s+/g, ' ').trim();
          if (body) out += push(display ? `$$${body}$$` : `$${body}$`);
          i = end + delim.length;
          continue;
        }
      }
    }
    out += text[i++];
  }
  return { text: out, maths };
}

function stripDeclarations(text) {
  let out = '', i = 0;
  while (i < text.length) {
    if (text[i] === '\\' && !isEscaped(text, i)) {
      const hit = /^\\([A-Za-z]+)(\*?)(?![A-Za-z])/.exec(text.slice(i, i + 40));
      if (hit) {
        const name = hit[1];
        let pos = i + hit[0].length;
        if (name === 'newcommand' || name === 'renewcommand' || name === 'providecommand' || name === 'DeclareMathOperator' || name === 'newtheorem') {
          const target = name === 'newtheorem' ? readBraced(text, skipSpaces(text, pos)) : readMacroTarget(text, pos);
          if (target) {
            pos = skipSpaces(text, target.end);
            for (let k = 0; k < 2; k += 1) { const opt = readBracketed(text, pos); if (opt) pos = skipSpaces(text, opt.end); }
            const body = readBraced(text, pos);
            if (body) { pos = body.end; const trail = readBracketed(text, skipSpaces(text, pos, false)); if (trail) pos = trail.end; i = pos; continue; }
          }
        }
        if (name === 'def') {
          const target = readMacroTarget(text, pos);
          const body = target && readBraced(text, skipSpaces(text, target.end, false));
          if (body) { i = body.end; continue; }
        }
        if (DROP_COMMANDS_1.has(name)) {
          pos = skipOverlay(text, pos);
          const opt = readBracketed(text, skipSpaces(text, pos, false));
          if (opt) pos = opt.end;
          const arg = readBraced(text, skipSpaces(text, pos, false));
          if (arg) { i = arg.end; continue; }
        }
        if (DROP_COMMANDS_2.has(name)) {
          const a1 = readBraced(text, skipSpaces(text, pos, false));
          const a2 = a1 && readBraced(text, skipSpaces(text, a1.end, false));
          if (a2) { i = a2.end; continue; }
        }
        if (DROP_BARE.has(name)) {
          i = skipOverlay(text, pos);
          if (text[i] === ' ') i += 1;
          continue;
        }
      }
    }
    out += text[i++];
  }
  return out;
}

function splitUnescapedAmpersands(row) {
  const cells = [];
  let start = 0;
  for (let i = 0; i < row.length; i += 1) {
    if (row[i] === '&' && !isEscaped(row, i)) { cells.push(row.slice(start, i)); start = i + 1; }
  }
  cells.push(row.slice(start));
  return cells;
}

function convertTabular(rawBody) {
  let body = rawBody.trim();
  const firstBrace = readBraced(body, 0);
  if (firstBrace) {
    body = body.slice(firstBrace.end).trimStart();
    const secondBrace = readBraced(body, 0);
    if (secondBrace && /^[lcrpbmX|@{}\s*\d.]+$/.test(secondBrace.body)) body = body.slice(secondBrace.end);
  }
  body = body
    .replace(/\\(?:toprule|midrule|bottomrule|hline)\b(?:\s*\[[^\]]*\])?/g, '')
    .replace(/\\(?:cline|cmidrule)(?:\([^)]*\))?\{[^}]*\}/g, '');
  const rawRows = body.split(/\\\\(?:\*|\s*\[[^\]]*\])?/);
  const rows = [];
  for (const rawRow of rawRows) {
    const cleanedRow = rawRow
      .replace(/\\multicolumn\{[^}]*\}\{[^}]*\}\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, '$1')
      .replace(/\\multirow\{[^}]*\}\{[^}]*\}\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, '$1')
      .trim();
    if (!cleanedRow) continue;
    const cells = splitUnescapedAmpersands(cleanedRow).map(cell => cleanInlineProse(cell).replace(/\s+/g, ' ').trim());
    if (cells.some(Boolean)) rows.push(cells);
  }
  return rows.length ? `\n\n${markdownTable(rows)}\n\n` : '';
}

function convertList(kind, inner) {
  const items = [];
  let pos = 0, current = null;
  while (pos < inner.length) {
    if (inner[pos] === '\\' && !isEscaped(inner, pos) && /^\\item(?![A-Za-z])/.test(inner.slice(pos, pos + 8))) {
      if (current) items.push(current);
      let after = skipOverlay(inner, pos + 5);
      after = skipSpaces(inner, after, false);
      const opt = readBracketed(inner, after);
      const label = opt ? cleanInlineProse(opt.body).replace(/\s+/g, ' ').trim() : '';
      if (opt) after = opt.end;
      current = { label, text: '' };
      pos = after;
      continue;
    }
    if (current) current.text += inner[pos];
    pos += 1;
  }
  if (current) items.push(current);
  if (!items.length) return cleanInlineProse(inner);
  const lines = items.map((item, idx) => {
    const body = cleanInlineProse(item.text).replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (kind === 'enumerate') return `${idx + 1}. ${item.label ? `${item.label} ` : ''}${body}`.trim();
    if (kind === 'description' || item.label) return `- ${item.label ? `${item.label}: ` : ''}${body}`.trim();
    return `- ${body}`.trim();
  });
  return `\n\n${lines.join('\n')}\n\n`;
}

function convertFrames(text, recordHeading, frameRank) {
  let out = '', i = 0;
  while (i < text.length) {
    if (text[i] === '\\' && !isEscaped(text, i) && text.startsWith('\\begin{frame}', i)) {
      let pos = skipOverlay(text, i + '\\begin{frame}'.length);
      const opt = readBracketed(text, skipSpaces(text, pos, false));
      if (opt) pos = opt.end;
      let title = '', subtitle = '';
      const tArg = readBraced(text, skipSpaces(text, pos, false));
      if (tArg) {
        title = tArg.body; pos = tArg.end;
        const sArg = readBraced(text, skipSpaces(text, pos, false));
        if (sArg) { subtitle = sArg.body; pos = sArg.end; }
      }
      const closer = '\\end{frame}', end = text.indexOf(closer, pos);
      if (end >= 0) {
        let body = text.slice(pos, end);
        body = body.replace(/\\frametitle(?:<[^>]*>)?(?:\[[^\]]*\])?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, (_, t) => { if (!title) title = t; return ''; });
        body = body.replace(/\\framesubtitle(?:<[^>]*>)?(?:\[[^\]]*\])?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, (_, s) => { if (!subtitle) subtitle = s; return ''; });
        const cleanT = cleanInlineProse(title).replace(/\s+/g, ' ').trim();
        const cleanS = cleanInlineProse(subtitle).replace(/\s+/g, ' ').trim();
        const fullTitle = cleanT && cleanS ? `${cleanT} — ${cleanS}` : cleanT || cleanS;
        out += `${fullTitle ? recordHeading(frameRank, fullTitle) : '\n\n'}${body}\n\n`;
        i = end + closer.length;
        continue;
      }
    }
    out += text[i++];
  }
  return out;
}

function replaceInnermostEnvs(text, matcher, replacer) {
  let current = text;
  for (let guard = 0; guard < 24; guard += 1) {
    let changed = false;
    current = current.replace(matcher, (...args) => { changed = true; return replacer(...args); });
    if (!changed) break;
  }
  return current;
}

function transformStructure(input, theorems) {
  const headings = [];
  const recordHeading = (rank, rawTitle) => {
    const title = cleanInlineProse(rawTitle).replace(/\s+/g, ' ').trim();
    if (!title) return '\n\n';
    const id = `\u0000H${headings.length}\u0000`;
    headings.push({ rank, title });
    return `\n\n${id}\n\n`;
  };

  // Detect lowest section rank before frames so Beamer frames nest directly under sections.
  let deepestSectionRank = 0;
  for (const match of input.matchAll(/\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?![A-Za-z])/g)) {
    deepestSectionRank = Math.max(deepestSectionRank, SECTION_RANKS[match[1]] || 0);
  }
  const frameRank = deepestSectionRank > 0 ? deepestSectionRank + 1 : 3;

  let text = convertFrames(input, recordHeading, frameRank);

  // Sectioning commands (\section*[short]{title})
  let sectioned = '', pos = 0;
  while (pos < text.length) {
    if (text[pos] === '\\' && !isEscaped(text, pos)) {
      const hit = /^\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?(?![A-Za-z])/.exec(text.slice(pos, pos + 24));
      if (hit) {
        let after = skipOverlay(text, pos + hit[0].length);
        const short = readBracketed(text, skipSpaces(text, after));
        if (short) after = short.end;
        const full = readBraced(text, skipSpaces(text, after));
        if (full) {
          sectioned += recordHeading(SECTION_RANKS[hit[1]], full.body);
          pos = full.end;
          continue;
        }
      }
    }
    sectioned += text[pos++];
  }
  text = sectioned;

  // Drop tikzpicture coordinate noise while keeping surrounding figure captions
  text = replaceInnermostEnvs(text, /\\begin\{tikzpicture\}(?:\[[^\]]*\])?[\s\S]*?\\end\{tikzpicture\}/g, () => '');

  // Tables
  text = replaceInnermostEnvs(
    text,
    /\\begin\{(tabular\*?|tabularx|longtable)\}(?:\[[^\]]*\])?((?:(?!\\begin\{(?:tabular\*?|tabularx|longtable)\})[\s\S])*?)\\end\{\1\}/g,
    (_, _env, body) => convertTabular(body),
  );

  // Figures & float wrappers: preserve captions and inner content, drop \includegraphics
  text = replaceInnermostEnvs(
    text,
    /\\begin\{(figure\*?|table\*?)\}(?:\[[^\]]*\])?((?:(?!\\begin\{(?:figure\*?|table\*?)\})[\s\S])*?)\\end\{\1\}/g,
    (_, env, body) => {
      const prefix = env.startsWith('table') ? 'Table' : 'Figure';
      const withCaptions = body
        .replace(/\\includegraphics(?:\*|\s*\[[^\]]*\])?\s*\{[^}]*\}/g, '')
        .replace(/\\caption(?:\[[^\]]*\])?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, (__, cap) => `\n\n${prefix}: ${cleanInlineProse(cap).trim()}\n\n`);
      return `\n\n${withCaptions}\n\n`;
    },
  );

  // Lists (innermost first)
  text = replaceInnermostEnvs(
    text,
    /\\begin\{(itemize|enumerate|description)\}(?:\[[^\]]*\])?((?:(?!\\begin\{(?:itemize|enumerate|description)\})[\s\S])*?)\\end\{\1\}/g,
    (_, kind, body) => convertList(kind, body),
  );

  // Theorems, Beamer blocks, abstract, quotes, and remaining custom wrappers
  text = replaceInnermostEnvs(
    text,
    /\\begin\{([A-Za-z]+\*?)\}(?:<[^>]*>)?((?:(?!\\begin\{[A-Za-z]+\*?\})[\s\S])*?)\\end\{\1\}/g,
    (_, rawEnv, rawBody) => {
      const base = rawEnv.replace(/\*$/, '');
      const thmLabel = theorems.get(rawEnv) || theorems.get(base);
      if (thmLabel) {
        let rest = skipSpaces(rawBody, 0);
        const opt = readBracketed(rawBody, rest);
        const name = opt ? cleanInlineProse(opt.body).replace(/\s+/g, ' ').trim() : '';
        const content = (opt ? rawBody.slice(opt.end) : rawBody).trim();
        return `\n\n${thmLabel}${name ? ` (${name})` : ''}. ${content}\n\n`;
      }
      if (base === 'block' || base === 'alertblock' || base === 'exampleblock') {
        const arg = readBraced(rawBody, skipSpaces(rawBody, 0));
        const title = arg ? cleanInlineProse(arg.body).trim() : '';
        const content = (arg ? rawBody.slice(arg.end) : rawBody).trim();
        return `\n\n${title ? `${title}. ` : ''}${content}\n\n`;
      }
      if (base === 'abstract') return `\n\nAbstract. ${rawBody.trim()}\n\n`;
      const opt = readBracketed(rawBody, skipSpaces(rawBody, 0, false));
      return `\n\n${(opt ? rawBody.slice(opt.end) : rawBody).trim()}\n\n`;
    },
  );

  return { text, headings };
}

function unescapeProseChars(text) {
  return text
    .replace(/\\\\(?:\*|\s*\[[^\]]*\])?/g, '\n')
    .replace(/\\par(?![A-Za-z])\s*/g, '\n\n')
    .replace(/\\LaTeX(?![A-Za-z])(?:\{\})?/g, 'LaTeX')
    .replace(/\\TeX(?![A-Za-z])(?:\{\})?/g, 'TeX')
    .replace(/\\(?:ldots|dots)(?![A-Za-z])(?:\{\})?/g, '...')
    .replace(/\\(?:quad|qquad|,|;|:|!| )(?![A-Za-z])/g, ' ')
    .replace(/\\slash(?![A-Za-z])(?:\{\})?/g, '/')
    .replace(/``/g, '"')
    .replace(/''/g, '"')
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/(?<!\\)~/g, ' ')
    .replace(/\\([%&#_{}])/g, '$1')
    .replace(/\\\$(\d)/g, '$$$1')
    .replace(/\\([,.])/g, '$1');
}

function cleanInlineProse(input) {
  let current = input;
  for (let pass = 0; pass < 6; pass += 1) {
    let out = '', i = 0, changed = false;
    while (i < current.length) {
      if (current[i] === '\\' && !isEscaped(current, i)) {
        const hit = /^\\([A-Za-z]+)(\*?)(?![A-Za-z])/.exec(current.slice(i, i + 32));
        if (hit) {
          const name = hit[1];
          let pos = skipOverlay(current, i + hit[0].length);
          if (name === 'href') {
            const url = readBraced(current, skipSpaces(current, pos, false));
            const label = url && readBraced(current, skipSpaces(current, url.end, false));
            if (url && label) {
              const cleanLabel = cleanInlineProse(label.body).trim(), cleanUrl = url.body.trim();
              out += cleanLabel && cleanLabel !== cleanUrl ? `${cleanLabel} (${cleanUrl})` : cleanUrl;
              i = label.end; changed = true; continue;
            }
          }
          if (name === 'url') {
            const url = readBraced(current, skipSpaces(current, pos, false));
            if (url) { out += url.body.trim(); i = url.end; changed = true; continue; }
          }
          if (name === 'eqref') {
            const ref = readBraced(current, skipSpaces(current, pos, false));
            if (ref) { out += `(${ref.body.trim()})`; i = ref.end; changed = true; continue; }
          }
          if (name === 'ref' || name === 'autoref' || name === 'cref' || name === 'Cref' || name === 'pageref') {
            const ref = readBraced(current, skipSpaces(current, pos, false));
            if (ref) { out += `[${ref.body.trim()}]`; i = ref.end; changed = true; continue; }
          }
          if (name === 'cite' || name === 'citep' || name === 'citet' || name === 'parencite' || name === 'textcite' || name === 'autocite') {
            for (let k = 0; k < 2; k += 1) { const opt = readBracketed(current, skipSpaces(current, pos, false)); if (opt) pos = opt.end; }
            const keys = readBraced(current, skipSpaces(current, pos, false));
            if (keys) { out += `[${keys.body.trim()}]`; i = keys.end; changed = true; continue; }
          }
          if (name === 'footnote') {
            const opt = readBracketed(current, pos);
            if (opt) pos = opt.end;
            const note = readBraced(current, skipSpaces(current, pos, false));
            if (note) { out += ` (${cleanInlineProse(note.body).trim()})`; i = note.end; changed = true; continue; }
          }
          if (name === 'textcolor') {
            const color = readBraced(current, skipSpaces(current, pos, false));
            const body = color && readBraced(current, skipSpaces(current, color.end, false));
            if (body) { out += body.body; i = body.end; changed = true; continue; }
          }
          if (name === 'texttt') {
            const code = readBraced(current, skipSpaces(current, pos, false));
            if (code) {
              const plain = unescapeProseChars(code.body);
              out += /[$\\]/.test(plain) ? `\`${plain}\`` : plain;
              i = code.end; changed = true; continue;
            }
          }
          if (UNWRAP_INLINE.has(name)) {
            const opt = readBracketed(current, pos);
            if (opt) pos = opt.end;
            const body = readBraced(current, skipSpaces(current, pos, false));
            if (body) { out += body.body; i = body.end; changed = true; continue; }
          }
          if (DROP_COMMANDS_1.has(name)) {
            const opt = readBracketed(current, skipSpaces(current, pos, false));
            if (opt) pos = opt.end;
            const arg = readBraced(current, skipSpaces(current, pos, false));
            if (arg) { i = arg.end; changed = true; continue; }
          }
          if (DROP_BARE.has(name)) {
            i = pos + (current[pos] === ' ' ? 1 : 0);
            changed = true; continue;
          }
        }
      }
      out += current[i++];
    }
    current = out;
    if (!changed) break;
  }
  // Unwrap bare text groups like "{\em word}" or "{nested}" left after macro cleanup.
  current = current.replace(/\{([^{}\u0000]*)\}/g, '$1');
  return unescapeProseChars(current);
}

/** Extract readable study text and an optional document title from a UTF-8 LaTeX source string. */
export function extractLatex(raw, { filename = '' } = {}) {
  const normalized = String(raw ?? '').replace(/\u0000/g, '').replace(/\r\n?/g, '\n');
  const { text: withoutVerbatim, verbatims } = shieldVerbatims(normalized);
  const uncommented = stripComments(withoutVerbatim);
  const { macros, theorems } = harvestDefinitions(uncommented);
  const title = extractTexTitle(uncommented, filename);
  const bodySlice = stripDeclarations(sliceDocumentBody(uncommented));
  const { text: mathShielded, maths } = shieldMath(bodySlice, macros);
  const { text: structured, headings } = transformStructure(mathShielded, theorems);
  let prose = cleanInlineProse(structured);

  if (headings.length) {
    const minRank = Math.min(...headings.map(h => h.rank));
    prose = prose.replace(/\u0000H(\d+)\u0000/g, (_, idx) => {
      const h = headings[Number(idx)];
      return `${'#'.repeat(Math.min(4, Math.max(1, h.rank - minRank + 1)))} ${h.title}`;
    });
  }
  prose = prose
    .replace(/\u0000M(\d+)\u0000/g, (_, idx) => maths[Number(idx)] ?? '')
    .replace(/\u0000V(\d+)\u0000/g, (_, idx) => verbatims[Number(idx)] ?? '')
    .split('\n')
    .map(line => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text: prose, title };
}
