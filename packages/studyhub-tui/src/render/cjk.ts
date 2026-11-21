/**
 * CJK / emoji / ANSI-aware display-width utilities.
 *
 * All functions treat ANSI escape sequences (SGR colours, OSC-8 hyperlinks, …) as zero-width and
 * never split a grapheme cluster, so wide characters (中文, ｆｕｌｌ-width punctuation, emoji) are
 * never cut in half. Wrapping helpers close any open SGR styles at the end of every produced line
 * and re-open them at the start of the next one, so each line is self-contained (safe for
 * virtualised rendering in Ink).
 */
import stripAnsi from 'strip-ansi';
import { eastAsianWidth } from 'get-east-asian-width';

export type Align = 'left' | 'right' | 'center';

// OSC (… BEL / ST) or CSI sequences.
const ANSI_SOURCE =
  '\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\\\|\\u009C)|[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]';

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const ZERO_WIDTH_CLUSTER = /^[\p{Mn}\p{Me}\p{Cf}\u200B-\u200F\u2028-\u202E\u2060-\u2064\uFE00-\uFE0F\u{E0000}-\u{E007F}]+$/u;
const ZERO_WIDTH_CP = /^[\p{Mn}\p{Me}\p{Cf}\u200B-\u200F\uFE00-\uFE0F]$/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const EMOJI_PRESENTATION_START = /^\p{Emoji_Presentation}/u;
const REGIONAL_INDICATOR_START = /^\p{Regional_Indicator}/u;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const widthCache = new Map<string, number>();

/** Display width (0, 1 or 2 columns) of a single grapheme cluster. */
export function graphemeWidth(g: string): number {
  if (g.length === 1) {
    const c = g.charCodeAt(0);
    if (c >= 0x20 && c < 0x7f) return 1;
    if (c < 0x20 || (c >= 0x7f && c < 0xa0)) return 0;
  }
  const cached = widthCache.get(g);
  if (cached !== undefined) return cached;
  const w = computeGraphemeWidth(g);
  if (widthCache.size > 8192) widthCache.clear();
  widthCache.set(g, w);
  return w;
}

function computeGraphemeWidth(g: string): number {
  if (!g) return 0;
  if (ZERO_WIDTH_CLUSTER.test(g)) return 0;
  if (REGIONAL_INDICATOR_START.test(g)) return 2;
  if (EMOJI_PRESENTATION_START.test(g)) return 2;
  if (PICTOGRAPHIC.test(g) && (g.includes('\uFE0F') || g.includes('\u200D'))) return 2;
  if (g.includes('\u20E3')) return 2; // keycap sequences
  for (const ch of g) {
    if (ZERO_WIDTH_CP.test(ch)) continue;
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
    return eastAsianWidth(cp, { ambiguousAsWide: false });
  }
  return 0;
}

/** Split a plain (ANSI-free) string into grapheme clusters. */
export function splitGraphemes(str: string): string[] {
  if (PRINTABLE_ASCII.test(str)) return str.split('');
  const out: string[] = [];
  for (const s of segmenter.segment(str)) out.push(s.segment);
  return out;
}

/** Visible width in terminal columns (ANSI ignored, CJK/emoji = 2, combining marks = 0). */
export function displayWidth(str: string): number {
  if (!str) return 0;
  if (PRINTABLE_ASCII.test(str)) return str.length;
  const plain = str.includes('\u001B') || str.includes('\u009B') ? stripAnsi(str) : str;
  if (PRINTABLE_ASCII.test(plain)) return plain.length;
  let w = 0;
  for (const s of segmenter.segment(plain)) w += graphemeWidth(s.segment);
  return w;
}

// ---------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------

interface Tok {
  s: string;
  w: number;
  ansi: boolean;
}

function tokenize(str: string): Tok[] {
  const out: Tok[] = [];
  const re = new RegExp(ANSI_SOURCE, 'g');
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(str)) !== null) {
    if (m.index > last) pushText(out, str.slice(last, m.index));
    out.push({ s: m[0], w: 0, ansi: true });
    last = re.lastIndex;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < str.length) pushText(out, str.slice(last));
  return out;
}

