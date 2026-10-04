import { proseSegments } from './tex-text.js';

/* Chemical formulas, ions and equations a model writes as plain text ("H2SO4", "NH4+", "SO42−"). The study cards render mhchem
 * (ui/study-math-render.js), so `$\ce{H2SO4}$` shows subscripts and charges; plain text does not, and "SO42−" is even ambiguous (SO₄²⁻ or
 * SO₄₂⁻). Pure and dependency-free. Only the unmistakable cases count: every part must be a real element symbol and the token needs a
 * digit, a charge or a second part, so words, product names (A4, MP3, B2B) and version strings stay prose. A digit followed by a sign
 * (SO42-, Fe3+, "SO4 2-") cannot be read with certainty: it is reported but never converted. */

const SYMBOLS = new Set(('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn ' +
  'Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No ' +
  'Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og').split(' '));
/* Valid symbol strings that are far more often something else. */
const NOT_CHEMISTRY = new Set(['B2B', 'B2C', 'C2C', 'O2O', 'P2P', 'Y2K', 'H1N1', 'H5N1', 'H3N2', 'PS2', 'PS3', 'PS4', 'PS5', 'NO1', 'I2C', 'B2G']);
/* A lone element with a digit or a sign is chemistry only for these. */
const ELEMENTAL = new Set(['H2', 'N2', 'O2', 'O3', 'Cl2', 'Br2', 'P4', 'S8']);
const SIMPLE_IONS = new Set(['H+', 'Li+', 'Na+', 'K+', 'Ag+', 'Cl-', 'Br-']);
/* Capitalised English words that are also element symbols: never the loose neighbour of an equation. */
const WORDS = new Set(['He', 'In', 'As', 'At', 'Be', 'No', 'Pa', 'Ho', 'Am', 'Re', 'Co', 'Ne', 'Us', 'Hf', 'Ca', 'Mo']);
const ARROW = '(?:<=>|<->|==>|-->|->|→|⟶|⇌|⇄)';
const ARROW_TEX = { '→': '->', '⟶': '->', '-->': '->', '==>': '->', '⇌': '<=>', '⇄': '<=>' };

const PART = '(?:[A-Z][a-z]?\\d*|\\((?:[A-Z][a-z]?\\d*)+\\)\\d*)';
const CANDIDATE = new RegExp(`(?<![A-Za-z0-9_\\\\^.{}\\-])(\\d{1,2})?((?:${PART})+)`, 'g');
const EXPLICIT_CHARGE = /^\^(?:\{(\d{0,2}[+\-−])\}|(\d{0,2}[+\-−]))/;
const SIGN = /^[+\-−]/;
const SPACED_CHARGE = /^\s\d[+\-−](?![A-Za-z0-9])/;

/** The parts of a formula body, or null when any of them is not an element symbol or a number is too long to be a subscript. */
function parts(body) {
  const found = [];
  for (const match of body.matchAll(/([A-Z][a-z]?)(\d*)|\(([^)]*)\)(\d*)/g)) {
    if (match[1]) found.push({ symbols: [match[1]], digits: match[2] });
    else found.push({ symbols: [...match[3].matchAll(/[A-Z][a-z]?/g)].map(m => m[0]), digits: match[4] });
  }
  if (!found.length || found.some(part => part.symbols.some(symbol => !SYMBOLS.has(symbol)))) return null;
  return found;
}

/** Every candidate formula of one prose segment: `{ start, end, piece, kind: 'strict' | 'weak' | 'ambiguous' }`. Strict has evidence enough on its own
 * (a digit, a charge or two parts); weak is a valid element group without any (Zn, NaCl) and only matters beside a strict one in an equation. */
