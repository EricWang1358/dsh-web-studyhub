/**
 * Markdown → ANSI renderer for the TUI.
 *
 * Walks `marked.lexer` tokens directly (no HTML step) and emits self-contained ANSI lines whose
 * visible width never exceeds `opts.width` (CJK-aware). Math (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) is
 * protected before lexing so `_`/`*` inside TeX are not treated as emphasis, then rendered via
 * `math.ts` (or restored verbatim when `mathUnicode === false`).
 */
import { createRequire } from 'node:module';
import type { ChalkInstance } from 'chalk';
import { marked, type Token, type Tokens } from 'marked';
import { getColorLevel, makeChalk, type ColorLevel, type ThemeTokens } from '../theme/tokens.js';
import {
  displayWidth,
  expandTabs,
  padDisplay,
  truncateDisplay,
  wrapCode,
  wrapDisplay,
  type Align,
} from './cjk.js';
import { LruCache } from './lru.js';
import { renderMath, replaceMath } from './math.js';

export interface MarkdownRenderOptions {
  width: number;
  theme: ThemeTokens;
  /** Render TeX as Unicode (default true). `false` keeps the raw `$…$` source. */
  mathUnicode?: boolean;
  /** Render borders, bullets, rules, and quote bars using pure ASCII (default false). */
  ascii?: boolean;
}

interface CliHighlightModule {
  highlight: (code: string, options?: { language?: string; ignoreIllegals?: boolean }) => string;
  supportsLanguage: (name: string) => boolean;
}

let cachedHighlighter: CliHighlightModule | null | undefined;
let highlighterLoadAttempted = false;
const supportedLangCache = new Map<string, boolean>();

function isLanguageSupported(hl: CliHighlightModule, lang: string): boolean {
  let supported = supportedLangCache.get(lang);
  if (supported === undefined) {
    supported = hl.supportsLanguage(lang);
    if (supportedLangCache.size > 128) supportedLangCache.clear();
    supportedLangCache.set(lang, supported);
  }
  return supported;
}

function getHighlighter(): CliHighlightModule | null {
  if (highlighterLoadAttempted) return cachedHighlighter ?? null;
  highlighterLoadAttempted = true;
  try {
    const req = createRequire(import.meta.url);
    const mod = req('cli-highlight') as Partial<CliHighlightModule> | undefined;
    if (mod && typeof mod.highlight === 'function' && typeof mod.supportsLanguage === 'function') {
      cachedHighlighter = mod as CliHighlightModule;
      return cachedHighlighter;
    }
    cachedHighlighter = null;
    return null;
  } catch {
    cachedHighlighter = null;
    return null;
  }
}

/** Returns true once `cli-highlight` has been lazily loaded by a fenced code block. */
export function isHighlighterLoaded(): boolean {
  return highlighterLoadAttempted && cachedHighlighter !== null && cachedHighlighter !== undefined;
}

const MD_CACHE_MAX = 256;
const mdCache = new LruCache<string, string[]>(MD_CACHE_MAX);

export function clearMarkdownCache(): void {
  mdCache.clear();
}

export function markdownCacheSize(): number {
  return mdCache.size;
}

// ---------------------------------------------------------------------------------------------
// Math protection
// ---------------------------------------------------------------------------------------------

const INLINE_PH = /\uE000(\d+)\uE001/g;
const BLOCK_PH = /\uE002(\d+)\uE003/g;
const CJK_EM_MARK = '\uE004';
const CJK_EM_CLEAN_RE = /\uE004 | \uE004|\uE004/g;
const CJK_PUNCT_RE = /[\u3000-\u303F\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF65“”‘’…]/;
const NON_WS_NON_PUNCT_RE = /[^\s*\p{P}\p{S}]/u;

/**
 * CommonMark §6.2 rejects emphasis delimiters adjacent to CJK punctuation when there is no
 * surrounding space (e.g. `**易错点：**后面的文字` or `核心**（注意）**概念`). Insert a
 * reversible sentinel-tagged space outside code fences/spans only where a delimiter's flanking
 * rule would otherwise fail, then strip the sentinel+space in `renderTextRun` (#1421).
 */