function pushText(out: Tok[], text: string): void {
  if (PRINTABLE_ASCII.test(text)) {
    for (let i = 0; i < text.length; i++) out.push({ s: text[i], w: 1, ansi: false });
    return;
  }
  for (const seg of segmenter.segment(text)) out.push({ s: seg.segment, w: graphemeWidth(seg.segment), ansi: false });
}

// ---------------------------------------------------------------------------------------------
// SGR state (so wrapped lines can be closed / re-opened independently)
// ---------------------------------------------------------------------------------------------

const SGR_RE = /^(?:\u001B\[|\u009B)([\d;:]*)m$/;
const OSC8_RE = /^\u001B\]8;[^;]*;([\s\S]*?)(?:\u0007|\u001B\\|\u009C)$/;

class SgrState {
  private attrs = new Map<string, string>();
  private link: string | null = null;

  apply(seq: string): void {
    const osc = OSC8_RE.exec(seq);
    if (osc) {
      this.link = osc[1] ? seq : null;
      return;
    }
    const m = SGR_RE.exec(seq);
    if (!m) return;
    const params = m[1] === '' ? ['0'] : m[1].split(';');
    for (let i = 0; i < params.length; i++) {
      const raw = params[i];
      const p = raw === '' ? 0 : Number.parseInt(raw, 10);
      if (Number.isNaN(p)) continue;
      if (p === 0) this.attrs.clear();
      else if (p === 1) this.attrs.set('bold', '1');
      else if (p === 2) this.attrs.set('dim', '2');
      else if (p === 22) {
        this.attrs.delete('bold');
        this.attrs.delete('dim');
      } else if (p === 3) this.attrs.set('italic', '3');
      else if (p === 23) this.attrs.delete('italic');
      else if (p === 4) this.attrs.set('underline', raw);
      else if (p === 24) this.attrs.delete('underline');
      else if (p === 5 || p === 6) this.attrs.set('blink', raw);
      else if (p === 25) this.attrs.delete('blink');
      else if (p === 7) this.attrs.set('inverse', '7');
      else if (p === 27) this.attrs.delete('inverse');
      else if (p === 8) this.attrs.set('hidden', '8');
      else if (p === 28) this.attrs.delete('hidden');
      else if (p === 9) this.attrs.set('strike', '9');
      else if (p === 29) this.attrs.delete('strike');
      else if (p === 53) this.attrs.set('overline', '53');
      else if (p === 55) this.attrs.delete('overline');
      else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) this.attrs.set('fg', String(p));
      else if (p === 39) this.attrs.delete('fg');
      else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) this.attrs.set('bg', String(p));
      else if (p === 49) this.attrs.delete('bg');
      else if (p === 38 || p === 48 || p === 58) {
        const key = p === 38 ? 'fg' : p === 48 ? 'bg' : 'ul';
        const mode = params[i + 1];
        if (mode === '5') {
          this.attrs.set(key, `${p};5;${params[i + 2] ?? '0'}`);
          i += 2;
        } else if (mode === '2') {
          this.attrs.set(key, `${p};2;${params[i + 2] ?? '0'};${params[i + 3] ?? '0'};${params[i + 4] ?? '0'}`);
          i += 4;
        }
      } else if (p === 59) this.attrs.delete('ul');
    }
  }

  open(): string {
    let s = '';
    if (this.attrs.size > 0) s += `\u001B[${[...this.attrs.values()].join(';')}m`;
    if (this.link) s += this.link;
    return s;
  }

  close(): string {
    let s = '';
    if (this.link) s += '\u001B]8;;\u0007';
    if (this.attrs.size > 0) s += '\u001B[0m';
    return s;
  }
}

// ---------------------------------------------------------------------------------------------
// Truncate / pad / slice
// ---------------------------------------------------------------------------------------------

