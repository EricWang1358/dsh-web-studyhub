/* StudyHub component library (plan §4, C1). Import from here:
   import { Button, Dialog, FileDrop } from './components/index.js'; */
export { Button, IconButton } from './Button.jsx';
export { default as SegmentedControl } from './SegmentedControl.jsx';
export { default as PageHeader } from './PageHeader.jsx';
export { default as EmptyState } from './EmptyState.jsx';
export { Panel, Disclosure } from './Panel.jsx';
export { default as Icon, ICON_NAMES } from './Icon.jsx';
export { Toast, ToastRegion, InlineMessage, Banner, shouldAutoDismiss, TOAST_TIMEOUT } from './Feedback.jsx';
export { default as SetupRequired } from './SetupRequired.jsx';
export { default as FileDrop, partitionFiles, formatBytes, describeAccept, createDropHandlers, guardFileDrag } from './FileDrop.jsx';
export { default as Dialog } from './Dialog.jsx';
export { useTopDialog } from './dialog-stack.js';
export { default as ScrollWindow, filterItems, scrollWindowCount, scrollEdges, edgeTracker } from './ScrollWindow.jsx';
export { Badge, Chip } from './Badge.jsx';
export { Hint } from './Hint.jsx';
export { ProgressBar, StackedBar } from './Progress.jsx';
export { Spinner, LoadingState } from './Loading.jsx';
export { ErrorState, CrashFallback, errorText } from './ErrorState.jsx';
export { JobRow, jobAnnouncement } from './JobRow.jsx';
export { useNow, createClock } from './use-now.js';
export { TONES, toneOf, TONE_ICONS } from './tones.js';
