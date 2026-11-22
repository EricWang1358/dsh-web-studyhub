/**
 * Pure text charts for the TUI: progress bars, sparklines, bar charts, a GitHub-style study
 * heatmap and tree-line flattening. Every function returns strings with exact, CJK-aware widths.
 */
import defaultChalk, { Chalk, type ChalkInstance } from 'chalk';
import type { ThemeTokens } from '../theme/tokens.js';
import { displayWidth, padDisplay, truncateDisplay } from './cjk.js';

const chalk: ChalkInstance = new Chalk({ level: defaultChalk.level });

type ChartTheme = Pick<ThemeTokens, 'primary' | 'track' | 'muted' | 'dim' | 'heat'> & Partial<ThemeTokens>;

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

function clampRatio(r: number): number {
  if (typeof r !== 'number' || Number.isNaN(r)) return 0;
  return Math.min(1, Math.max(0, r));
}

/** Horizontal bar of `cols` columns filled to `ratio` using eighth-blocks (no track). */
function eighthBar(ratio: number, cols: number): { fill: string; filledCols: number } {
  if (cols <= 0) return { fill: '', filledCols: 0 };
  const eighths = Math.round(clampRatio(ratio) * cols * 8);
  const full = Math.floor(eighths / 8);
  const part = eighths % 8;
  let fill = '█'.repeat(full);
  let filledCols = full;
  if (part > 0 && full < cols) {
    fill += EIGHTHS[part];
    filledCols++;
  }
  return { fill, filledCols };
}

export interface ProgressBarOptions {
  style?: 'block' | 'line';
  showPercent?: boolean;
  /** Override fill colour (defaults to theme.primary). */
  color?: string;
  /** Use pure ASCII glyphs (`#`, `>`, `-`) instead of Unicode blocks/lines. */
  ascii?: boolean;
}

/** Progress bar of exactly `width` columns (including the optional ` 37%` label). */
export function renderProgressBar(
  ratio: number,
  width: number,
  theme: ChartTheme,
  opts: ProgressBarOptions = {},
): string {
  const total = Math.max(0, Math.floor(width) || 0);
  if (total === 0) return '';
  const r = clampRatio(ratio);
  const style = opts.style ?? 'block';
  const ascii = opts.ascii === true;
  const fillColor = chalk.hex(opts.color ?? theme.primary);
  const trackColor = chalk.hex(theme.track);
  let label = '';
  if (opts.showPercent) {
    label = ` ${String(Math.round(r * 100)).padStart(3, ' ')}%`;
    if (label.length >= total) {
      const trimmed = label.trimStart();
      return padDisplay(ascii ? truncateDisplay(trimmed, total, '') : trimmed, total, 'right');
    }
  }
  const barW = total - label.length;
  let bar: string;
  if (ascii) {
    const filled = Math.round(r * barW);
    const rest = barW - filled;
    if (style === 'line') {
      bar =
        fillColor('#'.repeat(filled)) +
        (rest > 0 ? trackColor((filled > 0 ? '>' : '-') + '-'.repeat(rest - 1)) : '');
    } else {
      bar = fillColor('#'.repeat(filled)) + trackColor('-'.repeat(rest));
    }
  } else if (style === 'line') {
    const filled = Math.round(r * barW);
    const rest = barW - filled;
    bar =
      fillColor('━'.repeat(filled)) +
      (rest > 0 ? trackColor((filled > 0 ? '╺' : '─') + '─'.repeat(rest - 1)) : '');
  } else {
    const { fill, filledCols } = eighthBar(r, barW);
    bar = fillColor(fill) + trackColor('░'.repeat(barW - filledCols));
  }
  return bar + (label ? chalk.hex(theme.muted)(label) : '');
}

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const SPARK_ASCII = ['_', '.', '-', '=', '+', '*', '#'];

export interface SparklineOptions {
  /** Use ASCII characters (`_.-=+*#`) instead of Unicode block elements. */
  ascii?: boolean;
}