/** Truncate to at most `maxCols` columns, appending `ellipsis` when cut. ANSI-safe. */
export function truncateDisplay(str: string, maxCols: number, ellipsis = '…'): string {
  const max = Math.floor(maxCols);
  if (!(max > 0)) return '';
  if (displayWidth(str) <= max) return str;
  let ell = ellipsis;
  let ellW = displayWidth(ell);
  if (ellW > max) {
    ell = '';
    ellW = 0;
  }
  const target = max - ellW;
  let out = '';
  let w = 0;
  let cut = false;
  for (const tok of tokenize(str)) {
    if (tok.ansi) {
      out += tok.s;
      continue;
    }
    if (cut) continue;
    if (w + tok.w <= target) {
      out += tok.s;
      w += tok.w;
    } else {
      cut = true;
      out += ell;
    }
  }
  if (!cut) out += ell;
  return out;
}

/** Pad (or truncate) to exactly `width` columns. */
export function padDisplay(str: string, width: number, align: Align = 'left'): string {
  const target = Math.max(0, Math.floor(width) || 0);
  let s = str;
  let w = displayWidth(s);
  if (w > target) {
    s = truncateDisplay(s, target);
    w = displayWidth(s);
  }
  const gap = target - w;
  if (gap <= 0) return s;
  if (align === 'right') return ' '.repeat(gap) + s;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + s + ' '.repeat(gap - left);
  }
  return s + ' '.repeat(gap);
}

/**
 * Columns [startCol, endCol) of `str`. A wide char straddling either edge is replaced by spaces so
 * the result keeps its column alignment. All ANSI sequences are preserved.
 */
export function sliceDisplay(str: string, startCol: number, endCol?: number): string {
  const start = Math.max(0, Math.floor(startCol) || 0);
  const end = endCol === undefined ? Number.POSITIVE_INFINITY : Math.floor(endCol);
  if (end <= start) return '';
  let out = '';
  let col = 0;
  for (const tok of tokenize(str)) {
    if (tok.ansi) {
      out += tok.s;
      continue;
    }
    const gs = col;
    const ge = col + tok.w;
    col = ge;
    if (tok.w === 0) {
      if (gs > start && gs <= end) out += tok.s;
      continue;
    }
    if (gs >= start && ge <= end) out += tok.s;
    else if (gs < end && ge > start) out += ' '.repeat(Math.min(ge, end) - Math.max(gs, start));
  }
  return out;
}

