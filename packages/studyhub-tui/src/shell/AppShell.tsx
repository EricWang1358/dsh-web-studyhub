import React, { Suspense, lazy, memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Box, Text, useApp, useStdin } from 'ink';
import type { CommandPaletteItem, HostClient, PageId, ViewProps } from '../types/contracts.js';
import { t, useTuiStore } from '../state/store.js';
import { useTheme } from '../theme/tokens.js';
import { glyph } from '../render/glyphs.js';
import { KeyHintBar, Spinner, ToastStack, estimateToastStackHeight } from '../components/Badge.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { isKeyClaimed, resolveShellFooterHints, useContextualFooterTip, useModalHints } from '../components/focus.js';
import {
  KEY_LAYER_GLOBAL,
  KEY_LAYER_SYSTEM,
  KEY_SCOPE_DEPTH_QUIT_CONFIRM,
  KEY_SCOPE_DEPTH_SHELL_OVERLAY,
  KEY_SCOPE_DEPTH_TOO_SMALL,
  KeyScopeProvider,
  getHub,
  getTopOpaqueScope,
  useKeyDispatcherBridge,
  useKeyScope,
  useScopedInput,
} from '../components/key-dispatcher.js';
import { LAYOUT_BP, isViewportTooSmall } from '../components/layout-tokens.js';
import { useMouseClickInputFallback } from '../components/mouse.js';
import { useStableWindowSize } from '../components/resize.js';
import { TopBar } from './TopBar.js';
import { SideNav, sideNavWidth } from './SideNav.js';
import { ShellActionsContext, createDefaultShellActions, requestQuit, type ShellActions } from './actions.js';
import { isLibraryEmpty } from './data.js';
import { formatReturnHintLabel } from '../state/practice-stack.js';
import { SHELL_KEY_ROUTER, resolveCycledPage, type ShellKeyRouter } from '../input/global-router.js';

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
  /** Decides every global, system and Alt-chord key (default `SHELL_KEY_ROUTER`); tests pass a stub. */
  keyRouter?: ShellKeyRouter;
}

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
  keyRouter = SHELL_KEY_ROUTER,
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
      ...createDefaultShellActions(host, () => rawQuitRef.current(), actionOverrides?.refresh),
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

  // Below 60x18 the shell stays mounted and a notice is drawn over it instead: unmounting would
  // throw away in-progress input, cursor and scroll positions, and would drop the quit guards that
  // pages register, so `q` would exit without the unsaved-work confirmation (#1452).
  const tooSmall = isViewportTooSmall(columns, rows);
  const { stdin } = useStdin();
  const hub = getHub(stdin);

  // Render-time snapshot of routing state: every key handler for ONE keystroke sees
  // the state from BEFORE that keystroke (so closing an overlay with `?` never reopens it).
  const routing = useRef({ overlayOpen, inputCaptured, showLaunchpad, tooSmall });
  routing.current = { overlayOpen, inputCaptured, showLaunchpad, tooSmall };

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
      const resolved = keyRouter.resolveSystem(input, key, {
        blockedByScope: r.overlayOpen || r.inputCaptured || r.tooSmall || getTopOpaqueScope(hub) !== null,
        tooSmall: r.tooSmall,
        quitConfirmOpen: s.quitConfirmOpen,
        commandPaletteOpen: s.commandPaletteOpen,
        assistantOpen: s.assistantOpen,
        assistantFocused: s.assistantFocused,
        assistantFullscreen: s.assistantFullscreen,
      });
      if (!resolved) return false;
      switch (resolved.action) {
        case 'quit-force':
          s.setQuitConfirmOpen(false);
          rawQuitRef.current();
          break;
        case 'quit-request':
          actions.quit();
          break;
        case 'palette-close':
          s.setCommandPaletteOpen(false);
          break;
        case 'palette-open':
          s.setCommandPaletteOpen(true);
          break;
        case 'assistant-open-passive':
          s.openAssistant({ focused: false });
          break;
        case 'assistant-focus':
          s.setAssistantFocused(true);
          break;
        case 'assistant-close':
          s.closeAssistant();
          break;
        case 'assistant-open-focus':
          s.openAssistant({ focused: true });
          break;
        case 'notification-history-open':
          s.setNotificationHistoryOpen(true);
          break;
        case 'refresh':
          // The active view (e.g. BoardView, BookView) also reloads its own state: consume is false.
          void actions.refresh();
          break;
      }
      return resolved.consume;
    },
    { isActive: true, layer: KEY_LAYER_SYSTEM, id: 'AppShell:system' },
  );

  // Centralized Alt+* (`key.meta`) containment: passes TextInput editing chords through while
  // consuming unhandled Alt+s / Alt+x / Alt+q etc. so they never leak into view/modal handlers.
  useScopedInput(
    (input, key) => keyRouter.resolveAltChord(input, key).kind === 'consume-unhandled-alt',
    { isActive: true, layer: KEY_LAYER_SYSTEM, id: 'AppShell:alt-guard' },
  );

  useScopedInput(
    (input, key) => {
      const s = useTuiStore.getState();
      const r = routing.current;
      const resolved = keyRouter.resolveGlobal(input, key, {
        overlayOpen: r.overlayOpen,
        inputCaptured: r.inputCaptured,
        showLaunchpad: r.showLaunchpad,
        page: s.page,
        passiveAssistantOpen: s.assistantOpen && !s.assistantFocused && !s.assistantFullscreen,
        isKeyClaimed,
      });
      if (!resolved) return false;
      switch (resolved.action) {
        case 'fold-passive-assistant':
          s.closeAssistant();
          return true;
        case 'go-back':
          s.goBack();
          return true;
        case 'palette-open':
          s.setCommandPaletteOpen(true);
          return true;
        case 'help-open':
          s.setHelpOpen(true);
          return true;
        case 'course-picker-open':
          s.setCoursePickerOpen(true);
          return true;
        case 'inbox-open':
          s.setInboxOpen(true);
          return true;
        case 'quit-request':
          actions.quit();
          return true;
        case 'toggle-sidebar':
          s.toggleSidebar();
          return true;
        case 'page-prev':
          s.navigate(resolveCycledPage(s.page, -1));
          return true;
        case 'page-next':
          s.navigate(resolveCycledPage(s.page, 1));
          return true;
        case 'navigate-review':
          if (s.practiceStack.length > 0) {
            s.returnViaPracticeStack();
            return true;
          }
          if (s.page === 'review' && (!s.activeRunId || s.navContext.runId === s.activeRunId)) return true;
          if (s.activeRunId) s.navigate('review', { runId: s.activeRunId });
          else {
            const focusCourse =
              typeof s.snapshot?.focus?.course === 'string' && s.snapshot.focus.course
                ? s.snapshot.focus.course
                : undefined;
            s.navigate('review', focusCourse ? { course: focusCourse } : {});
          }
          return true;
        case 'navigate-page':
          // Preserve intermediate reader location in stack if leaving sources while a practice stack is active (#1319)
          if (s.practiceStack.length > 0 && s.page === 'sources' && resolved.page !== 'sources' && s.navContext.sourceId) {
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
          s.navigate(resolved.page);
          return true;
      }
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
          <KeyScopeProvider id="shell:palette" depth={KEY_SCOPE_DEPTH_SHELL_OVERLAY}>
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
          <KeyScopeProvider id="shell:help" depth={KEY_SCOPE_DEPTH_SHELL_OVERLAY}>
            <Suspense fallback={null}>
              <HelpOverlay isActive={helpOpen} onClose={() => useTuiStore.getState().setHelpOpen(false)} />
            </Suspense>
          </KeyScopeProvider>
        ) : null}
        {courseOpen && !paletteOpen && !helpOpen ? (
          <KeyScopeProvider id="shell:course" depth={KEY_SCOPE_DEPTH_SHELL_OVERLAY}>
            <Suspense fallback={null}>
              <CoursePickerModal isActive={courseOpen} onClose={() => useTuiStore.getState().setCoursePickerOpen(false)} />
            </Suspense>
          </KeyScopeProvider>
        ) : null}
        {inboxOpen && !paletteOpen && !helpOpen && !courseOpen ? (
          <KeyScopeProvider id="shell:inbox" depth={KEY_SCOPE_DEPTH_SHELL_OVERLAY}>
            <Suspense fallback={null}>
              <InboxModal host={host} isActive={inboxOpen} onClose={() => useTuiStore.getState().setInboxOpen(false)} />
            </Suspense>
          </KeyScopeProvider>
        ) : null}
        {notificationHistoryOpen && !paletteOpen && !helpOpen && !courseOpen && !inboxOpen ? (
          <KeyScopeProvider id="shell:notifications" depth={KEY_SCOPE_DEPTH_SHELL_OVERLAY}>
            <Suspense fallback={null}>
              <NotificationHistoryModal
                isActive={notificationHistoryOpen}
                onClose={() => useTuiStore.getState().setNotificationHistoryOpen(false)}
              />
            </Suspense>
          </KeyScopeProvider>
        ) : null}
        {voiceOverlay && !paletteOpen && !helpOpen && !courseOpen && !inboxOpen && !notificationHistoryOpen && renderVoicePack ? (
          <KeyScopeProvider id="shell:voice" depth={KEY_SCOPE_DEPTH_SHELL_OVERLAY}>
            {renderVoicePack({
              isActive: true,
              onClose: () => useTuiStore.getState().setVoicePackOpen(false),
              width: columns,
              height: rows,
            })}
          </KeyScopeProvider>
        ) : null}
        {overlays}
        {tooSmall ? (
          <KeyScopeProvider id="shell:tooSmall" depth={KEY_SCOPE_DEPTH_TOO_SMALL} opaque active={!quitConfirmOpen}>
            <TooSmallViewportNotice
              columns={columns}
              rows={rows}
              asciiMode={asciiMode}
              lang={lang}
              isActive={!quitConfirmOpen}
              onQuit={() => actions.quit()}
            />
          </KeyScopeProvider>
        ) : null}
        {quitConfirmOpen ? (
          <KeyScopeProvider id="shell:quitConfirm" depth={KEY_SCOPE_DEPTH_QUIT_CONFIRM}>
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
  isActive,
  onQuit,
}: {
  columns: number;
  rows: number;
  asciiMode: boolean;
  lang: 'zh' | 'en';
  isActive: boolean;
  onQuit: () => void;
}) {
  const theme = useTheme();
  const times = glyph('times', asciiMode);
  const warnGlyph = glyph('warn', asciiMode);
  const minCols = LAYOUT_BP.MIN_VIEWPORT_COLS;
  const minRows = LAYOUT_BP.MIN_VIEWPORT_ROWS;
  useKeyScope({
    id: 'shell:tooSmall',
    active: isActive,
    onKey: (input, key) => {
      if (!key.ctrl && !key.meta && input === 'q') {
        onQuit();
        return true;
      }
      // Consume all non-system keys so hidden views/modals never receive blind keystrokes while < 60x18.
      return true;
    },
  });
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
