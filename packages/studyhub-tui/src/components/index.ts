/**
 * StudyHub TUI component kit (Ink 8). Import everything from `../../components/index.js`.
 *
 * Keyboard contract: every interactive component takes `isActive` and passes it to
 * `useInput(..., { isActive })`, so overlays/hidden panes never leak keystrokes.
 * Focused text inputs & modals hold a ref-counted capture (`store.inputCaptured`),
 * which makes AppShell suppress all global single-key shortcuts.
 */
export { Panel, type PanelProps } from './Panel.js';
export {
  VirtualList,
  scrollbarThumb,
  nextScrollOffset,
  type VirtualListProps,
  type VirtualListRenderContext,
} from './VirtualList.js';
export { TextInput, type TextInputProps } from './TextInput.js';
export { SelectList, type SelectListProps, type SelectOption } from './SelectList.js';
export { ScrollView, highlightLine, type ScrollViewProps } from './ScrollView.js';
export { ScrollArea, type ScrollAreaProps } from './ScrollArea.js';
export {
  ChromeLabel,
  Prose,
  ProseContainer,
  computeProseLayout,
  type ChromeLabelProps,
  type ProseProps,
  type ProseContainerProps,
  type ProseLayout,
} from './Layout.js';
export { MarkdownView, type MarkdownViewProps } from './MarkdownView.js';
export { SplitPane, computeSplit, type SplitPaneProps, type PaneSize, type PaneContent } from './SplitPane.js';
export { Modal, modalContentWidth, type ModalProps } from './Modal.js';
export { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog.js';
export {
  Badge,
  StatusPill,
  ProgressBar,
  Spinner,
  SPINNER_FRAMES,
  EmptyState,
  KeyHintBar,
  ToastStack,
  Divider,
  type BadgeProps,
  type StatusPillProps,
  type PillStatus,
  type ProgressBarProps,
  type SpinnerProps,
  type EmptyStateProps,
  type KeyHintBarProps,
  type ToastStackProps,
  type DividerProps,
} from './Badge.js';
export {
  useInputCapture,
  acquireInputCapture,
  useClaimKeys,
  claimKeys,
  isKeyClaimed,
  DIGIT_KEYS,
} from './focus.js';
export { useFooterHints } from './hooks.js';
export {
  createStreamingCoalescer,
  useStreamingBuffer,
  type StreamingCoalescer,
  type StreamingBufferResult,
} from './useStreamingBuffer.js';
export { useTheme, getTheme, toneColor, type ThemeTokens, type Tone } from '../theme/tokens.js';