function candidates(segment) {
  const out = [];
  const word = (text) => /[A-Za-z0-9_]/.test(text || '');
  for (const match of segment.matchAll(CANDIDATE)) {
    const coefficient = match[1] || '';
    let body = match[2], start = match.index + coefficient.length, end = start + body.length, first = match.index;
    // "(H2SO4)" alone is a parenthesis of the prose, not a formula with a group.
    if (/^\([^()]*\)$/.test(body)) { body = body.slice(1, -1); start += 1; end -= 1; first = start; }
    const list = parts(body);
    if (!list) continue;
    const digitRuns = list.map(part => part.digits);
    if (digitRuns.some(run => run.length > 2) || NOT_CHEMISTRY.has(body)) continue;
    const tail = segment.slice(end);
    const hasDigit = digitRuns.some(Boolean), single = list.length === 1 && list[0].symbols.length === 1;
    let charge = '', stop = end, kind = 'weak', explicit = false;
    const caret = EXPLICIT_CHARGE.exec(tail);
    if (caret && !word(segment[end + caret[0].length])) { charge = `^${caret[1] ?? caret[2]}`; stop = end + caret[0].length; explicit = true; kind = 'strict'; }
    else if (SIGN.test(tail) && !/\s/.test(segment[end - 1] || ' ') && !word(segment[end + 1]) && !/[+\-−>=]/.test(segment[end + 1] || '')) {
      // A digit run of two or more before the sign (SO42-), or a lone element with a digit (Fe3+), can be a subscript or a charge.
      const last = digitRuns[digitRuns.length - 1];
      charge = tail[0]; stop = end + 1;
      if (last.length >= 2 || (single && last)) kind = 'ambiguous';
      else kind = single ? (SIMPLE_IONS.has(`${body}${charge === '−' ? '-' : charge}`) ? 'strict' : 'weak') : 'strict';
    } else if (hasDigit && SPACED_CHARGE.test(tail)) { kind = 'ambiguous'; stop = end + SPACED_CHARGE.exec(tail)[0].length; }
    else if (hasDigit) kind = single ? (ELEMENTAL.has(body) ? 'strict' : 'weak') : 'strict';
    if (kind === 'weak') { stop = end; charge = ''; if (WORDS.has(body) || body === 'I') continue; }
    // A letter, digit or "_" glued to the end is a longer word or identifier; "1.5" and a path separator are not chemistry either.
    if (word(segment[stop]) || (segment[stop] === '.' && /\d/.test(segment[stop + 1] || '')) || segment[stop] === '\\') continue;
    out.push({ start: first, end: stop, piece: segment.slice(first, stop), kind, explicit });
  }
  return out;
}

/** mhchem source of one piece: the minus sign is ASCII, a braced charge loses its braces, arrows use mhchem's spelling. */
function ce(piece) {
  let text = piece.replace(/−/g, '-').replace(/\^\{([^}]*)\}/g, '^$1');
  for (const [from, to] of Object.entries(ARROW_TEX)) text = text.split(from).join(to);
  return text;
}

const CONNECTED = new RegExp(`^(?:\\s\\+\\s|\\s?${ARROW}\\s?)$`);

/** Equations: formulas joined by " + " or an arrow become one span, with the plain element groups beside them (Zn, NaCl) as part of it.
 * A group without any strict formula is plain text. Ambiguous pieces never join. */
function chains(list, segment) {
  const usable = list.filter(item => item.kind !== 'ambiguous');
  const spans = [];
  for (let at = 0; at < usable.length;) {
    let to = at;
    while (to + 1 < usable.length && CONNECTED.test(segment.slice(usable[to].end, usable[to + 1].start))) to++;
    const group = usable.slice(at, to + 1);
    if (group.some(item => item.kind === 'strict')) spans.push({ start: group[0].start, end: group[group.length - 1].end });
    at = to + 1;
  }
  return spans;
}

/** `[{ start, end, piece, tex }]` over the whole text (positions in `text`); `tex` is the mhchem source, or null for an ambiguous piece. */
export function chemSpans(text) {
  const result = [];
  for (const { text: segment, offset } of proseSegments(text)) {
    const list = candidates(segment), strictOrChain = chains(list, segment);
    for (const span of strictOrChain) result.push({ start: offset + span.start, end: offset + span.end, piece: segment.slice(span.start, span.end), tex: ce(segment.slice(span.start, span.end)) });
    for (const item of list) if (item.kind === 'ambiguous') result.push({ start: offset + item.start, end: offset + item.end, piece: item.piece, tex: null });
  }
  return result.sort((a, b) => a.start - b.start);
}

/** The chemistry in a text that is not inside math delimiters or code, as the strings the card would show raw (SO42- included). */
export function bareChemistry(text) {
  const found = [];
  for (const span of chemSpans(text)) if (!found.includes(span.piece)) found.push(span.piece);
  return found;
}

/** `text` with every unambiguous formula, ion and equation wrapped as `$\ce{…}$` in place; ambiguous ones stay as written. */
export function wrapChemistry(text) {
  if (typeof text !== 'string' || text.includes('{{')) return text;
  let out = text;
  for (const span of chemSpans(text).filter(item => item.tex !== null).reverse()) {
    const pad = /[A-Za-z0-9]/.test(out[span.start - 1] || '') ? ' ' : '';
    out = `${out.slice(0, span.start)}${pad}$\\ce{${span.tex}}$${out.slice(span.end)}`;
  }
  return out;
}

/** mhchem source when the whole of `text` is one formula (loose: a plain element group such as NaOH counts), else null; for option sets. */
export function chemWhole(text, { loose = false } = {}) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed || /[㐀-鿿]/.test(trimmed)) return null;
  const spans = chemSpans(trimmed).filter(item => item.tex !== null);
  if (spans.length === 1 && spans[0].start === 0 && spans[0].end === trimmed.length) return spans[0].tex;
  if (!loose) return null;
  for (const { text: segment } of proseSegments(trimmed)) {
    const list = candidates(segment);
    if (list.length === 1 && list[0].kind !== 'ambiguous' && list[0].start === 0 && list[0].end === trimmed.length) return ce(list[0].piece);
  }
  return null;
}