/** Replace tabs with spaces (tab stops every `size` columns). */
export function expandTabs(str: string, size = 4): string {
  if (!str.includes('\t')) return str;
  return str
    .split('\n')
    .map((line) => {
      let out = '';
      let col = 0;
      for (const tok of tokenize(line)) {
        if (tok.s === '\t') {
          const n = size - (col % size);
          out += ' '.repeat(n);
          col += n;
        } else {
          out += tok.s;
          col += tok.w;
        }
      }
      return out;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------------------------
// Wrapping
// ---------------------------------------------------------------------------------------------

const CLOSING_PUNCT = new Set(Array.from('，。、；：！？）」』》〉】〕｝］’”…・％〜ー,.!?;:)]}%'));
const OPENING_PUNCT = new Set(Array.from('（「『《〈【〔｛［‘“'));

class LineBuilder {
  readonly lines: string[] = [];
  readonly state = new SgrState();
  cur = '';
  curW = 0;
  /** true when the current line was produced by an automatic wrap (drop leading spaces). */
  wrapped = false;

  constructor(readonly max: number) {}

  appendTok(tok: Tok): void {
    if (tok.ansi) {
      this.cur += tok.s;
      this.state.apply(tok.s);
      return;
    }
    if (tok.w > this.max) return; // cannot fit at all (e.g. wide char in 1-col box)
    this.cur += tok.s;
    this.curW += tok.w;
  }

  appendAnsiOnly(toks: Tok[]): void {
    for (const t of toks) if (t.ansi) this.appendTok(t);
  }

  breakLine(wrapped: boolean): void {
    this.lines.push(this.cur + this.state.close());
    this.cur = this.state.open();
    this.curW = 0;
    this.wrapped = wrapped;
  }

  hardAppend(toks: Tok[]): void {
    for (const t of toks) {
      if (!t.ansi && t.w > 0 && this.curW + t.w > this.max && this.curW > 0) this.breakLine(true);
      this.appendTok(t);
    }
  }

  finish(): string[] {
    this.lines.push(this.cur + this.state.close());
    return this.lines;
  }
}

function widthOf(toks: Tok[]): number {
  let w = 0;
  for (const t of toks) w += t.w;
  return w;
}

/**
 * Word-wrap to `maxCols` columns: latin text wraps at spaces, CJK wraps between any two characters
 * (with light kinsoku: closing punctuation never starts a line, opening punctuation never ends
 * one), over-long words are hard-broken, explicit `\n` is preserved. ANSI-safe.
 */
export function wrapDisplay(str: string, maxCols: number): string[] {
  const max = Math.max(1, Math.floor(maxCols) || 1);
  const b = new LineBuilder(max);
  const logical = str.split('\n');

  logical.forEach((line, li) => {
    if (li > 0) b.breakLine(false);
    let word: Tok[] = [];
    let spaces: Tok[] = [];
    let endsWide = false;

    const flush = (): void => {
      endsWide = false;
      const wordW = widthOf(word);
      const spaceW = widthOf(spaces);
      if (wordW === 0) {
        // only ANSI / zero-width marks — attach without affecting layout
        b.appendAnsiOnly(spaces);
        for (const t of word) b.appendTok(t);
        word = [];
        return;
      }
      if (b.curW === 0 && b.wrapped) {
        b.appendAnsiOnly(spaces);
        spaces = [];
      }
      const sw = b.curW === 0 && b.wrapped ? 0 : spaceW;
      if (b.curW + sw + wordW <= max) {
        for (const t of spaces) b.appendTok(t);
        for (const t of word) b.appendTok(t);
      } else {
        b.appendAnsiOnly(spaces);
        if (b.curW > 0) b.breakLine(true);
        if (wordW <= max) for (const t of word) b.appendTok(t);
        else b.hardAppend(word);
      }
      word = [];
      spaces = [];
    };

    const wordOnlyOpening = (): boolean => {
      let any = false;
      for (const t of word) {
        if (t.ansi || t.w === 0) continue;
        if (!OPENING_PUNCT.has(t.s)) return false;
        any = true;
      }
      return any;
    };

    for (const tok of tokenize(line)) {
      if (tok.ansi || tok.w === 0) {
        word.push(tok);
        continue;
      }
      if (tok.s === ' ') {
        if (widthOf(word) > 0) flush();
        else if (word.length) {
          spaces.push(...word);
          word = [];
        }
        spaces.push(tok);
        continue;
      }
      if (CLOSING_PUNCT.has(tok.s)) {
        // closing punctuation sticks to the preceding unit (never starts a line)
        word.push(tok);
        if (tok.w >= 2) endsWide = true;
        continue;
      }
      if (OPENING_PUNCT.has(tok.s)) {
        // opening punctuation sticks to the following unit (never ends a line)
        if (widthOf(word) > 0 && !wordOnlyOpening()) flush();
        word.push(tok);
        endsWide = false;
        continue;
      }
      if (tok.w >= 2) {
        // wide char: its own break unit
        if (widthOf(word) > 0 && !wordOnlyOpening()) flush();
        word.push(tok);
        endsWide = true;
        continue;
      }
      // narrow char extends a latin word; a break is allowed after a wide unit
      if (endsWide) flush();
      word.push(tok);
    }
    if (widthOf(word) > 0) flush();
    else {
      // trailing spaces are dropped (their ANSI kept), trailing ANSI kept
      b.appendAnsiOnly(spaces);
      for (const t of word) b.appendTok(t);
    }
  });

  return b.finish();
}

/** Character-level wrap (keeps every space; used for code blocks). ANSI-safe, preserves `\n`. */
export function wrapHard(str: string, maxCols: number): string[] {
  const max = Math.max(1, Math.floor(maxCols) || 1);
  const b = new LineBuilder(max);
  str.split('\n').forEach((line, li) => {
    if (li > 0) b.breakLine(false);
    b.hardAppend(tokenize(line));
  });
  return b.finish();
}

/** Split on `\n` closing/re-opening ANSI styles so every line is self-contained. */
export function splitAnsiLines(str: string): string[] {
  return wrapHard(str, Number.MAX_SAFE_INTEGER);
}
