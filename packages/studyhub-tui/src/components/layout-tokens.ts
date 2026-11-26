/**
 * Compatibility facade re-exporting centralized TUI layout breakpoints and chrome dimensions
 * from `../layout/breakpoints.js` (#1354 P2-a / D5).
 */
import { glyph } from '../render/glyphs.js';

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
  computeFilterBarLayout,
  clampModalFrame,
  type ContentTier,
  type PaneTier,
  type FilterBarLayout,
  type ClampedModalFrame,
} from '../layout/breakpoints.js';

export function ellipsisGlyph(asciiMode: boolean): string {
  return glyph('ellipsis', asciiMode);
}