function fixCjkEmphasisLine(line: string): string {
  if (!line.includes('*')) return line;
  const parts = line.split(INLINE_CODE_SPAN_RE);
  let boldOpen = false;
  let emOpen = false;
  let changed = false;

  const hasLater = (partIdx: number, pos: number, stars: number): boolean => {
    const token = '*'.repeat(stars);
    for (let p = partIdx; p < parts.length; p++) {
      if (p % 2 === 1) continue;
      const seg = parts[p];
      let from = p === partIdx ? pos : 0;
      while (from < seg.length) {
        const at = seg.indexOf(token, from);
        if (at === -1) break;
        const prev = at > 0 ? seg[at - 1] : '';
        const next = at + stars < seg.length ? seg[at + stars] : '';
        if (prev !== '\\' && prev !== '*' && next !== '*') return true;
        from = at + stars;
      }
    }
    return false;
  };

  for (let p = 0; p < parts.length; p++) {
    if (p % 2 === 1) continue; // skip inline code spans
    const seg = parts[p];
    if (!seg.includes('*')) continue;
    let out = '';
    let i = 0;
    while (i < seg.length) {
      if (seg[i] === '\\' && i + 1 < seg.length) {
        out += seg[i] + seg[i + 1];
        i += 2;
        continue;
      }
      if (seg[i] !== '*') {
        out += seg[i];
        i += 1;
        continue;
      }
      let end = i;
      while (end < seg.length && seg[end] === '*') end += 1;
      const runLen = end - i;
      const run = seg.slice(i, end);
      const prev = i > 0 ? seg[i - 1] : p > 0 ? '`' : '';
      const next = end < seg.length ? seg[end] : p + 1 < parts.length ? '`' : '';

      if (runLen === 2) {
        if (!boldOpen) {
          if (hasLater(p, end, 2)) {
            if (prev && NON_WS_NON_PUNCT_RE.test(prev) && next && CJK_PUNCT_RE.test(next)) {
              out += `${CJK_EM_MARK} ${run}`;
              changed = true;
            } else {
              out += run;
            }
            boldOpen = true;
          } else {
            out += run;
          }
        } else {
          if (prev && CJK_PUNCT_RE.test(prev) && next && NON_WS_NON_PUNCT_RE.test(next)) {
            out += `${run} ${CJK_EM_MARK}`;
            changed = true;
          } else {
            out += run;
          }
          boldOpen = false;
        }
      } else if (runLen === 1) {
        if (!emOpen) {
          if (hasLater(p, end, 1)) {
            if (prev && NON_WS_NON_PUNCT_RE.test(prev) && next && CJK_PUNCT_RE.test(next)) {
              out += `${CJK_EM_MARK} ${run}`;
              changed = true;
            } else {
              out += run;
            }
            emOpen = true;
          } else {
            out += run;
          }
        } else {
          if (prev && CJK_PUNCT_RE.test(prev) && next && NON_WS_NON_PUNCT_RE.test(next)) {
            out += `${run} ${CJK_EM_MARK}`;
            changed = true;
          } else {
            out += run;
          }
          emOpen = false;
        }
      } else {
        out += run;
      }
      i = end;
    }
    parts[p] = out;
  }
  return changed ? parts.join('') : line;
}

function preprocessCjkEmphasis(md: string): string {
  if (!md.includes('*')) return md;
  const lines = md.split('\n');
  let fence: { ch: string; len: number } | null = null;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = { ch: open[1][0], len: open[1].length };
      continue;
    }
    const fixed = fixCjkEmphasisLine(line);
    if (fixed !== line) {
      lines[i] = fixed;
      changed = true;
    }
  }
  return changed ? lines.join('\n') : md;
}

