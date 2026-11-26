import React, { Suspense, lazy, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useApp } from 'ink';
import { PAGE_REGISTRY, type CommandPaletteItem, type HostClient, type PageId, type ViewProps } from '../types/contracts.js';
import { t, useTuiStore } from '../state/store.js';
import { useTheme } from '../theme/tokens.js';
import { glyph } from '../render/glyphs.js';
import { KeyHintBar, Spinner, ToastStack, estimateToastStackHeight } from '../components/Badge.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { RESERVED_GLOBAL_KEY_SET, isKeyClaimed, resolveShellFooterHints, useContextualFooterTip, useModalHints } from '../components/focus.js';
import { KEY_LAYER_GLOBAL, KEY_LAYER_SYSTEM, KeyScopeProvider, useKeyDispatcherBridge, useScopedInput } from '../components/key-dispatcher.js';
import { LAYOUT_BP, isViewportTooSmall } from '../components/layout-tokens.js';
import { useMouseClickInputFallback } from '../components/mouse.js';
import { useStableWindowSize } from '../components/resize.js';
import { TopBar } from './TopBar.js';
import { SideNav, sideNavWidth } from './SideNav.js';
import { ShellActionsContext, createDefaultShellActions, requestQuit, type ShellActions } from './actions.js';
import { isLibraryEmpty } from './data.js';
import { formatReturnHintLabel } from '../state/practice-stack.js';

const Launchpad = lazy(() => import('./Launchpad.js').then((m) => ({ default: m.Launchpad })));
const CommandPalette = lazy(() => import('./CommandPalette.js').then((m) => ({ default: m.CommandPalette })));
const HelpOverlay = lazy(() => import('./HelpOverlay.js').then((m) => ({ default: m.HelpOverlay })));
const CoursePickerModal = lazy(() => import('./CoursePickerModal.js').then((m) => ({ default: m.CoursePickerModal })));
const InboxModal = lazy(() => import('./InboxModal.js').then((m) => ({ default: m.InboxModal })));
const NotificationHistoryModal = lazy(() =>
  import('./NotificationHistoryModal.js').then((m) => ({ default: m.NotificationHistoryModal })),
);
const AssistantPanel = lazy(() => import('./AssistantPanel.js').then((m) => ({ default: m.AssistantPanel })));

export interface VoicePackRenderProps {
  isActive: boolean;
  onClose: () => void;
  width: number;
  height: number;
}

export interface AppShellProps {
  host: HostClient;
  /** Render the active page into the main viewport. */
  renderPage: (page: PageId, view: ViewProps) => ReactNode;
  /** Override default shell actions (refresh / sample / course switching / quit …). */
  actions?: Partial<ShellActions>;
  /** Extra command-palette entries. */
  extraCommands?: readonly CommandPaletteItem[];
  /** Renderer for the `/voicepack` overlay (store.voicePackOpen). */
  renderVoicePack?: (props: VoicePackRenderProps) => ReactNode;
  /** Extra overlay nodes rendered above everything. */
  overlays?: ReactNode;
  /** Auto-open the Launchpad when the first snapshot shows an empty library (default true). */
  autoLaunchpad?: boolean;
}

/** Page cycle order for `[` / `]`. */
const NAV_ORDER: readonly PageId[] = PAGE_REGISTRY.filter((p) => p.group !== null).map((p) => p.id);
const SHORTCUTS = new Map<string, PageId>(PAGE_REGISTRY.map((p) => [p.shortcut, p.id]));

/** Pure layout math for the shell, exported for tests and the App. */
/**
 * Width of the assistant dock when it sits beside the page (#1411): just under half of the
 * area right of the sidebar, capped so the page keeps most of a very wide terminal.
 */
export function assistantDockWidth(availableW: number): number {
  return Math.min(ASSISTANT_DOCK_MAX_W, Math.max(ASSISTANT_DOCK_MIN_W, Math.floor(availableW * ASSISTANT_DOCK_RATIO)));
}
const ASSISTANT_DOCK_RATIO = 0.46;
const ASSISTANT_DOCK_MIN_W = 36;
const ASSISTANT_DOCK_MAX_W = 66;