function resample(values: number[], width: number): number[] {
  const n = values.length;
  if (width === n) return values.slice();
  const out: number[] = [];
  if (width < n) {
    for (let i = 0; i < width; i++) {
      const a = Math.floor((i * n) / width);
      const b = Math.max(a + 1, Math.floor(((i + 1) * n) / width));
      let sum = 0;
      for (let k = a; k < b; k++) sum += values[k];
      out.push(sum / (b - a));
    }
  } else {
    for (let i = 0; i < width; i++) out.push(values[Math.min(n - 1, Math.floor((i * n) / width))]);
  }
  return out;
}

/** Sparkline (`▁▂▃▄▅▆▇█` or ASCII `_.-=+*#`), optionally resampled to `width` columns. */
export function renderSparkline(values: number[], width?: number, opts: SparklineOptions = {}): string {
  if (!Array.isArray(values) || values.length === 0) return '';
  const clean = values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0));
  const w = width === undefined ? clean.length : Math.max(0, Math.floor(width) || 0);
  if (w === 0) return '';
  const chars = opts.ascii ? SPARK_ASCII : SPARK;
  const vals = resample(clean, w);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  if (max === min) return chars[Math.floor((chars.length - 1) / 2)].repeat(w);
  return vals.map((v) => chars[Math.round(((v - min) / (max - min)) * (chars.length - 1))]).join('');
}

export interface BarChartItem {
  label: string;
  value: number;
  color?: string;
}

export interface BarChartOptions {
  /** Use `#` instead of Unicode eighth-block characters. */
  ascii?: boolean;
}

function formatValue(v: number): string {
  if (!Number.isFinite(v)) return '0';
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(Math.abs(v) >= 100 ? 0 : 1);
}

/** Horizontal bar chart: one line per item, each exactly `width` columns. */
export function renderBarChart(
  items: BarChartItem[],
  width: number,
  theme: ChartTheme,
  opts: BarChartOptions = {},
): string[] {
  const total = Math.max(0, Math.floor(width) || 0);
  if (!items.length || total === 0) return [];
  const ascii = opts.ascii === true;
  const values = items.map((it) => (Number.isFinite(it.value) ? Math.max(0, it.value) : 0));
  const valueStrs = items.map((it) => formatValue(it.value));
  const valueW = Math.max(...valueStrs.map((s) => s.length));
  const maxLabel = Math.max(...items.map((it) => displayWidth(it.label)));
  let labelW = Math.min(maxLabel, Math.max(2, Math.floor(total * 0.3)));
  let barW = total - labelW - valueW - 2;
  if (barW < 1) {
    labelW = Math.max(0, labelW + barW - 1);
    barW = total - labelW - valueW - 2;
  }
  const maxV = Math.max(...values);
  const ellipsis = ascii ? '...' : '…';
  return items.map((it, i) => {
    if (barW < 1) {
      const narrow = `${truncateDisplay(it.label, Math.max(0, total - valueW - 1), ellipsis)} ${valueStrs[i]}`;
      return padDisplay(truncateDisplay(narrow, total, ascii ? '' : '…'), total);
    }
    const ratio = maxV > 0 ? values[i] / maxV : 0;
    let fill: string;
    let filledCols: number;
    if (ascii) {
      filledCols = Math.round(clampRatio(ratio) * barW);
      fill = '#'.repeat(filledCols);
    } else {
      ({ fill, filledCols } = eighthBar(ratio, barW));
    }
    const bar = chalk.hex(it.color ?? theme.primary)(fill) + ' '.repeat(barW - filledCols);
    const label = labelW > 0 ? padDisplay(truncateDisplay(it.label, labelW, ellipsis), labelW) : '';
    const line = `${label} ${bar} ${chalk.hex(theme.muted)(valueStrs[i].padStart(valueW, ' '))}`;
    return labelW > 0 ? line : padDisplay(truncateDisplay(line.slice(1), total, ascii ? '' : '…'), total);
  });
}

