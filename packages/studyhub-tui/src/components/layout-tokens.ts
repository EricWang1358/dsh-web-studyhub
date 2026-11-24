/**
 * Centralized TUI layout breakpoints, chrome dimensions, and pure layout math (#1354 P2-a).
 *
 * All shell components, modals, and views should consume these constants/helpers rather than
 * hand-computing breakpoints, sidebar widths, modal padding, or filter-bar dimensions.
 */
import { displayWidth } from '../render/cjk.js';
import type { UiLanguage } from '../types/contracts.js';

/** Canonical viewport / pane width breakpoints (columns). */
export const LAYOUT_BP = Object.freeze({
  /** Filter bar shows short `Esc` hint at/above this width. */
  FILTER_SHORT: 46,
  /** Filter bar shows full `Enter apply | Esc clear` hint at/above this width. */
  FILTER_FULL: 66,
  /** Docked assistant switches to side-by-side layout at/above this inner width. */
  DOCK_SIDE_BY_SIDE: 78,
  /** Default SplitPane collapse threshold (120-col terminal minus 24-col rail = 94). */
  SPLIT_DEFAULT: 86,
  /** Narrow pane threshold for compact toolbars / stacked secondary panes. */
  NARROW: 88,
  /** Compact detail/master threshold. */
  COMPACT: 90,
  /** Wide pane threshold for multi-column badges / prose measure. */
  WIDE: 96,
  /** Terminal width below which SideNav auto-collapses to icon rail. */
  SIDENAV_AUTO_COLLAPSE: 100,
  /** Review AI drawer side-by-side threshold. */
  AI_DRAWER_SIDE: 104,
  /** Extra-wide dashboard / table threshold. */
  EXTRA_WIDE: 110,
});

/** Canonical structural chrome dimensions (columns / rows). */
export const LAYOUT_CHROME = Object.freeze({
  SIDENAV_EXPANDED: 24,
  SIDENAV_COLLAPSED: 6,
  MODAL_DEFAULT_WIDTH: 72,
  MODAL_MIN_WIDTH: 24,
  MODAL_MARGIN_X: 4,
  MODAL_MARGIN_Y: 2,
  /** Modal border (2) + outer paddingX (2) + body paddingX (2). */
  MODAL_CHROME_X: 6,
  /** Standard Panel border (2) + default paddingX (2). */
  PANEL_CHROME_X: 4,
  /** Comfortable reading measure cap on ultrawide terminals. */
  PROSE_MAX_COLS: 96,
  GRID_GUTTER: 1,
  PAGE_PADDING_X: 1,
  SECTION_GAP: 1,
});

export type PaneTier = 'narrow' | 'medium' | 'wide' | 'xwide';

export function resolvePaneBreakpoint(width: number): {
  isNarrow: boolean;
  isCompact: boolean;
  isWide: boolean;
  isExtraWide: boolean;
  tier: PaneTier;
} {
  const isNarrow = width < LAYOUT_BP.NARROW;
  const isCompact = width < LAYOUT_BP.COMPACT;
  const isWide = width >= LAYOUT_BP.WIDE;
  const isExtraWide = width >= LAYOUT_BP.EXTRA_WIDE;
  const tier: PaneTier = isExtraWide ? 'xwide' : isWide ? 'wide' : isNarrow ? 'narrow' : 'medium';
  return { isNarrow, isCompact, isWide, isExtraWide, tier };
}

export function ellipsisGlyph(asciiMode: boolean): string {
  return asciiMode ? '...' : '…';
}

export interface FilterBarLayout {
  rightHint: string;
  inputWidth: number;
}

/**
 * Compute consistent inline filter-bar right hint and TextInput width across all list views.
 */
export function computeFilterBarLayout(
  width: number,
  badgeText: string,
  lang: UiLanguage,
  editing: boolean,
  extraReserve = 5,
): FilterBarLayout {
  const zh = lang === 'zh';
  const rightHint =
    width >= LAYOUT_BP.FILTER_FULL
      ? ` ${editing ? (zh ? 'Enter 确认 | Esc 清除' : 'Enter apply | Esc clear') : zh ? '/ 编辑 | Esc 清除' : '/ edit | Esc clear'}`
      : width >= LAYOUT_BP.FILTER_SHORT
        ? ' Esc'
        : '';
  const inputWidth = Math.max(8, width - displayWidth(badgeText) - displayWidth(rightHint) - extraReserve);
  return { rightHint, inputWidth };
}

export interface ClampedModalFrame {
  frameWidth: number;
  frameHeight: number;
  innerWidth: number;
  innerHeight: number;
}

/**
 * Clamp a modal frame cleanly to the current terminal viewport using centralized chrome margins.
 */
export function clampModalFrame(
  columns: number,
  rows: number,
  opts: {
    maxWidth?: number;
    minWidth?: number;
    maxHeight?: number;
    minHeight?: number;
    headerFooterRows?: number;
  } = {},
): ClampedModalFrame {
  const maxW = opts.maxWidth ?? LAYOUT_CHROME.MODAL_DEFAULT_WIDTH;
  const minW = opts.minWidth ?? LAYOUT_CHROME.MODAL_MIN_WIDTH;
  const availW = Math.max(LAYOUT_CHROME.MODAL_MIN_WIDTH, columns - LAYOUT_CHROME.MODAL_MARGIN_X);
  const frameWidth = Math.min(availW, Math.max(minW, Math.min(maxW, availW)));

  const availH = Math.max(10, rows - LAYOUT_CHROME.MODAL_MARGIN_Y);
  const maxH = opts.maxHeight ?? availH;
  const minH = opts.minHeight ?? 10;
  const frameHeight = Math.min(availH, Math.max(minH, Math.min(maxH, availH)));

  const innerWidth = Math.max(10, frameWidth - LAYOUT_CHROME.MODAL_CHROME_X);
  const innerHeight = Math.max(4, frameHeight - (opts.headerFooterRows ?? 5));
  return { frameWidth, frameHeight, innerWidth, innerHeight };
}