interface MathStore {
  inline: string[];
  blocks: string[];
}

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^\s{0,3}(`{3,}|~{3,})\s*$/;
const INLINE_CODE_SPAN_RE = /(`+[^`]*?`+)/;
const ENTITY_RE = /&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi;
const CJK_SOFT_BREAK_RE = /([^\x00-\xff])\n(?=[^\x00-\xff])/g;
const NEWLINE_RE = /\n/g;
const CRLF_RE = /\r\n?/g;
const BR_TAG_EXACT_RE = /^<br\s*\/?>$/i;
const BR_TAG_GLOBAL_RE = /<br\s*\/?>/gi;
const HTML_TAG_RE = /<[^>]*>/g;
const FIRST_TOKEN_RE = /^\s*(\S+)/;

function protectInline(line: string, store: MathStore, enabled: boolean): string {
  const hasDollar = line.includes('$');
  if (!hasDollar && !line.includes('\\')) return line;
  if (!hasDollar && !line.includes('\\(') && !line.includes('\\[')) return line;
  const replaceSegment = (seg: string): string =>
    replaceMath(seg, ({ raw, tex, display }) => {
      if (display) {
        store.blocks.push(enabled ? renderMath(tex) : raw);
        return `\uE002${store.blocks.length - 1}\uE003`;
      }
      const rendered = enabled ? renderMath(tex) : raw;
      store.inline.push(enabled && rendered.includes('\n') ? rendered.replace(NEWLINE_RE, ' ') : rendered);
      return `\uE000${store.inline.length - 1}\uE001`;
    });
  if (!line.includes('`')) return replaceSegment(line);
  // Skip inline code spans.
  const parts = line.split(INLINE_CODE_SPAN_RE);
  let out = '';
  for (let idx = 0; idx < parts.length; idx++) {
    const part = parts[idx];
    out += idx % 2 === 1 ? part : replaceSegment(part);
  }
  return out;
}

function protectMath(md: string, enabled: boolean): { src: string; store: MathStore } {
  const store: MathStore = { inline: [], blocks: [] };
  const hasDollar = md.includes('$');
  if (!hasDollar && !md.includes('\\')) return { src: md, store };
  if (!hasDollar && !md.includes('\\(') && !md.includes('\\[')) return { src: md, store };
  const lines = md.split('\n');
  const out: string[] = new Array(lines.length);
  let outLen = 0;
  let changed = false;
  let fence: { ch: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      out[outLen++] = line;
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = { ch: open[1][0], len: open[1].length };
      out[outLen++] = line;
      continue;
    }
    const t = line.trim();
    // Multi-line display math: a line starting with $$ / \[ that does not close on the same line.
    const opener = t.startsWith('$$') ? '$$' : t.startsWith('\\[') ? '\\[' : null;
    if (opener) {
      const closer = opener === '$$' ? '$$' : '\\]';
      const rest = t.slice(2);
      if (!rest.includes(closer)) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trimEnd().endsWith(closer)) j++;
        if (j < lines.length) {
          const indent = line.slice(0, line.length - line.trimStart().length);
          const lastLine = lines[j].trimEnd();
          const body = [rest, ...lines.slice(i + 1, j), lastLine.slice(0, lastLine.length - 2)]
            .join('\n')
            .trim();
          store.blocks.push(enabled ? renderMath(body) : lines.slice(i, j + 1).map((l) => l.trim()).join('\n'));
          out[outLen++] = `${indent}\uE002${store.blocks.length - 1}\uE003`;
          changed = true;
          i = j;
          continue;
        }
      }
    }
    const protectedLine = protectInline(line, store, enabled);
    if (protectedLine !== line) changed = true;
    out[outLen++] = protectedLine;
  }
  if (!changed) return { src: md, store };
  out.length = outLen;
  return { src: out.join('\n'), store };
}

// ---------------------------------------------------------------------------------------------
// Rendering context
// ---------------------------------------------------------------------------------------------

type StyleFn = (s: string) => string;
const identityStyle: StyleFn = (s: string): string => s;

interface StyleCache {
  bold?: StyleFn;
  italic?: StyleFn;
  strike?: StyleFn;
  codespan?: StyleFn;
  link?: StyleFn;
  dim?: StyleFn;
  muted?: StyleFn;
  ai?: StyleFn;
  border?: StyleFn;
  codeFrame?: StyleFn;
  headingBold?: StyleFn;
  h1?: StyleFn;
  h2?: StyleFn;
  h3?: StyleFn;
  h4?: StyleFn;
  quote?: StyleFn;
  accent?: StyleFn;
  success?: StyleFn;
}

const NO_COLOR_STYLES: StyleCache = Object.freeze({
  bold: identityStyle,
  italic: identityStyle,
  strike: identityStyle,
  codespan: identityStyle,
  link: identityStyle,
  dim: identityStyle,
  muted: identityStyle,
  ai: identityStyle,
  border: identityStyle,
  codeFrame: identityStyle,
  headingBold: identityStyle,
  h1: identityStyle,
  h2: identityStyle,
  h3: identityStyle,
  h4: identityStyle,
  quote: identityStyle,
  accent: identityStyle,
  success: identityStyle,
});

