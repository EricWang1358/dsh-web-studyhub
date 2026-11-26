/**
 * StudyHub TUI layout foundation barrel (#1354 P2 D5).
 * Single entry point for content-width breakpoints and `<Prose>` / `<ScrollArea>` / `<ChromeLabel>`.
 */
export {
  CONTENT_TIERS,
  LAYOUT_BP,
  LAYOUT_CHROME,
  resolveContentTier,
  isNarrowContent,
  isCompactContent,
  isWideContent,
  isViewportTooSmall,
  resolvePaneBreakpoint,
  ellipsisGlyph,
  computeFilterBarLayout,
  clampModalFrame,
  type ContentTier,
  type PaneTier,
  type FilterBarLayout,
  type ClampedModalFrame,
} from './breakpoints.js';
export {
  ChromeLabel,
  Prose,
  ProseContainer,
  SectionHeader,
  PageHeader,
  computeProseLayout,
  resolveDensitySpacing,
  GRID_GUTTER,
  PAGE_PADDING_X,
  SECTION_GAP,
  PROSE_MAX_COLS,
  type ChromeLabelProps,
  type ProseProps,
  type ProseContainerProps,
  type ProseLayout,
  type SectionHeaderProps,
  type PageHeaderProps,
  type DensityMode,
  type DensitySpacing,
} from '../components/Layout.js';
export { ScrollArea, type ScrollAreaProps } from '../components/ScrollArea.js';