// ---------------------------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------------------------

export interface HeatmapDay {
  date: string;
  count: number;
}

export interface HeatmapOptions {
  /** Last day shown (YYYY-MM-DD); defaults to today (local). */
  endDate?: string;
  /** Show weekday labels column + month header row (default true). */
  showLabels?: boolean;
  /** Label language (default 'zh'). */
  locale?: 'zh' | 'en';
  /** Use pure ASCII heatmap cells (`.`, `:`, `o`, `O`, `#`) instead of Unicode shades. */
  ascii?: boolean;
}

const DAY_MS = 86_400_000;
const HEAT_CHARS = ['░', '▒', '▓', '█', '█'];
const HEAT_CHARS_ASCII = ['.', ':', 'o', 'O', '#'];
const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseDay(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function fmtDay(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

function todayUtcMidnight(): number {
  const d = new Date();
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * GitHub-style heatmap. Returns: [month header] + 7 weekday rows (Mon→Sun) + legend line.
 * Each week is one 2-column cell (`█ `). With `showLabels: false` the header row and weekday
 * column are omitted (7 rows + legend).
 */
export function renderHeatmap(
  days: HeatmapDay[],
  weeks: number,
  theme: ChartTheme,
  opts: HeatmapOptions = {},
): string[] {
  const nWeeks = Math.max(1, Math.floor(weeks) || 1);
  const showLabels = opts.showLabels !== false;
  const zh = (opts.locale ?? 'zh') === 'zh';
  const end = (opts.endDate && parseDay(opts.endDate)) || todayUtcMidnight();
  const endDow = (new Date(end).getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const start = end - endDow * DAY_MS - (nWeeks - 1) * 7 * DAY_MS;

  const counts = new Map<string, number>();
  for (const d of days ?? []) {
    const t = parseDay(d.date);
    if (t === null || !Number.isFinite(d.count)) continue;
    const key = fmtDay(t);
    counts.set(key, (counts.get(key) ?? 0) + Math.max(0, d.count));
  }
  const visible: number[] = [];
  for (let t = start; t <= end; t += DAY_MS) {
    const v = counts.get(fmtDay(t)) ?? 0;
    if (v > 0) visible.push(v);
  }
  visible.sort((a, b) => a - b);
  const q1 = quantile(visible, 0.25);
  const q2 = quantile(visible, 0.5);
  const q3 = quantile(visible, 0.75);
  const level = (v: number): number => {
    if (v <= 0) return 0;
    if (v <= q1) return 1;
    if (v <= q2) return 2;
    if (v <= q3) return 3;
    return 4;
  };
  const heatChars = opts.ascii ? HEAT_CHARS_ASCII : HEAT_CHARS;
  const cell = (lv: number): string => chalk.hex(theme.heat[lv] ?? theme.primary)(heatChars[lv]);

  const dayLabels = zh ? ['一', '', '三', '', '五', '', ''] : ['Mon', '', 'Wed', '', 'Fri', '', ''];
  const labelW = showLabels ? (zh ? 3 : 4) : 0;
  const gridW = nWeeks * 2;

  const lines: string[] = [];
  if (showLabels) {
    let header = ' '.repeat(labelW);
    let cursor = labelW;
    let prevMonth = -1;
    for (let w = 0; w < nWeeks; w++) {
      const month = new Date(start + w * 7 * DAY_MS).getUTCMonth();
      if (month !== prevMonth) {
        const x = labelW + w * 2;
        const name = zh ? `${month + 1}月` : EN_MONTHS[month];
        const nameW = displayWidth(name);
        if (x >= cursor && x + nameW <= labelW + gridW) {
          header += ' '.repeat(x - cursor) + name;
          cursor = x + nameW;
        }
        prevMonth = month;
      }
    }
    lines.push(chalk.hex(theme.muted)(padDisplay(header, labelW + gridW)));
  }
  for (let dow = 0; dow < 7; dow++) {
    let row = showLabels ? chalk.hex(theme.muted)(padDisplay(dayLabels[dow], labelW)) : '';
    for (let w = 0; w < nWeeks; w++) {
      const t = start + (w * 7 + dow) * DAY_MS;
      row += t > end ? '  ' : `${cell(level(counts.get(fmtDay(t)) ?? 0))} `;
    }
    lines.push(row);
  }
  const legend = `${zh ? '少' : 'Less'} ${[0, 1, 2, 4].map((lv) => cell(lv)).join('')} ${zh ? '多' : 'More'}`;
  const legendLine = ' '.repeat(labelW) + chalk.hex(theme.muted)(legend);
  lines.push(padDisplay(opts.ascii ? truncateDisplay(legendLine, labelW + gridW, '...') : legendLine, labelW + gridW));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------------------------

export interface TreeNode {
  id: string;
  label: string;
  children?: TreeNode[];
  meta?: string;
}

export interface TreeLine {
  id: string;
  depth: number;
  text: string;
  selected: boolean;
  hasChildren: boolean;
  expanded: boolean;
}

export interface TreeLinesOptions {
  /** Use ASCII tree connectors (`|-- `, `\\-- `, `|  `, `>`/`v`) instead of Unicode box drawing. */
  ascii?: boolean;
}

/**
 * Flatten visible tree nodes into plain-text lines (no ANSI) with `├─ ` / `└─ ` / `│  ` guides
 * (or ASCII `|-- ` / `\-- ` / `|   `) and `▸`/`▾` (or `>`/`v`) markers. `meta` is right-aligned
 * when it fits.
 */
export function renderTreeLines(
  nodes: TreeNode[],
  expandedIds: ReadonlySet<string> | string[],
  selectedId: string | null,
  width: number,
  opts: TreeLinesOptions = {},
): TreeLine[] {
  const expanded: ReadonlySet<string> = Array.isArray(expandedIds) ? new Set(expandedIds) : expandedIds;
  const maxW = Math.max(1, Math.floor(width) || 1);
  const ascii = opts.ascii === true;
  const ellipsis = ascii ? '...' : '…';
  const out: TreeLine[] = [];

  const walk = (list: TreeNode[], depth: number, guides: string): void => {
    list.forEach((node, idx) => {
      const last = idx === list.length - 1;
      const hasChildren = Array.isArray(node.children) && node.children.length > 0;
      const isExpanded = hasChildren && expanded.has(node.id);
      const connector = depth === 0 ? '' : ascii ? (last ? '\\-- ' : '|-- ') : last ? '└─ ' : '├─ ';
      const marker = hasChildren
        ? ascii
          ? isExpanded
            ? 'v '
            : '> '
          : isExpanded
            ? '▾ '
            : '▸ '
        : depth === 0
          ? '  '
          : '';
      const left = `${guides}${connector}${marker}${node.label}`;
      let text: string;
      const meta = node.meta ?? '';
      const metaW = displayWidth(meta);
      if (meta && displayWidth(left) + 1 + metaW <= maxW) {
        text = `${padDisplay(left, maxW - metaW)}${meta}`;
      } else if (meta && maxW - metaW - 1 >= displayWidth(`${guides}${connector}${marker}`) + 2) {
        text = `${padDisplay(truncateDisplay(left, maxW - metaW - 1, ellipsis), maxW - metaW)}${meta}`;
      } else {
        text = truncateDisplay(left, maxW, ellipsis);
      }
      out.push({ id: node.id, depth, text, selected: node.id === selectedId, hasChildren, expanded: isExpanded });
      if (isExpanded && node.children) {
        const nextGuide = ascii ? (last ? '    ' : '|   ') : last ? '   ' : '│  ';
        walk(node.children, depth + 1, depth === 0 ? guides : guides + nextGuide);
      }
    });
  };
  walk(nodes ?? [], 0, '');
  return out;
}