const STYLE_CACHE_BY_THEME = new WeakMap<ThemeTokens, Partial<Record<ColorLevel, StyleCache>>>();

function getStyleCache(theme: ThemeTokens, colorLevel: ColorLevel): StyleCache {
  if (colorLevel === 0) return NO_COLOR_STYLES;
  let byLevel = STYLE_CACHE_BY_THEME.get(theme);
  if (!byLevel) {
    byLevel = {};
    STYLE_CACHE_BY_THEME.set(theme, byLevel);
  }
  let styles = byLevel[colorLevel];
  if (!styles) {
    styles = {};
    byLevel[colorLevel] = styles;
  }
  return styles;
}

interface Ctx {
  theme: ThemeTokens;
  c: ChalkInstance;
  s: StyleCache;
  store: MathStore;
  listDepth: number;
  mathOn: boolean;
  ascii: boolean;
}

const ENTITY_MAP: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', '#39': '\'', mdash: '—', ndash: '–',
  hellip: '…', copy: '©', reg: '®', times: '×', divide: '÷', middot: '·', laquo: '«', raquo: '»',
};

function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  ENTITY_RE.lastIndex = 0;
  return s.replace(ENTITY_RE, (m, name: string) => {
    if (name[0] === '#') {
      const cp = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      if (Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff) {
        if (name === '#39') return '\'';
        return String.fromCodePoint(cp);
      }
      return m;
    }
    return ENTITY_MAP[name] ?? m;
  });
}

function mathStyle(ctx: Ctx, s: string): string {
  return (ctx.s.ai ??= ctx.c.hex(ctx.theme.ai))(s);
}

function restoreMath(text: string, ctx: Ctx): string {
  if (ctx.store.inline.length === 0 && ctx.store.blocks.length === 0) return text;
  let s = text;
  if (ctx.store.inline.length > 0 && s.includes('\uE000')) {
    INLINE_PH.lastIndex = 0;
    s = s.replace(INLINE_PH, (_m, n: string) => mathStyle(ctx, ctx.store.inline[Number(n)] ?? ''));
  }
  if (ctx.store.blocks.length > 0 && s.includes('\uE002')) {
    BLOCK_PH.lastIndex = 0;
    s = s.replace(BLOCK_PH, (_m, n: string) => {
      const body = ctx.store.blocks[Number(n)] ?? '';
      if (!body.includes('\n')) return `\n  ${mathStyle(ctx, body)}\n`;
      return `\n${body
        .split('\n')
        .map((l) => `  ${mathStyle(ctx, l)}`)
        .join('\n')}\n`;
    });
  }
  return s;
}

/** Soft line breaks become spaces (none between two CJK characters). */
function softBreaks(s: string): string {
  if (!s.includes('\n')) return s;
  CJK_SOFT_BREAK_RE.lastIndex = 0;
  NEWLINE_RE.lastIndex = 0;
  return s.replace(CJK_SOFT_BREAK_RE, '$1').replace(NEWLINE_RE, ' ');
}

function renderTextRun(text: string, ctx: Ctx): string {
  const cleaned = text.includes(CJK_EM_MARK) ? text.replace(CJK_EM_CLEAN_RE, '') : text;
  return restoreMath(softBreaks(decodeEntities(cleaned)), ctx);
}

type AnyToken = Token & { tokens?: Token[]; text?: string };