export function shellLayout(columns: number, rows: number, opts: { sidebarCollapsed: boolean; showKeyHints: boolean; launchpad?: boolean }) {
  const navW = opts.launchpad ? 0 : sideNavWidth(columns, opts.sidebarCollapsed);
  const bodyH = Math.max(3, rows - 1 - (opts.showKeyHints ? 1 : 0));
  const contentW = Math.max(20, columns - navW - 2);
  return { navW, bodyH, contentW, contentH: bodyH };
}

export const AppShell = memo(function AppShell({
  host,
  renderPage,
  actions: actionOverrides,
  extraCommands,
  renderVoicePack,
  overlays,
  autoLaunchpad = true,
}: AppShellProps) {
  const { exit } = useApp();
  const { columns, rows } = useStableWindowSize();

  const page = useTuiStore((s) => s.page);
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const sidebarCollapsed = useTuiStore((s) => s.preferences.sidebarCollapsed);
  const showKeyHints = useTuiStore((s) => s.preferences.showKeyHints);
  const inputCaptured = useTuiStore((s) => s.inputCaptured);
  const paletteOpen = useTuiStore((s) => s.commandPaletteOpen);
  const helpOpen = useTuiStore((s) => s.helpOpen);
  const courseOpen = useTuiStore((s) => s.coursePickerOpen);
  const inboxOpen = useTuiStore((s) => s.inboxOpen);
  const notificationHistoryOpen = useTuiStore((s) => s.notificationHistoryOpen);
  const voiceOpen = useTuiStore((s) => s.voicePackOpen);
  const quitConfirmOpen = useTuiStore((s) => s.quitConfirmOpen);
  const assistantOpen = useTuiStore((s) => s.assistantOpen);
  const assistantFocused = useTuiStore((s) => s.assistantFocused);
  const assistantFullscreen = useTuiStore((s) => s.assistantFullscreen);
  const practiceStack = useTuiStore((s) => s.practiceStack);
  const showLaunchpad = useTuiStore((s) => s.showLaunchpad);
  const toasts = useTuiStore((s) => s.toasts);
  const footerHints = useTuiStore((s) => s.footerHints);
  const loading = useTuiStore((s) => s.loading);
  const refreshing = useTuiStore((s) => s.refreshing);
  const snapshot = useTuiStore((s) => s.snapshot);
  const dismissToast = useTuiStore((s) => s.dismissToast);
  const keystrokeCountRef = useRef(0);
  const [tipRotation, setTipRotation] = useState(0);

  const rawQuitRef = useRef<() => void>(() => exit());
  rawQuitRef.current = actionOverrides?.quit ?? (() => exit());

  const actions = useMemo<ShellActions>(
    () => ({
      ...createDefaultShellActions(host, () => rawQuitRef.current()),
      ...actionOverrides,
      quit: () => requestQuit(rawQuitRef.current),
    }),
    [host, actionOverrides],
  );

  // First-run Launchpad.
  const launchpadChecked = useRef(false);
  useEffect(() => {
    if (!autoLaunchpad || launchpadChecked.current || loading || !snapshot) return;
    launchpadChecked.current = true;
    if (isLibraryEmpty(snapshot)) useTuiStore.getState().setShowLaunchpad(true);
  }, [autoLaunchpad, loading, snapshot]);

  const voiceOverlay = voiceOpen && Boolean(renderVoicePack);
  // Right-docked passive assistant (`assistantOpen && !assistantFocused && !assistantFullscreen`) NEVER steals focus!
  const assistantCapturesFocus = assistantOpen && (assistantFocused || assistantFullscreen);
  const shellModalOpen =
    paletteOpen || helpOpen || courseOpen || inboxOpen || notificationHistoryOpen || voiceOverlay || quitConfirmOpen;
  const assistantScopeActive = assistantCapturesFocus && !shellModalOpen;
  const overlayOpen = shellModalOpen || assistantCapturesFocus;

  // Render-time snapshot of routing state: every useInput handler for ONE keystroke sees
  // the state from BEFORE that keystroke (so closing an overlay with `?` never reopens it).
  const routing = useRef({ overlayOpen, inputCaptured, showLaunchpad });
  routing.current = { overlayOpen, inputCaptured, showLaunchpad };

  const { navW, bodyH, contentW: fullContentW } = shellLayout(columns, rows, {
    sidebarCollapsed,
    showKeyHints,
    launchpad: showLaunchpad || (assistantOpen && assistantFullscreen),
  });
  const dockActive = assistantOpen && !assistantFullscreen && !showLaunchpad;
  const dockSideBySide = dockActive && columns - navW >= LAYOUT_BP.DOCK_SIDE_BY_SIDE;
  const dockW = dockSideBySide ? assistantDockWidth(columns - navW) : Math.max(20, columns - navW - 2);
  const dockH = dockSideBySide ? bodyH : Math.max(8, Math.floor(bodyH * 0.42));
  const contentW = dockSideBySide ? Math.max(24, columns - navW - dockW - 2) : fullContentW;
  const contentH = dockActive && !dockSideBySide ? Math.max(6, bodyH - dockH) : bodyH;
  useMouseClickInputFallback(true);
  useKeyDispatcherBridge(true);

  useScopedInput(
    (input, key) => {
      keystrokeCountRef.current += 1;
      if (keystrokeCountRef.current % 10 === 0) {
        setTipRotation((n) => n + 1);
      }
      const s = useTuiStore.getState();
      const r = routing.current;
      if (key.ctrl && input === 'c') {
        if (s.quitConfirmOpen) {
          s.setQuitConfirmOpen(false);
          rawQuitRef.current();
        } else {
          actions.quit();
        }
        return true;
      }
      if (key.ctrl && input === 'k') {
        if (s.commandPaletteOpen) {
          s.setCommandPaletteOpen(false);
          return true;
        }
        if (!r.overlayOpen && !r.inputCaptured) {
          s.setCommandPaletteOpen(true);
          return true;
        }
        return false;
      }
      // Ctrl+Space (NUL `\x00` or Ctrl+@ / Ctrl+Space) opens docked WITHOUT stealing focus; 2nd press focuses; 3rd collapses!
      const isCtrlSpace = input === '\u0000' || (key.ctrl && (input === ' ' || input === '@'));
      if (isCtrlSpace) {
        if (!s.assistantOpen) {
          if (!r.overlayOpen && !r.inputCaptured) {
            s.openAssistant({ focused: false });
            return true;
          }
          return false;
        }
        if (!s.assistantFocused && !s.assistantFullscreen) {
          s.setAssistantFocused(true);
        } else {
          s.closeAssistant();
        }
        return true;
      }
      if (key.ctrl && input === 'g') {
        if (s.assistantOpen && (s.assistantFocused || s.assistantFullscreen)) {
          s.closeAssistant();
          return true;
        }
        if (!r.overlayOpen && !r.inputCaptured) {
          s.openAssistant({ focused: true });
          return true;
        }
        return false;
      }
      if (key.ctrl && input === 'o') {
        if (!r.overlayOpen && !r.inputCaptured) {
          s.setNotificationHistoryOpen(true);
          return true;
        }
        return false;
      }
      if (key.ctrl && input === 'r') {
        void actions.refresh();
        // Allow the active view (e.g. BoardView, BookView) to also reload its domain state.
        return false;
      }
      return false;
    },
    { isActive: true, layer: KEY_LAYER_SYSTEM, id: 'AppShell:system' },
  );

  useScopedInput(
    (input, key) => {
      const s = useTuiStore.getState();
      const r = routing.current;
      if (r.overlayOpen || r.inputCaptured) return false;
      if (key.ctrl || key.meta) return false;
      // #1428: unified 2-step Esc across every docked page — when no modal/filter/view handler
      // consumed Esc, fold the passive assistant dock cleanly without leaving the current page.
      if (key.escape) {
        if (s.assistantOpen && !s.assistantFocused && !s.assistantFullscreen) {
          s.closeAssistant();
          return true;
        }
        return false;
      }
      if (input && !RESERVED_GLOBAL_KEY_SET.has(input) && isKeyClaimed(input)) return false;
      if (key.backspace) {
        if (!isKeyClaimed('backspace')) {
          s.goBack();
          return true;
        }
        return false;
      }
      switch (input) {
        case '/':
          s.setCommandPaletteOpen(true);
          return true;
        case '?':
          s.setHelpOpen(true);
          return true;
        case 'c':
          s.setCoursePickerOpen(true);
          return true;
        case 'I':
          s.setInboxOpen(true);
          return true;
        case 'q':
          actions.quit();
          return true;
        case '\\':
          s.toggleSidebar();
          return true;
        case '[':
        case ']': {
          const idx = NAV_ORDER.indexOf(s.page);
          const dir = input === ']' ? 1 : -1;
          const next = NAV_ORDER[(Math.max(0, idx) + dir + NAV_ORDER.length) % NAV_ORDER.length];
          s.navigate(next);
          return true;
        }
        default:
          break;
      }
      if (r.showLaunchpad && (input === 's' || input === 'i' || input === 'm')) return false;
      const target = SHORTCUTS.get(input);
      if (target) {
        if (target === 'review') {
          if (s.practiceStack.length > 0) {
            s.returnViaPracticeStack();
            return true;
          }
          if (s.page === 'review' && (!s.activeRunId || s.navContext.runId === s.activeRunId)) return true;
          if (s.activeRunId) s.navigate('review', { runId: s.activeRunId });
          else {
            const focusCourse = typeof s.snapshot?.focus?.course === 'string' && s.snapshot.focus.course ? s.snapshot.focus.course : undefined;
            s.navigate('review', focusCourse ? { course: focusCourse } : {});
          }
          return true;
        }
        // Preserve intermediate reader location in stack if leaving sources while a practice stack is active (#1319)
        if (s.practiceStack.length > 0 && s.page === 'sources' && target !== 'sources' && s.navContext.sourceId) {
          s.pushPracticeContext({
            kind: 'page',
            returnPage: 'sources',
            navContext: { ...s.navContext },
            readingPos: {
              sourceId: s.navContext.sourceId,
              pageNumber: s.navContext.pageNumber,
            },
            originKind: 'source',
            pushedAt: Date.now(),
          });
        }
        s.navigate(target);
        return true;
      }
      return false;
    },
    { isActive: true, layer: KEY_LAYER_GLOBAL, id: 'AppShell:global' },
  );

  const contentActive = !overlayOpen && !showLaunchpad;
  const view: ViewProps = useMemo(
    () => ({ host, width: contentW, height: contentH, isActive: contentActive }),
    [host, contentW, contentH, contentActive],
  );

  const compactMode = useTuiStore((s) => Boolean(s.preferences.compactMode));
  const modalHints = useModalHints();
  const practiceReturnLabel = useMemo(() => formatReturnHintLabel(practiceStack, lang), [practiceStack, lang]);
  const hints = useMemo(
    () =>
      resolveShellFooterHints({
        modalHints,
        footerHints,
        inputCaptured,
        overlayOpen,
        compactMode,
        practiceReturnLabel,
        lang,
      }),
    [modalHints, footerHints, inputCaptured, overlayOpen, compactMode, practiceReturnLabel, lang],
  );

  const contextualTipText = useContextualFooterTip(
    overlayOpen || showLaunchpad || inputCaptured || Boolean(modalHints && modalHints.length > 0),
    tipRotation,
  );

  const toastW = Math.min(52, Math.max(28, Math.floor(columns * 0.45)));
  const toastRows = Math.min(Math.max(1, rows - 3), estimateToastStackHeight(toasts, toastW, asciiMode));
  const toastTop = Math.max(1, rows - (showKeyHints ? 1 : 0) - toastRows);
  // Below 60x18 the shell stays mounted and a notice is drawn over it instead: unmounting would
  // throw away in-progress input, cursor and scroll positions, and would drop the quit guards that
  // pages register, so `q` would exit without the unsaved-work confirmation (#1452).
  const tooSmall = isViewportTooSmall(columns, rows);
  let main: ReactNode;
  if (showLaunchpad) {
    main = (
      <Suspense fallback={null}>
        <Launchpad width={columns - 2} height={bodyH} isActive={!overlayOpen} />
      </Suspense>
    );
  } else if (loading && !snapshot) {
    const ell = glyph('ellipsis', asciiMode);
    main = (
      <Box width={contentW} height={bodyH} alignItems="center" justifyContent="center">
        <Spinner label={t(lang, `正在打开学习库${ell}`, `Opening library${ell}`)} />
      </Box>
    );
  } else {
    main = renderPage(page, view);
  }

  return (
    <ShellActionsContext.Provider value={actions}>
      <Box flexDirection="column" width={columns} height={rows}>
        <TopBar width={columns} />
        <Box flexDirection="row" height={bodyH} width={columns}>
          {navW > 0 ? <SideNav width={navW} height={bodyH} /> : null}
          {assistantOpen && assistantFullscreen ? (
            <Box flexDirection="column" width={columns - navW} height={bodyH} paddingX={1} overflow="hidden">
              <KeyScopeProvider opaque={assistantScopeActive}>
                <Suspense fallback={null}>
                  <AssistantPanel
                    host={host}
                    isActive={
                      !paletteOpen && !helpOpen && !courseOpen && !inboxOpen && !notificationHistoryOpen && !quitConfirmOpen
                    }
                    width={Math.max(40, columns - navW - 2)}
                    height={bodyH}
                    docked
                    onClose={() => useTuiStore.getState().closeAssistant()}
                  />
                </Suspense>
              </KeyScopeProvider>
            </Box>
          ) : dockSideBySide ? (
            <Box flexDirection="row" width={columns - navW} height={bodyH} paddingX={1} overflow="hidden">
              <Box flexDirection="column" width={contentW} height={bodyH} overflow="hidden">
                {main}
              </Box>
              <KeyScopeProvider opaque={assistantScopeActive}>
                <Suspense fallback={null}>
                  <AssistantPanel
                    host={host}
                    isActive={
                      assistantFocused &&
                      !paletteOpen &&
                      !helpOpen &&
                      !courseOpen &&
                      !inboxOpen &&
                      !notificationHistoryOpen &&
                      !quitConfirmOpen
                    }
                    width={dockW}
                    height={bodyH}
                    docked
                    onClose={() => useTuiStore.getState().closeAssistant()}
                  />
                </Suspense>
              </KeyScopeProvider>
            </Box>
          ) : dockActive ? (
            <Box flexDirection="column" width={columns - navW} height={bodyH} paddingX={1} overflow="hidden">
              <Box flexDirection="column" width={contentW} height={contentH} overflow="hidden">
                {main}
              </Box>
              <KeyScopeProvider opaque={assistantScopeActive}>
                <Suspense fallback={null}>
                  <AssistantPanel
                    host={host}
                    isActive={
                      assistantFocused &&
                      !paletteOpen &&
                      !helpOpen &&
                      !courseOpen &&
                      !inboxOpen &&
                      !notificationHistoryOpen &&
                      !quitConfirmOpen
                    }
                    width={dockW}
                    height={dockH}
                    docked
                    onClose={() => useTuiStore.getState().closeAssistant()}
                  />
                </Suspense>
              </KeyScopeProvider>
            </Box>
          ) : (
            <Box flexDirection="column" width={columns - navW} height={bodyH} paddingX={1} overflow="hidden">
              {main}
            </Box>
          )}
        </Box>
        {showKeyHints ? (
          <KeyHintBar
            hints={hints}
            width={columns}
            right={refreshing ? t(lang, `${glyph('sync', asciiMode)} 同步中`, `${glyph('sync', asciiMode)} syncing`) : undefined}
            tip={contextualTipText}
          />
        ) : null}

        {paletteOpen ? (
          <KeyScopeProvider>
            <Suspense fallback={null}>
              <CommandPalette
                host={host}
                isActive={paletteOpen}
                onClose={() => useTuiStore.getState().setCommandPaletteOpen(false)}
                extraCommands={extraCommands}
              />
            </Suspense>
          </KeyScopeProvider>
        ) : null}
        {helpOpen && !paletteOpen ? (
          <KeyScopeProvider>
            <Suspense fallback={null}>
              <HelpOverlay isActive={helpOpen} onClose={() => useTuiStore.getState().setHelpOpen(false)} />
            </Suspense>
          </KeyScopeProvider>
        ) : null}
        {courseOpen && !paletteOpen && !helpOpen ? (
          <KeyScopeProvider>
            <Suspense fallback={null}>
              <CoursePickerModal isActive={courseOpen} onClose={() => useTuiStore.getState().setCoursePickerOpen(false)} />
            </Suspense>
          </KeyScopeProvider>
        ) : null}
        {inboxOpen && !paletteOpen && !helpOpen && !courseOpen ? (
          <KeyScopeProvider>
            <Suspense fallback={null}>
              <InboxModal host={host} isActive={inboxOpen} onClose={() => useTuiStore.getState().setInboxOpen(false)} />
            </Suspense>
          </KeyScopeProvider>
        ) : null}
        {notificationHistoryOpen && !paletteOpen && !helpOpen && !courseOpen && !inboxOpen ? (
          <KeyScopeProvider>
            <Suspense fallback={null}>
              <NotificationHistoryModal
                isActive={notificationHistoryOpen}
                onClose={() => useTuiStore.getState().setNotificationHistoryOpen(false)}
              />
            </Suspense>
          </KeyScopeProvider>
        ) : null}
        {voiceOverlay && !paletteOpen && !helpOpen && !courseOpen && !inboxOpen && !notificationHistoryOpen && renderVoicePack ? (
          <KeyScopeProvider>
            {renderVoicePack({
              isActive: true,
              onClose: () => useTuiStore.getState().setVoicePackOpen(false),
              width: columns,
              height: rows,
            })}
          </KeyScopeProvider>
        ) : null}
        {overlays}
        {tooSmall ? <TooSmallViewportNotice columns={columns} rows={rows} asciiMode={asciiMode} lang={lang} /> : null}
        {quitConfirmOpen ? (
          <KeyScopeProvider>
            <ConfirmDialog
            title={t(lang, '确认退出', 'Quit StudyHub')}
            message={t(lang, '当前有进行中的考试/练习，确认退出吗？', 'Session in progress. Quit StudyHub?')}
            confirmLabel={t(lang, '退出', 'Quit')}
            cancelLabel={t(lang, '继续', 'Stay')}
            isActive={quitConfirmOpen}
            onConfirm={() => {
              useTuiStore.getState().setQuitConfirmOpen(false);
              rawQuitRef.current();
            }}
            onCancel={() => useTuiStore.getState().setQuitConfirmOpen(false)}
          />
          </KeyScopeProvider>
        ) : null}
        {voiceOpen && !renderVoicePack ? <VoicePackFallback /> : null}
        {toasts.length > 0 ? (
          <Box position="absolute" top={toastTop} left={Math.max(0, columns - toastW - 1)} width={toastW}>
            <ToastStack toasts={toasts} onDismiss={dismissToast} width={toastW} paused={notificationHistoryOpen} />
          </Box>
        ) : null}
      </Box>
    </ShellActionsContext.Provider>
  );
});

