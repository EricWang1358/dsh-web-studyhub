/**
 * Markdown → ANSI renderer for the TUI.
 *
 * Walks `marked.lexer` tokens directly (no HTML step) and emits self-contained ANSI lines whose
 * visible width never exceeds `opts.width` (CJK-aware). Math (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) is
 * protected before lexing so `_`/`*` inside TeX are not treated as emphasis, then rendered via
 * `math.ts` (or restored verbatim when `mathUnicode === false`).
 */
import { createRequire } from 'node:module';
import defaultChalk, { Chalk, type ChalkInstance } from 'chalk';
import { marked, type Token, type Tokens } from 'marked';
import type { ThemeTokens } from '../theme/tokens.js';
import {
  displayWidth,
  expandTabs,
  padDisplay,
  truncateDisplay,
  wrapDisplay,
  wrapHard,
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

/** Shared chalk instance at the auto-detected colour level (0 when not a TTY, so output is plain). */
const chalk: ChalkInstance = new Chalk({ level: defaultChalk.level });

// ---------------------------------------------------------------------------------------------
// Math protection
// ---------------------------------------------------------------------------------------------

const INLINE_PH = /\uE000(\d+)\uE001/g;
const BLOCK_PH = /\uE002(\d+)\uE003/g;

interface MathStore {
  inline: string[];
  blocks: string[];
}

const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;

function protectInline(line: string, store: MathStore, enabled: boolean): string {
  if (!line.includes('$') && !line.includes('\\(') && !line.includes('\\[')) return line;
  // Skip inline code spans.
  const parts = line.split(/(`+[^`]*?`+)/);
  return parts
    .map((part, idx) => {
      if (idx % 2 === 1) return part;
      return replaceMath(part, ({ raw, tex, display }) => {
        if (display) {
          store.blocks.push(enabled ? renderMath(tex) : raw);
          return `\uE002${store.blocks.length - 1}\uE003`;
        }
        store.inline.push(enabled ? renderMath(tex).replace(/\n/g, ' ') : raw);
        return `\uE000${store.inline.length - 1}\uE001`;
      });
    })
    .join('');
}

function protectMath(md: string, enabled: boolean): { src: string; store: MathStore } {
  const store: MathStore = { inline: [], blocks: [] };
  if (!md.includes('$') && !md.includes('\\(') && !md.includes('\\[')) return { src: md, store };
  const lines = md.split('\n');
  const out: string[] = [];
  let fence: { ch: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      out.push(line);
      const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = { ch: open[1][0], len: open[1].length };
      out.push(line);
      continue;
    }
    const t = line.trim();
    const indent = line.slice(0, line.length - line.trimStart().length);
    // Multi-line display math: a line starting with $$ / \[ that does not close on the same line.
    const opener = t.startsWith('$$') ? '$$' : t.startsWith('\\[') ? '\\[' : null;
    if (opener) {
      const closer = opener === '$$' ? '$$' : '\\]';
      const rest = t.slice(2);
      if (!rest.includes(closer)) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trimEnd().endsWith(closer)) j++;
        if (j < lines.length) {
          const lastLine = lines[j].trimEnd();
          const body = [rest, ...lines.slice(i + 1, j), lastLine.slice(0, lastLine.length - 2)]
            .join('\n')
            .trim();
          store.blocks.push(enabled ? renderMath(body) : lines.slice(i, j + 1).map((l) => l.trim()).join('\n'));
          out.push(`${indent}\uE002${store.blocks.length - 1}\uE003`);
          i = j;
          continue;
        }
      }
    }
    out.push(protectInline(line, store, enabled));
  }
  return { src: out.join('\n'), store };
}

// ---------------------------------------------------------------------------------------------
// Rendering context
// ---------------------------------------------------------------------------------------------

interface Ctx {
  theme: ThemeTokens;
  c: ChalkInstance;
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
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, name: string) => {
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
  return ctx.c.hex(ctx.theme.ai)(s);
}

function restoreMath(text: string, ctx: Ctx): string {
  let s = text;
  if (s.includes('\uE000')) s = s.replace(INLINE_PH, (_m, n: string) => mathStyle(ctx, ctx.store.inline[Number(n)] ?? ''));
  if (s.includes('\uE002')) {
    s = s.replace(BLOCK_PH, (_m, n: string) => {
      const body = ctx.store.blocks[Number(n)] ?? '';
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
  return s.replace(/([^\x00-\xff])\n(?=[^\x00-\xff])/g, '$1').replace(/\n/g, ' ');
}

function renderTextRun(text: string, ctx: Ctx): string {
  return restoreMath(softBreaks(decodeEntities(text)), ctx);
}

type AnyToken = Token & { tokens?: Token[]; text?: string };

function inline(tokens: Token[] | undefined, ctx: Ctx): string {
  if (!tokens) return '';
  const { c, theme } = ctx;
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
        out += c.bold(inline(tok.tokens, ctx));
        break;
      case 'em':
        out += c.italic(inline(tok.tokens, ctx));
        break;
      case 'del':
        out += c.strikethrough(inline(tok.tokens, ctx));
        break;
      case 'codespan': {
        const code = restoreMath((tok.text ?? '').replace(/\n/g, ' '), ctx);
        out += c.bgHex(theme.codeBg).hex(theme.code)(` ${code} `);
        break;
      }
      case 'link': {
        const link = tok as unknown as Tokens.Link;
        const label = inline(link.tokens, ctx) || link.href;
        out += c.hex(theme.link).underline(label);
        const href = (link.href ?? '').replace(/^mailto:/, '');
        const plain = (link.text ?? '').trim();
        if (href && href !== plain && !href.startsWith('#')) out += ' ' + c.hex(theme.dim)(`(${href})`);
        break;
      }
      case 'image': {
        const img = tok as unknown as Tokens.Image;
        out += c.hex(theme.muted)(`[image: ${img.text || img.href}]`);
        break;
      }
      case 'br':
        out += '\n';
        break;
      case 'html': {
        const raw = tok.text ?? '';
        if (/^<br\s*\/?>$/i.test(raw.trim())) out += '\n';
        else out += decodeEntities(raw.replace(/<[^>]*>/g, ''));
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
  const { c, theme, mathOn, ascii } = ctx;
  const lang = (tok.lang ?? '').trim().split(/\s+/)[0] ?? '';
  if (mathOn && MATH_LANGS.has(lang.toLowerCase())) {
    return renderMath(tok.text)
      .split('\n')
      .flatMap((l) => wrapDisplay(`  ${mathStyle(ctx, l)}`, width));
  }
  const code = expandTabs(tok.text.replace(/\r\n?/g, '\n'), 4);
  let body = code;
  if (lang && c.level > 0) {
    const hl = getHighlighter();
    if (hl && hl.supportsLanguage(lang)) {
      try {
        body = hl.highlight(code, { language: lang, ignoreIllegals: true });
      } catch {
        body = code;
      }
    }
  }
  if (width < 8) return wrapHard(body, width);
  const border = c.hex(theme.border);
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
    top = border(prefix) + c.hex(theme.muted)(label) + border(`${'-'.repeat(rem)}+`);
    bottom = border(`+${'-'.repeat(width - 2)}+`);
    vBar = border('|');
  } else {
    top = border('╭─') + c.hex(theme.muted)(label) + border(`${'─'.repeat(Math.max(0, width - 3 - labelW))}╮`);
    bottom = border(`╰${'─'.repeat(width - 2)}╯`);
    vBar = border('│');
  }
  const lines = [top];
  for (const l of wrapHard(body, inner)) lines.push(`${vBar} ${padDisplay(l, inner)} ${vBar}`);
  lines.push(bottom);
  return lines;
}

function renderList(tok: Tokens.List, width: number, ctx: Ctx): string[] {
  const { c, theme, ascii } = ctx;
  const depth = ctx.listDepth;
  const start = typeof tok.start === 'number' ? tok.start : Number.parseInt(String(tok.start || '1'), 10) || 1;
  const maxNum = String(start + tok.items.length - 1).length;
  const out: string[] = [];
  tok.items.forEach((item, idx) => {
    let markerPlain: string;
    if (tok.ordered) markerPlain = `${String(start + idx)}.`.padStart(maxNum + 1, ' ');
    else if (ascii) markerPlain = depth % 2 === 0 ? '*' : '-';
    else markerPlain = depth % 2 === 0 ? '•' : '◦';
    let marker = c.hex(tok.ordered ? theme.accent : theme.muted)(markerPlain);
    if (item.task) {
      const checkedGlyph = ascii ? '[x]' : '☑';
      const uncheckedGlyph = ascii ? '[ ]' : '☐';
      const box = item.checked ? c.hex(theme.success)(checkedGlyph) : c.hex(theme.muted)(uncheckedGlyph);
      marker = tok.ordered ? `${marker} ${box}` : box;
      markerPlain = tok.ordered ? `${markerPlain} ${uncheckedGlyph}` : uncheckedGlyph;
    }
    const mw = displayWidth(markerPlain) + 1;
    const children = (item.tokens ?? []).filter((t) => t.type !== 'checkbox');
    const bodyWidth = Math.max(1, width - mw);
    let body = renderBlocks(children, bodyWidth, { ...ctx, listDepth: depth + 1 }, !item.loose);
    if (item.task && item.checked) body = body.map((l) => c.hex(theme.muted)(l));
    if (tok.loose && idx > 0) out.push('');
    if (body.length === 0) {
      out.push(marker);
      return;
    }
    body.forEach((l, i) => out.push(i === 0 ? `${marker} ${l}` : `${' '.repeat(mw)}${l}`));
  });
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
  const { c, theme, ascii } = ctx;
  const n = tok.header.length;
  if (n === 0) return [];
  const cell = (t: Tokens.TableCell): string => inline(t.tokens, ctx).replace(/\n/g, ' ');
  const header = tok.header.map(cell);
  const rows = tok.rows.map((r) => {
    const cells = r.map(cell);
    while (cells.length < n) cells.push('');
    return cells.slice(0, n);
  });
  const hChar = ascii ? '-' : '─';
  const vChar = ascii ? '|' : '│';
  const avail = width - (3 * n + 1);
  if (avail < n) {
    // Too narrow for a grid: fall back to "header: value" lines.
    const out: string[] = [];
    rows.forEach((r, ri) => {
      if (ri > 0) out.push(c.hex(theme.border)(hChar.repeat(Math.max(1, width))));
      r.forEach((v, j) => out.push(...wrapDisplay(`${c.bold(header[j])}: ${v}`, width)));
    });
    return out;
  }
  const nat = header.map((h, j) => Math.max(1, displayWidth(h), ...rows.map((r) => displayWidth(r[j]))));
  const widths = distributeWidths(nat, avail);
  const aligns: Align[] = tok.align.map((a) => (a === 'right' ? 'right' : a === 'center' ? 'center' : 'left'));
  const border = c.hex(theme.border);
  const rule = (l: string, m: string, r: string): string => border(l + widths.map((w) => hChar.repeat(w + 2)).join(m) + r);
  const row = (cells: string[], head: boolean): string =>
    border(vChar) +
    cells
      .map((v, j) => {
        const fitted = padDisplay(v, widths[j], aligns[j] ?? 'left');
        return ` ${head ? c.bold.hex(theme.heading)(fitted) : fitted} `;
      })
      .join(border(vChar)) +
    border(vChar);
  const out = ascii
    ? [rule('+', '+', '+'), row(header, true), rule('+', '+', '+')]
    : [rule('┌', '┬', '┐'), row(header, true), rule('├', '┼', '┤')];
  for (const r of rows) out.push(row(r, false));
  out.push(ascii ? rule('+', '+', '+') : rule('└', '┴', '┘'));
  return out;
}

function renderBlock(tok: AnyToken, width: number, ctx: Ctx): string[] {
  const { c, theme, ascii } = ctx;
  const hChar = ascii ? '-' : '─';
  switch (tok.type) {
    case 'space':
    case 'def':
      return [];
    case 'heading': {
      const h = tok as unknown as Tokens.Heading;
      const text = inline(h.tokens, ctx);
      if (h.depth === 1) {
        return [...wrapBlock(c.bold.hex(theme.primary)(text), width), c.hex(theme.border)(hChar.repeat(width))];
      }
      if (h.depth === 2) return wrapBlock(c.bold.hex(theme.heading)(text), width);
      if (h.depth === 3) return wrapBlock(c.bold.hex(theme.accent)(text), width);
      return wrapBlock(c.hex(theme.accent)(text), width);
    }
    case 'paragraph':
      return wrapBlock(inline(tok.tokens, ctx), width);
    case 'text':
      return wrapBlock(tok.tokens && tok.tokens.length ? inline(tok.tokens, ctx) : renderTextRun(tok.text ?? '', ctx), width);
    case 'code':
      return renderCode(tok as unknown as Tokens.Code, width, ctx);
    case 'blockquote': {
      const inner = renderBlocks(tok.tokens ?? [], Math.max(1, width - 2), ctx, false);
      const bar = c.hex(theme.quote)(ascii ? '|' : '▎');
      return inner.map((l) => `${bar} ${c.hex(theme.quote)(l)}`);
    }
    case 'list':
      return renderList(tok as unknown as Tokens.List, width, ctx);
    case 'hr':
      return [c.hex(theme.border)(hChar.repeat(width))];
    case 'table':
      return renderTable(tok as unknown as Tokens.Table, width, ctx);
    case 'html': {
      const text = decodeEntities((tok.text ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).trim();
      return text ? wrapBlock(c.hex(theme.muted)(restoreMath(text, ctx)), width) : [];
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
    out.push(...lines);
    first = false;
  }
  return out;
}

function renderUncached(md: string, width: number, theme: ThemeTokens, mathOn: boolean, ascii: boolean): string[] {
  const { src, store } = protectMath(md.replace(/\r\n?/g, '\n'), mathOn);
  const ctx: Ctx = { theme, c: chalk, store, listDepth: 0, mathOn, ascii };
  let lines: string[];
  try {
    const tokens = marked.lexer(src, { gfm: true });
    lines = renderBlocks(tokens, width, ctx, false);
  } catch {
    lines = wrapDisplay(restoreMath(src, ctx), width);
  }
  const ellipsis = ascii ? '...' : '…';
  return lines.map((l) => (displayWidth(l) > width ? truncateDisplay(l, width, ellipsis) : l));
}

/** Render markdown to self-contained ANSI lines, each at most `opts.width` columns wide. */
export function renderMarkdownLines(md: string, opts: MarkdownRenderOptions): string[] {
  const width = Math.max(1, Math.floor(opts.width) || 1);
  const mathOn = opts.mathUnicode !== false;
  const ascii = opts.ascii === true;
  if (!md) return [];
  const key = `${width}\u0001${opts.theme.id}\u0001${mathOn ? 1 : 0}\u0001${ascii ? 1 : 0}\u0001${md}`;
  const cached = mdCache.get(key);
  if (cached) return cached.slice();
  const lines = renderUncached(md, width, opts.theme, mathOn, ascii);
  mdCache.set(key, lines);
  return lines.slice();
}

/** Render markdown to a single ANSI string (lines joined by `\n`). */
export function renderMarkdown(md: string, opts: MarkdownRenderOptions): string {
  return renderMarkdownLines(md, opts).join('\n');
}