function inline(tokens: Token[] | undefined, ctx: Ctx): string {
  if (!tokens) return '';
  const { c, theme, s } = ctx;
  let out = '';
  for (const tok of tokens as AnyToken[]) {
    switch (tok.type) {
      case 'text':
        out += tok.tokens && tok.tokens.length ? inline(tok.tokens, ctx) : renderTextRun(tok.text ?? '', ctx);
        break;
      case 'escape':
        out += tok.text ?? '';
        break;
      case 'strong':
        out += (s.bold ??= c.bold)(inline(tok.tokens, ctx));
        break;
      case 'em':
        out += (s.italic ??= c.italic)(inline(tok.tokens, ctx));
        break;
      case 'del':
        out += (s.strike ??= c.strikethrough)(inline(tok.tokens, ctx));
        break;
      case 'codespan': {
        const rawCode = tok.text ?? '';
        const flat = rawCode.includes('\n') ? rawCode.replace(NEWLINE_RE, ' ') : rawCode;
        const code = restoreMath(flat, ctx);
        out += (s.codespan ??= c.bgHex(theme.codeBg).hex(theme.code))(` ${code} `);
        break;
      }
      case 'link': {
        const link = tok as unknown as Tokens.Link;
        const label = inline(link.tokens, ctx) || link.href;
        out += (s.link ??= c.hex(theme.link).underline)(label);
        const rawHref = link.href ?? '';
        const href = rawHref.startsWith('mailto:') ? rawHref.slice(7) : rawHref;
        const plain = (link.text ?? '').trim();
        if (href && href !== plain && !href.startsWith('#')) out += ' ' + (s.dim ??= c.hex(theme.dim))(`(${href})`);
        break;
      }
      case 'image': {
        const img = tok as unknown as Tokens.Image;
        out += (s.muted ??= c.hex(theme.muted))(`[image: ${img.text || img.href}]`);
        break;
      }
      case 'br':
        out += '\n';
        break;
      case 'html': {
        const raw = tok.text ?? '';
        if (BR_TAG_EXACT_RE.test(raw.trim())) out += '\n';
        else {
          HTML_TAG_RE.lastIndex = 0;
          out += decodeEntities(raw.replace(HTML_TAG_RE, ''));
        }
        break;
      }
      case 'checkbox':
        break;
      default:
        if (tok.tokens) out += inline(tok.tokens, ctx);
        else if (typeof tok.text === 'string') out += renderTextRun(tok.text, ctx);
    }
  }
  return out;
}

function trimBlank(lines: string[]): string[] {
  let s = 0;
  let e = lines.length;
  while (s < e && displayWidth(lines[s]) === 0 && lines[s].trim() === '') s++;
  while (e > s && displayWidth(lines[e - 1]) === 0 && lines[e - 1].trim() === '') e--;
  return lines.slice(s, e);
}

function wrapBlock(text: string, width: number): string[] {
  return trimBlank(wrapDisplay(text, width));
}

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

const MATH_LANGS = new Set(['math', 'latex', 'tex', 'katex']);

function renderCode(tok: Tokens.Code, width: number, ctx: Ctx): string[] {
  const { c, theme, mathOn, ascii, s } = ctx;
  const langMatch = FIRST_TOKEN_RE.exec(tok.lang ?? '');
  const lang = langMatch ? langMatch[1] : '';
  if (mathOn && MATH_LANGS.has(lang.toLowerCase())) {
    return renderMath(tok.text)
      .split('\n')
      .flatMap((l) => wrapDisplay(`  ${mathStyle(ctx, l)}`, width));
  }
  const rawText = tok.text.includes('\r') ? tok.text.replace(CRLF_RE, '\n') : tok.text;
  // #1431: four-space indented code blocks are not skipped by `preprocessCjkEmphasis` (that scan only
  // tracks fences and inline spans), so strip any CJK emphasis sentinel before framing the code.
  const code = expandTabs(rawText.includes(CJK_EM_MARK) ? rawText.replace(CJK_EM_CLEAN_RE, '') : rawText, 4);
  let body = code;
  if (lang && c.level > 0) {
    const hl = getHighlighter();
    if (hl && isLanguageSupported(hl, lang)) {
      try {
        body = hl.highlight(code, { language: lang, ignoreIllegals: true });
      } catch {
        body = code;
      }
    }
  }
  if (width < 8) return wrapCode(body, width);
  // #1414: the frame uses `dim`, not `border`: panel borders may be faint, but a code frame that fades into
  // the terminal background leaves the language label looking like a stray line of text.
  const border = (s.codeFrame ??= c.hex(theme.dim));
  const muted = (s.muted ??= c.hex(theme.muted));
  const inner = width - 4;
  let label = lang ? ` ${lang} ` : '';
  if (displayWidth(label) > width - 4) label = truncateDisplay(label, width - 4, ascii ? '...' : '…');
  const labelW = displayWidth(label);
  let top: string;
  let bottom: string;
  let vBar: string;
  if (ascii) {
    const useLongPrefix = Boolean(label) && width >= labelW + 6;
    const prefix = useLongPrefix ? '+---' : '+-';
    const rem = Math.max(0, width - prefix.length - labelW - 1);
    top = border(prefix) + muted(label) + border(`${'-'.repeat(rem)}+`);
    bottom = border(`+${'-'.repeat(width - 2)}+`);
    vBar = border('|');
  } else {
    top = border('╭─') + muted(label) + border(`${'─'.repeat(Math.max(0, width - 3 - labelW))}╮`);
    bottom = border(`╰${'─'.repeat(width - 2)}╯`);
    vBar = border('│');
  }
  const wrapped = wrapCode(body, inner);
  const lines: string[] = new Array(wrapped.length + 2);
  lines[0] = top;
  for (let i = 0; i < wrapped.length; i++) {
    lines[i + 1] = `${vBar} ${padDisplay(wrapped[i], inner)} ${vBar}`;
  }
  lines[lines.length - 1] = bottom;
  return lines;
}

