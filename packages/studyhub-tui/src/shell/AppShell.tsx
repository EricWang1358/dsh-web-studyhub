import React, { memo, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Box, useApp, useInput, useWindowSize } from 'ink';
import { PAGE_REGISTRY, type CommandPaletteItem, type HostClient, type KeyHint, type PageId, type ViewProps } from '../types/contracts.js';
import { t, useTuiStore } from '../state/store.js';
import { useTheme } from '../theme/tokens.js';
import { KeyHintBar, Spinner, ToastStack } from '../components/Badge.js';
import { isKeyClaimed } from '../components/focus.js';
import { TopBar } from './TopBar.js';
import { SideNav, sideNavWidth } from './SideNav.js';
import { CommandPalette } from './CommandPalette.js';
import { HelpOverlay } from './HelpOverlay.js';
import { CoursePickerModal } from './CoursePickerModal.js';
import { InboxModal } from './InboxModal.js';
import { Launchpad } from './Launchpad.js';
import { ShellActionsContext, createDefaultShellActions, type ShellActions } from './actions.js';
import { isLibraryEmpty } from './data.js';

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
  const theme = useTheme();
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();

  const page = useTuiStore((s) => s.page);
  const lang = useTuiStore((s) => s.preferences.language);
  const sidebarCollapsed = useTuiStore((s) => s.preferences.sidebarCollapsed);
  const showKeyHints = useTuiStore((s) => s.preferences.showKeyHints);
  const inputCaptured = useTuiStore((s) => s.inputCaptured);
  const paletteOpen = useTuiStore((s) => s.commandPaletteOpen);
  const helpOpen = useTuiStore((s) => s.helpOpen);
  const courseOpen = useTuiStore((s) => s.coursePickerOpen);
  const inboxOpen = useTuiStore((s) => s.inboxOpen);
  const voiceOpen = useTuiStore((s) => s.voicePackOpen);
  const showLaunchpad = useTuiStore((s) => s.showLaunchpad);
  const toasts = useTuiStore((s) => s.toasts);
  const footerHints = useTuiStore((s) => s.footerHints);
  const loading = useTuiStore((s) => s.loading);
  const refreshing = useTuiStore((s) => s.refreshing);
  const snapshot = useTuiStore((s) => s.snapshot);
  const dismissToast = useTuiStore((s) => s.dismissToast);

  const actions = useMemo<ShellActions>(
    () => ({ ...createDefaultShellActions(host, () => exit()), ...actionOverrides }),
    [host, exit, actionOverrides],
  );

  // First-run Launchpad.
  const launchpadChecked = useRef(false);
  useEffect(() => {
    if (!autoLaunchpad || launchpadChecked.current || loading || !snapshot) return;
    launchpadChecked.current = true;
    if (isLibraryEmpty(snapshot)) useTuiStore.getState().setShowLaunchpad(true);
  }, [autoLaunchpad, loading, snapshot]);

  const voiceOverlay = voiceOpen && Boolean(renderVoicePack);
  const overlayOpen = paletteOpen || helpOpen || courseOpen || inboxOpen || voiceOverlay;

  // Render-time snapshot of routing state: every useInput handler for ONE keystroke sees
  // the state from BEFORE that keystroke (so closing an overlay with `?` never reopens it).
  const routing = useRef({ overlayOpen, inputCaptured, showLaunchpad });
  routing.current = { overlayOpen, inputCaptured, showLaunchpad };

  const { navW, bodyH, contentW } = shellLayout(columns, rows, { sidebarCollapsed, showKeyHints, launchpad: showLaunchpad });

  useInput((input, key) => {
    const s = useTuiStore.getState();
    const r = routing.current;
    if (key.ctrl && input === 'k') {
      if (!r.overlayOpen) s.setCommandPaletteOpen(true);
      else if (s.commandPaletteOpen) s.setCommandPaletteOpen(false);
      return;
    }
    if (key.ctrl && input === 'r') {
      void actions.refresh();
      return;
    }
    if (r.overlayOpen || r.inputCaptured) return;
    if (key.ctrl || key.meta) return;
    if (input && isKeyClaimed(input)) return;
    if (key.backspace) {
      if (!isKeyClaimed('backspace')) s.goBack();
      return;
    }
    switch (input) {
      case '/':
        s.setCommandPaletteOpen(true);
        return;
      case '?':
        s.setHelpOpen(true);
        return;
      case 'c':
        s.setCoursePickerOpen(true);
        return;
      case 'I':
        s.setInboxOpen(true);
        return;
      case 'q':
        actions.quit();
        return;
      case '\\':
        s.toggleSidebar();
        return;
      case '[':
      case ']': {
        const idx = NAV_ORDER.indexOf(s.page);
        const dir = input === ']' ? 1 : -1;
        const next = NAV_ORDER[(Math.max(0, idx) + dir + NAV_ORDER.length) % NAV_ORDER.length];
        s.navigate(next);
        return;
      }
      default:
        break;
    }
    if (r.showLaunchpad && (input === 's' || input === 'i' || input === 'm')) return;
    const target = SHORTCUTS.get(input);
    if (target) {
      if (target === 'review' && s.activeRunId) s.navigate('review', { runId: s.activeRunId });
      else s.navigate(target);
    }
  });

  const contentActive = !overlayOpen && !showLaunchpad;
  const view: ViewProps = useMemo(
    () => ({ host, width: contentW, height: bodyH, isActive: contentActive }),
    [host, contentW, bodyH, contentActive],
  );

  const tailHints: KeyHint[] = useMemo(
    () => [
      { key: 'Ctrl+K', label: t(lang, '命令', 'Cmd') },
      { key: '?', label: t(lang, '帮助', 'Help') },
    ],
    [lang],
  );
  const defaultHints: KeyHint[] = useMemo(
    () => [
      { key: '1-9', label: t(lang, '页面', 'Pages') },
      { key: 'c', label: t(lang, '课程', 'Course') },
      { key: '[ ]', label: t(lang, '切换', 'Cycle') },
      { key: 'q', label: t(lang, '退出', 'Quit') },
    ],
    [lang],
  );
  const hints = useMemo(
    () => [...(footerHints.length ? footerHints : defaultHints), ...tailHints],
    [footerHints, defaultHints, tailHints],
  );

  const toastW = Math.min(48, Math.max(28, Math.floor(columns * 0.4)));
  const toastRows = Math.min(2, toasts.length);
  const toastTop = Math.max(1, rows - (showKeyHints ? 1 : 0) - toastRows);

  let main: ReactNode;
  if (showLaunchpad) {
    main = <Launchpad width={columns - 2} height={bodyH} isActive={!overlayOpen} />;
  } else if (loading && !snapshot) {
    main = (
      <Box width={contentW} height={bodyH} alignItems="center" justifyContent="center">
        <Spinner label={t(lang, '正在打开学习库…', 'Opening library…')} />
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
          <Box flexDirection="column" width={columns - navW} height={bodyH} paddingX={1} overflow="hidden">
            {main}
          </Box>
        </Box>
        {showKeyHints ? (
          <KeyHintBar hints={hints} width={columns} right={refreshing ? t(lang, '⟳ 同步中', '⟳ syncing') : undefined} />
        ) : null}

        {toasts.length > 0 ? (
          <Box position="absolute" top={toastTop} left={Math.max(0, columns - toastW - 1)} width={toastW}>
            <ToastStack toasts={toasts} onDismiss={dismissToast} width={toastW} />
          </Box>
        ) : null}

        {paletteOpen ? (
          <CommandPalette
            host={host}
            isActive={paletteOpen}
            onClose={() => useTuiStore.getState().setCommandPaletteOpen(false)}
            extraCommands={extraCommands}
          />
        ) : null}
        {helpOpen && !paletteOpen ? <HelpOverlay isActive={helpOpen} onClose={() => useTuiStore.getState().setHelpOpen(false)} /> : null}
        {courseOpen && !paletteOpen && !helpOpen ? (
          <CoursePickerModal isActive={courseOpen} onClose={() => useTuiStore.getState().setCoursePickerOpen(false)} />
        ) : null}
        {inboxOpen && !paletteOpen && !helpOpen && !courseOpen ? (
          <InboxModal host={host} isActive={inboxOpen} onClose={() => useTuiStore.getState().setInboxOpen(false)} />
        ) : null}
        {voiceOverlay && !paletteOpen && !helpOpen && !courseOpen && !inboxOpen && renderVoicePack
          ? renderVoicePack({
              isActive: true,
              onClose: () => useTuiStore.getState().setVoicePackOpen(false),
              width: columns,
              height: rows,
            })
          : null}
        {overlays}
        {voiceOpen && !renderVoicePack ? <VoicePackFallback /> : null}
      </Box>
    </ShellActionsContext.Provider>
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