/** Opaque notice drawn over the shell when the terminal is below 60x18; the shell underneath keeps its state (#1452). */
const TooSmallViewportNotice = memo(function TooSmallViewportNotice({
  columns,
  rows,
  asciiMode,
  lang,
}: {
  columns: number;
  rows: number;
  asciiMode: boolean;
  lang: 'zh' | 'en';
}) {
  const theme = useTheme();
  const times = glyph('times', asciiMode);
  const warnGlyph = glyph('warn', asciiMode);
  const minCols = LAYOUT_BP.MIN_VIEWPORT_COLS;
  const minRows = LAYOUT_BP.MIN_VIEWPORT_ROWS;
  return (
    <Box
      position="absolute"
      top={0}
      left={0}
      width="100%"
      height="100%"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      paddingX={1}
      backgroundColor={theme.surface}
      overflow="hidden"
    >
      <Text color={theme.warning} bold wrap="wrap">
        {`${warnGlyph} ${t(lang, `终端窗口太小 (${columns}${times}${rows})`, `Terminal too small (${columns}${times}${rows})`)}`}
      </Text>
      <Text color={theme.text} wrap="wrap">
        {t(lang, `请放大窗口至至少 ${minCols}${times}${minRows}`, `Resize terminal to at least ${minCols}${times}${minRows}`)}
      </Text>
      <Text color={theme.dim} wrap="wrap">
        {t(lang, '按 q 或 Ctrl+C 退出', 'Press q or Ctrl+C to quit')}
      </Text>
    </Box>
  );
});

/** If no voice-pack renderer is wired, close the flag and tell the user (prevents a stuck state). */
function VoicePackFallback(): null {
  useEffect(() => {
    const s = useTuiStore.getState();
    s.setVoicePackOpen(false);
    s.notify(s.preferences.language === 'en' ? 'Voice pack is not available in this build' : '当前版本暂不支持语音包', 'warning');
  }, []);
  return null;
}

// Re-export for backwards compatibility (implementation lives in standalone ShellBootFrame.tsx).
export { ShellBootFrame } from './ShellBootFrame.js';