function renderList(tok: Tokens.List, width: number, ctx: Ctx): string[] {
  const { c, theme, ascii, s } = ctx;
  const depth = ctx.listDepth;
  const start = typeof tok.start === 'number' ? tok.start : Number.parseInt(String(tok.start || '1'), 10) || 1;
  const maxNum = String(start + tok.items.length - 1).length;
  const out: string[] = [];
  const markerStyle = tok.ordered ? (s.accent ??= c.hex(theme.accent)) : (s.muted ??= c.hex(theme.muted));
  const mutedStyle = (s.muted ??= c.hex(theme.muted));
  const checkedStyle = (s.success ??= c.hex(theme.success));
  const childCtx: Ctx = { ...ctx, listDepth: depth + 1 };
  const checkedGlyph = ascii ? '[x]' : '☑';
  const uncheckedGlyph = ascii ? '[ ]' : '☐';

  for (let idx = 0; idx < tok.items.length; idx++) {
    const item = tok.items[idx];
    let markerPlain: string;
    if (tok.ordered) markerPlain = `${String(start + idx)}.`.padStart(maxNum + 1, ' ');
    else if (ascii) markerPlain = depth % 2 === 0 ? '*' : '-';
    else markerPlain = depth % 2 === 0 ? '•' : '◦';
    let marker = markerStyle(markerPlain);
    if (item.task) {
      const box = item.checked ? checkedStyle(checkedGlyph) : mutedStyle(uncheckedGlyph);
      marker = tok.ordered ? `${marker} ${box}` : box;
      markerPlain = tok.ordered ? `${markerPlain} ${uncheckedGlyph}` : uncheckedGlyph;
    }
    const mw = displayWidth(markerPlain) + 1;
    const rawTokens = item.tokens ?? [];
    const children = rawTokens.length > 0 && rawTokens.some((t) => t.type === 'checkbox')
      ? rawTokens.filter((t) => t.type !== 'checkbox')
      : rawTokens;
    const bodyWidth = Math.max(1, width - mw);
    const body = renderBlocks(children, bodyWidth, childCtx, !item.loose);
    if (tok.loose && idx > 0) out.push('');
    if (body.length === 0) {
      out.push(marker);
      continue;
    }
    const pad = body.length > 1 ? ' '.repeat(mw) : '';
    const applyTaskMute = item.task && item.checked;
    for (let i = 0; i < body.length; i++) {
      const line = applyTaskMute ? mutedStyle(body[i]) : body[i];
      out.push(i === 0 ? `${marker} ${line}` : `${pad}${line}`);
    }
  }
  return out;
}

function distributeWidths(nat: number[], avail: number): number[] {
  const n = nat.length;
  const total = nat.reduce((a, b) => a + b, 0);
  if (total <= avail) return nat.slice();
  const floorShare = Math.max(1, Math.min(6, Math.floor(avail / n)));
  const base = nat.map((w) => Math.min(w, floorShare));
  let rest = avail - base.reduce((a, b) => a + b, 0);
  if (rest <= 0) return base;
  const need = nat.map((w, i) => w - base[i]);
  const needTotal = need.reduce((a, b) => a + b, 0);
  const widths = base.map((b, i) => b + Math.floor((rest * need[i]) / needTotal));
  rest = avail - widths.reduce((a, b) => a + b, 0);
  const order = nat.map((_, i) => i).sort((a, b) => nat[b] - widths[b] - (nat[a] - widths[a]));
  for (let k = 0; rest > 0 && k < order.length * 2; k++) {
    const i = order[k % order.length];
    if (widths[i] < nat[i]) {
      widths[i]++;
      rest--;
    }
  }
  return widths;
}

function renderTable(tok: Tokens.Table, width: number, ctx: Ctx): string[] {
  const { c, theme, ascii, s } = ctx;
  const n = tok.header.length;
  if (n === 0) return [];
  const cell = (t: Tokens.TableCell): string => {
    const rendered = inline(t.tokens, ctx);
    if (!rendered.includes('\n')) return rendered;
    NEWLINE_RE.lastIndex = 0;
    return rendered.replace(NEWLINE_RE, ' ');
  };
  const header = tok.header.map(cell);
  const rows = tok.rows.map((r) => {
    const cells = r.map(cell);
    while (cells.length < n) cells.push('');
    return cells.length === n ? cells : cells.slice(0, n);
  });
  const hChar = ascii ? '-' : '─';
  const vChar = ascii ? '|' : '│';
  const avail = width - (3 * n + 1);
  const border = (s.border ??= c.hex(theme.border));
  if (avail < n) {
    // Too narrow for a grid: fall back to "header: value" lines.
    const boldStyle = (s.bold ??= c.bold);
    const sepRule = border(hChar.repeat(Math.max(1, width)));
    const out: string[] = [];
    for (let ri = 0; ri < rows.length; ri++) {
      if (ri > 0) out.push(sepRule);
      const r = rows[ri];
      for (let j = 0; j < r.length; j++) out.push(...wrapDisplay(`${boldStyle(header[j])}: ${r[j]}`, width));
    }
    return out;
  }
  const nat: number[] = new Array(n);
  for (let j = 0; j < n; j++) {
    let maxW = Math.max(1, displayWidth(header[j]));
    for (let ri = 0; ri < rows.length; ri++) {
      const w = displayWidth(rows[ri][j]);
      if (w > maxW) maxW = w;
    }
    nat[j] = maxW;
  }
  const widths = distributeWidths(nat, avail);
  const aligns: Align[] = tok.align.map((a) => (a === 'right' ? 'right' : a === 'center' ? 'center' : 'left'));
  const segs = widths.map((w) => hChar.repeat(w + 2));
  const rule = (l: string, m: string, r: string): string => border(l + segs.join(m) + r);
  const styledVBar = border(vChar);
  const headStyle = (s.headingBold ??= c.bold.hex(theme.heading));
  const row = (cells: string[], head: boolean): string => {
    let line = styledVBar;
    for (let j = 0; j < cells.length; j++) {
      if (j > 0) line += styledVBar;
      const fitted = padDisplay(cells[j], widths[j], aligns[j] ?? 'left');
      line += ` ${head ? headStyle(fitted) : fitted} `;
    }
    return line + styledVBar;
  };
  const out: string[] = new Array(rows.length + 4);
  if (ascii) {
    const asciiRule = rule('+', '+', '+');
    out[0] = asciiRule;
    out[1] = row(header, true);
    out[2] = asciiRule;
    for (let i = 0; i < rows.length; i++) out[3 + i] = row(rows[i], false);
    out[out.length - 1] = asciiRule;
  } else {
    out[0] = rule('┌', '┬', '┐');
    out[1] = row(header, true);
    out[2] = rule('├', '┼', '┤');
    for (let i = 0; i < rows.length; i++) out[3 + i] = row(rows[i], false);
    out[out.length - 1] = rule('└', '┴', '┘');
  }
  return out;
}

function renderBlock(tok: AnyToken, width: number, ctx: Ctx): string[] {
  const { c, theme, ascii, s } = ctx;
  const hChar = ascii ? '-' : '─';
  switch (tok.type) {
    case 'space':
    case 'def':
      return [];
    case 'heading': {
      const h = tok as unknown as Tokens.Heading;
      const text = inline(h.tokens, ctx);
      if (h.depth === 1) {
        const h1Style = (s.h1 ??= c.bold.hex(theme.primary));
        const borderStyle = (s.border ??= c.hex(theme.border));
        return [...wrapBlock(h1Style(text), width), borderStyle(hChar.repeat(width))];
      }
      if (h.depth === 2) return wrapBlock((s.h2 ??= c.bold.hex(theme.heading))(text), width);
      if (h.depth === 3) return wrapBlock((s.h3 ??= c.bold.hex(theme.accent))(text), width);
      return wrapBlock((s.h4 ??= c.hex(theme.accent))(text), width);
    }
    case 'paragraph':
      return wrapBlock(inline(tok.tokens, ctx), width);
    case 'text':
      return wrapBlock(tok.tokens && tok.tokens.length ? inline(tok.tokens, ctx) : renderTextRun(tok.text ?? '', ctx), width);
    case 'code':
      return renderCode(tok as unknown as Tokens.Code, width, ctx);
    case 'blockquote': {
      const inner = renderBlocks(tok.tokens ?? [], Math.max(1, width - 2), ctx, false);
      const quoteStyle = (s.quote ??= c.hex(theme.quote));
      const bar = quoteStyle(ascii ? '|' : '▎');
      const prefix = `${bar} `;
      for (let i = 0; i < inner.length; i++) inner[i] = prefix + quoteStyle(inner[i]);
      return inner;
    }
    case 'list':
      return renderList(tok as unknown as Tokens.List, width, ctx);
    case 'hr':
      return [(s.border ??= c.hex(theme.border))(hChar.repeat(width))];
    case 'table':
      return renderTable(tok as unknown as Tokens.Table, width, ctx);
    case 'html': {
      const raw = tok.text ?? '';
      BR_TAG_GLOBAL_RE.lastIndex = 0;
      HTML_TAG_RE.lastIndex = 0;
      const text = decodeEntities(raw.replace(BR_TAG_GLOBAL_RE, '\n').replace(HTML_TAG_RE, '')).trim();
      return text ? wrapBlock((s.muted ??= c.hex(theme.muted))(restoreMath(text, ctx)), width) : [];
    }
    default:
      if (tok.tokens) return wrapBlock(inline(tok.tokens, ctx), width);
      if (typeof tok.text === 'string') return wrapBlock(renderTextRun(tok.text, ctx), width);
      return [];
  }
}

function renderBlocks(tokens: Token[], width: number, ctx: Ctx, tight: boolean): string[] {
  const out: string[] = [];
  let first = true;
  for (const tok of tokens as AnyToken[]) {
    const lines = renderBlock(tok, width, ctx);
    if (lines.length === 0) continue;
    if (!first && !tight) out.push('');
    for (let i = 0; i < lines.length; i++) out.push(lines[i]);
    first = false;
  }
  return out;
}

function renderUncached(
  md: string,
  width: number,
  theme: ThemeTokens,
  mathOn: boolean,
  ascii: boolean,
  colorLevel: ColorLevel,
): string[] {
  const normalized = md.includes('\r') ? md.replace(CRLF_RE, '\n') : md;
  const { src: mathSafe, store } = protectMath(normalized, mathOn);
  const src = preprocessCjkEmphasis(mathSafe);
  const c = makeChalk(colorLevel);
  const ctx: Ctx = { theme, c, s: getStyleCache(theme, colorLevel), store, listDepth: 0, mathOn, ascii };
  let lines: string[];
  try {
    const tokens = marked.lexer(src, { gfm: true });
    lines = renderBlocks(tokens, width, ctx, false);
  } catch {
    lines = wrapDisplay(restoreMath(src, ctx), width);
  }
  const ellipsis = ascii ? '...' : '…';
  for (let i = 0; i < lines.length; i++) {
    if (displayWidth(lines[i]) > width) lines[i] = truncateDisplay(lines[i], width, ellipsis);
  }
  return lines;
}

/** Render markdown to self-contained ANSI lines, each at most `opts.width` columns wide. */
export function renderMarkdownLines(md: string, opts: MarkdownRenderOptions): string[] {
  if (!md) return [];
  const width = Math.max(1, Math.floor(opts.width) || 1);
  const mathOn = opts.mathUnicode !== false;
  const ascii = opts.ascii === true;
  const colorLevel = getColorLevel();
  const key = `${width}\u0001${opts.theme.id}\u0001${mathOn ? 1 : 0}\u0001${ascii ? 1 : 0}\u0001${colorLevel}\u0001${md}`;
  const cached = mdCache.get(key);
  if (cached) return cached.slice();
  const lines = renderUncached(md, width, opts.theme, mathOn, ascii, colorLevel);
  mdCache.set(key, lines);
  return lines.slice();
}

/** Render markdown to a single ANSI string (lines joined by `\n`). */
export function renderMarkdown(md: string, opts: MarkdownRenderOptions): string {
  return renderMarkdownLines(md, opts).join('\n');
}
